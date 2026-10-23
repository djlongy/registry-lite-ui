registry-lite-ui is a web UI for a plain `registry:2` that browses, copies, moves, promotes and deletes images through the registry's own HTTP API, and optionally browses one GitLab group's PyPI packages.

## Run it

`podman-compose up -d` with `compose.yml` (registry and UI), or `podman-compose -f compose.ui.yml up -d` with `REGISTRY_URL` set for a registry that already runs. `docker compose` works the same way. Pin `UI_IMAGE` to a version or a digest in your `.env`.

## Changes in 0.2.3

- Fixed: changing the default sort in Settings did not reorder the PyPI packages in the tree until something was clicked. It now applies at once.
- A push in progress no longer shows as a 404. The registry lists a new repository once its first layer is uploaded, and its tags answer 404 until the manifest comes. The UI now says no tags yet, walks the registry every `UI_POLL_BURST` seconds (5) while such a repository waits, for at most `UI_POLL_BURST_MAX` seconds (600), and loads its tags as soon as they exist. `UI_POLL_BURST=0` turns this off.
- A failing registry backs off as before, also during a burst.
- Opening a repository whose push is still in progress starts the burst at once, instead of at the next walk. It shows the no-tags-yet message only, without the advice to delete an empty repository.
- Fixed: one repository the registry lists but cannot read (a push that never finished) stopped the first full walk from completing on a fresh state, so Recent and live updates never started.
- Fixed: a forced tag reload while an earlier read was still in flight returned that earlier answer.
- The release workflow publishes one run at a time per commit, so a tag pushed on the head of main no longer races the main run.

## Changes in 0.2.2

- Fixed: on an SELinux host, podman-compose mounted `secrets/gitlab_token` and `secrets/registry_password` without a label, so a token file under a home directory stopped the UI at start (`Permission denied: '/run/secrets/gitlab_token'`). `compose.pypi.yml` and `compose.registry-auth.yml` now bind-mount the file with `:ro,z`.
- A 401 from GitLab now says that a deploy token is refused by the packages API, and names the token types that work: a personal, group or project access token with `read_api`.
- A group that GitLab cannot find now points to the project form of `PYPI_INDEX_URL`, for a project path given as `GITLAB_GROUP`.
- The README says that the overrides add to the service `registry-lite-ui`: rename the container with `container_name`, not the service.

## Changes in 0.2.1

- The image is `ghcr.io/newen-systems/registry-lite-ui`. Images up to 0.2.0 stay at `ghcr.io/djlongy/registry-lite-ui`.
- `PYPI_INDEX_URL` names the PyPI source with the index URL pip is given, and it can be a project's index as well as a group's. `GITLAB_URL` with `GITLAB_GROUP` still works and is deprecated.
- Container tags in the tree are listed newest version first, as PyPI versions are.
- Releases come from a pushed tag `vX.Y.Z`. `latest` now means the latest release, main is `edge`, and each release also gets `X.Y` and `X`.

## Changes in 0.2.0

- An optional PyPI source (`compose.pypi.yml`): one GitLab group's PyPI packages beside the registry, with a type filter in the tree, one Recent list for both, PEP 440 version order, files with SHA-256, Requires-Python and wheel platforms, and pip or uv commands for Linux/macOS and Windows.
- Behind the OIDC override, PyPI data needs a login unless `UI_PYPI_PUBLIC=true`. Container data stays readable without one.
- Install commands leave out the token when GitLab serves the group index anonymously (`UI_PYPI_INDEX_AUTH=auto`), and a public group needs no token at all (an empty `secrets/gitlab_token`).
- Fixed: a long list could make the page itself scroll past the panel and leave an empty band below it.

## Changes in 0.1.1

- With the OIDC or LDAP override, anyone may browse without logging in. The header has a Log in button, and Copy to..., Move to... and Delete appear only after login. The UI refuses a change without a logged-in user (401), and oauth2-proxy refuses it first.
- OIDC logins use PKCE (S256).

## Features

- Tree browser of repositories and tags, with manifest detail (digest, size, layers, platforms of an index), Helm charts and a Created column.
- Pull, push and delete-from-a-script commands for podman or docker.
- Copy between repositories by blob mount and original manifest bytes, so digests do not change. Multi-arch indexes copy child by child.
- Move, which is a checked copy followed by a delete of the source.
- Promote between environments, configured with `UI_ENVIRONMENTS`.
- Delete with guards: every tag on the digest is listed first, and a digest that a tagged index lists as a child is refused.
- Live updates over Server-Sent Events, with a polling fallback, and a Recent changes view.
- A settings panel and a Help panel with the garbage collection commands.
- TLS for the UI and for the registry connection from an existing certificate.
- Optional auth overrides in front of the UI: basic auth, OIDC (oauth2-proxy) and LDAP (dex).
- A standalone `compose.ui.yml` for a registry that already runs as its own service.

## Security

The README "Security review" section lists the reviewers, the totals and what is open.

## Known limits

- The image is not signed, and a version tag can be re-pushed. Pin by digest.
- The OIDC and LDAP paths have no rate limit. Only the basic-auth override limits requests.
- There is no per-user authorisation and no audit log beyond the access line per request.
