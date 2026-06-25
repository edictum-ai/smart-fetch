#!/usr/bin/env bash
# Captatum gated deploy. Hard-aborts on ANY failure — prevents the silent-failure
# chains that bite manual deploys (expired ECR token, apply-before-image-lands,
# commit-before-tests). Read this alongside docs/deploy.md.
#
# Usage:
#   scripts/deploy.sh                 # gateway tag = current main HEAD
#   scripts/deploy.sh <gateway-tag>   # explicit tag
#   BROWSER_TAG=<tag> scripts/deploy.sh   # override the sidecar tag (only when
#                                         # Dockerfile.browser / browser-sidecar.sh change)
#
# Gates (each must pass or the whole deploy aborts with a message):
#  0  working tree clean + on main
#  1  typecheck + 250-line + unit tests green
#  2  fresh ECR login (the token is short-lived — re-login EVERY deploy)
#  3  build + push gateway image, then VERIFY it is present in ECR before continuing
#  4  tofu apply (gateway tag + pinned browser tag + desired_count=1)
#  5  wait for the NEW task definition's task to reach RUNNING (abort + print reason on STOPPED)
#  6  live probe (POST /mcp → expect 401, i.e. alive + auth-gating)
set -euo pipefail

# Hard-coded: this script is Captatum-specific (the ECR repo, cluster, and tofu
# env below all live in the personal-arnold account). Do NOT inherit a globally
# exported AWS_PROFILE (e.g. edictum-prod) — that silently authenticated ECR
# pushes as the wrong account and aborted at the push gate.
AWS_PROFILE="personal-arnold"
REGION="eu-central-1"
ACCOUNT="291807115868"
GW_REPO="personal-memory-prod-captatum"
GW_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$GW_REPO"
CLUSTER="personal-memory-prod-captatum"
SVC="personal-memory-prod-captatum"
INFRA="$HOME/project/personal-memory/personal-memory-infra/opentofu/envs/prod"
HOSTNAME="captatum.arnoldcartagena.com"
# The browser sidecar only needs a new tag when Dockerfile.browser / scripts/browser-sidecar.sh
# change (Chromium must still match the gateway's playwright pin). Default to the last shipped tag.
BROWSER_TAG="${BROWSER_TAG:-6f3b58c}"
TAG="${1:-$(git rev-parse --short HEAD)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { echo -e "\n==> $*"; }
die() { echo "ABORT: $*" >&2; exit 1; }

step "gate 0: clean tree on main"
[ -z "$(git status --porcelain)" ] || die "uncommitted changes — commit or stash first"
[ "$(git branch --show-current)" = "main" ] || die "not on main (on $(git branch --show-current))"

step "gate 1: typecheck + line-limit + unit tests"
node_modules/.bin/tsc -p tsconfig.json --noEmit
node --no-warnings src/dev/check-line-limits.ts
node --test test/*.test.ts >/tmp/captatum-deploy-tests.log 2>&1 || { tail -30 /tmp/captatum-deploy-tests.log; die "unit tests failed"; }

step "gate 2: fresh ECR login (token is short-lived)"
aws ecr get-login-password --region "$REGION" --profile "$AWS_PROFILE" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com" \
  || die "ECR login failed (AWS SSO expired? run: aws sso login --profile $AWS_PROFILE)"

step "gate 3: build + push gateway:$TAG, then VERIFY in ECR"
docker buildx build --platform linux/arm64 -t "$GW_URI:$TAG" --push .
until aws ecr list-images --repository-name "$GW_REPO" --region "$REGION" --profile "$AWS_PROFILE" --output text 2>/dev/null | grep -q "$TAG"; do
  echo "  waiting for $TAG to appear in ECR..."; sleep 10
done
echo "verified $GW_REPO:$TAG in ECR"

step "gate 4: tofu apply (gateway=$TAG browser=$BROWSER_TAG desired_count=1)"
( cd "$INFRA" && tofu apply \
    -var captatum_desired_count=1 \
    -var captatum_image_tag="$TAG" \
    -var captatum_browser_image_tag="$BROWSER_TAG" \
    -auto-approve )

step "gate 5: wait for the NEW task def's task to reach RUNNING"
NEW_DEF=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --profile "$AWS_PROFILE" --query 'services[0].taskDefinition' --output text)
echo "expecting a task on $NEW_DEF"
for i in $(seq 1 80); do
  TASKS=$(aws ecs list-tasks --cluster "$CLUSTER" --profile "$AWS_PROFILE" --query 'taskArns' --output text 2>/dev/null)
  RES=$([ -n "$TASKS" ] && aws ecs describe-tasks --cluster "$CLUSTER" --tasks $TASKS --profile "$AWS_PROFILE" \
        --query "tasks[?taskDefinitionArn==\`$NEW_DEF\`].{s:lastStatus,r:stoppedReason}" --output json 2>/dev/null || echo "[]")
  s=$(echo "$RES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0]?.s||"none")}catch(e){console.log("none")}})')
  echo "  [$i] new-def task: $s"
  [ "$s" = "RUNNING" ] && { echo "task RUNNING ✓"; break; }
  [ "$s" = "STOPPED" ] && die "new task STOPPED: $(echo "$RES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0]?.r)}catch(e){}})')"
  sleep 15
  [ "$i" = "80" ] && die "timed out waiting for RUNNING (20 min)"
done

step "gate 6: live probe"
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 -X POST "https://$HOSTNAME/mcp" \
  -H "content-type: application/json" -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}')
[ "$code" = "401" ] || die "live probe got HTTP $code (expected 401)"
echo "live ✓ (HTTP 401 = alive + auth-gating)"

echo -e "\nDEPLOY SUCCESS: gateway $TAG, browser $BROWSER_TAG, task $(basename "$NEW_DEF"), live at https://$HOSTNAME/mcp"
echo "Reminder: Tier-3 renders go through the browser sidecar — verify one via the connector."
