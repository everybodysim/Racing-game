# Cloudflare Leaderboard Setup (No Terminal / No Commands / Mobile-Friendly)

This guide is for people who:

- are **not comfortable with backend work**,
- are on **phone/tablet**,
- and do **not want to run commands**.

Everything below is written as a **click-by-click Cloudflare Dashboard workflow**.

---

## What you are setting up (plain-language)

Your game now has an in-game leaderboard UI.

- It shows in a top corner.
- It is scrollable.
- It is resizable.
- It stores player names and lap times.
- It is unique per track.

To make that work across players/devices, we need a small online backend.
That backend is a **Cloudflare Worker** + **Cloudflare KV** storage.

You will configure 3 things:

1. A KV database bucket (for leaderboard entries).
2. A Worker API script (the backend endpoint).
3. A Worker URL in your game frontend (`js/main.js`).

---

## Before you start

You need:

- A Cloudflare account you can log into in a browser.
- Access to your site files (GitHub, host file manager, or editor app).
- The updated project files in this repo.

You do **not** need:

- Node.js
- npm
- wrangler
- terminal

---

## Part A — Create KV storage in Cloudflare Dashboard

### Step A1) Open Cloudflare dashboard

1. Open your browser.
2. Go to: `https://dash.cloudflare.com`
3. Sign in.

### Step A2) Open the Workers & Pages area

1. In the left menu, tap **Workers & Pages**.
2. Wait for the page to load.

### Step A3) Open KV

Depending on Cloudflare UI version:

- You may see **Storage & Databases** → **KV**, or
- A direct **KV** section inside Workers.

Open **KV**.

### Step A4) Create namespace

1. Tap **Create namespace**.
2. Name it exactly:

`LEADERBOARD_KV`

3. Tap **Create**.

You now have storage ready.

---

## Part B — Create the Worker backend in Dashboard (no CLI)

### Step B1) Create Worker

1. Go back to **Workers & Pages**.
2. Tap **Create application**.
3. Tap **Create Worker**.
4. Choose a name, for example:

`racing-leaderboard-api`

5. Tap **Deploy** (quick deploy is fine).
6. Tap **Edit code**.

### Step B2) Replace Worker code with project backend

1. Open this file from your repo:
   - `cloudflare-leaderboard/worker/src/index.js`
2. Copy its full contents.
3. In Cloudflare code editor, select all existing code and replace it.
4. Paste the copied code.
5. Save the file in the editor.

What this code does:

- `GET /api/leaderboard?trackId=...` returns leaderboard rows for that track only.
- `POST /api/leaderboard` adds a new `{ name, timeSeconds }` entry for one track.
- Automatically sorts by fastest time.
- Keeps top entries.

---

## Part C — Bind KV to Worker in Dashboard UI

### Step C1) Open Worker settings

1. In the Worker editor screen, find **Settings**.
2. Open **Bindings**.

### Step C2) Add KV binding

1. Tap **Add binding**.
2. Choose binding type: **KV Namespace**.
3. Variable name (must be exact):

`LEADERBOARD_KV`

4. Namespace: select the one you created (`LEADERBOARD_KV`).
5. Save binding.

Why exact name matters:

- The backend code expects `env.LEADERBOARD_KV`.
- If you choose another variable name, reads/writes will fail.

---

## Part D — Deploy Worker from dashboard

### Step D1) Deploy current code

1. Return to Worker code editor.
2. Tap **Deploy** or **Save and Deploy**.
3. Wait until deployment success message appears.

### Step D2) Copy Worker URL

After deploy, you will see a URL like:

`https://racing-leaderboard-api.<your-subdomain>.workers.dev`

Copy this URL. You need it for frontend wiring.

---

## Part E — Connect game frontend to Worker URL

Your game file currently contains this placeholder:

- File: `js/main.js`
- Constant:

```js
const LEADERBOARD_API_BASE = 'https://REPLACE_WITH_YOUR_WORKER_URL/api/leaderboard';
```

You must replace it with your real Worker URL + `/api/leaderboard`.

Example:

```js
const LEADERBOARD_API_BASE = 'https://racing-leaderboard-api.abcd1234.workers.dev/api/leaderboard';
```

### Mobile-friendly ways to edit this file

Choose whichever you already use:

- GitHub web editor in browser.
- Replit / StackBlitz / Codespaces web editor.
- Hosting provider file manager editor.

After editing, publish/redeploy your frontend as you normally do.

---

## Part F — How to verify (no command line)

### Check 1: API URL directly in browser

1. Open browser and visit:

`https://YOUR-WORKER-URL/api/leaderboard?trackId=test-track`

2. You should see JSON response like:

- `ok: true`
- `entries: []` (empty is normal for new track)

### Check 2: In-game leaderboard panel

1. Open your game.
2. Start a track.
3. Confirm leaderboard panel appears.
4. Panel should show loading or empty message first.

### Check 3: Username behavior

1. Press **E** to open mode menu.
2. Enter player name in new name field.
3. Close menu.
4. Finish a fast lap.
5. Entry should appear in leaderboard with your name/time.

### Check 4: Popup behavior when no name is set

1. Clear the name field in E menu.
2. Finish a new best lap.
3. Popup should appear asking for a name.
4. Enter name and save.
5. Record should submit.

### Check 5: Per-track separation

1. Set a time on Track A.
2. Switch to Track B (or different map/mods URL).
3. Track B leaderboard should be different.
4. Return to Track A and confirm Track A time still exists.

---

## Understanding the important files

### Backend files (new root folder)

- `cloudflare-leaderboard/worker/src/index.js`
  - API logic, validation, sorting, per-track keying.

- `cloudflare-leaderboard/worker/wrangler.toml`
  - Local/CLI config reference for same Worker (you can ignore this if doing dashboard-only setup).

### Frontend files

- `index.html`
  - Leaderboard panel UI, name input field, popup structure.

- `js/main.js`
  - Track ID generation, leaderboard fetch/post, local storage for player name, popup flow.

---

## Troubleshooting (no terminal required)

## 1) Leaderboard says unavailable

Possible causes:

- Worker URL in `LEADERBOARD_API_BASE` is wrong.
- Worker not deployed after code change.
- KV binding missing or misspelled.

Fix:

1. Re-open Worker URL in browser and verify it responds.
2. Re-check binding variable is exactly `LEADERBOARD_KV`.
3. Re-deploy Worker.
4. Hard-refresh game page.

## 2) Names do not save

Possible causes:

- Browser privacy mode blocking local storage.
- Player name contains only spaces.

Fix:

1. Use normal browser tab, not strict/private mode.
2. Enter a non-empty name (letters/numbers).
3. Save again in E menu.

## 3) Records not posting

Possible causes:

- `LEADERBOARD_API_BASE` still placeholder value.
- Worker failed to parse payload.

Fix:

1. Confirm constant points to real deployed Worker URL.
2. Confirm URL ends with `/api/leaderboard`.
3. Re-publish frontend.

## 4) Same leaderboard appears on all tracks

Possible causes:

- Track URL not actually changing map/mods.
- Testing same track with same `map/mods` values.

Fix:

1. Verify `?map=...` or `?mods=...` changes between tests.
2. Use clearly different shared track links.

---

## Safety and anti-cheat notes (for later)

Current backend is simple so setup is easy.

For public/competitive use, add later:

- Rate limiting.
- Bot protection.
- Moderation tools.
- Stronger lap validation.

This project already gives you a clean base that works for small/community usage.

---

## Quick checklist (copy this)

- [ ] Created KV namespace `LEADERBOARD_KV` in dashboard.
- [ ] Created Worker and pasted `cloudflare-leaderboard/worker/src/index.js` code.
- [ ] Added KV binding variable name exactly `LEADERBOARD_KV`.
- [ ] Deployed Worker and copied Worker URL.
- [ ] Replaced `LEADERBOARD_API_BASE` in `js/main.js` with real URL + `/api/leaderboard`.
- [ ] Published frontend changes.
- [ ] Verified leaderboard load, submit, popup, and per-track separation in game.

---

## If you want an even easier future version

If you want, next pass can move the API URL out of code and into a small config file/UI toggle,
so you can change endpoints without editing JavaScript manually.

