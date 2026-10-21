# registry-lite-ui

A web UI for a plain `registry:2` that browses, copies, moves and deletes images, and optionally browses a GitLab PyPI index.

![Recent changes across containers and PyPI](docs/screenshots/overview.png)
![A repository's tags, newest first](docs/screenshots/tags.png)
![Copy to another repository](docs/screenshots/copy.png)
![A PyPI package's versions](docs/screenshots/pypi-package.png)
![A PyPI version's files](docs/screenshots/pypi-version.png)

## Requirements

- Docker Compose v2, or podman-compose 1.2+ (the auth overrides use `!reset`).
- `registry:2` (distribution 2.8) with `REGISTRY_STORAGE_DELETE_ENABLED=true` for move and delete. Browse and copy work without it. No token-auth registries.
- For PyPI: GitLab 16+ with the PyPI package registry.
- linux/amd64 or linux/arm64.

## Config

Set on the `registry-lite-ui` service. The full set is `Config` in `app/server.py` and `Source` in `app/pypi.py`.

| Req | Name | Default | Purpose |
|---|---|---|---|
| Required | `REGISTRY_URL` | `http://registry:5000` | The only registry the UI talks to. |
| Optional | `UI_REGISTRY_HOST` | host:port of `REGISTRY_URL` | The registry address clients type, used in the pull and push commands. |
| Optional | `UI_ALLOWED_HOSTS` | compose: `localhost,127.0.0.1,[::1]` | `Host` allowlist against DNS rebinding. Set it to the name users type. |
| Optional | `UI_BIND`, `UI_PORT`, `REGISTRY_PORT` | `127.0.0.1`, `8080`, `5000` | Host publish address and ports. The UI is loopback-only until `UI_BIND` is set. |
| Optional | `UI_READONLY` | `false` | Hides and refuses copy, move and delete. |
| Optional | `UI_ENVIRONMENTS` | `dev,test,uat,staging,prod` | Stage prefixes, in order, offered as promote shortcuts in Copy to and Move to. |
| Optional | `UI_REGISTRY_STORAGE` | empty | Host path or volume of the registry data, shown in the garbage collection commands in Help. |
| Optional | `UI_POLL_INTERVAL`, `UI_MAX_EVENTS`, `UI_MAX_EVENT_DAYS` | `30`, `1000`, `30` | Seconds between registry walks, and the Recent history caps. |
| When the registry has basic auth | `REGISTRY_USER`, `REGISTRY_PASSWORD_FILE` | empty | Registry credentials. See `compose.registry-auth.yml`. |
| When the registry is HTTPS | `REGISTRY_CA_FILE` | system store | CA bundle (or the self-signed certificate) for `REGISTRY_URL`. Verification never turns off. |
| When the UI serves HTTPS | `UI_TLS_CERT`, `UI_TLS_KEY` | empty | Certificate and key for the UI listener, TLS 1.2+. |
| When PyPI is on | `PYPI_INDEX_URL` | none | The index pip is given: `https://<gitlab>/api/v4/groups/<id or path>/-/packages/pypi/simple` or `.../projects/<id or path>/packages/pypi/simple`. |
| When PyPI is on | `secrets/gitlab_token` | none | A token with `read_api`, never sent to the browser. Leave the file empty for a public index. |
| Optional | `UI_PYPI_PUBLIC_URL` | base of `PYPI_INDEX_URL` | The GitLab address pip users type, when it differs. |
| Optional | `UI_PYPI_PUBLIC` | `false` | Behind `compose.oidc.yml`, PyPI needs a login unless this is `true`. |

## Minimum configuration

`.env`:

```sh
UI_IMAGE=ghcr.io/djlongy/registry-lite-ui:0.2.1
UI_REGISTRY_HOST=registry.example.internal:5000
```

## Usage

```sh
docker compose up -d   # registry on :5000 as before, UI on http://localhost:8080
```

## Image

| | |
|---|---|
| Reference | `ghcr.io/djlongy/registry-lite-ui` |
| Base | `registry.access.redhat.com/ubi9/python-312-minimal`, pinned by digest in `Containerfile`, stdlib only |
| Platforms | linux/amd64, linux/arm64 |
| User | uid and gid 65534, read-only root filesystem, no capabilities |

## Tags

A release is `X.Y.Z`, `X.Y`, `X` and `latest`; main is `edge`; every build has its commit sha. Pin `UI_IMAGE` to `X.Y.Z` or a digest, and Renovate finds new releases. A release is a pushed tag that matches `VERSION`: `git tag -a v0.2.1 -m "registry-lite-ui 0.2.1" && git push origin v0.2.1`.

## Ports and volumes

- UI on 8080, the registry on 5000. The UI is never on the push or pull path: stop it and clients carry on.
- `ui-state` at `/state` holds `state.json`, the Recent history. Without it, history resets on restart.
- `registry-data` holds the images. `registry-init` gives it to uid 65534 once, as the registry runs as 65534 too.

## Overrides

Add each with `-f`, after `compose.yml` (or after `compose.ui.yml` for a registry that already runs elsewhere).

| File | Adds | Set |
|---|---|---|
| `compose.ui.yml` | The UI alone, used in place of `compose.yml`. | `REGISTRY_URL`, and `CERTS_DIR`, `KEYS_DIR` for HTTPS. |
| `compose.pypi.yml` | The PyPI source: a second tree root and a type filter. | `PYPI_INDEX_URL`, `secrets/gitlab_token`. |
| `compose.oidc.yml` | oauth2-proxy in front. Reads stay anonymous, a login gates changes and PyPI. | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_COOKIE_SECRET`, `OIDC_REDIRECT_URL`, `OIDC_EMAIL_DOMAINS`, `UI_ALLOWED_HOSTS`, optional `OIDC_ALLOWED_GROUPS`. |
| `compose.ldap.yml` | dex with LDAP as the issuer, after `compose.oidc.yml`. | `LDAP_BIND_PW`, `DEX_HOST`, `TLS_CERT`, `DEX_TLS_KEY`; edit `auth/dex-ldap.yaml`. |
| `compose.basic.yml` | nginx basic auth in front of everything. | `auth/htpasswd` (`htpasswd -B -c auth/htpasswd admin`), `UI_ALLOWED_HOSTS`. |
| `compose.tls.yml` | HTTPS for the registry and the UI from one certificate. | `REGISTRY_HOST`, `TLS_CERT`, `TLS_KEY`, `UI_TLS_KEY`. |
| `compose.oidc-tls.yml`, `compose.basic-tls.yml` | HTTPS on the proxy instead of the UI. | `TLS_CERT`, `PROXY_TLS_KEY`. |
| `compose.registry-auth.yml` | The UI's credentials for a registry with basic auth. | `REGISTRY_USER`, `secrets/registry_password`. |

## Preconditions

- Files the containers read (keys, certificates, `secrets/*`, a host `/data/registry`) belong to uid 65534: `chown -R 65534:65534 <dirs>`, or `podman unshare chown` for rootless podman. Mount shared directories with `:z` under SELinux.
- The OIDC issuer sends `email` with `email_verified` true, and a `groups` claim when `OIDC_ALLOWED_GROUPS` is set.
- The PyPI token's user can read the group or project, or the index is public and the token file is empty.

## Behaviour

- **Recent** is when the UI saw a change: the registry API has no push times, and pushes before the UI started are not in it. PyPI upload times come from GitLab.
- **Copy** mounts blobs and writes the original manifest bytes, so the digest does not change. **Move** is copy, check, then delete.
- **Delete** is by digest, so every tag on that digest goes, and the dialog lists them. A digest that a tagged index uses as a platform is refused (409).
- **Garbage collection** is not run by the UI: it needs the registry stopped. Help shows the commands. Never add `--delete-untagged`: it breaks multi-arch images in registry 2.8.
- **Empty repositories** stay in the catalog, because the registry API cannot delete them. The UI hides them unless Settings shows them.
- **PyPI** versions sort by PEP 440. A version held by several projects lists each copy with its files, SHA-256, Requires-Python and wheel platforms. Commands come for pip or uv on Linux/macOS or Windows, and leave out the token while GitLab serves the index anonymously.
- **Auth.** CSRF token, JSON-only POST and an `Origin` check on every change. Behind `compose.oidc.yml`, the UI answers `/api/pypi/*` with 401 without a user, and the proxy strips a forged `X-Forwarded-Email`.
- **Self-healing.** Pollers back off while the registry or GitLab is down. `/healthz` turns 503 when a poller stalls, and a watchdog exits so `restart: unless-stopped` brings the UI back. Logs go to stdout, one line per request.

## Out of scope

- Uploading Python packages, and changing anything in GitLab.
- Running garbage collection, and token-auth registries.
- Per-user permissions and an audit log beyond the access log.

## Expected result

The UI on `http://localhost:8080` lists the registry's repositories:

```sh
curl -fs localhost:8080/healthz && curl -s localhost:8080/api/repos
```
