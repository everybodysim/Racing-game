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
test( 'editor imports crashcat world/update functions (incl. box + MotionType for ground)', /import \{ createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType \} from 'crashcat'/.test( html ) );
test( 'editor imports buildWallColliders + createSphereBody from Physics.js', html.includes( "import { buildWallColliders, createSphereBody } from './js/Physics.js'" ) );
test( 'editor imports Vehicle from Vehicle.js', html.includes( "import { Vehicle } from './js/Vehicle.js'" ) );
test( 'editor imports computeSpawnPosition + bounds/pool-preset helpers from Track.js', /computeSpawnPosition, computeTrackBounds, computePoolPresetWaterCells \} from '\.\/js\/Track\.js'/.test( html ) );
test( 'Physics.js null-safe for a missing debug group', physics.includes( 'if ( debugGroup )' ) );

console.log( 'Editor drive: camera modes' );
test( 'free perspective camera created alongside the ortho camera', html.includes( 'const freeCamera = new THREE.PerspectiveCamera' ) );
test( "camera mode state starts in 'flat'", /let editorCamMode = 'flat'/.test( html ) );
test( 'editorActiveCamera() helper exists', html.includes( 'function editorActiveCamera()' ) );
test( 'screenToGrid raycasts from the ACTIVE camera', html.includes( 'raycaster.setFromCamera( mouse, editorActiveCamera() )' ) );
test( 'animate() renders the ACTIVE camera', html.includes( 'renderer.render( scene, editorActiveCamera() )' ) );
test( 'animate() steps the drive physics every frame', html.includes( 'stepEditorDrive( dt )' ) );
test( 'resize keeps the free camera aspect in sync', html.includes( 'freeCamera.aspect = a;' ) );
test( 'Camera mode is a dropdown (Flat / Free / Follow) + Respawn button, top-right', html.includes( 'id="cam-mode-select"' ) && ( html.match( /<option value="(flat|free|follow)"/g ) || [] ).length === 3 && html.includes( 'id="btn-respawn-car"' ) && html.includes( 'id="editor-cam-cluster"' ) );
test( 'follow cam chases behind the car using its heading', html.includes( 'function stepFollowCam' ) && /applyQuaternion\( vehicle\.container\.quaternion \)/.test( html ) && /editorCamMode === 'follow' \) \{ stepFollowCam\( dt \); return; \}/.test( html ) );
test( 'follow mode renders through the perspective free camera', /return \( editorCamMode === 'free' \|\| editorCamMode === 'follow' \) \? freeCamera : camera;/.test( html ) );
test( 'respawn recomputes spawn from the live grid (start block wins)', /function respawn\(\) \{[\s\S]*?computeSpawnPosition\( getCellsArray\(\) \);[\s\S]*?vehicle\.setSpawn\( spawn\.position, spawn\.angle \);[\s\S]*?vehicle\.resetToSpawn\(\);/.test( html ) );
test( 'placing a Start / Start-Finish block respawns the car onto it', /type === 'track-start' \|\| type === 'track-start-finish' \) editorDrive\?\.respawn\(\);/.test( html ) );
test( 'ground 4-way nudged up like the elevated 4-way (+0.1)', /roadPiece\.type === 'track-4-way' \? 0\.1 : 0/.test( html ) );
test( 'editor slope-up placed at ground level like the game (-ELEVATED_HEIGHT)', /normalizedType === 'slope-up' \? - ELEVATED_HEIGHT : 0/.test( html ) );
test( 'top-right cluster is fixed-positioned', /#editor-cam-cluster \{ position: fixed; top: 10px; right: 12px;/.test( html ) );
test( 'buttons no longer clutter the Run toolbar group', ! /btn-cam-mode" class="action"/.test( html ) );
test( 'drive hint chip exists', html.includes( 'id="drive-hint"' ) );
test( 'green ground no longer covers pools: per-cell tile patch with water holes', html.includes( 'function rebuildGroundTiles' ) && /\?\.water \) continue;/.test( html ) && ! /new THREE\.PlaneGeometry\( 200, 200 \)/.test( html ) );
test( 'ground hole recut hooks: water edits flag the patch dirty', /groundTilesDirty = true; \/\/ water added\/removed/.test( html ) );
test( 'ground hole recut hooks: rebuild runs in the render loop', /if \( groundTilesDirty \) \{ rebuildGroundTiles\(\); groundTilesDirty = false; \}/.test( html ) );
test( 'ground surround frame fills outside the grid (no seams)', /const groundFrame = new THREE\.Group\(\);/.test( html ) && html.includes( 'groundFrame.add( strip )' ) );
console.log( 'Editor drive: car-affecting blocks (magnets / arcs / portals / pads / surfaces)' );
test( 'physics extras now include surfaces + arcLinks', /surfaces: m\.u,/.test( html ) && /arcLinks: m\.a,/.test( html ) );
test( 'magnet force applied per frame (blue pulls, red pushes, curved falloff)', html.includes( 'function fxApplyMagnetForceFor' ) && /if \( magnet\.kind === 'red' \) _fxMagnetDir\.multiplyScalar\( - 1 \);/.test( html ) && /Math\.pow\( 1 - tf, 1\.6 \)/.test( html ) );
test( 'arc links + portals trigger with game-identical radius and ballistics', html.includes( 'function fxApplyArcLinkFor' ) && /FX_ARC_LINK_TRIGGER_RADIUS = CELL_RAW \* GRID_SCALE \* 0\.32;/.test( html ) && /const vy = \( ty \+ 0\.5 \* gravity \* travelTime \* travelTime \) \/ travelTime;/.test( html ) );
test( 'purple portal teleports and keeps velocity', /portal-purple' \) \{[\s\S]*?rigidBody\.setPosition\( world, targetVehicle\.rigidBody, \[ pair\.centerX, pair\.centerY, pair\.centerZ \], false \);[\s\S]*?velocity kept/.test( html ) );
test( 'pads: contact detection, effect combining, input modifiers, time + gravity scale', html.includes( 'function fxApplyPadContact' ) && html.includes( 'function fxCombinePadEffects' ) && html.includes( 'function fxApplyPadInputModifiers' ) && /fxActivePadEffect\?\.timeScale/.test( html ) && /fxActivePadEffect\?\.gravity/.test( html ) );
test( 'surfaces: grip/drag/accel/drive multipliers like the game', html.includes( 'function fxApplySurfaceGrip' ) && /FX_SURFACE_EFFECTS = \{[\s\S]*?'surface-ice'/.test( html ) && /FX_GARAGE_FIXED_MULTIPLIER = 1\.15;/.test( html ) );
test( 'special surfaces: bounce, kicks, custom forces with once-per-contact latch', html.includes( 'function fxApplySpecialSurfacesFor' ) && /'surface-bounce': \( targetVehicle \) => fxApplySurfaceBounceFor\( targetVehicle \),/.test( html ) && /oncePerContact/.test( html ) );
test( 'boost surfaces: impulse + sustained accel like the game', html.includes( 'function fxApplyBoostFor' ) && /FX_BOOST_VELOCITY_DELTA = 8\.2;/.test( html ) && /FX_BOOST_ACCEL_PER_SECOND = 16\.5;/.test( html ) );
test( 'trick pads: air-trick spin + recovery copied into the editor', html.includes( 'function fxUpdateAirTrickStateFor' ) && /FX_AIR_TRICK_DURATION_SECONDS = 0\.62;/.test( html ) );
test( 'size pads rescale the car', html.includes( 'function fxApplyVehicleScaleFromPad' ) && /container\.scale\.setScalar\( nextScale \)/.test( html ) );
test( 'step wiring: effects run in the game loop order (magnet → arc → gravity → pad → boost → special → trick → grip)', /fxApplyMagnetForceFor\( vehicle, fxdt \);[\s\S]*?fxApplyArcLinkFor\( vehicle, fxArcLinkState \);[\s\S]*?gravityFactor = FX_VEHICLE_BASE_GRAVITY_FACTOR[\s\S]*?fxApplyPadContact\( vehicle[\s\S]*?fxApplyBoostFor\( vehicle, fxClock \);[\s\S]*?fxApplySpecialSurfacesFor\( vehicle, fxSpecialContactState \);[\s\S]*?fxApplySurfaceGrip\( vehicle, activeSurfaceType, fxActivePadEffect \);/.test( html ) );
test( 'effect entries rebuild with the colliders + on drive init', /rebuildMovingState\(\);\n[\s\S]{0,120}rebuildEffectEntries\(\);/.test( html ) && ( html.match( /rebuildEffectEntries\(\);/g ) || [] ).length >= 2 );
test( 'no game-runtime edits: fx subsystem is editor-local (main.js has no fxApply*)', ! /fxApply/.test( readFileSync( './js/main.js', 'utf-8' ) ) );

test( 'Special Parts bar is the original flat 212px 2-column bar', /#side-ui-bar \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?width: 212px;/.test( html ) && ! /<details id="side-ui-bar"/.test( html ) );

console.log( 'Editor drive: input wiring' );
test( 'arrow keys no longer pan the flat camera (they drive the car)', ! /ArrowUp' \) \{\s*camTarget\.z -= panStep/.test( html ) );
test( 'arrow keydown feeds editorDrive.onDriveKey', html.includes( "editorDrive.onDriveKey( e.key, true )" ) );
test( 'arrow keyup releases editorDrive.onDriveKey', html.includes( "editorDrive.onDriveKey( e.key, false )" ) );
test( 'free-mode MIDDLE-drag rotates the camera', /editorCamMode === 'free' && editorDrive && e\.button === 1 \) \{\s*editorDrive\.startRotate/.test( html ) );
test( 'right-click is NOT captured for rotate (erase keeps working in free mode)', ! /e\.button === 2 \|\| e\.button === 1/.test( html ) );
test( 'flat pan branch (middle/ctrl/space) is flat-mode only', /editorCamMode === 'flat' && \( e\.button === 1 \|\|/.test( html ) );
test( 'pointermove routes to rotation while rotating', html.includes( 'editorDrive.isRotating()' ) );
test( 'free-mode wheel dollies instead of ortho-zooming', html.includes( 'editorDrive.dolly( e.deltaY )' ) );
test( 'free cam never clips below the floor', ( html.match( /Math\.max\( 0\.6, freeCamera\.position\.y \)/g ) || [] ).length >= 2 );
test( 'Space flies UP and Ctrl flies DOWN in free mode', /flyKeys\.has\( 'KeyE' \) \|\| flyKeys\.has\( 'Space' \) \) move\.y \+= 1;/.test( html ) && /flyKeys\.has\( 'KeyQ' \) \|\| flyKeys\.has\( 'ControlLeft' \)/.test( html ) );
test( 'space-grab cursor only engages in flat mode', /editorCamMode === 'flat' && ! spaceDown/.test( html ) );
test( 'Shift+R respawns the car', html.includes( "e.key.toLowerCase() === 'r' ) { e.preventDefault(); respawn(); }" ) );
test( 'Shift is never a drive input and clears any held drive state', /if \( e\.key === 'Shift' \) \{[\s\S]{0,260}editorDrive\?\.clearDriveKeys\?\.\(\);/.test( html ) && /function clearDriveKeys\(\) \{[\s\S]{0,100}driveKeys\[ key \] = false;/.test( html ) && /if \( e\.shiftKey && ! modifier \) return;/.test( html ) );

console.log( 'Editor drive: physics lifecycle' );
test( 'hoisted editorDrive handle is var (no TDZ when save() runs first)', html.includes( 'var editorDrive = null; // assigned by the drive section at the bottom' ) );
test( 'markEditorCollidersDirty guards on editorDrive', /function markEditorCollidersDirty\(\) \{ if \( editorDrive \) editorDrive\.markDirty\(\); \}/.test( html ) );
test( 'stepEditorDrive guards on editorDrive', /function stepEditorDrive\( dt \) \{ if \( editorDrive \) editorDrive\.step\( dt \); \}/.test( html ) );
test( 'save() marks colliders dirty so walls track edits', /function save\(\) \{\s*markEditorCollidersDirty\(\);/.test( html ) );
test( 'physics extras round-trip maps short keys to long keys', html.includes( 'water: m.q,' ) && html.includes( 'poolSlopes: m.z' ) && html.includes( 'magnets: m.m' ) );
test( 'pool-filled preset floods non-track cells like the game', /if \( m\.t === 'pool-filled' \) \{[\s\S]*?computePoolPresetWaterCells\( getCellsArray\(\), extras \)/.test( html ) );
test( 'ground colliders built for the drive world (car can no longer fall through on spawn)', /buildWallColliders\( w, null, cellsArr, extras \);\s*addGroundColliders\( w, cellsArr, extras \);/.test( html ) );
test( 'ground uses one thick slab when no water cells', html.includes( 'if ( waterSet.size === 0 ) {' ) && html.includes( 'GROUND_HALF_H = 0.5' ) );
test( 'ground runs skip water cells so cars drop into pools', /waterSet\.has\( `\$\{ gx \},\$\{ gz \}` \)/.test( html ) && html.includes( 'function flushRun(' ) );
test( 'spawn/rest y matches the game ground (top at -0.115)', html.includes( 'groundTopY = - 0.125 + 0.01' ) );
test( 'respawn does NOT move the camera', ! /freeCamera\.position\.set\( vehicle\.spherePos/.test( html ) );
test( 'physics world built with the same layer setup as the game', ( () => {

	const i = html.indexOf( 'function buildWorld() {' );
	return html.slice( i, i + 1200 ).includes( 'buildWallColliders( w, null, cellsArr, extras )' );

} )() );
test( 'colliders rebuild debounced after edit bursts settle', html.includes( 'now - lastEditAt < 0.4' ) );
test( 'rebuild preserves the car position across world swaps', html.includes( 'createSphereBody( newWorld, [ pos[ 0 ], Math.max( pos[ 1 ], 0.5 ), pos[ 2 ] ] )' ) );
test( 'vehicle body created with the game-identical spawn + perf', html.includes( 'vehicle.setPerformance( { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } )' ) );
test( 'car model gets the Godot 0.5 root scale fix', html.includes( 'gltf.scene.scale.setScalar( 0.5 );' ) );
test( 'car model materials forced FrontSide like the game loader', html.includes( "child.material.side = THREE.FrontSide;" ) );
test( 'drive input shape matches Vehicle.update (x/z axes), pad-modified', /const padAdjustedInput = fxApplyPadInputModifiers\( \{\s*x: \( driveKeys\.ArrowRight \? 1 : 0 \) - \( driveKeys\.ArrowLeft \? 1 : 0 \),\s*z: \( driveKeys\.ArrowUp \? 1 : 0 \) - \( driveKeys\.ArrowDown \? 1 : 0 \),\s*y: 0,\s*\}, fxActivePadEffect \);/.test( html ) && html.includes( 'vehicle.update( fxdt, padAdjustedInput )' ) );
test( 'physics stepping passes a contact listener (crashcat contract)', html.includes( 'updateWorld( world, NOOP_CONTACT_LISTENER, fxdt )' ) );
test( 'Vehicle.update only consumes x/z from the input object', vehicle.includes( 'this.inputX = controlsInput.x;' ) && vehicle.includes( 'this.inputZ = controlsInput.z;' ) );
test( 'computeSpawnPosition returns { position, angle } used by setSpawn', track.includes( 'return { position: [ x, 0.5, z ], angle };' ) && html.includes( 'vehicle.setSpawn( spawn.position, spawn.angle )' ) );
test( 'respawn resets through Vehicle.resetToSpawn', html.includes( 'vehicle.resetToSpawn();' ) );
test( 'car init failure degrades gracefully (editing still works)', html.includes( 'Test car failed to load — editing still works' ) );
test( 'fly keys released on keyup', html.includes( "flyKeys.delete( e.code )" ) );

console.log( `\n${ pass } passed, ${ fail } failed${ fail > 0 ? ' — WITH FAILURES' : '' }` );
process.exit( fail > 0 ? 1 : 0 );
