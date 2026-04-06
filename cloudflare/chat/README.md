# Cloudflare live chat setup (mobile-friendly, no terminal required)

This folder gives you a production-ready Cloudflare Worker + Durable Object backend for a **real-time in-game chat**.

It is designed for your racing game and supports:

- multiple chat rooms (`room=global`, `room=track-abc`, etc.)
- live push updates with WebSockets
- message history persistence per room
- safe input trimming and limits
- simple REST endpoint for loading current history

---

## 1) What files are in this folder

- `wrangler.toml`: Cloudflare app config (name, Durable Object binding, migration).
- `src/index.js`: API + live chat room logic.
- `README.md`: this setup guide.

---

## 2) Cloudflare dashboard setup flow (phone/tablet friendly)

You can do everything in the Cloudflare dashboard UI:

1. Create a new **Worker**.
2. Name it however you want (for example, `racing-live-chat`).
3. Open the Worker code editor and paste `src/index.js`.
4. In settings, add a **Durable Object binding**:
   - Binding name: `CHAT_ROOM`
   - Class name: `ChatRoom`
5. Add a migration tag (`v1`) with `ChatRoom` as a new SQLite-backed class.
6. Deploy.

After deploy, your Worker URL will look like:

`https://<your-worker-subdomain>.workers.dev`

---

## 3) Endpoints your game will call

### A) Load room history

- `GET /api/chat/messages?room=global`

Response shape:

```json
{
  "ok": true,
  "messages": [
    {
      "id": "uuid",
      "name": "Player",
      "text": "Hello!",
      "createdAt": 1234567890
    }
  ]
}
```

### B) Send a message

- `POST /api/chat/messages?room=global`
- Body:

```json
{
  "name": "Alex",
  "text": "Great lap!"
}
```

### C) Subscribe for live updates

- `GET /api/chat/stream?room=global`
- WebSocket events:
  - snapshot event on connect (`type: "snapshot"`)
  - new message events (`type: "message"`)

---

## 4) How to wire it into your game UI

For the frontend you’d add:

1. **Chat panel** (message list + input + send button).
2. **Initial fetch** from `/api/chat/messages?room=<roomName>`.
3. **WebSocket connection** to `/api/chat/stream?room=<roomName>`.
4. **POST** on send to `/api/chat/messages?room=<roomName>`.
5. Render incoming `snapshot` + `message` events.

Room strategy suggestions:

- `global`: all players in one chat
- `track-<trackId>`: one chat per map
- `party-<inviteCode>`: private sessions

---

## 5) Built-in safety/limits in this implementation

- Name max length: 24 chars
- Message max length: 220 chars
- Message history kept per room: last 80 messages
- Room id sanitized to lowercase `[a-z0-9-_]` and capped at 40 chars

This reduces abuse and prevents huge payloads from lagging the game UI.

---

## 6) Production hardening checklist

Before exposing publicly, you should add:

1. **Rate limiting** (per-IP or per-session).
2. **Profanity/abuse filtering** on message text.
3. **Basic anti-spam gate** (cooldown per user/device).
4. **Optional auth** if you want only signed-in players chatting.
5. **Moderation hooks** (delete message / mute user / block room).
6. **Client reconnect logic** (auto-reconnect with backoff).
7. **Message rendering escape/sanitization** on frontend.

---

## 7) How this scales

Durable Objects route each room to exactly one instance, which gives:

- in-order message handling per room
- simple fan-out to connected sockets in that room
- persistent small history in Durable Object storage

This is a strong fit for game lobbies and match chat.

---

## 8) Quick integration map for your existing repo

- Keep this backend in `cloudflare/chat`.
- Add game-side chat UI in your `index.html` + `js/main.js`.
- Use your Worker URL as chat API base.
- Start with one room (`global`), then expand to per-track rooms.

