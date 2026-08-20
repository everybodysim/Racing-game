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

## Car painter / Paint Shop (garage) — 3D click-to-fill (`js/main.js` + `index.html`)

### What it is now (simplified)
- A simple, new-player-friendly 3D painter. You **click a color directly on the
  3D car** in the viewer, the whole connected region of that color gets selected,
  you pick a new paint color, and Apply (300 coins). That's it — no tools, no
  brushes, no 2D sheet. Drag to rotate the car; a click (no drag) selects.
- The selection is **flood-filled** (4-neighbourhood, connected) using **redmean
  color distance** so it grabs one panel/region — NOT scattered chunks of similar
  color elsewhere (the old "only selects chunks" bug). Redmean also fixes the old
  "white selects everything" and "black is buggy" problems (perceptually weighted
  by redness, white/black no longer collapse onto every color).
- The live 3D preview shows the selected region in your chosen NEW color before
  you commit, so you see exactly how it'll look.
- Selections persist as compact RLE pixel masks per mapping, so repaints are
  region-accurate (the exact pixels you clicked-on's region, not a global re-match).

### History (why this exists)
- v1 (original): click 3D car → global color-distance re-match. Bugs: chunky
  selection (disconnected similar-color pixels), white grabbed everything, black
  grabbed nothing.
- v2 (over-engineered): 2D "paint sheet" + Wand/Brush/Eraser tools. Too complex
  for new players; too much freedom for inappropriate content.
- v3 (current): 3D click-to-fill. Keeps v2's flood-fill + redmean + RLE-mask
  infrastructure (which fixed the v1 bugs) but drives it from a single 3D click.
  No 2D sheet, no tool buttons, no brush.

### Layout (`index.html` `#garage-paint-studio`)
- 2-column grid: `#garage-paint-tools` (left, narrow ~280px) | `#garage-viewer-wrap`
  3D canvas (right, the PRIMARY interaction surface — click the car here).
- Controls (minimal): `#garage-target-color` (new paint color picker),
  `#garage-repaint-tolerance` range 4–180 ("Color match" slider, default 40),
  `#garage-clear-selection-btn`, `#garage-apply-paint-btn`, `#garage-selection-chip`
  (status), `#garage-mapping-status`, `#garage-mappings-list`.
- `#garage-viewer` is a `<canvas>` (WebGL). cursor:pointer; .dragging cursor:grabbing.

### Core functions (search `garageRedmeanDistanceSq` as the anchor)
- `garageRedmeanDistanceSq(r1,g1,b1,r2,g2,b2)`: perceptual color distance (redmean).
- `getGarageActiveTexture()`: finds the selected car model's first `material.map`.
- `ensureGarageSelectionSource()`: binds the selected car's colormap pixels to
  selection state (caches via `garageSelectionTexture`/`garageSelectionSource`);
  called from `updateGarageUi()`, `setModeTab('garage')`, `selectGarageCar()`,
  `garageSelectFromViewerClick()`. Re-binds on car switch; resets the mask.
- `getGarageViewerHit(event)`: raycasts the 3D viewer canvas → first mesh hit + uv.
- `sampleTextureHexAtUv(texture, uv)`: most-common color in a 3px radius around a
  UV (flipY-aware: v = texture.flipY ? 1-uv.y : uv.y). Used to be the main picker;
  now `garagePixelHex` (single pixel) is used for the seed, but this is kept.
- `garagePixelHex(x,y)`: hex of one texture pixel (image-data space, row 0 = top).
- `garageSelectFromViewerClick(event)`: THE entry point. raycast → uv → seed pixel
  → `garagePixelHex` → `garageFloodFill` → set `selectedGarageSourceHex` →
  `refreshGarageViewer()` (live preview in target color) → `updateGaragePaintControls()`.
- `garageFloodFill(x,y,tol)`: 4-neighbourhood flood-fill SEEDING a fresh mask (each
  click re-seeds — a new click replaces the selection). Redmean tolerance.
- `describeGarageSelection()`: returns `{hex, tolerance, count}` — most common
  selected color as sourceHex + derived tolerance for the global fallback.
- `encodeSelectionMaskRle`/`decodeSelectionMaskRle`: base64 RLE of [start,len]
  Uint32 runs. Local-only (NOT sent to ghosts/multiplayer).

### Click-vs-drag (`initGarageViewer`)
- pointerdown sets dragging=true, moved=false, records sx/sy.
- pointermove: if dragging, accumulates yaw; if |dx|+|dy|>4 sets moved=true.
- pointerup: dragging=false; if !moved (a click, not a drag) → `garageSelectFromViewerClick`.
  This is how a single click selects while a drag just rotates. Threshold 4px.

### State vars (near the garage state block ~line 4275)
- `garageSelectionMask` (Uint8Array over active texture pixels, 1=selected),
  `garageSelectionTexture`, `garageSelectionSource` ({width,height,data}).
- `selectedGarageSourceHex`/`hoveredGarageSourceHex` kept for legacy paths but
  `garageSelectionMask` is now the source of truth.
- REMOVED (v2 leftovers): garagePaintTool, garagePaintSheetCtx, garagePaintSheetImage,
  garagePaintDragging, garagePaintLastPx, garageBrushSize*, garageToolBtns,
  garagePaintSheetCanvas. Do NOT re-add — the 2D sheet is gone.

### Persistence & apply
- `normalizeGarageCosmetics()` preserves `mask` (RLE string), `maskW`, `maskH`
  per mapping. Max 48 mappings per car (unchanged).
- `buildResolvedMappings()` carries `mask/maskW/maskH/maskRle`; masks are lazily
  decoded + cached via `getResolvedMappingMask(mapping, total)`.
- `recolorTexture()`: prefers an EXACT region mask match over global color-distance.
  Ghost mappings have no mask → fall back to `pickMappedColor` (backward compat).
- `applyCarCustomizationToObject(root, carKey, highlightHex='', previewUnlit=false,
  hoverHex='', highlightTolerance, previewMask=null, previewTargetHex='')`:
  when previewMask + previewTargetHex set (live preview), folds the in-progress
  selection into a transient mapping so the 3D clone previews the repaint. The
  actual in-game vehicle call passes neither → persisted mappings only.
- Apply handler: derives `describeGarageSelection`, encodes the mask, upserts the
  mapping (matches existing by `mapping.mask` OR color proximity), charges 300
  coins, clears the in-progress mask, refreshes.

### init wiring
- `initGarageViewer()` called once at boot (creates the WebGL viewer + attaches
  pointer listeners including the click→select handler).
- `ensureGarageSelectionSource()` called from `updateGarageUi()` (after models
  load), `setModeTab('garage')`, `selectGarageCar()`, `garageSelectFromViewerClick()`,
  and the `?garage=1` boot. There is NO `initGaragePaintSheet` anymore (removed).

### What does NOT need changing
- Ghost/replay/multiplayer cosmetics: unchanged shape (sourceHex/targetHex/
  tolerance); masks are local-only. `buildResolvedMappingsFromGhostCosmetics`
  produces maskless mappings that fall back to color-distance.
- `GARAGE_REPAINT_COST` (300), `GARAGE_PAINT_PALETTE`, paint unlocks, coins.
- `getGarageTexturePalette()` is UNUSED (kept as harmless dead code).

## Garage vehicle-card mini 3D previews (`js/main.js` + `index.html`)

### What & why
- The garage car-selection cards used to show a `<dl>` of identical stats
  (speed/accel/handling/traction/topSpeed/power all uniform across cars because
  all packs are fixed at x1.15) plus an identical `x1.15` upgrade status — i.e.
  useless info. Replaced each card's stat block with a small **spinning 3D
  preview** of that car wearing its current paint, so the card grid is now a
  visual roster of the player's painted cars (the original user request).
- Each card now shows: the car name, a 72px-tall `<canvas class="garage-card-preview">`
  mini viewer, and a one-line meta row ("Paint maps: N", centered). The
  `garageUpgradeSummary()` "Handling x1.15 • Power x1.15 • Traction x1.15"
  line was REMOVED entirely (always-identical, useless) — the function itself
  was deleted; do not re-add it unless the upgrade packs become variable again.

### Implementation (ONE shared renderer for all cards, single rAF loop)
- `garageCardCanvasByKey` (carKey→canvas) is rebuilt by `renderGarageVehicleCards()`.
  `garageCardPreviews` (Map carKey→{scene,camera,carRoot,yaw,ctx2d}) holds each card's
  cheap scene graph — NO per-card WebGLRenderer.
- `garageCardSharedRenderer`: a SINGLE `THREE.WebGLRenderer` on one offscreen canvas
  (`alpha:true, preserveDrawingBuffer:true`) shared by ALL cards. Created lazily in
  `ensureGarageCardPreviews()`. Each card's canvas is a plain 2D canvas (`getContext('2d')`);
  the loop renders each card's scene to the shared renderer (resizing it to the card's px
  size), then blits `renderer.domElement` → card 2D canvas via `drawImage`. `preserveDrawingBuffer`
  is required for the drawImage readback. The cards still spin.
- WHY one shared renderer: the previous design made one WebGLRenderer PER card → 10 contexts
  (12 with main + paint viewer). Browsers cap ~16 WebGL contexts; under the memory churn of
  paint-apply the MAIN game renderer (oldest/largest) was dropped first → black screen. One
  shared context drops the total to 3 (main + viewer + 1 shared card renderer), eliminating
  the loss. This is the real fix for the "apply paint → black screen" bug.
- `ensureGarageCardPreviews()`: creates the shared renderer (once) + a scene/camera/carRoot
  per card that lacks one. Scene = ambient(3.0)+dir light; camera = PerspectiveCamera(34°,
  ...) at (0,0.85,3.5) — CLOSER than the paint viewer (z 5.2) per the "more zoomed in"
  request. Car clone added at rotation.y=π.
- `refreshGarageCardPreviewPaint(carKey)`: clears carRoot, re-clones `models[carKey]`,
  `applyCarCustomizationToObject(clone, carKey, '', true, '', tol, null, '')`
  (previewUnlit=true → MeshBasicMaterial, no selection preview → persisted paint only).
- `startGarageCardPreviews()`: ONE `requestAnimationFrame` loop ticks ALL previews
  (`yaw += 0.012` slow spin, re-render, drawImage blit). Guards: no-op if size 0 or no
  shared renderer; self-requeues only while previews exist. `stopGarageCardPreviews()` cancels
  the rAF.
- `disposeGarageCardPreviews()`: cancels loop + `disposeGarageCloneMaterials` each carRoot +
  clears the Map + `garageCardSharedRenderer.dispose()` (sets it back to null so it's recreated
  on next open). Called at the top of `renderGarageVehicleCards()` because `innerHTML=''`
  destroys the old canvases — the old 2D contexts are gone, so rebuild rebinds to fresh ones.

### Lifecycle / when it runs (avoid idle WebGL contexts at boot)
- The shared renderer + scenes are created LAZILY, only when the garage tab is actually
  visible — NOT at boot. `renderGarageVehicleCards()` only builds the card DOM + canvases; it
  does NOT create the renderer. `activateGarageCardPreviews()` (ensureGarageCardPreviews +
  refreshGarageCardPreviewsPaint + startGarageCardPreviews) is the entry point and is called
  from `setModeTab('garage')` and `setModeMenuOpen(true)` ONLY when `modeTab==='garage' &&
  modeMenuOpen`. Closing the menu / switching tabs calls `disposeGarageCardPreviews()` (drops
  the shared renderer + clones → 0 card WebGL resources while closed).
- A new module-level `modeTab` (default 'gameplay') tracks the active tab; set inside
  `setModeTab()`. `setModeMenuOpen` reads `modeTab` to decide activate/dispose.
- Context count while the garage is open: main game renderer + paint viewer + 1 shared card
  renderer = 3 (was 12). The game is paused behind the modal, so the cost is bounded.

### Keep paint in sync
- The Apply-paint handler calls `refreshGarageCardPreviewPaint(carKey)` +
  `updateGarageCardMeta(carKey)` so the just-painted car's card updates its preview
  and its "Paint maps: N" count immediately (no full re-render of all cards).

### Clicking a card must NOT rebuild the grid (the "cars disappear" bug)
- `selectGarageCar()` toggles the `.active` outline via `updateGarageCardActiveState()`
  (querySelectorAll cards, compare `card.dataset.carKey` to the selected key) — it does
  NOT call `renderGarageVehicleCards()`. A full rebuild would run
  `disposeGarageCardPreviews()` (because `innerHTML=''` destroys the canvases) and, on
  the click path, the renderers are NOT recreated → every preview goes blank.
- `renderGarageVehicleCards()` is only for genuine rebuilds (boot, paint-apply refresh
  of the grid). It sets `button.dataset.carKey` so `updateGarageCardActiveState` can
  match, and calls `activateGarageCardPreviews()` when the garage is visible so a
  rebuild (re)creates the renderers for the fresh canvases.
- Do NOT re-add a `renderGarageCardPreviews()` call inside `selectGarageCar()`.

### GPU-memory leak + WebGL context loss (the "apply paint → black screen" bug)
- Symptom: sometimes applying paint made the whole 3D canvas go black while the HTML UI
  kept running. That's WebGL context loss on the MAIN game renderer, caused by GPU-memory
  pressure from leaked textures.
- Root leak: `applyCarCustomizationToObject` builds fresh materials (with per-mapping
  `CanvasTexture` maps) and stashes them on `mesh.userData.customMaterial`. The garage
  viewer (`refreshGarageViewer`) and card previews (`refreshGarageCardPreviewPaint`) throw
  the whole clone away with `carRoot.clear()` — which only UNLINKS children; it does NOT
  dispose those materials/textures. WebGL resources are NOT auto-freed by JS GC, so every
  refresh leaked one `CanvasTexture` + material per mesh. Over a paint session the pressure
  tripped context loss on the main (largest) renderer.
- Fix layer 1 (stop the leak): `disposeGarageCloneMaterials(root)` traverses a clone and
  disposes each `userData.customMaterial` + its `.map` (only when the map isn't the shared
  base GLB texture). Called BEFORE `carRoot.clear()` in `refreshGarageViewer`,
  `refreshGarageCardPreviewPaint`, and `disposeGarageCardPreviews`. The LIVE in-game
  vehicle does NOT leak (it's the same object re-applied; `applyCarCustomizationToObject`
  disposes its own previous customMaterial in place).
- Fix layer 2 (cut context count — the decisive fix): the previous design created one
  WebGLRenderer PER card → 10 contexts (12 with main + viewer). That alone tripped context
  loss on paint-apply. Now ALL card previews share ONE `garageCardSharedRenderer`
  (see "Implementation" above): total contexts while open = 3 (main + viewer + 1 shared card
  renderer). `disposeGarageCardPreviews()` (called on menu close / tab switch / grid rebuild)
  fully disposes the shared renderer + clones → 0 card WebGL resources while closed. They're
  recreated lazily on reopen (`ensureGarageCardPreviews`). `setModeMenuOpen(false)` and
  `setModeTab(non-garage)` both call `disposeGarageCardPreviews()`.
- NOTE: do NOT add a `webglcontextlost` → `window.location.reload()` handler. It was tried
  and it fired proactively during normal painting, reloading the page mid-paint and making
  the garage unusable. The leak fix (layer 1) + context reduction (layer 2) are the correct
  fix; if a loss ever still occurs the player can refresh manually.

### CSS (`index.html`)
- `.garage-card-preview`: 100% width × 72px, radius 8, bg `#0e1622` (shows behind
  transparent WebGL alpha before first frame / if context lost), `touch-action:none`.
- `.garage-vehicle-meta`: centered single-line "Paint maps: N" (blue).
- The old `.garage-vehicle-card dl/dt/dd` and `.garage-vehicle-status` rules were
  removed (no longer emitted by `renderGarageVehicleCards`).

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

## Embedded / CrazyGames navigation (`js/PageTransitions.js`)

### What it is
- CrazyGames (and itch.io / other game portals) load the game inside an iframe.
  Opening the game in a new tab from inside that iframe escapes the portal
  (the player ends up on the raw game URL outside CrazyGames). So when the game
  detects it is embedded, every same-origin game-page navigation is redirected
  to the CURRENT tab (replace, not new tab). Standalone gameplay is unchanged.

### Detection
- `isEmbedded = (window.self !== window.top)` (try/catch — cross-origin parent
  access throws, which is treated as embedded). This is the CrazyGames iframe
  signal; there is no CrazyGames SDK loaded. Exposed as `window.SkidNav.isEmbedded`.
- Logic lives in `js/PageTransitions.js`, which is ALREADY loaded in `<head>` of
  every page (campaign/clubs/coins/competitions/custommods/editor/index/itchdemo/
  mods/official-tracks/replay/settings/share/tas-viewer/totd/tracks/weekly-cup).
  So NO per-page edits are required — one file, one script tag per page already
  present.

### Behavior when embedded (iframe)
- `window.open` is monkey-patched: if the url is a same-origin http(s)/relative
  game page (share.html, replay.html, track play URLs, editor.html, etc.) it is
  redirected to `window.location.href` (same-tab, via the fade transition) and
  returns `null`. Callers that do `if (!tab) return;` (main.js share/replay
  exporters) simply stop after the redirect — fine.
- Content URLs that are NOT game pages are left as real popups: `blob:`,
  `data:`, `about:blank`, `mailto:`, `tel:`, `javascript:`, and external
  http(s) origins. This preserves: the VideoRecorder's open-recording-in-new-tab
  (blob:), the raw-ghost-code `about:blank` document.write popup, and external
  links.
- `<a target="_blank">` clicks: same-origin relative links are converted to
  same-tab fade navigation; external `target="_blank"` links keep native
  new-tab behavior. (All in-repo `target="_blank"` play links — tracks.html,
  official-tracks.html, weekly-cup.html, share.html — are same-origin
  relative, so they convert.)
- Plain same-origin `<a>` (no target) clicks keep the existing fade-transition
  same-tab behavior (unchanged).

### Behavior when standalone (not in iframe) — UNCHANGED
- `window.open` is NOT patched (native). All `window.open(..., '_blank')` calls
  open real new tabs exactly as before. `target="_blank"` links open new tabs.
  This is normal gameplay / the GitHub-pages standalone deployment.

### URL classifier
- `isSameOriginPageUrl(raw)`: false for empty/`#`/mailto/tel/javascript/blob/
  data/about; otherwise resolves via `new URL(raw, location.href)` and returns
  true only for http/https with `origin === location.origin`. Exposed as
  `window.SkidNav.isSameOriginPageUrl`. `window.SkidNav.open(url,target,features)`
  is a thin pass-through to the (possibly patched) `window.open`.

### Why NOT to edit individual call sites
- The `window.open` patch + click handler cover ALL current call sites
  (main.js, VideoRecorder.js, replay.html, totd.html, editor.html, tracks.html,
  + all `<a target="_blank">`) without touching them, and automatically cover
  future ones. Only PageTransitions.js needs to change if the policy changes.



## Mobile devices hard-blocked (`index.html` early script + `js/main.js`)

### What it is
- Mobile devices get a full-screen `#mobile-block-overlay` ("Sorry, this game
  does not currently support mobile.") shown immediately on page load, and the
  game loop is hard-paused behind it. The game still boots (loading screen runs
  underneath), but `animate()` never advances gameplay.

### Detection (UA-ONLY — never misdetects desktop/Chromebook)
- The early inline IIFE at the top of `<body>` checks ONLY the user agent:
  mobile tokens (Android/webOS/iPhone/iPod/BlackBerry/IEMobile/Opera Mini|Mobi/
  Windows Phone/Mobile), explicitly excluding `CrOS` (Chromebooks), PLUS the
  iPadOS-13+ masquerade (`navigator.platform === 'MacIntel' && maxTouchPoints > 1`
  — no touchscreen Mac exists, so no Mac false-positive).
- Deliberately NO screen-size, touch, or `pointer: coarse` checks — those would
  hit touchscreen laptops, small desktop windows, and narrow iframes.
- On match it sets `window.__mobileUnsupported = true` and adds
  `html.mobile-blocked` (which displays `#mobile-block-overlay`, z-index 999999).
- Test override: `?block-mobile-test=1` URL param forces the block on desktop.

### Pause wiring
- `js/main.js` `animate()`: the paused branch reads
  `if ( paused || window.__mobileUnsupported )` — a hard gate that works even in
  multiplayer/split-screen/replay (where `setPaused` is disallowed).

## Mobile UI force-disabled (temporary — standard layout everywhere)

### What & why
- The game was switching to the mobile UI (vertical home, mobile action dock,
  hidden desktop buttons, mobile menu sheet) when run inside a narrow CrazyGames
  iframe (small screen / touch detection). The user wants the standard (desktop)
  layout locked everywhere for now; the mobile-switching logic will be
  re-evaluated later.

### How it's disabled (`index.html` only — no JS/CSS file changes)
The mobile UI had two independent triggers; BOTH are neutralized:
1. **`body.mobile` class** — never added. The old early detection IIFE was
   REPLACED by the mobile-block IIFE (see "Mobile devices hard-blocked" above),
   which only adds `html.mobile-blocked`. Every `body.mobile ...` CSS rule is
   therefore inert.
2. **`@media (pointer: coarse)` blocks** — two CSS blocks (one for the
   mobile-actions-menu/positioning, one for the mobile-action-dock/menu-sheet +
   repositioned HUD) that fired on touch devices regardless of the `mobile`
   class. Both media queries are changed from `@media (pointer: coarse) {` to
   `@media (pointer: coarse) and (pointer: fine) {` — an impossible query (a
   pointer can't be both coarse AND fine), so the blocks never apply. An inline
   comment on each line explains the revert.

### What is NOT changed
- The existing "Force the normal (desktop) main-menu layout in ALL cases" block
  (CSS near `body.mobile #home-body`) stays — it keeps the two-column home from
  collapsing on narrow screens even if `body.mobile` were re-enabled.
- **Touch input overlay** (`js/Controls.js` `setupTouchUI()`): still shows on
  touch devices (`matchMedia('(pointer: coarse)')`). This is gameplay INPUT, not
  the "mobile UI" layout, and is needed to play on a touch device. Left as-is.
- `isMobileUi()` (`index.html` ~line 2904) still reads `mobileQuery.matches`
  (pointer: coarse) — its mobile-menu/leaderboard handlers still run on touch,
  but the elements they toggle (`#mobile-action-dock`, `#mobile-menu-sheet`,
  `.mobile-open`) are hidden by the disabled `@media` blocks, so there's no
  visible effect. No breakage.
- `countdownEnabled` default in main.js reads `body.mobile`/`pointer: coarse`;
  with `body.mobile` never set it defaults OFF on desktop (unchanged) and still
  ON on touch (because `pointer: coarse` matches). Acceptable.

### To re-enable mobile UI later
1. In the detection IIFE: remove the early `return;` (restore the `add('mobile')`
   lines).
2. Revert both `@media (pointer: coarse) and (pointer: fine) {` back to
   `@media (pointer: coarse) {` (drop the `and (pointer: fine)` + comment).
3. Optionally remove the now-redundant "Force the normal desktop main-menu" block
   if the mobile layout should fully take over again.

### Verified
- Narrow iframe sim (420x300, CrazyGames-like): mobile chrome
  (`#mobile-action-dock`, `#mobile-menu-sheet`, `#mobile-actions-menu`,
  `#mobile-leaderboard-close`) is hidden; all desktop buttons (`#editor-link`,
  `#totd-link`, `#tracks-link`, `#mods-link`, etc.) are visible; home shows the
  two-column desktop layout with the community sidebar.
- Normal desktop load: home page renders identically to before (full desktop
  layout, all buttons). No regressions.
- CSS braces balanced (519/519 excl. comments); detection IIFE braces balanced.


## Public multiplayer servers (`js/PublicServers.js` + `js/main.js` + `index.html`)

### What it is
- 3 fixed public servers in the multiplayer widget (`#mp-panel`): **Server 1**
  (`server-1`, code `PUBSV1`), **Server 2** (`server-2`, code `PUBSV2`),
  **Server 3** (`server-3`, code `PUBSV3`). They are NOT locational — they're
  just 3 parallel PeerJS rooms so players can spread out if one is full. Anyone
  can join; they see everyone else on the same server.
- There is NO round timer, NO rankings overlay, NO deterministic track rotation,
  and NO backend worker. A public server is a bare-minimum PeerJS (WebRTC) mesh:
  the buttons join you into the server with everyone else, and the host tells
  joiners which map everyone is on (MAP_SYNC) so you redirect onto it. That's it.
- The **crucial new feature** is a map-vote UI that appears in the multiplayer
  panel when you're in a server: a text input + a "Select track" button. A player
  pastes a track URL and submits; their game searches the track share board for
  the URL and gets the name. Then on EVERYONE's screen a bottom-of-screen prompt
  appears ("Switch map?" + the track name + Yes/No buttons) that updates in real
  time showing how many voted Yes/No. After 30s (counted on the initiator's
  device) the UI hides for everyone and the votes are tallied; if >60% are "yes"
  (with at least one vote) the track is switched — the initiator's game redirects
  first and sends a VOTE_RESULT signal to move everyone else over too.
- **Normal multiplayer with host/join codes is UNCHANGED.** All public-server code
  is gated behind `isPublicServerActive()` (only true after `joinPublicServer`,
  via the buttons or the `?pubServer=` boot param). No `pubServer` param = no
  public-server code runs at all.

### Architecture (PeerJS / WebRTC mesh only — no backend worker)
- PeerJS connects players over WebRTC. `peerConfig` includes a TURN server, so
  the connection works even through symmetric NATs. There is NO Cloudflare
  servers worker on the public-servers path: **public servers make ZERO calls
  to `racing-servers-api`**. The old `cloudflare-servers/worker` is kept only for
  history (see the STATUS notice in `cloudflare-servers/README.md`); it can be
  deleted/disabled. **No worker redeploy is required** — it's a client-side
  change.
- The only network dependency is the **read-only** track share board
  (`cloudflare/worker`, `GET /api/tracks`), used by the vote to look up a pasted
  track URL's name (`fetchTrackList` + `findTrackByPlayUrl`). Zero KV writes.
- Host election is PeerJS-native: the first player to claim the
  `RACE-ROOM-<code>` peer id becomes the host; joiners connect to it. If the host
  disappears, a joiner detects the dead connection and reclaims the id
  (self-healing, via `maintainPublicServerPeer` + `maybeReclaimPublicServerHost`).
- The "host" role grants NO in-game privileges — it is hidden from the UI and
  gates nothing except: acting as the PeerJS relay (so all peers see each other)
  and sending the MAP_SYNC packet (so joiners load the right map). Do NOT add any
  `if (publicServerState.isHost)` gate that affects gameplay/visibility.

### Join / map sync (host tells joiners which map everyone is on)
- `joinPublicServer(serverId)` leaves any session, sets the roomCode to the
  fixed server code, and `startPublicServerPeer(code)` tries to claim the
  `RACE-ROOM-<code>` peer id. If PeerJS fires `unavailable-id` (someone else owns
  it) the client becomes a joiner (connects via `applyPublicServerRoleToConnections`
  → `startPeerMultiplayer(code,'join')`); 6s safety timeout falls back to joiner.
- When a joiner connects, the host sends a `PEER_PACKET_MAP_SYNC` with its
  current `mapSignature` (from `getCurrentMapSignature()`) — see
  `broadcastPublicServerMapSync` (called from `registerPeerConnection` on the
  host side). The joiner's `onPublicServerMapSync` calls
  `redirectPublicServerToMap(sig,'host')`, which redirects (rejoining via
  `?pubServer=<id>&play=1&map=...`) if the signature differs from the map they're
  on.
- Anti-loop: after a redirect the page reloads on the host's map, so
  `sig === getCurrentMapSignature()` → no re-redirect. A sessionStorage flag
  (`pubsrv_loaded_map`, via `getLoadedPublicServerMapFromStorage` /
  `setLoadedPublicServerMapInStorage` / `clearLoadedPublicServerMapFromStorage`)
  is a belt-and-braces guard against re-redirecting.
- `buildServerTrackRedirectUrl(playUrl, serverId)` (PublicServers.js) extracts
  ONLY `map`+`mods` from the playUrl and applies them to the CURRENT page's
  pathname (`window.location.pathname`) + adds `?pubServer=<id>&play=1`. It does
  NOT use the playUrl's origin/pathname (that path doesn't exist on other
  deployments → 404). It filters `mods=none`. This is the same redirect builder
  the vote uses.
- Leave: `leavePublicServer()` tears down the PeerJS peer (the LEFT packet + peer
  destroy handle departure; if we were host a surviving joiner's maintenance loop
  reclaims the id). `?pubServer=<id>` on the redirect URL re-joins the same server
  on the new map.

### Map vote (the new feature)
- **UI** (`index.html`): `#mp-pubtrack-row` (input `#mp-pubtrack-input` + button
  `#mp-pubtrack-btn` "Select track") inside `#mp-panel`, shown only while on a
  public server (toggled to `display:flex`/`none` by
  `updatePublicServerButtonStates`). `#mp-vote-prompt` is a fixed bottom-of-screen
  overlay (`z-index: 258`, `display:none` → `.visible { display:flex }`) with
  `#mp-vote-title` ("Switch map?"), `#mp-vote-track-name`, Yes/No buttons
  (`#mp-vote-yes`/`#mp-vote-no`), and live counts (`#mp-vote-yes-count`/
  `#mp-vote-no-count`).
- **Packets** (main.js, defined near the other `PEER_PACKET_*` constants):
  - `PEER_PACKET_MAP_SYNC` — host → joiner: `{type, playerId, mapSignature}`.
  - `PEER_PACKET_VOTE_START` — initiator → all: `{type, playerId, voteId, playUrl,
    trackName, initiatorId, startedAt}`.
  - `PEER_PACKET_VOTE` — any voter → all: `{type, playerId, voteId, vote:'yes'|'no'}`.
  - `PEER_PACKET_VOTE_RESULT` — initiator → all: `{type, playerId, voteId,
    passed:bool, playUrl, trackName}`.
  - The host relays every packet (in `relayHostPacket`) so indirectly-connected
    peers also receive it. `handlePeerPacket` dispatches each type.
- **Flow** (in `main.js`, the `publicServerVoteState` block):
  1. A player pastes a URL + clicks "Select track" → `startPublicServerVoteFromInput`
     → `getCachedPublicServerTrackList()` (60s-cached `fetchTrackList`) →
     `findTrackByPlayUrl(rawUrl, list)` (PublicServers.js) finds the track + name.
  2. `startPublicServerVote(playUrl, trackName)` records the vote locally
     (`publicServerVoteState`), auto-votes "yes" for the initiator, broadcasts
     `PEER_PACKET_VOTE_START`, shows the prompt, and starts the authoritative
     30s timer on the initiator's device (`PUBLIC_SERVER_VOTE_DURATION_MS` 30000).
  3. Peers' `onPublicServerVoteStart` shows the prompt + starts a fallback timeout
     (the vote duration + slack) in case the initiator's VOTE_RESULT never
     arrives. A new VOTE_START while one is active is ignored (the existing one
     wins). Only ONE vote is active at a time per server.
  4. Each `castPublicServerVote('yes'|'no')` records the vote, updates the live
     counts via `updatePublicServerVoteCounts`, and broadcasts
     `PEER_PACKET_VOTE`. `onPublicServerVote` records peers' votes + refreshes
     counts. Your own vote disables its button so you can't vote twice.
  5. After 30s the initiator's `endPublicServerVote(true)` tallies
     (`tallyPublicServerVotes`): passes if `total > 0 && (yes/total) >
     PUBLIC_SERVER_VOTE_PASS_RATIO (0.60)` — strictly more than 60% yes. It
     broadcasts `PEER_PACKET_VOTE_RESULT` (passed + playUrl + trackName). If
     passed, the **initiator redirects first** (`redirectPublicServerToTrack`),
     which rejoins the server on the new map. Hides the prompt locally.
  6. Peers' `onPublicServerVoteResult` (ignoring their own looped-back result):
     if passed, redirect to the track; hide the prompt. So the vote result
     "moves everyone else over" via the VOTE_RESULT signal — the initiator's
     redirect is the trigger and the packet is the follow signal.
- **Vote prompt DOM helpers**: `showPublicServerVotePrompt` /
  `hidePublicServerVotePrompt` / `updatePublicServerVoteCounts` (writes the
  Yes/No counts + disables the button matching our cast vote).
- `resetPublicServerVoteState()` clears the timers + state; called on join,
  leave, and after a vote ends.

### Client module (`js/PublicServers.js`) — simplified
- `PUBLIC_SERVERS` = 3 fixed servers. `findPublicServer(id)`,
  `isPublicServerConfigured()` (always true — no backend needed).
- `fetchTrackList()` → GETs the track board (`{ ok, entries:[{...,playUrl}] }`),
  sorted by a stable key, via `fetchTrackBoardWithRetry` (retries the flaky 503/
  error-1102 worker — a 503 carries NO CORS headers so the browser surfaces it as
  a `TypeError: Failed to fetch`; the helper catches the throw, not just status).
- `findTrackByPlayUrl(url, trackList)` → matches by `map`+`mods` query params
  (order-independent, hash-ignored) and returns `{ name (trimmed; 'Shared track'
  fallback), playUrl }`, or null. This is the vote's board lookup.
- `mapSignatureFromPlayUrl(url)` → `"map|mods"` (defaults `default`/`none`).
- `buildServerTrackRedirectUrl(playUrl, serverId)` → same-tab URL adding
  `?pubServer=<id>&play=1` on the CURRENT page's pathname. Filters `mods=none`.
- REMOVED (no longer exported): `cycleInfo`, `ROUND_EPOCH`, `CYCLE_MS`,
  `PLAY_DURATION_MS`, `RANKINGS_WINDOW_MS`, `pickTrackForCycle`,
  `fetchRandomTrackPlayUrl`, `SERVERS_API_BASE`, `fetchServerState`,
  `joinServer`, `claimServerHost`, `heartbeatServer`, `submitServerLap`,
  `setServerTrack`, `leaveServer`. Do NOT re-add — public servers no longer use
  the racing-servers-api worker or the round/rotation/rankings model.

### main.js integration (the bits that changed)
- `publicServerState` block (next to `multiplayerSessionState`): `active`,
  `serverId`, `isHost` (hidden; no privileges), `claimedHost`,
  `peerMaintainTimer`, `hostClaimInFlight`, `trackListCache`/`trackListCacheAt`,
  `loadedMapSignature` (anti-loop guard). MUCH smaller than before (no
  round/timer/rankings/lap/meta/cycle/resolve fields).
- `publicServerVoteState` block: `active`, `voteId`, `playUrl`, `trackName`,
  `initiatorId`, `ourVote`, `votes`, `isInitiator`, `endsAt`, `timer`,
  `fallbackTimer`.
- `PUBSRV_LOADED_MAP_KEY` (`pubsrv_loaded_map`, sessionStorage) +
  `getLoadedPublicServerMapFromStorage` / `setLoadedPublicServerMapInStorage` /
  `clearLoadedPublicServerMapFromStorage` (replaces the old
  `PUBSRV_LOADED_ROUND_KEY` round-tracking).
- `isPublicServerActive()`, `publicServerRoomCode()`, `publicServerName()`.
- `buildPublicServerButtons()` fills `#mp-public-buttons` + wires the Leave
  button, the `#mp-pubtrack-btn`, and the vote Yes/No buttons. Called from
  `initMultiplayerPanel()` BEFORE the Firebase-config early-return.
- `updatePublicServerButtonStates()` toggles the server buttons + Leave button +
  `#mp-pubtrack-row` visibility.
- `joinPublicServer` / `leavePublicServer` / `resetPublicServerState` /
  `stopPublicServerMaintainLoop` (one 10s maintenance loop, replacing the old
  round/tick/visibility loops).
- `startPublicServerPeer` / `applyPublicServerRoleToConnections` /
  `maintainPublicServerPeer` / `maybeReclaimPublicServerHost` (PeerJS-native host
  election + self-healing).
- `broadcastPublicServerMapSync` / `onPublicServerMapSync` /
  `redirectPublicServerToMap` / `redirectPublicServerToTrack` (map sync +
  redirect; redirect builder is in PublicServers.js).
- The vote feature: `startPublicServerVoteFromInput` /
  `getCachedPublicServerTrackList` / `startPublicServerVote` /
  `onPublicServerVoteStart` / `castPublicServerVote` / `onPublicServerVote` /
  `endPublicServerVote` / `onPublicServerVoteResult` / `tallyPublicServerVotes` /
  `sendPublicServerPacket` + the DOM helpers.
- `handlePeerPacket` handles MAP_SYNC / VOTE_START / VOTE / VOTE_RESULT (alongside
  STATE/LEFT). `registerPeerConnection` sends MAP_SYNC from the host side on
  joiner connect.
- `publishMultiplayerBestLap` is a no-op on public servers (there's no
  private-room lap store); a world record still submits to the OFFICIAL
  leaderboard via the `isNewBest` → `submitLeaderboardTime` path in the
  lap-finish handler (independent of this). Private rooms keep the Firebase write.
- `beforeunload` → on a public server, no Firebase leave fetch (PeerJS LEFT +
  peer destroy handle it); on a private room, the Firebase presence clear runs.
- `hostRotateRoomCode()` early-returns when `isPublicServerActive()` (public
  servers use the fixed code + vote-driven map changes, not room-code rotation).
- `?pubServer=<id>` param → auto-join on boot (handled before the Firebase
  early-return; works without Firebase).

### What was deliberately removed (do not re-add)
- The 5-minute round timer, the `cycleInfo`/`ROUND_EPOCH`/`CYCLE_MS` wall-clock
  math, the `tickPublicServerRound`/`tickPublicServerTimer` loops, the
  `#mp-server-timer` countdown widget, the rankings overlay
  (`#mp-server-rankings` + `renderPublicServerRankings` +
  `updatePublicServerRankingsVisibility` + `collectPublicServerRoundLaps`), the
  P2P lap packets (`PEER_PACKET_LAP`/`broadcastPublicServerLap`/
  `ingestPublicServerPeerLap`) + META packets (`PEER_PACKET_META`/
  `broadcastPublicServerMeta`/`ingestPublicServerPeerMeta`), the member-count
  helper (`computePublicServerMemberCount`), the deterministic track picker
  (`pickTrackForCycle` + `ensureTrackForCycle` + `getCachedTrackList` +
  `resolvedTracksByCycle`), and the `loadedRoundId`/`pubsrv_loaded_round`
  round-tracking. Public servers are now a minimal join + map-sync + vote model.

### Tests
- `test-public-server-vote.mjs`: `findTrackByPlayUrl` (match by map+mods
  ignoring hash/order, null on no-match/empty, blank-name → "Shared track"
  fallback), `mapSignatureFromPlayUrl` (defaults), `buildServerTrackRedirectUrl`
  (uses current pathname, carries map+mods+pubServer+play, filters mods=none,
  no playUrl origin), and the vote tally pass-gate math (>60% yes strictly, >=1
  vote, initiator-alone passes). 27 assertions. (The old
  `test-public-servers-fixes.mjs` / `test-pubsrv-logic.mjs` /
  `test-pubsrv-round-flow.mjs` tested the removed round/rotation/rankings model
  and were deleted.)
