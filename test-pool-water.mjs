// Pool glow-up test suite.
//
// Verifies js/Track.js pool visuals — the dynamic water shader (ported from
// the classic "tinted clear water" technique) and the tiled pool blocks:
//
//   1. No external texture CDNs (fully procedural — offline-safe)
//   2. Water shader implements the demo technique: fbm waves, finite-
//      difference world normals, refraction onto the floor, caustic web,
//      fresnel, sun glint
//   3. Wave field has geometry to bend (subdivided plane) and is animated
//   4. Pool blocks (floor + walls) are canvas-tiled, edge lip is glossy
//   5. Tile textures are deterministic (seeded PRNG, no Math.random)
//   6. Water is bluer (default hex + shader body tint)
//   7. customPool track API stays compatible (waterColor/edgeColor/transparent)
// Run: node test-pool-water.mjs

import { readFileSync } from 'node:fs';

const track = readFileSync( './js/Track.js', 'utf8' );
const main = readFileSync( './js/main.js', 'utf8' );
const particles = readFileSync( './js/Particles.js', 'utf8' );
const audio = readFileSync( './js/Audio.js', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond, detail = '' ) {

	if ( cond ) { passed++; console.log( `  ✓ ${ name }` ); }
	else { failed++; console.error( `  ✗ ${ name }${ detail ? ' — ' + detail : '' }` ); }

}

// 1. Fully procedural — no external assets
test( 'no external CDN water/pool assets', ! /cdn\.(jsdelivr|unpkg)|https?:\/\/.*\.(jpg|png)/.test( track ) );
test( 'no TextureLoader for water (procedural instead)', ! track.includes( 'setCrossOrigin' ) );

// 2. The demo technique
const shaderIdx = track.indexOf( 'createRepositoryWaterMaterial' );
const shader = track.slice( shaderIdx, track.indexOf( 'const ELEVATED_TYPES', shaderIdx ) );
test( 'fbm wave field in vertex shader', /fbm/.test( shader ) && /getWave/.test( shader ) );
test( 'finite-difference world normals', /hX1 - hX2/.test( shader ) && /hZ1 - hZ2/.test( shader ) );
test( 'waves evaluated in world space (shared ocean feel)', /world\.xz/.test( shader ) && /world\.y \+= hC/.test( shader ) );
test( 'refraction onto the pool floor', /refract\(/.test( shader ) && /floorY/.test( shader ) );
test( 'caustics project onto the REAL refracted scene (floor + car)', /vec3 fPos = vWorldPos \+ refrDir \* dFloor;/.test( shader ) && /refrColor \+= vec3\( caustic \* vec3\( 0\.65, 0\.8, 0\.9 \) \)/.test( shader ) );
test( 'water is opaque — no un-wiggled ghost of the raw scene', /gl_FragColor = vec4\( final, 1\.0 \);/.test( shader ) && ! /waterAlpha/.test( shader ) && /transparent: false,/.test( track ) );
test( 'freecam shift-sprint is wired (declared state now used)', /sprinting \? freecamState\.sprintMultiplier : 1/.test( main ) );
test( 'foam caps the tallest crests (surface texture)', /smoothstep\( 0\.13, 0\.2, vWaveH \)/.test( shader ) && /vWaveH = hC;/.test( track ) );
test( 'sun glints shimmer on the ripples', /noise\( vWorldPos\.xz \* 6\.5/.test( shader ) );
test( 'water samples the REAL scene, not a drawn floor', /uniform sampler2D tDiffuse/.test( shader ) && /texture2D\( tDiffuse, refrUV \)/.test( shader ) );
test( 'refraction wobble is animated (the light-bending wiggle)', /noise\( vWorldPos\.xz \* 2\.1/.test( shader ) && /screenUV \+ wobble \* 0\.035/.test( shader ) );
test( 'water shader references no removed uniforms (compiles)', ! /cellSize|shallowColor/.test( shader ) );
test( 'choppy ripples ride the swell', /sin\( wp\.x \* 3\.4 - t \* 1\.4 \) \* 0\.03/.test( shader ) );
test( 'rolling swell amplitudes', /sin\( wp\.x \* 1\.35 \+ t \) \* 0\.055/.test( shader ) );
test( 'wave scale 3.4x the flat pass', /waveHeight: \{ value: CELL_RAW \* 0\.17 \}/.test( track ) );
test( 'water level leaves wave headroom below the edge lip', /CELL_RAW, 0\.12,/.test( track ) && 0.12 + 0.22 * 9.99 * 0.17 < 0.515 );
test( 'splash surface matches the lowered water level', /WATER_SURFACE_Y = 0\.12/.test( main ) );
test( 'fresnel sky reflection', /fresnel/.test( shader ) && /skyTop/.test( shader ) );
test( 'sun glint', /pow\(\s*max\( dot\( rDir, lightDir \), 0\.0 \),\s*450\.0/.test( shader ) );

// 3. Animated + subdivided
test( 'water plane subdivided for the wave field', /PlaneGeometry\(\s*waterWidth,\s*waterDepth,\s*waterSeg,\s*waterSeg\s*\)/.test( track ) );
test( 'time uniform driven every frame', /onBeforeRender[\s\S]{0,220}uniforms\.time\.value = (?:performance\.now\(\) \* 0\.001|t)/.test( track ) );

// 4. Pool blocks textured
test( 'pool floor uses procedural tile texture', /map: poolFloorTexture/.test( track ) );
test( 'pool walls use procedural tile texture', /map: poolWallTexture/.test( track ) );
test( 'edge lip glossy', /roughness: 0\.22, metalness: 0\.12/.test( track ) );

// 5. Determinism
test( 'tile textures deterministic (seeded PRNG)', /createPoolTileCanvas/.test( track ) && ! /Math\.random\(\)/.test( track.slice( track.indexOf( 'createPoolTileCanvas' ), track.indexOf( 'normalizePoolVisuals' ) ) ) );

// 6. Bluer
test( 'default waterColor is a saturated blue', track.includes( "'#1180e6'" ) );
test( 'shader applies the blue body tint', shader.includes( 'vec3( 0.86, 0.94, 1.08 )' ) );

// 6b. Screen-space refraction plumbing
test( 'prerender pass exists (hides water, renders scene to half-res RT)', /export function prerenderWaterRefraction/.test( track ) && /plane\.visible = false/.test( track ) && /db\.x /.test( track ) && /Math\.floor\( db\.x \/ 2 \)/.test( track ) );
test( 'plane registry resets per track build', track.includes( 'WATER_PLANES.length = 0;' ) && track.includes( 'WATER_PLANES.push( waterPlane );' ) );
test( 'every render site prerenders refraction (incl. split-screen rects)', main.split( 'prerenderWaterRefraction( renderer, scene' ).length === 5 && main.includes( 'prerenderWaterRefraction( renderer, scene, cam2.camera, 1,' ) );
test( 'shadows update once per frame, not per render pass', main.includes( 'shadowMap.autoUpdate = false' ) && main.includes( 'renderer.shadowMap.needsUpdate = true' ) );
test( 'Track.js module cache param bumped (it changed)', main.includes( 'Track.js?v=999974' ) );

// 7. Splash when the car breaks the surface
test( 'splash FX class exists (droplet burst + gravity)', /export class WaterSplashFX/.test( particles ) && /burst\(/.test( particles ) && /velocity\.y -= particle\.gravity \* dt/.test( particles ) );
test( 'splash sound is procedural (no sample file)', /playSplash\(/.test( audio ) && /createBuffer\(/.test( audio ) && ! /splash\.(ogg|mp3|wav)/.test( audio ) );
test( 'splash triggers on water entry (all 4 camera-state sites)', main.includes( 'triggerWaterSplash' ) && main.split( 'updateWaterCameraState( waterCameraState' ).length === 5 && main.includes( "( pos ) => triggerWaterSplash" ) );
test( 'splash intensity scales with dive speed', /dive \/ 10 \/ speed \/ 60/.test( main.replace( /Math\.hypot\(|\)/g, '' ) ) || /dive \/ 10/.test( main ) );
test( 'splash FX updated each frame', /waterSplashFx\?\.update\( dt \)/.test( main ) );
test( 'pool walls still wear the ceramic tile texture', /map: poolWallTexture/.test( track ) );

// 8. customPool API compatibility
test( 'customPool waterColor/edgeColor still honored', /isHex\( cfg\.waterColor \)/.test( track ) && /isHex\( cfg\.edgeColor \)/.test( track ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
