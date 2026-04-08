# Coins Worker (Cheap Cloudflare Setup)

This worker stores coin stats and exposes a global coins ranking.

## Endpoints
- `GET /api/coins/top`
- `POST /api/coins/submit` body: `{ "name": "Player", "coins": 1234, "records": 5 }`

## Dashboard setup
1. Create KV namespace (name suggestion: `RACING_COINS_KV`).
2. Create Worker named `racing-coins-api`.
3. Paste `src/index.js`.
4. Add KV binding:
   - Variable: `COINS_KV`
   - Namespace: `RACING_COINS_KV`
5. Deploy.
6. Copy Worker URL and update frontend constants.

## Cheapness notes
- KV-only storage (no Durable Objects / no D1 required).
- Cached top list under one key (`coins:top`) to keep reads simple.

## Verify
- Open: `https://YOUR_WORKER/api/coins/top`
- Submit with curl:
  ```bash
  curl -X POST https://YOUR_WORKER/api/coins/submit \
    -H "content-type: application/json" \
    -d '{"name":"Tester","coins":250,"records":2}'
  ```
