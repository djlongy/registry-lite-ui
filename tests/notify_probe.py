"""Measures what registry:2 notifications cost when the endpoint is down.
Usage: notify_probe.py <registry host:port> <total pushes>; prints push latency for 5 batches.
PUTs one small manifest under many tags, which creates one notification event per PUT."""
import http.client
import json
import sys
import time

host, total = sys.argv[1], int(sys.argv[2])
c = http.client.HTTPConnection(host)


def req(method, path, body=None, headers=None):
    c.request(method, path, body, headers or {})
    r = c.getresponse()
    r.read()
    req.location = r.getheader("Location")
    return r.status


cfg = b"{}"
import hashlib
cd = "sha256:" + hashlib.sha256(cfg).hexdigest()
assert req("POST", "/v2/p/blobs/uploads/") == 202
assert req("PUT", req.location + ("&" if "?" in req.location else "?") + f"digest={cd}", cfg, {"Content-Type": "application/octet-stream"}) == 201
mt = "application/vnd.oci.image.manifest.v1+json"
m = json.dumps({"schemaVersion": 2, "mediaType": mt, "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": cd, "size": 2}, "layers": []}).encode()
batch = total // 5
for b in range(5):
    t = time.time()
    for i in range(batch):
        assert req("PUT", f"/v2/p/manifests/t{b}-{i}", m, {"Content-Type": mt}) == 201
    print(f"batch {b + 1}: {batch} pushes in {time.time() - t:.2f}s ({(time.time() - t) / batch * 1000:.2f} ms each)")
