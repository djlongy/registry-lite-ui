"""Web UI server: serves static files and a small JSON API that calls registry.py. Stdlib only."""
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import selectors
import signal
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import poller as P
import registry as R

log = logging.getLogger("ui")

STATIC = Path(__file__).parent / "static"
FILES = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"), "/style.css": ("style.css", "text/css"),
         "/favicon.svg": ("favicon.svg", "image/svg+xml")}
PATH_RE = re.compile(r"/[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*/?")
VOLUME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")


def valid_storage(value):
    """An absolute path or a volume name, with nothing a shell or a mount option would read as syntax, because it is shown inside a command to copy."""
    if len(value) > 255:
        return False
    if value.startswith("/"):
        return bool(PATH_RE.fullmatch(value)) and ".." not in value.split("/")
    return bool(VOLUME_RE.fullmatch(value))


HOST_RE = re.compile(r"[A-Za-z0-9.-]+(:\d{1,5})?|\[[0-9A-Fa-f:]+\](:\d{1,5})?")
DEFAULT_ENVIRONMENTS = "dev,test,uat,staging,prod"  # the lifecycle stages, in order, that the copy and move dialogs offer as promote shortcuts
MAX_ENVIRONMENTS = 12
MAX_TAGNAMES = 5000  # tag names /api/tagnames returns, so the answer stays small on a very large registry
MEDIA_TYPE_RE = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")
CREATED_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})")  # RFC 3339, the form image config blobs use
MAX_BODY = 4096  # bytes of JSON accepted on a POST
HEALTHZ = "/healthz"
HEADER_SECS, BODY_SECS = 10, 10  # whole-request limits against clients that send a byte at a time
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
SECURITY_HEADERS = (("Content-Security-Policy", CSP), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
                    ("Cache-Control", "no-store"), ("Cross-Origin-Resource-Policy", "same-origin"))


class Config:
    def __init__(self, env):
        self.registry_url = env.get("REGISTRY_URL", "http://registry:5000")
        pw_file = env.get("REGISTRY_PASSWORD_FILE")
        password = Path(pw_file).read_text().strip() if pw_file else env.get("REGISTRY_PASSWORD", "")
        self.client = R.Client(self.registry_url, env.get("REGISTRY_USER", ""), password,
                              env.get("REGISTRY_CA_FILE") or None)
        self.readonly = env.get("UI_READONLY", "").lower() in ("1", "true", "yes")
        stages = [e.strip() for e in (env.get("UI_ENVIRONMENTS") or DEFAULT_ENVIRONMENTS).split(",") if e.strip()]
        self.environments = list(dict.fromkeys(stages))  # in lifecycle order, each a path prefix such as prod or team-a/prod
        if len(self.environments) > MAX_ENVIRONMENTS or not all(R.valid_repo(e) for e in self.environments):
            raise ValueError(f"UI_ENVIRONMENTS must be at most {MAX_ENVIRONMENTS} repository-style path prefixes in order, such as dev,test,prod")
        self.registry_storage = env.get("UI_REGISTRY_STORAGE", "").strip()  # display only: where the registry keeps its data, for the garbage collection command
        if self.registry_storage and not valid_storage(self.registry_storage):
            raise ValueError("UI_REGISTRY_STORAGE must be an absolute path such as /data/registry or a volume name")
        self.registry_host = env.get("UI_REGISTRY_HOST", "").strip()  # what clients type to reach the registry, shown in the pull and push commands
        if self.registry_host and not HOST_RE.fullmatch(self.registry_host):
            raise ValueError("UI_REGISTRY_HOST must be host or host:port, without a scheme or path")
        self.hosts = {h.strip().lower() for h in env.get("UI_ALLOWED_HOSTS", "").split(",") if h.strip()}
        self.csrf = hmac.new(secrets.token_bytes(32), b"csrf", hashlib.sha256).hexdigest()
        n = lambda key, default: int(env.get(key, default))  # noqa: E731
        self.max_conn, self.interval, self.max_tags = n("UI_MAX_CONN", 64), n("UI_POLL_INTERVAL", 30), n("UI_POLL_MAX_TAGS", 500)
        self.sse_slots = threading.BoundedSemaphore(n("UI_MAX_SSE", 20))
        state_dir = env.get("UI_STATE_DIR")
        self.state = P.State(os.path.join(state_dir, "state.json") if state_dir else None, n("UI_MAX_EVENTS", 1000),
                             n("UI_MAX_EVENT_DAYS", 30) * 86400)
        self.poller = None
        self.errors = P.Throttle(logger=log)


def server_context(cert, key):
    """TLS context for the UI's own listener: TLS 1.2 or newer, cert and key read from mounted files."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    return ctx


def csrf_ok(cfg, headers):
    """A mutating request needs JSON content type (forces a CORS preflight), the token, and a same-origin Origin."""
    origin = headers.get("Origin")
    return (headers.get("Content-Type", "").split(";")[0] == "application/json"
            and hmac.compare_digest(headers.get("X-CSRF-Token", ""), cfg.csrf)
            and (origin is None or urllib.parse.urlsplit(origin).netloc == headers.get("Host")))


def descriptor(d):
    """Digest and size of a manifest or layer entry, both checked, since a registry response is not trusted."""
    return {"digest": R.check_digest(d.get("digest")), "size": d["size"] if isinstance(d.get("size"), int) else None}


def view_manifest(c, repo, ref, with_tags=True):
    """with_tags=False skips tags_of(), which lists the repository and HEADs every tag. The pane rows and the tag detail
    use that form and work the shared tags out from the tag list they already hold; delete and move ask for the real list."""
    data, mtype, digest = c.manifest(repo, ref)
    m = R.json_load(data)
    out = {"repo": repo, "ref": ref, "digest": digest, "mediaType": mtype, "size": len(data),
           "index": mtype in R.INDEX_TYPES, "platforms": [], "layers": []}
    if with_tags:
        out["tags"] = R.tags_of(c, repo, digest)
    for d in m.get("manifests", []):
        platform = d.get("platform") if isinstance(d.get("platform"), dict) else {}
        out["platforms"].append({**descriptor(d), **{k: str(platform[k]) for k in ("os", "architecture", "variant") if k in platform}})
    out["layers"] = [descriptor(d) for d in m.get("layers", [])]
    if "config" in m:
        out["config"] = R.check_digest(m["config"].get("digest"))
        ctype = m["config"].get("mediaType")
        if isinstance(ctype, str) and MEDIA_TYPE_RE.fullmatch(ctype):
            out["configType"] = ctype  # tells an image from a Helm chart or another artifact
        try:  # the config blob names os/arch and when the image was built; best effort, it may be an artifact config
            cfg = R.json_load(c.call("GET", f"/v2/{repo}/blobs/{out['config']}")[2])
            platform = {k: cfg[k] for k in ("os", "architecture") if k in cfg}
            if platform:
                out["platform"] = platform
            if isinstance(cfg.get("created"), str) and CREATED_RE.fullmatch(cfg["created"]):
                out["created"] = cfg["created"]
        except R.RegistryError:
            pass
    return out


class BoundedServer(ThreadingHTTPServer):
    """One thread per connection, at most max_conn at once. Extra connections are closed without a reply, because
    answering would do blocking TLS work in the accept thread. A reaper closes sockets past their deadline, so a
    client that sends one byte at a time cannot hold a slot (the socket timeout only bounds each single read)."""
    daemon_threads = True

    def __init__(self, addr, handler, max_conn):
        super().__init__(addr, handler)
        self.slots = threading.BoundedSemaphore(max_conn)
        self.deadlines, self.closed = {}, threading.Event()
        threading.Thread(target=self.reap, daemon=True, name="reaper").start()

    def deadline(self, sock, seconds=None):
        """Close sock after `seconds` unless called again. No seconds removes the deadline."""
        if seconds is None:
            self.deadlines.pop(sock, None)
        else:
            self.deadlines[sock] = time.monotonic() + seconds

    def reap(self):
        while not self.closed.wait(1):
            now = time.monotonic()
            for sock, t in self.deadlines.copy().items():
                if t < now:
                    try:
                        socket.socket.shutdown(sock, socket.SHUT_RDWR)  # not SSLSocket.shutdown, it is not thread safe
                    except OSError:
                        pass

    def server_close(self):
        self.closed.set()
        super().server_close()

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:  # the thread did not start, so it will not release the slot
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):  # TLS probes and dropped clients are routine, not tracebacks
        log.debug("connection error from %s: %s", client_address[0], sys.exc_info()[1])


def one(q, key):
    v = q.get(key, [""])[0]
    if not v:
        raise R.RegistryError(400, f"missing {key}")
    return v


def routes(cfg):
    """The JSON API: GET handlers take the query, POST handlers the decoded body."""
    c = cfg.client

    def tags(q):
        repo = one(q, "repo")
        return [{"tag": t, "digest": c.manifest(repo, t, head=True)[2], "changed": cfg.state.tags.get(f"{repo}:{t}", {}).get("changed")}
                for t in sorted(c.tags(repo))]

    def tagnames(q):  # tag names the poller has seen, so the filter can match tags without a tags call per repository
        with cfg.state.cond:
            refs = list(cfg.state.tags)  # copied under the lock, sorted and capped outside it
            empty = cfg.state.empty.copy()
        refs.sort()
        out = {}
        for ref in refs[:MAX_TAGNAMES]:
            repo, _, tag = ref.rpartition(":")
            out.setdefault(repo, []).append(tag)
        return {"repos": out, "truncated": len(refs) > MAX_TAGNAMES, "empty": sorted(empty)[:MAX_TAGNAMES]}

    def parents(q):  # the tagged indexes that list a digest as a child: what delete and move would refuse (409), shown up front
        repo, digest = R.check_repo(one(q, "repo")), one(q, "digest")
        if not R.DIGEST_RE.fullmatch(digest):
            raise R.RegistryError(400, "digest expected")
        found, kept = R.survey(c, repo, digest)
        data, mtype, _ = c.manifest(repo, digest)
        kids = set(R.children(data, mtype))  # what "also delete index children" would remove: those no other tagged manifest keeps
        tags = sorted(found)
        return {"parents": [{"tag": t, "platform": found[t]} for t in tags[:5]], "more": max(0, len(tags) - 5),
                "children": len(kids), "removable": len(kids - kept)}

    def recent(q):
        return cfg.state.snapshot(max(0, min(int(q.get("limit", ["200"])[0]), cfg.state.max_events)))

    def woken(fn):  # a change made here shows up in Recent without waiting for the next poll
        def run(b):
            out = fn(*(str(b[k]) for k in ("src", "srcRef", "dst", "dstRef")))
            if cfg.poller:
                cfg.poller.wake()
            return out
        return run

    def delete(b):
        out = {"deleted": R.delete(c, str(b["repo"]), str(b["digest"]), b.get("children", False) is True)}
        if cfg.poller:
            cfg.poller.wake()
        return out

    get = {
        "/api/config": lambda q: {"csrf": cfg.csrf, "readonly": cfg.readonly, "deleteEnabled": c.delete_enabled(),
                                  "registry": cfg.registry_url,
                                  "registryHost": cfg.registry_host or urllib.parse.urlsplit(cfg.registry_url).netloc,
                                  "registryHostSet": bool(cfg.registry_host), "environments": cfg.environments, "registryStorage": cfg.registry_storage},
        "/api/repos": lambda q: sorted(c.catalog()),
        "/api/tags": tags,
        "/api/recent": recent,
        "/api/tagnames": tagnames,
        "/api/parents": parents,
        "/api/manifest": lambda q: view_manifest(c, one(q, "repo"), one(q, "ref"), q.get("tags", ["1"])[0] != "0"),
    }
    post = {
        "/api/copy": woken(lambda *a: {"digest": R.copy(c, *a)}),
        "/api/move": woken(lambda *a: {"deleted": R.move(c, *a)}),
        "/api/delete": delete,
    }
    return get, post


def host_only(host):
    name, _, port = host.rpartition(":")
    return (name if port.isdigit() and name else host).lower()


class Handler(BaseHTTPRequestHandler):
    cfg = None  # set by make_handler
    get = post = None
    server_version = "registry-lite-ui"
    sys_version = ""
    timeout = 15  # per socket operation; HEADER_SECS and BODY_SECS bound the whole read

    def setup(self):
        super().setup()
        self.server.deadline(self.request, HEADER_SECS)

    def finish(self):
        self.server.deadline(self.request)
        super().finish()

    def headers_out(self, pairs):
        for k, v in (*pairs, *SECURITY_HEADERS):
            self.send_header(k, v)
        self.end_headers()

    def send(self, status, body, ctype="application/json"):
        self.server.deadline(self.request, BODY_SECS)  # a client that stops reading cannot hold the thread
        self.send_response(status)
        self.headers_out((("Content-Type", ctype), ("Content-Length", str(len(body)))))
        self.wfile.write(body)

    def reply(self, status, obj):
        self.send(status, json.dumps(obj).encode())

    def events(self):
        """Server-Sent Events: a message with the new sequence number on each change, a comment every 15 s as heartbeat."""
        if not self.cfg.sse_slots.acquire(blocking=False):
            self.cfg.errors.error("sse", "live client limit reached, further clients get 503")
            return self.reply(503, {"error": "too many live clients"})
        try:
            self.send_response(200)
            self.headers_out((("Content-Type", "text/event-stream"), ("X-Accel-Buffering", "no")))
            self.close_connection = True
            self.log_request(200)
            seq = self.cfg.state.seq
            self.wfile.write(b"retry: 5000\n\n")
            self.wfile.flush()
            idle = 0
            while not self.hung_up():
                now = self.cfg.state.wait(seq, 1)
                idle = idle + 1 if now == seq else 0
                if idle in (0, 15):  # a change, or 15 quiet seconds: heartbeat
                    self.wfile.write(b": hb\n\n" if now == seq else b"data: %d\n\n" % now)
                    self.wfile.flush()
                    idle = 0
                seq = now
        except OSError:
            pass  # client went away
        finally:
            self.cfg.sse_slots.release()

    def hung_up(self):
        """A browser sends nothing after its request, so a readable socket means it has gone. Frees the slot at once."""
        with selectors.DefaultSelector() as sel:  # not select(), which fails for descriptors above 1024
            sel.register(self.connection, selectors.EVENT_READ)
            return bool(sel.select(0))

    def read_json(self):
        """The body of a POST: a plain Content-Length of at most MAX_BODY bytes, all read within BODY_SECS."""
        n = self.headers.get("Content-Length", "")
        if "Transfer-Encoding" in self.headers or not (n.isascii() and n.isdigit()):
            raise R.RegistryError(411, "a plain Content-Length is required")
        if int(n) > MAX_BODY:
            raise R.RegistryError(413, "body too large")
        self.server.deadline(self.request, BODY_SECS)
        try:
            return json.loads(self.rfile.read(int(n)))
        finally:  # the operation that follows may take longer than the body deadline
            self.server.deadline(self.request)

    def mutate(self, handler):
        if self.cfg.readonly:
            return self.reply(403, {"error": "UI is read-only (UI_READONLY)"})
        if not csrf_ok(self.cfg, self.headers):
            return self.reply(403, {"error": "CSRF check failed"})
        self.reply(200, handler(self.read_json()))

    def health(self):  # never calls the registry
        healthy = self.cfg.poller is None or self.cfg.poller.healthy()
        self.send(200 if healthy else 503, b"ok" if healthy else b"poller stalled", "text/plain")

    def dispatch(self, method, url):
        if self.cfg.hosts and url.path != HEALTHZ and host_only(self.headers.get("Host", "")) not in self.cfg.hosts:
            return self.reply(421, {"error": "host not allowed"})  # /healthz is the container's own probe
        if method == "POST" and url.path in self.post:
            return self.mutate(self.post[url.path])
        if method != "GET" or url.path in self.post:
            return self.reply(404, {"error": "not found"})
        if url.path in FILES:
            name, ctype = FILES[url.path]
            return self.send(200, (STATIC / name).read_bytes(), ctype + "; charset=utf-8")
        if url.path == HEALTHZ:
            return self.health()
        if url.path == "/api/events":
            return self.events()
        if url.path in self.get:
            return self.reply(200, self.get[url.path](urllib.parse.parse_qs(url.query)))
        self.reply(404, {"error": "not found"})

    def handle_any(self, method):
        if method == "GET":
            self.server.deadline(self.request)  # the headers are in; a POST gets a fresh deadline for its body
        try:
            self.dispatch(method, urllib.parse.urlsplit(self.path))
        except R.RegistryError as e:
            if e.status >= 500:
                self.cfg.errors.error("api", e.message)
            self.reply(e.status if 400 <= e.status < 600 else 502, {"error": e.message})
        except (KeyError, ValueError, TypeError):
            self.reply(400, {"error": "bad request"})
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client left, or the reaper closed a slow one: nothing to answer
        except Exception as e:  # a bug must not drop the connection or leak a traceback
            self.cfg.errors.error("api", f"unhandled {type(e).__name__} on {method}")
            self.reply(500, {"error": "internal error"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_other(self):
        self.reply(405, {"error": "method not allowed"})

    do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_other

    def log_request(self, code="-", size="-"):  # one line per request: no query, headers, cookies or body
        path = self.path.split("?")[0]
        log.log(logging.DEBUG if path == HEALTHZ or (code == 503 and path == "/api/events") else logging.INFO, "%s %s %s", self.command, ascii(path)[1:-1], code)

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)


def make_handler(cfg):
    get, post = routes(cfg)
    return type("Handler", (Handler,), {"cfg": cfg, "get": get, "post": post})


def watchdog(cfg, every=60):
    """A stalled poller is not fixed by an unhealthy flag alone, so exit and let the restart policy bring the UI back."""
    while True:
        time.sleep(every)
        if not cfg.poller.healthy():
            log.error("poller has stalled, exiting so the container restarts")
            cfg.state.save(force=True, wait=5)
            os._exit(1)


def main(env):
    logging.basicConfig(level=env.get("LOG_LEVEL", "info").upper(), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        cfg = Config(env)
    except (ValueError, OSError) as e:
        sys.exit(f"configuration error: {e}")
    if not cfg.hosts:
        log.warning("UI_ALLOWED_HOSTS is not set: any Host header is accepted, so DNS rebinding is not blocked")
    httpd = BoundedServer((env.get("UI_LISTEN", "0.0.0.0"), int(env.get("UI_PORT", "8080"))), make_handler(cfg), cfg.max_conn)
    cert, key = env.get("UI_TLS_CERT"), env.get("UI_TLS_KEY")
    if bool(cert) != bool(key):
        sys.exit("UI_TLS_CERT and UI_TLS_KEY must be set together")
    if cert:
        # handshake in the worker thread, so a stalled client cannot block accept()
        httpd.socket = server_context(cert, key).wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    cfg.poller = P.Poller(cfg.client, cfg.state, cfg.interval, cfg.max_tags)
    cfg.poller.start()
    threading.Thread(target=watchdog, args=(cfg,), daemon=True, name="watchdog").start()
    stop = threading.Event()  # a thread started now, since SIGTERM may arrive when no thread can be created
    threading.Thread(target=lambda: (stop.wait(), httpd.shutdown()), daemon=True, name="stop").start()
    signal.signal(signal.SIGTERM, lambda *a: stop.set())
    log.info("listening on %s, registry %s, history %s", httpd.server_address[1], cfg.registry_url,
             cfg.state.path or "in memory only")
    try:
        httpd.serve_forever()
    finally:
        cfg.state.save(force=True)


if __name__ == "__main__":
    main(os.environ)
