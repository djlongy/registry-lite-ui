#!/usr/bin/env bash
# TLS checks with a throwaway self-signed certificate. Run from the repo root with docker working.
# Needs openssl, skopeo, curl. COLIMA_PROFILE=<name> installs the docker CA inside that Colima VM, otherwise sudo is used.
set -uo pipefail
cd "$(dirname "$0")/.."
export REGISTRY_PORT=${REGISTRY_PORT:-5050} UI_PORT=${UI_PORT:-8088} COMPOSE_PROJECT_NAME=rlui UI_ALLOWED_HOSTS=localhost
WORK=$(mktemp -d "$PWD/.tlswork.XXXXXX")   # under the repo so a Colima VM can mount it
trap 'find "$WORK" -delete' EXIT
H=docker.example.internal
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
expect() { local name=$1 want=$2; shift 2; local out; out=$("$@" 2>&1); [[ $out == *"$want"* ]] && ok "$name" || { bad "$name"; echo "  got: $out"; }; }
refused() { local name=$1; shift; if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi; }

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$H" \
  -addext "subjectAltName=DNS:$H,DNS:localhost,IP:127.0.0.1" -keyout "$WORK/tls.key" -out "$WORK/tls.crt" 2>/dev/null
cp "$WORK/tls.key" "$WORK/ui.key"; chmod 644 "$WORK/tls.key" "$WORK/ui.key"   # both services run as 65534, which does not own these files
mkdir "$WORK/certs"; cp "$WORK/tls.crt" "$WORK/certs/ca.crt"
export TLS_CERT=$WORK/tls.crt TLS_KEY=$WORK/tls.key UI_TLS_KEY=$WORK/ui.key PROXY_TLS_KEY=$WORK/ui.key REGISTRY_HOST=$H
C=(-f compose.yml -f compose.tls.yml)
REG=localhost:$REGISTRY_PORT UIH=https://localhost:$UI_PORT
echo "== registry and UI both on HTTPS, certificate used as the CA"
docker compose "${C[@]}" up -d --build >/dev/null 2>&1; sleep 4

echo "-- registry"
expect "registry answers HTTPS with the CA" "{}" curl -sS --cacert "$WORK/tls.crt" "https://localhost:$REGISTRY_PORT/v2/"
refused "registry refuses plain HTTP" curl -fsS "http://localhost:$REGISTRY_PORT/v2/"
refused "registry HTTPS fails without the CA" curl -fsS "https://localhost:$REGISTRY_PORT/v2/"
SRC=${SRC_REPO:-mirror.gcr.io/library}
refused "skopeo push fails without the CA" skopeo copy --quiet --override-os linux --override-arch arm64 docker://$SRC/alpine:latest docker://$REG/tls/alpine:s
retry() { for _ in 1 2 3; do "$@" 2>"$WORK/err" && return 0; sleep 3; done; cat "$WORK/err"; return 1; }
retry skopeo copy --quiet --all --dest-cert-dir "$WORK/certs" docker://$SRC/busybox:latest docker://$REG/tls/busybox:m >/dev/null && ok "skopeo push multi-arch with --cert-dir" || bad "skopeo push multi-arch"
skopeo copy --quiet --override-os linux --override-arch arm64 --dest-cert-dir "$WORK/certs" docker://$SRC/alpine:latest docker://$REG/tls/alpine:s >/dev/null 2>&1 && ok "skopeo push single-arch with --cert-dir" || bad "skopeo push single-arch"
skopeo copy --quiet --all --src-cert-dir "$WORK/certs" docker://$REG/tls/busybox:m dir:"$WORK/pull" >/dev/null 2>&1 && ok "skopeo pull with --cert-dir" || bad "skopeo pull"
# docker never verifies registries that resolve to loopback, so map the certificate name to the daemon host's own address
DREG=$H:$REGISTRY_PORT
VM() { if [ -n "${COLIMA_PROFILE:-}" ]; then colima ssh -p "$COLIMA_PROFILE" -- "$@"; else "$@"; fi; }
HOSTIP=$(VM hostname -I | awk '{print $1}')
VM sudo sh -c "grep -v ' $H\$' /etc/hosts > /tmp/hosts.new; echo '$HOSTIP $H' >> /tmp/hosts.new; cat /tmp/hosts.new > /etc/hosts"
VM sudo rm -rf /etc/docker/certs.d/$DREG
docker pull -q $SRC/alpine:latest >/dev/null && docker tag $SRC/alpine:latest $DREG/tls/alpine:d
out=$(docker push $DREG/tls/alpine:d 2>&1); [[ $out == *"x509"* ]] && ok "docker push fails verification before the CA is installed" || { bad "docker negative"; echo "  got: $out"; }
VM sudo mkdir -p /etc/docker/certs.d/$DREG
VM sudo tee /etc/docker/certs.d/$DREG/ca.crt < "$WORK/tls.crt" >/dev/null
docker push -q $DREG/tls/alpine:d >/dev/null 2>&1 && ok "docker push with certs.d" || bad "docker push"
docker rmi $DREG/tls/alpine:d >/dev/null; docker pull -q $DREG/tls/alpine:d >/dev/null 2>&1 && ok "docker pull with certs.d" || bad "docker pull"
VM sudo rm -rf /etc/docker/certs.d/$DREG

echo "-- UI serves HTTPS"
expect "UI answers HTTPS with the CA" "ok" curl -sS --cacert "$WORK/tls.crt" "$UIH/healthz"
refused "UI refuses plain HTTP" curl -fsS "http://localhost:$UI_PORT/healthz"
echo "-- UI to registry over verified TLS: browse, copy, move, delete"
UI_SCHEME=https UI_CURL_ARGS="--cacert $WORK/tls.crt" tests/e2e.sh clients up | grep -c '^PASS' | sed 's/^/clients PASS count: /'
UI_SCHEME=https UI_CURL_ARGS="--cacert $WORK/tls.crt" tests/e2e.sh ui

echo "-- UI refuses an untrusted or mismatched registry certificate"
net=${COMPOSE_PROJECT_NAME}_default
run() { docker run -d --rm --name tls-probe --network "$net" -p 8089:8080 "$@" "${UI_IMAGE:-ghcr.io/djlongy/registry-lite-ui:latest}" >/dev/null; for _ in $(seq 15); do curl -fs localhost:8089/healthz >/dev/null && break; sleep 1; done; curl -s localhost:8089/api/repos; docker rm -f tls-probe >/dev/null; }
out=$(run -e REGISTRY_URL=https://$H:5000); echo "no CA: $out"; [[ $out == *"TLS verification failed"* ]] && ok "no CA: verify failure with a clear message" || bad "no CA"
cp "$WORK/tls.crt" "$WORK/ca-only.crt"
out=$(run -e REGISTRY_URL=https://registry:5000 -e REGISTRY_CA_FILE=/certs/tls.crt -v "$WORK/tls.crt:/certs/tls.crt:ro"); echo "name not in SAN: $out"
[[ $out == *"subjectAltName"* ]] && ok "name not in SAN: message names the SAN" || bad "SAN message"

echo "== basic auth proxy with TLS in front of a plain-HTTP UI"
echo "admin:$(openssl passwd -apr1 test-pass-1)" > auth/htpasswd
B=("${C[@]}" -f compose.basic.yml -f compose.basic-tls.yml)
docker compose "${B[@]}" up -d >/dev/null 2>&1; sleep 4
[ "$(curl -s --cacert "$WORK/tls.crt" -o /dev/null -w '%{http_code}' $UIH/api/repos)" = 401 ] && ok "proxy HTTPS without credentials: 401" || bad "proxy 401"
[ "$(curl -s --cacert "$WORK/tls.crt" -u admin:test-pass-1 -o /dev/null -w '%{http_code}' $UIH/api/repos)" = 200 ] && ok "proxy HTTPS with credentials: 200" || bad "proxy 200"
refused "proxy refuses plain HTTP" curl -fsS "http://localhost:$UI_PORT/api/repos"

echo "== rendered config for the OIDC TLS override (not started)"
OIDC_EMAIL_DOMAINS=x OIDC_ISSUER_URL=x OIDC_CLIENT_ID=x OIDC_CLIENT_SECRET=x OIDC_COOKIE_SECRET=x OIDC_REDIRECT_URL=x \
  docker compose "${C[@]}" -f compose.oidc.yml -f compose.oidc-tls.yml config --quiet && ok "compose.oidc-tls.yml renders" || bad "oidc-tls config"

OIDC_EMAIL_DOMAINS=x OIDC_ISSUER_URL=x OIDC_CLIENT_ID=x OIDC_CLIENT_SECRET=x OIDC_COOKIE_SECRET=x OIDC_REDIRECT_URL=x LDAP_BIND_PW=x DEX_TLS_KEY=$WORK/ui.key DEX_HOST=dex.example.internal \
  docker compose -f compose.yml -f compose.oidc.yml -f compose.ldap.yml config --quiet && ok "compose.ldap.yml renders" || bad "ldap config"

docker compose "${B[@]}" down -v >/dev/null 2>&1
echo "failures: $fails"
exit $((fails > 0))
