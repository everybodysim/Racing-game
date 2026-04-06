# Accounts Worker — Cloudflare setup guide (web dashboard only)

This worker handles user accounts (signup, login, profile cloud-sync) for the racing game. It lives alongside the existing track-share worker — they are separate Workers with separate KV namespaces.

---

## What this Worker does

- `POST /api/accounts/signup` — create a new account (username + password), returns auth token.
- `POST /api/accounts/login` — authenticate, returns auth token + saved profile (if any).
- `POST /api/accounts/save` — save profile JSON to the cloud (requires auth token).
- `GET  /api/accounts/profile` — load saved profile from the cloud (requires auth token).
- `POST /api/accounts/delete` — delete the account and all data (requires auth token).

Storage uses **Cloudflare KV** via the `ACCOUNTS_KV` binding.

---

## Prerequisites

1. A Cloudflare account (same one you used for the track-share worker).
2. That's it — everything below is done in the Cloudflare dashboard.

---

## Step-by-step deployment (all in the browser)

### 1) Create a KV namespace

1. Go to https://dash.cloudflare.com
2. In the left sidebar, click **Workers & Pages**.
3. Click **KV** in the sub-menu.
4. Click **Create a namespace**.
5. Name it `racing-accounts` (or whatever you like).
6. Click **Add**.
7. **Copy the namespace ID** — you'll see it in the table. It's a long hex string like `abc123def456...`.

### 2) Update `wrangler.toml` with the namespace ID

Open `cloudflare/accounts-worker/wrangler.toml` in your code editor (or on GitHub) and replace:

```toml
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

with the real ID you copied. For example:

```toml
id = "abc123def456..."
```

Commit and push this change.

### 3) Create the Worker

1. In the Cloudflare dashboard, go to **Workers & Pages**.
2. Click **Create** → **Create Worker**.
3. Name it `racing-accounts-api`.
4. Click **Deploy** (this creates a placeholder — you'll paste the real code next).
5. After it deploys, click **Edit code** (the "Quick Edit" button).
6. **Delete** all the placeholder code in the editor.
7. **Copy the entire contents** of `cloudflare/accounts-worker/src/index.js` from this repo.
8. **Paste** it into the Cloudflare editor.
9. Click **Deploy** (top-right).

### 4) Bind the KV namespace to the Worker

1. Go back to the Worker's page in the dashboard (Workers & Pages → `racing-accounts-api`).
2. Click **Settings** → **Bindings**.
3. Click **Add** → **KV Namespace**.
4. Set the **Variable name** to exactly: `ACCOUNTS_KV`
5. Select the KV namespace you created in step 1 (`racing-accounts`).
6. Click **Save**.

### 5) Test it

Your Worker is now live at:

```
https://racing-accounts-api.<your-subdomain>.workers.dev
```

To find your exact URL: go to **Workers & Pages** → click `racing-accounts-api` → the URL is shown at the top.

Open that URL in a browser with `/api/accounts/profile` appended, e.g.:

```
https://racing-accounts-api.yourname.workers.dev/api/accounts/profile
```

You should see: `{"ok":false,"error":"Unauthorized — please log in again"}` — that's correct (no token yet).

---

## 6) Connect the game frontend to this Worker

### Option A (recommended): same domain via route

If your game is on Cloudflare Pages or a custom domain on Cloudflare:

1. Go to your **domain** in the Cloudflare dashboard.
2. Click **Workers Routes** (under the Workers tab).
3. Click **Add route**.
4. Route: `yourdomain.com/api/accounts/*`
5. Worker: select `racing-accounts-api`.
6. Click **Save**.

Then the default `ACCOUNTS_API_BASE = '/api/accounts'` in `main.js` works with no changes.

### Option B: separate domains

If the game is hosted elsewhere (GitHub Pages, Netlify, etc.), edit the `ACCOUNTS_API_BASE` constant in `js/main.js`:

```js
const ACCOUNTS_API_BASE = 'https://racing-accounts-api.<your-subdomain>.workers.dev/api/accounts';
```

CORS is already enabled in the Worker, so cross-origin requests will work.

---

## 7) Verify end-to-end

1. Open the game in a browser.
2. Press **E** (or click "Mode Menu") to open the mode menu.
3. Scroll down to **Cloud Account**.
4. Enter a username and password, click **Sign Up**.
5. You should see "Account created — profile saved to cloud".
6. Click **Log Out**, then **Log In** with the same credentials.
7. Your profile (coins, upgrades, garage, campaign progress) should load automatically.

---

## How data is stored

In your `ACCOUNTS_KV` namespace, data is stored under these key patterns:

| Key pattern | Value |
|---|---|
| `user:<username>` | `{ passwordHash, createdAt }` |
| `profile:<username>` | Profile JSON (same format as the Export Profile button) |
| `token:<hex>` | `{ username, createdAt }` — auto-expires after 90 days |

You can inspect these in the Cloudflare dashboard: **Workers & Pages → KV → your namespace → View**.

---

## Security notes

- Passwords are hashed with SHA-256 before storage (never stored in plain text).
- Auth tokens are 32-byte random hex strings, stored with a 90-day TTL.
- Usernames are 3–24 characters, alphanumeric plus `_` and `-`.
- Profile data is capped at 64 KB.
- For production use, consider adding rate limiting via Cloudflare's built-in tools (dashboard → Security → Rate Limiting).

---

## File map

- Worker logic: `cloudflare/accounts-worker/src/index.js`
- Worker config: `cloudflare/accounts-worker/wrangler.toml`
- Frontend account UI: `index.html` (the `#account-panel` section)
- Frontend account logic: `js/main.js` (search for "Cloud account state")
