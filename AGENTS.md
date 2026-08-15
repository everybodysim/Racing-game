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

### Elevated corner support pillar (Physics.js `addElevatedCornerSupport`)
- The corner mesh is a curved quarter-annulus, NOT a square block. The generic
  full-square `addElevatedSupportCollider(gx,gz)` is therefore SKIPPED for
  `elevated-corner` (the dispatch guards `normalizedType !== 'elevated-corner'`)
  and rebuilt as a curved footprint by `addElevatedCornerSupport(gx,gz,orient)`:
  - Two straight L-arm boxes fill the region under the two road stubs (the two
    sides adjacent to the tight inside corner at local (-CELL_HALF,+CELL_HALF)).
    Arm A runs along +z (north stub edge), arm B along -x (west stub edge). The
    arms are THIN WALLS flush with the stub edges (depth half-thickness =
    WALL_HALF_THICK), spanning the road half-width `CELL_HALF - WALL_HALF_THICK`
    along the edge — NOT solid blocks reaching toward the center. The corner's
    below-deck mesh is a curved shell (the outer wall extends down), so the
    support is a thin shell too: N-edge wall + W-edge wall + outer arc. The
    thin arms still meet the outer-arc endpoints exactly (dist 0.0).
  - The OUTER corner arc (the 8 longer wall segments from `addElevatedCornerWalls`)
    is duplicated at the SUPPORT height (centerY = supportTopY - SUPPORT_HALF_HEIGHT,
    halfHeight = SUPPORT_HALF_HEIGHT) — same XZ position/rotation as the road-level
    outer walls, only Y/halfHeight differ. This "expands" the rounded outer edge
    downward so a car below the elevated block still collides with a curved surface
    matching the mesh.
- Vertical extent matches the OLD support box exactly (top = supportTopY ≈ 3.479 <
  road surface elevatedSurfaceY ≈ 3.561), so the road deck above is NEVER blocked.
  Verified: arm boxes meet the outer-arc endpoints exactly (dist 0.0) for all 4
  orientations, support top stays below road for all 4.
- The road-level `addElevatedCornerWalls` (INNER 3-seg tight arc + OUTER 8-seg long
  arc rails) is unchanged and still called for corners.
- Other elevated types (straight/checkpoint/3-way/4-way) still use the full-square
  `addElevatedSupportCollider`.

### Show-hitboxes debug visuals (main.js + Physics.js)
- `HACK_HITBOX_OPACITY = 0.5` (hitboxes 50% transparent) and `HACK_WORLD_OPACITY = 0.9`
  (world 10% transparent, full color). The world must stay near-opaque so it reads
  in full color; the hitboxes overlay as semi-transparent blue on top.
- The wall/box debug material is `_debugMat` in Physics.js (MeshBasicMaterial,
  color 0x2244ff, opacity 0.5, depthWrite:false, depthTest:false so it always draws
  on top). The car sphere hitbox uses `carHitboxMaterial` (HACK_HITBOX_OPACITY).
- `setHackMeshTransparencyEnabled` traverses the scene, saves each material's
  original transparent/opacity/depthWrite, then sets transparent=true, opacity=min
  (current, HACK_WORLD_OPACITY), depthWrite=true. Restored on disable.

### Slope collider geometry (rotationally symmetric, seam-exact)
- `addSlopeCollider(gx, gz, orient, up)`: a tilted box, halfExtents
  `[ELEVATED_SURFACE_HALF_XZ, ELEVATED_SURFACE_HALF_H, slopeTargetHalfLen]`, pitched by
  `slopeAngle` (atan2(CELL_RAW*0.5, CELL_RAW) ≈ 26.565°) around the yaw axis (Euler
  'YXZ'). slope-down is normalized to slope-up via ORIENT_180 + `up=false`→flipped orient.
- The box's TOP face IS the driving surface. `slopeTargetHalfLen` / `slopeTargetCenterY`
  are derived so the top face meets the adjacent flat surfaces EXACTLY at both seams
  (no step → no clipping):
  - low end top Y  = `groundY` (ground road surface)
  - high end top Y = `elevatedSurfaceY + ELEVATED_SURFACE_HALF_H` (flat elevated deck top)
  - `slopeDeckTopY = elevatedSurfaceY + ELEVATED_SURFACE_HALF_H`
  - `slopeTargetHalfLen  = (slopeDeckTopY - groundY) / (2*sin(slopeAngle))`
  - `slopeTargetCenterY  = (groundY + slopeDeckTopY)/2 - ELEVATED_SURFACE_HALF_H*cos(slopeAngle)`
  - Solving `centerY + hy*cos ∓ hl*sin = {groundY, deckTopY}`. Valid for ANY slopeAngle;
    the rise = `2*hl*sin` = deckTopY − groundY, independent of orientation/yaw — all
    slopes have identical shape, just rotated. The half-run (`hl*cos` ≈ 3.776) slightly
    exceeds the cell half-width (≈3.746), so the ends overlap the neighbouring cells
    (good — guarantees no gap). `SLOPE_LOWER_EDGE_SHIFT = 0` (old 0.9 fudge removed).
- The old fudge constants (SLOPE_SURFACE_DROP=0.4, SLOPE_TOP_BLEND_RAISE=0.05,
  baseSlopeCenterY, slopeNormalYOffset, baseSlopeForwardYOffset, slopeBottomY,
  elevatedSurfaceTopY) were REMOVED — they left a 0.05 bump at the top seam and a
  0.256 drop at the bottom seam (clipping). If a slope "doesn't work", suspect
  friction or adjacency, NOT the hitbox shape.

### Slope side rails + ground U-walls (addSlopeSideWalls + addSlopeGroundWalls)
- `addSlopeSideWalls`: the two PITCHED frictionless rails along the ramp edges
  (halfExtents `[hThick, ELEVATED_WALL_HALF_H, slopeTargetHalfLen]`, same yaw+pitch
  quaternion as the slope box, lateral offset ±WALL_X*S). Their center Y is
  `slopeTargetCenterY + SLOPE_SIDE_WALL_RAISE` where `SLOPE_SIDE_WALL_RAISE =
  ELEVATED_WALL_HALF_H` (raised by half their own height — they used to sit too
  low). Called from `addSlopeCollider`.
- `addSlopeGroundWalls`: a ground-level U of three straight-road-style walls
  sealing the un-collided space under/around the solid slope wedge so a ground
  car can't clip in through the sides or the tall high end. All three use road
  wall dims (`halfExtents` arms `[hThick, hHeight, hLen]`, cross `[hLen, hHeight,
  hThick]`), center `wallY`, friction 0.0, yaw quaternion.
  - HIGH end is ALWAYS local -z for a normalized slope-up: the pitched top face
    Y = centerY + hy*cos ∓ hl*sin is maximal at lz = -hl. So the cross wall caps
    local -z (world offset `(-hLen*sr, -hLen*cr)` from cell center) and the low
    end (local +z) stays open as the ramp mouth.
  - Arms: lateral offset ±WALL_X (cell units), run along the slope length
    (local z), full cell long — identical to `addElevatedRoadWalls`/straight road
    walls. Cross wall spans across the road (local x), full cell wide.
  - Works for all 4 orientations (verified: cross wall lands on the high side,
    arms stay lateral, for orient 0/10/16/22).

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

## Video Recorder official mod (`mods/VideoRecorder.js` + `js/VideoRecorder.js`)

### What it is
- An official (catalog) mod, NOT a community/custom mod. Registered in `mods/mods.json`
  alongside freecam/hacks/etc. Install/uninstall via Mod Manager (`mods.html`).
- Records high-FPS, high-quality gameplay video (with game audio) straight from the
  WebGL canvas and downloads a WebM/MP4 to the player's browser on stop. Purpose:
  capturing gameplay for YouTube.

### Why the engine is wired in main.js, not the mod runtime
- The recorder needs the renderer canvas (`renderer.domElement`) and the game's
  AudioContext (`window.__gameAudio.listener.context`) + music element. The sandboxed
  custom-mod runtime can't reach those, so `js/VideoRecorder.js` (the engine) is
  imported and instantiated directly in `js/main.js`, gated on `videoRecorderInstalled`.
  `mods/VideoRecorder.js` is just metadata so the mod appears in the Mod Manager catalog
  and follows the same install lifecycle as other official mods.

### Code touchpoints (search `video-recorder` / `VideoRecorder`)
1. `mods/mods.json` — registry entry `{ id: 'video-recorder', name, entry: 'mods/VideoRecorder.js' }`.
2. `mods/VideoRecorder.js` — metadata export `VIDEO_RECORDER_MOD` (id/name/description).
3. `js/VideoRecorder.js` — the `VideoRecorder` class + `UI_TOGGLE_GROUPS` + settings
   helpers. Uses `canvas.captureStream(fps)` + `MediaRecorder`. Settings persist to
   localStorage key `racing-video-recorder-settings-v1`.
4. `index.html` — `<button id="video-recorder-btn">` (above `#car-select`, `display:none`
   until mod installed) + `<div id="video-recorder-panel">` (settings: fps, bitrate,
   format, filename prefix, capture-audio toggle, hide-UI-while-recording + per-group
   checkboxes built from `UI_TOGGLE_GROUPS`, start/stop/close, status line). CSS near
   `#hacks-panel`.
5. `js/main.js` import + `videoRecorderInstalled` flag (next to other `*Installed` flags)
   + the wiring block after `boostActivateBtn` listener: builds the recorder, populates
   controls from persisted settings, `vrSyncSettings()`, `vrRefreshButtonState()`, and
   the start/stop/click handlers. The `Alt+R` shortcut is in the main keydown handler
   (shares the "don't fire while typing" guard). `beforeunload` stops a live recording.

### Leaderboard gating (important)
- `nonFreecamModsInstalled` EXCLUDES `video-recorder` (alongside `freecam`), because the
  recorder is a non-gameplay utility. Installing it does NOT disable the leaderboard.
  Do NOT add `video-recorder` back into that `.some()` filter — it would wrongly block
  legitimate lap submissions just because someone is recording.

### Audio capture approach
- SFX: `window.__gameAudio.listener.getInput()` (THREE.AudioListener input GainNode,
  r140+) is tapped via a parallel Gain into a `MediaStreamAudioDestinationNode`. Does
  NOT disturb the listener's own -> ctx.destination routing.
- Music: `createMediaElementSource(musicEl)` is called ONCE and cached on
  `musicEl.__vrMediaSource` (calling it twice per element throws). The source is routed
  to BOTH ctx.destination (player still hears it) and the recording mixer. On cleanup
  we keep the music->destination connection.

### Hide-UI-while-recording
- `UI_TOGGLE_GROUPS` maps a setting key (hud/lapHud/countdown/boost/topMsg/vignette/nav/
  garage/hacks/mp) to DOM selectors. When `hideUiWhileRecording` is on, `start()` sets
  `data-vr-hidden` + `display:none` on matching elements and `stop()`/cleanup restores
  the previous `display`. The recorder never clobbers the game's own show/hide (it saves
  + restores the prior value). Default hides hud/lapHud/countdown/boost/topMsg/vignette;
  nav/garage/hacks/mp default off.

### Frame capture — display capture (includes HTML UI) vs relay canvas
- The recording MUST show the on-screen UI (HUD, lap timer, speedometer, buttons),
  not just the 3D scene. Those UI elements are HTML/CSS overlays on top of the
  WebGL canvas — they are NOT canvas pixels, so capturing only `renderer.domElement`
  (relay canvas) yields a video with the 3D scene but NO UI.
- PRIMARY capture path: `navigator.mediaDevices.getDisplayMedia({ video:{ frameRate, displaySurface:'tab' }, audio:false })`.
  This captures the COMPOSITED tab — WebGL + every HTML UI overlay — because it
  records what the user sees. `captureMode = 'display'`. In display mode the
  browser captures automatically; `captureFrame()` is a no-op (returns early when
  `captureMode !== 'relay'`). Audio is still mixed via the WebAudio path below and
  added as tracks (getDisplayMedia `audio:true` is unreliable across browsers, so
  we pass `audio:false` and mix ourselves).
- The user must approve a tab-share prompt once per recording (pick "this tab").
  `preferCurrentTab`/`displaySurface:'tab'` hints steer Chrome to the current tab.
  If the user picks a window/screen instead of a tab, UI may not appear — logged.
- If the user clicks the browser's native "Stop sharing" button, the display video
  track fires `ended`; we listen for it and call `stop()` so the file is finalized
  + opened in a new tab instead of silently dropped.
- FALLBACK (`captureMode = 'relay'`): if `getDisplayMedia` is unavailable/denied,
  the recorder creates an offscreen RGBA8 2D canvas (`relayCanvas`), and each frame
  `captureFrame()` does `relayCtx.drawImage(webglCanvas, 0, 0)` (reads the preserved
  frame buffer — `preserveDrawingBuffer: true`) then `videoTrack.requestFrame()`.
  `captureStream(fps)` is called on the RELAY canvas. This sidesteps the half-float
  drawing buffer (grey/empty) BUT captures only the 3D scene — HTML UI is NOT
  included. The status message + debug log say "canvas only — UI hidden" so the
  user knows to approve the tab-share prompt to get UI.
- `captureFrame()` is called from the game's `animate()` loop after `renderer.render()`.
  Timeslice `start(1000)` keeps chunks flowing; `stop()` calls `requestData()` first.

### Audio mixing (both modes)
- Engine/skid/impact sounds live in the WebAudio graph (THREE.AudioListener ->
  AudioContext.destination). Music plays through an HTMLMediaElement. `_buildAudioStream()`
  taps both via a MediaStreamDestination + Gain mixer: a gain tap off
  `listener.getInput()` (SFX) + a cached `createMediaElementSource` (music, routed to
  BOTH speakers and the mixer). Returns an audio-only MediaStream added to the
  capture stream. `createMediaElementSource` is cached on the element (`__vrMediaSource`)
  because it can only be called once per element.

### Debug log + open-in-new-tab (diagnostics)
- The recorder has a `log(msg)` method that appends a timestamped line to an
  internal buffer (`getDebugLog()`), the `#vr-debug` `<pre>` panel (via the
  `onDebug` callback wired in main.js), and `console.log`. It logs: canvas size,
  relay canvas size, video track readyState/frameRate/requestFrame availability,
  audio track count, mimeType, recorder opts, each `dataavailable` event (size +
  running total + chunk count), `onstop`, finalize blob size/type/frame count,
  blob URL, window.open result, AND the hide-groups applied (`hide UI: applied
  groups = [ hud(3 el), nav(2 el) ]`) + restore count.
- On stop, `_finalize()` opens the recording in a NEW TAB (`window.open(url, '_blank')`)
  so the user can play/verify it in-browser. It does NOT auto-download — see below.
- `#vr-copy-debug-btn` copies the log to clipboard; `#vr-clear-debug-btn` clears it.

### Download is a button, not auto (fixes "old page navigates to broken blob")
- The old auto `<a download>.click()` ran inside the ASYNC `onstop` callback,
  outside a user gesture, so browsers ignored the `download` attribute and
  NAVIGATED the current tab to the blob URL (broken page, debug log lost).
- Now: `_finalize()` opens the recording in a NEW TAB only (`window.open(url, '_blank')`,
  which the user confirmed works perfectly). It also retains the actual Blob as
  `this.lastBlob`. The panel's `#vr-download-btn` calls `videoRecorder.downloadLast()`,
  which mints a FRESH `URL.createObjectURL(this.lastBlob)` (re-using the URL already
  opened in the new tab can confuse some browsers into navigating) and keeps the `<a>`
  in the DOM for 4s before removing it + revoking — removing the anchor synchronously
  can abort the download in Chrome and fall back to navigating the current tab.
  Because it fires from a real user click, the `download` attribute is honored → the
  file downloads, the game page stays put. The button appears (`vrRefreshButtonState`,
  keyed off `lastBlob`) only when a finished recording exists.
- `lastBlob`/`lastBlobUrl`/`lastBlobName` are retained; revoked 4s after a download.
  They're overwritten on the next recording.

### Hide-UI groups default ALL OFF (fixes "always hides everything")
- `DEFAULT_SETTINGS.hideGroups` previously pre-checked 6 groups (hud, lapHud,
  countdown, boost, topMsg, vignette). The instant "Hide selected UI" was enabled,
  most of the screen vanished — looked like "it hides everything regardless of
  selection." Now every group defaults OFF; nothing hides unless the user
  explicitly checks it, so the selection is always respected.
- `_applyHideGroups` skips any group whose `hideGroups[key]` is falsy, and now
  logs exactly which groups it hid (with element counts) + logs "master toggle
  OFF" when the master toggle is off. If something hides unexpectedly, the debug
  log shows the precise list.
- Alt+R (keyboard start) now calls `vrSyncSettings()` before `start()` so a
  keyboard-started recording respects the current checkbox state (previously only
  the panel Start button synced settings).

### UI visibility gotcha (CSS display:none + inline style)
- `#video-recorder-btn`, `#vr-start-btn`, `#vr-stop-btn` all have `display: none` in
  their CSS rules. The wiring MUST set `el.style.display = 'block'` (NOT `''`) to
  show them — setting inline `''` reverts to the stylesheet's `display: none`. This
  bit us once (button never appeared even though the mod was installed and Alt+R
  worked). `vrRefreshButtonState()` uses explicit `'block'`/`'none'` for the same
  reason.

### Start/stop notifications
- Start and stop both surface a `showTopMessage(...)` toast (e.g. "⏺ Recording
  started (Alt+R to stop)", "⏹ Stopping recording… preparing download") from the
  button handlers and the `Alt+R` keydown handler. The recorder's own status line
  (`getMessage`) in the panel also updates.

### Tests
- `test-video-recorder.mjs` (78 assertions): MIME picking, settings round-trip,
  `UI_TOGGLE_GROUPS` shape, the relay-canvas start/stop lifecycle, `captureFrame()`
  (drawImage + requestFrame, throttle, no-op when not recording / display mode),
  the display-mode path (getDisplayMedia success → captureMode='display', no relay,
  captureFrame no-op), the debug log, `_applyHideGroups` selection (only checked
  groups hide, master toggle off hides nothing, restore works, exact-count check),
  `downloadLast()` guard (lastBlob-based), and the auto-capture fallback.
  Stubs browser globals incl. a swappable `navigator.mediaDevices.getDisplayMedia`.
  (NOTE: the `test-*.mjs` node suite was removed from the repo for the public
  CrazyGames submission; the assertions above describe what was verified.)

## Settings system (`js/GameSettings.js` + `settings.html` + `js/settings-page.js`)

### What it is
- A standalone **Settings page** (`settings.html`) separate from `index.html`,
  accessible from the main menu (home-secondary link), the in-game Nav tab
  (Configure section → Settings), and NavBar (`PAGE_NAMES['settings.html']`).
- 4 tabs: Graphics, Audio, Gameplay, Cloud Sync. (Controls + Accessibility tabs
  were REMOVED because their fields weren't wired to the engine — kept in the
  GameSettings schema for a future re-enable, just no UI. Shadow map size slider
  also removed — see below.)
- One shared ES module `js/GameSettings.js` is the single source of truth; both
  `index.html` (the game) and `settings.html` import it.

### GameSettings module (`js/GameSettings.js`) — single source of truth
- Unified schema key: `racing-game-settings-v1` = `{ v:1, graphics, audio,
  gameplay, controls, accessibility }`. Cached in-module; `refresh()` clears the
  cache (used by storage-event cross-tab sync).
- ALSO writes the legacy per-subsystem keys so existing code keeps working:
  - `racing-graphics-quality` (preset: low/medium/high; for a `custom` preset
    the legacy key stores `basePreset` so the game picks the right base)
  - `racingGameAudioSettings` (JSON: sfxVolume/musicVolume/musicMode)
  - `racing-show-fps-v1` ('1'/'0')
  - `racing-fx-settings-v1` (recentGhostsEnabled/recentGhostCount)
  - `racing-player-name-v1` (playerName — not a settings field but mirrored)
  - NOTE: the countdown setting was REMOVED from the settings schema in Phase 2.
    The in-game countdown still works via its own legacy key
    (`COUNTDOWN_SETTINGS_KEY`, mobile-ON/desktop-OFF default), independent of
    GameSettings — only the settings-page option was removed.
- Defaults: graphics preset `high` on desktop / `low` on mobile (via
  `window.matchMedia` + `navigator.deviceMemory` heuristic); null = "follow
  preset/default" for tri-state fields (maxPixelRatio, shadows, bloom*,
  smokeParticles, cameraDistance, cameraHeight). `shadows` defaults null →
  presets default shadows ON, so the game looks high-quality normally.
- Graphics preset model (Phase 2): `preset` ∈ {low,medium,high,custom}.
  `basePreset` always holds the last REAL preset (low/medium/high). Customizing
  ANY advanced slider/checkbox flips `preset='custom'` (keeping `basePreset`);
  returning all overrides to null snaps `preset` back to `basePreset`. The
  effective graphics = base of `basePreset` (when custom) or `preset`,
  overlaid with non-null overrides. See `normalizeGraphics()`. The override
  fields that count toward "custom" are: maxPixelRatio, smokeParticles,
  bloomStrength, bloomRadius, shadows (NOT shadowMapSize — it has no slider).
- `normalizeSettings()` clamps every field (e.g. bloom 0–0.1, recentGhostCount
  1–20, steerSmoothing 0.2–1, colorblindFilter ∈ off/protan/deutan/tritan).
  `shadowMapSize` is force-set to null (control removed). Unknown → fallback.
  `custom` preset accepted.
- API: `getSettings`, `saveSettings`, `patchSettings` (deep-merge + normalize +
  persist + applyLegacyKeys), `resetToDefaults`, `refresh`, `applyLive` (no-op
  unless the game loaded `window.__gameSettingsApplyLive`), `isSignedIn`,
  `getCloudStatus`, `saveSettingsToCloud`, `loadSettingsFromCloud`,
  `syncFromLegacy`, `clearLocalStorage`, `UNIFIED_KEY`.
- `syncFromLegacy()` (Phase 2 cloud-sync fix): pulls LIVE values the in-game
  controls (graphics buttons, audio sliders, FPS toggle, FX-ghost panel) wrote
  DIRECTLY to the legacy keys back into the unified slice. The in-game UI
  bypasses GameSettings, so without this the unified slice (and therefore the
  cloud save) goes stale. `saveSettingsToCloud()` AND main.js
  `getCurrentProfileSnapshot()` BOTH call `syncFromLegacy()` first → cloud
  always reflects the player's actual current state. Also called via the
  settings-page `storage` listener indirectly (legacy-key writes fire a
  unified-key write that the other tab picks up).
- `clearLocalStorage()` wipes every `racing-*` / `racingGame*` localStorage key
  (settings, coins, garage, campaign, ghosts, account session, mods, etc.).
  Returns the removed-key list. Used by the settings page Danger-zone button.
- Cloud sync: reads session token from `racing-account-session-v1`; sends the
  settings slice as `profile.settings` to the accounts worker
  (`POST /api/accounts/profile`); load merges server settings over local.
  IMPORTANT: the DEPLOYED live worker must be re-deployed (see
  `cloudflare-accounts/worker/`) for the new `custom`/`basePreset`/`showBestGhost`
  fields to survive sanitization — the old deployed build strips unknown fields.
- Tested by `test-gamesettings.mjs` (38 assertions: defaults incl. showBestGhost
  + no countdown + shadows-null, custom-preset behaviour, clamp, syncFromLegacy,
  clearLocalStorage, reset, cloud-status). The worker side is tested by
  `test-accounts-settings.mjs` (round-trip + sanitization + null + defaults +
  no-clobber of coins + custom/basePreset/showBestGhost).

### settings.html (`js/settings-page.js`)
- Sliders: null-capable sliders treat the leftmost (min) position as "auto"
  (null); the value label shows `data-null-text` ("auto"). Tri-state checkbox
  (shadows only — countdown was removed in Phase 2) CYCLES on click:
  auto(indeterminate) → on → off → auto.
- Graphics preset row has 4 buttons: Low / Medium / High / **Custom**. Custom is
  `disabled` until an advanced override exists; customizing ANY slider flips to
  `preset='custom'` (keeping the last real preset as `basePreset`) and lights up
  Custom. Clicking Low/Med/High resets ALL advanced overrides to null (auto) and
  sets `preset=basePreset=<that>`. A `#gfx-preset-status` line describes the
  current state. Moving all overrides back to auto snaps custom → base preset.
- `patchAndApply()` = `GameSettings.patchSettings(patch); GameSettings.applyLive();`
  on every control change → persists instantly + pushes to a running game.
- Cross-tab: `storage` event on `UNIFIED_KEY` → `GameSettings.refresh()` +
  re-sync UI (so changes made in the game's own graphics buttons update here).
- Cloud tab shows sign-in status from `getCloudStatus()`; Save/Load buttons call
  `saveSettingsToCloud()`/`loadSettingsFromCloud()` (Save now syncs from legacy
  first). Last-opened tab persists to `racing-settings-tab-v1`.
- Local data panel: Reset to defaults + Export JSON. A **Danger zone** section has
  a "Clear all local storage" button → `GameSettings.clearLocalStorage()` then
  reloads to `index.html`. Cloud saves are not affected.

### main.js integration (the live bridge)
- `import GameSettings from './GameSettings.js'` at top.
- `applyLiveGameSettings(settings)` (defined next to `applyGraphicsQuality`) is
  an ORCHESTRATOR that calls five per-subsystem helpers, each in its OWN
  try/catch: `applyGraphicsSettings`, `applyAudioSettings`, `applyCameraSettings`,
  `applyFpsSettings`, `applyGhostSettings`. The per-section isolation is critical:
  previously the whole body ran under one try/catch at the call site, so a throw
  in the graphics section (e.g. renderer/particles not ready during an early boot
  call) silently aborted the function BEFORE camera/audio/fps/ghost ran — the
  exact "setting doesn't take effect after reload" symptom. Now a failing section
  logs a console.warn and the rest still apply.
  - `applyGraphicsSettings`: effective preset = `{ ...GRAPHICS_QUALITY_PRESETS[presetKey] }`
    where `presetKey = (preset==='custom' ? basePreset : preset)`, overlaid with
    non-null advanced overrides + reduceMotion (forces bloom=0,
    weatherParticleScale=0), sets `cachedGraphicsPreset`, calls
    `applyGraphicsPresetToRenderer()` + `particles.setQuality()` +
    `setupWeatherFx()` + `updateGraphicsQualityUi()`.
  - `applyCameraSettings`: applies `cameraDistance/Height/Lag` to BOTH `cam` AND
    `cam2` (split-screen P2 previously ignored camera settings). Null values
    (auto/follow-preset) are skipped so defaults are preserved.
  - `applyFpsSettings`: `fpsHudVisible` + `updateFpsHudVisibility()` + legacy key.
  - `applyGhostSettings`: `showBestGhost` flag → hides `ghostModel` when false.
  - Countdown + recent-ghost rebuild persist for the next race (not toggled live).
- First-frame safety net: `animate()` re-calls `applyLiveGameSettings(
  GameSettings.getSettings() )` once on the first render frame
  (`settingsAppliedThisBoot` guard). The boot call runs before the first frame,
  but this re-apply catches any subsystem that was skipped because an engine
  dependency wasn't ready at boot time. Idempotent on a normal boot.
- In-game controls now write THROUGH GameSettings too (Phase 2 cloud-sync fix):
  `applyGraphicsQuality(save=true)` calls `GameSettings.patchSettings` with the
  preset + null overrides; the audio sliders + music select + FPS toggle + FX
  ghost panel handlers all `GameSettings.patchSettings(...)`. So the unified slice
  stays fresh even when the player uses the in-game UI rather than settings.html.
- At boot (right after `window.__gameAudio = audio`): `applyLiveGameSettings(
  GameSettings.getSettings() )` so settings.html changes take effect on load.
- `window.__gameSettingsApplyLive` exposed = the live-apply entry point the
  settings page's `applyLive()` calls. `storage` listener on `UNIFIED_KEY`
  re-applies live when another tab saves.
- Cloud profile: `getCurrentProfileSnapshot()` calls `GameSettings.syncFromLegacy()`
  FIRST then includes `settings: GameSettings.getSettings()`; `applyImportedProfile()`
  does `GameSettings.saveSettings(parsed.settings)` + `applyLiveGameSettings()` so
  a loaded cloud profile restores settings too.

### Accounts worker (`cloudflare-accounts/worker/src/index.js`)
- `sanitizeProfile()` now includes `settings: sanitizeSettings(profile.settings)`.
- `sanitizeSettings()` MIRRORS `GameSettings.normalizeSettings()` (same clamps +
  fallbacks + null handling) so settings round-trip through the cloud safely.
  Bad values are clamped, not rejected. Missing settings → full defaults object
  (never undefined). Sending only `settings` does NOT clobber coins/garage.
  Accepts `preset` ∈ {low,medium,high,custom}; `basePreset` defaults to preset
  (or high if preset is custom); `gameplay.showBestGhost` defaults true.
- Tested by `test-accounts-settings.mjs` (signup → save with settings →
  getProfile round-trip; clamp test; null round-trip; missing→defaults;
  coins-preserved-when-only-settings; custom/basePreset/showBestGhost).
- IMPORTANT: the DEPLOYED live worker must be re-deployed (`wrangler deploy` in
  `cloudflare-accounts/worker/`) for the new fields to survive sanitization.

### Per-section field reference
- graphics: preset (low/medium/high/custom), basePreset (low/medium/high),
  maxPixelRatio, shadows, bloomStrength, bloomRadius, smokeParticles (all
  nullable → follow preset; shadows defaults null → ON), shadowMapSize (ALWAYS
  null — control removed because it was broken; the field is force-set to null
  in normalizeGraphics + worker sanitizeSettings so it always follows the active
  preset's map size, i.e. "always normal"; kept in schema for a future re-enable),
  antialias (bool, needs reload), reduceMotion (bool, disables bloom+weather).
- audio: sfxVolume, musicVolume (0–1), musicMode (0–3).
- gameplay: showFps, showBestGhost (default true; toggles personal-best ghost
  rendering), recentGhostsEnabled, recentGhostCount (1–20),
  cameraDistance/cameraHeight (nullable), cameraLag (0.1–1), autoRespawn.
  (countdownEnabled was REMOVED from the settings schema in Phase 2.)
- controls: invertSteer, keyboardOnly, steerSmoothing (0.2–1). STILL in the
  schema but NO settings-page UI (Controls tab removed — fields not wired to
  the engine yet). Safe to re-add the tab later.
- accessibility: highContrastHud, largeHud, screenShake (default true),
  colorblindFilter (off/protan/deutan/tritan). STILL in the schema but NO
  settings-page UI (Accessibility tab removed — none of these are wired to the
  engine yet). Safe to re-add the tab later.
