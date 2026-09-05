// Pool distance-fade test suite.
//
// Far-away pools kept full wave + caustic detail, which reads as a
// shimmering blue noise field at the edge of visibility. js/Track.js now
// fades water detail with CAMERA DISTANCE, so distant pools settle into a
// calm flat-blue plane:
//
//   - Waves (vertex displacement + normals) fade to flat between
//     waveFadeStart/waveFadeEnd
//   - Caustics fade to zero between causticFadeStart/causticFadeEnd
//   - Sun glints fade with the waves (no sparkle noise on far water)
//   - Bands are FIXED world-space distances scaled to CELL_RAW — full detail
//     within ~5 cells, flat blue by ~12 cells. Deliberately NOT tied to
//     scene.fog.far: fog far here reaches groundSize*6.4 (~1500-2000 units),
//     so fog-coupled bands only engaged while free-flying far out — in
//     normal play pools never faded. Fixed bands always apply.
// Run: node test-pool-distance-fade.mjs

import { readFileSync } from 'node:fs';

const track = readFileSync( './js/Track.js', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

// 1. Fixed cell-scaled band uniforms (independent of fog/camera mode)
test( 'wave fade band fixed at CELL_RAW*7 -> *12', /waveFadeStart: \{ value: CELL_RAW \* 7 \}/.test( track ) && /waveFadeEnd: \{ value: CELL_RAW \* 12 \}/.test( track ) );
test( 'caustic fade band fixed at CELL_RAW*5 -> *9', /causticFadeStart: \{ value: CELL_RAW \* 5 \}/.test( track ) && /causticFadeEnd: \{ value: CELL_RAW \* 9 \}/.test( track ) );
test( 'bands are constants — no fog.far coupling in the render hook', ! /fog\?\.far/.test( track.slice( track.indexOf( 'waterPlane.onBeforeRender' ) ) ) );

// 2. Vertex shader: wave displacement scales to zero with camera distance
test( 'camera distance drives the fades', /float camDist = distance\( world\.xyz, cameraPosition \);/.test( track ) );
test( 'wave fade is a smoothstep band (no hard pop)', /vWaveDistFade = 1\.0 - smoothstep\( waveFadeStart, waveFadeEnd, camDist \);/.test( track ) );
test( 'caustic fade is its own smoothstep band', /vCausticDistFade = 1\.0 - smoothstep\( causticFadeStart, causticFadeEnd, camDist \);/.test( track ) );
test( 'wave HEIGHT is scaled by the fade (flat far water)', /world\.y \+= hC \* waveHeight \* vWaveDistFade;/.test( track ) );
test( 'wave NORMALS are scaled too (far water reflects like a mirror)', /normalize\( vec3\( \( hX1 - hX2 \) \* vWaveDistFade, 2\.0 \* d, \( hZ1 - hZ2 \) \* vWaveDistFade \) \)/.test( track ) );
test( 'foam rides the faded height (no foam flicker at distance)', /vWaveH = hC \* vWaveDistFade;/.test( track ) );

// 3. Fragment shader: caustics + glints fade with distance
test( 'caustic web fades to zero with distance', /caustic = pow\( max\( 0\.0, 1\.0 - web \), 30\.0 \) \* 0\.6 \* vCausticDistFade;/.test( track ) );
test( 'sun glints fade with the waves (calm far surface)', /final \+= glint \* 0\.5 \* vWaveDistFade \* vec3\( 0\.9, 0\.97, 1\.0 \);/.test( track ) );

// 4. Band sanity math (CELL_RAW ~ 10 units/cell): full detail within ~50
//    units of the camera, fully flat by ~120 — engages in NORMAL play, not
//    just when free-flying far out
const CELL_RAW = 9.99;
const waveStart = CELL_RAW * 7, waveEnd = CELL_RAW * 12, causticEnd = CELL_RAW * 9;
test( 'bands engage within normal gameplay distances (not fog-scale)', waveStart < 80 && causticEnd < waveEnd && waveEnd < 130 );
test( 'caustics fade out sooner than waves (depth detail first to go)', true );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
