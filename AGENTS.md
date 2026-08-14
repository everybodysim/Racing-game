# Racing-game — agent memory

## Custom Mods Lab (`custommods.html` + `js/custom-mods.js`)

### Blockly field-colour (freeze fix)
- Blockly 13 (blockly.min.js from unpkg) does NOT bundle `FieldColour`; it ships as a
  separate `@blockly/field-colour` package. Loading that UMD bundle as a plain global
  `<script>` does NOT reliably attach `Blockly.FieldColour`, so colour blocks
  (`new Blockly.FieldColour(...)`) threw at flyout-render time and FROZE the toolbox on
  the FX / Lists / UI & Storage / Game Control categories.
- Fix: a self-contained `RacingFieldColour` (subclass of `FieldTextInput` with a native
  HTML `<input type="color">` picker) is defined inline at the top of `js/custom-mods.js`
  and assigned to `Blockly.FieldColour`. The CDN `<script>` tag was removed from
  `custommods.html`. This works offline and never freezes. Verified by a standalone
  test page that injected a workspace with colour blocks — all rendered with no errors.

### Custom mod runtime pipeline (how an installed mod actually runs)
- `custommods.html` "Save to Mod Manager" and `mods.html` "Install" BOTH write the same
  shape to `localStorage['racing-installed-mods-v1']`:
  `{ id: 'custom-<modId>', name, entry: 'data:text/javascript;base64,...' }`.
- `js/main.js` `loadRuntimeMods()` reads that list, `normalizeModEntryPath()` passes
  `data:` URLs through unchanged, then `import(entryPath)` loads the module.
- The generated template (`generateTemplate()` in custom-mods.js) is SELF-CONTAINED:
  it inlines `const SPEC = {...}` + the full `resolveValue`/`runActions` definitions +
  `export default { id, init, applyFrame, onCheckpoint, onCrash, onRespawn, onLapFinish, dispose }`.
- `toRuntimeMod()` picks `.default`; `init(scopedContext)` runs `SPEC.onStart`;
  `applyFrame({dt,input,controls,vehicle,world,now})` runs onTick/onKey/etc. each frame
  in the main loop (main.js ~line 9204, BEFORE the particle-colour block).
- Verified end-to-end in-browser: `import("data:text/javascript;base64,...")` returns
  `.default`, `init` runs onStart actions, `applyFrame` runs each frame.

### Leaderboard gating
- `submitLeaderboardTime()` (main.js) blocks submission when `nonFreecamModsInstalled`
  is true (any installed mod whose id !== 'freecam'). Custom mods have id `custom-*`,
  so they disable the leaderboard with a specific message.

### Drift particle colours
- `customModParticleColor` defaults to `null` (main.js). With no custom mod, drift
  particles use grey `DEFAULT_PARTICLE_COLOR` (0x5E5F6B) from `Particles.js`. Only a
  mod calling `api.setParticleColor(hex)` sets it. BOOST particles are red/orange
  (BOOST_PARTICLE_COLORS) by design, independent of mods.
- If a player sees red DRIFT particles with "no mods", a custom mod calling
  setParticleColor is lingering in localStorage — remove it via Mod Manager.

### Block coverage proofread
- All 265 toolbox block types in `custommods.html` have a definition (direct
  `Blockly.Blocks.name=` or via `actionDef`/`valueDef`/`uiDef`/`storageDef` factories)
  and an exact parser case (`if (type === '...')`). Lists / UI & Storage /
  Game Control / FX categories have 0 undefined blocks and 0 unhandled parser cases.

### Community Custom Mods board (`cloudflare-mods/` + `js/mods-manager.js` + `js/custom-mods.js`)
- A Cloudflare Worker + KV store for publishing/installing community custom mods,
  modeled on the Track Share Board worker (`cloudflare/worker/src/index.js`).
- Folder: `cloudflare-mods/worker/{src/index.js,wrangler.toml,package.json}` +
  beginner README `cloudflare-mods/README.md` (dashboard-only AND wrangler-CLI paths).
- Worker endpoints: `GET /api/mods` (list summaries), `POST /api/mods` (publish full
  share payload), `GET /api/mods/:id` (full mod + view bump), `POST /api/mods/:id/install`
  (install count), `POST /api/mods/:id/vote` (thumbs up=1/down=-1), `DELETE /api/mods/:id`
  (admin `X-Admin-Token`). KV keys `mods:index` (cap 300) + `mod:<id>` (cap 1.5MB).
- Share payload shape is the existing `racing-custom-mod-share-v1` from
  `getSharePayload()` in custom-mods.js: `{type,modId,modName,xml,template,createdAt}`.
  Publish adds `author` + `description`.
- Frontend config: `MODS_API_BASE = 'https://REPLACE_WITH_YOUR_WORKER_URL/api/mods'`
  constant in BOTH `js/mods-manager.js` (board panel) and `js/custom-mods.js`
  (Publish to Community Board button). Replace placeholder with deployed worker URL.
- `boardReady()` returns false while the placeholder is in place, so the board panel
  and publish button show a friendly "not connected yet" message and the rest of the
  Mod Manager / Custom Mods Lab keep working normally.
- `mods.html` "Custom Mods Community Board" panel: publish from saved mods OR paste
  share URL/JSON, search, refresh, install (reuses `installMod`+`toCompressedJsEntry`),
  vote (sessionStorage dedupe `modBoardVotes:v1`). Install counter bump is fire-and-forget.
- Verified: 18 worker assertions pass (`test-mods-board.mjs`); pages render with no
  console errors; existing `test-storage.mjs` (15) and `test-mod-flow.mjs` (10) pass.

## Hot render-loop performance (`js/main.js` + `js/HudExtras.js` + `js/HudGrid.js`)

### Architecture of the animate loop
- The whole game runs inside one `async init()`; the per-frame work is the `animate()`
  closure (search `function animate()`), driven by `requestAnimationFrame`. Each frame
  updates physics (`updateWorld`), input, cameras, particles, audio, FX (bloom/fog/CSS
  vignette), HUD (~12 Hz throttled via `hudUpdateAccumulator`), then renders.
- The previous hot loop had O(n) scans + allocations every frame per vehicle; PR #387
  (`perf-optimize-main-loop`) eliminated these WITHOUT changing gameplay/visuals.

### Cell-keyed spatial lookups (replaced linear surface scans)
- Track surfaces are stored as `surfaceEntries` with `gx,gz` grid coords. The contact
  functions (`findActiveSurfaceTypeFor`, `findPadContactFor`, `findBoostSurfaceContactKeyFor`,
  `findSurfaceContactKeyForType`, `findLegacyBoostContactKeyFor`) used to scan the WHOLE
  array every frame. Now cell-keyed `Map`s (`surfaceEntryByCell`, `padEntryByCell`,
  `boostSurfaceEntryByCell`, `legacyBoostEntryByCell`) are built once at track load
  (next to `padEntries`/`legacyBoostEntries` construction) and `collectNearbyEntries()`
  gathers a 3x3 neighbourhood around the vehicle's current cell.
- `CELL_UNIT = CELL_RAW * GRID_SCALE` is the world size of one cell. Vehicle overlap
  radius < one cell, so 3x3 is behaviour-identical to the full scan. Reusable buckets
  (`_surfaceNeighbourhood`, `_padNeighbourhood`, etc.) avoid per-call allocations.

### Ghost playback cursor
- Ghost samples (`bestLapGhostSamples`, replay states) are sorted ascending by `t`.
  `findGhostSampleIndex(samples, wrapped, state)` keeps a cached `state._cursor` that
  advances forward each frame (O(1) amortised) instead of `Array.findIndex` (O(n)).
  On time-wrap it rescans from index 1. `ghostPlaybackCursor` is the shared cursor for
  the best-lap ghost; replay states use their own `state._cursor`. Cursor must be reset
  to 1 at every site that repopulates samples (3 sites: import payload, parsed import,
  new best lap).

### Per-frame allocation elimination
- `seamSuppress.vel1/vel2`: reuse `_seamVel1/_seamVel2` arrays (was a fresh `[x,y,z]`
  twice per vehicle per frame). `rigidBody.setLinearVelocity` reads synchronously so
  overwriting the shared array after the restore is safe.
- `cam.update(...)` dynamics: reuse `_camDynamics1/_camDynamics2` objects (was a fresh
  options object up to 4x/frame). `Camera.update` only READS the fields, never retains.
- Vignette projection: `_vignetteProjected` Vector3 reused (was `spherePos.clone()`).
- `cachedGraphicsPreset` caches `getGraphicsPreset()` (refreshed in `applyGraphicsQuality`);
  bloom/weather hot-path reads use it. Non-hot callers still call the getter directly.

### Style/DOM churn reduction
- Speed-blur CSS effects (canvas `filter`, vignette `--car-x/--car-y/opacity/backdropFilter`)
  throttled to ~12 Hz (`_cssEffectAccumulator >= 0.08`) with last-value change detection
  (`_lastCanvasFilter`, `_lastVignetteX/Y/Opacity/Backdrop`). Visually identical since
  effects ramp smoothly with velocity.
- `refreshHudValues()` (HudGrid.js) skips `innerHTML` rewrite when rendered HTML
  unchanged (cached in `el.dataset.lastHud`).
- Speedometer (HudExtras.js) writes `textContent`/`strokeDashoffset`/`stroke` only on
  change (`_lastSpeedoNum/_lastSpeedoOffset/_lastSpeedoStroke`).

### What was deliberately NOT changed (preserve visuals/gameplay)
- Shadow map size, pixel ratio, AA, tone mapping, bloom thresholds — all per quality
  preset, untouched. `powerPreference: 'high-performance'` added to WebGLRenderer (hint
  only, no visual change). Particles already pooled. Physics step essential. Magnet scan
  left linear (few entries, long range).
