# Racing Game

## Recent gameplay/editor updates

- Editor now uses explicit tile painting (Straight/Corner/Bump/Finish) with rotation controls.
- Respawn button is wired in gameplay.
- Lap HUD tracks current/last/best lap times.
- Lap completion currently works from either finish-line direction (checkpoint system planned for future updates).
- Camera mode can be toggled during gameplay with `C`:
  - Overview camera
  - Chase camera (closer follow with smoothed yaw)
- Bump tiles include physics collision using a spherical collider.

## Quick controls

- **Drive**: `W/A/S/D` or arrow keys
- **Respawn**: on-screen button
- **Toggle camera mode**: `C`

## Minimal multiplayer (client-authoritative)

This repo now includes a very lightweight multiplayer mode:

- Local physics stays on each player's device.
- Server is just a relay (Cloudflare Worker + Durable Object).
- Each client sends car transform snapshots ~12 times/sec.

### Run multiplayer in-game

Open game clients with a shared room id:

- `http://localhost:8080/?room=test123&ws=ws://127.0.0.1:8787/ws`

Notes:

- If `room` is omitted, the game now auto-groups players by map (same `map` + `mods` params => same room).
- Use the same `room` value for players who should see each other.
- `ws` should point to your deployed Worker websocket endpoint.

### Cloudflare Worker files

- Worker script: `cloudflare/worker.js`
- Wrangler config template: `cloudflare/wrangler.toml.example`

### No-terminal setup (Cloudflare Dashboard only)

If you are on a Chromebook and only using browser tools:

1. In Cloudflare dashboard, go to **Workers & Pages** → **Create** → **Worker**.
2. Replace the Worker code with `cloudflare/worker.js` from this repo.
3. Create a Durable Object class named `Room` and bind it to variable name `ROOM`.
4. Deploy the Worker.
5. Use your Worker URL as the `ws` parameter in game URLs, for example:
   - `https://your-game-host/?room=test123&ws=wss://your-worker-subdomain.workers.dev/ws`

This gives you room-based multiplayer relay without running terminal commands.
