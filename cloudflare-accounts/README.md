# Cloudflare Account System Setup (Extremely Detailed, Beginner-Friendly)

This guide helps you set up **account sign-up/login + cloud profile save/load** for the game without guesswork.

You can follow this even if backend work feels confusing.

---

## What this new backend does

The new account Worker exposes these endpoints:

- `POST /api/accounts/signup`
  - Creates a new account with unique username + password.
  - Returns a session token.
- `POST /api/accounts/login`
  - Logs into an existing account.
  - Returns a session token.
- `GET /api/accounts/profile?token=...`
  - Loads a saved cloud profile for the logged-in account.
- `POST /api/accounts/profile`
  - Saves the profile payload for the logged-in account.

The frontend (`js/main.js`) now uses this API for:

- Sign up
- Login
- Export account code
- Import account code
- Optional cloud save/load profile actions

---

## Overview of what you must set up

You will do 6 parts:

1. Create KV namespace in Cloudflare.
2. Create/Deploy an Account Worker with the repo code.
3. Bind KV to the Worker.
4. Copy Worker URL and set it in `js/main.js`.
5. Deploy your frontend update.
6. Test sign-up/login/cloud save/load in-game.

---

## Part 0 — Before starting (do this first)

You need:

- Cloudflare account access (`https://dash.cloudflare.com`).
- This repo with latest code.
- Ability to edit `js/main.js` and publish frontend files.

If you use dashboard only (no command line), that is fine.

---

## Part 1 — Create KV storage (Dashboard clicks)

1. Open Cloudflare Dashboard.
2. In left sidebar, open **Workers & Pages**.
3. Open **Storage & Databases** → **KV**.
4. Click **Create namespace**.
5. Namespace name: `RACING_ACCOUNTS_KV`.
6. Click **Create**.

Keep this tab open; you’ll select this namespace when adding Worker bindings.

---

## Part 2 — Create Account Worker (Dashboard clicks)

1. Go to **Workers & Pages**.
2. Click **Create application**.
3. Click **Create Worker**.
4. Name it: `racing-account-api` (or any name you prefer).
5. Click **Deploy**.
6. Click **Edit code**.

Now replace Worker code:

1. Open file from repo: `cloudflare-accounts/worker/src/index.js`.
2. Copy all code.
3. In Cloudflare editor, replace entire file contents.
4. Save.

---

## Part 3 — Add KV binding (very important)

1. In Worker editor, open **Settings**.
2. Open **Bindings**.
3. Click **Add binding**.
4. Type: **KV Namespace**.
5. Variable name: `ACCOUNTS_KV` (must be exactly this).
6. KV namespace: choose `RACING_ACCOUNTS_KV` (or the namespace you created).
7. Save.

If the variable name is not exactly `ACCOUNTS_KV`, the backend will fail.

---

## Part 4 — Deploy Worker and copy URL

1. Return to Worker code screen.
2. Click **Deploy** / **Save and Deploy**.
3. Wait for success message.
4. Copy worker URL, for example:
   - `https://racing-account-api.your-subdomain.workers.dev`

You’ll need this URL in `js/main.js`.

---

## Part 5 — Wire frontend to account Worker

Open `js/main.js` and find the account API base constant.

Set it to:

```js
const ACCOUNT_API_BASE = 'https://YOUR-ACCOUNT-WORKER-URL/api/accounts';
```

Example:

```js
const ACCOUNT_API_BASE = 'https://racing-account-api.abcd1234.workers.dev/api/accounts';
```

Then redeploy your frontend (GitHub Pages / Cloudflare Pages / your host).

---

## Part 6 — Testing checklist (click-by-click)

### 6.1 Test signup endpoint directly

Open browser URL (replace base URL):

`https://YOUR-ACCOUNT-WORKER-URL/api/accounts/profile?token=test`

Expected: JSON error like invalid token. That proves route is alive.

### 6.2 In game: sign up

1. Open game page.
2. Press `E` to open mode menu.
3. In account section:
   - Username: choose a new one.
   - Password: choose one (6+ chars).
4. Click **Sign Up**.
5. Confirm status says signed in.

### 6.3 Duplicate username check

1. Open another browser/incognito.
2. Try same username + any password on **Sign Up**.
3. Should fail with duplicate username error.

### 6.4 Login check

1. In second browser, use same username + correct password.
2. Click **Login**.
3. Should sign in and return a token.

### 6.5 Cloud save/load check

1. While logged in, press **Cloud Save Profile**.
2. Change coins/profile locally (play or import code).
3. Press **Cloud Load Profile**.
4. Profile should restore from cloud account data.

### 6.6 Export/import account code

1. Press **Export Account** to copy a code.
2. On another device/browser, use **Import Account** and paste code.
3. Confirm username + session data restore.
4. Then click **Cloud Load Profile** to sync account profile content.

---

## Important operational notes

### A) Password safety

- Passwords are hashed (SHA-256 with salt) before storing.
- Still, for production-grade auth, consider stronger auth policies and rate limiting.

### B) Sessions

- Session tokens currently expire after ~30 days.
- Users can log in again to get fresh tokens.

### C) CORS

- Worker currently allows `*` origin for easier setup.
- For tighter security, lock this to your site domain.

### D) KV consistency

- KV is eventually consistent.
- Very small delay can happen between write and global read.

---

## Troubleshooting (common mistakes)

### "Leaderboard works but accounts fail"

Usually one of:

- Wrong `ACCOUNT_API_BASE` URL in `js/main.js`.
- Account Worker deployed but binding missing.
- Binding variable name not `ACCOUNTS_KV`.

### "Signup always says username invalid"

Allowed username:

- length 3 to 24
- letters, numbers, underscore, dash, dot
- no spaces-only names

### "Cloud load says invalid token"

- Session token expired.
- Re-login and try again.
- If importing account code, make sure full code pasted.

### "Import/Export works but cloud save doesn’t"

- Export/import is local code transfer.
- Cloud save/load requires valid logged-in token against deployed Worker.

---

## File map

- Account Worker code: `cloudflare-accounts/worker/src/index.js`
- Account Worker config: `cloudflare-accounts/worker/wrangler.toml`
- Frontend account UI + logic: `index.html`, `js/main.js`
- Leaderboard dedupe update: `cloudflare-leaderboard/worker/src/index.js`

