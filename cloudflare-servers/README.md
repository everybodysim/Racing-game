# Public Racing Servers (Cloudflare Worker + KV)

This folder is the backend for the **public multiplayer servers** feature in the
multiplayer widget (`index.html`). It is a Cloudflare Worker that stores the
**synced 5-minute round timer, round rotation, and per-round best-lap rankings**
for each public server.

> The live worker URL is **https://racing-servers-api.ga1010.workers.dev/** and the
> KV binding is **`SERVERS_KV`**. The code to deploy is in `worker/src/index.js`.

## Why a separate worker?

The synced round timer + rankings must be the same for **every** player on a
public server, and the Firebase Realtime Database that powers PeerJS room
metadata **cannot be modified**. So the authoritative round/rotation/rankings
state lives here (Cloudflare KV), and the client polls it ~once per second.

- **PeerJS / WebRTC** (positions, best-lap signalling) is unchanged — public
  servers reuse the existing PeerJS room mechanism with a fixed 6-char room code
  per server. PeerJS uses its own default cloud signalling server; Firebase is
  only read/written through the existing `firebaseRoomsRequest` helpers (no rule
  changes needed).
- **Round state, members, host-claim, and round-scoped rankings** live in this
  worker (KV), so they are server-authoritative and sync across all players.

## Endpoints

- `GET /api/servers` → list of public server summaries (id, name, code, memberCount).
- `GET /api/servers/:id` → full server state (round, members, laps, host, timing).
- `POST /api/servers/:id/join` `{ clientId, name }` → register as a member; auto-claims host if none is live. Returns `{ server, isHost, claimedHost }`.
- `POST /api/servers/:id/claim-host` `{ clientId, name }` → claim host if the seat is free.
- `POST /api/servers/:id/heartbeat` `{ clientId, name }` → keep membership alive; refreshes host heartbeat if you are host.
- `POST /api/servers/:id/lap` `{ clientId, name, time }` → submit a best lap for the current round (keeps the minimum).
- `POST /api/servers/:id/next-round` `{ clientId, trackPlayUrl, trackMapSignature }` → host-only; advances to a new round (new track, reset laps) once the round + 5s rankings window have elapsed.
- `POST /api/servers/:id/leave` `{ clientId }` → leave; releases host if you were host.

KV keys: `servers:index` (summaries) and `server:<id>` (full state).

## Deploy (Wrangler CLI)

```bash
cd cloudflare-servers/worker
npm install
# Create the KV namespace and put its id in wrangler.toml (SERVERS_KV binding):
npx wrangler kv namespace create SERVERS_KV
#   → copy the id into wrangler.toml's [[kv_namespaces]] id field
npx wrangler deploy
```

The deployed worker name is `racing-servers-api` (matches the live URL
`racing-servers-api.ga1010.workers.dev`). No `ADMIN_TOKEN` is needed — public
servers are open by design.

## Deploy (Dashboard)

1. Create the Worker `racing-servers-api` and paste `worker/src/index.js`.
2. Create a KV namespace and bind it as `SERVERS_KV`.
3. Save + deploy.
