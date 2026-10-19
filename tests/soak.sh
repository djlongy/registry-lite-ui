#!/usr/bin/env bash
# Accelerated long-run test: 1 s poll interval, constant tag churn, SSE connect and disconnect storms, registry outages.
# Samples memory, state file size, event count and log volume every 30 s. Usage: SOAK_MINUTES=25 tests/soak.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export REGISTRY_PORT=${REGISTRY_PORT:-5050} UI_PORT=${UI_PORT:-8088} COMPOSE_PROJECT_NAME=rlui UI_POLL_INTERVAL=1 UI_MAX_EVENTS=500
MIN=${SOAK_MINUTES:-25}
R=http://localhost:$REGISTRY_PORT UI=http://localhost:$UI_PORT
docker compose up -d --build >/dev/null 2>&1
for _ in $(seq 30); do curl -fs "$R/v2/" >/dev/null && curl -fs "$UI/healthz" >/dev/null && break; sleep 1; done
trap 'kill $(jobs -p) 2>/dev/null' EXIT

# one config blob, then each manifest differs only by an annotation, so every PUT is a new digest
CD=sha256:$(printf '{}' | shasum -a 256 | cut -d' ' -f1)
loc=$(curl -si -X POST "$R/v2/soak/a/blobs/uploads/" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r')
curl -s -o /dev/null -X PUT "${loc}&digest=$CD" -H 'Content-Type: application/octet-stream' --data-binary '{}'
MT=application/vnd.oci.image.manifest.v1+json
manifest() { printf '{"schemaVersion":2,"mediaType":"%s","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"%s","size":2},"layers":[],"annotations":{"n":"%s"}}' "$MT" "$CD" "$1"; }

churn() { local i=0 m d
  while :; do i=$((i + 1)); m=$(manifest "$i")
    curl -s -o /dev/null -X PUT "$R/v2/soak/a/manifests/t$((i % 200))" -H "Content-Type: $MT" --data-binary "$m"
    if [ $((i % 7)) -eq 0 ]; then d=$(printf '%s' "$m" | shasum -a 256 | cut -d' ' -f1); curl -s -o /dev/null -X DELETE "$R/v2/soak/a/manifests/sha256:$d"; fi
    sleep 0.3; done; }
sse() { while :; do curl -sN --max-time "$1" "$UI/api/events" >/dev/null 2>&1; done; }
outages() { while :; do sleep 240; docker compose stop registry >/dev/null 2>&1; sleep 20; docker compose start registry >/dev/null 2>&1; done; }
reads() { while :; do curl -s -o /dev/null "$UI/api/recent"; curl -s -o /dev/null "$UI/api/repos"; sleep 2; done; }
churn & sse 1 & sse 2 & sse 3 & outages & reads &

end=$(( $(date +%s) + MIN * 60 ))
echo "# soak $MIN min: poll 1 s, UI_MAX_EVENTS=500, churn ~3 events/s, SSE storms, registry outage 20 s every 4 min"
echo "# time_s rss pids state_bytes events seq tags log_bytes_last_5min restarts"
t0=$(date +%s)
while [ "$(date +%s)" -lt "$end" ]; do
  sleep 30
  st=$(docker stats --no-stream --format '{{.MemUsage}} {{.PIDs}}' rlui-ui-1 2>/dev/null)
  size=$(docker exec rlui-ui-1 stat -c %s /state/state.json 2>/dev/null || echo 0)
  rec=$(curl -s "$UI/api/recent?limit=1000" | jq -r '"\(.events | length) \(.seq) \(.tags)"' 2>/dev/null || echo "- - -")
  logb=$(docker logs --since 5m rlui-ui-1 2>&1 | wc -c)
  echo "$(( $(date +%s) - t0 )) ${st%% /*} ${st##* } $size $rec $logb $(docker inspect -f '{{.RestartCount}}' rlui-ui-1)"
done
echo "# final: health=$(docker inspect -f '{{.State.Health.Status}}' rlui-ui-1) restarts=$(docker inspect -f '{{.RestartCount}}' rlui-ui-1) oom=$(docker inspect -f '{{.State.OOMKilled}}' rlui-ui-1)"
echo "# log lines in the retained json-file: $(docker logs rlui-ui-1 2>&1 | wc -l), bytes: $(docker logs rlui-ui-1 2>&1 | wc -c)"
echo "# distinct error lines:"; docker logs rlui-ui-1 2>&1 | grep -E 'WARNING|ERROR|recovered' | sed -E 's/^[0-9-]+ [0-9:,]+ //' | sort | uniq -c | sort -rn | head -8
