#!/usr/bin/env bash
# Dry run of the release decision: no tag is created.
set -uo pipefail
cd "$(dirname "$0")/.."
r=.github/scripts/release.sh
fails=0
want() { local name=$1 expect=$2; shift 2; local got; got=$("$@" 2>/dev/null); [[ $got == "$expect" ]] && echo "PASS $name" || { echo "FAIL $name: got '$got'"; fails=$((fails + 1)); }; }
bad() { local name=$1; shift; if "$@" >/dev/null 2>&1; then echo "FAIL $name"; fails=$((fails + 1)); else echo "PASS $name"; fi; }
ok() { local name=$1; shift; if "$@" >/dev/null 2>&1; then echo "PASS $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi; }
ok "VERSION file is valid semver" $r check "$(cat VERSION)"
for v in 0.1.0 1.2.3 0.1.0-dev 1.0.0-rc.1 1.0.0+build.5; do ok "semver accepts $v" $r check $v; done
for v in "" 1.0 v1.0.0 01.0.0 1.0.0- dev; do bad "semver rejects '$v'" $r check "$v"; done
want "0.1.0-dev does not release" release=false $r decide 0.1.0-dev false
want "0.1.0 with no tag releases" release=true $r decide 0.1.0 false
want "0.1.0 with a tag is skipped" release=false $r decide 0.1.0 true
want "1.0.0-rc.1 does not release" release=false $r decide 1.0.0-rc.1 false
echo "failures: $fails"
exit $((fails > 0))
