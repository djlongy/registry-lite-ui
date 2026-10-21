"""A fake GitLab for the PyPI smoke test: python3 tests/fake_gitlab.py <port> [bind address]. Token: unit_test.TOKEN."""
import http.server
import sys

from unit_test import FakeGitLab

http.server.ThreadingHTTPServer((sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1", int(sys.argv[1])), FakeGitLab).serve_forever()
