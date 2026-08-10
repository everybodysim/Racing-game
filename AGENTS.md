# Racing Game — Agent Notes

## Determinism / TAS

The game is designed to be **100% deterministic**: identical inputs produce
identical simulation state and identical visual output, regardless of display
refresh rate. This is the foundation for the TAS (Tool-Assisted Speedrun)
feature.

### How it works

- **Fixed timestep** (`js/Determinism.js`): the simulation always advances in
  `FIXED_DT` (1/120 s) chunks. `main.js#animate()` runs an accumulator: real
  frame time is added to `simAccumulator`, and `runSimulationStep(FIXED_DT)`
  is called once per accumulated `FIXED_DT` (capped at
  `MAX_STEPS_PER_FRAME`). Rendering and audio stay on real time and are
  decoupled from the simulation.

- **Seeded RNG** (`js/Determinism.js`): a shared `gameRng` (mulberry32)
  replaces every `Math.random()` / `THREE.MathUtils.randFloat*` call in
  gameplay **and** visual loops (particles, weather, lightning, camera shake,
  sky decorations, audio music/impact-tone). `resetGameRng(DEFAULT_RNG_SEED)`
  is called at race start so each run begins from the same RNG state.

- **Race clock**: gameplay timers (countdown, lap timing, boost windows,
  stunt scoring, advancements drift duration) use `raceClockSeconds`, which
  advances by exactly `stepDt` per substep — never `Date.now()` /
  `performance.now()` / `timer.getElapsed()` for gameplay state.

- **TAS step = one simulation substep**: `mods/TAS.js`'s
  `DeterministicPlaybackController` advances one step per `applyFrame` call,
  and `applyFrame` is now invoked per substep, so one TAS input row maps to
  exactly one `FIXED_DT` (1/120 s) of simulation. The mod resets its frame
  cursor on the `onRaceStart` runtime hook.

### Reference architecture

`js/tas-viewer.js` is the standalone reference implementation (the TAS
**editor**, opened from the "TAS Editor" nav link when the TAS mod is
installed): `FIXED_DT = 1/120`, `resetGameRng(DEFAULT_RNG_SEED)` per run,
`resetRun()` → `stepSimulation()`. It runs an editor state machine
(IDLE → RECORDING → REVIEW → PLAYBACK → BRUTEFORCE): recording captures one
input step per substep, playback replays them deterministically, and brute-force
mutates 3 frames per attempt and keeps a change only if the 2-lap time
improves. `mods/TAS.js` is the in-game playback-only runtime (no UI) that
replays the stored inputs during a normal race.

### What is intentionally non-deterministic (cosmetic only)

- Water shader ripple (`Track.js` `waterPlane.onBeforeRender` uses
  `performance.now()`) — render-time uniform, no gameplay effect.
- Multiplayer client id (`main.js` line ~830) — out of scope.
- Achievement unlock timestamps (`unlockedAt: Date.now()`) — display only.

### Contract for new code

To keep determinism, any new gameplay/visual logic must:

1. Run inside `runSimulationStep()` (per-substep), not directly in
   `animate()`.
2. Scale by `stepDt`, never by real frame time.
3. Use `gameRng` (or a `new SeededRandom(seedFromString(...))`) for any
   randomness — never `Math.random()`.
4. Use `raceClockSeconds` for any time comparison — never `Date.now()` /
   `performance.now()` / `timer.getElapsed()`.
