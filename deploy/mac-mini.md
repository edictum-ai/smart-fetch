# Mac Mini deploy (cloudflared + Docker)

Run the gateway + browser sidecar in Docker on a Mac Mini, with a Cloudflare Tunnel
exposing it. Good for an always-on self-host on hardware you already own.

## 1) Docker + repo

```sh
brew install --cask docker          # then launch Docker.app
git clone https://github.com/edictum-ai/captatum.git ~/captatum
cd ~/captatum
node --no-warnings scripts/gen-oauth-keys.ts   # print OAuth keys
cp .env.example .env               # fill it in (keys + Cloudflare + origins)
```

## 2) cloudflared tunnel

```sh
brew install cloudflared
cloudflared tunnel login                          # pick your domain's zone
cloudflared tunnel create captatum                # -> a tunnel UUID + creds JSON
# Route your hostname to the tunnel, then map it to the local gateway:
cloudflared tunnel route dns captatum captatum.your-domain.com
```

Run the tunnel (e.g. via `launchctl` / pm2 / the Cloudflare dashboard as a remote-managed tunnel):

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml run captatum
# config.yml maps captatum.your-domain.com -> http://localhost:3000
```

Create the **Cloudflare Access** app on `captatum.your-domain.com`, scoped to a
policy that holds the consent identity on `/oauth/authorize*`, and put its
`CF_ACCESS_*` values in `.env`.

## 3) Start the stack

```sh
CAPTATUM_TAG=<release-tag> docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f gateway
```

The gateway binds `127.0.0.1:3000`; `cloudflared` reaches it locally. The SQLite
file persists in the `captatum-data` volume.

## 4) Keep it running

Use `launchd` (or Docker Desktop's "Start on login") to run both `cloudflared` and
`docker compose` on boot. Verify:

```sh
curl -sf https://captatum.your-domain.com/healthz   # -> {"status":"ok"}
```
