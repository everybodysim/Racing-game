// Dynamic slope-tilt test suite.
//
// Verifies Vehicle.computeSlopeTiltFromSamples — the pure math behind the
// raycast slope detection — against PHYSICAL ground truth: climbing tilts
// the nose up, a surface rising toward the car's right lifts its right side.
// (The legacy grid-cell detection was inverted — live-confirmed — so legacy
// equality is deliberately NOT asserted.)
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

// ---- Physical ground truth ----
// The ray-depth generator below simulates a surface y = k·z (rises toward +Z)
// and a car at heading θ (forward offset points along (sinθ, 0, cosθ); the
// +X-offset sample — called 'right' in the API, which is the car's LEFT side
// in model space — points along (cosθ, 0, -sinθ)).
// NOTE: the legacy grid-cell detection used the OPPOSITE convention (live
// testing showed climbing tilted the nose DOWN), so legacy equality is
// deliberately NOT asserted anywhere.
const L = 1.1, W = 0.65, MAX = 1.0;
function newTilt( slopeAngle, headingYaw ) {

	const k = Math.tan( slopeAngle );
	const fz = Math.cos( headingYaw ), fx = Math.sin( headingYaw );
	const sx = Math.cos( headingYaw ), sz = - Math.sin( headingYaw );
	const H = 10;
	const depth = ( x, z ) => H - k * z;
	return Vehicle.computeSlopeTiltFromSamples( {
		forward: depth( 0, L * fz ),
		backward: depth( 0, - L * fz ),
		right: depth( W * sx, W * sz ),
		left: depth( - W * sx, - W * sz ),
	}, L, W, MAX );

}

{
	const A = Math.atan2( 0.5, 1 ); // canonical slope ≈ 26.57°
	const HALF = Math.atan( Math.tan( A ) / Math.SQRT2 ); // diagonal component

	// Climbing: nose UP (negative rotation.x), roll 0.
	const up = newTilt( A, 0 );
	test( 'climbing head-on: nose up', approx( up.pitch, - A ) && up.roll === 0 );

	// Descending: nose DOWN, roll 0.
	const down = newTilt( A, Math.PI );
	test( 'descending head-on: nose down', approx( down.pitch, A ) && down.roll === 0 );

	// Crosswise, hill rising toward the car's RIGHT side: right side UP.
	const cross = newTilt( A, Math.PI / 2 );
	test( 'crosswise: uphill side of the car rises', approx( cross.roll, - A ) && cross.pitch === 0 );

	// Crosswise, hill rising toward the car's LEFT side: left side UP.
	const cross2 = newTilt( A, - Math.PI / 2 );
	test( 'crosswise mirrored: roll flips', approx( cross2.roll, A ) && cross2.pitch === 0 );

	// Diagonal climb: nose up AND uphill-side up, equal components.
	const diag = newTilt( A, Math.PI / 4 );
	test( 'diagonal climb: pitch and roll both tilt uphill',
		approx( diag.pitch, - HALF ) && approx( diag.roll, - HALF ) );

	// Diagonal descent: both flip.
	const diagDown = newTilt( A, Math.PI + Math.PI / 4 );
	test( 'diagonal descent: both flip', approx( diagDown.pitch, HALF ) && approx( diagDown.roll, HALF ) );

	// Steeper 40° slope: true angle comes through, still nose up.
	const steep = newTilt( MathUtils.degToRad( 40 ), 0 );
	test( 'steeper 40° slope: full true angle, nose up', approx( steep.pitch, - MathUtils.degToRad( 40 ) ) );
}

console.log( '--- Flat + partial + clamp ---' );

{
	const L = 1.1, W = 0.65;
	let flat = Vehicle.computeSlopeTiltFromSamples( { forward: 0.5, backward: 0.5, left: 0.5, right: 0.5 }, L, W );
	test( 'flat ground: zero tilt', flat.pitch === 0 && flat.roll === 0 );

	// Front/back only (side rays missed / rejected) → pitch only. Front is
	// shallower = uphill forward = nose UP (negative).
	let fb = Vehicle.computeSlopeTiltFromSamples( { forward: 0.3, backward: 0.7, left: null, right: null }, L, W );
	test( 'front/back-only: nose up when front is shallower', approx( fb.pitch, - Math.atan2( 0.4, 2 * L ) ) && fb.roll === 0 );

	// Sides only → roll only. 'right' (+X-offset) sample deeper = surface
	// rises toward the car's right → right side UP (negative rotation.z).
	let lr = Vehicle.computeSlopeTiltFromSamples( { forward: null, backward: null, left: 0.4, right: 0.6 }, L, W );
	test( 'sides-only: uphill side rises', approx( lr.roll, - Math.atan2( 0.2, 2 * W ) ) && lr.pitch === 0 );

	// Nothing hit (airborne) → zeros; the visual lerp decays the tilt.
	let none = Vehicle.computeSlopeTiltFromSamples( { forward: null, backward: null, left: null, right: null }, L, W );
	test( 'all rays missed: zero tilt', none.pitch === 0 && none.roll === 0 );

	// Extreme geometry clamps instead of producing nonsense angles.
	const absurd = Vehicle.computeSlopeTiltFromSamples( { forward: - 1.5, backward: 3.0, left: 0, right: 0 }, L, W, 1.0 );
	test( 'extreme slope clamps to maxTilt', Math.abs( absurd.pitch ) <= 1.0 + 1e-9 );
}

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
