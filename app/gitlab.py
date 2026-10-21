"""GitLab package registry client: the group's PyPI packages, their files and Requires-Python. Stdlib only.
Everything GitLab returns is checked before use, and no error message carries the token."""
import base64
import html
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

MAX_PAGE = 16 << 20  # bytes of one response; a page of 100 packages is well under 1 MiB
NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?")  # PEP 508 project name
VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+!_-]{0,127}")
FILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+!-]{0,254}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
URL_RE = re.compile(r"https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?")
TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})")


class GitLabError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def norm(name):
    """PEP 503: pip treats PyYAML, pyyaml and py_yaml as one project."""
    return re.sub(r"[-_.]+", "-", name).lower()


class Client:
    def __init__(self, url, token, ca_file=None, timeout=20):
        if not re.fullmatch(r"https?://[^/?#\s]+(/[^?#\s]*)?", url or ""):
            raise ValueError("GITLAB_URL must be http(s)://host[:port][/path]")
        self.url, self.token, self.timeout = url.rstrip("/"), token, timeout
        self.api = self.url + "/api/v4"
        self.ctx = ssl.create_default_context(cafile=ca_file) if ca_file else None
        self.on_page = None  # called after each page of a list, so a long read counts as progress

    def open(self, path, basic=False):
        """GET one API path. The PyPI simple index takes basic auth (__token__), the REST API the PRIVATE-TOKEN header."""
        headers = {"Authorization": "Basic " + base64.b64encode(f"__token__:{self.token}".encode()).decode()} if basic else {"PRIVATE-TOKEN": self.token}
        req = urllib.request.Request(self.api + path, headers={**headers, "Accept": "application/json, text/html"})
        try:
            r = urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx)
        except urllib.error.HTTPError as e:
            hint = {401: ": the token is missing, expired or revoked", 403: ": the token lacks read_api or access to this group",
                    404: ": not found, or the token cannot see it"}.get(e.code, "")
            raise GitLabError(e.code, f"GitLab answered {e.code} for {path.split('?')[0]}{hint}") from None
        except (urllib.error.URLError, OSError) as e:
            raise GitLabError(502, f"GitLab unreachable: {getattr(e, 'reason', e)}") from None
        with r:
            body = r.read(MAX_PAGE + 1)
            if len(body) > MAX_PAGE:
                raise GitLabError(502, f"GitLab answer for {path.split('?')[0]} is over {MAX_PAGE >> 20} MiB")
            return body, r.headers

    def get(self, path):
        body, _ = self.open(path)
        try:
            return json.loads(body)
        except ValueError:
            raise GitLabError(502, f"GitLab sent something other than JSON for {path.split('?')[0]}") from None

    def get_all(self, path, limit):
        """A list endpoint followed page by page (X-Next-Page), at most `limit` items. Returns (items, truncated)."""
        out, page = [], "1"
        while page:
            body, headers = self.open(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
            try:
                items = json.loads(body)
            except ValueError:
                raise GitLabError(502, "GitLab sent something other than JSON") from None
            if not isinstance(items, list):
                raise GitLabError(502, "GitLab sent an object where a list was expected")
            out += items
            if self.on_page:
                self.on_page()
            if len(out) >= limit:
                return out[:limit], True
            page = headers.get("X-Next-Page", "")
            if page and not page.isdigit():
                raise GitLabError(502, "GitLab sent a bad X-Next-Page")
        return out, False

    def group(self, ref):
        g = self.get("/groups/" + urllib.parse.quote(str(ref), safe=""))
        if not (isinstance(g, dict) and isinstance(g.get("id"), int) and isinstance(g.get("full_path"), str)):
            raise GitLabError(502, "GitLab sent a group without id or full_path")
        return {"id": g["id"], "path": g["full_path"]}

    def packages(self, group_id, limit):
        """Every PyPI package of the group and its subgroups, one entry per upload (a name and version in one project)."""
        rows, truncated = self.get_all(f"/groups/{group_id}/packages?package_type=pypi&exclude_subgroups=false&order_by=created_at&sort=desc", limit)
        return [p for p in (package(r) for r in rows) if p], truncated

    def files(self, project, package_id):
        rows, _ = self.get_all(f"/projects/{int(project)}/packages/{int(package_id)}/package_files", 1000)
        return [f for f in (package_file(r) for r in rows) if f]

    def anonymous_index(self, group_id):
        """Whether GitLab serves the group's PyPI index without a login, so install commands need no token."""
        req = urllib.request.Request(f"{self.api}/groups/{int(group_id)}/-/packages/pypi/simple")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as r:
                return r.status == 200
        except (urllib.error.URLError, OSError):  # 401, 403 or 404 for anonymous, or unreachable: assume a token is needed
            return False

    def requires_python(self, project, name):
        """Requires-Python per file name, from the project's PEP 503 index page. GitLab keeps it only when the uploader sent it."""
        if not NAME_RE.fullmatch(name):
            raise GitLabError(400, "bad package name")
        body, _ = self.open(f"/projects/{int(project)}/packages/pypi/simple/{norm(name)}", basic=True)
        page = body.decode("utf-8", "replace")
        out = {}
        for m in re.finditer(r"<a\s[^>]*>", page):
            href = re.search(r'href="([^"]*)"', m[0])
            req = re.search(r'data-requires-python="([^"]*)"', m[0])
            if href:
                fname = urllib.parse.unquote(html.unescape(href[1]).split("#")[0].rsplit("/", 1)[-1])
                out[fname] = html.unescape(req[1])[:100] if req else ""
        return out


def package(p):
    """One upload from the packages API, or None when a field is missing or odd."""
    try:
        name, version = p["name"], p["version"]
        if not (NAME_RE.fullmatch(name) and VERSION_RE.fullmatch(version) and isinstance(p["id"], int) and isinstance(p["project_id"], int)):
            return None
        pipeline = p.get("pipeline") if isinstance(p.get("pipeline"), dict) else {}
        return {"id": p["id"], "name": name, "key": norm(name), "version": version,
                "projectId": p["project_id"], "project": str(p.get("project_path") or p["project_id"])[:255],
                "created": p["created_at"] if TIME_RE.fullmatch(str(p.get("created_at"))) else None,
                "downloaded": p["last_downloaded_at"] if TIME_RE.fullmatch(str(p.get("last_downloaded_at"))) else None,
                "webPath": p["_links"]["web_path"] if str((p.get("_links") or {}).get("web_path", "")).startswith("/") else "",
                "pipeline": {"id": pipeline["id"], "ref": str(pipeline.get("ref", ""))[:255], "sha": str(pipeline.get("sha", ""))[:40]}
                if isinstance(pipeline.get("id"), int) else None}
    except (KeyError, TypeError):
        return None


def package_file(f):
    try:
        name = f["file_name"]
        if not (isinstance(name, str) and FILE_RE.fullmatch(name)):
            return None
        sha = f.get("file_sha256") if SHA256_RE.fullmatch(str(f.get("file_sha256"))) else None
        return {"name": name, "size": f["size"] if isinstance(f.get("size"), int) else None, "sha256": sha,
                "created": f["created_at"] if TIME_RE.fullmatch(str(f.get("created_at"))) else None, **describe(name)}
    except (KeyError, TypeError):
        return None


# ---- What a distribution file is, from its name alone (PEP 427 wheel tags, PEP 600 manylinux) -------------------------------
OSES = (("manylinux", "linux"), ("musllinux", "linux (musl)"), ("linux", "linux"), ("win", "windows"), ("macosx", "macos"))
ARCHES = ("x86_64", "amd64", "aarch64", "arm64", "universal2", "i686", "win32", "ppc64le", "s390x", "armv7l")
LEGACY = {"1": "manylinux_2_5_", "2010": "manylinux_2_12_", "2014": "manylinux_2_17_"}


def platform_of(tag):
    """manylinux_2_17_x86_64 -> (linux glibc 2.17+, x86_64), win_amd64 -> (windows, amd64), any -> (any, any)."""
    if tag == "any":
        return "any", "any"
    tag = re.sub(r"^manylinux(1|2010|2014)_", lambda m: LEGACY[m[1]], tag)
    osname = next((o for prefix, o in OSES if tag.startswith(prefix)), tag)
    arch = next((a for a in ARCHES if tag.endswith(a)), "?")
    if osname == "macos" and (m := re.match(r"macosx_(\d+)_(\d+)", tag)):
        osname = f"macos {m[1]}.{m[2]}+"
    if m := re.match(r"(many|musl)linux_(\d+)_(\d+)", tag):
        osname += f" glibc {m[2]}.{m[3]}+" if m[1] == "many" else f" {m[2]}.{m[3]}+"
    return osname, "x86" if arch == "win32" else arch


def python_of(tag):
    """cp312 -> CPython 3.12, py3 -> Python 3, py2.py3 -> Python 2, Python 3."""
    names = []
    for t in tag.split("."):
        m = re.fullmatch(r"(cp|py|pp)(\d)(\d*)", t)
        names.append(f"{ {'cp': 'CPython', 'pp': 'PyPy', 'py': 'Python'}[m[1]]} {m[2]}{'.' + m[3] if m[3] else ''}" if m else t)
    return ", ".join(names)


def describe(filename):
    if filename.endswith(".whl"):
        parts = filename[:-4].split("-")
        if len(parts) in (5, 6):
            py, abi, plats = parts[-3:]
            lowest = {}  # several tags for one target (manylinux2014 and manylinux_2_28): keep the lowest version per OS
            for osname, arch in sorted({platform_of(p) for p in plats.split(".")}, key=lambda p: [int(n) for n in re.findall(r"\d+", p[0])]):
                lowest.setdefault((re.sub(r" [\d.]+\+$", "", osname), arch), (osname, arch))  # family: linux glibc, linux (musl), macos
            return {"kind": "wheel", "python": python_of(py), "abi": abi,
                    "platforms": [{"os": o, "arch": a} for o, a in sorted(lowest.values())]}
    if filename.endswith((".tar.gz", ".zip", ".tar.bz2")):
        return {"kind": "sdist", "python": "source", "abi": "", "platforms": [{"os": "any", "arch": "any"}]}
    return {"kind": "other", "python": "", "abi": "", "platforms": []}
