// Pool performance governor test suite.
//
// The pool's screen-space refraction re-rendered the ENTIRE scene every
// frame whenever any water existed — off-screen pools included, lag spikes
// included. js/Track.js now gates it two ways:
//
//   1. FRUSTUM gate — no water plane in the camera's view = skip the pass
//   2. CADENCE gate — as measured FPS dips (45/28/18 thresholds), the RT
//      refreshes every 2nd/3rd/4th frame per camera; the wobble animates
//      in-shader so the stale sample is imperceptible
//
// js/main.js feeds it via updateWaterQuality( rollingFps ), and rollingFps
// now tracks every frame even with the FPS HUD hidden.
// Run: node test-pool-perf.mjs

import { readFileSync } from 'node:fs';

const track = readFileSync( './js/Track.js', 'utf8' );
const main = readFileSync( './js/main.js', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

// 1. Quality governor exported, imported, and fed every frame
test( 'updateWaterQuality exported from Track.js', /export function updateWaterQuality/.test( track ) );
test( 'main.js imports + calls it with rollingFps', /import \{[^}]*updateWaterQuality[^}]*\} from '\.\/Track\.js\?v=999977'/.test( main ) && /updateWaterQuality\( rollingFps \);/.test( main ) );
test( 'unknown FPS (0/NaN) falls back to full quality', /! Number\.isFinite\( rollingFps \) \|\| rollingFps <= 0 /.test( track ) );
test( 'cadence tiers: 45+ every frame, 28+ every 2nd, 18+ every 3rd, else 4th', /rollingFps >= 45 \? 1 : rollingFps >= 28 \? 2 : rollingFps >= 18 \? 3 : 4/.test( track ) );

// 2. Frustum gate
test( 'water planes cache world bounding spheres once (no per-frame alloc)', /userData\.waterWorldSphere = waterPlane\.geometry\.boundingSphere\.clone\(\)\.applyMatrix4\( waterPlane\.matrixWorld \);/.test( track ) );
test( 'frustum test runs before any RT work in the pass', track.indexOf( 'if ( ! isWaterVisibleToCamera( camera ) ) return;' ) < track.indexOf( 'const db = renderer.getDrawingBufferSize( _waterDbSize );' ) );
test( 'uncached plane falls back to rendering (safe default)', /if \( ! sphere \) return true; \/\/ not cached/.test( track ) );
test( 'camera inverse matrix refreshed before the frustum build', /camera\.matrixWorldInverse\.copy\( camera\.matrixWorld \)\.invert\(\);/.test( track ) );
test( 'frustum helper reuses module-level temps (no GC churn)', /const _waterFrustum = new THREE\.Frustum\(\);/.test( track ) && /const _waterProjScreen = new THREE\.Matrix4\(\);/.test( track ) );

// 3. Cadence gate
test( 'per-camera last-refresh map (split-screen stays even)', /const waterLastRefrFrameByCam = new Map\(\);/.test( track ) );
test( 'cadence skip returns BEFORE touching viewport/scissor state', track.indexOf( 'waterRefrFrameCounter - waterLastFrame < waterRefrCadence' ) < track.indexOf( 'const prevViewport = renderer.getViewport' ) );
test( 'off-screen skip does not advance the cadence clock (instant refresh on return)', track.indexOf( 'isWaterVisibleToCamera( camera ) ) return;' ) < track.indexOf( 'waterLastRefrFrameByCam.set' ) );

// 4. FPS signal health
test( 'rollingFps updates even with the FPS HUD hidden', main.indexOf( 'const instantFps' ) < main.indexOf( 'if ( ! fpsHudVisible || ! fpsHud ) return;' ) );
test( 'instant FPS still sanity-checked (non-finite skipped)', /if \( Number\.isFinite\( instantFps \) && instantFps > 0 \) \{/.test( main ) );

// 5. The pass itself is untouched when it does run (visuals preserved)
test( 'RT sizing + per-plane uniform wiring unchanged', /renderer\.setRenderTarget\( rt \);/.test( track ) && /plane\.material\.uniforms\.tDiffuse\.value = rt\.texture;/.test( track ) );
test( 'cache bumps present', /Track\.js\?v=999977/.test( main ) && /v=1000208/.test( readFileSync( './index.html', 'utf8' ) ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
