"""Web UI server: serves static files and a small JSON API that calls registry.py. Stdlib only."""
import hashlib
import hmac
import json
import os
import secrets
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import registry as R

STATIC = Path(__file__).parent / "static"
FILES = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"), "/style.css": ("style.css", "text/css")}
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


class Config:
    def __init__(self, env):
        self.registry_url = env.get("REGISTRY_URL", "http://registry:5000")
        pw_file = env.get("REGISTRY_PASSWORD_FILE")
        password = Path(pw_file).read_text().strip() if pw_file else env.get("REGISTRY_PASSWORD", "")
        self.client = R.Client(self.registry_url, env.get("REGISTRY_USER", ""), password)
        self.readonly = env.get("UI_READONLY", "").lower() in ("1", "true", "yes")
        self.hosts = {h.strip() for h in env.get("UI_ALLOWED_HOSTS", "").split(",") if h.strip()}
        self.csrf = hmac.new(secrets.token_bytes(32), b"csrf", hashlib.sha256).hexdigest()


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
        "/api/tags": lambda q: [{"tag": t, "digest": c.manifest(one(q, "repo"), t, head=True)[2]}
                                for t in sorted(c.tags(one(q, "repo")))],
        "/api/manifest": lambda q: view_manifest(c, one(q, "repo"), one(q, "ref")),
    }

    def transfer(fn):
        return lambda b: {"digest": fn(c, str(b["src"]), str(b["srcRef"]), str(b["dst"]), str(b["dstRef"]))}

    POST = {
        "/api/copy": transfer(R.copy),
        "/api/move": lambda b: {"deleted": R.move(c, str(b["src"]), str(b["srcRef"]), str(b["dst"]), str(b["dstRef"]))},
        "/api/delete": lambda b: {"deleted": R.delete(c, str(b["repo"]), str(b["digest"]), bool(b.get("children")))},
    }

    class Handler(BaseHTTPRequestHandler):
        server_version = "registry-lite-ui"
        sys_version = ""

        def send(self, status, body, ctype="application/json"):
            self.send_response(status)
            for k, v in (("Content-Type", ctype), ("Content-Length", str(len(body))), ("Content-Security-Policy", CSP),
                         ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store")):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

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
                if method == "GET" and url.path == "/healthz":
                    return self.send(200, b"ok", "text/plain")
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
                self.reply(e.status if 400 <= e.status < 600 else 502, {"error": e.message})
            except (KeyError, ValueError, TypeError):
                self.reply(400, {"error": "bad request"})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    return Handler


if __name__ == "__main__":
    cfg = Config(os.environ)
    ThreadingHTTPServer((os.environ.get("UI_BIND", "0.0.0.0"), int(os.environ.get("UI_PORT", "8080"))), make_handler(cfg)).serve_forever()
