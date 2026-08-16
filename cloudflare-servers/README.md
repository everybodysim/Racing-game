# Multiplayer Servers System (Cloudflare Worker + KV)

This worker is the authoritative backend for the Skid Circuit **multiplayer
server browser**. It does **not** replace the existing multiplayer networking —
it is a discovery + ownership + chat-scoping layer that sits **on top of** the
existing PeerJS (WebRTC) peer connections and Firebase Realtime Database room
signaling.

## What it owns

1. **Permanent server definitions** — owner, name, settings. Stored in KV and
   survive players leaving.
2. **Active session presence** — live "room" metadata + heartbeat. Ephemeral;
   garbage-collected after the heartbeat TTL (60s) with no live players.
3. **Server chat history** — the last 50 messages per server (live delivery is
   still Ably; this is the persisted backlog + the authorization point).

It deliberately does **not** store live WebRTC connection state. The actual
peer connection is still established PeerJS↔PeerJS using a room code, and
Firebase still carries per-room player positions / lap times.

## Endpoints

### Permanent server definitions
- `GET  /api/servers/permanent` — list all permanent servers (with live session summary).
- `POST /api/servers/permanent` `{ token, name, settings }` — create a permanent server (owner = authenticated account). Returns `{ ok, server }`.
- `GET  /api/servers/<id>` — fetch one server (definition + live session summary).
- `POST /api/servers/<id>/rename` `{ token, name }` — owner-only rename.
- `DELETE /api/servers/<id>` `{ token }` — owner-only delete.

### Active sessions
- `GET  /api/servers/temporary` — list currently-active temporary sessions (stale ones are dropped).
- `GET  /api/servers/sessions` — list ALL active sessions (temporary + permanent).
- `POST /api/servers/temporary` `{ name, roomCode, mapSignature, hostUsername, hostClientId, settings }` — host creates a temporary server. Returns `{ ok, server }` with the auto-assigned `serverId`.
- `POST /api/servers/<id>/join` `{ username, clientId }` — join a server (capacity checked server-side). Returns `{ ok, server }` with `roomCode` + `mapSignature`.
- `POST /api/servers/<id>/heartbeat` `{ clientId, username }` — refresh presence; returns the fresh player list.
- `POST /api/servers/<id>/leave` `{ clientId }` — leave a server. A temporary server with no live players is deleted.

### Server chat (history + authorization)
- `GET  /api/servers/<id>/chat` — last 50 messages.
- `POST /api/servers/<id>/chat` `{ clientId, username, content }` — append a message. **Only players currently in the session may post** (verified server-side against the active session's player list).

## Server IDs

IDs are **numeric, sequential, and server-authoritative**. The first server gets
ID 1; if 1 is taken, the next free ID is used. The client never chooses an ID.

Allocation uses a KV counter (`servers:counter`) with a probe-and-claim retry
loop: read counter → verify `server:<id>` and `session:<id>` are both absent →
claim and advance the counter past the claimed id. The re-read-before-write and
counter-self-correction make double-claims self-healing. This is the strongest
atomicity available on plain KV (the same storage all other workers in this repo
use) without introducing Durable Objects, which would be an incompatible infra
change.

Counter is shared between temporary and permanent servers so IDs are globally
unique and monotonic. Temporary IDs are freed when the session is
garbage-collected, but the counter never goes backwards, so a recycled temporary
ID number will simply not be re-issued (the next server gets the next higher
number). This avoids any "stale ID" ambiguity at the cost of a few skipped
numbers — an acceptable trade-off for correctness.

## Authentication & ownership

Permanent-server ownership is verified **server-side** via the account token.
The worker calls the existing accounts worker
(`GET https://racing-account-api.ga1010.workers.dev/api/accounts/profile?token=`)
to resolve the token to a username. It does **not** duplicate password hashing.
The client-supplied token is never trusted alone — the resolved username must
match the stored `ownerUsernameKey`.

Temporary servers have no owner; the host is the player who created them.

## Host migration

The existing networking is a PeerJS **star topology** (host peer relays between
guests). True host migration would require every guest to reconnect to a new
host peer ID, which the current networking does not support. Therefore, when the
host of a temporary server stops heartbeating, the server is closed after the TTL
and remaining players are notified to return to the server browser. Permanent
servers keep their definition; a new session can be started by anyone later.
This is the safe fallback documented in `docs/multiplayer-servers.md`.

## Deploy

### Dashboard-only path
1. Create a Cloudflare account → Workers & Pages.
2. Create a Worker named `racing-servers-api` and paste `src/index.js`.
3. Create a KV namespace and bind it to `SERVERS_KV` (Settings → Variables → KV).
4. Copy the deployed URL into `SERVERS_API_BASE` in `js/MultiplayerServers.js`
   and `js/main.js`.

### Wrangler CLI path
```bash
cd cloudflare-servers/worker
npm install
# edit wrangler.toml: replace REPLACE_WITH_SERVERS_KV_NAMESPACE_ID with your KV id
npx wrangler kv:namespace create SERVERS_KV   # creates the namespace
npx wrangler deploy
```

Then set the deployed worker URL in `js/MultiplayerServers.js` (`SERVERS_API_BASE`).

> ⚠️ Until `SERVERS_API_BASE` is changed from the placeholder, the server browser
> shows a "not connected yet" message and the rest of the game keeps working
> normally (single-player + existing join-by-code multiplayer are unaffected).
