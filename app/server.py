"""Web UI server: serves static files and a small JSON API that calls registry.py. Stdlib only."""
import hashlib
import hmac
import json
import logging
import os
import secrets
import signal
import ssl
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import poller as P
import registry as R

log = logging.getLogger("ui")

STATIC = Path(__file__).parent / "static"
FILES = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"), "/style.css": ("style.css", "text/css")}
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


class Config:
    def __init__(self, env):
        self.registry_url = env.get("REGISTRY_URL", "http://registry:5000")
        pw_file = env.get("REGISTRY_PASSWORD_FILE")
        password = Path(pw_file).read_text().strip() if pw_file else env.get("REGISTRY_PASSWORD", "")
        self.client = R.Client(self.registry_url, env.get("REGISTRY_USER", ""), password,
                              env.get("REGISTRY_CA_FILE") or None)
        self.readonly = env.get("UI_READONLY", "").lower() in ("1", "true", "yes")
        self.hosts = {h.strip() for h in env.get("UI_ALLOWED_HOSTS", "").split(",") if h.strip()}
        self.csrf = hmac.new(secrets.token_bytes(32), b"csrf", hashlib.sha256).hexdigest()
        n = lambda key, default: int(env.get(key, default))  # noqa: E731
        self.max_conn, self.interval, self.max_tags = n("UI_MAX_CONN", 64), n("UI_POLL_INTERVAL", 30), n("UI_POLL_MAX_TAGS", 500)
        self.sse_slots = threading.BoundedSemaphore(n("UI_MAX_SSE", 20))
        state_dir = env.get("UI_STATE_DIR")
        self.state = P.State(os.path.join(state_dir, "state.json") if state_dir else None, n("UI_MAX_EVENTS", 1000),
                             n("UI_MAX_EVENT_DAYS", 30) * 86400)
        self.poller = None
        self.errors = P.Throttle()


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


def view_manifest(c, repo, ref):
    data, mtype, digest = c.manifest(repo, ref)
    m = R.json_load(data)
    out = {"repo": repo, "ref": ref, "digest": digest, "mediaType": mtype, "size": len(data),
           "index": mtype in R.INDEX_TYPES, "tags": R.tags_of(c, repo, digest), "platforms": [], "layers": []}
    for d in m.get("manifests", []):
        out["platforms"].append({"digest": d["digest"], "size": d.get("size"), **(d.get("platform") or {})})
    out["layers"] = [{"digest": d["digest"], "size": d.get("size")} for d in m.get("layers", [])]
    if "config" in m:
        out["config"] = m["config"]["digest"]
        try:  # the config blob names os/arch; best effort, it may be an artifact config
            cfg = R.json_load(c.call("GET", f"/v2/{repo}/blobs/{m['config']['digest']}")[2])
            out["platform"] = {k: cfg[k] for k in ("os", "architecture") if k in cfg}
        except R.RegistryError:
            pass
    return out


class BoundedServer(ThreadingHTTPServer):
    """One thread per connection, at most max_conn at once. Extra connections get a 503 and are closed."""
    daemon_threads = True

    def __init__(self, addr, handler, max_conn):
        super().__init__(addr, handler)
        self.slots = threading.BoundedSemaphore(max_conn)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):  # TLS probes and dropped clients are routine, not tracebacks
        log.debug("connection error from %s: %s", client_address[0], sys.exc_info()[1])


def make_handler(cfg):
    c = cfg.client

    def one(q, key):
        v = q.get(key, [""])[0]
        if not v:
            raise R.RegistryError(400, f"missing {key}")
        return v

    GET = {
        "/api/config": lambda q: {"csrf": cfg.csrf, "readonly": cfg.readonly, "deleteEnabled": c.delete_enabled(),
                                  "registry": cfg.registry_url},
        "/api/repos": lambda q: sorted(c.catalog()),
        "/api/tags": lambda q: [{"tag": t, "digest": c.manifest(one(q, "repo"), t, head=True)[2],
                                 "changed": cfg.state.tags.get(f"{one(q, 'repo')}:{t}", {}).get("changed")}
                                for t in sorted(c.tags(one(q, "repo")))],
        "/api/recent": lambda q: cfg.state.snapshot(min(int(q.get("limit", ["200"])[0]), cfg.state.max_events)),
        "/api/manifest": lambda q: view_manifest(c, one(q, "repo"), one(q, "ref")),
    }

    def transfer(fn):
        return lambda b: {"digest": fn(c, str(b["src"]), str(b["srcRef"]), str(b["dst"]), str(b["dstRef"]))}

    def woken(fn):  # a change made here shows up in Recent without waiting for the next poll
        def run(b):
            out = fn(b)
            if cfg.poller:
                cfg.poller.wake()
            return out
        return run

    POST = {
        "/api/copy": woken(transfer(R.copy)),
        "/api/move": woken(lambda b: {"deleted": R.move(c, str(b["src"]), str(b["srcRef"]), str(b["dst"]), str(b["dstRef"]))}),
        "/api/delete": woken(lambda b: {"deleted": R.delete(c, str(b["repo"]), str(b["digest"]), bool(b.get("children")))}),
    }

    class Handler(BaseHTTPRequestHandler):
        server_version = "registry-lite-ui"
        sys_version = ""
        timeout = 15  # per socket operation, also bounds a slow client

        def send(self, status, body, ctype="application/json"):
            self.send_response(status)
            for k, v in (("Content-Type", ctype), ("Content-Length", str(len(body))), ("Content-Security-Policy", CSP),
                         ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store")):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def events(self):
            """Server-Sent Events: a message with the new sequence number on each change, a comment every 15 s as heartbeat."""
            if not cfg.sse_slots.acquire(blocking=False):
                return self.reply(503, {"error": "too many live clients"})
            try:
                self.send_response(200)
                for k, v in (("Content-Type", "text/event-stream"), ("Cache-Control", "no-store"), ("X-Accel-Buffering", "no"),
                             ("Content-Security-Policy", CSP), ("X-Content-Type-Options", "nosniff")):
                    self.send_header(k, v)
                self.end_headers()
                self.close_connection = True
                self.log_request(200)
                seq = cfg.state.seq
                self.wfile.write(b"retry: 5000\n\n")
                self.wfile.flush()
                while True:
                    now = cfg.state.wait(seq, 15)
                    self.wfile.write(b": hb\n\n" if now == seq else b"data: %d\n\n" % now)
                    self.wfile.flush()
                    seq = now
            except OSError:
                pass  # client went away
            finally:
                cfg.sse_slots.release()

        def reply(self, status, obj):
            self.send(status, json.dumps(obj).encode())

        def handle_any(self, method):
            url = urllib.parse.urlsplit(self.path)
            if cfg.hosts and self.headers.get("Host", "").split(":")[0] not in cfg.hosts:
                return self.reply(421, {"error": "host not allowed"})
            try:
                if method == "GET" and url.path in FILES:
                    name, ctype = FILES[url.path]
                    return self.send(200, (STATIC / name).read_bytes(), ctype + "; charset=utf-8")
                if method == "GET" and url.path == "/healthz":  # never calls the registry
                    healthy = cfg.poller is None or cfg.poller.healthy()
                    return self.send(200 if healthy else 503, b"ok" if healthy else b"poller stalled", "text/plain")
                if method == "GET" and url.path == "/api/events":
                    return self.events()
                if method == "GET" and url.path in GET:
                    return self.reply(200, GET[url.path](urllib.parse.parse_qs(url.query)))
                if method == "POST" and url.path in POST:
                    if cfg.readonly:
                        return self.reply(403, {"error": "UI is read-only (UI_READONLY)"})
                    if not csrf_ok(cfg, self.headers):
                        return self.reply(403, {"error": "CSRF check failed"})
                    n = int(self.headers.get("Content-Length", "0"))
                    if n > 4096:
                        return self.reply(413, {"error": "body too large"})
                    return self.reply(200, POST[url.path](json.loads(self.rfile.read(n))))
                self.reply(404, {"error": "not found"})
            except R.RegistryError as e:
                if e.status >= 500:
                    cfg.errors.error("api", e.message)
                self.reply(e.status if 400 <= e.status < 600 else 502, {"error": e.message})
            except (KeyError, ValueError, TypeError):
                self.reply(400, {"error": "bad request"})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def log_request(self, code="-", size="-"):  # one line per request: no query, headers, cookies or body
            path = self.path.split("?")[0]
            log.log(logging.DEBUG if path == "/healthz" else logging.INFO, "%s %s %s", self.command, path, code)

        def log_message(self, fmt, *args):
            log.debug(fmt, *args)

    return Handler


def main(env):
    logging.basicConfig(level=env.get("LOG_LEVEL", "info").upper(), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = Config(env)
    httpd = BoundedServer((env.get("UI_BIND", "0.0.0.0"), int(env.get("UI_PORT", "8080"))), make_handler(cfg), cfg.max_conn)
    cert, key = env.get("UI_TLS_CERT"), env.get("UI_TLS_KEY")
    if bool(cert) != bool(key):
        sys.exit("UI_TLS_CERT and UI_TLS_KEY must be set together")
    if cert:
        # handshake in the worker thread, so a stalled client cannot block accept()
        httpd.socket = server_context(cert, key).wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    cfg.poller = P.Poller(cfg.client, cfg.state, cfg.interval, cfg.max_tags)
    cfg.poller.start()
    signal.signal(signal.SIGTERM, lambda *a: threading.Thread(target=httpd.shutdown).start())
    log.info("listening on %s, registry %s, history %s", httpd.server_address[1], cfg.registry_url,
             cfg.state.path or "in memory only")
    try:
        httpd.serve_forever()
    finally:
        cfg.state.save(force=True)


if __name__ == "__main__":
    main(os.environ)
