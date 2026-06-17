# Deploy

smart-fetch ships a generic, **infra-agnostic** container image. The hosted
flavor runs as a stateless service behind a reverse tunnel (e.g. Cloudflare
Tunnel) with a MySQL-compatible store (e.g. TiDB) for OAuth state. The actual
deployment configuration — cloud account, VPC, ECR registry, DB host, tunnel
token, hostnames, secrets — lives in the **private infrastructure repository**,
not here. This public repo intentionally contains no infra internals.

## Image

```bash
docker build -t smart-fetch .
# or, for a remote registry:
docker buildx build --platform linux/arm64 -t <your-registry>/smart-fetch:<tag> --push .
```

The image runs `node --no-warnings src/server.ts` (hosted flavor). Tier-3
(Playwright) ships module-only (no Chromium) by default; to enable render, use a
browser-capable base image and unset `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`.

## Runtime configuration

See [`.env.example`](../.env.example) for the full env shape:
`SMART_FETCH_FLAVOR=hosted`, `OAUTH_*`, `TIDB_*`, `MCP_ALLOWED_*`,
`OPENROUTER_API_KEY`. Secrets (OAuth ES256 JWK, DB password) must come from your
secret manager — never baked into the image.

## Health & MCP

- `GET /healthz` → `{ "status": "ok" }` (the only unauthenticated route).
- MCP clients call `POST /mcp` with a gateway-issued OAuth bearer token.

## Two flavors

- **Hosted**: Streamable HTTP `/mcp` + gateway OAuth; reachable from web agents.
- **Self-contained local binary**: `bun build --compile` → one executable, no
  auth, single-user. No deployment needed.
