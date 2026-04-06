# Cloudflare live chat setup with KV (mobile-friendly, no terminal required)

You asked for a version that does **not** depend on Durable Objects. This folder now uses **Cloudflare KV only**.

Important expectation setting:

- With KV only, this is **near-real-time** chat via short polling (for example every 1–3 seconds).
- True instant fan-out sockets are what Durable Objects are best at.
- For most casual in-game chat, KV polling is still good enough.

---

## What is in this folder

- `src/index.js` → KV-backed chat API.
- `wrangler.toml` → Worker config with one KV binding: `CHAT_KV`.
- `README.md` → this guide.

---

## Dashboard-only setup (no commands)

1. In Cloudflare dashboard, create/open your Worker.
2. Paste `src/index.js` into the editor and save.
3. In Worker settings, add a KV namespace binding:
   - Binding variable: `CHAT_KV`
   - Namespace: create one named something like `racing-live-chat`
4. Deploy.

That is enough for backend setup.

---

## API endpoints

### 1) Read messages

`GET /api/chat/messages?room=global`

Optional incremental polling cursor:

`GET /api/chat/messages?room=global&since=1712420000000`

Response shape:

```json
{
  "ok": true,
  "room": "global",
  "cursor": 1712420001234,
  "messages": [
    {
      "id": "uuid",
      "name": "Player",
      "text": "gg",
      "createdAt": 1712420001234
    }
  ]
}
```

### 2) Send message

`POST /api/chat/messages?room=global`

Body:

```json
{
  "name": "Alex",
  "text": "Great lap!"
}
```

---

## How to make it feel live in your game

Use polling with a cursor:

1. On load, call `GET /api/chat/messages?room=global` and render.
2. Store `cursor` from response.
3. Every 1–3 seconds call `GET /api/chat/messages?room=global&since=<cursor>`.
4. Append new messages and update `cursor`.
5. On send, post to `POST /api/chat/messages?room=global` and either:
   - append optimistic message locally, or
   - wait for next poll cycle.

---

## Limits/safety currently built in

- Name max length: 24 chars
- Message max length: 220 chars
- Room history retained: last 120 messages
- Room ID sanitized to lowercase `a-z`, `0-9`, `_`, `-` and max 40 chars

---

## Production notes

KV is eventually consistent, so two fast writers might briefly read stale history in edge cases. For lightweight game chat this is usually acceptable.

If you later need strict real-time ordering and high write concurrency, move to Durable Objects.
