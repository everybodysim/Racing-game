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
test( 'editor: vivid preview only when colors are enabled', /const colorsOn = customPoolColorsEnabled === true;[\s\S]{0,900}colorsOn \? 0\.45 : 0\.18/.test( editor ) );

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
test( 'profile import restores the default car', /localStorage\.setItem\( DEFAULT_CAR_KEY, parsed\.defaultCar \);/.test( main ) );
test( 'index.html cache bumped for the new main.js', /v=1000211/.test( html ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
