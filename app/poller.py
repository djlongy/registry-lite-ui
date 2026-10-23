"""Change detection. A poller walks the registry and State keeps a bounded, optionally persisted event history.
The registry API has no push timestamps, so a change is the moment the poller first sees it."""
import json
import logging
import os
import tempfile
import threading
import time
from collections import deque

import registry as R

log = logging.getLogger("poller")
MAX_STATE_BYTES = 8 << 20  # a state file over this is neither written nor read
KINDS = ("image", "helm", "artifact")


def diff(old, new, now):
    """Events between two {ref: digest} maps, where ref is repo:tag."""
    ev = [{"t": now, "type": "new" if k not in old else "retagged", "ref": k, "digest": d, "prev": old.get(k)}
          for k, d in new.items() if old.get(k) != d]
    ev += [{"t": now, "type": "deleted", "ref": k, "digest": None, "prev": d} for k, d in old.items() if k not in new]
    return ev


def repo_of(ref):
    return ref.rsplit(":", 1)[0]


def well_formed(data):
    """The state file is read back as is, so check its shape once instead of failing on every poll."""
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)  # noqa: E731
    return (isinstance(data, dict) and isinstance(data.get("seq"), int) and isinstance(data.get("baselined"), bool)
            and num(data.get("since")) and isinstance(data.get("tags"), dict) and isinstance(data.get("events"), list)
            and all(isinstance(k, str) and isinstance(v, dict) and isinstance(v.get("digest"), str)
                    and num(v.get("changed")) and num(v.get("first")) for k, v in data["tags"].items())
            and isinstance(data.get("meta", {}), dict)
            and all(isinstance(k, str) and isinstance(v, dict) and isinstance(v.get("index"), bool) and v.get("kind") in KINDS
                    for k, v in data.get("meta", {}).items())
            and all(isinstance(e, dict) and isinstance(e.get("ref"), str) and num(e.get("t")) and isinstance(e.get("seq"), int)
                    and e.get("type") in ("new", "retagged", "deleted") for e in data["events"]))


class Throttle:
    """Log an error when it changes, then at most every `every` seconds with a repeat count. Log recovery once."""
    def __init__(self, every=600, clock=time.monotonic, logger=log):
        self.every, self.clock, self.seen, self.log = every, clock, {}, logger

    def error(self, key, msg):
        now = self.clock()
        msg = ascii(msg)[1:-1]  # one line, no control characters, whatever the registry sent
        last_msg, last_t, skipped = self.seen.get(key, (None, 0, 0))
        if msg != last_msg or now - last_t >= self.every:
            self.log.warning("%s%s", msg, f" (repeated {skipped} more times)" if skipped and msg == last_msg else "")
            self.seen[key] = (msg, now, 0)
        else:
            self.seen[key] = (last_msg, last_t, skipped + 1)

    def ok(self, key):
        if self.seen.pop(key, None):
            log.info("%s recovered", key)


class State:
    """Current tag to digest map plus the last `max_events` events no older than `max_age` seconds."""
    def __init__(self, path=None, max_events=1000, max_age=30 * 86400, save_every=30, clock=time.time):
        self.path, self.max_events, self.max_age, self.save_every, self.clock = path, max_events, max_age, save_every, clock
        self.tags, self.events, self.seq, self.baselined = {}, deque(), 0, False
        self.meta = {}  # digest to {"index": bool, "kind": image|helm|artifact}, read once per digest, which never changes
        self.empty = set()  # repositories a full walk found with no tags. In memory only, so unknown again after a restart.
        self.since = clock()
        self.cond = threading.Condition()
        self.saved, self.saved_at, self.dirty = None, 0, False
        self.oversize_warned = False
        self.write_lock = threading.Lock()  # the poller and the SIGTERM path both save
        if path:
            self.load()

    def update(self, scanned, observed, gone=()):
        """Apply one poll. `scanned` repos were walked completely, `observed` maps their refs to digests, `gone` repos left the catalog."""
        now = self.clock()
        with self.cond:
            seen = {repo_of(k) for k in observed}
            self.empty = (self.empty | (scanned - seen)) - seen - set(gone)
            old = {k: v["digest"] for k, v in self.tags.items() if repo_of(k) in scanned or repo_of(k) in gone}
            ev = diff(old, observed, now)
            for e in ev:
                if e["type"] == "deleted":
                    del self.tags[e["ref"]]
                else:
                    self.tags[e["ref"]] = {"digest": e["digest"], "first": self.tags.get(e["ref"], {}).get("first", now), "changed": now}
            if ev and self.baselined:  # until the first full pass finishes, everything looks new
                for e in ev:
                    self.seq += 1
                    self.events.append({**e, "seq": self.seq})
            self.prune(now)
            if len(self.meta) > 2 * len(self.tags) + 1000:  # digests of deleted tags, once there are many
                keep = {v["digest"] for v in self.tags.values()}
                self.meta = {d: v for d, v in self.meta.items() if d in keep}
            self.dirty = self.dirty or bool(ev)
            if ev and self.baselined:
                self.cond.notify_all()
        return ev

    def known(self, digest):
        with self.cond:
            return digest in self.meta

    def learn(self, digest, index, kind):
        with self.cond:
            self.meta[digest] = {"index": index, "kind": kind}
            self.dirty = True

    def traits(self, digest):
        """What is known about a manifest digest, or {}."""
        with self.cond:
            return dict(self.meta.get(digest, {}))

    def mark_baselined(self):
        with self.cond:
            self.baselined, self.dirty = True, True

    def prune(self, now):
        while len(self.events) > self.max_events or (self.events and now - self.events[0]["t"] > self.max_age):
            self.events.popleft()

    def wait(self, seq, timeout):
        """Block until seq changes or timeout, return the current seq."""
        with self.cond:
            if self.seq == seq:
                self.cond.wait(timeout)
            return self.seq

    def snapshot(self, limit):
        with self.cond:
            last = {}
            for k, v in self.tags.items():
                last[repo_of(k)] = max(last.get(repo_of(k), 0), v["changed"])
            return {"events": list(self.events)[::-1][:limit], "seq": self.seq, "since": self.since, "baselined": self.baselined,
                    "persistent": bool(self.path), "lastChanged": last, "tags": len(self.tags)}

    def dump(self):
        return json.dumps({"v": 1, "since": self.since, "baselined": self.baselined, "seq": self.seq,
                           "tags": self.tags, "meta": self.meta, "events": list(self.events)}, sort_keys=True, separators=(",", ":"))

    def save(self, force=False, wait=-1):
        """Write the state atomically, only if it changed and not more often than save_every.
        The poller, the shutdown path and the watchdog all call this; `wait` bounds how long one waits for the others."""
        if not self.write_lock.acquire(timeout=wait):
            return
        try:
            self.write(force)
        finally:
            self.write_lock.release()

    def write(self, force):
        if not self.path or not (self.dirty or force):
            return
        if not force and self.clock() - self.saved_at < self.save_every:
            return
        with self.cond:
            text = self.dump()
            self.dirty = False
        self.saved_at = self.clock()
        if text == self.saved:
            return
        if len(text) > MAX_STATE_BYTES:
            if self.oversize_warned:
                return
            self.oversize_warned = True
            log.warning("state is %d bytes, over the %d byte limit: history is kept in memory only", len(text), MAX_STATE_BYTES)
            return
        d = os.path.dirname(self.path)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".state-")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
            self.saved = text
        except OSError as e:
            log.warning("cannot write state file: %s", e)
            self.dirty = True
            if os.path.exists(tmp):
                os.unlink(tmp)

    def load(self):
        d = os.path.dirname(self.path)
        for n in os.listdir(d) if os.path.isdir(d) else []:  # leftovers of an interrupted write
            if n.startswith(".state-"):
                os.unlink(os.path.join(d, n))
        try:
            with open(self.path) as f:
                raw = f.read(MAX_STATE_BYTES + 1)
            if len(raw) > MAX_STATE_BYTES:
                raise ValueError("file too large")
            data = json.loads(raw)
            if not well_formed(data):
                raise ValueError("unexpected structure")
            self.tags, self.seq, self.baselined = data["tags"], data["seq"], data["baselined"]
            self.meta = data.get("meta", {})
            self.since = data["since"]
            self.events = deque(data["events"])
            self.prune(self.clock())
            self.saved = raw
        except FileNotFoundError:
            pass
        except (ValueError, KeyError, TypeError, OSError) as e:
            log.warning("ignoring unreadable state file: %s", e)
            self.tags, self.events, self.seq, self.baselined, self.meta = {}, deque(), 0, False, {}


class Poller(threading.Thread):
    """Walks catalog and tags every `interval` seconds, at most `max_tags` tags per cycle, resuming where it stopped.
    A push uploads its layers before its manifest, and between the two the catalog lists a new repository while its tag
    list answers 404. While one waits like that, the walk runs every `burst` seconds, for at most `burst_max` seconds
    after it was first seen, so its tags show within seconds of the manifest. burst 0 turns this off."""
    def __init__(self, client, state, interval=30, max_tags=500, burst=5, burst_max=600):
        super().__init__(daemon=True, name="poller")
        self.client, self.state, self.interval, self.max_tags = client, state, interval, max_tags
        self.burst, self.burst_max = burst, burst_max
        self.cursor, self.covered, self.stop, self.kick = "", set(), threading.Event(), threading.Event()
        self.partial = ("", {})  # a repository larger than the budget, with the tags checked so far
        self.throttle, self.last_tick = Throttle(), time.monotonic()
        self.pending = {}  # repository in the catalog whose tag list is 404 (a push in progress) -> when first seen

    def healthy(self):
        return time.monotonic() - self.last_tick < 3 * max(self.interval, 300)

    def pushing(self, repo):
        """A tags request answered 404 for a listed repository: start the burst now, not at the next walk.
        Only a repository not yet known wakes the walk, so repeated requests cannot drive it faster than the burst."""
        if repo not in self.pending:
            self.pending[repo] = time.monotonic()
            self.wake()

    def wait_for(self, fails):
        """Seconds to the next cycle: the interval, backing off on failure, shorter while a push is in progress.
        A failing registry always backs off, burst or not."""
        wait = min(self.interval * 2 ** min(fails, 8), 300)
        now = time.monotonic()
        if self.burst > 0 and not fails and any(now - t < self.burst_max for t in self.pending.values()):
            wait = min(wait, self.burst)
        return wait

    def wake(self):
        self.kick.set()

    def learn(self, r, mtype, digest):
        """Record whether a digest is an index, and its kind. The kind needs a read of the manifest, once per digest."""
        if not digest or self.state.known(digest):
            return
        index = mtype in R.INDEX_TYPES
        kind = "image"
        if not index:
            try:
                data = self.client.manifest(r, digest)[0]
            except R.RegistryError:  # not read this time, tried again next cycle
                return
            try:
                config = R.json_load(data).get("config")
                kind = R.kind_of(config.get("mediaType") if isinstance(config, dict) else None)
            except (R.RegistryError, RecursionError, AttributeError) as e:  # a digest names its content, so it stays unreadable: do not retry it
                self.throttle.error("manifest", f"cannot read manifest {digest}: {getattr(e, 'message', e)}")
                kind = "artifact"
        self.state.learn(digest, index, kind)

    def scan(self, r, budget):
        """Check up to `budget` more tags of r. Returns (digests by ref, tags checked), or None while r is unfinished."""
        tags = sorted(self.client.tags(r))
        name, done = self.partial
        done = done if name == r else {}
        todo = [t for t in tags if t not in done][:budget]
        for t in todo:
            _, mtype, done[t] = self.client.manifest(r, t, head=True)
            self.learn(r, mtype, done[t])
            self.last_tick = time.monotonic()  # progress, so a slow registry is not mistaken for a stall
        self.partial = (r, done)
        if any(t not in done for t in tags):
            return None, len(todo)
        self.partial = ("", {})
        return {f"{r}:{t}": done[t] for t in tags}, max(len(todo), 1)

    def cycle(self):
        repos = sorted(self.client.catalog())
        order = [r for r in repos if r > self.cursor] + [r for r in repos if r <= self.cursor]
        scanned, observed, budget = set(), {}, self.max_tags
        pending, skipped = set(), set()
        for r in order:
            if budget <= 0:
                break
            try:
                found, used = self.scan(r, budget)
            except Exception as e:  # a repo deleted mid-walk, or one bad tag: skip it this cycle, but a dead registry aborts
                if getattr(e, "status", 0) not in (404, 400):
                    raise
                skipped.add(r)
                if e.status == 404:
                    pending.add(r)
                self.throttle.error(f"skip {r}", f"skipping {r}: {getattr(e, 'message', e)}")
                self.partial = ("", {})
                continue
            budget -= used
            if found is None:  # unfinished: resume here next cycle, report nothing for r yet
                break
            observed.update(found)
            scanned.add(r)
            self.cursor = r
        # A waiting repository this cycle did not reach (its budget ran out first) keeps its first-seen time, so
        # burst_max still bounds the burst.
        now = time.monotonic()
        kept = (set(self.pending) & set(repos)) - scanned - skipped
        self.pending = {r: self.pending.get(r, now) for r in pending | kept}
        gone = {k.rsplit(":", 1)[0] for k in self.state.tags} - set(repos)
        self.state.update(scanned, observed, gone)
        if not self.state.baselined:
            self.covered |= scanned | skipped  # a repository that cannot be read (a push that never finished) must not hold off the baseline
            if self.covered >= set(repos):
                self.state.mark_baselined()

    def run(self):
        fails = 0
        while not self.stop.is_set():
            try:
                self.cycle()
                fails = 0
                self.throttle.ok("registry")
            except Exception as e:  # the poller must never die
                fails += 1
                self.throttle.error("registry", f"poll failed: {getattr(e, 'message', e)}")
            try:
                self.state.save()
            except Exception as e:
                self.throttle.error("state", f"state save failed: {e}")
            self.last_tick = time.monotonic()
            self.kick.wait(self.wait_for(fails))
            self.kick.clear()
