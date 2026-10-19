"""Registry client and image operations. Talks only to REGISTRY_URL, over its HTTP API."""
import base64
import hashlib
import json
import logging
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger("registry")

# Patterns from the distribution spec. fullmatch is always used. re.ASCII keeps \w to [A-Za-z0-9_].
REPO_PART_RE = re.compile(r"[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*")
TAG_RE = re.compile(r"\w[\w.-]{0,127}", re.ASCII)
SHA256 = "sha256:"
DIGEST_RE = re.compile(r"sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128}")

MAX_BODY = 8 << 20  # largest registry response read into memory; blobs are streamed instead
MAX_PAGES = 1000  # pages followed for one catalog or tag list
MAX_ITEMS, MAX_LIST_BYTES = 100_000, 16 << 20  # entries and raw bytes kept for one catalog or tag list
MAX_MESSAGE = 300  # registry error text passed on, cut after the credentials are removed
MAX_DEPTH = 3  # index nesting followed by copy

INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
IMAGE_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
IMAGE_CONFIGS = {"application/vnd.docker.container.image.v1+json", "application/vnd.oci.image.config.v1+json"}
HELM_CONFIG = "application/vnd.cncf.helm.config.v1+json"
ACCEPT = ", ".join(sorted(INDEX_TYPES | IMAGE_TYPES))
DELETE_OFF = "Deletion is disabled on this registry. Set REGISTRY_STORAGE_DELETE_ENABLED=true and restart it."


def kind_of(config_type):
    """image (also an index or an unknown manifest), helm or artifact, from the media type of a manifest's config."""
    if not config_type or config_type in IMAGE_CONFIGS:
        return "image"
    return "helm" if config_type == HELM_CONFIG else "artifact"


class RegistryError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def valid_repo(name):
    return len(name) <= 255 and all(REPO_PART_RE.fullmatch(part) for part in name.split("/"))


def check_repo(name):
    if not valid_repo(name):
        raise RegistryError(400, "invalid repository name")
    return name


def check_digest(digest):
    """A digest taken from a registry response, before it goes into a URL."""
    if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
        raise RegistryError(502, "registry returned an invalid digest")
    return digest


def hashed(data, like):
    """The digest of data in the algorithm `like` names (sha256: or sha512:)."""
    alg = like.split(":")[0]
    return f"{alg}:{hashlib.new(alg, data).hexdigest()}"


def check_ref(ref):
    """A reference is a tag or a digest."""
    if not (TAG_RE.fullmatch(ref) or DIGEST_RE.fullmatch(ref)):
        raise RegistryError(400, "invalid tag or digest")
    return ref


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # never follow: the registry URL is fixed
        return None


class Client:
    def __init__(self, base, user="", password="", cafile=None):
        u = urllib.parse.urlsplit(base)
        if u.scheme not in ("http", "https") or not u.hostname or "@" in u.netloc or u.path.strip("/") or u.query or u.fragment:
            raise ValueError("REGISTRY_URL must be http(s)://host[:port] with no credentials, path, query or fragment")
        self.base = base.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode() if user else ""
        self.secrets = [s for s in (self.auth[6:], password) if len(s) > 3]
        if user and u.scheme == "http":
            log.warning("registry credentials are sent over plain HTTP, use https in REGISTRY_URL outside a private network")
        # Verification is always on. cafile may be a CA or the self-signed leaf itself.
        # With a cafile, only that file is trusted, not the system store as well.
        tls = urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=cafile))
        self.opener = urllib.request.build_opener(NoRedirect, tls)

    def open(self, method, path, headers=None, body=None, timeout=30):
        """Return an open response. path must be a /v2/ path; only it is taken from callers or Location headers."""
        if not path.startswith("/v2/") or ".." in path.split("?")[0].split("/"):
            raise RegistryError(502, "unexpected registry path")
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=dict(headers or {}))
        if self.auth:
            req.add_header("Authorization", self.auth)
        try:
            return self.opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            return e  # HTTPError is a response too
        except OSError as e:  # URLError is one
            raise RegistryError(502, unreachable(e))

    def redact(self, text):
        """A registry may echo the Authorization header into an error message. The browser and the log must not see it."""
        for secret in self.secrets:
            text = text.replace(secret, "[redacted]")
        return text

    def call(self, method, path, headers=None, body=None, ok=(200,)):
        with self.open(method, path, headers, body) as r:
            data = r.read(MAX_BODY + 1)
            if len(data) > MAX_BODY:
                raise RegistryError(502, "registry response too large")
            if r.status not in ok:
                raise RegistryError(r.status, self.redact(describe(r.status, data))[:MAX_MESSAGE])
            return r.status, r.headers, data

    def paged(self, path, key):
        out, seen, size = [], set(), 0
        while path:
            if path in seen or len(seen) >= MAX_PAGES:
                raise RegistryError(400, "registry paging does not end")
            seen.add(path)
            _, h, data = self.call("GET", path)
            size += len(data)
            items = json_load(data).get(key) or []
            if not isinstance(items, list):
                raise RegistryError(400, "registry returned a list of the wrong type")  # 400: the poller skips this repo
            out += items
            if len(out) > MAX_ITEMS or size > MAX_LIST_BYTES:
                raise RegistryError(400, "registry list is too large")
            link = re.match(r'<([^>]+)>', h.get("Link", ""))
            path = local_path(link.group(1)) if link else None
        return out

    def catalog(self):
        """Repository names as the registry lists them, minus any that are not valid names."""
        return [r for r in self.paged("/v2/_catalog?n=1000", "repositories") if isinstance(r, str) and valid_repo(r)]

    def tags(self, repo):
        """Tag names as the registry lists them, minus any that are not valid tags."""
        return [t for t in self.paged(f"/v2/{check_repo(repo)}/tags/list?n=1000", "tags") if isinstance(t, str) and TAG_RE.fullmatch(t)]

    def manifest(self, repo, ref, head=False):
        """Return (raw bytes, media type, digest). Raw bytes are kept so a copy has the same digest."""
        _, h, data = self.call("HEAD" if head else "GET",
                               f"/v2/{check_repo(repo)}/manifests/{check_ref(ref)}", {"Accept": ACCEPT})
        digest = h.get("Docker-Content-Digest", "")
        if digest:
            check_digest(digest)
        if not head:
            if any(DIGEST_RE.fullmatch(claim) and claim != hashed(data, claim) for claim in (digest, ref)):
                raise RegistryError(502, "registry returned a manifest that does not match its digest")
            digest = digest or hashed(data, SHA256)
        return data, h.get("Content-Type", "").split(";")[0], digest

    def delete_enabled(self):
        """DELETE on a digest that cannot exist: 405 means disabled, 404 means enabled."""
        with self.open("DELETE", "/v2/ui-probe/manifests/sha256:" + "0" * 64) as r:
            return r.status != 405


def unreachable(e):
    reason = getattr(e, "reason", e)
    if isinstance(reason, ssl.SSLCertVerificationError):
        why = reason.verify_message.rstrip(".")
        hint = " The certificate needs a subjectAltName entry for the host in REGISTRY_URL, a CN alone is ignored." \
            if "mismatch" in why.lower() or "IP address" in why else \
            " Mount the registry certificate or its CA and set REGISTRY_CA_FILE."
        return f"registry TLS verification failed: {why}.{hint}"
    return f"registry unreachable: {reason}"


def local_path(url):
    """Keep only the path and query of a Location or Link value, so the host is never taken from the registry."""
    u = urllib.parse.urlsplit(url)
    return u.path + ("?" + u.query if u.query else "")


def json_load(data):
    try:
        obj = json.loads(data or b"{}")
    except (ValueError, RecursionError):  # a manifest nested thousands of levels deep
        raise RegistryError(502, "registry returned invalid JSON")
    if not isinstance(obj, dict):
        raise RegistryError(502, "registry returned unexpected JSON")
    return obj


def describe(status, data):
    try:
        e = json_load(data)["errors"][0]
        return f"registry said {status} {e.get('code', '')}: {e.get('message', '')}"
    except (KeyError, IndexError, RegistryError, TypeError):
        return f"registry said {status}"


def child_entries(manifest_bytes):
    """The entries of an index, which must be a list of objects."""
    items = json_load(manifest_bytes).get("manifests", [])
    if not isinstance(items, list) or not all(isinstance(m, dict) for m in items):
        raise RegistryError(502, "registry returned unexpected JSON")
    return items


def children(manifest_bytes, media_type):
    """Child manifest digests of an index, else []."""
    if media_type not in INDEX_TYPES:
        return []
    return [check_digest(m.get("digest")) for m in child_entries(manifest_bytes)]


def blobs(manifest_bytes):
    """Config and layer digests of an image manifest that can be mounted."""
    m = json_load(manifest_bytes)
    found = ([m["config"]] if "config" in m else []) + m.get("layers", [])
    return [check_digest(d.get("digest")) for d in found if not d.get("urls")]


def copy_blob(c, src, dst, digest):
    """Mount from src into dst. If the registry starts an upload instead, cancel it and stream the blob."""
    status, h, _ = c.call("POST", f"/v2/{dst}/blobs/uploads/?mount={digest}&from={src}", ok=(201, 202))
    if status == 201:
        return
    session = local_path(h["Location"])
    c.call("DELETE", session, ok=(204,))
    _, h, _ = c.call("POST", f"/v2/{dst}/blobs/uploads/", ok=(202,))
    with c.open("GET", f"/v2/{src}/blobs/{digest}", timeout=300) as r:
        if r.status != 200 or not r.headers.get("Content-Length", "").isdigit():
            raise RegistryError(r.status if r.status != 200 else 502, f"cannot read blob {digest[:19]}")
        sep = "&" if "?" in h["Location"] else "?"
        c.call("PUT", local_path(h["Location"]) + f"{sep}digest={digest}",
               {"Content-Type": "application/octet-stream", "Content-Length": r.headers["Content-Length"]}, r, ok=(201,))  # r is read in 8 KiB blocks


def copy(c, src, src_ref, dst, dst_ref, depth=0):
    """Copy an image or index. Children and blobs go first, the manifest last, bytes unchanged."""
    check_repo(src), check_repo(dst), check_ref(src_ref), check_ref(dst_ref)
    if depth > MAX_DEPTH:
        raise RegistryError(502, "index nesting is too deep")
    data, mtype, digest = c.manifest(src, src_ref)
    if mtype not in INDEX_TYPES | IMAGE_TYPES:
        raise RegistryError(400, f"unsupported manifest type {mtype or 'unknown'} (schema1 is not copied)")
    for child in children(data, mtype):
        copy(c, src, child, dst, child, depth + 1)
    if src != dst:
        for blob in blobs(data) if mtype in IMAGE_TYPES else []:
            copy_blob(c, src, dst, blob)
    c.call("PUT", f"/v2/{dst}/manifests/{dst_ref}", {"Content-Type": mtype}, data, ok=(201,))
    return digest


def tags_of(c, repo, digest):
    """Tags in repo that point at digest. The registry deletes by digest, so all of them go."""
    return [t for t in c.tags(repo) if c.manifest(repo, t, head=True)[2] == digest]


PLATFORM_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,31}")
MAX_SURVEY_FETCHES = 500  # index manifests read while looking for the parents of one digest


def platform_of(entry):
    """os/architecture/variant of an index entry. The text is chosen by whoever pushed the index, so odd parts become 'unknown'."""
    p = entry.get("platform")
    parts = [p[k] for k in ("os", "architecture", "variant") if isinstance(p, dict) and k in p]
    return "/".join(x if isinstance(x, str) and PLATFORM_RE.fullmatch(x) else "unknown" for x in parts)


def index_entries(c, repo, cache, d):
    """The entries of the index manifest d, read once per survey."""
    if d not in cache:
        if len(cache) >= MAX_SURVEY_FETCHES:
            raise RegistryError(400, "too many indexes to check before deleting")
        cache[d] = child_entries(c.manifest(repo, d)[0])
    return cache[d]


def reaches(c, repo, cache, target, d, depth):
    """The platform of the entry of index d that leads to target, directly or through nested indexes, else None."""
    for m in index_entries(c, repo, cache, d):
        if m.get("digest") == target:
            return platform_of(m)
        nested = depth < MAX_DEPTH and m.get("mediaType") in INDEX_TYPES
        if nested and reaches(c, repo, cache, target, check_digest(m.get("digest")), depth + 1) is not None:
            return platform_of(m)
    return None


def survey(c, repo, digest):
    """One pass over the tags of repo, right before a delete of digest. Returns (parents, kept): the tagged indexes
    that list digest as a child, directly or through up to MAX_DEPTH nested indexes, with the platform, and the digests
    that other tagged manifests keep alive. An index no tag reaches cannot be found from the API."""
    cache, parents, kept = {}, {}, set()
    for tag in c.tags(repo):
        _, mtype, dg = c.manifest(repo, tag, head=True)
        if dg == digest:
            continue
        kept.add(dg)
        if mtype in INDEX_TYPES:
            kept.update(check_digest(m.get("digest")) for m in index_entries(c, repo, cache, dg))
            found = reaches(c, repo, cache, digest, dg, 1)
            if found is not None:
                parents[tag] = found
    return parents, kept


def refuse_parents(parents, digest):
    """409 when a tagged index uses digest: the registry deletes by digest, so the delete would break that index."""
    if not parents:
        return
    tags = sorted(parents)
    shown = ", ".join(tags[:5]) + (f" and {len(tags) - 5} more" if len(tags) > 5 else "")
    plat = ", ".join(sorted({p for p in parents.values() if p}))[:60]
    raise RegistryError(409, (f"{digest[:19]} is a child{f' ({plat})' if plat else ''} of the index tagged {shown}; "
                              "deleting it would break that index. Delete or retag the index first.")[:MAX_MESSAGE])


def delete(c, repo, digest, with_children=False):
    """Delete a manifest by digest. Refused (409) while a tagged index uses it as a child. With with_children, also
    delete index children no other tagged manifest in the repo uses."""
    check_repo(repo)
    if not DIGEST_RE.fullmatch(digest):
        raise RegistryError(400, "delete takes a digest")
    if not c.delete_enabled():
        raise RegistryError(405, DELETE_OFF)
    data, mtype, _ = c.manifest(repo, digest)
    orphans = set(children(data, mtype)) if with_children else set()
    parents, kept = survey(c, repo, digest)  # one pass, right before the DELETE calls; a push after it can still race
    refuse_parents(parents, digest)
    gone = [digest, *sorted(orphans - kept)]
    for d in gone:
        c.call("DELETE", f"/v2/{repo}/manifests/{d}", ok=(202,))
    return gone


def move(c, src, src_ref, dst, dst_ref):
    """Copy, check the destination digest matches, then delete the source digest."""
    if src == dst:
        raise RegistryError(400, "move needs two repositories: registry:2 deletes by digest, which would remove both tags")
    if not c.delete_enabled():
        raise RegistryError(405, "nothing copied. " + DELETE_OFF)
    before = c.manifest(check_repo(src), check_ref(src_ref), head=True)[2]
    refuse_parents(survey(c, src, before)[0], before)  # before anything is copied
    digest = copy(c, src, src_ref, dst, dst_ref)
    if c.manifest(dst, dst_ref, head=True)[2] != digest:
        raise RegistryError(502, "destination digest differs, source kept")
    return delete(c, src, digest, with_children=True)
