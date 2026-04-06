# Accounts Worker — Deno Deploy setup guide (web dashboard only)

This worker handles user accounts (signup, login, profile cloud-sync) for the racing game. It uses **Deno Deploy** with built-in **Deno KV** for storage — no database setup required.

---

## What this Worker does

- `POST /api/accounts/signup` — create a new account (username + password), returns auth token.
- `POST /api/accounts/login` — authenticate, returns auth token + saved profile (if any).
- `POST /api/accounts/save` — save profile JSON to the cloud (requires auth token).
- `GET  /api/accounts/profile` — load saved profile from the cloud (requires auth token).
- `POST /api/accounts/delete` — delete the account and all data (requires auth token).

Storage uses **Deno KV** — it's built into Deno Deploy, so there's nothing extra to create or configure.

---

## Prerequisites

1. A free Deno Deploy account — sign up at https://dash.deno.com (you can use your GitHub account).
2. That's it — everything below is done in the browser.

---

## Step-by-step deployment (all in the browser)

### 1) Create a new Playground

1. Go to https://dash.deno.com
2. Click **New Playground** (top-right).
3. This opens a code editor in your browser with some starter code.

### 2) Paste the worker code

1. **Select all** the starter code in the editor (Ctrl+A / Cmd+A).
2. **Delete** it.
3. Open the file `deno-accounts-worker/main.js` from this repo (you can view it on GitHub).
4. **Copy the entire contents** of that file.
5. **Paste** it into the Deno Deploy editor.

### 3) Deploy

1. Click **Save & Deploy** (top-right), or press **Ctrl+S**.
2. The preview panel on the right will show the deployed URL.
3. Your worker is now live! The URL looks like: `https://<random-name>.deno.dev`

### 4) Note your URL

Look at the preview panel or the project settings — your URL will be something like:

```
https://gentle-fox-42.deno.dev
```

You'll need this URL in the next step.

### 5) (Optional) Rename your project

1. Click the **Settings** icon (gear) in the playground.
2. Change the project name to something memorable, like `racing-accounts`.
3. Your URL will update to `https://racing-accounts.deno.dev`.

---

## Connect the game frontend

Edit the `ACCOUNTS_API_BASE` constant in `js/main.js` — find this line near the top:

```js
const ACCOUNTS_API_BASE = '/api/accounts';
```

Change it to your Deno Deploy URL:

```js
const ACCOUNTS_API_BASE = 'https://<your-project>.deno.dev/api/accounts';
```

For example:

```js
const ACCOUNTS_API_BASE = 'https://racing-accounts.deno.dev/api/accounts';
```

CORS is enabled in the worker, so cross-origin requests will work from any domain (GitHub Pages, Cloudflare Pages, etc.).

---

## Test it

1. After changing `ACCOUNTS_API_BASE`, open the game in a browser.
2. Press **E** to open the mode menu.
3. Scroll down to **Cloud Account**.
4. Enter a username and password, click **Sign Up**.
5. You should see "Account created — profile saved to cloud".
6. Click **Log Out**, then **Log In** with the same credentials.
7. Your profile (coins, upgrades, garage, campaign progress) should load automatically.

You can also test the raw API by opening this URL in your browser:

```
https://<your-project>.deno.dev/api/accounts/profile
```

You should see: `{"ok":false,"error":"Unauthorized — please log in again"}` — that's correct (no token yet).

---

## How data is stored

Deno KV stores data as key-value pairs. This worker uses these key patterns:

| Key | Value |
|---|---|
| `["user", username]` | `{ passwordHash, createdAt }` |
| `["profile", username]` | Profile JSON (same format as the Export Profile button) |
| `["token", hex]` | `{ username, createdAt }` — auto-expires after 90 days |

Deno KV is built into Deno Deploy — there's no separate database to create, configure, or pay for. Data persists automatically.

---

## Security notes

- Passwords are hashed with SHA-256 before storage (never stored in plain text).
- Auth tokens are 32-byte random hex strings with a 90-day TTL (auto-deleted by Deno KV).
- Usernames are 3–24 characters, alphanumeric plus `_` and `-`.
- Profile data is capped at 64 KB.

---

## Deno Deploy free tier limits

- 1 million requests per month
- 1 GB KV storage
- 100,000 KV read units / day, 1,000 KV write units / day

This is more than enough for a game with casual users. See https://deno.com/deploy/pricing for details.

---

## File map

- Deno Deploy worker: `deno-accounts-worker/main.js`
- Cloudflare worker (alternative): `cloudflare/accounts-worker/src/index.js`
- Frontend account UI: `index.html` (the `#account-panel` section)
- Frontend account logic: `js/main.js` (search for "Cloud account state")
