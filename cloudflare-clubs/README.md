# Cloudflare Clubs System (Ably + Workers + KV)

This folder contains a complete Clubs backend + integration notes for this racing game.

## Folder structure

- `cloudflare-clubs/worker/src/index.js` – Worker API for clubs, membership, owner-only moderation, and message history persistence.
- `cloudflare-clubs/worker/wrangler.toml` – Worker project config, including `CLUBS_KV` binding.
- `cloudflare-clubs/worker/package.json` – local scripts (`dev`, `deploy`, `tail`) and Wrangler dependency.

---

## 1) Create a Cloudflare account (first-time users)

1. Open https://dash.cloudflare.com/
2. Click **Sign Up**.
3. Enter email + password.
4. Confirm your email.
5. After login, you land in the Cloudflare dashboard.

You can use Workers without moving DNS for this project.

---

## 2) Create Worker project files locally

Already included in this folder. If starting from scratch:

```bash
cd cloudflare-clubs/worker
npm install
```

What each file does:

- `src/index.js` routes and business logic:
  - `POST /clubs` create club with unique case-insensitive name.
  - `GET /clubs` list clubs.
  - `POST /clubs/:id/members` owner-only add member.
  - `POST /clubs/:id/kick` owner-only kick member.
  - `POST /clubs/:id/mute` owner-only mute member.
  - `POST /clubs/:id/rename` owner-only rename club.
  - `POST /clubs/:id/transfer` owner-only ownership transfer.
  - `DELETE /clubs/:id` owner-only delete club.
  - `POST /clubs/:id/messages` store message history (normal or announcements).
  - `GET /clubs/:id/messages` retrieve last 15 normal + last 15 announcements.

- `wrangler.toml` defines worker name, entrypoint, and KV binding.

---

## 3) Install Wrangler CLI

From `cloudflare-clubs/worker` run:

```bash
npm install
npx wrangler --version
```

If you want global install:

```bash
npm install -g wrangler
wrangler --version
```

---

## 4) Log in to Wrangler

```bash
npx wrangler login
```

Browser opens → click **Allow** → terminal confirms auth.

Check current account:

```bash
npx wrangler whoami
```

---

## 5) Create KV namespace `CLUBS_KV`

In terminal:

```bash
npx wrangler kv namespace create CLUBS_KV
npx wrangler kv namespace create CLUBS_KV --preview
```

You will get two IDs (`id` and `preview_id`).

Paste them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CLUBS_KV"
id = "<prod-id>"
preview_id = "<preview-id>"
```

Dashboard click path (if you prefer UI):
- Dashboard → **Workers & Pages** → **KV** → **Create namespace** → name it `CLUBS_KV`.

---

## 6) Deploy Worker

```bash
cd cloudflare-clubs/worker
npm run deploy
```

After deploy you get URL like:
`https://racing-clubs-worker.<subdomain>.workers.dev`

Put this URL in `index.html` constant:

```js
const CLUBS_API_BASE = "https://YOUR-WORKER.workers.dev";
```

---

## 7) Local development/testing

```bash
npm run dev
```

Wrangler prints local URL (usually `http://127.0.0.1:8787`).

Test endpoints with curl:

```bash
curl http://127.0.0.1:8787/clubs
curl -X POST http://127.0.0.1:8787/clubs -H "content-type: application/json" -d '{"displayName":"Club One","ownerUsername":"PlayerA"}'
```

Owner-only add member:

```bash
curl -X POST http://127.0.0.1:8787/clubs/<clubId>/members \
  -H "content-type: application/json" \
  -H "x-actor-username: PlayerA" \
  -d '{"username":"PlayerB"}'
```

Announcements (owner only):

```bash
curl -X POST http://127.0.0.1:8787/clubs/<clubId>/messages \
  -H "content-type: application/json" \
  -H "x-actor-username: PlayerA" \
  -d '{"stream":"owner","username":"PlayerA","content":"Patch tonight"}'
```

---

## 8) Logs and debugging

Live logs from deployed worker:

```bash
npm run tail
```

Also dashboard route:
- Workers & Pages → your worker → **Logs**.

Common errors:
- `403 Owner only action` → `x-actor-username` is not club owner.
- `409 Club name already exists` → name uniqueness is case-insensitive.
- `404 Club not found` → wrong `clubId`.
- `Error: binding CLUBS_KV not found` → check `wrangler.toml` binding and namespace IDs.

---

## 9) Data model in KV

Keys used:

- `clubs:index` → array of all `clubId`s.
- `clubs:name-index` → map `{ lowercasedName: clubId }`.
- `club:<clubId>` → metadata + members + owner + settings.
- `club:<clubId>:chat:normal` → last 15 normal chat messages.
- `club:<clubId>:chat:owner` → last 15 announcements messages.

Message object format:

```json
{
  "messageId": "msg_xxx",
  "username": "PlayerA",
  "timestamp": "2026-05-12T12:34:56.000Z",
  "content": "Hello club"
}
```

---

## 10) Ably integration details

Frontend sends Ably messages with tags:

- Normal: `[clubId] username: message`
- Announcements: `[clubId][owner] username: message`

Worker independently stores canonical history per club (not only frontend filtering), so reconnect/history can use backend source.

---

## 11) Frontend wiring steps

1. Open `index.html`.
2. Find `CLUBS_API_BASE` and set deployed worker URL.
3. Open game page and click chat button.
4. Open **Clubs** tab.
5. Create club, open it, send normal chat, send owner announcements.
6. Use owner toolbar to add members.

UI behavior implemented:
- clubs page inside chat popup
- create club UI
- club list browser
- club homepage with member list
- owner controls hidden for non-owners
- normal + announcements inputs

---

## 12) Environment variables/secrets

Current worker does not require secrets for core club APIs.
If you later add server-side Ably publishing, set secrets:

```bash
npx wrangler secret put ABLY_API_KEY
```

Edit variables later via:
- terminal (`wrangler secret put`), or
- dashboard → Worker → Settings → Variables.

---

## 13) Updating and redeploying later

1. Edit `src/index.js`.
2. Test locally: `npm run dev`.
3. Deploy: `npm run deploy`.
4. Watch logs: `npm run tail`.

---

## 14) Rename/change worker later

1. Edit `name = "..."` in `wrangler.toml`.
2. Deploy again (`npm run deploy`).
3. Update frontend `CLUBS_API_BASE` URL.

---

## 15) API request/response examples

Create club request:

```http
POST /clubs
content-type: application/json

{"displayName":"Drift Kings","ownerUsername":"Alex"}
```

Response:

```json
{"club":{"clubId":"club_...","displayName":"Drift Kings","ownerUsername":"Alex","members":["Alex"]}}
```

Owner kick member request:

```http
POST /clubs/<clubId>/kick
x-actor-username: Alex
content-type: application/json

{"username":"Sam"}
```

---

## 16) Important beginner troubleshooting checklist

- Did you run `npx wrangler login` in this machine?
- Did you create both KV IDs (prod + preview)?
- Did you paste IDs correctly into `wrangler.toml`?
- Did deploy finish successfully?
- Did you copy exact workers.dev URL into `index.html`?
- Are you testing as owner for owner-only actions?
- Are you passing JSON headers in API calls?

