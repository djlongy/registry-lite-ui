#!/usr/bin/env bash
# Logs in through oauth2-proxy and a throwaway dex. Run from the repo root with docker working.
set -uo pipefail
cd "$(dirname "$0")/.."
export UI_PORT=8088 UI_ALLOWED_HOSTS=localhost OIDC_EMAIL_DOMAINS=example.internal OIDC_ISSUER_URL=http://dex:5556/dex OIDC_CLIENT_ID=registry-ui OIDC_CLIENT_SECRET=test-client-secret \
  OIDC_COOKIE_SECRET=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_') OIDC_REDIRECT_URL=http://localhost:8088/oauth2/callback OIDC_COOKIE_SECURE=false
docker compose -f compose.yml -f compose.oidc.yml -f tests/oidc/compose.dex.yml up -d >/dev/null 2>&1
sleep 8
JAR=$(mktemp)
R=(--resolve dex:5556:127.0.0.1 -s)
echo "no session, API:      $(curl "${R[@]}" -o /dev/null -w '%{http_code}' localhost:8088/api/repos)"
echo "no session, page:     $(curl "${R[@]}" -o /dev/null -w '%{http_code}' localhost:8088/)"
login=$(curl "${R[@]}" -c "$JAR" -b "$JAR" -L -o /dev/null -w '%{url_effective}' 'localhost:8088/oauth2/start?rd=/')
echo "redirected to IdP:    ${login%%\?*}"
final=$(curl "${R[@]}" -c "$JAR" -b "$JAR" -L -o /dev/null -w '%{url_effective}' --data-urlencode login=admin@example.internal --data-urlencode password=password "$login")
echo "after login:          $final"
echo "with session, API:    $(curl "${R[@]}" -b "$JAR" -o /dev/null -w '%{http_code}' localhost:8088/api/repos)"
echo "wrong password:       $(curl "${R[@]}" -c "$JAR.2" -b "$JAR.2" -L -o /dev/null -w '%{http_code}' --data-urlencode login=admin@example.internal --data-urlencode password=bad "$login")"
echo "UI published directly: $(docker compose -f compose.yml -f compose.oidc.yml port registry-lite-ui 8080 2>&1 | head -1)"
