# Accounts Worker — Cloudflare setup guide (very detailed)

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
2. Node.js installed (`node -v` should work).
3. `npm` installed (`npm -v` should work).
4. Wrangler CLI installed. If you already set it up for the track worker, you're good.

---

## Step-by-step deployment

### 1) Install Wrangler (skip if already installed)

```bash
npm install -g wrangler
wrangler --version
```

### 2) Log in to Cloudflare (skip if already logged in)

```bash
wrangler login
```

This opens a browser. Authorize, then return to terminal.

### 3) Create KV namespace for accounts

Navigate to this folder and run:

```bash
cd cloudflare/accounts-worker
wrangler kv namespace create ACCOUNTS_KV
```

You'll see output like:

```
✅ Successfully created namespace "racing-accounts-api-ACCOUNTS_KV"
with id "abc123def456..."
```

**Copy** the namespace ID (the long hex string).

### 4) Paste the namespace ID into `wrangler.toml`

Open `cloudflare/accounts-worker/wrangler.toml` and replace:

```toml
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

with the real ID you just copied. For example:

```toml
id = "abc123def456..."
```

Save the file.

### 5) Deploy the Worker

From `cloudflare/accounts-worker`:

```bash
wrangler deploy
```

You'll get a URL like:

```
https://racing-accounts-api.<your-subdomain>.workers.dev
```

Test it:

```bash
curl https://racing-accounts-api.<your-subdomain>.workers.dev/api/accounts/profile
```

Should return `{"ok":false,"error":"Unauthorized — please log in again"}` (expected — no token yet).

### 6) Test signup + login with curl

```bash
# Sign up
curl -X POST https://racing-accounts-api.<your-subdomain>.workers.dev/api/accounts/signup \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test1234"}'

# Login
curl -X POST https://racing-accounts-api.<your-subdomain>.workers.dev/api/accounts/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test1234"}'
```

Both should return `{"ok":true,"token":"...","username":"testuser"}`.

---

## 7) Connect the game frontend to this Worker

The frontend code uses `ACCOUNTS_API_BASE` in `js/main.js` (currently set to `'/api/accounts'`).

### Pattern A (recommended): same domain via Cloudflare Pages + route

If your game is on Cloudflare Pages, add a route so `/api/accounts/*` goes to this Worker:

1. Go to **Cloudflare dashboard → Workers & Pages → your Pages project → Settings → Functions**.
2. Or, go to **Workers Routes** under your domain and add:
   - Route: `yourdomain.com/api/accounts/*`
   - Worker: `racing-accounts-api`

Then the default `ACCOUNTS_API_BASE = '/api/accounts'` in `main.js` works with no changes.

### Pattern B: separate domains

If the game is hosted elsewhere (GitHub Pages, Netlify, etc.), edit the `ACCOUNTS_API_BASE` constant in `js/main.js`:

```js
const ACCOUNTS_API_BASE = 'https://racing-accounts-api.<your-subdomain>.workers.dev/api/accounts';
```

CORS is already enabled in the Worker, so cross-origin requests will work.

---

## 8) Verify end-to-end

1. Open the game in a browser.
2. Press **E** (or click "Mode Menu") to open the mode menu.
3. Scroll down to **Cloud Account**.
4. Enter a username and password, click **Sign Up**.
5. You should see "Account created — profile saved to cloud".
6. Click **Log Out**, then **Log In** with the same credentials.
7. Your profile (coins, upgrades, garage, campaign progress) should load automatically.

---

## 9) How data is stored

In your `ACCOUNTS_KV` namespace, data is stored under these key patterns:

| Key pattern | Value |
|---|---|
| `user:<username>` | `{ passwordHash, createdAt }` |
| `profile:<username>` | Profile JSON (same format as the Export Profile button) |
| `token:<hex>` | `{ username, createdAt }` — auto-expires after 90 days |

---

## 10) Security notes

- Passwords are hashed with SHA-256 before storage (never stored in plain text).
- Auth tokens are 32-byte random hex strings, stored with a 90-day TTL.
- Usernames are 3–24 characters, alphanumeric plus `_` and `-`.
- Profile data is capped at 64 KB.
- For production use, consider adding rate limiting via Cloudflare's built-in tools.

---

## 11) Useful debug commands

From `cloudflare/accounts-worker`:

```bash
# Re-deploy after changes
wrangler deploy

# Live-tail logs
wrangler tail

# List all keys in the KV namespace
wrangler kv key list --binding ACCOUNTS_KV

# Get a specific user record
wrangler kv key get --binding ACCOUNTS_KV "user:testuser"

# Get a specific profile
wrangler kv key get --binding ACCOUNTS_KV "profile:testuser"
```

---

## File map

- Worker logic: `cloudflare/accounts-worker/src/index.js`
- Worker config: `cloudflare/accounts-worker/wrangler.toml`
- Frontend account UI: `index.html` (the `#account-panel` section)
- Frontend account logic: `js/main.js` (search for "Cloud account state")
