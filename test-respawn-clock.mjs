// Start/finish auto-respawn reliability test suite.
//
// Bug: at ~20 FPS, crossing the finish with separate start + finish blocks
// sometimes restarted the timer but never respawned the player. Root causes
// fixed in js/main.js:
//
//   1. The respawn was a REAL-TIME setTimeout armed 30 lines into the
//      lap-completion block — any throw in the share-snapshot/leaderboard
//      bookkeeping (exactly the code that strains on a laggy frame) skipped
//      arming it entirely.
//   2. A 500ms real timer at 20 FPS fires at a random point relative to
//      50ms-long frames, compounding with throttling.
//
// Fix: the respawn is scheduled on the GAME CLOCK (timestamp checked every
// frame) and armed FIRST in the lap block — deterministic at any frame rate.
// Run: node test-respawn-clock.mjs

import { readFileSync } from 'node:fs';

const main = readFileSync( './js/main.js', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

// 1. Game-clock scheduling, not real-time timers
test( 'pending respawn is a game-clock timestamp', /let autoRespawnAtSeconds = null;/.test( main ) && /let autoRespawnAtSeconds2 = null;/.test( main ) );
test( 'vehicle 1 scheduled at +0.5 game seconds', /scheduleAutoRespawnVehicle\(\) \{\s*autoRespawnAtSeconds = raceClockSeconds \+ 0\.5;/.test( main ) );
test( 'vehicle 2 scheduled at +0.5 game seconds', /scheduleAutoRespawnVehicle2\(\) \{\s*autoRespawnAtSeconds2 = raceClockSeconds \+ 0\.5;/.test( main ) );
test( 'no real-time setTimeout left in the respawn path', ! /setTimeout\(\s*\(\) => \{\s*respawnVehicle/.test( main ) );
test( 'old timer ids fully removed', ! main.includes( 'autoRespawnTimerId' ) );

// 2. Frame loop fires due respawns deterministically
test( 'frame loop checks vehicle 1 due-time', /if \( autoRespawnAtSeconds !== null && now >= autoRespawnAtSeconds \) \{\s*autoRespawnAtSeconds = null;\s*respawnVehicle\(\);/.test( main ) );
test( 'frame loop checks vehicle 2 due-time (gated on vehicle2)', /if \( autoRespawnAtSeconds2 !== null && vehicle2 && now >= autoRespawnAtSeconds2 \)/.test( main ) );
test( 'due-checks run in the main update, before controls read', main.indexOf( 'updateWaterQuality( rollingFps );' ) > -1 && main.indexOf( 'autoRespawnAtSeconds !== null && now >=' ) < main.indexOf( 'const controlsBlocked =' ) );

// 3. Scheduled FIRST in the lap block — a throw later can never eat it
const lapBlockStart = main.indexOf( 'if ( hasLeftStartZone && allCheckpointsPassed && crossedFinish ) {' );
const lapSnapshotIdx = main.indexOf( 'createShareSnapshot( bestLapSeconds )', lapBlockStart );
test( 'vehicle 1 respawn armed before the share-snapshot bookkeeping', lapBlockStart > -1 && lapSnapshotIdx > -1 && main.indexOf( 'scheduleAutoRespawnVehicle();', lapBlockStart ) < lapSnapshotIdx );
test( 'exactly one schedule call per vehicle (moved, not duplicated)', main.split( 'scheduleAutoRespawnVehicle();' ).length - 1 === 1 && main.split( 'scheduleAutoRespawnVehicle2();' ).length - 1 === 1 );

const lapBlock2 = main.indexOf( 'if ( hasLeftStartZone2 && allCheckpointsPassed2 && crossedFinish ) {' );
test( 'vehicle 2 respawn armed first in its lap block too', lapBlock2 > -1 && main.indexOf( 'scheduleAutoRespawnVehicle2();', lapBlock2 ) - lapBlock2 < 220 );

// 4. respawnVehicle clears the pending stamp (manual respawn cancels auto)
test( 'respawnVehicle clears pending stamp', /autoRespawnAtSeconds = null;\s*vehicle\.resetToSpawn\(\);/.test( main ) );
test( 'respawnVehicle2 clears its pending stamp', /autoRespawnAtSeconds2 = null;\s*vehicle2\.resetToSpawn\(\);/.test( main ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
