# Cloudflare setup guide (very detailed)

This folder gives you a **Worker API** for `tracks.html` so the base URL (`/tracks.html`) can load the same shared board on all devices.

---

## What this Worker does

- `GET /api/tracks` → returns current shared board entries.
- `POST /api/tracks` → accepts `{ name, ghostCode }`, validates it, and stores a new board item.
- `DELETE /api/tracks/:id` → removes an entry (admin token required).

Storage uses **Cloudflare KV** via the `TRACKS_KV` binding in `wrangler.toml`.

---

## Prerequisites

1. A Cloudflare account.
2. Node.js installed (`node -v` should work).
3. `npm` installed (`npm -v` should work).
4. Wrangler CLI installed (instructions below).

---

## 1) Install Wrangler

From anywhere on your machine:

```bash
npm install -g wrangler
wrangler --version
```

If global install fails, use npx:

```bash
npx wrangler --version
```

---

## 2) Login to Cloudflare

```bash
wrangler login
```

This opens a browser authorization flow. After success, terminal returns to prompt.

---

## 3) Create KV namespace

Inside this repository:

```bash
cd cloudflare/worker
wrangler kv namespace create TRACKS_KV
```

Copy the printed namespace ID (looks like a long hex string).

---

## 4) Configure `wrangler.toml`

Open `cloudflare/worker/wrangler.toml` and replace:

```toml
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

with the real KV namespace ID from step 3.

---

## 5) Optional: set admin delete token

If you want delete moderation (`DELETE /api/tracks/:id`):

```bash
wrangler secret put ADMIN_TOKEN
```

Enter a strong token value when prompted.

If you skip this, delete endpoint will remain unauthorized.

---

## 6) Deploy the Worker

From `cloudflare/worker`:

```bash
wrangler deploy
```

You’ll get a URL like:

`https://racing-track-board-api.<subdomain>.workers.dev`

Test it:

```bash
curl https://racing-track-board-api.<subdomain>.workers.dev/api/tracks
```

Should return JSON with `ok: true`.

---

## 7) Connect your game frontend to this Worker

You have two deployment patterns:

### Pattern A (recommended): same domain via Cloudflare Pages + route

If your static site is on Cloudflare Pages, route `/api/*` to the Worker.
Then `tracks.html` works with default `API_BASE = '/api/tracks'`.

### Pattern B: separate domains

If frontend is elsewhere, edit in `tracks.html`:

```js
const API_BASE = '/api/tracks';
```

to:

```js
const API_BASE = 'https://racing-track-board-api.<subdomain>.workers.dev/api/tracks';
```

In this case, CORS is already enabled in Worker responses.

---

## 8) Verify end-to-end

1. Open `/tracks.html` on device A.
2. Add a ghost entry.
3. Open `/tracks.html` on device B.
4. Confirm same entry appears (shared board).

If it does not:
- open browser devtools Network tab
- check `/api/tracks` response codes
- confirm Worker URL and API_BASE
- confirm KV namespace ID is correctly configured in `wrangler.toml`

---

## 9) Useful debug commands

From `cloudflare/worker`:

```bash
wrangler deploy
wrangler tail
wrangler kv key list --binding TRACKS_KV
wrangler kv key get --binding TRACKS_KV "tracks:all"
```

---

## 10) Data safety and limits (important)

- KV is eventually consistent (very fast, but not strict transactional DB behavior).
- Current code caps board size at `MAX_ENTRIES = 300`.
- Anyone with endpoint access can submit entries unless you add auth/rate limiting.

For stronger control later:
- add Turnstile captcha for POST,
- add per-IP throttling,
- migrate to D1 for richer moderation queries.

---

## File map

- Worker logic: `cloudflare/worker/src/index.js`
- Worker config: `cloudflare/worker/wrangler.toml`
- Frontend board page: `tracks.html`

