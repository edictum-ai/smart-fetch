# Deploy

captatum ships a generic, **infra-agnostic** container image. The hosted
flavor runs as a stateless service behind a reverse tunnel (e.g. Cloudflare
Tunnel) with a MySQL-compatible store (e.g. TiDB) for OAuth state. The actual
deployment configuration — cloud account, VPC, ECR registry, DB host, tunnel
token, hostnames, secrets — lives in the **private infrastructure repository**,
not here. This public repo intentionally contains no infra internals.

## Image

```bash
docker build -t captatum .
# or, for a remote registry:
docker buildx build --platform linux/arm64 -t <your-registry>/captatum:<tag> --push .
```

The image runs `node --no-warnings src/server.ts` (hosted flavor). Tier-3
(Playwright) ships module-only (no Chromium) by default; to enable render, use a
browser-capable base image and unset `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`.

## Runtime configuration

See [`.env.example`](../.env.example) for the full env shape:
`CAPTATUM_FLAVOR=hosted`, `OAUTH_*`, `TIDB_*`, `MCP_ALLOWED_*`,
`OPENROUTER_API_KEY`. Secrets (OAuth ES256 JWK, DB password) must come from your
secret manager — never baked into the image.

## Health & MCP

- `GET /healthz` → `{ "status": "ok" }` (the only unauthenticated route).
- MCP clients call `POST /mcp` with a gateway-issued OAuth bearer token.

## Two flavors

- **Hosted**: Streamable HTTP `/mcp` + gateway OAuth; reachable from web agents.
- **Self-contained local binary**: `bun build --compile` → one executable, no
  auth, single-user. No deployment needed.

## Hosted deploy runbook

The hosted flavor runs as an ECS/Fargate task with **three** containers: the
gateway (`captatum`), a `cloudflared` tunnel, and a **browser sidecar** (long-lived
Chromium over CDP — Tier-3 render, isolated blast radius). Infra lives in the
private `personal-memory-infra` repo (OpenTofu).

### One command (gated)

```bash
aws sso login --profile personal-arnold   # if the SSO session expired
scripts/deploy.sh                          # gateway tag = main HEAD
```

`scripts/deploy.sh` **hard-aborts on any failure**. It runs these gates in order,
each of which must pass or the whole deploy stops with a message:

0. clean working tree on `main`
1. typecheck + 250-line limit + `node --test test/*.test.ts` green
2. **fresh ECR login** (the token is short-lived — re-logged every run)
3. build + push the gateway image, then **verify it is present in ECR** before continuing
4. `tofu apply` (gateway tag + pinned `browser_image_tag` + `desired_count=1`)
5. **wait for the NEW task-definition revision's task to reach `RUNNING`** — aborts and prints the `stoppedReason` on `STOPPED` (catches CannotPullContainerError, etc.)
6. live probe `POST /mcp` → expect `401` (alive + auth-gating)

Override the tags with args/env: `scripts/deploy.sh <gateway-tag>` or
`BROWSER_TAG=<tag> scripts/deploy.sh` (only bump the sidecar tag when
`Dockerfile.browser` / `scripts/browser-sidecar.sh` change; its Chromium major
must match the gateway's `playwright` pin).

### Gotchas that bit us (and the gate that now prevents each)

- **ECR login token expired mid-deploy → push `denied`, then `tofu apply` ran against a missing image.** Gate 2 re-logs in every run; gate 3 blocks the apply until the image is confirmed in ECR.
- **Applied before the image landed.** Gate 3 verifies presence first; gate 5 confirms a task actually runs.
- **Committed before the full test run.** Gate 1 fails the deploy on any test failure.
- **Watcher caught the *old* task RUNNING.** Gate 5 filters by the *new* task-definition ARN, not "newest task."
- **Always pass `-var captatum_desired_count=1`** (default is 0 = paused) — the script does this.
- **Tier-3 needs the sidecar.** If `CAPTATUM_BROWSER_CDP_ENDPOINT` is unset or the browser container isn't running, the gateway falls back to Tier-1 (no crash). After deploy, confirm a Tier-3 render through the connector.

### Manual fallback (if you can't use the script)

```bash
export AWS_PROFILE=personal-arnold
TAG=$(git rev-parse --short HEAD)
aws ecr get-login-password --region eu-central-1 --profile personal-arnold \
  | docker login --username AWS --password-stdin 291807115868.dkr.ecr.eu-central-1.amazonaws.com
docker buildx build --platform linux/arm64 \
  -t 291807115868.dkr.ecr.eu-central-1.amazonaws.com/personal-memory-prod-captatum:$TAG --push .
# CONFIRM it landed before applying:
until aws ecr list-images --repository-name personal-memory-prod-captatum \
    --region eu-central-1 --profile personal-arnold --output text | grep -q "$TAG"; do sleep 10; done
cd "$HOME/project/personal-memory/personal-memory-infra/opentofu/envs/prod"
tofu apply -var captatum_desired_count=1 -var captatum_image_tag=$TAG \
           -var captatum_browser_image_tag=6f3b58c -auto-approve
aws ecs update-service --cluster personal-memory-prod-captatum \
  --service personal-memory-prod-captatum --force-new-deployment \
  --profile personal-arnold
# then wait for the new task def's task to be RUNNING (not STOPPED) before walking away
```

