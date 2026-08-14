# Community Custom Mods Board (Cloudflare Worker + KV)

This folder lets players **publish their custom mods** to a shared community board
and **install mods other people made** — directly from the Mod Manager page
(`mods.html`), just like the Track Share Board works for tracks.

It is a **Cloudflare Worker** (a tiny free backend) that stores published mods in
**Cloudflare KV** (a small free storage bucket).

> ⚠️ Security note: the worker code in this folder is **untrusted repository
> content**. It only runs on *your own* Cloudflare account, and only stores the mod
> payloads players choose to publish. Review `worker/src/index.js` before deploying.

---

## What this Worker does (plain language)

Players build custom mods in the Custom Mods Lab (`custommods.html`). Each mod can
be "published" to the community board. The Worker:

- `GET /api/mods` → lists every published mod (name, author, description, install count, votes).
- `POST /api/mods` → publishes a new mod (stores the full mod + its summary).
- `GET /api/mods/:id` → fetches one full mod so it can be installed or remixed in the Lab.
- `POST /api/mods/:id/install` → bumps the install counter (for popularity).
- `POST /api/mods/:id/vote` → thumbs up (1) or thumbs down (-1).
- `DELETE /api/mods/:id` → removes a mod (only with your admin token).

Storage uses Cloudflare KV via the `MODS_KV` binding in `wrangler.toml`.

---

## You have two ways to set this up

- **Way 1 (no terminal):** all clicks in the Cloudflare Dashboard website. Pick this if you are not comfortable with commands.
- **Way 2 (with terminal):** use the Wrangler command line. Faster if you already use a terminal.

Both ways end with the same result. Follow only the one you like.

---

## Prerequisites

- A Cloudflare account (free). Sign up at https://dash.cloudflare.com/
- Access to edit your game files (GitHub web editor, hosting file manager, or a code app).
- The files in this folder (already in your repo).

You do **not** need a paid Cloudflare plan. The free tier is plenty for a community mod board.

---

# Way 1 — Dashboard only (no terminal, no commands)

### Step 1) Log in to Cloudflare

1. Open your browser.
2. Go to `https://dash.cloudflare.com`
3. Sign in (or sign up first if you don't have an account).

### Step 2) Create the KV storage bucket

1. In the left menu, tap **Workers & Pages**.
2. Open **KV** (it may be under **Storage & Databases** → **KV** depending on the dashboard version).
3. Tap **Create namespace**.
4. Name it exactly:

```
MODS_KV
```

5. Tap **Create**.

You now have the storage bucket ready.

### Step 3) Create the Worker

1. Go back to **Workers & Pages**.
2. Tap **Create application** (or **Create**).
3. Tap **Create Worker**.
4. Name it, for example:

```
racing-mods-board-api
```

5. Tap **Deploy** (quick deploy is fine).
6. Tap **Edit code**.

### Step 4) Paste the Worker code

1. Open this file from your repo:

```
cloudflare-mods/worker/src/index.js
```

2. Copy its **full contents**.
3. In the Cloudflare code editor, select all the existing starter code and delete it.
4. Paste the copied code.
5. Tap **Save** (or **Deploy**).

### Step 5) Bind the KV bucket to the Worker

The Worker code reads/writes `env.MODS_KV`. You must tell Cloudflare which KV bucket that name points to.

1. Go to your Worker's **Settings**.
2. Open **Bindings**.
3. Tap **Add binding**.
4. Choose binding type: **KV Namespace**.
5. Variable name (must be EXACT):

```
MODS_KV
```

6. Namespace: select the `MODS_KV` namespace you created in Step 2.
7. Save the binding.

> If the variable name is not exactly `MODS_KV`, reads/writes will fail.

### Step 6) (Optional) Set an admin delete token

Deleting a published mod needs a secret token so random people can't delete each other's mods.

1. Go to your Worker's **Settings** → **Variables and Secrets** (or **Variables**).
2. Tap **Add** (or **Add variable**), choose **Secret** (or **Secret text**).
3. Name:

```
ADMIN_TOKEN
```

4. Value: type any strong password/token of your choosing (keep it private).
5. Save.

If you skip this, the delete endpoint stays unauthorized (no one can delete via the API). That's fine to start with.

### Step 7) Deploy and copy the Worker URL

1. In the Worker code editor, tap **Deploy** (or **Save and Deploy**).
2. After deploy, you'll see a URL like:

```
https://racing-mods-board-api.<your-subdomain>.workers.dev
```

3. Copy this URL. You need it for the frontend wiring in Step 8.

### Step 8) Wire your game to the Worker URL

You must put your Worker URL into the game so it knows where to send mods.

Open these files and find the placeholder:

**File 1: `js/mods-manager.js`**

Find:

```js
const MODS_API_BASE = 'https://REPLACE_WITH_YOUR_WORKER_URL/api/mods';
```

Replace with your real URL + `/api/mods`, for example:

```js
const MODS_API_BASE = 'https://racing-mods-board-api.abcd1234.workers.dev/api/mods';
```

**File 2: `custommods.html`**

Find the same placeholder:

```js
const MODS_API_BASE = 'https://REPLACE_WITH_YOUR_WORKER_URL/api/mods';
```

Replace it with the same value.

After editing, publish/redeploy your frontend as you normally do.

### Step 9) Verify it works

1. Open `https://YOUR-WORKER-URL/api/mods` directly in a browser.
2. You should see JSON like:

```json
{ "ok": true, "entries": [] }
```

(`entries: []` is correct for a brand-new empty board.)

3. Open your game's **Mod Manager** page (`mods.html`).
4. Scroll to the **Custom Mods Community Board** section.
5. It should load (empty at first, that's fine).
6. Open **Custom Mods Lab** (`custommods.html`), build a mod, click **Publish to Community Board**.
7. Go back to the Mod Manager board — your mod should appear.
8. Click **Install** on someone's mod — it installs into your game.

If something shows "Community board not connected yet", see Troubleshooting below.

---

# Way 2 — Wrangler CLI (terminal)

This way is faster if you already use a terminal.

### Step 1) Install Wrangler

You need Node.js installed (`node -v` should work). Then, from anywhere:

```bash
npm install -g wrangler
wrangler --version
```

If global install fails, use npx instead:

```bash
npx wrangler --version
```

### Step 2) Log in to Cloudflare

```bash
wrangler login
```

A browser opens → click **Allow** → the terminal confirms auth.

Check your account:

```bash
wrangler whoami
```

### Step 3) Create the KV namespace

Inside this repository:

```bash
cd cloudflare-mods/worker
wrangler kv namespace create MODS_KV
```

Copy the printed namespace ID (a long hex string).

(Optional preview namespace):

```bash
wrangler kv namespace create MODS_KV --preview
```

### Step 4) Configure `wrangler.toml`

Open `cloudflare-mods/worker/wrangler.toml` and replace:

```toml
id = "REPLACE_WITH_MODS_KV_NAMESPACE_ID"
```

with the real KV namespace ID from Step 3.

### Step 5) (Optional) Set the admin delete token

```bash
wrangler secret put ADMIN_TOKEN
```

Enter a strong token value when prompted.

If you skip this, the delete endpoint stays unauthorized.

### Step 6) Install deps and deploy

From `cloudflare-mods/worker`:

```bash
npm install
npm run deploy
```

You'll get a URL like:

```
https://racing-mods-board-api.<subdomain>.workers.dev
```

Test it:

```bash
curl https://racing-mods-board-api.<subdomain>.workers.dev/api/mods
```

Should return JSON with `ok: true`.

### Step 7) Wire the frontend to this Worker URL

Edit `js/mods-manager.js` and `custommods.html`, replacing the placeholder:

```js
const MODS_API_BASE = 'https://REPLACE_WITH_YOUR_WORKER_URL/api/mods';
```

with your real Worker URL + `/api/mods`, e.g.:

```js
const MODS_API_BASE = 'https://racing-mods-board-api.abcd1234.workers.dev/api/mods';
```

### Step 8) Local development/testing (optional)

```bash
npm run dev
```

Wrangler prints a local URL (usually `http://127.0.0.1:8787`). Test with curl:

```bash
curl http://127.0.0.1:8787/api/mods
```

### Step 9) Logs and debugging

Live logs from the deployed Worker:

```bash
npm run tail
```

Also: Dashboard → Workers & Pages → your worker → **Logs**.

Useful KV debug commands:

```bash
wrangler kv key list --binding MODS_KV
wrangler kv key get --binding MODS_KV "mods:index"
```

---

## How the frontend uses it

- **Mod Manager** (`mods.html` + `js/mods-manager.js`): a "Custom Mods Community Board" panel lists every published mod with Install, thumbs up/down, and install count. A "Publish" form lets you pick one of your own saved mods (or paste a share URL/JSON), add an author + description, and publish it.
- **Custom Mods Lab** (`custommods.html`): a **Publish to Community Board** button publishes the mod you're currently editing, after asking for author + description.
- If the Worker URL is not configured or the fetch fails, the board panel shows a friendly "Community board not connected yet" message and the rest of the Mod Manager keeps working normally.

---

## Data model in KV

Keys used:

- `mods:index` → array of summary entries (capped at `MAX_ENTRIES = 300`):
  ```json
  {
    "id": "uuid",
    "modId": "custom-my-mod",
    "modName": "My Cool Mod",
    "author": "PlayerA",
    "description": "Adds nitro",
    "installCount": 0,
    "viewCount": 0,
    "thumbsUp": 0,
    "thumbsDown": 0,
    "lastLikedAt": 0,
    "createdAt": 1700000000000
  }
  ```
- `mod:<id>` → full published payload (the full `racing-custom-mod-share-v1` share, including `xml` and `template`), capped at `MAX_FULL_BYTES = 1,500,000`.

---

## API request/response examples

### List mods

```http
GET /api/mods
```

Response:

```json
{ "ok": true, "entries": [ { "id": "...", "modName": "Nitro Mod", "installCount": 3, "thumbsUp": 5, "thumbsDown": 0 } ] }
```

### Publish a mod

```http
POST /api/mods
Content-Type: application/json

{
  "type": "racing-custom-mod-share-v1",
  "modId": "custom-nitro",
  "modName": "Nitro Mod",
  "author": "PlayerA",
  "description": "Hold space for boost",
  "xml": "<xml ... Blockly blocks ...>",
  "template": "// Nitro Mod\nconst SPEC = {...};\nexport default ..."
}
```

Response:

```json
{ "ok": true, "entry": { "id": "uuid", "modName": "Nitro Mod", ... } }
```

### Fetch one mod (to install / remix)

```http
GET /api/mods/<id>
```

### Vote

```http
POST /api/mods/<id>/vote
Content-Type: application/json

{ "vote": 1 }
```

(`vote: 1` = thumbs up, `vote: -1` = thumbs down)

### Delete (admin only)

```http
DELETE /api/mods/<id>
X-Admin-Token: <your token>
```

---

## Troubleshooting

### 1) Board says "not connected yet"

Possible causes:

- `MODS_API_BASE` in `js/mods-manager.js` and/or `custommods.html` is still the placeholder.
- Worker not deployed.
- KV binding missing or misspelled (must be exactly `MODS_KV`).

Fix:

1. Visit `https://YOUR-WORKER-URL/api/mods` in a browser — it must return JSON with `ok: true`.
2. Confirm `MODS_API_BASE` ends with `/api/mods`.
3. Confirm the KV binding variable name is exactly `MODS_KV`.
4. Redeploy the Worker, hard-refresh the game page.

### 2) Publish fails / "could not publish"

- The mod's `type` must be `racing-custom-mod-share-v1` (the Lab builds this for you).
- The mod is too large (over the 1.5 MB cap). Trim complex mods.
- Worker not deployed or KV binding missing.

### 3) Installs don't count

- The install counter only updates after a successful install. Re-check the Worker URL.

### 4) Delete returns Unauthorized

- You didn't set the `ADMIN_TOKEN` secret, or the `X-Admin-Token` header doesn't match it.

---

## Data safety and limits

- KV is eventually consistent (very fast, but not a strict transactional database).
- The board caps at `MAX_ENTRIES = 300` summaries (oldest get dropped when full).
- Anyone with the endpoint URL can submit mods unless you add further auth/rate limiting.
- For stronger control later: add Turnstile captcha for POST, per-IP throttling, or migrate to D1 for richer moderation queries.

---

## File map

- Worker logic: `cloudflare-mods/worker/src/index.js`
- Worker config: `cloudflare-mods/worker/wrangler.toml`
- Worker npm scripts: `cloudflare-mods/worker/package.json`
- Frontend board UI: `mods.html` + `js/mods-manager.js`
- Frontend publish button: `custommods.html`

---

## Quick checklist (copy this)

- [ ] Created KV namespace `MODS_KV`.
- [ ] Created Worker and pasted `cloudflare-mods/worker/src/index.js` code.
- [ ] Added KV binding variable name exactly `MODS_KV`.
- [ ] (Optional) Set `ADMIN_TOKEN` secret.
- [ ] Deployed Worker and copied Worker URL.
- [ ] Replaced `MODS_API_BASE` in `js/mods-manager.js` with real URL + `/api/mods`.
- [ ] Replaced `MODS_API_BASE` in `custommods.html` with the same URL.
- [ ] Published frontend changes.
- [ ] Verified list, publish, install, and vote in the Mod Manager.
