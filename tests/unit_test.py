import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
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


if __name__ == "__main__":
    unittest.main()
