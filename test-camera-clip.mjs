// Chase-cam hitbox clip probe test suite.
//
// Verifies js/Camera.js clamp logic with the THREE stub (loader hook maps
// 'three' -> test-three-stub.mjs). The real raycast lives in main.js
// (crashcat castRay, static bodies only) and is browser-only; here the probe
// is simulated. What matters is the Camera's gating + clamping math:
//
//   1. No clipProbe supplied = legacy behavior (desired pos = target + offset)
//   2. Probe returning full length = untouched
//   3. Probe returning a shorter free length = camera pulled in along the
//      SAME direction, exactly at the free distance
//   4. Probe receives the normalized direction and correct segment length
//   5. Overview (fixed-angle) mode never calls the probe
//   6. Freed segment restores full distance (drive away from a wall)
//
// Run: node test-camera-clip.mjs

import { register } from 'node:module';
globalThis.window = { innerWidth: 800, innerHeight: 600, addEventListener() {} };
register( './test-three-resolve.mjs', import.meta.url );

const { Camera } = await import( './js/Camera.js' );

let passed = 0, failed = 0;
function test( name, cond ) {

	if ( cond ) { passed++; console.log( `  ✓ ${ name }` ); }
	else { failed++; console.error( `  ✗ ${ name }` ); }

}

const approx = ( a, b, eps = 1e-4 ) => Math.abs( a - b ) < eps;
const vecApprox = ( v, x, y, z, eps = 1e-4 ) => approx( v.x, x, eps ) && approx( v.y, y, eps ) && approx( v.z, z, eps );

const IDENT_QUAT = { x: 0, y: 0, z: 0, w: 1 };
const TARGET = { x: 5, y: 0, z: 5 };
// chaseOffset = (0, 2.3, -6.6); identity quat → yaw 0 → rotatedOffset unchanged.
const EXPECTED_X = 5, EXPECTED_Y = 2.3, EXPECTED_Z = 5 - 6.6;

function freshCam( probe ) {

	const cam = new Camera();
	if ( probe ) cam.clipProbe = probe;
	// Prime the smoothed target so the clamp math uses our exact target.
	cam.targetPosition.set( TARGET.x, TARGET.y, TARGET.z );
	cam.update( 1 / 60, cam.targetPosition, IDENT_QUAT, {} );
	return cam;

}

console.log( '--- Chase-cam clip probe ---' );

{
	// 1. No probe = legacy behavior.
	const cam = freshCam( null );
	test( 'no probe: desired pos = target + chase offset',
		vecApprox( cam._desiredPos, EXPECTED_X, EXPECTED_Y, EXPECTED_Z ) );

	// 2. Probe says the segment is clear.
	const cam2 = freshCam( () => 7.2 ); // full-ish length
	test( 'clear segment: untouched',
		vecApprox( cam2._desiredPos, EXPECTED_X, EXPECTED_Y, EXPECTED_Z ) );

	// 3-4. Probe reports a wall partway: clamp along the same direction.
	let sawDir = null, sawLength = 0, sawOrigin = null;
	const FREE = 2.5;
	const cam3 = freshCam( ( origin, dir, length ) => {

		sawOrigin = { x: origin.x, y: origin.y, z: origin.z };
		sawDir = { x: dir.x, y: dir.y, z: dir.z };
		sawLength = length;
		return FREE;

	} );
	const desiredLen = Math.hypot( 0, EXPECTED_Y - TARGET.y, EXPECTED_Z - TARGET.z );
	test( 'probe receives the car origin', sawOrigin && vecApprox( sawOrigin, TARGET.x, TARGET.y, TARGET.z ) );
	test( 'probe receives a NORMALIZED direction', sawDir && approx( Math.hypot( sawDir.x, sawDir.y, sawDir.z ), 1 ) );
	test( 'probe receives the full segment length', approx( sawLength, desiredLen ) );
	test( 'blocked segment clamps to origin + dir * free',
		vecApprox( cam3._desiredPos,
			TARGET.x + sawDir.x * FREE,
			TARGET.y + sawDir.y * FREE,
			TARGET.z + sawDir.z * FREE ) );

	// 6. Wall disappears: back to full distance.
	cam3.clipProbe = () => 99;
	cam3.update( 1 / 60, cam3.targetPosition, IDENT_QUAT, {} );
	test( 'freed segment restores full distance',
		vecApprox( cam3._desiredPos, EXPECTED_X, EXPECTED_Y, EXPECTED_Z ) );

	// Extra: probe returning MORE than the segment never pushes the camera out.
	const cam4 = freshCam( () => 100 );
	test( 'probe cannot push the camera farther than desired',
		vecApprox( cam4._desiredPos, EXPECTED_X, EXPECTED_Y, EXPECTED_Z ) );
}

console.log( '--- Fixed-angle (overview) cam is never probed ---' );

{
	let called = 0;
	const cam = new Camera();
	cam.clipProbe = () => { called++; return 0.5; };
	cam.mode = 'overview';
	cam.targetPosition.set( TARGET.x, TARGET.y, TARGET.z );
	cam.update( 1 / 60, cam.targetPosition, IDENT_QUAT, {} );
	test( 'overview mode never casts', called === 0 );
	test( 'overview keeps its framing (offset cam, not clamped)',
		vecApprox( cam._desiredPos, TARGET.x + 7.0, TARGET.y + 7.1, TARGET.z + 7.0 ) );
}

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
