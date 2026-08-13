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
