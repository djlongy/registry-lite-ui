"""Registry client and image operations. Talks only to REGISTRY_URL, over its HTTP API."""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

# Patterns from the distribution spec. fullmatch is always used.
REPO_RE = re.compile(r"[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*")
TAG_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,127}")
DIGEST_RE = re.compile(r"sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128}")

INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
IMAGE_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
ACCEPT = ", ".join(sorted(INDEX_TYPES | IMAGE_TYPES))
DELETE_OFF = "Deletion is disabled on this registry. Set REGISTRY_STORAGE_DELETE_ENABLED=true and restart it."


class RegistryError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def check_repo(name):
    if len(name) > 255 or not REPO_RE.fullmatch(name):
        raise RegistryError(400, "invalid repository name")
    return name


def check_ref(ref):
    """A reference is a tag or a digest."""
    if not (TAG_RE.fullmatch(ref) or DIGEST_RE.fullmatch(ref)):
        raise RegistryError(400, "invalid tag or digest")
    return ref


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # never follow: the registry URL is fixed
        return None


class Client:
    def __init__(self, base, user="", password=""):
        self.base = base.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode() if user else ""
        self.opener = urllib.request.build_opener(NoRedirect)

    def open(self, method, path, headers=None, body=None, timeout=30):
        """Return an open response. path must be a /v2/ path; only it is taken from callers or Location headers."""
        if not path.startswith("/v2/"):
            raise RegistryError(502, "unexpected registry path")
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=dict(headers or {}))
        if self.auth:
            req.add_header("Authorization", self.auth)
        try:
            return self.opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            return e  # HTTPError is a response too
        except (urllib.error.URLError, OSError) as e:
            raise RegistryError(502, f"registry unreachable: {e}")

    def call(self, method, path, headers=None, body=None, ok=(200,)):
        with self.open(method, path, headers, body) as r:
            data = r.read()
            if r.status not in ok:
                raise RegistryError(r.status, describe(r.status, data))
            return r.status, r.headers, data

    def paged(self, path, key):
        out = []
        while path:
            _, h, data = self.call("GET", path)
            out += (json_load(data).get(key) or [])
            link = re.match(r'<([^>]+)>', h.get("Link", ""))
            path = local_path(link.group(1)) if link else None
        return out

    def catalog(self):
        return self.paged("/v2/_catalog?n=1000", "repositories")

    def tags(self, repo):
        return self.paged(f"/v2/{check_repo(repo)}/tags/list?n=1000", "tags")

    def manifest(self, repo, ref, head=False):
        """Return (raw bytes, media type, digest). Raw bytes are kept so a copy has the same digest."""
        status, h, data = self.call("HEAD" if head else "GET",
                                    f"/v2/{check_repo(repo)}/manifests/{check_ref(ref)}", {"Accept": ACCEPT})
        return data, h.get("Content-Type", "").split(";")[0], h.get("Docker-Content-Digest", "")

    def delete_enabled(self):
        """DELETE on a digest that cannot exist: 405 means disabled, 404 means enabled."""
        with self.open("DELETE", "/v2/ui-probe/manifests/sha256:" + "0" * 64) as r:
            return r.status != 405


def local_path(url):
    """Keep only the path and query of a Location or Link value, so the host is never taken from the registry."""
    u = urllib.parse.urlsplit(url)
    return u.path + ("?" + u.query if u.query else "")


def json_load(data):
    try:
        return json.loads(data or b"{}")
    except ValueError:
        raise RegistryError(502, "registry returned invalid JSON")


def describe(status, data):
    try:
        e = json_load(data)["errors"][0]
        return f"registry said {status} {e.get('code', '')}: {e.get('message', '')}"
    except (KeyError, IndexError, RegistryError, TypeError):
        return f"registry said {status}"


def children(manifest_bytes, media_type):
    """Child manifest digests of an index, else []."""
    if media_type not in INDEX_TYPES:
        return []
    return [m["digest"] for m in json_load(manifest_bytes).get("manifests", [])]


def blobs(manifest_bytes, media_type):
    """Config and layer descriptors of an image manifest that can be mounted."""
    m = json_load(manifest_bytes)
    found = ([m["config"]] if "config" in m else []) + m.get("layers", [])
    return [d["digest"] for d in found if not d.get("urls")]


def copy_blob(c, src, dst, digest):
    """Mount from src into dst. If the registry starts an upload instead, cancel it and stream the blob."""
    status, h, _ = c.call("POST", f"/v2/{dst}/blobs/uploads/?mount={digest}&from={src}", ok=(201, 202))
    if status == 201:
        return
    session = local_path(h["Location"])
    c.call("DELETE", session, ok=(204,))
    _, h, _ = c.call("POST", f"/v2/{dst}/blobs/uploads/", ok=(202,))
    with c.open("GET", f"/v2/{src}/blobs/{digest}", timeout=3600) as r:
        if r.status != 200:
            raise RegistryError(r.status, f"cannot read blob {digest[:19]}")
        sep = "&" if "?" in h["Location"] else "?"
        c.call("PUT", local_path(h["Location"]) + f"{sep}digest={digest}",
               {"Content-Type": "application/octet-stream", "Content-Length": r.headers["Content-Length"]}, r, ok=(201,))


def copy(c, src, src_ref, dst, dst_ref):
    """Copy an image or index. Children and blobs go first, the manifest last, bytes unchanged."""
    check_repo(src), check_repo(dst), check_ref(src_ref), check_ref(dst_ref)
    data, mtype, digest = c.manifest(src, src_ref)
    if mtype not in INDEX_TYPES | IMAGE_TYPES:
        raise RegistryError(400, f"unsupported manifest type {mtype or 'unknown'} (schema1 is not copied)")
    for child in children(data, mtype):
        copy(c, src, child, dst, child)
    if src != dst:
        for blob in blobs(data, mtype) if mtype in IMAGE_TYPES else []:
            copy_blob(c, src, dst, blob)
    c.call("PUT", f"/v2/{dst}/manifests/{dst_ref}", {"Content-Type": mtype}, data, ok=(201,))
    return digest


def tags_of(c, repo, digest):
    """Tags in repo that point at digest. The registry deletes by digest, so all of them go."""
    return [t for t in c.tags(repo) if c.manifest(repo, t, head=True)[2] == digest]


def delete(c, repo, digest, with_children=False):
    """Delete a manifest by digest. With with_children, also delete index children no other tagged index in the repo uses."""
    check_repo(repo)
    if not DIGEST_RE.fullmatch(digest):
        raise RegistryError(400, "delete takes a digest")
    if not c.delete_enabled():
        raise RegistryError(405, DELETE_OFF)
    data, mtype, _ = c.manifest(repo, digest)
    orphans = set(children(data, mtype)) if with_children else set()
    for tag in c.tags(repo) if orphans else []:
        d, t, dg = c.manifest(repo, tag)
        if dg != digest:
            orphans -= set(children(d, t))
    gone = [digest, *sorted(orphans)]
    for d in gone:
        c.call("DELETE", f"/v2/{repo}/manifests/{d}", ok=(202,))
    return gone


def move(c, src, src_ref, dst, dst_ref):
    """Copy, check the destination digest matches, then delete the source digest."""
    if src == dst:
        raise RegistryError(400, "move needs two repositories: registry:2 deletes by digest, which would remove both tags")
    if not c.delete_enabled():
        raise RegistryError(405, "nothing copied. " + DELETE_OFF)
    digest = copy(c, src, src_ref, dst, dst_ref)
    if c.manifest(dst, dst_ref, head=True)[2] != digest:
        raise RegistryError(502, "destination digest differs, source kept")
    return delete(c, src, digest, with_children=True)
