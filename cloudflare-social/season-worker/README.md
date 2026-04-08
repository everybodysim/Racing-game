# Season Worker (TOTD-style seed source)

This worker provides deterministic seeds for season/week/day and a season records board.

## Endpoints
- `GET /api/season/current`
- `GET /api/season/board?seasonId=S12`
- `POST /api/season/record` body `{ "seasonId":"S12", "name":"Player", "records": 4 }`

`/api/season/current` returns:
- `seasonId`
- `seasonSeed`
- `daySeed`
- `rewardPool`
- `trackSeeds` (12 deterministic season tracks)

Use this with your existing TOTD seed flow so each season has a stable seed and reward pool.

## Setup
1. Create Worker: `racing-season-api`
2. Create KV namespace: `RACING_SEASON_KV`
3. Bind KV in Worker settings:
   - Variable: `SEASON_KV`
   - Namespace: `RACING_SEASON_KV`
4. Paste `src/index.js`
5. Deploy

## Cost
- Very cheap (small KV writes + light read traffic).
