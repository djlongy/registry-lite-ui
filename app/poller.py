"""Change detection. A poller walks the registry and State keeps a bounded, optionally persisted event history.
The registry API has no push timestamps, so a change is the moment the poller first sees it."""
import json
import logging
import os
import tempfile
import threading
import time
from collections import deque

log = logging.getLogger("poller")


def diff(old, new, now):
    """Events between two {ref: digest} maps, where ref is repo:tag."""
    ev = [{"t": now, "type": "new" if k not in old else "retagged", "ref": k, "digest": d, "prev": old.get(k)}
          for k, d in new.items() if old.get(k) != d]
    ev += [{"t": now, "type": "deleted", "ref": k, "digest": None, "prev": d} for k, d in old.items() if k not in new]
    return ev


def repo_of(ref):
    return ref.rsplit(":", 1)[0]


class Throttle:
    """Log an error when it changes, then at most every `every` seconds with a repeat count. Log recovery once."""
    def __init__(self, every=600, clock=time.monotonic):
        self.every, self.clock, self.seen = every, clock, {}

    def error(self, key, msg):
        now = self.clock()
        last_msg, last_t, skipped = self.seen.get(key, (None, 0, 0))
        if msg != last_msg or now - last_t >= self.every:
            log.warning("%s%s", msg, f" (repeated {skipped} more times)" if skipped and msg == last_msg else "")
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
        self.since = clock()
        self.cond = threading.Condition()
        self.saved, self.saved_at, self.dirty = None, 0, False
        if path:
            self.load()

    def update(self, scanned, observed, gone=()):
        """Apply one poll. `scanned` repos were walked completely, `observed` maps their refs to digests, `gone` repos left the catalog."""
        now = self.clock()
        with self.cond:
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
            self.dirty = self.dirty or bool(ev)
            if ev and self.baselined:
                self.cond.notify_all()
        return ev

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
                           "tags": self.tags, "events": list(self.events)}, sort_keys=True, separators=(",", ":"))

    def save(self, force=False):
        """Write the state atomically, only if it changed and not more often than save_every."""
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
        d = os.path.dirname(self.path)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".state-")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(text)
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
                raw = f.read()
            data = json.loads(raw)
            self.tags, self.seq, self.baselined = data["tags"], data["seq"], data["baselined"]
            self.since = data["since"]
            self.events = deque(data["events"])
            self.prune(self.clock())
            self.saved = raw
        except FileNotFoundError:
            pass
        except (ValueError, KeyError, TypeError, OSError) as e:
            log.warning("ignoring unreadable state file: %s", e)
            self.tags, self.events, self.seq, self.baselined = {}, deque(), 0, False


class Poller(threading.Thread):
    """Walks catalog and tags every `interval` seconds, at most `max_tags` tags per cycle, resuming where it stopped."""
    def __init__(self, client, state, interval=30, max_tags=500):
        super().__init__(daemon=True, name="poller")
        self.client, self.state, self.interval, self.max_tags = client, state, interval, max_tags
        self.cursor, self.covered, self.stop, self.kick = "", set(), threading.Event(), threading.Event()
        self.throttle, self.last_tick = Throttle(), time.monotonic()

    def healthy(self):
        return time.monotonic() - self.last_tick < 3 * max(self.interval, 300)

    def wake(self):
        self.kick.set()

    def cycle(self):
        repos = sorted(self.client.catalog())
        order = [r for r in repos if r > self.cursor] + [r for r in repos if r <= self.cursor]
        scanned, observed, budget = set(), {}, self.max_tags
        for r in order:
            if budget <= 0:
                break
            try:
                tags = self.client.tags(r)
                found = {f"{r}:{t}": self.client.manifest(r, t, head=True)[2] for t in tags}
            except Exception as e:  # a repo deleted mid-walk, or one bad tag: skip it this cycle, but a dead registry aborts
                if getattr(e, "status", 0) not in (404, 400):
                    raise
                continue
            observed.update(found)
            scanned.add(r)
            budget -= max(len(tags), 1)
            self.cursor = r
        gone = {k.rsplit(":", 1)[0] for k in self.state.tags} - set(repos)
        self.state.update(scanned, observed, gone)
        if not self.state.baselined:
            self.covered |= scanned
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
            self.kick.wait(min(self.interval * 2 ** min(fails, 8), 300))
            self.kick.clear()
