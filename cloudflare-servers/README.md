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
- **Round timing is PURE wall-clock math.** The round boundary is derived from
  UTC time split into fixed 5-minute (+5s rankings) chunks anchored to a fixed
  epoch (2026-01-01T00:00:00Z). It does **not** depend on a host or on when the
  first player joined — it is always running and can never freeze. Every client
  computes the same round boundaries from the worker's `now`.
- **No host privileges.** The first live player claims a "host" seat purely for
  PeerJS peer-id election (so joiners can connect), but this grants **no**
  in-game privileges and is never shown to players. Anyone can pick the next
  track (first-writer-wins) during the rankings window, so the rotation keeps
  working even if the host disappears.

## Endpoints

- `GET /api/servers` → list of public server summaries (id, name, code, memberCount, roundEndAt, inRankings).
- `GET /api/servers/:id` → full server state (round, nextRound, members, laps, timing: playEnd/cycleEnd/inRankings/roundOver, now).
- `POST /api/servers/:id/join` `{ clientId, name }` → register as a member; auto-claims the (hidden, privilege-less) host seat if none is live. Returns `{ server, isHost, claimedHost }`.
- `POST /api/servers/:id/claim-host` `{ clientId, name }` → claim the host seat if free (PeerJS election only).
- `POST /api/servers/:id/heartbeat` `{ clientId, name }` → keep membership alive; refreshes host heartbeat if you are host; re-claims host if the seat is stale.
- `POST /api/servers/:id/lap` `{ clientId, name, time }` → submit a best lap for the CURRENT cycle (keeps the minimum per client per cycle).
- `POST /api/servers/:id/set-track` `{ clientId, cycleIndex, trackPlayUrl, trackMapSignature }` → **any player** sets the track for a cycle; first-writer-wins (later attempts return `alreadySet:true` and are ignored). Replaces the old host-only `next-round`.
- `POST /api/servers/:id/leave` `{ clientId }` → leave; releases host if you were host.

KV keys: `servers:index` (summaries) and `server:<id>` (full state: members, host, laps keyed by cycleIndex, tracks keyed by cycleIndex).

## Timing constants (in the worker)

- `PLAY_DURATION_MS = 5 * 60 * 1000` (5 min of racing)
- `RANKINGS_WINDOW_MS = 5 * 1000` (5 s of rankings)
- `CYCLE_MS = PLAY_DURATION_MS + RANKINGS_WINDOW_MS` (305 s per cycle)
- `ROUND_EPOCH = Date.UTC(2026,0,1)` — the anchor; cycles are `floor((now-epoch)/CYCLE_MS)`.

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
