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
test( 'caustic web', /abs\( n1 - n2 \)/.test( shader ) && /pow\(\s*max\( 0\.0, 1\.0 - web \),\s*30\.0\s*\)/.test( shader ) );
test( 'ceramic tiles drawn in-shader, grid-aligned', /cellSize \* \$\{ WATER_SHADER_TILE_COLS \}\.0/.test( shader ) );
test( 'fresnel sky reflection', /fresnel/.test( shader ) && /skyTop/.test( shader ) );
test( 'sun glint', /pow\(\s*max\( dot\( rDir, lightDir \), 0\.0 \),\s*450\.0/.test( shader ) );

// 3. Animated + subdivided
test( 'water plane subdivided for the wave field', /PlaneGeometry\(\s*waterWidth,\s*waterDepth,\s*waterSeg,\s*waterSeg\s*\)/.test( track ) );
test( 'time uniform driven every frame', /onBeforeRender[\s\S]{0,120}uniforms\.time\.value = performance\.now\(\) \* 0\.001/.test( track ) );

// 4. Pool blocks textured
test( 'pool floor uses procedural tile texture', /map: poolFloorTexture/.test( track ) );
test( 'pool walls use procedural tile texture', /map: poolWallTexture/.test( track ) );
test( 'edge lip glossy', /roughness: 0\.22, metalness: 0\.12/.test( track ) );

// 5. Determinism
test( 'tile textures deterministic (seeded PRNG)', /createPoolTileCanvas/.test( track ) && ! /Math\.random\(\)/.test( track.slice( track.indexOf( 'createPoolTileCanvas' ), track.indexOf( 'normalizePoolVisuals' ) ) ) );

// 6. Bluer
test( 'default waterColor is a saturated blue', track.includes( "'#1180e6'" ) );
test( 'shader applies the blue body tint', shader.includes( 'vec3( 0.72, 0.9, 1.14 )' ) );

// 7. customPool API compatibility
test( 'customPool waterColor/edgeColor still honored', /isHex\( cfg\.waterColor \)/.test( track ) && /isHex\( cfg\.edgeColor \)/.test( track ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
