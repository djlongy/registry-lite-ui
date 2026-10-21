"""The PyPI source: one GitLab group's PyPI packages, kept in memory and refreshed by its own poller.
GitLab records when each file was uploaded, so Recent needs no history of its own: a change is any difference in
the list, and the sequence number tells the browsers."""
import collections
import logging
import threading
import time

import gitlab as G
import poller as P

log = logging.getLogger("pypi")


class Catalog:
    """The last package list read, with a sequence number that moves when an upload comes or goes."""
    def __init__(self, clock=time.time):
        self.clock, self.cond = clock, threading.Condition()
        self.packages, self.truncated, self.group, self.seq, self.loaded, self.error = [], False, None, 0, None, ""
        self.anonymous = False  # GitLab serves the group index without a login
        self.sig, self.by_id = None, {}  # by_id: upload id -> upload, so /api/pypi/files serves only this group's packages

    def update(self, group, packages, truncated):
        sig = tuple(sorted((p["id"], p["created"] or "") for p in packages))
        with self.cond:
            self.group, self.truncated, self.loaded, self.error = group, truncated, self.clock(), ""
            self.packages, self.by_id = packages, {p["id"]: p for p in packages}  # always: download times change too
            if sig != self.sig:  # browsers are told only when an upload came or went
                self.sig = sig
                self.seq += 1
                self.cond.notify_all()

    def failed(self, message):
        with self.cond:
            self.error = message

    def upload(self, upload_id):
        with self.cond:
            return self.by_id.get(upload_id)

    def snapshot(self):
        with self.cond:
            return {"seq": self.seq, "group": self.group, "packages": self.packages, "truncated": self.truncated,
                    "loaded": self.loaded, "error": self.error}


class Poller(threading.Thread):
    """Reads the group's package list every `interval` seconds, backing off while GitLab fails."""
    def __init__(self, client, catalog, group_ref, interval=60, limit=20000):
        super().__init__(daemon=True, name="pypi-poller")
        self.client, self.catalog, self.group_ref, self.interval, self.limit = client, catalog, group_ref, interval, limit
        self.group, self.kick, self.stop = None, threading.Event(), threading.Event()
        self.throttle, self.last_tick = P.Throttle(logger=log), time.monotonic()
        client.on_page = self.tick  # each page of a long list counts as progress

    def tick(self):
        self.last_tick = time.monotonic()

    def healthy(self):
        return time.monotonic() - self.last_tick < 3 * max(self.interval, 300)

    def cycle(self):
        if self.group is None:
            self.group = self.client.group(self.group_ref)
        packages, truncated = self.client.packages(self.group["id"], self.limit)
        if truncated:
            self.throttle.error("limit", f"the group has more than {self.limit} PyPI uploads; only the newest {self.limit} are shown (UI_PYPI_MAX_PACKAGES)")
        self.catalog.anonymous = self.client.anonymous_index(self.group["id"])
        self.catalog.update(self.group, packages, truncated)

    def run(self):
        fails = 0
        while not self.stop.is_set():
            try:
                self.cycle()
                fails = 0
                self.throttle.ok("gitlab")
            except Exception as e:  # the poller must never die
                fails += 1
                msg = e.message if isinstance(e, G.GitLabError) else f"poll failed: {type(e).__name__}"
                self.throttle.error("gitlab", msg)
                self.catalog.failed(msg)
            self.tick()
            self.kick.wait(min(self.interval * 2 ** min(fails, 4), 300))  # under the 900 s health threshold
            self.kick.clear()


class FileCache:
    """Files and Requires-Python per upload. Kept for `ttl` seconds, since GitLab can add a file to an existing version."""
    def __init__(self, client, ttl, size=2000):
        self.client, self.ttl, self.size = client, ttl, size
        self.items, self.lock = collections.OrderedDict(), threading.Lock()

    def get(self, project, package_id, name):
        key = (project, package_id)
        with self.lock:
            hit = self.items.get(key)
            if hit and time.monotonic() - hit[0] < self.ttl:
                self.items.move_to_end(key)
                return hit[1]
        files = self.client.files(project, package_id)
        try:
            needs = self.client.requires_python(project, name)
        except G.GitLabError:  # the index is a nicety; the file list stands without it
            needs = {}
        out = [{**f, "requires": needs.get(f["name"], "")} for f in files]
        with self.lock:
            self.items[key] = (time.monotonic(), out)
            while len(self.items) > self.size:
                self.items.popitem(last=False)
        return out


class Source:
    """Everything the server needs for the PyPI source, built from the environment. None of it exists when GITLAB_URL is unset."""
    def __init__(self, env):
        token_file = env.get("GITLAB_TOKEN_FILE")
        token = open(token_file).read().strip() if token_file else env.get("GITLAB_TOKEN", "")
        if not token:
            raise ValueError("set GITLAB_TOKEN_FILE (or GITLAB_TOKEN) to a token with read_api on the group")
        self.client = G.Client(env["GITLAB_URL"], token, env.get("GITLAB_CA_FILE") or None)
        self.group_ref = env.get("GITLAB_GROUP", "").strip()
        if not self.group_ref:
            raise ValueError("set GITLAB_GROUP to the group path (such as team/python) or its numeric id")
        self.public_url = (env.get("UI_PYPI_PUBLIC_URL") or env["GITLAB_URL"]).rstrip("/")  # what pip users type
        if not G.URL_RE.fullmatch(self.public_url):
            raise ValueError("UI_PYPI_PUBLIC_URL must be http(s)://host[:port][/path]")
        # auto: the commands leave out __token__:<TOKEN> while GitLab serves the index without a login. token, none: forced.
        self.index_auth = env.get("UI_PYPI_INDEX_AUTH", "auto").strip().lower()
        if self.index_auth not in ("auto", "token", "none"):
            raise ValueError("UI_PYPI_INDEX_AUTH must be auto, token or none")
        # Behind an auth proxy, PyPI data needs a login unless this says the packages are for everyone.
        self.public = env.get("UI_PYPI_PUBLIC", "").lower() in ("1", "true", "yes")
        n = lambda key, default: int(env.get(key, default))  # noqa: E731
        self.interval, self.limit = n("UI_PYPI_POLL_INTERVAL", 60), n("UI_PYPI_MAX_PACKAGES", 20000)
        self.catalog = Catalog()
        self.files = FileCache(self.client, self.interval)
        self.poller = Poller(self.client, self.catalog, self.group_ref, self.interval, self.limit)

    def config(self):
        anonymous = self.catalog.anonymous if self.index_auth == "auto" else self.index_auth == "none"
        return {"gitlab": self.public_url, "group": self.catalog.snapshot()["group"], "groupRef": self.group_ref,
                "interval": self.interval, "indexAuth": "none" if anonymous else "token"}
