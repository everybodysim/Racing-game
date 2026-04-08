# Season Worker (TOTD-style seed source)

This worker provides deterministic seeds for season/week/day.

## Endpoint
- `GET /api/season/current`

Returns:
- `seasonId`
- `seasonSeed`
- `daySeed`
- `rewardPool`

Use this with your existing TOTD seed flow so each season has a stable seed and reward pool.

## Setup
1. Create Worker: `racing-season-api`
2. Paste `src/index.js`
3. Deploy (no KV required)

## Cost
- Extremely cheap (read-only compute, no storage).
