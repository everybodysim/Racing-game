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

## TAS Editor (iframe-embed architecture)

The interactive TAS editor lives on `tas-viewer.html` (opened via the "TAS
Editor" nav link under **Create** + a home secondary link, both gated on the
`tas` mod being installed). The editor is a **parent page** that drives the
real game running in an **iframe** at `index.html?tas=1`:

- `index.html` detects `?tas=1` → `tasEmbedMode`: adds `body.tas-embed-mode`
  (CSS hides ALL chrome except the canvas + the `#countdown-hud` overlay — like
  pressing H), locks the iframe to `overflow:hidden` (no arrow-key scroll),
  keeps the fixed-timestep simulation, and exposes `window.__tasBridge` plus a
  `postMessage` protocol (`{type:'tas-command', command, ...}`).
- The TAS editor uses **normal gameplay car stats** (no engine-tier override)
  so recordings match a real race.
- `js/main.js#runSimulationStep` has the TAS embed branches: `record` snapshots
  raw key state per substep into `tasRecordedSteps`; `playback`/`eval` feed the
  car from `tasPlaybackController.nextStep()` (one step = one `FIXED_DT`
  substep) and bypass pad/hack mutation so replay is bit-for-bit.
- **Record countdown:** pressing Record in the editor triggers a 3-2-1 inside
  the iframe (`startRecord` sets `countdownActive` + `tasPendingRecord`;
  `countdownEnabled` stays false for everyone else). The car + lap timer are
  frozen (input forced to `ZERO_DRIVE_INPUT`, `lapStartSeconds` set when the
  countdown ends) but the sim keeps rendering. When it ends, the sim flips to
  `record` mode and posts `tas-record-start`.
  **IMPORTANT ordering:** `tasPendingRecord = true` MUST be set AFTER
  `tasResetRun()` (which clears it) — otherwise the countdown→record handoff
  in `runSimulationStep` (`if (tasPendingRecord && !countdownActive)`) never
  fires and no inputs are captured. The countdown HUD now animates per digit
  via the `tick`/`go` CSS classes re-triggered in `updateCountdownHud`.
- **Lap-2 / prefix architecture:** combined start/finish tracks record 2 laps;
  only lap 2's inputs are editable. Lap 1 is kept as a hidden **prefix**
  (`prefixSteps`) replayed (headless during eval, visible during playback)
  before the target lap so the car carries the correct start-of-lap-2 speed.
  Tracks with separate start AND finish blocks (`shouldAutoRespawnAfterLap`)
  respawn after finishing, so they only need 1 lap (`tasTargetLaps = 1`).
  `tasLap2StartIndex` (set in the lap-finish handler when lap 1 completes) marks
  the split; `bridgeRecordingSplit()` returns `{prefix, lap2, targetLaps}`.
  When the target lap completes during `record`, the lap-finish handler also
  proactively posts `tas-record-stopped` (with `lapTime`) so the REVIEW
  prompt appears even if the parent's `tas-lap` → `stopRecord` path is missed.
- `bridge.eval(steps)` runs a **headless** synchronous eval loop
  (`tasRunEval`: `runSimulationStep(FIXED_DT)` until the target lap or the step
  cap, no render) and returns `{time, laps, dnf}`. `time` = `completedLap` of
  the target lap (lap-2 duration for 2-lap tracks, lap-1 duration for 1-lap
  tracks), measured from `lapStartSeconds` at that lap's start.
- **Important:** the in-race `mods/TAS.js` runtime mod's `applyFrame` is
  skipped inside `tasEmbedMode` (the runtime mod loop checks `runtime.id ===
  'tas'`) so it cannot override the bridge's recorded/edited input.
- Recording only works with **keyboard** (arrow keys / WASD). Gamepad/touch
  move the car but record neutral steps, so playback won't match — the editor
  hint tells users to use the keyboard.
- Input serialization format: `ArrowUp+ArrowLeft,30` = hold those keys for 30
  substeps. One serialized row = N identical `{keys:{up,down,left,right}}`
  steps. `keysToAxes` round-trips to the same `{x,z}` that `Controls.update()`
  produces from those keys, so recording ↔ playback are consistent.
- **Brute force** mutates 3 random frames per attempt and keeps a change only
  if the target-lap eval improves. A **turbo mode** batches evals (no live
  per-keep display, fewer UI yields) for much faster optimization.

### Known determinism limitation (alpha)

Tracks with custom **force-steer / force-brake** mods
(`customModForceBrakeUntil` etc.) are applied during recording (to the live
drive input) but bypassed during playback/eval (line ~8966 sets
`padAdjustedInput = input` verbatim). So TAS playback is not bit-exact for
such tracks. Plain tracks (the common case) are fully deterministic.
