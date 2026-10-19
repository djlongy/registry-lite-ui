registry-lite-ui is a web UI for a plain `registry:2` that browses, copies, moves, promotes and deletes images through the registry's own HTTP API.

## Run it

`podman-compose up -d` with `compose.yml` (registry and UI), or `podman-compose -f compose.ui.yml up -d` with `REGISTRY_URL` set for a registry that already runs. `docker compose` works the same way. Pin `UI_IMAGE` to a version or a digest in your `.env`.

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
