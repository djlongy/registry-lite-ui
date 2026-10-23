import http.server
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
import poller as P  # noqa: E402
import registry as R  # noqa: E402
import server as S  # noqa: E402
import gitlab as G  # noqa: E402
import pypi as Y  # noqa: E402

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
        c = FakeClient()
        with self.assertRaises(R.RegistryError):
            R.delete(c, "a/b", "latest")


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
        c = FakeClient()
        with self.assertRaises(R.RegistryError):
            R.move(c, "a/b", "t", "a/b", "u")


class StaticFiles(unittest.TestCase):
    def test_every_served_file_exists(self):
        for path, (name, ctype) in S.FILES.items():
            self.assertTrue((S.STATIC / name).is_file(), path)
        self.assertEqual(S.FILES["/favicon.svg"][1], "image/svg+xml")


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
        c = R.Client("http://registry:5000")
        with self.assertRaises(R.RegistryError):
            c.open("GET", "/admin")


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
        httpd = S.BoundedServer(("127.0.0.1", 0), S.make_handler(S.Config({})), 8)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
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
        c = R.Client(f"https://localhost:{port}")
        with self.assertRaises(R.RegistryError) as e:
            c.call("GET", "/v2/x")
        self.assertIn("TLS verification failed", e.exception.message)

    def test_name_not_in_san_says_so(self):
        cert, port = self.serve("DNS:other.example.internal")
        c = R.Client(f"https://localhost:{port}", cafile=cert)
        with self.assertRaises(R.RegistryError) as e:
            c.call("GET", "/v2/x")
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

    def test_empty_repositories_are_the_scanned_ones_with_no_tags(self):
        st = self.state()
        st.update({"a", "b", "c"}, {"a:1": "d1"})  # b and c were walked completely and have no tags
        self.assertEqual(st.empty, {"b", "c"})
        st.update({"b"}, {"b:2": "d2"})  # a push into b makes it non-empty
        self.assertEqual(st.empty, {"c"})
        st.update({"a"}, {})  # the last tag of a is deleted
        self.assertEqual(st.empty, {"a", "c"})
        st.update(set(), {}, gone={"c"})  # c left the catalog
        self.assertEqual(st.empty, {"a"})
        st.update(set(), {})  # a repository that was not walked this time keeps what is known about it
        self.assertEqual(st.empty, {"a"})

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
        self.heads += head
        if not head:  # a read by digest, for the kind
            return b"{}", "", t
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

    def test_records_index_and_kind_once_per_digest(self):
        helm = '{"config":{"mediaType":"application/vnd.cncf.helm.config.v1+json"}}'
        image = '{"config":{"mediaType":"application/vnd.oci.image.config.v1+json"}}'
        other = '{"config":{"mediaType":"application/vnd.example.thing.v1+json"}}'
        bodies = {D("1"): (image, IMG), D("2"): (helm, IMG), D("3"): (other, IMG), D("4"): ("{}", IDX)}

        class Reg(FakeRegistry):
            gets = []

            def manifest(self, r, t, head=False):
                if t.startswith("sha256:"):
                    self.gets.append(t)
                    return bodies[t][0].encode(), bodies[t][1], t
                return b"", bodies[self.repos[r][t]][1], self.repos[r][t]
        reg = Reg({"a": {"image": D("1"), "chart": D("2"), "art": D("3"), "multi": D("4"), "alias": D("1")}})
        st = P.State(clock=Clock())
        p = P.Poller(reg, st, max_tags=100)
        p.cycle()
        self.assertEqual({d: (v["index"], v["kind"]) for d, v in st.meta.items()},
                         {D("1"): (False, "image"), D("2"): (False, "helm"), D("3"): (False, "artifact"), D("4"): (True, "image")})
        self.assertEqual(sorted(reg.gets), [D("1"), D("2"), D("3")])  # an index and a repeated digest are not read
        p.cycle()
        self.assertEqual(len(reg.gets), 3)  # known digests are never read again

    def test_unreadable_manifest_is_tried_again_next_cycle(self):
        class Reg(FakeRegistry):
            bad = True

            def manifest(self, r, t, head=False):
                if t.startswith("sha256:"):
                    if self.bad:
                        raise R.RegistryError(500, "boom")
                    return b'{"config":{"mediaType":"application/vnd.cncf.helm.config.v1+json"}}', IMG, t
                return b"", IMG, self.repos[r][t]
        reg = Reg({"a": {"t": D("1")}})
        st = P.State(clock=Clock())
        p = P.Poller(reg, st)
        p.cycle()
        self.assertEqual((st.meta, len(st.tags)), ({}, 1))
        reg.bad = False
        p.cycle()
        self.assertEqual(st.traits(D("1")), {"index": False, "kind": "helm"})

    def test_hostile_manifest_does_not_stall_the_poller(self):
        deep = b"[" * 100000  # nested far past the recursion limit
        class Reg(FakeRegistry):
            gets = 0

            def manifest(self, r, t, head=False):
                if t.startswith("sha256:"):
                    self.gets += 1
                    return deep, IMG, t
                return b"", IMG, self.repos[r][t]
        reg = Reg({"a": {"bad": D("1"), "ok": D("2")}})
        st = P.State(clock=Clock())
        p = P.Poller(reg, st)
        p.cycle()
        self.assertEqual(len(st.tags), 2)  # the cycle finished
        self.assertEqual(st.traits(D("1")), {"index": False, "kind": "artifact"})
        p.cycle()
        self.assertEqual(reg.gets, 2)  # each digest was read once, the unreadable one is not retried
        with self.assertRaises(R.RegistryError):
            R.json_load(deep)

    def test_meta_is_saved_and_loaded(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        st = P.State(os.path.join(d, "state.json"), clock=Clock())
        st.learn(D("1"), False, "helm")
        st.save(force=True)
        self.assertEqual(P.State(os.path.join(d, "state.json"), clock=Clock()).traits(D("1")), {"index": False, "kind": "helm"})

    def test_push_in_progress_polls_in_bursts(self):
        class Reg(FakeRegistry):
            def tags(self, r):
                if r not in self.repos:  # in the catalog with layers only: the tag list is 404 until the manifest
                    raise R.RegistryError(404, "registry said 404 NAME_UNKNOWN")
                return super().tags(r)

            def catalog(self):
                return [*self.repos, "pushing"]
        reg = Reg({"a": {"1": "d1"}})
        p = P.Poller(reg, P.State(clock=Clock()), interval=60, burst=5, burst_max=600)
        self.assertEqual(p.wait_for(0), 60)
        p.cycle()
        self.assertEqual((set(p.pending), p.wait_for(0)), ({"pushing"}, 5))
        self.assertEqual(p.wait_for(1), 120)  # a failing registry backs off, burst or not
        first = p.pending["pushing"]
        p.cycle()
        self.assertEqual(p.pending["pushing"], first)  # the burst window runs from when the push was first seen
        p.pending["pushing"] -= 599
        self.assertEqual(p.wait_for(0), 5)
        p.pending["pushing"] -= 1  # a push that never finished goes back to the interval
        self.assertEqual(p.wait_for(0), 60)
        p.pending["pushing"] = first
        p.burst = 0  # UI_POLL_BURST=0 turns it off
        self.assertEqual(p.wait_for(0), 60)
        reg.repos["pushing"] = {"1": "d2"}
        p.cycle()
        self.assertEqual(p.pending, {})

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
    def test_excess_connections_are_closed_without_a_reply(self):
        cfg = S.Config({"UI_MAX_SSE": "2"})
        srv = S.BoundedServer(("127.0.0.1", 0), S.make_handler(cfg), 2)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        port = srv.server_address[1]
        held = [socket.create_connection(("127.0.0.1", port)) for _ in range(2)]  # idle connections hold the slots
        self.addCleanup(lambda: [h.close() for h in held])
        time.sleep(0.3)
        c = socket.create_connection(("127.0.0.1", port))
        self.addCleanup(c.close)
        c.settimeout(3)
        self.assertEqual(c.recv(100), b"")

    def test_sse_clients_are_capped(self):
        cfg = S.Config({"UI_MAX_SSE": "1"})
        self.assertTrue(cfg.sse_slots.acquire(blocking=False))
        self.assertFalse(cfg.sse_slots.acquire(blocking=False))



class Upstream:
    """A scripted registry: GET answers come from a table of path -> (status, headers, body)."""
    def __init__(self, table):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                status, headers, body = table.get(self.path, (404, {}, b"{}"))
                self.send_response(status)
                for k, v in {**headers, "Content-Length": str(len(body))}.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class Hostile(unittest.TestCase):
    """A registry response is not trusted."""
    def upstream(self, table):
        u = Upstream(table)
        self.addCleanup(u.close)
        return R.Client(u.url)

    def test_paging_loop_is_cut(self):
        link = {"Link": '</v2/_catalog?n=1000>; rel="next"'}
        c = self.upstream({"/v2/_catalog?n=1000": (200, link, b'{"repositories":["a"]}')})
        with self.assertRaises(R.RegistryError) as e:
            c.catalog()
        self.assertIn("paging", e.exception.message)

    def test_oversized_response_is_refused(self):
        c = self.upstream({"/v2/a/manifests/t": (200, {}, b"x" * 2048)})
        old, R.MAX_BODY = R.MAX_BODY, 1024
        self.addCleanup(setattr, R, "MAX_BODY", old)
        with self.assertRaises(R.RegistryError) as e:
            c.manifest("a", "t")
        self.assertIn("too large", e.exception.message)

    def test_manifest_must_match_its_digest(self):
        body = b'{"layers":[]}'
        good = "sha256:" + __import__("hashlib").sha256(body).hexdigest()
        c = self.upstream({"/v2/a/manifests/t": (200, {"Docker-Content-Digest": D("0")}, body),
                           f"/v2/a/manifests/{D('1')}": (200, {"Docker-Content-Digest": D("1")}, body),
                           f"/v2/a/manifests/{good}": (200, {}, body)})
        for ref in ("t", D("1")):
            with self.assertRaises(R.RegistryError, msg=ref):
                c.manifest("a", ref)
        self.assertEqual(c.manifest("a", good)[2], good)

    def test_sha512_manifests_are_hashed_too(self):
        body = b'{"schemaVersion":2}'
        lie = "sha512:" + "ab" * 64
        good = "sha512:" + __import__("hashlib").sha512(body).hexdigest()
        c = self.upstream({"/v2/a/manifests/t": (200, {"Docker-Content-Digest": lie}, body),
                           "/v2/a/manifests/u": (200, {"Docker-Content-Digest": good}, body)})
        with self.assertRaises(R.RegistryError):
            c.manifest("a", "t")
        self.assertEqual(c.manifest("a", "u")[2], good)

    def test_digests_from_a_manifest_are_checked(self):
        bad = json.dumps({"manifests": [{"digest": "../../x"}], "layers": [{"digest": "sha256:zz"}]}).encode()
        with self.assertRaises(R.RegistryError):
            R.children(bad, IDX)
        with self.assertRaises(R.RegistryError):
            R.blobs(bad)

    def test_error_text_never_carries_the_credentials(self):
        u = Upstream({"/v2/a/manifests/t": (500, {}, json.dumps({"errors": [{"code": "X", "message": "echo Basic cmVndXNlcjpjYW5hcnktMTIzNA== canary-1234\nFORGED"}]}).encode())})
        self.addCleanup(u.close)
        c = R.Client(u.url, "reguser", "canary-1234")
        with self.assertRaises(R.RegistryError) as e:
            c.manifest("a", "t")
        self.assertNotIn("canary", e.exception.message)
        self.assertNotIn("cmVnd", e.exception.message)

    def test_many_small_pages_are_cut(self):
        table = {}
        for i in range(30):
            link = {"Link": f'</v2/_catalog?last={i + 1}>; rel="next"'}
            table["/v2/_catalog?n=1000" if i == 0 else f"/v2/_catalog?last={i}"] = (200, link, json.dumps({"repositories": [f"r{i}/{j}" for j in range(1000)]}).encode())
        c = self.upstream(table)
        old, R.MAX_ITEMS = R.MAX_ITEMS, 5000
        self.addCleanup(setattr, R, "MAX_ITEMS", old)
        with self.assertRaises(R.RegistryError) as e:
            c.catalog()
        self.assertIn("too large", e.exception.message)

    def test_credentials_are_redacted_before_the_message_is_cut(self):
        pw = "p" * 16 + "q" * 16
        msg = "x" * 140 + pw  # the password straddles the old 200 character cut
        u = Upstream({"/v2/a/manifests/t": (500, {}, json.dumps({"errors": [{"code": "X", "message": msg}]}).encode())})
        self.addCleanup(u.close)
        c = R.Client(u.url, "reguser", pw)
        with self.assertRaises(R.RegistryError) as e:
            c.manifest("a", "t")
        self.assertNotIn("ppppp", e.exception.message)
        self.assertIn("[redacted]", e.exception.message)

    def test_catalog_drops_invalid_names_and_header_digest_is_checked(self):
        c = self.upstream({"/v2/_catalog?n=1000": (200, {}, json.dumps({"repositories": ["ok/app", "BAD", "x" * 300, 5]}).encode()),
                           "/v2/ok/app/manifests/t": (200, {"Docker-Content-Digest": "not-a-digest"}, b"{}")})
        self.assertEqual(c.catalog(), ["ok/app"])
        with self.assertRaises(R.RegistryError):
            c.manifest("ok/app", "t", head=True)

    def test_json_must_be_an_object(self):
        with self.assertRaises(R.RegistryError):
            R.json_load(b"[1]")

    def test_registry_url_is_validated(self):
        for bad in ["file:///etc/passwd", "ftp://h", "http://u:p@h:5000", "http://:p@h:5000", "http://h:5000#frag", "http://h:5000/x", "http://h?x=1", "registry:5000"]:
            with self.assertRaises(ValueError, msg=bad):
                R.Client(bad)

    def test_dot_dot_path_refused(self):
        c = R.Client("http://registry:5000")
        with self.assertRaises(R.RegistryError):
            c.open("GET", "/v2/a/../../x")

    def test_self_referencing_index_stops(self):
        class Loop(FakeClient):
            def manifest(self, repo, ref, head=False):
                return self.m[D("a")][0].replace(D("b").encode(), D("a").encode()), IDX, D("a")
        c = Loop()
        with self.assertRaises(R.RegistryError) as e:
            R.copy(c, "s/a", "latest", "d/a", "latest")
        self.assertIn("nesting", e.exception.message)

    def test_delete_keeps_an_independently_tagged_child(self):
        class Tagged(FakeClient):
            tags = lambda self, repo: ["index", "standalone"]  # noqa: E731
            delete_enabled = lambda self: True  # noqa: E731

            def manifest(self, repo, ref, head=False):
                return self.m[D("b") if ref == "standalone" else ref if ref in self.m else D("a")]
        gone = R.delete(Tagged(), "app", D("a"), with_children=True)
        self.assertEqual(gone, [D("a"), D("c")])


class ChildOfAnIndex(unittest.TestCase):
    """A digest that is also a child of a tagged index must not be deleted, or the index breaks for that platform."""
    def client(self):
        class C(FakeClient):
            tags = lambda self, repo: ["1.36", "certcheck"]  # noqa: E731
            delete_enabled = lambda self: True  # noqa: E731

            def manifest(self, repo, ref, head=False):
                return self.m[{"1.36": D("a"), "certcheck": D("b")}.get(ref, ref)]
        return C()

    def test_delete_of_a_child_is_refused_with_409(self):
        c, child = self.client(), D("b")
        with self.assertRaises(R.RegistryError) as e:
            R.delete(c, "test/busybox", child)
        self.assertEqual(e.exception.status, 409)
        self.assertIn("1.36", e.exception.message)
        self.assertEqual([m for m, _ in c.calls if m == "DELETE"], [])

    def test_the_index_itself_and_unrelated_digests_can_be_deleted(self):
        c = self.client()
        self.assertEqual(R.delete(c, "test/busybox", D("a")), [D("a")])

    def test_move_of_a_child_is_refused_before_anything_is_copied(self):
        c = self.client()
        with self.assertRaises(R.RegistryError) as e:
            R.move(c, "test/busybox", "certcheck", "other/busybox", "certcheck")
        self.assertEqual(e.exception.status, 409)
        self.assertEqual(c.calls, [])

    def test_a_grandchild_is_protected_through_an_untagged_middle_index(self):
        mid, leaf = D("7"), D("8")
        top = json.dumps({"manifests": [{"digest": mid, "mediaType": IDX, "platform": {"os": "linux", "architecture": "arm64"}}]}).encode()
        middle = json.dumps({"manifests": [{"digest": leaf, "mediaType": IMG}]}).encode()

        class C(FakeClient):
            tags = lambda self, repo: ["a"]  # noqa: E731
            delete_enabled = lambda self: True  # noqa: E731

            def manifest(self, repo, ref, head=False):
                return {"a": (top, IDX, D("6")), D("6"): (top, IDX, D("6")), mid: (middle, IDX, mid), leaf: (b"{}", IMG, leaf)}[ref]
        c = C()
        with self.assertRaises(R.RegistryError) as e:
            R.delete(c, "test/busybox", leaf)
        self.assertEqual(e.exception.status, 409)
        self.assertIn("(linux/arm64)", e.exception.message)
        self.assertEqual([m for m, _ in c.calls if m == "DELETE"], [])

    def test_message_text_is_controlled(self):
        evil = {"platform": {"os": "\x1b[31mred\nDeletion SUCCEEDED", "architecture": "amd64"}}
        self.assertEqual(R.platform_of(evil), "unknown/amd64")
        parents = {f"t{i}": "linux/amd64" for i in range(40)}
        child = D("b")
        with self.assertRaises(R.RegistryError) as e:
            R.refuse_parents(parents, child)
        self.assertIn("and 35 more", e.exception.message)
        self.assertLessEqual(len(e.exception.message), R.MAX_MESSAGE)

    def test_a_manifests_value_of_the_wrong_type_fails_closed(self):
        for bad in (b'{"manifests":{"digest":"x"}}', b'{"manifests":["x"]}'):
            with self.assertRaises(R.RegistryError) as e:
                R.child_entries(bad)
            self.assertEqual(e.exception.status, 502)

    def test_platform_is_named(self):
        self.assertEqual(R.platform_of({"platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}}), "linux/arm64/v8")
        self.assertEqual(R.platform_of({}), "")


class State2(unittest.TestCase):
    def test_wrong_shape_is_ignored(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "state.json")
        for text in ['{"v":1,"since":1,"baselined":true,"seq":1,"tags":{"a:1":5},"events":[]}',
                     '{"v":1,"since":1,"baselined":true,"seq":1,"tags":{},"events":[{"ref":1}]}', "[]"]:
            with open(path, "w") as f:
                f.write(text)
            s = P.State(path)
            self.assertEqual((s.tags, len(s.events), s.baselined), ({}, 0, False), text)

    def test_error_log_is_one_line(self):
        th = P.Throttle()
        with self.assertLogs("poller", "WARNING") as cm:
            th.error("registry", "bad\n2026-01-01 FAKE line\x1b[31m")
        self.assertEqual(len(cm.output[0].splitlines()), 1)


class BigRepo(unittest.TestCase):
    def test_one_repository_larger_than_the_budget(self):
        reg = FakeRegistry({"app": {f"t{i:02d}": f"d{i}" for i in range(10)}, "b": {"1": "x"}})
        st = P.State(clock=Clock())
        p = P.Poller(reg, st, max_tags=4)
        heads = []
        for _ in range(5):
            before = reg.heads
            p.cycle()
            heads.append(reg.heads - before)
        self.assertLessEqual(max(heads), 4)
        self.assertTrue(st.baselined)
        self.assertEqual(len(st.tags), 11)
        self.assertEqual(list(st.events), [])


    def test_empty_repositories_and_exact_multiples_do_not_stall(self):
        reg = FakeRegistry({"a": {f"t{i}": f"d{i}" for i in range(4)}, "b": {}, "c": {"1": "x"}, "d": {}})
        st = P.State(clock=Clock())
        p = P.Poller(reg, st, max_tags=4)
        for _ in range(4):
            p.cycle()
        self.assertTrue(st.baselined)
        self.assertEqual(len(st.tags), 5)


class Resilience(unittest.TestCase):
    def test_a_repository_with_a_hostile_tag_list_is_skipped_not_fatal(self):
        class Reg(FakeRegistry):
            def tags(self, r):
                if r == "a":
                    raise R.RegistryError(400, "registry list is too large")
                return super().tags(r)
        reg = Reg({"a": {}, "b": {"1": "d1"}})
        st = P.State(clock=Clock())
        P.Poller(reg, st, max_tags=10).cycle()
        self.assertIn("b:1", st.tags)

    def test_tag_lists_keep_only_valid_strings(self):
        u = Upstream({"/v2/a/tags/list?n=1000": (200, {}, json.dumps({"tags": ["ok", 5, {"x": 1}, "bad tag"]}).encode()),
                      "/v2/b/tags/list?n=1000": (200, {}, b'{"tags":"abc"}')})
        self.addCleanup(u.close)
        c = R.Client(u.url)
        self.assertEqual(c.tags("a"), ["ok"])
        with self.assertRaises(R.RegistryError) as e:
            c.tags("b")
        self.assertEqual(e.exception.status, 400)  # the poller skips a 400 and goes on

    def test_oversized_state_is_not_written_and_save_waits_for_the_lock(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        s = P.State(os.path.join(d, "state.json"), clock=Clock())
        s.mark_baselined()
        old, P.MAX_STATE_BYTES = P.MAX_STATE_BYTES, 10
        self.addCleanup(setattr, P, "MAX_STATE_BYTES", old)
        with self.assertLogs("poller", "WARNING") as cm:
            s.save(force=True)
            s.save(force=True)
        self.assertEqual(len(cm.output), 1)  # one warning, not one per save
        self.assertEqual(os.listdir(d), [])
        P.MAX_STATE_BYTES = old
        with s.write_lock:
            s.save(force=True, wait=0.1)  # gives up instead of hanging behind a stuck writer
        self.assertEqual(os.listdir(d), [])
        s.save(force=True)
        self.assertEqual(os.listdir(d), ["state.json"])

    def test_progress_ticks_the_watchdog(self):
        reg = FakeRegistry({"a": {f"t{i}": "d" for i in range(5)}})
        p = P.Poller(reg, P.State(clock=Clock()), max_tags=10)
        p.last_tick = 0
        p.scan("a", 10)
        self.assertGreater(p.last_tick, 0)


TOKEN = "glpat-test-token-value"


def upload(i, name, version, project=7, created="2026-10-01T10:00:00.000Z"):
    return {"id": i, "name": name, "version": version, "package_type": "pypi", "project_id": project, "project_path": f"grp/p{project}",
            "created_at": created, "last_downloaded_at": None, "_links": {"web_path": f"/grp/p{project}/-/packages/{i}"},
            "pipeline": {"id": 99, "ref": "main", "sha": "a" * 40}}


class FakeGitLab(http.server.BaseHTTPRequestHandler):
    """Group 5 (grp) with 250 uploads over three pages, files for upload 1, and a PEP 503 page for one project."""
    packages = [upload(1, "PyYAML", "6.0.2"), upload(2, "pyyaml", "6.0.3"), upload(3, "bad name!", "1"),
                *[upload(10 + i, f"pkg{i}", "1.0") for i in range(247)]]
    calls = []
    public = False  # whether the group index answers without a login

    def log_message(self, *a):
        pass

    def answer(self, status, body, ctype="application/json", headers=()):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(url.query)
        FakeGitLab.calls.append(url.path)
        basic = self.headers.get("Authorization", "")
        if url.path == "/api/v4/groups/5/-/packages/pypi/simple" and FakeGitLab.public:
            return self.answer(200, b"<html></html>", "text/html")
        if self.headers.get("PRIVATE-TOKEN") != TOKEN and not basic.startswith("Basic ") and not FakeGitLab.public:
            return self.answer(401, {"message": "401 Unauthorized"})
        if url.path == "/api/v4/groups/grp":
            return self.answer(200, {"id": 5, "full_path": "grp"})
        if url.path in ("/api/v4/projects/grp%2Fp7", "/api/v4/projects/7"):
            return self.answer(200, {"id": 7, "path_with_namespace": "grp/p7"})
        if url.path == "/api/v4/projects/7/packages":  # a project's list does not name the project in each row
            rows = [{k: v for k, v in p.items() if k not in ("project_id", "project_path")} for p in self.packages if p["project_id"] == 7][:100]
            return self.answer(200, rows, headers=[("X-Next-Page", "")])
        if url.path == "/api/v4/groups/5/packages":
            page, per = int(q["page"][0]), int(q["per_page"][0])
            rows = self.packages[(page - 1) * per: page * per]
            more = page * per < len(self.packages)
            return self.answer(200, rows, headers=[("X-Next-Page", str(page + 1) if more else "")])
        if url.path == "/api/v4/projects/7/packages/1/package_files":
            return self.answer(200, [{"file_name": "PyYAML-6.0.2-cp39-cp39-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", "size": 737360,
                                      "file_sha256": "3b" * 32, "created_at": "2026-10-01T10:00:00.000Z"},
                                     {"file_name": "PyYAML-6.0.2.tar.gz", "size": 1000, "file_sha256": "zz", "created_at": "x"},
                                     {"file_name": "../etc/passwd", "size": 1}])
        if url.path == "/api/v4/projects/7/packages/pypi/simple/pyyaml":
            return self.answer(200, b'<a href="https://g/api/v4/projects/7/packages/pypi/files/3b/PyYAML-6.0.2-cp39-cp39-manylinux_2_17_x86_64.manylinux2014_x86_64.whl#sha256=3b" '
                                    b'data-requires-python="&gt;=3.8">x</a><a href="files/1/PyYAML-6.0.2.tar.gz#sha256=1">y</a>', "text/html")
        self.answer(404, {"message": "404 Not Found"})


def serve_fake(handler):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd



class PypiSource(unittest.TestCase):
    """The optional PyPI source: off without GITLAB_URL, and behind a login when an auth proxy is in front."""
    @classmethod
    def setUpClass(cls):
        cls.gl = serve_fake(FakeGitLab)
        cls.base = f"http://127.0.0.1:{cls.gl.server_address[1]}"
        cls.env = {"PYPI_INDEX_URL": f"{cls.base}/api/v4/groups/grp/-/packages/pypi/simple", "GITLAB_TOKEN": TOKEN}

    @classmethod
    def tearDownClass(cls):
        cls.gl.shutdown()

    def serve(self, env):
        cfg = S.Config(env)
        if cfg.pypi:
            cfg.pypi.poller.cycle()
        srv = S.BoundedServer(("127.0.0.1", 0), S.make_handler(cfg), 8)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return cfg, srv.server_address[1]

    def get(self, port, path, extra=""):
        c = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.addCleanup(c.close)
        c.sendall(f"GET {path} HTTP/1.0\r\nHost: t\r\n{extra}\r\n".encode())
        out = b""
        while chunk := c.recv(65536):
            out += chunk
        head, _, body = out.partition(b"\r\n\r\n")
        return int(head.split(b" ")[1]), body

    def test_off_without_gitlab(self):
        cfg, port = self.serve({})
        self.assertIsNone(cfg.pypi)
        self.assertEqual(self.get(port, "/api/pypi/packages")[0], 404)
        _, port = self.serve({"UI_LOGIN_URL": "/oauth2/start"})  # behind a proxy, still no PyPI: 404, not a crash
        self.assertEqual(self.get(port, "/api/pypi/packages")[0], 404)

    def test_locked_config_names_no_group(self):
        cfg = S.Config({**self.env, "UI_LOGIN_URL": "/oauth2/start"})
        cfg.client.delete_enabled = lambda: True  # /api/config asks the registry, and there is none here
        cfg.pypi.poller.cycle()
        srv = S.BoundedServer(("127.0.0.1", 0), S.make_handler(cfg), 8)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        port = srv.server_address[1]
        self.assertEqual(json.loads(self.get(port, "/api/config")[1])["pypi"], {"locked": True})  # no host, no group
        opened = json.loads(self.get(port, "/api/config", "X-Forwarded-Email: a@example.internal\r\n")[1])["pypi"]
        self.assertEqual((opened["ref"], opened["kind"], opened["indexAuth"]), ("grp", "group", "token"))

    def test_packages_files_and_index_auth(self):
        cfg, port = self.serve(self.env)
        status, body = self.get(port, "/api/pypi/packages")
        self.assertEqual((status, len(json.loads(body)["packages"])), (200, 249))
        status, body = self.get(port, "/api/pypi/files?id=1&project=999&name=zzz")  # project and name come from the catalog
        self.assertEqual(json.loads(body)[0]["requires"], ">=3.8")
        self.assertEqual(self.get(port, "/api/pypi/files?id=424242")[0], 404)  # not an upload of this group
        self.assertEqual(cfg.pypi.config()["indexAuth"], "token")  # the fake answers 401 without a login

    def test_login_guards_pypi_only(self):
        _, port = self.serve({**self.env, "UI_LOGIN_URL": "/oauth2/start"})
        for path in ("/api/pypi/packages", "/api/pypi/files?id=1", "/api/pypi/seq"):
            self.assertEqual(self.get(port, path)[0], 401, path)
        self.assertEqual(self.get(port, "/api/pypi/packages", "X-Forwarded-Email: a@example.internal\r\n")[0], 200)
        _, port = self.serve({**self.env, "UI_LOGIN_URL": "/oauth2/start", "UI_PYPI_PUBLIC": "true"})
        self.assertEqual(self.get(port, "/api/pypi/packages")[0], 200)

    def test_public_group_needs_no_token(self):
        FakeGitLab.public = True
        self.addCleanup(setattr, FakeGitLab, "public", False)
        cfg, port = self.serve({**self.env, "GITLAB_TOKEN": ""})
        status, body = self.get(port, "/api/pypi/packages")
        self.assertEqual((status, len(json.loads(body)["packages"])), (200, 249))
        self.assertEqual(cfg.pypi.config()["indexAuth"], "none")
        FakeGitLab.public = False
        with self.assertRaises(G.GitLabError) as e:  # the group turned private: no token, so reads fail (the poller logs it)
            cfg.pypi.poller.cycle()
        self.assertIn("token", e.exception.message)
        self.assertEqual(len(cfg.pypi.catalog.snapshot()["packages"]), 249)  # the last list stays

    def test_errors_say_what_to_fix(self):
        c = G.Client(self.base, "a-deploy-token")  # GitLab answers a deploy token 401 on the REST API, as for no token
        with self.assertRaises(G.GitLabError) as e:
            c.scope("project", "7")
        self.assertIn("deploy token", e.exception.message)
        c = G.Client(self.base, TOKEN)
        with self.assertRaises(G.GitLabError) as e:  # a project path given where a group is expected
            c.scope("group", "grp/p7")
        self.assertIn("/api/v4/projects/<id or path>/packages/pypi/simple", e.exception.message)

    def test_config_is_checked(self):
        bad_urls = ("g.example", f"{self.base}/api/v4/groups/grp/packages/pypi/simple", f"{self.base}/api/v4/projects/7/-/packages/pypi/simple",
                    f"{self.base}/api/v4/users/7/packages/pypi/simple", "javascript:alert(1)")
        for change in [{"PYPI_INDEX_URL": u} for u in bad_urls] + [{"UI_PYPI_PUBLIC_URL": "javascript:x"}, {"UI_PYPI_INDEX_AUTH": "maybe"}]:
            with self.assertRaises(ValueError, msg=change):
                Y.Source({**self.env, **change})

    def test_index_url_forms(self):
        cases = {
            "https://g.example/api/v4/groups/10/-/packages/pypi/simple": ("https://g.example", "group", "10"),
            "https://g.example/api/v4/groups/team%2Fpython/-/packages/pypi": ("https://g.example", "group", "team/python"),
            "https://g.example/gitlab/api/v4/projects/104/packages/pypi/simple/": ("https://g.example/gitlab", "project", "104"),
            "http://g.example:8080/api/v4/projects/pub%2Fpkgs/packages/pypi/simple": ("http://g.example:8080", "project", "pub/pkgs"),
        }
        for url, want in cases.items():
            self.assertEqual(G.parse_index(url), want, url)
        self.assertEqual(Y.index_url({"GITLAB_URL": "https://g.example/", "GITLAB_GROUP": "team/python"}),  # the 0.2.0 settings still work
                         "https://g.example/api/v4/groups/team%2Fpython/-/packages/pypi/simple")

    def test_project_index(self):
        cfg, port = self.serve({**self.env, "PYPI_INDEX_URL": f"{self.base}/api/v4/projects/grp%2Fp7/packages/pypi/simple"})
        status, body = self.get(port, "/api/pypi/packages")
        snap = json.loads(body)
        self.assertEqual((status, snap["scope"]), (200, {"kind": "project", "id": 7, "path": "grp/p7"}))
        self.assertEqual({p["project"] for p in snap["packages"]}, {"grp/p7"})  # filled in from the project, which the rows leave out
        self.assertTrue(cfg.pypi.config()["index"].endswith("/api/v4/projects/7/packages/pypi/simple"))

    def test_wheel_tags(self):
        d = G.describe("x-1.0-cp312-cp312-manylinux_2_17_x86_64.musllinux_1_1_x86_64.whl")
        self.assertEqual([(p["os"], p["arch"]) for p in d["platforms"]], [("linux (musl) 1.1+", "x86_64"), ("linux glibc 2.17+", "x86_64")])
        self.assertEqual(G.describe("numpy-2.1.0-cp312-cp312-win_amd64.whl")["platforms"], [{"os": "windows", "arch": "amd64"}])


class Http(unittest.TestCase):
    def serve(self, env=None, conns=8):
        cfg = S.Config(env or {})
        srv = S.BoundedServer(("127.0.0.1", 0), S.make_handler(cfg), conns)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return cfg, srv.server_address[1]

    def talk(self, port, request, timeout=5):
        c = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.addCleanup(c.close)
        c.sendall(request)
        out = b""
        while chunk := c.recv(4096):
            out += chunk
        return out

    def post(self, port, cfg_csrf, length, body=b"{}", extra=""):
        return self.talk(port, (f"POST /api/copy HTTP/1.0\r\nHost: t\r\nContent-Type: application/json\r\nX-CSRF-Token: {cfg_csrf}\r\n"
                                f"Content-Length: {length}\r\n{extra}\r\n").encode() + body)

    def test_body_framing_is_strict(self):
        cfg, port = self.serve()
        status = lambda out: out.split(b"\r\n")[0].split(b" ")[1]  # noqa: E731
        self.assertEqual(status(self.post(port, cfg.csrf, "-1", b"x" * 100)), b"411")
        self.assertEqual(status(self.post(port, cfg.csrf, "abc")), b"411")
        self.assertEqual(status(self.post(port, cfg.csrf, "2", extra="Transfer-Encoding: chunked\r\n")), b"411")
        self.assertEqual(status(self.post(port, cfg.csrf, "5000", b"x" * 5000)), b"413")
        self.assertEqual(status(self.post(port, cfg.csrf, "2")), b"400")  # well formed, but no src/dst keys
        self.assertEqual(status(self.post(port, "wrong", "2")), b"403")

    def test_login_guards_changes(self):
        status = lambda out: out.split(b"\r\n")[0].split(b" ")[1]  # noqa: E731
        cfg, port = self.serve()  # no auth proxy: CSRF is the only gate
        self.assertEqual(status(self.post(port, "wrong", "2")), b"403")
        cfg, port = self.serve({"UI_LOGIN_URL": "/oauth2/start"})
        self.assertEqual(status(self.post(port, cfg.csrf, "2")), b"401")  # anonymous
        self.assertEqual(status(self.post(port, cfg.csrf, "2", extra="X-Forwarded-Email: a@example.internal\r\n")), b"400")  # past the guard
        self.assertEqual(S.user_of({"X-Forwarded-User": "u1"}), "u1")
        self.assertEqual(S.user_of({}), "")

    def test_headers_and_methods(self):
        srv, port = self.serve()
        out = self.talk(port, b"GET /nope HTTP/1.0\r\nHost: t\r\n\r\n")
        self.assertIn(b" 404 ", out.split(b"\r\n")[0])
        for h in (b"Content-Security-Policy", b"X-Content-Type-Options", b"Cross-Origin-Resource-Policy: same-origin", b"Referrer-Policy"):
            self.assertIn(h, out)
        out = self.talk(port, b"PUT /api/copy HTTP/1.0\r\nHost: t\r\n\r\n")
        self.assertIn(b" 405 ", out.split(b"\r\n")[0])
        self.assertIn(b"application/json", out)

    def test_sse_slot_is_freed_when_the_client_hangs_up(self):
        cfg, port = self.serve({"UI_MAX_SSE": "1"})

        def connect():
            c = socket.create_connection(("127.0.0.1", port), timeout=5)
            self.addCleanup(c.close)
            c.sendall(b"GET /api/events HTTP/1.0\r\nHost: t\r\n\r\n")
            return c, c.recv(200).split(b"\r\n")[0]
        first, status = connect()
        self.assertIn(b" 200 ", status)
        self.assertIn(b" 503 ", connect()[1])  # the only slot is taken
        first.close()
        time.sleep(1.5)  # not the 15 s heartbeat
        self.assertIn(b" 200 ", connect()[1])

    def test_a_slow_operation_keeps_its_connection(self):
        old, S.BODY_SECS = S.BODY_SECS, 1
        self.addCleanup(setattr, S, "BODY_SECS", old)
        orig = R.copy
        R.copy = lambda *a: (time.sleep(3), D("a"))[1]
        self.addCleanup(setattr, R, "copy", orig)
        cfg, port = self.serve()
        body = json.dumps({"src": "a", "srcRef": "t", "dst": "b", "dstRef": "t"})
        out = self.post(port, cfg.csrf, str(len(body)), body.encode())
        self.assertIn(b" 200 ", out.split(b"\r\n")[0])

    def test_host_names(self):
        self.assertEqual([S.host_only(h) for h in ("ui:8080", "UI.Example", "[::1]:8080", "[::1]", "localhost:80")],
                         ["ui", "ui.example", "[::1]", "[::1]", "localhost"])

    def test_host_allowlist(self):
        srv, port = self.serve({"UI_ALLOWED_HOSTS": "ui.example, [::1]"})
        self.assertIn(b" 421 ", self.talk(port, b"GET /nope HTTP/1.0\r\nHost: evil.example\r\n\r\n").split(b"\r\n")[0])
        self.assertIn(b" 404 ", self.talk(port, b"GET /nope HTTP/1.0\r\nHost: UI.example:8080\r\n\r\n").split(b"\r\n")[0])
        self.assertIn(b" 200 ", self.talk(port, b"GET /healthz HTTP/1.0\r\nHost: 127.0.0.1:8080\r\n\r\n").split(b"\r\n")[0])

    def test_slow_header_is_cut_off(self):
        old, S.HEADER_SECS = S.HEADER_SECS, 1
        self.addCleanup(setattr, S, "HEADER_SECS", old)
        srv, port = self.serve()
        c = socket.create_connection(("127.0.0.1", port), timeout=6)
        self.addCleanup(c.close)
        start = time.monotonic()
        try:  # one byte every 0.4 s never trips the 15 s socket timeout
            for b in b"GET /healthz HTTP/1.0\r\nX-Slow: ":
                c.sendall(bytes([b]))
                time.sleep(0.4)
        except OSError:
            pass
        self.assertLess(time.monotonic() - start, 6)
        try:
            self.assertEqual(c.recv(100), b"")
        except ConnectionResetError:
            pass  # closed with unread data pending: also a close


@unittest.skipUnless(shutil.which("openssl"), "openssl not installed")
class TlsOverflow(unittest.TestCase):
    def test_overflow_does_not_block_the_listener(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        cert, key = make_cert(d, "DNS:localhost")
        srv = S.BoundedServer(("127.0.0.1", 0), S.make_handler(S.Config({})), 1)
        srv.socket = S.server_context(cert, key).wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        port = srv.server_address[1]
        holder = socket.create_connection(("127.0.0.1", port))  # takes the only slot, never handshakes
        time.sleep(0.3)
        extra = socket.create_connection(("127.0.0.1", port))  # overflow, must be dropped at once
        time.sleep(0.3)
        holder.close()
        extra.close()
        time.sleep(0.5)
        c = R.Client(f"https://localhost:{port}", cafile=cert)
        self.assertEqual(c.call("GET", "/v2/x", ok=(404,))[0], 404)



class Routes(unittest.TestCase):
    """The JSON API handlers, called directly against a fake registry client."""
    def setUp(self):
        class C(FakeClient):
            tags = lambda self, repo: ["latest", "other"]  # noqa: E731
            delete_enabled = lambda self: True  # noqa: E731
            catalog = lambda self: ["b/app", "a/app"]  # noqa: E731

            def call(self, method, path, headers=None, body=None, ok=(200,)):
                super().call(method, path)
                if method != "GET":
                    return 201, {}, b""
                return 200, {}, b'{"os":"linux","architecture":"arm64","extra":1}'
        self.cfg = S.Config({})
        self.cfg.client = C()
        self.get, self.post = S.routes(self.cfg)

    def test_reads(self):
        self.assertEqual(self.get["/api/repos"]({}), ["a/app", "b/app"])
        tags = self.get["/api/tags"]({"repo": ["a/app"]})
        self.assertEqual([t["tag"] for t in tags], ["latest", "other"])
        self.assertEqual([(t["index"], t["kind"]) for t in tags], [(True, None), (True, None)])  # FakeClient answers every ref with the index
        self.cfg.state.learn(D("a"), True, "image")
        self.assertEqual(self.get["/api/tags"]({"repo": ["a/app"]})[0]["kind"], "image")
        with self.assertRaises(R.RegistryError):
            self.get["/api/tags"]({})
        with self.assertRaises(ValueError):
            S.Config({"UI_POLL_BURST": "-1"})
        def pushing(repo):
            raise R.RegistryError(404, "registry said 404 NAME_UNKNOWN: repository name not known to registry")
        self.cfg.client.tags = pushing  # layers uploaded, manifest not yet
        with self.assertRaises(R.RegistryError) as e:
            self.get["/api/tags"]({"repo": ["a/app"]})
        self.assertEqual(e.exception.status, 404)
        self.assertIn("push in progress", e.exception.message)
        self.assertEqual(self.get["/api/recent"]({"limit": ["-5"]})["events"], [])
        self.assertTrue(self.get["/api/config"]({})["deleteEnabled"])
        # the pull host: the explicit setting, else the host:port of REGISTRY_URL
        def host(env):
            cfg = S.Config(env)
            cfg.client = self.cfg.client
            return S.routes(cfg)[0]["/api/config"]({})
        self.assertEqual(host({"UI_REGISTRY_HOST": "docker.example.internal:5000"})["registryHost"], "docker.example.internal:5000")
        self.assertTrue(host({"UI_REGISTRY_HOST": "docker.example.internal:5000"})["registryHostSet"])
        fallback = host({"REGISTRY_URL": "https://registry.example:5443"})
        self.assertEqual((fallback["registryHost"], fallback["registryHostSet"]), ("registry.example:5443", False))
        # the version and revision baked into the image, with dev defaults for a plain checkout
        self.assertEqual((host({})["version"], host({})["revision"]), ("dev", "unknown"))
        built = host({"APP_VERSION": "1.2.3", "APP_REVISION": "abc1234def"})
        self.assertEqual((built["version"], built["revision"]), ("1.2.3", "abc1234def"))
        for bad in ("https://x:5000", "x/y", "x y", "x:5000/"):
            with self.assertRaises(ValueError):
                S.Config({"UI_REGISTRY_HOST": bad})
        # the registry storage, shown inside a command to copy: a path or a volume name, never shell syntax
        self.assertEqual(host({})["registryStorage"], "")
        for good in ("/data/registry", "/srv/registry-data/", "registry_data", "a1.b-c"):
            self.assertEqual(host({"UI_REGISTRY_STORAGE": good})["registryStorage"], good)
        for bad in ("/", "rel/path", "/a b", "/a;rm", "$(x)", "/a/../b", "-v", "a:ro", "/a:ro", "/" + "a" * 260, "a`b`"):
            with self.assertRaises(ValueError, msg=bad):
                S.Config({"UI_REGISTRY_STORAGE": bad})
        # the promote shortcuts: a default list, or the configured one, each a folder name
        self.assertEqual(host({})["environments"], ["dev", "test", "uat", "staging", "prod"])
        self.assertEqual(host({"UI_ENVIRONMENTS": " qa , prod "})["environments"], ["qa", "prod"])
        self.assertEqual(host({"UI_ENVIRONMENTS": "team-a/dev,team-a/prod,prod,prod"})["environments"], ["team-a/dev", "team-a/prod", "prod"])  # order kept, a prefix may have segments, repeats go
        for bad in ("Dev", "a//b", "/a", "a/", "x y", "dev,Prod", ",".join(f"e{i}" for i in range(13))):
            with self.assertRaises(ValueError, msg=bad):
                S.Config({"UI_ENVIRONMENTS": bad})

    def test_tagnames_groups_the_pollers_tags_by_repository(self):
        self.cfg.state.tags = {"a/app:v2": {}, "a/app:v1": {}, "b:latest": {}}
        self.cfg.state.empty = {"gone/repo"}
        self.assertEqual(self.get["/api/tagnames"]({}), {"repos": {"a/app": ["v1", "v2"], "b": ["latest"]}, "truncated": False, "empty": ["gone/repo"]})
        S.MAX_TAGNAMES, cap = 2, S.MAX_TAGNAMES
        try:
            capped = self.get["/api/tagnames"]({})
        finally:
            S.MAX_TAGNAMES = cap
        self.assertEqual(capped, {"repos": {"a/app": ["v1", "v2"]}, "truncated": True, "empty": ["gone/repo"]})

    def test_parents_names_the_tagged_indexes_that_list_a_digest(self):
        parents = self.get["/api/parents"]
        child = parents({"repo": ["a/app"], "digest": [D("b")]})
        self.assertEqual(child, {"parents": [{"tag": "latest", "platform": ""}, {"tag": "other", "platform": ""}], "more": 0, "children": 0, "removable": 0})
        self.assertEqual(parents({"repo": ["a/app"], "digest": [D("a")]}), {"parents": [], "more": 0, "children": 2, "removable": 2})  # a tagged index has no parent, two children
        self.cfg.client.tags = lambda repo: [f"t{i}" for i in range(7)]  # at most five are named, the rest are counted
        many = parents({"repo": ["a/app"], "digest": [D("b")]})
        self.assertEqual(([p["tag"] for p in many["parents"]], many["more"]), (["t0", "t1", "t2", "t3", "t4"], 2))
        for bad in ({"repo": ["a/app"], "digest": ["latest"]}, {"repo": ["A/app"], "digest": [D("b")]}, {"repo": ["a/app"]}):
            with self.assertRaises(R.RegistryError, msg=bad):
                parents(bad)

    def test_manifest_config_type_and_created_are_validated(self):
        def view(config_type, blob):
            class C(FakeClient):
                def manifest(self, repo, ref, head=False):
                    cfg = {"digest": D("1"), **({"mediaType": config_type} if config_type else {})}
                    return (('{"config":%s,"layers":[]}' % json.dumps(cfg)).encode(), IMG, D("a"))

                def call(self, method, path, headers=None, body=None, ok=(200,)):
                    return 200, {}, json.dumps(blob).encode()
            return S.view_manifest(C(), "a/app", "1.0", with_tags=False)
        chart = view("application/vnd.cncf.helm.config.v1+json", {"name": "demo", "version": "0.2.0"})
        self.assertEqual(chart["configType"], "application/vnd.cncf.helm.config.v1+json")
        self.assertNotIn("created", chart)  # a chart config has no build time
        self.assertNotIn("platform", chart)  # nor an os or architecture
        img = view("application/vnd.oci.image.config.v1+json", {"os": "linux", "architecture": "arm64", "created": "2025-03-01T10:20:30.123456789Z"})
        self.assertEqual((img["created"], img["platform"]["os"]), ("2025-03-01T10:20:30.123456789Z", "linux"))
        self.assertEqual(view("", {"created": "2025-03-01T10:20:30+11:00"})["created"], "2025-03-01T10:20:30+11:00")
        self.assertNotIn("configType", view("", {}))
        for bad in ("text/html; x=y", "NOTVALID", "a b/c", "x/" + "y" * 200, "image/<script>"):
            self.assertNotIn("configType", view(bad, {}), bad)
        for bad in ("yesterday", "2025-03-01", "2025-03-01T10:20:30", "<b>2025-03-01T10:20:30Z</b>", 20250301):
            self.assertNotIn("created", view("", {"created": bad}), bad)

    def test_manifest_without_tags_makes_no_tag_listing(self):
        listed = []
        self.cfg.client.tags = lambda repo: listed.append(repo) or ["latest"]
        plain = self.get["/api/manifest"]({"repo": ["a/app"], "ref": ["latest"], "tags": ["0"]})
        self.assertEqual((listed, "tags" in plain), ([], False))
        full = self.get["/api/manifest"]({"repo": ["a/app"], "ref": ["latest"]})
        self.assertEqual((listed, "tags" in full), (["a/app"], True))  # the default form still lists, for delete and move

    def test_manifest_views(self):
        idx = self.get["/api/manifest"]({"repo": ["a/app"], "ref": ["latest"]})
        self.assertTrue(idx["index"])
        self.assertEqual(len(idx["platforms"]), 2)
        img = S.view_manifest(self.cfg.client, "a/app", D("b"))
        self.assertEqual((img["platform"], len(img["layers"])), ({"os": "linux", "architecture": "arm64"}, 1))

    def test_children_must_be_a_json_boolean(self):
        out = self.post["/api/delete"]({"repo": "a/app", "digest": D("a"), "children": "false"})
        self.assertEqual(out["deleted"], [D("a")])  # the string "false" is not true

    def test_writes_wake_the_poller(self):
        woken = []
        self.cfg.poller = type("Poller", (), {"wake": lambda self: woken.append(1)})()
        body = {"src": "a/app", "srcRef": "latest", "dst": "c/app", "dstRef": "v1"}
        self.assertEqual(self.post["/api/copy"](body)["digest"], D("a"))
        self.assertIn("deleted", self.post["/api/delete"]({"repo": "a/app", "digest": D("a")}))
        self.assertEqual(len(woken), 2)
        with self.assertRaises(KeyError):
            self.post["/api/copy"]({"src": "a/app"})


class Stream(unittest.TestCase):
    def test_refused_mount_streams_the_blob(self):
        calls = []

        class Body:
            status, headers = 200, {"Content-Length": "3"}
            __enter__ = lambda self: self  # noqa: E731
            __exit__ = lambda self, *a: None  # noqa: E731

        class C:
            def call(self, method, path, headers=None, body=None, ok=(200,)):
                calls.append((method, path))
                return (202, {"Location": "http://other.example/v2/d/app/blobs/uploads/u1?_state=x"}, b"") if "mount" in path else (ok[0], {"Location": "/v2/d/app/blobs/uploads/u2"}, b"")

            def open(self, method, path, headers=None, body=None, timeout=30):
                calls.append((method, path))
                return Body()
        R.copy_blob(C(), "s/app", "d/app", D("1"))
        self.assertEqual([m for m, _ in calls], ["POST", "DELETE", "POST", "GET", "PUT"])
        self.assertEqual(calls[1][1], "/v2/d/app/blobs/uploads/u1?_state=x")  # the host of Location is dropped
        self.assertTrue(calls[-1][1].endswith(f"u2?digest={D('1')}"))

    def test_move_verifies_then_deletes_the_source(self):
        class C(FakeClient):
            delete_enabled = lambda self: True  # noqa: E731
            tags = lambda self, repo: []  # noqa: E731
        c = C()
        self.assertEqual(R.move(c, "s/app", "latest", "d/app", "latest"), [D("a"), D("b"), D("c")])
        self.assertEqual([p for m, p in c.calls if m == "DELETE"][0], f"/v2/s/app/manifests/{D('a')}")


if __name__ == "__main__":
    unittest.main()
