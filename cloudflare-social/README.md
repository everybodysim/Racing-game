# Cloudflare Social Stack (Cheap-first)

This folder contains separate workers, each in its own subfolder:

1. `season-worker` – seasonal TOTD-like seed source
2. `coins-worker` – global coins leaderboard
3. `clubs-worker` – clubs creation + per-club rankings

Deploy each worker independently using the README inside each folder.

Frontend pages added:
- `coins.html` (global coin rankings + manual submit)
- `clubs.html` (create/join clubs + per-club pages)
- `seasons.html` (season seed + projected reward pool split)
