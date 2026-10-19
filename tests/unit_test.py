import http.server
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
import poller as P  # noqa: E402
import registry as R  # noqa: E402
import server as S  # noqa: E402

IDX = "application/vnd.oci.image.index.v1+json"
IMG = "application/vnd.oci.image.manifest.v1+json"
D = lambda c: "sha256:" + c * 64  # noqa: E731


class FakeClient:
    """Records every call. Manifests: an index A with children B and C, and image manifests with one config and one layer."""
    def __init__(self):
        self.calls = []
        b = lambda blobs: ('{"config":{"digest":"%s"},"layers":[{"digest":"%s"}]}' % blobs).encode()  # noqa: E731
        self.m = {
            D("a"): (('{"manifests":[{"digest":"%s"},{"digest":"%s"}]}' % (D("b"), D("c"))).encode(), IDX, D("a")),
            D("b"): (b((D("1"), D("2"))), IMG, D("b")),
            D("c"): (b((D("3"), D("4"))), IMG, D("c")),
        }

    def manifest(self, repo, ref, head=False):
        return self.m[ref if ref in self.m else D("a")]

    def call(self, method, path, headers=None, body=None, ok=(200,)):
        self.calls.append((method, path))
        status = 201
        return status, {}, b""


class Names(unittest.TestCase):
    def test_repo(self):
        for good in ["a", "a/b", "a-b/c.d_e", "team/app__x", "a" * 255]:
            R.check_repo(good)
        for bad in ["", "A", "a//b", "/a", "a/", "a b", "-a", "a..b", "../x", "a" * 256, "a/b?x=1", "a%2fb"]:
            with self.assertRaises(R.RegistryError, msg=bad):
                R.check_repo(bad)

    def test_ref(self):
        for good in ["latest", "v1.2.3", "_x", D("a"), "a" * 128]:
            R.check_ref(good)
        for bad in ["", ".x", "-x", "a" * 129, "a/b", "sha256:abc", "x y", "a@b"]:
            with self.assertRaises(R.RegistryError, msg=bad):
                R.check_ref(bad)

    def test_delete_needs_digest(self):
        with self.assertRaises(R.RegistryError):
            R.delete(FakeClient(), "a/b", "latest")


class Copy(unittest.TestCase):
    def test_children_and_blobs_before_index(self):
        c = FakeClient()
        digest = R.copy(c, "src/app", "latest", "dst/app", "v1")
        self.assertEqual(digest, D("a"))
        puts = [p for m, p in c.calls if m == "PUT"]
        # both child manifests are put by digest, then the index under the requested tag, last
        self.assertEqual(puts, [f"/v2/dst/app/manifests/{D('b')}", f"/v2/dst/app/manifests/{D('c')}", "/v2/dst/app/manifests/v1"])
        order = [p for m, p in c.calls]
        # each child's blobs are mounted before that child's manifest is put
        self.assertLess(order.index(f"/v2/dst/app/blobs/uploads/?mount={D('2')}&from=src/app"), order.index(puts[0]))
        self.assertLess(order.index(f"/v2/dst/app/blobs/uploads/?mount={D('4')}&from=src/app"), order.index(puts[1]))

    def test_same_repo_mounts_nothing(self):
        c = FakeClient()
        R.copy(c, "a/b", "latest", "a/b", "copy")
        self.assertFalse([p for m, p in c.calls if "blobs" in p])

    def test_move_same_repo_refused(self):
        with self.assertRaises(R.RegistryError):
            R.move(FakeClient(), "a/b", "t", "a/b", "u")


class Csrf(unittest.TestCase):
    def setUp(self):
        self.cfg = S.Config({})
        self.h = {"Content-Type": "application/json", "X-CSRF-Token": self.cfg.csrf, "Host": "ui:8080"}

    def test_good(self):
        self.assertTrue(S.csrf_ok(self.cfg, self.h))
        self.assertTrue(S.csrf_ok(self.cfg, {**self.h, "Origin": "http://ui:8080"}))

    def test_bad(self):
        self.assertFalse(S.csrf_ok(self.cfg, {**self.h, "X-CSRF-Token": "x"}))
        self.assertFalse(S.csrf_ok(self.cfg, {k: v for k, v in self.h.items() if k != "X-CSRF-Token"}))
        self.assertFalse(S.csrf_ok(self.cfg, {**self.h, "Content-Type": "text/plain"}))
        self.assertFalse(S.csrf_ok(self.cfg, {**self.h, "Origin": "http://evil.example"}))


class Paths(unittest.TestCase):
    def test_location_host_is_dropped(self):
        self.assertEqual(R.local_path("http://evil.example/v2/a/blobs/uploads/u?_state=x"), "/v2/a/blobs/uploads/u?_state=x")

    def test_non_v2_path_refused(self):
        with self.assertRaises(R.RegistryError):
            R.Client("http://registry:5000").open("GET", "/admin")


def make_cert(d, san):
    """Self-signed cert for the given subjectAltName, written to d. Returns (cert, key)."""
    cert, key = os.path.join(d, "c.pem"), os.path.join(d, "k.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=test",
                    "-addext", f"subjectAltName={san}", "-keyout", key, "-out", cert], check=True, capture_output=True)
    return cert, key


@unittest.skipUnless(shutil.which("openssl"), "openssl not installed")
class Tls(unittest.TestCase):
    def serve(self, san):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        cert, key = make_cert(d, san)
        ctx = S.server_context(cert, key)
        self.assertEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), S.make_handler(S.Config({})))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return cert, httpd.server_address[1]

    def test_leaf_as_ca_is_trusted(self):
        cert, port = self.serve("DNS:localhost")
        c = R.Client(f"https://localhost:{port}", cafile=cert)
        self.assertEqual(c.call("GET", "/v2/x", ok=(404,))[0], 404)  # the UI answers 404 for unknown paths

    def test_without_ca_is_refused(self):
        cert, port = self.serve("DNS:localhost")
        with self.assertRaises(R.RegistryError) as e:
            R.Client(f"https://localhost:{port}").call("GET", "/v2/x")
        self.assertIn("TLS verification failed", e.exception.message)

    def test_name_not_in_san_says_so(self):
        cert, port = self.serve("DNS:other.example.internal")
        with self.assertRaises(R.RegistryError) as e:
            R.Client(f"https://localhost:{port}", cafile=cert).call("GET", "/v2/x")
        self.assertIn("subjectAltName", e.exception.message)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Diff(unittest.TestCase):
    def test_new_retagged_deleted_unchanged(self):
        old = {"a:1": "d1", "a:2": "d2", "a:3": "d3"}
        new = {"a:1": "d1", "a:2": "dX", "a:4": "d4"}
        got = {(e["type"], e["ref"]) for e in P.diff(old, new, 5)}
        self.assertEqual(got, {("retagged", "a:2"), ("new", "a:4"), ("deleted", "a:3")})

    def test_retag_keeps_previous_digest(self):
        (e,) = P.diff({"a:1": "d1"}, {"a:1": "d2"}, 5)
        self.assertEqual((e["prev"], e["digest"]), ("d1", "d2"))


class StateTests(unittest.TestCase):
    def state(self, **kw):
        return P.State(clock=kw.pop("clock", Clock()), **kw)

    def test_no_events_before_baseline(self):
        s = self.state()
        s.update({"a"}, {"a:1": "d1"})
        self.assertEqual(len(s.events), 0)
        s.mark_baselined()
        s.update({"a"}, {"a:1": "d2", "a:2": "d3"})
        self.assertEqual(sorted(e["type"] for e in s.events), ["new", "retagged"])

    def test_partial_scan_does_not_delete_other_repos(self):
        s = self.state()
        s.update({"a", "b"}, {"a:1": "d1", "b:1": "d2"})
        s.mark_baselined()
        s.update({"a"}, {"a:1": "d1"})
        self.assertIn("b:1", s.tags)
        s.update({"a"}, {"a:1": "d1"}, gone={"b"})
        self.assertNotIn("b:1", s.tags)
        self.assertEqual([e["type"] for e in s.events], ["deleted"])

    def test_event_count_cap(self):
        s = self.state(max_events=5)
        s.mark_baselined()
        for i in range(50):
            s.update({"a"}, {"a:1": f"d{i}"})
        self.assertEqual(len(s.events), 5)
        self.assertEqual(s.events[-1]["seq"], 50)

    def test_event_age_cap(self):
        clk = Clock()
        s = self.state(clock=clk, max_age=100)
        s.mark_baselined()
        s.update({"a"}, {"a:1": "d1"})
        clk.now += 101
        s.update({"a"}, {"a:1": "d1"})
        self.assertEqual(len(s.events), 0)

    def test_persistence_round_trip_and_atomic_write(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "state.json")
        s = P.State(path, clock=Clock())
        s.mark_baselined()
        s.update({"a"}, {"a:1": "d1"})
        s.save(force=True)
        self.assertEqual(os.listdir(d), ["state.json"])  # no temp file left behind
        t = P.State(path, clock=Clock())
        self.assertEqual((t.tags, list(t.events), t.seq, t.baselined), (s.tags, list(s.events), s.seq, True))
        mtime = os.stat(path).st_mtime_ns
        s.save(force=True)  # unchanged content is not rewritten
        self.assertEqual(os.stat(path).st_mtime_ns, mtime)

    def test_save_is_rate_limited(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        clk = Clock()
        s = P.State(os.path.join(d, "state.json"), save_every=30, clock=clk)
        s.mark_baselined()
        s.update({"a"}, {"a:1": "d1"})
        s.save()
        first = open(s.path).read()
        s.update({"a"}, {"a:1": "d2"})
        s.save()
        self.assertEqual(open(s.path).read(), first)
        clk.now += 31
        s.save()
        self.assertNotEqual(open(s.path).read(), first)

    def test_corrupt_file_is_ignored_and_load_applies_caps(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "state.json")
        open(path, "w").write("{broken")
        open(os.path.join(d, ".state-leftover"), "w").write("x")
        s = P.State(path)
        self.assertEqual((s.tags, len(s.events)), ({}, 0))
        self.assertEqual(os.listdir(d), ["state.json"])


class FakeRegistry:
    def __init__(self, repos):
        self.repos, self.heads = repos, 0

    def catalog(self):
        return list(self.repos)

    def tags(self, r):
        return list(self.repos[r])

    def manifest(self, r, t, head=False):
        self.heads += 1
        return b"", "", self.repos[r][t]


class PollerTests(unittest.TestCase):
    def test_work_per_cycle_is_capped_and_resumes(self):
        reg = FakeRegistry({f"r{i}": {"t": f"d{i}"} for i in range(10)})
        st = P.State(clock=Clock())
        p = P.Poller(reg, st, max_tags=3)
        p.cycle()
        self.assertEqual(reg.heads, 3)
        self.assertFalse(st.baselined)
        for _ in range(3):
            p.cycle()
        self.assertTrue(st.baselined)
        self.assertEqual(len(st.tags), 10)

    def test_detects_changes_after_baseline(self):
        reg = FakeRegistry({"a": {"1": "d1"}})
        st = P.State(clock=Clock())
        p = P.Poller(reg, st, max_tags=100)
        p.cycle()
        reg.repos["a"]["2"] = "d2"
        reg.repos["a"]["1"] = "dX"
        p.cycle()
        del reg.repos["a"]
        p.cycle()
        self.assertEqual(sorted((e["type"], e["ref"]) for e in st.events), [("deleted", "a:1"), ("deleted", "a:2"), ("new", "a:2"), ("retagged", "a:1")])

    def test_poller_survives_errors(self):
        class Down(FakeRegistry):
            def catalog(self):
                raise R.RegistryError(502, "registry unreachable")
        p = P.Poller(Down({}), P.State(clock=Clock()), interval=0)
        p.kick.set()
        t = threading.Thread(target=p.run, daemon=True)
        t.start()
        t.join(0.3)
        self.assertTrue(t.is_alive())
        p.stop.set()
        p.kick.set()


class ThrottleTests(unittest.TestCase):
    def test_repeated_errors_collapse(self):
        clk = Clock()
        th = P.Throttle(every=600, clock=clk)
        with self.assertLogs("poller", "INFO") as cm:
            for _ in range(100):
                th.error("registry", "poll failed: down")
                clk.now += 1
            clk.now += 600
            th.error("registry", "poll failed: down")
            th.error("registry", "poll failed: other")
            th.ok("registry")
        self.assertEqual(len(cm.output), 4)  # first, reminder with count, state change, recovery
        self.assertIn("repeated 99 more times", cm.output[1])


class Bounded(unittest.TestCase):
    def test_excess_connections_get_503(self):
        import socket
        cfg = S.Config({"UI_MAX_SSE": "2"})
        srv = S.BoundedServer(("127.0.0.1", 0), S.make_handler(cfg), 2)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        port = srv.server_address[1]
        held = [socket.create_connection(("127.0.0.1", port)) for _ in range(2)]  # idle connections hold the slots
        self.addCleanup(lambda: [h.close() for h in held])
        import time
        time.sleep(0.3)
        c = socket.create_connection(("127.0.0.1", port))
        self.addCleanup(c.close)
        c.settimeout(3)
        self.assertTrue(c.recv(100).startswith(b"HTTP/1.1 503"))

    def test_sse_clients_are_capped(self):
        cfg = S.Config({"UI_MAX_SSE": "1"})
        self.assertTrue(cfg.sse_slots.acquire(blocking=False))
        self.assertFalse(cfg.sse_slots.acquire(blocking=False))


if __name__ == "__main__":
    unittest.main()
