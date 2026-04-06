# Cloudflare Worker Backend Setup (Track-Specific Leaderboard)

This folder contains a **new backend** for the racing game's per-track leaderboard.

It is designed so each track has its own leaderboard entries, and the frontend submits:

- `trackId` (unique ID for the current track)
- `trackName`
- `name` (player username from the in-game E menu, stored in local storage)
- `timeSeconds` (lap time)

---

## Folder layout

- `cloudflare-leaderboard/worker/src/index.js` → Worker API source.
- `cloudflare-leaderboard/worker/wrangler.toml` → Worker deployment config + KV binding.

---

## API overview

The Worker exposes:

- `GET /api/leaderboard?trackId=<id>`
  - Returns leaderboard for one track only.
- `POST /api/leaderboard`
  - Stores a new record for a track.
  - Accepts JSON:

```json
{
  "trackId": "abc123",
  "trackName": "Default Track",
  "name": "playerOne",
  "timeSeconds": 43.287
}
```

### Behavior details

- Track isolation is done by KV key prefix: `leaderboard:<trackId>`.
- Results are sorted by fastest time first.
- Ties are broken by oldest submission first.
- Each track keeps only top `25` entries.

---

## Prerequisites

1. Cloudflare account.
2. Node.js 18+ and npm.
3. Wrangler CLI.

Check:

```bash
node -v
npm -v
```

Install Wrangler globally (or use `npx wrangler` in every command):

```bash
npm install -g wrangler
wrangler --version
```

---

## Step 1) Log in to Cloudflare

From any terminal:

```bash
wrangler login
```

A browser tab opens. Approve access for the account that owns your Worker/KV resources.

---

## Step 2) Create KV namespace for leaderboard data

From this repository root:

```bash
cd cloudflare-leaderboard/worker
wrangler kv namespace create LEADERBOARD_KV
```

You will get output including a namespace ID, similar to:

```text
[[kv_namespaces]]
binding = "LEADERBOARD_KV"
id = "1234567890abcdef1234567890abcdef"
```

Copy that `id` value.

---

## Step 3) Configure `wrangler.toml`

Open:

- `cloudflare-leaderboard/worker/wrangler.toml`

Replace:

```toml
id = "REPLACE_WITH_LEADERBOARD_KV_NAMESPACE_ID"
```

with your real namespace ID.

---

## Step 4) Deploy the Worker

Still inside `cloudflare-leaderboard/worker`:

```bash
wrangler deploy
```

Wrangler will print your deployed URL, for example:

```text
https://racing-leaderboard-api.your-subdomain.workers.dev
```

---

## Step 5) Connect frontend to Worker URL

The game code uses this constant in `js/main.js`:

```js
const LEADERBOARD_API_BASE = 'https://REPLACE_WITH_YOUR_WORKER_URL/api/leaderboard';
```

Replace it with your real URL:

```js
const LEADERBOARD_API_BASE = 'https://racing-leaderboard-api.your-subdomain.workers.dev/api/leaderboard';
```

If your site and Worker are on the same domain and routed under `/api`, you can also use:

```js
const LEADERBOARD_API_BASE = '/api/leaderboard';
```

---

## Step 6) Test endpoints manually

Use real values for `WORKER_URL` and `trackId`.

### Read leaderboard for one track

```bash
curl "https://WORKER_URL/api/leaderboard?trackId=default-track"
```

Expected: JSON with `ok: true` and an `entries` array.

### Submit a leaderboard time

```bash
curl -X POST "https://WORKER_URL/api/leaderboard" \
  -H "Content-Type: application/json" \
  -d '{
    "trackId":"default-track",
    "trackName":"Default Track",
    "name":"playerOne",
    "timeSeconds":42.913
  }'
```

Expected: JSON with `ok: true` and sorted entries.

---

## Step 7) Test in the game

1. Open the game.
2. Press **E** to open the mode menu.
3. Set your player name in the new name input.
4. Finish laps.
5. Confirm leaderboard panel updates in the top-left corner.
6. Change tracks (or map/mod parameters) and confirm leaderboard changes per track.

### Name popup behavior

- If a new personal best is set and no name is saved, the game shows a popup.
- Entering a name saves it to local storage and submits the record.

---

## Operations / debugging

From `cloudflare-leaderboard/worker`:

```bash
wrangler tail
wrangler kv key list --binding LEADERBOARD_KV
```

To inspect one track key (replace with actual key):

```bash
wrangler kv key get --binding LEADERBOARD_KV "leaderboard:YOUR_TRACK_ID"
```

---

## Security + production notes

Current implementation is intentionally simple. Before public launch, consider:

1. **Rate limiting**
   - Add per-IP throttling (Durable Object or Cloudflare WAF rules).
2. **Bot protection**
   - Add Turnstile on POST requests.
3. **Validation hardening**
   - Add stricter time plausibility checks (anti-cheat heuristics).
4. **Moderation**
   - Add admin endpoints for deleting invalid submissions.
5. **Analytics / observability**
   - Use `wrangler tail` and Cloudflare Logs to monitor abuse and API failures.

---

## Quick redeploy workflow

When you update Worker code:

```bash
cd cloudflare-leaderboard/worker
wrangler deploy
```

When you update frontend API URL or leaderboard UI:

- redeploy your static site (or push to your hosting provider) so `js/main.js` changes go live.

---

## Common mistakes checklist

- [ ] Forgot to replace KV namespace ID in `wrangler.toml`.
- [ ] Forgot to replace `LEADERBOARD_API_BASE` in `js/main.js`.
- [ ] CORS blocked because wrong endpoint URL was used.
- [ ] Worker deployed to a different account/subdomain than expected.
- [ ] Browser cached old frontend JS (hard refresh to verify).

