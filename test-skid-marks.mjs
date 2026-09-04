// Skid marks test suite.
//
// Verifies js/SkidMarks.js behavior in Node via a minimal THREE stub
// (test-three-resolve.mjs maps 'three' -> test-three-stub.mjs):
//
//   1. Marks appear ONLY while drifting (speed + driftIntensity gates)
//   2. Segments come from both rear tires independently
//   3. THE RESTART ARTIFACT: teleporting back to the start block mid-drift
//      must NOT draw a connecting line across the map — the trail breaks
//   4. Stopping drift and starting again anchors a fresh trail (no line
//      from wherever you stopped to wherever you resumed)
//   5. Ring buffer recycles oldest marks instead of growing unbounded
//   6. clear() erases, breakVehicleTrail() breaks strips without erasing
//   7. Quality hook: maxSegments 0 disables, undefined keeps the pool
//
// Run: node test-skid-marks.mjs

import { register } from 'node:module';
register( './test-three-resolve.mjs', import.meta.url );

const { SkidMarks } = await import( './js/SkidMarks.js' );

let passed = 0, failed = 0;
function test( name, cond ) {

	if ( cond ) { passed++; console.log( `  ✓ ${ name }` ); }
	else { failed++; console.error( `  ✗ ${ name }` ); }

}

// ---- helpers -----------------------------------------------------------------

function makeScene() {

	return { children: [], add( o ) { this.children.push( o ); }, remove( o ) {

		const i = this.children.indexOf( o );
		if ( i >= 0 ) this.children.splice( i, 1 );

	} };

}

function makeWheel() {

	// Object3D-ish: only getWorldPosition is used.
	return { getWorldPosition( out ) { return out.copy( this.worldPos || this._default ); } };

}

function makeVehicle() {

	return {
		container: { position: { x: 0, y: 0.4, z: 0 }, quaternion: {} },
		linearSpeed: 0,
		driftIntensity: 0,
		wheelBL: Object.assign( makeWheel(), { worldPos: { x: -0.55, y: 0.2, z: -1.0, copy( v ) { Object.assign( this, v ); return this; } } } ),
		wheelBR: Object.assign( makeWheel(), { worldPos: { x: 0.55, y: 0.2, z: -1.0, copy( v ) { Object.assign( this, v ); return this; } } } ),
	};

}

function moveVehicle( v, dx, dz ) {

	v.container.position.x += dx;
	v.container.position.z += dz;
	v.wheelBL.worldPos.x += dx;
	v.wheelBL.worldPos.z += dz;
	v.wheelBR.worldPos.x += dx;
	v.wheelBR.worldPos.z += dz;

}

function setDrifting( v, on = true ) {

	v.linearSpeed = on ? 1.2 : 0.05;
	v.driftIntensity = on ? 1.0 : 0.1;

}

function stampCount( marks ) {

	// Count instances that were ever given a real (non-zero-scale) matrix.
	return marks.mesh.matrices.filter( ( m ) => m && m._basis ).length;

}

console.log( '--- Drift gating ---' );

{
	const scene = makeScene();
	const marks = new SkidMarks( scene );
	const v = makeVehicle();

	marks.update( 1 / 60, v ); // stationary, not drifting
	test( 'no marks while parked', stampCount( marks ) === 0 );

	setDrifting( v );
	marks.update( 1 / 60, v ); // drift starts: anchor frame (no mark yet)
	test( 'first drifting frame only anchors', stampCount( marks ) === 0 );

	moveVehicle( v, 0.5, 0.5 );
	marks.update( 1 / 60, v );
	test( 'marks appear once moving while drifting', stampCount( marks ) === 2 ); // one per rear tire

	setDrifting( v, false );
	moveVehicle( v, 2, 2 );
	marks.update( 1 / 60, v );
	const afterStop = stampCount( marks );
	test( 'no new marks after drift ends', afterStop === 2 );

	setDrifting( v );
	marks.update( 1 / 60, v ); // re-anchor
	const beforeResume = stampCount( marks );
	moveVehicle( v, 0.3, 0.3 );
	marks.update( 1 / 60, v );
	const afterResume = stampCount( marks );
	test( 'resuming drift draws from the resume point (anchor, then marks)', afterResume - beforeResume === 2 );

	// High speed but no slip → no marks.
	const v2 = makeVehicle();
	v2.linearSpeed = 3.0;
	v2.driftIntensity = 0.1;
	const marks2 = new SkidMarks( makeScene() );
	marks2.update( 1 / 60, v2 );
	moveVehicle( v2, 1, 1 );
	marks2.update( 1 / 60, v2 );
	test( 'speed without drift intensity leaves no marks', stampCount( marks2 ) === 0 );

	// Drift intensity but crawling → no marks.
	const v3 = makeVehicle();
	v3.linearSpeed = 0.1;
	v3.driftIntensity = 1.5;
	const marks3 = new SkidMarks( makeScene() );
	marks3.update( 1 / 60, v3 );
	moveVehicle( v3, 0.01, 0.01 );
	marks3.update( 1 / 60, v3 );
	test( 'drift angle without speed leaves no marks', stampCount( marks3 ) === 0 );

}

console.log( '--- THE RESTART ARTIFACT (teleport mid-drift) ---' );

{
	const scene = makeScene();
	const marks = new SkidMarks( scene );
	const v = makeVehicle();

	// Drift out to the middle of the track.
	setDrifting( v );
	marks.update( 1 / 60, v );
	for ( let i = 0; i < 5; i ++ ) {

		moveVehicle( v, 0.6, 0.4 );
		marks.update( 1 / 60, v );

	}
	const beforeSnap = stampCount( marks );
	test( 'drifting around the track laid marks', beforeSnap === 10 ); // 5 moves x 2 tires (anchor doesn't stamp)

	// Restart: car snaps from (3.0, 2.0) back to the start block, still flagged drifting.
	v.container.position.x = 0;
	v.container.position.z = 0;
	v.wheelBL.worldPos.x = -0.55;
	v.wheelBL.worldPos.z = -1.0;
	v.wheelBR.worldPos.x = 0.55;
	v.wheelBR.worldPos.z = -1.0;
	marks.update( 1 / 60, v ); // the frame after the snap
	const afterSnap = stampCount( marks );
	test( 'NO line is drawn across the map on restart', afterSnap === beforeSnap );

	// And the trail cleanly continues from the start block afterwards.
	moveVehicle( v, 0.4, 0.4 );
	marks.update( 1 / 60, v );
	test( 'marks resume normally from the start block', stampCount( marks ) === beforeSnap + 2 );

}

console.log( '--- Trail break vs erase ---' );

{
	const scene = makeScene();
	const marks = new SkidMarks( scene );
	const v = makeVehicle();
	setDrifting( v );
	marks.update( 1 / 60, v );
	moveVehicle( v, 0.5, 0 );
	marks.update( 1 / 60, v );
	const laid = stampCount( marks );

	marks.breakVehicleTrail( v );
	test( 'breakVehicleTrail keeps existing marks', stampCount( marks ) === laid );
	// Next frame would need a fresh anchor — no connection to the old trail.
	moveVehicle( v, 0.5, 0 );
	marks.update( 1 / 60, v );
	test( 'broken trail re-anchors instead of connecting', stampCount( marks ) === laid ); // anchor only

	marks.clear();
	test( 'clear() erases everything', stampCount( marks ) === 0 );
	test( 'clear() resets for a fresh start', marks.cursor === 0 );

}

console.log( '--- Ring buffer + quality ---' );

{
	const scene = makeScene();
	const marks = new SkidMarks( scene, { maxSegments: 64 } ); // pool floor is 64
	const v = makeVehicle();
	setDrifting( v );
	marks.update( 1 / 60, v );
	for ( let i = 0; i < 200; i ++ ) {

		moveVehicle( v, 0.4, 0.1 );
		marks.update( 1 / 60, v );

	}
	test( 'pool stays bounded (recycles oldest)', marks.mesh.matrices.filter( ( m ) => m && m._basis ).length <= 64 );
	test( 'cursor wrapped safely', marks.cursor < 64 );

	marks.setQuality( { maxSegments: 0 } );
	test( 'maxSegments 0 disables emission', marks.enabled === false );
	marks.setQuality( {} );
	test( 'missing budget re-enables with the same pool', marks.enabled === true && marks.maxSegments === 64 );

}

console.log( '--- Multi-vehicle isolation ---' );

{
	const scene = makeScene();
	const marks = new SkidMarks( scene );
	const v1 = makeVehicle();
	const v2 = makeVehicle();
	v2.wheelBL.worldPos.x = 100; // far away — separate track
	v2.wheelBR.worldPos.x = 100.5;

	setDrifting( v1 );
	marks.update( 1 / 60, v1 );
	setDrifting( v2 );
	marks.update( 1 / 60, v2 );
	moveVehicle( v1, 0.5, 0 );
	marks.update( 1 / 60, v1 );
	moveVehicle( v2, 0.5, 0 );
	marks.update( 1 / 60, v2 );

	test( 'both split-screen cars lay their own marks', stampCount( marks ) === 4 );

	marks.breakVehicleTrail( v1 );
	moveVehicle( v1, 0.5, 0 );
	marks.update( 1 / 60, v1 );
	moveVehicle( v2, 0.5, 0 );
	marks.update( 1 / 60, v2 );
	test( 'breaking car 1 trail does not affect car 2', stampCount( marks ) === 6 );

}

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
