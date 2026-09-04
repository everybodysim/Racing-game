// Dynamic slope-tilt test suite.
//
// Verifies Vehicle.computeSlopeTiltFromSamples — the pure math behind the
// raycast slope detection — against a REPLICA of the legacy grid-cell
// implementation's math (applySlopeConformVisual, removed from main.js).
// If the new ray-based detection is sign-compatible with the old one for
// canonical slope geometry, the car's on-slope orientation is unchanged
// while detection itself becomes fully dynamic.
//
//   1. Canonical slope (rises toward +Z), every heading: new == old exactly
//   2. Downhill driving sign-flips correctly (new == old)
//   3. Flat ground: zero pitch/roll
//   4. Partial samples: front/back-only → pitch, sides-only → roll, none → zero
//   5. Clamp: extreme geometry can't exceed maxTilt
//
// Run: node test-slope-tilt.mjs

import { register } from 'node:module';
register( './test-three-resolve.mjs', import.meta.url );

const { Vehicle } = await import( './js/Vehicle.js' );
const { Vector3, MathUtils } = await import( './test-three-stub.mjs' );

let passed = 0, failed = 0;
function test( name, cond ) {

	if ( cond ) { passed++; console.log( `  ✓ ${ name }` ); }
	else { failed++; console.error( `  ✗ ${ name }` ); }

}

const approx = ( a, b, eps = 1e-6 ) => Math.abs( a - b ) < eps;
const UP = new Vector3( 0, 1, 0 );

// ---- Legacy replica (from the removed applySlopeConformVisual) ----
// A slope cell with orientation 0 drives _slopeForward = (0,0,1); the old
// code built the slope normal as up tilted BACKWARD, i.e. a surface rising
// toward +Z at angle A, then rotated it into the car's heading frame.
function legacyTilt( slopeAngle, headingYaw, maxTilt ) {

	const tan = Math.tan( slopeAngle );
	const worldUp = new Vector3( 0, 1, - tan ).normalize(); // rises toward +Z
	const localUp = worldUp.applyAxisAngle( UP, - headingYaw ).normalize();
	return {
		pitch: MathUtils.clamp( Math.atan2( - localUp.z, localUp.y ), - maxTilt, maxTilt ),
		roll: MathUtils.clamp( Math.atan2( localUp.x, localUp.y ), - maxTilt, maxTilt ),
	};

}

// ---- New implementation fed with ray depths from the same geometry ----
// Surface y = k·z (rises toward +Z). Car at heading θ: forward offset points
// along (sinθ, 0, cosθ), +X side offset along (cosθ, 0, -sinθ). Depths are
// measured downward from one shared origin height, so only differences matter.
function newTilt( slopeAngle, headingYaw, L, W, maxTilt ) {

	const k = Math.tan( slopeAngle );
	const fz = Math.cos( headingYaw ), fx = Math.sin( headingYaw );
	const sx = Math.cos( headingYaw ), sz = - Math.sin( headingYaw );
	// depth(hit) = H − y(hit); H cancels in every difference.
	const H = 10;
	const depth = ( x, z ) => H - k * z;
	const samples = {
		forward: depth( 0, L * fz ),
		backward: depth( 0, - L * fz ),
		right: depth( W * sx, W * sz ),
		left: depth( - W * sx, - W * sz ),
	};
	return Vehicle.computeSlopeTiltFromSamples( samples, L, W, maxTilt );

}

console.log( '--- Sign lock vs legacy implementation ---' );

{
	const A = Math.atan2( 0.5, 1 ); // the old SLOPE_CONFORM_ANGLE ≈ 26.57°
	const L = 1.1, W = 0.65, MAX = 1.0;
	let all = true, detail = '';
	for ( const deg of [ 0, 30, 45, 90, 135, 180, 250, 311 ] ) {

		const yaw = MathUtils.degToRad( deg );
		const old = legacyTilt( A, yaw, MAX );
		const now = newTilt( A, yaw, L, W, MAX );
		if ( ! approx( old.pitch, now.pitch ) || ! approx( old.roll, now.roll ) ) {

			all = false;
			detail = `heading ${ deg }°: old(${ old.pitch.toFixed( 4 ) }, ${ old.roll.toFixed( 4 ) }) vs new(${ now.pitch.toFixed( 4 ) }, ${ now.roll.toFixed( 4 ) })`;

		}

	}
	test( 'canonical slope, 8 headings: pitch/roll match legacy exactly', all );
	if ( ! all ) console.error( '    ' + detail );

	// Steeper geometry (dynamic detection's whole point) — legacy math still
	// defines the convention; the new code must follow it beyond 26.57°.
	const steep = MathUtils.degToRad( 40 );
	let allSteep = true;
	for ( const deg of [ 0, 37, 90, 123 ] ) {

		const yaw = MathUtils.degToRad( deg );
		const old = legacyTilt( steep, yaw, MAX );
		const now = newTilt( steep, yaw, L, W, MAX );
		if ( ! approx( old.pitch, now.pitch ) || ! approx( old.roll, now.roll ) ) allSteep = false;

	}
	test( 'steeper 40° slope: convention still matches legacy', allSteep );

	// Downhill = same geometry, heading flipped 180° — signs must flip.
	const up = newTilt( A, 0, L, W, MAX );
	const down = newTilt( A, Math.PI, L, W, MAX );
	test( 'downhill sign-flips pitch', approx( down.pitch, - up.pitch ) && down.pitch < 0 );
}

console.log( '--- Flat + partial + clamp ---' );

{
	const L = 1.1, W = 0.65;
	let flat = Vehicle.computeSlopeTiltFromSamples( { forward: 0.5, backward: 0.5, left: 0.5, right: 0.5 }, L, W );
	test( 'flat ground: zero tilt', flat.pitch === 0 && flat.roll === 0 );

	// Front/back only (side rays missed / rejected) → pitch, no roll.
	let fb = Vehicle.computeSlopeTiltFromSamples( { forward: 0.3, backward: 0.7, left: null, right: null }, L, W );
	test( 'front/back-only: pitch from depth delta', approx( fb.pitch, Math.atan2( 0.4, 2 * L ) ) && fb.roll === 0 );

	// Sides only → roll, no pitch.
	let lr = Vehicle.computeSlopeTiltFromSamples( { forward: null, backward: null, left: 0.4, right: 0.6 }, L, W );
	test( 'sides-only: roll from depth delta', approx( lr.roll, Math.atan2( 0.2, 2 * W ) ) && lr.pitch === 0 );

	// Nothing hit (airborne) → zeros; the visual lerp decays the tilt.
	let none = Vehicle.computeSlopeTiltFromSamples( { forward: null, backward: null, left: null, right: null }, L, W );
	test( 'all rays missed: zero tilt', none.pitch === 0 && none.roll === 0 );

	// Extreme geometry clamps instead of producing nonsense angles.
	const absurd = Vehicle.computeSlopeTiltFromSamples( { forward: - 1.5, backward: 3.0, left: 0, right: 0 }, L, W, 1.0 );
	test( 'extreme slope clamps to maxTilt', Math.abs( absurd.pitch ) <= 1.0 + 1e-9 );
}

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
