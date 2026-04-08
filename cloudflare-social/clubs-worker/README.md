# Clubs Worker (Cheap KV-first setup)

## Features
- Create clubs
- Join clubs
- Submit member stats (coins + records)
- Club pages with ranking by coins and records

## Endpoints
- `GET /api/clubs`
- `POST /api/clubs` body `{ name, owner }`
- `GET /api/clubs/:id`
- `POST /api/clubs/:id/join` body `{ name }`
- `POST /api/clubs/:id/stats` body `{ name, coins, records }`

## Dashboard setup
1. Create KV namespace: `RACING_CLUBS_KV`.
2. Create Worker `racing-clubs-api`.
3. Paste `src/index.js`.
4. Add binding:
   - Variable: `CLUBS_KV`
   - Namespace: `RACING_CLUBS_KV`
5. Deploy.

## Cheapness notes
- KV only.
- Club index is cached in one key for cheap reads.

## Quick test
1. Create club using POST `/api/clubs`.
2. Open `clubs.html` and set your API base constant.
