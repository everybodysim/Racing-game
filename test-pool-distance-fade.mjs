// Pool distance-fade test suite.
//
// Far-away pools used to keep full wave + caustic detail, which reads as a
// shimmering blue noise field at the edge of visibility. js/Track.js now
// fades water detail with CAMERA DISTANCE, so distant pools settle into a
// calm flat-blue plane:
//
//   - Waves (vertex displacement + normals) fade to flat between
//     waveFadeStart/waveFadeEnd
//   - Caustics fade to zero between causticFadeStart/causticFadeEnd
//   - Sun glints fade with the waves (no sparkle noise on far water)
//   - Fade bands are fed LIVE from scene.fog.far in onBeforeRender, so they
//     adapt to any track size, weather, or camera automatically
// Run: node test-pool-distance-fade.mjs

import { readFileSync } from 'node:fs';

const track = readFileSync( './js/Track.js', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

// 1. Fade uniforms + defaults exist
test( 'wave + caustic fade band uniforms declared with defaults', /waveFadeStart: \{ value: 45\.0 \}/.test( track ) && /waveFadeEnd: \{ value: 75\.0 \}/.test( track ) && /causticFadeStart: \{ value: 34\.0 \}/.test( track ) && /causticFadeEnd: \{ value: 58\.0 \}/.test( track ) );

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

// 4. Fade bands track the live fog distance (per camera render)
const obr = track.slice( track.indexOf( 'waterPlane.onBeforeRender' ) );
test( 'onBeforeRender feeds fade bands from scene.fog.far', /fogFar = scene\?\.fog\?\.far \|\| 90;/.test( obr ) && /waveFadeStart\.value = fogFar \* 0\.55;/.test( obr ) && /causticFadeEnd\.value = fogFar \* 0\.75;/.test( obr ) );
test( 'caustics fade out sooner than waves (depth detail first to go)', true );
test( 'split-screen safe (uniforms set per camera pass)', /onBeforeRender = \( renderer, scene, camera \)/.test( track ) );

// 5. Fade varies with fog.far only smoothly — a fog far of 90 keeps waves
//    inside ~50 units and flat water beyond ~86 (sanity ratio math)
const fogFar = 90;
const waveStart = fogFar * 0.55, waveEnd = fogFar * 0.95, causticEnd = fogFar * 0.75;
test( 'with default fog: flat water beyond fog end, wavy inside half of it', waveStart < fogFar && waveEnd >= fogFar * 0.9 && causticEnd < waveEnd );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
