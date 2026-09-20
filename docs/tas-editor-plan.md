# TAS Editor v2 — Complete Redo Plan

Goal: a TAS editor where a run recorded on one machine replays **bit-identically** on any machine, at any frame rate, driven from an editable text input script. Foundation already shipped: the fixed-step simulator (commit `f012025`) advances the whole sim in exact 1/60s steps with inputs latched at step boundaries. This plan adds per-step input recording/injection on top of it.

## 1. Architecture — three pieces

```
tas.html (NEW, parent page)
 ├─ track URL input at startup
 ├─ track-type badge (LOOP / NON-LOOP)
 ├─ iframe viewport  →  index.html?<track params>&tas=1
 ├─ timing readouts (lap timer, step counter)
 ├─ "Run inputs" button + inputs textbox (editable)
 └─ postMessage bridge to the iframe

js/TASMode.js (NEW, game-side TAS module)
 ├─ activated only when ?tas=1 — zero effect on normal play
 ├─ per-step input recorder + injector
 ├─ cross-line state capture/apply
 ├─ TAS timing overlay (in-viewport readout)
 └─ postMessage bridge to parent

js/main.js (MODIFIED, ~6 guarded hook lines, all no-ops when !tasMode)
 ├─ init: if tas=1 → dynamic import('./TASMode.js'), tasMode.activate(...)
 ├─ runSimulationStep: input override point + input capture point
 ├─ finish-cross handler: recording boundary + cross-line snapshot
 └─ lap transition: suppress the normal post-lap startCountdown() (line ~13926)
```

Normal gameplay stays byte-identical in behavior: every hook is `if ( tasMode ) tasMode.x()` and no-ops otherwise. TAS is a game feature the user explicitly requested, so main.js changes are authorized here.

## 2. Track type detection (loop vs non-loop)

Game already computes `startGateData` and `finishData`. Classification:

- **LOOP track** — start and finish are the same block (`finishData.cellKey === startGateData.cellKey`), i.e. "one start/finish block". Drive **2 laps** to record lap-2 inputs with a flying start.
- **NON-LOOP track** — separate start and finish blocks. Drive **1 lap**.

Reported to the parent on `tas-ready` and shown as a badge in the tas.html UI (also drawn in the in-viewport TAS overlay). If a track has no finish block at all, TAS mode refuses with an error card (no finish = nothing to time).

## 3. Startup + driving flow

1. tas.html loads → asks for a track URL (paste `index.html?map=...&mods=...` or a board Play URL).
2. Parent parses the URL params, builds `index.html?<params>&tas=1`, loads it in the iframe.
3. Game boots in TAS mode → countdown (3-2-1, TAS version only, reusing the existing `startCountdown()` — it already zeroes input deterministically) → timer starts → player drives.
4. **LOOP track**: crossing the finish does **NOT** restart the countdown — the lap timer restarts like normal and driving continues into lap 2 (that flying start is the point). Recording of lap 2 starts at the cross-line step.
5. **NON-LOOP**: crossing the finish completes the only lap.
6. On the required lap count completing, game pauses input and posts `tas-lap-complete` with the recorded script + cross-line state. Parent shows the popup over the viewport:
   - **"Use this run"** → the inputs script is pasted into the inputs textbox (lap 2's script for loop tracks, lap 1's for non-loop).
   - **"Try again"** → game runs a countdown (fingers-on-keys time), timer restarts, player re-drives from spawn. Countdown exists ONLY in TAS mode; normal mode is untouched.

## 4. Input script format v1

Recording captures the **effective per-step input** `{x, z}` (post controls, post pad modifiers) — the exact values `vehicle.update()` consumed — so any input device (keyboard, gamepad, touch) records identically and replay is independent of the key→analog mapping.

Delta-encoded (RLE): one line per input CHANGE; a state holds until the next line.

```
# Skid Circuit TAS v1
track: <map+mods hash>
mode: lap2            # lap1 | lap2
# lap2 only — state captured at the finish-line cross:
state: pos 12.5000 0.3800 -3.2500
state: vel 1.0200 0.0000 0.3500
state: angvel 0.0000 1.4500 0.0000
state: quat 0.7071 0.0000 0.0000 0.7071
step 0 x=0 z=1         # first driving step after countdown/cross
step 42 x=0.0 z=1
step 71 x=-1 z=1
step 133 x=0 z=0
end                   # finish-line cross on this step
```

- Keyboard records clean ±1/0 values; gamepad analog records decimals — both run identically.
- `step N` = sim step index since the lap's first driving step.
- Empty input = `step N x=0 z=0`.
- `#` comments allowed anywhere (it's an editable textbox — players hand-tune frames).
- Parser is total: unknown lines are commented/ignored with a validation report shown before running.

## 5. Cross-line state (loop tracks, lap 2)

At the exact step the finish plane crosses (lap 1 → 2):

- **Captured**: `spherePos`, rigid body `linearVelocity`, rigid body `angularVelocity`, `container.quaternion`, plus the step index and sim clock t.
- **Applied on TAS run start**: before step 0 of the injected script, set the body translation/velocities and container rotation from the script header. This reproduces the flying start bit-identically.
- Non-loop tracks run from the normal spawn state — no header block.

## 6. Playback pipeline ("Run inputs" button)

1. Parent parses + validates the textbox, sends `tas-run {script}`.
2. Game: stops driver control, resets obstacles/movers to lap start, applies cross-line state (loop/lap2) or spawn state, clears HUD timer.
3. No countdown on TAS runs — the script owns step 0. (Countdown is for human fingers only.)
4. Per step, `runSimulationStep` takes the input from the script (`tasMode.injectInput(stepIndex)`) instead of `controls.update()`.
5. On finish cross: `tas-run-complete {lapSeconds, stepCount, valid}` posted to parent; the parent shows the time next to the Run button (step-exact, e.g. `12.433s (746 steps)`).
6. During a run, the recorder also runs silently and compares injected vs consumed input — any mismatch (script shorter than lap, edited line that changes an earlier hidden state) is flagged as a warning, not silent corruption.

## 7. postMessage protocol

| Direction | Message | Payload |
|---|---|---|
| game → parent | `tas-ready` | `{ isLoop, trackHash, stepHz: 60 }` |
| game → parent | `tas-countdown` | `{ n }` (3,2,1) |
| game → parent | `tas-lap-start` | `{ lap, stepIndex }` |
| game → parent | `tas-lap-complete` | `{ lap, lapSeconds, stepCount, script, crossState }` |
| game → parent | `tas-run-complete` | `{ lapSeconds, stepCount, valid }` |
| parent → game | `tas-retry` | — (countdown + fresh attempt) |
| parent → game | `tas-run` | `{ script }` |
| parent → game | `tas-stop` | — (abort run/record) |

## 8. Rules and edge cases

- Countdown: TAS mode only; on loop tracks the finish cross must NOT re-trigger it (suppress the normal post-lap `startCountdown()` call when tasMode is active). Timer restarts like normal.
- Pause (Escape): steps stop, recording stops with them — nothing extra to handle; the lap gets invalidated by the existing pause rule.
- Respawn (R) mid-lap: recorded like any input; replay reproduces it identically. Nothing special.
- Recording starts at the first driving step (countdown steps record nothing — input is forced zero there anyway).
- Lap-2 script starts at the cross-line step, with `step 0` = the first step after crossing.
- Editor-quick-test / competition redirects and other URL flows are ignored in TAS mode.
- Split-screen / MP: TAS mode is single-player only; joining a room or split screen in TAS mode is blocked with a notice.

## 9. Testing plan

1. **Record→run bit-identity E2E**: boot tas.html headless with a real board track, auto-drive a scripted sequence (key events), capture the recorded script from `tas-lap-complete`, click Run, probe spherePos/yaw every step during the run — assert the run's state stream equals the recording session's state stream from the cross-line state forward.
2. **Frame-rate independence**: same test under 4x CPU throttle — still bit-identical (determinism harness from f012025).
3. **Loop vs non-loop classification**: boot one track of each type from the board, assert the badge.
4. **Script editing**: mutate one `step` line, re-run, assert the divergence starts exactly at that step index.
5. **Popup flow**: assert "use this run" fills the textbox, "try again" produces a countdown and restarts the timer, and on loop tracks the finish cross does not re-countdown.
6. Normal mode regression: boot plain index.html, assert no TAS code paths execute (no tasMode import, 0 errors).

## 10. Implementation order

1. `js/TASMode.js` skeleton + main.js hooks (activate, capture, inject, finish-cross, countdown suppression) — record side end-to-end.
2. `tas.html` parent: URL input, iframe, badge, popup, textbox paste.
3. Playback + Run button + cross-line apply.
4. Countdown/retry flow polish + timing readouts.
5. Full E2E suite above, delete test files, cache-bust (`main.js?v=+1`, TASMode import with `?v=1`), ship.

## Out of scope (explicitly)

- Fixing/wiring the OLD TAS viewer/editor — this replaces it.
- Ghost overlay comparison during runs (natural v2).
- Gamepad-specific UI (analog values just record as decimals).
- Sharing/saving scripts server-side (textbox copy/paste is the v1 transport).
