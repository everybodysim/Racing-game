// test-editor-drive.mjs — regression suite for the drive-in-editor feature:
// drivable test car (both modes) + Flat Map/Free Cam toggle.
// Static source checks (same style as the rest of the repo's suites).

import { readFileSync } from 'node:fs';

const html = readFileSync( './editor.html', 'utf8' );
const physics = readFileSync( './js/Physics.js', 'utf8' );
const vehicle = readFileSync( './js/Vehicle.js', 'utf8' );
const track = readFileSync( './js/Track.js', 'utf8' );

let pass = 0, fail = 0;
function test( name, cond ) {

	if ( cond ) { pass ++; console.log( `  ✓ ${ name }` ); }
	else { fail ++; console.log( `  ✗ ${ name }` ); }

}

console.log( 'Editor drive: module imports' );
test( 'importmap maps crashcat (same pinned version as the game)', html.includes( '"crashcat": "https://esm.sh/crashcat@0.0.2"' ) );
test( 'editor imports crashcat world/update functions', /import \{ createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody \} from 'crashcat'/.test( html ) );
test( 'editor imports buildWallColliders + createSphereBody from Physics.js', html.includes( "import { buildWallColliders, createSphereBody } from './js/Physics.js'" ) );
test( 'editor imports Vehicle from Vehicle.js', html.includes( "import { Vehicle } from './js/Vehicle.js'" ) );
test( 'editor imports computeSpawnPosition from Track.js', /computeSpawnPosition \} from '\.\/js\/Track\.js'/.test( html ) );
test( 'Physics.js null-safe for a missing debug group', physics.includes( 'if ( debugGroup )' ) );

console.log( 'Editor drive: camera modes' );
test( 'free perspective camera created alongside the ortho camera', html.includes( 'const freeCamera = new THREE.PerspectiveCamera' ) );
test( "camera mode state starts in 'flat'", /let editorCamMode = 'flat'/.test( html ) );
test( 'editorActiveCamera() helper exists', html.includes( 'function editorActiveCamera()' ) );
test( 'screenToGrid raycasts from the ACTIVE camera', html.includes( 'raycaster.setFromCamera( mouse, editorActiveCamera() )' ) );
test( 'animate() renders the ACTIVE camera', html.includes( 'renderer.render( scene, editorActiveCamera() )' ) );
test( 'animate() steps the drive physics every frame', html.includes( 'stepEditorDrive( dt )' ) );
test( 'resize keeps the free camera aspect in sync', html.includes( 'freeCamera.aspect = a;' ) );
test( 'View toggle button exists with a Respawn Car button', html.includes( 'id="btn-cam-mode"' ) && html.includes( 'id="btn-respawn-car"' ) );
test( 'drive hint chip exists', html.includes( 'id="drive-hint"' ) );

console.log( 'Editor drive: input wiring' );
test( 'arrow keys no longer pan the flat camera (they drive the car)', ! /ArrowUp' \) \{\s*camTarget\.z -= panStep/.test( html ) );
test( 'arrow keydown feeds editorDrive.onDriveKey', html.includes( "editorDrive.onDriveKey( e.key, true )" ) );
test( 'arrow keyup releases editorDrive.onDriveKey', html.includes( "editorDrive.onDriveKey( e.key, false )" ) );
test( 'free-mode right/middle/space drag starts camera rotation', /editorCamMode === 'free' && editorDrive && \( e\.button === 2 \|\| e\.button === 1 \|\| \( e\.button === 0 && \( e\.ctrlKey \|\| e\.metaKey \|\| spaceDown \) \) \)/.test( html ) );
test( 'pointermove routes to rotation while rotating', html.includes( 'editorDrive.isRotating()' ) );
test( 'free-mode wheel dollies instead of ortho-zooming', html.includes( 'editorDrive.dolly( e.deltaY )' ) );
test( 'free cam never clips below the floor', ( html.match( /Math\.max\( 0\.6, freeCamera\.position\.y \)/g ) || [] ).length >= 2 );
test( 'Shift+R respawns the car', html.includes( "e.key.toLowerCase() === 'r' ) { e.preventDefault(); respawn(); }" ) );

console.log( 'Editor drive: physics lifecycle' );
test( 'hoisted editorDrive handle is var (no TDZ when save() runs first)', html.includes( 'var editorDrive = null; // assigned by the drive section at the bottom' ) );
test( 'markEditorCollidersDirty guards on editorDrive', /function markEditorCollidersDirty\(\) \{ if \( editorDrive \) editorDrive\.markDirty\(\); \}/.test( html ) );
test( 'stepEditorDrive guards on editorDrive', /function stepEditorDrive\( dt \) \{ if \( editorDrive \) editorDrive\.step\( dt \); \}/.test( html ) );
test( 'save() marks colliders dirty so walls track edits', /function save\(\) \{\s*markEditorCollidersDirty\(\);/.test( html ) );
test( 'physics extras round-trip maps short keys to long keys', /water: m\.t === 'pool-filled' \? \[\] : m\.q,/.test( html ) && html.includes( 'poolSlopes: m.z' ) && html.includes( 'magnets: m.m' ) );
test( 'physics world built with the same layer setup as the game', ( () => {

	const i = html.indexOf( 'function buildWorld() {' );
	return html.slice( i, i + 900 ).includes( 'buildWallColliders( w, null, getCellsArray(), getPhysicsExtras() )' );

} )() );
test( 'colliders rebuild debounced after edit bursts settle', html.includes( 'now - lastEditAt < 0.4' ) );
test( 'rebuild preserves the car position across world swaps', html.includes( 'createSphereBody( newWorld, [ pos[ 0 ], Math.max( pos[ 1 ], 0.5 ), pos[ 2 ] ] )' ) );
test( 'vehicle body created with the game-identical spawn + perf', html.includes( 'vehicle.setPerformance( { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } )' ) );
test( 'car model gets the Godot 0.5 root scale fix', html.includes( 'gltf.scene.scale.setScalar( 0.5 );' ) );
test( 'car model materials forced FrontSide like the game loader', html.includes( "child.material.side = THREE.FrontSide;" ) );
test( 'drive input shape matches Vehicle.update (x/z axes)', /vehicle\.update\( dt, \{\s*x: \( driveKeys\.ArrowRight \? 1 : 0 \) - \( driveKeys\.ArrowLeft \? 1 : 0 \),\s*z: \( driveKeys\.ArrowUp \? 1 : 0 \) - \( driveKeys\.ArrowDown \? 1 : 0 \),/.test( html ) );
test( 'physics stepping passes a contact listener (crashcat contract)', html.includes( 'updateWorld( world, NOOP_CONTACT_LISTENER, dt )' ) );
test( 'Vehicle.update only consumes x/z from the input object', vehicle.includes( 'this.inputX = controlsInput.x;' ) && vehicle.includes( 'this.inputZ = controlsInput.z;' ) );
test( 'computeSpawnPosition returns { position, angle } used by setSpawn', track.includes( 'return { position: [ x, 0.5, z ], angle };' ) && html.includes( 'vehicle.setSpawn( spawn.position, spawn.angle )' ) );
test( 'respawn resets through Vehicle.resetToSpawn', html.includes( 'vehicle.resetToSpawn();' ) );
test( 'car init failure degrades gracefully (editing still works)', html.includes( 'Test car failed to load — editing still works' ) );
test( 'fly keys released on keyup', html.includes( "flyKeys.delete( e.code )" ) );

console.log( `\n${ pass } passed, ${ fail } failed${ fail > 0 ? ' — WITH FAILURES' : '' }` );
process.exit( fail > 0 ? 1 : 0 );
