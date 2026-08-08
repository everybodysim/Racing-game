# Cloudflare Competitions Backend

This folder contains a Cloudflare Workers backend for the competitions system.

## Structure

- `worker/wrangler.toml` — Worker configuration and KV bindings.
- `worker/src/index.js` — API implementation.

## Endpoints

- `GET /health`
- `GET /api/competitions/event?tier=&seed=`
- `POST /api/competitions/enter`
- `POST /api/competitions/submit`

## Setup

1. Create two KV namespaces in Cloudflare (production + preview) for binding name `COMP_KV`.
2. Put the resulting namespace IDs into `worker/wrangler.toml`.
3. Deploy the worker from the `worker/` directory with Wrangler.
4. Set the frontend API base to your worker domain:
   - `https://<your-worker>.workers.dev`

## Data model

Each event is keyed by `event:<seed>:<tier>`.
Stored value shape:

```json
{
  "pool": 0,
  "entries": 0,
  "leaderboard": [
    { "name": "Player", "time": 12.34 }
  ]
}
```

## Notes

- CORS is enabled for browser access.
- Leaderboard keeps best time per player and stores up to top 200 records.
