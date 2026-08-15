# Racing-game — agent memory

## Adding a new car (vehicle model)

### Model requirements (the GLB itself)
- Node names matter: the `Vehicle.attachModel()` traverse looks for `body` and any node
  whose name contains `wheel` (+ `front`/`back` + `left`/`right`) to bind steering/roll.
  Both existing trucks AND the new `vehicle-hatchback-green.glb` / `vehicle-sedan-orange.glb`
  use: `body`, `underside`, `wheel-front-left/right`, `wheel-back-left/right`.
- Single material named `colormap` with a `baseColorTexture` (the paint shop reads it).
- Truck models reference an EXTERNAL texture `Textures/colormap.png` (resolved at
  `models/Textures/colormap.png`); the hatchback/sedan EMBED their PNG in the GLB. The
  paint shop's `getTextureSourcePixels()` reads `texture.image` (an HTMLImageElement in
  both cases) so external vs embedded makes no difference to cosmetics.
- All `vehicle-*` models are auto-scaled to 0.5 in `loadModels()` (matches Godot root_scale).
- The collider is always a fixed crashcat sphere radius 0.5 (`VEHICLE_SURFACE_RADIUS`,
  `createSphereBody`) — NOT derived from the model. Wheelbase/size differences are visual only.

### Code touchpoints to register a new car (search `vehicle-truck-yellow` as the template)
1. `index.html` `<select id="car-select">` — add `<option value="vehicle-…">Name</option>`.
2. `index.html` `<select id="garage-car-select">` — add `<option value="vehicle-…">Name</option>` (no body-style suffix; the garage card title uses `stats.name` only).
3. `js/main.js` `modelNames[]` (line ~234) — add the model base name (no `.glb`).
4. `js/main.js` `CAR_STATS` (line ~244) — add `{ name, speed, accel, perf: { topSpeed, accelRate, driveForce } }`.
   `perf` drives `Vehicle.setPerformance()`; `speed`/`accel` are the 0-10 garage card display.
5. `js/main.js` `CAR_SELECT_STYLES` (line ~250) — add `{ background, border, color }` hex theme.
6. `js/main.js` `normalizeMultiplayerCarKey()` `fallbackByName` (line ~915) — optional friendly-name alias.
7. `js/tas-viewer.js` `MODELS`, `REQUIRED_VEHICLE_KEYS`, `CAR_STATS` (lines ~13-24) — mirror main.js stats.
8. `js/tas-viewer.html` `<select>` (line ~108) — add option (parallel to tas-viewer.js).
9. `js/custom-mods.js` `action_set_vehicle_model` dropdown (line ~213) — add `[ 'Name', 'vehicle-…' ]`.
10. (Optional) `js/Track.js` `NPC_TRUCKS` (line ~379) — parked decorative cars on the default track.

### What does NOT need changing per car
- Audio: `audio/engine.ogg` is shared (no per-car engine sound).
- Physics body: fixed sphere, created once per vehicle; `setPerformance()` only tunes
  topSpeed/accelRate/driveForce.
- Paint shop / cosmetics: generic over `material.map` + `material.color`; keyed by carKey in
  `garageCosmetics.cars[carKey]` (localStorage `racing-garage-mods-v1`), auto-creates per car.
- Ghost/replay: stores `car` key in the payload; `createGhostVisualModel(models[entry.car])`
  falls back to yellow. `bestGhostCarKey` defaults to yellow.
- Split-screen: `pickRandomCarKey()` picks from `Object.keys(CAR_STATS)` automatically.
- `renderGarageVehicleCards()` iterates `modelNames.filter(k => CAR_STATS[k])` — auto-includes.

### Car-key persistence across systems
- Player's chosen car: `carSelect.value` / `currentCarKey()` (default `vehicle-truck-yellow`).
- Multiplayer packets carry `carKey` + `cosmetics`; `normalizeMultiplayerCarKey()` validates
  against `CAR_STATS[key] && models[key]` else falls back to yellow.
- Ghost/replay payloads carry `car`; imported ghosts normalize and re-render the matching model.
- Custom mods can call `api.setVehicleModel(key)` (validates against CAR_STATS + models).

### Current car roster (10 cars, all unified stats)
- Original 4: `vehicle-truck-yellow` (Yellow Truck), `vehicle-truck-green` (Green Truck),
  `vehicle-truck-purple` (Purple Van), `vehicle-truck-red` (Red Truck).
- Batch 2: `vehicle-hatchback-green` (Green Hatchback), `vehicle-sedan-orange` (Orange Sedan).
- Batch 3: `vehicle-car-police` (Police Car), `vehicle-delivery-yellow` (Yellow Delivery),
  `vehicle-flatbed-purple` (Purple Flatbed), `vehicle-van-blue` (Blue Van).
- Naming convention: `[Color] [Model]` (e.g. "Yellow Truck", "Purple Van", "Police Car").
  Police Car has no color prefix (it's a distinct livery). All share identical perf
  (topSpeed 1.12, accelRate 4.8, driveForce 95.0). The `car-select` dropdown options are
  overridden at runtime to `stats.name` (main.js ~line 5997), so HTML option text is a fallback.
- Garage card grid: `repeat(5, minmax(0,1fr))` → 2×5 grid for 10 cars. Responsive: 3 cols
  <1200px, 2 cols <720px. Mobile forces 2 cols.

## Physics: car is a rolling sphere (`js/Physics.js` + `js/Vehicle.js`)

### Drive model (critical for surface friction tuning)
- The car is a single crashcat sphere (radius `VEHICLE_SURFACE_RADIUS` 0.5, friction 5.0).
- It moves by ROLLING: `Vehicle.update()` applies ANGULAR velocity around the right
  axis (`rigidBody.setAngularVelocity(... angvel + _right * drive)`). Surface friction
  converts that rolling into linear (forward) motion.
- Consequence: on a tilted surface going UPHILL, the sphere needs grip to convert
  roll→translation against gravity. Low surface friction → sphere slips/spins in place
  → car "glides with zero friction" and can't accelerate uphill. On FLAT surfaces
  low friction is tolerable (no uphill gravity component), which is why flat
  elevated roads (friction 1.0) work but slopes did not.

### Surface friction values (Physics.js)
- Ground surface (`createGroundSurfaceCollider` in main.js): **5.0** (matches sphere).
- Slope driving surface (`addSlopeCollider`): **5.0** (was 1.0 — caused the "can't grip
  uphill" bug; raised to match ground). Pool slope (`addPoolSlopeCollider`): **5.0**.
- Slope side walls (`addSlopeSideWalls`): **0.0** (frictionless guide rails — keep low
  so the car slides along them instead of gripping/flipping).
- Flat elevated surface (`addMergedElevatedSurfaceColliders`): **1.0** (flat, OK).
- Jump ramp: **1.0** (low friction intentional — launches the car). Bump dome: **3.0**.
- Walls/poles/cubes: 0.0–0.9. Water floor: 0.25 (slick). Custom asset colliders: 0.7.
- Rule of thumb: any NEW tilted/drivable ramp should use friction 5.0 so the rolling
  sphere can grip uphill. Frictionless rails/launch surfaces stay low.

### Slope collider geometry (rotationally symmetric)
- `addSlopeCollider(gx, gz, orient, up)`: a tilted box, halfExtents
  `[ELEVATED_SURFACE_HALF_XZ, ELEVATED_SURFACE_HALF_H, slopeTargetHalfLen]`, pitched by
  `slopeAngle` (atan2(CELL_RAW*0.5, CELL_RAW) ≈ 26.565°) around the yaw axis (Euler
  'YXZ'). The rise (high-end Y − low-end Y) is `2*halfLen*sin(slopeAngle)` and is
  INDEPENDENT of orientation/yaw — all slopes have identical shape, just rotated.
  slope-down is normalized to slope-up via ORIENT_180 + `up=false`→flipped orient.
- High end meets the flat elevated surface (elevatedSurfaceTopY); low end blends into
  the ground (slightly buried). So a slope's collider is correct for ALL orientations —
  if a slope "doesn't work", suspect friction or adjacency, NOT the hitbox shape.

### Seam-bounce suppression vs slopes (the intermittent grip-loss glitch)
- `suppressSeamBounce(world, veh, key, onSlope)` cancels the upward "pop" + speed loss
  when the sphere catches on an edge between two FLAT surface colliders. It does this by
  RESTORING THE ENTIRE PRE-STEP VELOCITY (`rigidBody.setLinearVelocity(savedVel)`).
- BUG (fixed): on a slope the car legitimately gains upward velocity (vy>0) while
  climbing. That tripped the detection thresholds (vy 0.15–4.0, vyDelta>0.2, prevVy<1.0)
  and restored the pre-step velocity — freezing the car's velocity and undoing the
  physics step. Result: car slid around with stale velocity, ignoring physics, unable to
  grip/accelerate. Intermittent because it depended on exact per-frame vy values.
- FIX: `suppressSeamBounce` takes an `onSlope` flag; when true it skips the velocity
  restore (and returns false so crash-detection isn't skipped). `isVehicleOnSlopeCell()`
  (uses `slopeCellMap`, same cell math as `applySlopeConformVisual`) computes the flag in
  the main loop before the call. Flat-ground suppression is unchanged (onSlope=false).
- The slope is one continuous tilted collider (no internal seam) and its high end meets
  the elevated surface flush, so suppression isn't needed on slope cells. Do NOT remove
  the onSlope bypass — reintroducing it brings back the grip-loss glitch.

## Decoration trees (`js/Track.js`)

### Tree rotation (breaks up grid pattern)
- `createInstances(src, positions, randomY)` accepts a `randomY` flag. Both 3D auto-placed
  tree meshes — `decoration-forest` (tall trees) AND `decoration-empty` (buffer-zone
  bushes/shrubs near the track) — pass `true`. `empty-deco-grass` (flat grass quad) keeps
  rotation 0 (rotating a flat quad would change its visual footprint).
- Each instance gets a Y rotation limited to **90° intervals** (0, 90, 180, 270) derived
  from a stable hash of its cell coords. No odd tilts — only the four cardinal angles.
  Same cell → same angle every reload (no reshuffle when the track rebuilds). Trees/bushes
  are roughly symmetric so rotation only breaks the repetitive aligned-grid pattern.

### Off-grid tree blocking (`blockCellForTrees`)
- A track cell at (gx,gz) covers [gx,gx+1]×[gz,gz+1]. An integer decoration cell (cx,cz)
  covers [cx,cx+1]×[cz,cz+1]. A tree is "under the road" when footprints overlap.
- Blocking range = `floor(gx)..ceil(gx)` per axis. On-grid (integer gx): 1 cell. Off-grid:
  2 per axis (4 total). OLD center-based math (`ceil(gx-0.5)..floor(gx+0.5)`) missed the
  far-side cell for fractional gx → trees poked through off-grid roads. Fixed + tested in
  `test-offgrid-trees.mjs` (12 assertions).
- Tree-blocked cells render as `empty-deco-grass` (flat grass quad); buffer-zone cells
  keep `decoration-empty` (bushes). `empty-deco-grass.glb` loaded in main.js + tas-viewer.js.

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
