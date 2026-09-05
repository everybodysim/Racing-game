// Bug-blitz regression suite (v2).
//
// Static source checks for the eight-fix pass:
//   1. Water waves backed off 0.17 → 0.15 (crests no longer clip through grass)
//   2. Minap mirrored: rotate(headingAngle) + scale(-1, 1) so turns read correctly
//   3. Profile auto-saves to the accounts backend every 5 minutes + top message
//   4. Editor elevated blocks render double-sided (no vanishing faces/shadows)
//   5. Skybox follows the CAMERA (freecam sanity), not the vehicle
//   6. Surfaces/pads lie flush with slope ramps (game + editor + slope-down midpoint)
//   7. Custom pool colors: checkbox-gated (colorsOn, OFF by default) + vivid in-game
//   8. Garage: no per-card 3D previews, mask find() fix, no global wash for masked
//      mappings, storage budget trim, and the Default Car dropdown
//
// Run: node test-bug-blitz.mjs

import { readFileSync } from 'node:fs';

const track = readFileSync( './js/Track.js', 'utf8' );
const main = readFileSync( './js/main.js', 'utf8' );
const hud = readFileSync( './js/HudExtras.js', 'utf8' );
const html = readFileSync( './index.html', 'utf8' );
const worker = readFileSync( './cloudflare-accounts/worker/src/index.js', 'utf8' );
const editor = readFileSync( './editor.html', 'utf8' );

let passed = 0, failed = 0;
function test( name, cond ) {

	if ( cond ) { passed++; console.log( `  ✓ ${ name }` ); }
	else { failed++; console.error( `  ✗ ${ name }` ); }

}

console.log( '1. Water waves (3x, backed off from the grass-clipping 3.4x)' );
test( 'waveHeight is CELL_RAW * 0.15', /waveHeight: \{ value: CELL_RAW \* 0\.15 \}/.test( track ) );
test( '0.17 wave scale is gone', !track.includes( 'CELL_RAW * 0.17' ) );

console.log( '\n2. Minimap mirroring' );
test( 'rotates by +headingAngle (not -headingAngle)', /ctx\.rotate\( headingAngle \);/.test( hud ) );
test( 'mirrors horizontally with ctx.scale( -1, 1 )', /ctx\.scale\( -1, 1 \);/.test( hud ) );
test( 'mirror happens after the rotation', hud.indexOf( 'ctx.rotate( headingAngle );' ) < hud.indexOf( 'ctx.scale( -1, 1 );' ) );
test( 'old inverted rotation removed', !hud.includes( 'ctx.rotate( -headingAngle );' ) );

console.log( '\n3. Profile auto-save (accounts backend)' );
test( '5-minute auto-save interval (300000 ms)', main.includes( '}, 300000 );' ) && main.includes( 'Profile auto-save failed' ) );
test( 'auto-save posts to /profile with the session token', /method: 'POST',[\s\S]{0,220}body: JSON\.stringify\( \{ token: accountSession\.token, profile: getCurrentProfileSnapshot\(\) \} \)/.test( main ) );
test( 'successful auto-save shows a top message', main.includes( "showTopMessage( 'Profile auto-saved to the cloud'" ) );
test( 'debounced cloud sync helper exists for setting changes', main.includes( 'function syncProfileToCloudDebounced()' ) );

console.log( '\n4. Editor: double-sided elevated blocks' );
test( 'elevated traverse sets THREE.DoubleSide', /elevated\.traverse[\s\S]{0,900}m\.side = THREE\.DoubleSide;/.test( editor ) );
test( 'double-sided guard prevents repeat mutation', editor.includes( 'm.__doubleSided = true;' ) );

console.log( '\n5. Skybox follows the camera' );
test( 'skyGroup tracks cam.camera x/z', /skyGroup\.position\.set\( cam\.camera\.position\.x, 0, cam\.camera\.position\.z \);/.test( main ) );
test( 'no longer tracks the vehicle container', !main.includes( 'skyGroup.position.set( vehicle.container.position.x' ) );

console.log( '\n6. Slope-matched surfaces and pads' );
test( 'game: surface patches tilt flush with slope ramps', /elevatedEntry && elevatedEntry\.type === 'slope-up'[\s\S]{0,420}Math\.atan2\( ELEVATED_HEIGHT, CELL_RAW \)/.test( track ) );
test( 'game: tilt uses the cell\'s own elevated entry (off-grid safe)', /const elevatedEntry = elevatedMap\.get\( `\$\{ gx \},\$\{ gz \}` \);/.test( track ) );
test( 'editor: patch loop tilts for slope-up AND slope-down', /cell\.elevatedType === 'slope-up' \|\| cell\.elevatedType === 'slope-down'[\s\S]{0,520}Math\.atan2\( ELEVATED_HEIGHT, CELL_RAW \)/.test( editor ) );
test( 'editor: slope-down orient normalized via ORIENT_180', /cell\.elevatedType === 'slope-down'\s*\?\s*\( ORIENT_180\[ cell\.elevatedOrient \|\| 0 \]/.test( editor ) );
test( 'editor: slope-down overlay midpoint is half height', /if \( cell\.elevatedType === 'slope-up' \|\| cell\.elevatedType === 'slope-down' \) return ELEVATED_HEIGHT \* 0\.5;/.test( editor ) );

console.log( '\n7. Custom pool colors (checkbox-gated, vivid in-game)' );
test( 'game: colors only apply when colorsOn === true', /const colorsOn = cfg\.colorsOn === true;[\s\S]{0,260}waterColor: colorsOn && isHex\( cfg\.waterColor \)/.test( track ) );
test( 'game: isCustom flag drives vividness', track.includes( 'isCustom: colorsOn' ) );
test( 'game: custom pools saturate x1.5 + clamp lightness', /Math\.min\( 1, hsl\.s \* 1\.5 \), THREE\.MathUtils\.clamp\( hsl\.l, 0\.34, 0\.62 \)/.test( track ) );
test( 'game: custom pools skip the deep-navy drown (0.12 vs 0.6)', /visuals\.isCustom \? 0\.12 : 0\.6/.test( track ) );
test( 'game: uTint uniform — neutral for custom, cool for classic', /uTint: \{ value: new THREE\.Vector3\( visuals\.isCustom \? 1 : 0\.86/.test( track ) );
test( 'game: shader tints through uTint', track.includes( 'refrColor *= uTint;' ) );
test( 'game: custom edge lip glows harder (0.55)', /emissiveIntensity: poolVisuals\.isCustom \? 0\.55 : 0\.3/.test( track ) );
test( 'editor: checkbox lives inside the Custom Pool button', /<button id="btn-custom-pool"[^>]*><input type="checkbox" id="cp-colors-toggle"/.test( editor ) );
test( 'editor: colors flag defaults to disabled (false)', /let customPoolColorsEnabled = false;/.test( editor ) );
test( 'editor: payload carries colorsOn', editor.includes( 'r: { ...customPoolConfig, colorsOn: customPoolColorsEnabled === true }' ) );
test( 'editor: load restores the flag + syncs the checkbox', /customPoolColorsEnabled = mods\?\.r\?\.colorsOn === true;/.test( editor ) );
test( 'editor: toggling stops propagation (no panel open)', /cp-colors-toggle' \)\?\.addEventListener\( 'click', \( event \) => \{[\s\S]{0,80}event\.stopPropagation\(\);/.test( editor ) );
test( 'editor: vivid preview only when colors are enabled', /const colorsOn = customPoolColorsEnabled === true;[\s\S]{0,2400}colorsOn \? 0\.45 : 0\.18/.test( editor ) );

console.log( '\n8. Garage + default car' );
test( 'garage cards: no spinning preview canvas anymore', !main.includes( 'garage-card-preview" aria-label' ) );
test( 'garage cards: big viewer is the only preview (comment pins why)', main.includes( 'No per-card spinning 3D previews anymore' ) );
test( 'paint find(): only source-color matches fold together (no mask catch-all)', !main.includes( "mapping.mask || colorDistanceSqHex" ) );
test( 'masked mappings are excluded from the global color wash', main.includes( 'const globalMappings = resolvedMappings.filter( ( m, idx ) => ! masks[ idx ] );' ) );
test( 'fallback uses globalMappings, not all resolved mappings', /pickMappedColor\( \{[\s\S]{0,160}\}, globalMappings \);/.test( main ) );
test( 'storage budget: compactGarageCosmetics trims oldest masks', /function compactGarageCosmetics\( cosmetics, budget = 200000 \)/.test( main ) );
test( 'saveGarageMods writes the trimmed cosmetics', /cosmetics: compactGarageCosmetics\( garageCosmetics \) \}/.test( main ) );
test( 'cloud profile snapshot trims the same way', /cosmetics: compactGarageCosmetics\( garageCosmetics \) \},/.test( main ) || /garage: \{ mods: garageMods, unlocked: garageUnlocked, cosmetics: compactGarageCosmetics\( garageCosmetics \) \}/.test( main ) );
test( 'default-car dropdown in the Gameplay panel', html.includes( '<select id="default-car-select"' ) );
test( 'default-car options include Last used + Random + every CAR_STATS car', /'<option value="__last">Last used car \(default\)<\/option>', '<option value="__random">Random<\/option>'/.test( main ) );
test( 'boot: default-car setting overrides the boot randomizer', /applyDefaultCar\( localStorage\.getItem\( DEFAULT_CAR_KEY \) \|\| '__random' \);/.test( main ) );
test( 'profile snapshot carries defaultCar', main.includes( "defaultCar: localStorage.getItem( DEFAULT_CAR_KEY ) || '__last'," ) );
test( 'profile import merges default car (local pick beats stale cloud)', /const nextDefault = localDefault \|\| cloudDefault \|\| '__last';/.test( main ) && /if \( nextDefault !== '__last' \) applyDefaultCar\( nextDefault \);/.test( main ) );
test( 'index.html cache bumped for the new main.js', /v=1000213/.test( html ) );

console.log( '\n9. Underwater package (dry pool cam + fog + overlay + caustics + bubbles)' );
const camera = readFileSync( './js/Camera.js', 'utf8' );
test( 'chase cam rises above pools with the legacy high-angle framing', /underwaterChaseOffset = new THREE\.Vector3\( 0, 7\.4, - 3\.2 \);/.test( camera ) && /underwaterOverviewOffset = new THREE\.Vector3\( 3\.6, 8\.6, 3\.6 \);/.test( camera ) && /lerp\( 4\.8, 0\.8, underwaterLift \)/.test( camera ) );
test( 'pool camera has a water-surface safety floor during transitions', /const minimumCameraY = this\.waterSurfaceY \+ 0\.35;/.test( camera ) && /this\.camera\.position\.y = minimumCameraY;/.test( camera ) );
test( 'main.js feeds the camera the water surface height', main.includes( 'waterSurfaceY: 0.12' ) && main.split( 'waterSurfaceY: 0.12' ).length === 3 );
test( 'main.js: camera-underwater state + fog + overlay toggle wired', main.includes( 'const cameraUnderwater = updateCameraUnderwater( cam.camera, dt );' ) );
test( 'main.js: underwater fog engages before the gameplay fog fallback', main.includes( 'else if ( cameraUnderwater ) scene.fog = underwaterFog;' ) );
test( 'main.js: underwater fog color + reach', /underwaterFog = new THREE\.Fog\( 0x0e3f55, 0\.9, Math\.max\( 8, cellWorld \* 1\.35 \) \)/.test( main ) );
test( 'main.js: overlay element toggles via the state edge', main.includes( "underwaterOverlayEl?.classList.toggle( 'active', underwater );" ) );
test( 'main.js: Track state export imported', main.includes( 'setWaterUnderwaterCameraState' ) );
test( 'main.js: bubbles spawn from the submerged car (rare, pooled)', main.includes( 'class CarBubblesFX' ) && main.includes( 'spawnTimer = 0.5 + Math.random() * 1.6;' ) );
test( 'main.js: bubbles capped at 16 sprites', main.includes( '>= 16 ) return;' ) );
test( 'main.js: bubble FX updated for both players', main.includes( 'carBubblesFx2 ??= new CarBubblesFX( scene );' ) );
test( 'main.js: barely-there water control constants', main.includes( 'WATER_CONTROL_ACCEL = 2.0' ) && main.includes( 'WATER_CONTROL_STEER = 0.55' ) );
test( 'main.js: water control applies gentle forward thrust only in water', /if \( inputZ \|\| inputX \) \{[\s\S]{0,400}WATER_CONTROL_ACCEL \* safeDelta;/.test( main ) );
test( 'Track.js: setWaterUnderwaterCameraState exported', /export function setWaterUnderwaterCameraState\( active \) \{[\s\S]{0,80}WATER_UNDERWATER\.camera = !! active;/.test( track ) );
test( 'Track.js: water shader renders a shimmering underside from below', track.includes( 'if ( ! gl_FrontFacing ) {' ) && track.includes( 'shimmering water ceiling' ) );
test( 'Track.js: pool-floor caustics material factory', track.includes( 'function createPoolFloorCausticsMaterial()' ) );
test( 'Track.js: caustics gain eases toward the camera-underwater flag', /u\.gain\.value = THREE\.MathUtils\.lerp\( u\.gain\.value, targetGain, step \);/.test( track ) );
test( 'Track.js: caustic overlay attached per pool floor', track.includes( 'const causticOverlay = new THREE.Mesh(' ) );
test( 'index.html: underwater overlay element present after <body>', /<body>\s*\n\t<div id="underwater-overlay" aria-hidden="true"><\/div>/.test( html ) );
test( 'index.html: underwater overlay is tint ONLY (no crosshatch bands)', html.includes( 'background: rgba( 14, 63, 85, 0.24 )' ) && ! html.includes( 'underwater-light-bands' ) && ! /#underwater-overlay::(before|after)/.test( html ) );
test( 'Track.js: sin-hash cross-pattern artifact is GONE (iq hash everywhere)', ! track.includes( 'vec2( 127.1, 311.7 )' ) && track.split( 'p.x * p.y * ( p.x + p.y )' ).length === 5 );
test( 'Track.js: caustic noise domains rotated so lattices never align', track.split( 'mat2 rotC' ).length === 4 );
test( 'Track.js: pool WALLS get shaded underwater caustics', track.includes( 'function createPoolWallCausticsMaterial' ) && track.includes( 'attachCausticAnimator( wallCaustic )' ) && track.includes( 'surfaceFade = smoothstep' ) );
test( 'Track.js: caustics respect sun shading (N dot L toward the sun)', track.includes( 'function computeCausticShade' ) && track.includes( 'uniforms.shade.value = computeCausticShade' ) );
test( 'index.html: overlay is pointer-transparent', /#underwater-overlay \{[^}]*pointer-events: none;/.test( html ) );
test( 'editor.html: special parts restored to the original flat bar (no details panel, no adjust group)', ! /<details id="side-ui-bar"/.test( editor ) && ! /side-ui-adjust/.test( editor ) && /<div id="side-ui-bar">/.test( editor ) && editor.includes( 'Arc/Portal ▲' ) && editor.includes( 'Magnet ▲' ) );
test( 'editor.html: all 14 special-part button ids survived the merge', [ 'btn-magnet-blue','btn-magnet-red','btn-magnet-up','btn-magnet-down','btn-magnet-strength-up','btn-magnet-strength-down','btn-magnet-range-up','btn-magnet-range-down','btn-arc-green','btn-portal-yellow','btn-arc-orange','btn-portal-purple','btn-portal-id-down','btn-portal-id-up' ].every( ( id ) => editor.split( 'id="' + id + '"' ).length === 2 ) );
test( 'editor.html: Height dispatcher toasts the RIGHT block value (no clobber)', editor.includes( 'function nudgeSelectedHeight' ) && editor.includes( "addEventListener( 'click', () => nudgeSelectedHeight( MAGNET_Y_STEP ) )" ) && ! editor.includes( 'nudgeSelectedMagnet( MAGNET_Y_STEP ); nudgeSelectedArc( MAGNET_Y_STEP )' ) );
test( 'editor.html: special-blocks bar is the original 212px 2-column flat grid', /#side-ui-bar \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?width: 212px;/.test( editor ) );
test( 'worker: defaultCar + repaint masks survive sanitizeProfile', ( () => { const w = worker; return w.includes( 'sanitizeDefaultCar' ) && /mask: typeof mapping\?\.mask === 'string' \? mapping\.mask\.slice\( 0, 32000 \) : ''/.test( w ) && /defaultCar: sanitizeDefaultCar\( profile\?\.defaultCar \)/.test( w ); } )() );
test( 'editor.html: arc/portal help text kept', editor.includes( 'Orange launches' ) );
test( 'Track.js import pin bumped to v=1000213', /Track\.js\?v=1000213'/.test( main ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
