#!/usr/bin/env bash
# End-to-end checks against a running `docker compose up`. Prints PASS or FAIL per check.
# Usage: REGISTRY_PORT=5000 UI_PORT=8080 tests/e2e.sh [phase] [label]   phases: clients ui gc (default: all)
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=${SRC_REPO:-mirror.gcr.io/library}  # source images; a mirror of Docker Hub avoids its pull rate limit
REG=localhost:${REGISTRY_PORT:-5000}
UI=${UI_SCHEME:-http}://localhost:${UI_PORT:-8080}
WORK=$(mktemp -d)
trap 'find "$WORK" -delete' EXIT
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
raw() { skopeo inspect --raw --tls-verify=false "docker://$REG/$1" | shasum -a 256 | cut -d' ' -f1; }
gone() { ! skopeo inspect --raw --tls-verify=false "docker://$REG/$1" >/dev/null 2>&1; }
csrf() { curl -fsS ${UI_CURL_ARGS:-} "$UI/api/config" | jq -r .csrf; }
post() { curl -sS ${UI_CURL_ARGS:-} -X POST "$UI$1" -H 'Content-Type: application/json' -H "X-CSRF-Token: $(csrf)" -d "$2"; }
code() { curl -s ${UI_CURL_ARGS:-} -o /dev/null -w '%{http_code}' "$@"; }
skopeo_push() { skopeo copy --quiet --dest-tls-verify=false "$@"; }
pull_dir() { skopeo copy --quiet --src-tls-verify=false "docker://$REG/$1" "dir:$WORK/$2"; }
dock() { docker pull -q "$SRC/$1" >/dev/null && docker tag "$SRC/$1" "$REG/$2" && docker push -q "$REG/$2" >/dev/null && docker rmi "$REG/$2" >/dev/null && docker pull -q "$REG/$2" >/dev/null; }

clients() {
  local l=$1 src
  echo "== push and pull with skopeo and docker (label $l)"
  for img in busybox alpine; do
    src=$(skopeo inspect --raw docker://$SRC/$img:latest | shasum -a 256 | cut -d' ' -f1)
    check "skopeo push multi-arch $img" skopeo_push --all docker://$SRC/$img:latest docker://$REG/lib/$img:$l-multi
    [ "$(raw lib/$img:$l-multi)" = "$src" ] && ok "multi-arch $img digest identical to source" || bad "multi-arch $img digest"
    check "skopeo push single-arch $img" skopeo_push --override-os linux --override-arch arm64 docker://$SRC/$img:latest docker://$REG/lib/$img:$l-single
    check "skopeo pull $img" pull_dir lib/$img:$l-single "pull-$img-$l"
    check "docker push then pull $img" dock $img lib/$img:$l-docker
  done
}

ui() {
  echo "== UI operations"
  curl -fsS ${UI_CURL_ARGS:-} "$UI/api/repos" | jq -e 'index("lib/busybox")' >/dev/null && ok "catalog lists lib/busybox" || bad "catalog"
  curl -fsS ${UI_CURL_ARGS:-} "$UI/api/tags?repo=lib/busybox" | jq -e 'length > 0' >/dev/null && ok "tag list" || bad "tag list"
  curl -fsS ${UI_CURL_ARGS:-} "$UI/api/manifest?repo=lib/busybox&ref=up-multi" | jq -e '.index and (.platforms | length > 1)' >/dev/null && ok "manifest detail shows platforms of an index" || bad "manifest detail index"
  curl -fsS ${UI_CURL_ARGS:-} "$UI/api/manifest?repo=lib/alpine&ref=up-single" | jq -e '(.layers | length > 0) and .platform.architecture == "arm64"' >/dev/null && ok "manifest detail shows layers and platform of an image" || bad "manifest detail image"

  echo "-- copy keeps the digest"
  post /api/copy '{"src":"lib/busybox","srcRef":"up-multi","dst":"mirror/busybox","dstRef":"copy"}' | jq -e .digest >/dev/null
  [ "$(raw lib/busybox:up-multi)" = "$(raw mirror/busybox:copy)" ] && ok "index copy: digest identical" || bad "index copy digest"
  check "index copy: child platform inspectable" skopeo inspect --tls-verify=false --override-arch amd64 --override-os linux docker://$REG/mirror/busybox:copy
  post /api/copy '{"src":"lib/alpine","srcRef":"up-single","dst":"mirror/alpine","dstRef":"copy"}' | jq -e .digest >/dev/null
  [ "$(raw lib/alpine:up-single)" = "$(raw mirror/alpine:copy)" ] && ok "image copy: digest identical" || bad "image copy digest"
  check "image copy: docker pull" docker pull -q $REG/mirror/alpine:copy
  post /api/copy '{"src":"lib/alpine","srcRef":"up-single","dst":"lib/alpine","dstRef":"alias"}' | jq -e .digest >/dev/null
  [ "$(raw lib/alpine:up-single)" = "$(raw lib/alpine:alias)" ] && ok "same-repo retag: digest identical" || bad "same-repo retag"

  echo "-- move"
  local d
  d=$(raw mirror/alpine:copy)
  post /api/move '{"src":"mirror/alpine","srcRef":"copy","dst":"moved/alpine","dstRef":"v1"}' | jq -e '.deleted | length > 0' >/dev/null
  [ -n "$d" ] && [ "$(raw moved/alpine:v1)" = "$d" ] && gone mirror/alpine:copy && ok "move: destination has the digest, source gone" || bad "move"
  check "move: moved image pullable" pull_dir moved/alpine:v1 moved

  echo "-- delete"
  local kids idx left=0
  kids=$(skopeo inspect --raw --tls-verify=false docker://$REG/mirror/busybox:copy | jq -r '.manifests[].digest')
  idx="sha256:$(raw mirror/busybox:copy)"
  post /api/delete "{\"repo\":\"mirror/busybox\",\"digest\":\"$idx\",\"children\":true}" | jq -e '.deleted | length > 1' >/dev/null
  gone mirror/busybox:copy && ok "delete: index gone" || bad "delete index"
  for k in $kids; do skopeo inspect --raw --tls-verify=false docker://$REG/mirror/busybox@"$k" >/dev/null 2>&1 && left=$((left + 1)); done
  [ $left -eq 0 ] && ok "delete with children: no child manifest left" || bad "children left: $left"
  check "delete: source repo copy untouched" skopeo inspect --raw --tls-verify=false docker://$REG/lib/busybox:up-multi

  echo "-- guards"
  [ "$(code -X POST "$UI/api/delete" -H 'Content-Type: application/json' -d '{}')" = 403 ] && ok "POST without CSRF token: 403" || bad "csrf missing"
  [ "$(code -X POST "$UI/api/delete" -H 'Content-Type: application/json' -H "X-CSRF-Token: $(csrf)" -H 'Origin: http://evil.example' -d '{}')" = 403 ] && ok "POST from foreign Origin: 403" || bad "csrf origin"
  [ "$(code -X POST "$UI/api/delete" -H 'Content-Type: text/plain' -H "X-CSRF-Token: $(csrf)" -d '{}')" = 403 ] && ok "POST as text/plain: 403" || bad "csrf content type"
  post /api/copy '{"src":"../etc","srcRef":"x","dst":"a","dstRef":"b"}' | jq -e '.error == "invalid repository name"' >/dev/null && ok "invalid source name rejected" || bad "name validation"
  post /api/copy '{"src":"lib/alpine","srcRef":"up-single","dst":"A/B","dstRef":"b"}' | jq -e '.error == "invalid repository name"' >/dev/null && ok "uppercase destination rejected" || bad "dst validation"
  curl -s ${UI_CURL_ARGS:-} -D - -o /dev/null "$UI/" | grep -qi "content-security-policy: default-src 'none'" && ok "CSP header set" || bad "CSP"
}

recent() {
  echo "== Recent view and live stream (poll interval ${UI_POLL_INTERVAL:-30} s)"
  local wait=$(( ${UI_POLL_INTERVAL:-30} * 3 + 5 )) i ev
  for i in $(seq "$wait"); do curl -fsS ${UI_CURL_ARGS:-} "$UI/api/recent?limit=1" | jq -e .baselined >/dev/null && break; sleep 1; done
  curl -sN --max-time "$wait" ${UI_CURL_ARGS:-} "$UI/api/events" > "$WORK/sse.txt" 2>/dev/null &
  local sse=$!
  sleep 1
  seen() { curl -fsS ${UI_CURL_ARGS:-} "$UI/api/recent" | jq -e --arg t "$1" --arg r "$2" '.events | any(.type == $t and .ref == $r)' >/dev/null; }
  waitfor() { for i in $(seq "$wait"); do seen "$1" "$2" && return 0; sleep 1; done; return 1; }
  skopeo_push --override-os linux --override-arch arm64 docker://$SRC/alpine:latest docker://$REG/lib/alpine:rec-1
  waitfor new lib/alpine:rec-1 && ok "pushed tag appears in Recent as new, within the poll window" || bad "new tag not in Recent"
  skopeo_push --override-os linux --override-arch arm64 docker://$SRC/busybox:latest docker://$REG/lib/alpine:rec-1
  waitfor retagged lib/alpine:rec-1 && ok "overwritten tag appears as retagged" || bad "retag not in Recent"
  local d
  d=$(raw lib/alpine:rec-1)
  post /api/delete "{\"repo\":\"lib/alpine\",\"digest\":\"sha256:$d\"}" >/dev/null
  waitfor deleted lib/alpine:rec-1 && ok "deleted tag appears as deleted" || bad "delete not in Recent"
  wait "$sse" 2>/dev/null
  [ "$(grep -c '^data: ' "$WORK/sse.txt")" -ge 3 ] && ok "SSE stream delivered $(grep -c '^data: ' "$WORK/sse.txt") change messages" || bad "SSE messages: $(grep -c '^data: ' "$WORK/sse.txt")"
  curl -fsS ${UI_CURL_ARGS:-} "$UI/api/recent" | jq -e '.events[0].seq > .events[1].seq' >/dev/null && ok "events are newest first" || bad "event order"
  if [ -n "${RESTART_UI:-}" ]; then
    local n; n=$(curl -fsS ${UI_CURL_ARGS:-} "$UI/api/recent" | jq '.events | length')
    docker compose restart ui >/dev/null 2>&1; for i in $(seq 20); do curl -fs ${UI_CURL_ARGS:-} "$UI/healthz" >/dev/null && break; sleep 1; done
    curl -fsS ${UI_CURL_ARGS:-} "$UI/api/recent" | jq -e --argjson n "$n" '.persistent and (.events | length) == $n' >/dev/null && ok "history survives a UI restart ($n events)" || bad "history lost on restart"
  fi
}

gc() {
  echo "== garbage collection"
  local before after d
  size() { docker run --rm -v rlui_registry-data:/v "$SRC/alpine:latest" du -sk /v | cut -f1; }
  # an image with a unique 20 MB layer, so deleting it frees real space
  printf 'FROM %s/alpine:latest\nRUN head -c 20000000 /dev/urandom > /blob\n' "$SRC" | docker build -q --no-cache -t "$REG/scratch/big:gc" - >/dev/null
  check "docker push scratch image" docker push -q "$REG/scratch/big:gc"
  before=$(size)
  d="sha256:$(raw scratch/big:gc)"
  post /api/delete "{\"repo\":\"scratch/big\",\"digest\":\"$d\",\"children\":true}" | jq -e '.deleted | length > 1' >/dev/null && ok "UI delete scratch/big with its children"
  docker compose stop registry >/dev/null 2>&1
  docker compose --profile gc run --rm gc-dry 2>&1 | tail -n 3
  docker compose --profile gc run --rm gc 2>&1 | tail -n 2
  docker compose start registry >/dev/null 2>&1
  for _ in $(seq 20); do curl -fs "http://$REG/v2/" >/dev/null && break; sleep 1; done
  after=$(size)
  echo "volume KiB before=$before after=$after"
  [ "$after" -lt "$before" ] && ok "GC shrank the volume" || bad "GC did not shrink the volume"
  for t in lib/busybox:up-multi lib/busybox:down-multi lib/alpine:up-single lib/alpine:down-multi moved/alpine:v1; do
    skopeo copy --quiet --all --src-tls-verify=false "docker://$REG/$t" "dir:$WORK/gc-$(echo "$t" | tr '/:' '__')" >/dev/null 2>&1 && ok "full pull after GC: $t" || bad "full pull after GC: $t"
  done
}
case "${1:-all}" in
  clients) clients "${2:-ui}" ;;
  ui) ui ;;
  gc) gc ;;
  recent) recent ;;
  all) clients up; clients down; ui; recent; gc ;;
esac
echo "failures: $fails"
exit $((fails > 0))
