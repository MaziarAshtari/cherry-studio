# Cherry Studio Sync Server

A small, self-contained server that keeps several Cherry Studio desktop installations (Windows, macOS, Linux) in sync. Each client only needs a **Server URL** and an **Auth Token**.

- Node.js 24, zero runtime npm dependencies (TypeScript runs directly through Node's type stripping, storage uses the built-in `node:sqlite`).
- SQLite in WAL mode for sync records, a content-addressed directory for binary blobs.
- Bearer-token authentication, entity-level Last-Write-Wins with tombstones, monotonic revisions, Server-Sent Events for live updates.

Run it behind an HTTPS reverse proxy (Caddy or Nginx). Data is not end-to-end encrypted: anyone with access to the server's disk can read synced chats and API keys, so host it on a machine you control.

## Quick start on Ubuntu with Docker Compose

```bash
# 1. Install Docker Engine + Compose plugin (skip if already installed)
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2

# 2. Get the server
git clone https://github.com/CherryHQ/cherry-studio.git
cd cherry-studio/sync-server

# 3. Create the configuration with a strong token
cp .env.example .env
echo "SYNC_AUTH_TOKEN=$(openssl rand -base64 32 | tr -d '\n')" >> .env

# 4. Start it (listens on 127.0.0.1:8787)
sudo docker compose up -d --build
curl http://127.0.0.1:8787/api/v1/health
```

Data is stored in `./data` (`sync.sqlite` plus `blobs/`). Back up this directory to back up everything.

## Quick start with native Node.js and systemd

```bash
# Node.js 24 from NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo useradd --system --home /var/lib/cherry-sync --create-home cherrysync
sudo mkdir -p /opt/cherry-sync
sudo cp -r package.json src scripts /opt/cherry-sync/
echo "SYNC_AUTH_TOKEN=$(node scripts/generate-token.ts)" | sudo tee /opt/cherry-sync/.env
sudo chmod 600 /opt/cherry-sync/.env

sudo cp deploy/cherry-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cherry-sync
journalctl -u cherry-sync -f
```

The unit binds to `127.0.0.1:8787` and stores data in `/var/lib/cherry-sync`.

## HTTPS reverse proxy

**Caddy** (automatic certificates) — see [`deploy/Caddyfile`](deploy/Caddyfile):

```bash
sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # replace sync.example.com with your domain
sudo systemctl reload caddy
```

**Nginx** — see [`deploy/nginx.conf`](deploy/nginx.conf). Keep `proxy_buffering off` on `/api/v1/sync/events` so live notifications are not delayed, and raise `client_max_body_size` for large attachments.

## Connect Cherry Studio clients

On every device open **Settings → Data Settings → Self-Hosted Sync**:

1. Enter the **Server URL** (for example `https://sync.example.com`) and the **Auth Token** from `.env`.
2. Optionally change the **Device Name** (defaults to the hostname).
3. Click **Test Connection**, then enable **Self-Hosted Sync**.
4. Pick the categories to sync. The first device uploads its data; other devices download it and merge per entity.

Changes are pushed a few seconds after you make them; other devices pull immediately through the live event stream and every few minutes as a fallback. **Sync Now** runs a full pull-then-push cycle.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SYNC_AUTH_TOKEN` | — (required) | Shared bearer token, at least 24 characters. Generate with `npm run generate-token`. |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` behind a local reverse proxy. |
| `PORT` | `8787` | HTTP port. |
| `DATA_DIR` | `./data` | Directory for `sync.sqlite` and `blobs/`. |
| `MAX_BODY_BYTES` | `67108864` | Maximum JSON body for one push. |
| `MAX_BLOB_BYTES` | `1073741824` | Maximum size of one blob. |
| `CHANGES_PAGE_SIZE` | `500` | Maximum changes per pull page. |
| `SSE_HEARTBEAT_MS` | `25000` | Heartbeat interval on the event stream. |

The server refuses to start without a valid `SYNC_AUTH_TOKEN`. To rotate it, change `.env`, restart, and update the token on every client.

## API (v1)

All endpoints except `health` require `Authorization: Bearer <token>`. Sync endpoints also take `X-Device-Id` and `X-Device-Name` (URI-encoded) headers.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness probe, no auth. |
| `GET` | `/api/v1/auth/verify` | Validates the token and registers the device. Returns `latestRevision` and server time. |
| `GET` | `/api/v1/sync/changes?since=<rev>&categories=<a,b>&limit=<n>` | Records (including tombstones) with `revision > since`, in revision order, with `hasMore` for paging. |
| `POST` | `/api/v1/sync/push` | Body `{ changes: [{ entityKey, category, updatedAt, deleted, data }] }`. Returns one result per change: `accepted` (new revision), `rejected` (a newer version exists and is returned as `current`) or `merged` (identical content already stored). |
| `GET` | `/api/v1/sync/events` | Server-Sent Events stream. Emits `revision` events when another device pushes. |
| `HEAD`/`GET`/`PUT` | `/api/v1/blobs/:sha256` | Content-addressed binary storage. `PUT` verifies the SHA-256 of the body; existing blobs are never stored twice. |

### Conflict resolution

Every entity (a topic, a message, an assistant, a provider, an MCP server, a preference key, a file, a knowledge item, …) is resolved independently with Last-Write-Wins on its UTC `updatedAt` in milliseconds. Equal timestamps are broken by comparing device ids, so every replica reaches the same result. Deletions are stored as tombstones and win over older writes, so a device that was offline cannot resurrect deleted data with a stale copy.

## Development

```bash
npm install          # only needed for type checking
npm test             # node:test integration suite
npm run typecheck
SYNC_AUTH_TOKEN=$(npm run -s generate-token) npm start
```
