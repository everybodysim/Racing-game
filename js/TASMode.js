// js/TASMode.js — game-side TAS mode (?tas=1), see docs/tas-editor-plan.md.
// Only loaded when ?tas=1 is in the game URL; normal gameplay never imports
// this module and no game runtime file changes for TAS behavior.
//
// MODEL:
// - RECORD (?tas=1 open, Try again, R): 3-2-1 countdown FIRST — the timer,
//   the step counter and recording all start only when it ends. On loop
//   tracks BOTH laps are recorded (lap 1 stays editable in the script);
//   position, velocity, angular velocity and rotation are captured at the
//   lap-1 -> lap-2 crossing at FULL precision (Number<->String round-trips
//   are exact) so lap 2 replays are deterministic.
// - RUN, skip mode (editor checkbox OFF, default): jump straight to lap 2 —
//   respawn, apply the recorded crossing state, inject instantly.
// - RUN, play-lap-1 mode (checkbox ON): mirrors the recording exactly —
//   countdown settle first (the recording's lap 1 started post-settle;
//   replaying from a fresh unsettled spawn made lap 1 drift until it
//   missed the finish), then lap 1, then the recorded state at the line,
//   then lap 2. Legacy pre-v6 scripts keep their instant-start behavior.

import { contacts } from 'crashcat';

const TAS_STEP_HZ = 60;

function zeroInput() { return { x: 0, z: 0 }; }

export function activate( ctx ) {

	if ( window.__tasActive ) return;
	window.__tasActive = true;

	const lapsNeeded = ctx.isLoop ? 2 : 1;

	const state = {
		phase: 'record',           // record | run | done
		fastForward: false,        // true during the synchronous lap-1 burst
		brute: null,               // active brute-force session object
		bruteResult: null,         // timed-lap seconds captured in brute mode
		wipeFails: 0,
		started: false,            // true once the countdown has ended
		stepIndex: 0,              // per-lap step counter
		lastRecorded: null,
		lapsCompleted: 0,
		lapBuffers: [ [] ],        // per-lap RLE buffers of {step, x, z}
		crossState: null,          // lap-1 -> lap-2 crossing state, FULL precision
		runScript: null,
		runEntries: null,          // active replay timeline (lap1 or lap2)
		runPointer: 0,
		runLaps: 1,
		lastRunText: '',
		overlayTick: 0,
		playback: { lap1CrossStep: null, totalSteps: null, time: null },
		paused: false,
		pausePos: null,
		pauseRot: null,
		calc: false,
		probeErr: null,
		skipMode: false,
	};

	window.__tasState = () => {
		const mp = ctx.vehicle.rigidBody?.motionProperties;
		return {
			phase: state.phase,
			lapsCompleted: state.lapsCompleted,
			started: state.started,
			countdownActive: ctx.get.countdownActive(),
			stepIndex: state.stepIndex,
			inputsRecorded: state.lapBuffers.reduce( ( n, b ) => n + b.length, 0 ),
			wipeFails: state.wipeFails,
			brute: state.brute ? { round: state.brute.round, rounds: state.brute.rounds, adopted: state.brute.adopted, best: state.brute.best, last: state.brute.last } : null,
			mutate: ( text, n, add ) => scriptToText( mutateScript( parseScript( text ), n, add ) ),
			det: ctx.get.lapDetection ? ctx.get.lapDetection() : null,
			playback: state.playback,
			paused: state.paused,
			probeErr: state.probeErr || null,
			isLoop: ctx.isLoop,
			pos: [ ctx.vehicle.spherePos.x, ctx.vehicle.spherePos.y, ctx.vehicle.spherePos.z ],
			vel: mp ? [ ...mp.linearVelocity ] : [ 0, 0, 0 ],
			yaw: ctx.vehicle.container.rotation.y,
		};
	};

	// crashcat keeps persistent contact pairs with warm-start solver
	// impulses; the history carried INTO lap 2 differed between sessions
	// that drove lap 1 (a lap of contact history) and ones that skipped it
	// (teleported in). Every lap-2 boundary in EVERY session — recording
	// crossings, play-mode crossings, skip-mode starts, retries — wipes the
	// car's contact records, so all sessions start lap 2 from the same
	// clean engine state: exact recorded pos/vel/angvel/rot + zero
	// warm-start. Fresh contacts re-form on the next step.
	function resetCarPhysicsHistory() {

		try {

			const body = ctx.vehicle.rigidBody;
			if ( body && ctx.world?.contacts ) {

				contacts.destroyBodyContacts( ctx.world.contacts, ctx.world.bodies, body );
				ctx.rigidBodyApi.wake?.( ctx.world, body );

			}

		} catch ( e ) { state.wipeFails ++; }

	}

	const post = ( type, payload ) => {

		if ( window.parent && window.parent !== window ) window.parent.postMessage( { type, ...payload }, '*' );

	};

	// ── UI wipe: nothing except what TAS uses stays in the viewport ─────
	const KEEP_SELECTOR = '#loading-screen, #countdown-hud, #export-ghost-btn, #import-ghost-btn, #tas-overlay, #replay-topbar';
	const KEEP_IDS = new Set( [ 'loading-screen', 'countdown-hud', 'export-ghost-btn', 'import-ghost-btn', 'tas-overlay', 'replay-topbar' ] );
	const hideStyle = document.createElement( 'style' );
	hideStyle.textContent = '.tas-hide { display: none !important; }';
	document.head.appendChild( hideStyle );
	const spine = new Set();
	function markHidden( el ) {

		if ( ! el || el.nodeType !== 1 ) return;
		if ( el.tagName === 'CANVAS' ) return; // canvases are the game view, never UI
		if ( spine.has( el ) || KEEP_IDS.has( el.id ) || el.closest( KEEP_SELECTOR ) ) return;
		el.classList.add( 'tas-hide' );

	}
	function wipeUi() {

		const canvases = document.querySelectorAll( 'canvas' );
		if ( ! canvases.length ) return; // no canvas yet — static list only (safety)
		spine.clear();
		for ( const canvas of canvases ) {

			spine.add( canvas );
			for ( let el = canvas.parentElement; el && el !== document.body; el = el.parentElement ) spine.add( el );

		}
		for ( const el of document.querySelectorAll( 'body *' ) ) markHidden( el );

	}
	wipeUi();
	// Late-added DOM (toasts, popups) gets hidden too — but only added nodes,
	// so per-frame HUD text updates cost nothing.
	new MutationObserver( ( mutations ) => {

		for ( const m of mutations ) for ( const node of m.addedNodes ) {

			if ( node.nodeType !== 1 ) continue;
			if ( node.id === 'tas-overlay' ) continue;
			markHidden( node );
			for ( const child of node.querySelectorAll ? node.querySelectorAll( '*' ) : [] ) markHidden( child );

		}

	} ).observe( document.body, { childList: true, subtree: true } );

	// First open needs its countdown too: main.js's own boot call runs before
	// this module sets countdownEnabled, so start one here.
	try { ctx.fns.startCountdown(); } catch ( e ) { /* retry()/R also start it */ }

	// ── Crossing state capture / apply (FULL precision) ─────────────────
	function captureCrossState() {

		const v = ctx.vehicle;
		const mp = v.rigidBody?.motionProperties;
		return {
			pos: [ v.spherePos.x, v.spherePos.y, v.spherePos.z ],
			vel: mp ? [ ...mp.linearVelocity ] : [ 0, 0, 0 ],
			angvel: mp ? [ ...mp.angularVelocity ] : [ 0, 0, 0 ],
			rot: [ v.container.rotation.x, v.container.rotation.y, v.container.rotation.z ],
			// Gameplay state the record carries across the line but respawn
			// zeroes: boost timer, pad effect state, boost contact memory,
			// arc-link state, vehicle speed accumulators.
			game: ctx.get.gameState?.() ?? null,
		};

	}

	function applyCrossState( cs ) {

		if ( ! cs ) return;
		const v = ctx.vehicle;
		const body = v.rigidBody;
		if ( body ) {

			if ( ctx.rigidBodyApi.setPosition ) ctx.rigidBodyApi.setPosition( ctx.world, body, cs.pos, false );
			if ( cs.vel && ctx.rigidBodyApi.setLinearVelocity ) ctx.rigidBodyApi.setLinearVelocity( ctx.world, body, cs.vel );
			if ( cs.angvel && ctx.rigidBodyApi.setAngularVelocity ) ctx.rigidBodyApi.setAngularVelocity( ctx.world, body, cs.angvel );

		}
		v.spherePos.set( cs.pos[ 0 ], cs.pos[ 1 ], cs.pos[ 2 ] );
		if ( cs.rot ) {

			v.container.rotation.set( cs.rot[ 0 ], cs.rot[ 1 ], cs.rot[ 2 ] );
			v.container.quaternion.setFromEuler( v.container.rotation );

		}
		if ( cs.game && ctx.fns.restoreGameState ) ctx.fns.restoreGameState( cs.game );

	}

	// ── Script build / parse ──────────────────────────────────────────
	function fmt( n ) { return String( n ); }

	function buildScript() {

		const lines = [ '# Skid Circuit TAS v11', `track: ${ ctx.trackId }`, 'mode: run' ];
		if ( ctx.isLoop && state.crossState ) {

			lines.push( `state: pos ${ state.crossState.pos.map( fmt ).join( ' ' ) }` );
			lines.push( `state: vel ${ state.crossState.vel.map( fmt ).join( ' ' ) }` );
			lines.push( `state: angvel ${ state.crossState.angvel.map( fmt ).join( ' ' ) }` );
			lines.push( `state: rot ${ state.crossState.rot.map( fmt ).join( ' ' ) }` );
			if ( state.crossState.game ) lines.push( `state: game ${ JSON.stringify( state.crossState.game ) }` );

		}
		const lap1 = state.lapBuffers[ 0 ] || [];
		for ( const entry of lap1 ) lines.push( `step ${ entry.step } x=${ fmt( entry.x ) } z=${ fmt( entry.z ) }` );
		if ( ctx.isLoop ) {

			lines.push( 'cross' );
			for ( const entry of state.lapBuffers[ 1 ] || [] ) lines.push( `step ${ entry.step } x=${ fmt( entry.x ) } z=${ fmt( entry.z ) }` );

		}
		lines.push( 'end' );
		return lines.join( '\n' );

	}

	function parseScript( text ) {

		const script = { mode: 'run', crossState: null, lap1: [], lap2: [], errors: [], ver: 0 };
		const num = ( s ) => Number( s );
		let lastStep = -1;
		let inLap2 = false;
		for ( const rawLine of String( text ).split( /\r?\n/ ) ) {

			const verMatch = /^#\s*Skid Circuit TAS v(\d+)/.exec( rawLine );
			if ( verMatch ) script.ver = num( verMatch[ 1 ] );
			const line = rawLine.replace( /#.*$/, '' ).trim();
			if ( ! line ) continue;
			if ( line === 'end' ) break;
			if ( line.startsWith( 'track:' ) || line.startsWith( 'Skid Circuit TAS' ) ) continue;
			if ( line === 'cross' ) {

				inLap2 = true;
				lastStep = -1;
				continue;

			}
			if ( line.startsWith( 'mode:' ) ) {

				const mode = line.slice( 5 ).trim();
				if ( mode !== 'run' && mode !== 'lap1' && mode !== 'lap2' ) script.errors.push( `unknown mode "${ mode }"` );
				else script.mode = mode;
				continue;

			}
			if ( line.startsWith( 'state: game' ) ) {

				try {

					const game = JSON.parse( line.slice( 'state: game'.length ).trim() );
					script.crossState = script.crossState || {};
					script.crossState.game = game;

				} catch ( e ) { script.errors.push( `bad game state line: "${ line.slice( 0, 80 ) }"` ); }
				continue;

			}
			if ( line.startsWith( 'state:' ) ) {

				const [ kind, ...nums ] = line.slice( 6 ).trim().split( /\s+/ );
				const values = nums.map( num );
				if ( ! [ 'pos', 'vel', 'angvel', 'rot' ].includes( kind ) || values.length !== 3 || values.some( ( v ) => ! Number.isFinite( v ) ) ) {

					script.errors.push( `bad state line: "${ line }"` );
					continue;

				}
				script.crossState = script.crossState || {};
				script.crossState[ kind ] = values;
				continue;

			}
			if ( line.startsWith( 'step' ) ) {

				const parts = line.slice( 4 ).trim().split( /\s+/ );
				const step = num( parts[ 0 ] );
				if ( ! Number.isInteger( step ) || step < 0 || step <= lastStep ) {

					script.errors.push( `bad/unordered step line: "${ line }"` );
					continue;

				}
				lastStep = step;
				const kv = { x: 0, z: 0 };
				for ( const part of parts.slice( 1 ) ) {

					const m = /^(x|z)=(-?[0-9.eE+]+)$/.exec( part );
					if ( m ) kv[ m[ 1 ] ] = num( m[ 2 ] );
					else script.errors.push( `bad token "${ part }" in: "${ line }"` );

				}
				const entry = { step, x: clampInput( kv.x ), z: clampInput( kv.z ) };
				( inLap2 ? script.lap2 : script.lap1 ).push( entry );
				continue;

			}
			script.errors.push( `unrecognized line: "${ line }"` );

		}
		// legacy 'lap2' scripts carry the lap-2 timeline only
		if ( script.mode === 'lap2' && script.lap2.length === 0 && script.lap1.length ) script.lap2 = script.lap1, script.lap1 = [];
		if ( script.mode === 'lap2' && ( ! script.crossState?.pos || ! script.crossState?.vel ) ) {

			script.errors.push( 'lap2 scripts need "state: pos" and "state: vel" lines' );

		}
		if ( ! script.lap1.length && ! script.lap2.length ) script.errors.push( 'no step lines' );
		return script;

	}

	function clampInput( v ) { return Number.isFinite( v ) ? Math.max( -1, Math.min( 1, v ) ) : 0; }

	function scriptInputAt( i ) {

		const entries = state.runEntries;
		if ( ! entries || ! entries.length ) return zeroInput();
		while ( state.runPointer < entries.length - 1 && entries[ state.runPointer + 1 ].step <= i ) state.runPointer ++;
		const e = entries[ state.runPointer ];
		return e && e.step <= i ? { x: e.x, z: e.z } : zeroInput();

	}

	// ── Per-step hook (called from runSimulationStep after pad modifiers) ──
	function step( input ) {

		state.overlayTick ++;

		if ( state.phase === 'record' ) {

			if ( ! state.started ) {

				// Countdown: timer stays at 0, steps stay at 0, nothing is
				// recorded until the countdown has fully ended.
				if ( ctx.get.countdownActive() ) {

					if ( state.overlayTick % 6 === 0 ) updateOverlay();
					return input;

				}
				state.started = true;
				state.stepIndex = 0;

			}
			const buffer = state.lapBuffers[ state.lapBuffers.length - 1 ];
			if ( state.lastRecorded === null || state.lastRecorded.x !== input.x || state.lastRecorded.z !== input.z ) {

				buffer.push( { step: state.stepIndex, x: input.x, z: input.z } );
				state.lastRecorded = { x: input.x, z: input.z };

			}
			state.stepIndex ++;
			if ( state.overlayTick % 6 === 0 ) updateOverlay();
			return input;

		}

		if ( state.phase === 'run' && state.runScript ) {

			// Play-lap-1 mode arms exactly like the recorder: no injection
			// until the countdown has fully ended.
			if ( ! state.started ) {

				if ( ctx.get.countdownActive() ) {

					if ( state.overlayTick % 6 === 0 ) updateOverlay();
					return zeroInput();

				}
				state.started = true;
				state.stepIndex = 0;

			}
			const scripted = scriptInputAt( state.stepIndex );
			if ( state.overlayTick % 6 === 0 ) {

				updateOverlay();
				post( 'tas-step', {
					global: globalStep(),
					total: state.playback.totalSteps,
					lap: Math.min( state.lapsCompleted + 1, state.runLaps ),
					entry: state.runPointer,
				} );

			}
			state.stepIndex ++;
			return scripted;

		}

		// done: freeze driving
		if ( state.overlayTick % 6 === 0 ) updateOverlay();
		return zeroInput();

	}

	// Per-burst-step mirror of the game's lap detection (main.js runs it
	// once per FRAME; bursts run hundreds of raw steps with no frames, so
	// crossings mid-burst are invisible to the game). Physics-relevant
	// effects only: checkpoint pass flags + pad clears + checkpoint
	// respawn save + start-zone exit + the finish crossing into
	// onLapComplete(crossT). Ghost HUD deltas / mod events are skipped
	// (cosmetic). Primitives are written back through writeLapDetection so
	// the game's per-frame detector never double-fires or desyncs.
	function probeLapCross() {

		try {

			probeLapCrossInner();

		} catch ( e ) {

			if ( ! state.probeErr ) state.probeErr = String( e && e.message || e );
			throw e; // burst loops abort on a broken probe instead of looping blind

		}

	}

	function probeLapCrossInner() {

		const det = ctx.get.lapDetection();
		if ( ! det ) return;
		const v = ctx.vehicle;

		// checkpoints: exact game math (zero-inclusive plane test +
		// interpolation + xCross gate; passedThisLap keeps it forward-only)
		if ( det.checkpointStates ) {

			for ( const checkpoint of det.checkpointStates ) {

				const localX = ( ( v.spherePos.x - checkpoint.centerX ) * checkpoint.cosA ) + ( ( v.spherePos.z - checkpoint.centerZ ) * checkpoint.sinA );
				const localZ = ( - ( v.spherePos.x - checkpoint.centerX ) * checkpoint.sinA ) + ( ( v.spherePos.z - checkpoint.centerZ ) * checkpoint.cosA );
				if ( checkpoint.hasPrevSample ) {

					const z0 = checkpoint.lastLocalZ;
					const z1 = localZ;
					const crossedPlane = ( z0 <= 0 && z1 >= 0 ) || ( z0 >= 0 && z1 <= 0 );
					if ( crossedPlane ) {

						const t = z0 / ( z0 - z1 );
						const xCross = checkpoint.lastLocalX + ( localX - checkpoint.lastLocalX ) * t;
						if ( t >= 0 && t <= 1 && Math.abs( xCross ) <= checkpoint.halfExtent && ! checkpoint.passedThisLap ) {

							checkpoint.passedThisLap = true;
							ctx.fns.restoreGameState( { activePadEffect: null, activePadTimeScale: 1, padContactKey: null } );
							if ( det.checkpointRespawnInstalled && ctx.fns.saveCheckpointState ) ctx.fns.saveCheckpointState( checkpoint );

						}

					}

				}
				checkpoint.lastLocalX = localX;
				checkpoint.lastLocalZ = localZ;
				checkpoint.hasPrevSample = true;

			}

		}

		if ( ! det.finishData ) return;
		const fd = det.finishData;
		const localX = ( ( v.spherePos.x - fd.centerX ) * fd.cosA ) + ( ( v.spherePos.z - fd.centerZ ) * fd.sinA );
		const localZ = ( - ( v.spherePos.x - fd.centerX ) * fd.sinA ) + ( ( v.spherePos.z - fd.centerZ ) * fd.cosA );
		const sd = det.startGateData || fd;
		const startLocalX = ( ( v.spherePos.x - sd.centerX ) * sd.cosA ) + ( ( v.spherePos.z - sd.centerZ ) * sd.sinA );
		const startLocalZ = ( - ( v.spherePos.x - sd.centerX ) * sd.sinA ) + ( ( v.spherePos.z - sd.centerZ ) * sd.cosA );
		const inStartCell = Math.abs( startLocalX ) < sd.halfExtent && Math.abs( startLocalZ ) < sd.halfExtent;
		if ( ! det.hasLeftStartZone && ! inStartCell ) det.hasLeftStartZone = true;

		let crossedFinish = false;
		let crossedAtT = 1;
		if ( det.hasPrevFinishSample ) {

			const z0 = det.lastLocalZ;
			const z1 = localZ;
			const crossedPlane = ( z0 <= 0 && z1 >= 0 ) || ( z0 >= 0 && z1 <= 0 );
			if ( crossedPlane ) {

				const t = z0 / ( z0 - z1 );
				const xCross = det.lastLocalX + ( localX - det.lastLocalX ) * t;
				crossedFinish = t >= 0 && t <= 1 && Math.abs( xCross ) <= fd.halfExtent;
				if ( crossedFinish ) crossedAtT = t;

			}

		}

		if ( crossedFinish ) {

			if ( ! det.hasLeftStartZone ) return; // mirror the game's gate
			if ( det.checkpointStates && ! det.checkpointStates.every( ( c ) => c.passedThisLap ) ) {

				ctx.fns.writeLapDetection( { hasLeftStartZone: det.hasLeftStartZone, hasPrevFinishSample: true, lastLocalX: localX, lastLocalZ: localZ } );
				return;

			}
			// Crossing! onLapComplete may teleport (applyCrossState) or end
			// the run — skip the tail write so a fresh sample chain starts
			// from the post-crossing state (no phantom on the next frame).
			onLapComplete( crossedAtT );
			return;

		}

		ctx.fns.writeLapDetection( { hasLeftStartZone: det.hasLeftStartZone, hasPrevFinishSample: true, lastLocalX: localX, lastLocalZ: localZ } );

	}

	// Global run position: lap-2 steps continue past the lap-1 crossing step
	// instead of resetting to 0 at the line (loop tracks, skip mode).
	function globalStep() {

		const base = state.playback.lap1CrossStep || 0;
		return state.stepIndex + ( ( state.skipMode || state.lapsCompleted >= 1 ) ? base : 0 );

	}

	// ── Lap cross hook (replaces the normal lap-transition block in TAS) ──
	function onLapComplete( crossT = 1 ) {

		// Sub-step precision: the finish plane is crossed PARTWAY through the
		// final step (crossT = interpolation fraction between the last two
		// samples). The raw sim clock only advances in 1/60s quanta, so the
		// recorded time must subtract the un-simulated remainder of that step:
		// lapSeconds_precise = stepClock - (1 - crossT) / 60. Without this,
		// every lap time is a multiple of 1/60 (~16.7ms) and the displayed
		// decimals are fake — the brute forcer could never see sub-step wins.
		const lapSeconds = ctx.get.lapSeconds() - ( 1 - crossT ) / TAS_STEP_HZ;
		state.lapsCompleted ++;

		if ( state.phase === 'run' ) {

			if ( state.lapsCompleted < state.runLaps ) {

				// Crossing into the timed lap: hard-apply the recorded
				// crossing state (pos/vel/angvel/rot) so lap 2 starts
				// EXACTLY as recorded, no matter how lap 1 drifted.
				if ( state.lapsCompleted === 1 ) state.playback.lap1CrossStep = state.stepIndex;
				if ( state.lapsCompleted === 1 && state.runScript.lap2.length ) {

					if ( state.runScript.crossState ) applyCrossState( state.runScript.crossState );
					resetCarPhysicsHistory();
					state.runEntries = state.runScript.lap2;
					state.runPointer = 0;
					state.stepIndex = 0;

				}
				ctx.tasBeginNextLap();
				updateOverlay();
				return;

			}
			const stepCount = state.stepIndex;
			state.phase = 'done';
			ctx.tasBeginNextLap();
			if ( state.brute ) state.bruteResult = lapSeconds;
			else if ( state.calc ) state.playback.totalSteps = globalStep(), state.playback.time = round6( lapSeconds );
			else post( 'tas-run-complete', { lapSeconds: round6( lapSeconds ), stepCount } );
			updateOverlay();
			return;

		}

		if ( state.lapsCompleted < lapsNeeded ) {

			// Loop track, lap 1 done: NO countdown — roll straight into lap 2,
			// capture the flying-start state at full precision for the script.
			state.crossState = captureCrossState();
			ctx.tasBeginNextLap();
			resetCarPhysicsHistory();
			state.lapBuffers.push( [] );
			state.stepIndex = 0;
			state.lastRecorded = null;
			post( 'tas-lap-cross', { lap: 1, lapSeconds: round6( lapSeconds ) } );
			updateOverlay();
			return;

		}

		// Recording complete: hand the full script (both laps) to the editor.
		const script = buildScript();
		const stepCount = state.stepIndex;
		state.phase = 'done';
		ctx.tasBeginNextLap();
		post( 'tas-lap-complete', {
			lap: state.lapsCompleted,
			lapSeconds: round6( lapSeconds ),
			stepCount,
			script,
			crossState: ctx.isLoop ? state.crossState : null,
		} );
		updateOverlay();

	}

	function round6( n ) { return Number( n.toFixed( 6 ) ); }

	// ── Parent commands + R restart ─────────────────────────────────────
	function resetState( phase ) {

		state.phase = phase;
		state.started = false;
		state.stepIndex = 0;
		state.lastRecorded = null;
		state.lapsCompleted = 0;
		state.lapBuffers = [ [] ];
		state.crossState = null;
		state.runScript = null;
		state.runEntries = null;
		state.runPointer = 0;
		state.runLaps = 1;
		state.paused = false;
		state.skipMode = false;
		if ( ctx.fns.setPaused ) ctx.fns.setPaused( false );

	}

	function retry() {

		resetState( 'record' );
		ctx.fns.respawnVehicle();
		resetCarPhysicsHistory();
		ctx.fns.startCountdown();
		post( 'tas-retry-started', {} );
		updateOverlay();

	}

	function run( text, startAtLap2 ) {

		const script = parseScript( text );
		if ( script.errors.length ) {

			post( 'tas-run-invalid', { errors: script.errors } );
			return;

		}
		state.lastRunText = text;
		state.lastPlayLap1 = !! startAtLap2;
		state.playback = { lap1CrossStep: null, totalSteps: null, time: null };
		resetState( 'run' );
		state.runScript = script;
		state.stepIndex = 0;
		ctx.fns.respawnVehicle();

		// AUTO-CALCULATE: burst the ENTIRE run (countdown settle + every
		// lap, crossings detected in-burst by the probe) to learn the
		// lap-1 crossing step, the total run length and the precise
		// finish time BEFORE playback starts. Playback then seeks to the
		// slider's zero position and plays in real time; scrubbing the
		// slider re-anchors with the same deterministic bursts.
		if ( ! startAtLap2 && ctx.fns.stepOnce && script.lap1.length ) {

			state.calc = true;
			state.runEntries = script.lap1;
			state.runLaps = script.lap2.length ? 2 : ( ctx.isLoop && script.mode === 'run' && ! script.crossState ? 2 : 1 );
			state.started = false;
			resetCarPhysicsHistory();
			ctx.fns.startCountdown();
			state.fastForward = true;
			const l1Last = script.lap1[ script.lap1.length - 1 ].step;
			const l2Last = script.lap2.length ? script.lap2[ script.lap2.length - 1 ].step : 0;
			const burstCap = 60 * 5 + ( l1Last + 60 * 30 ) + ( script.lap2.length ? l2Last + 60 * 30 : 0 );
			let burst = 0;
			try {

				while ( state.phase === 'run' && burst ++ < burstCap ) {

					ctx.fns.stepOnce();
					if ( state.phase === 'run' ) probeLapCross();

				}

			} catch ( e ) { /* seek falls back below */ }
			state.fastForward = false;
			state.calc = false;
			// undo the calc's done flip; seekTo re-anchors everything
			state.phase = 'run';
			state.lapsCompleted = 0;
			state.started = false;
			state.runEntries = script.lap1;
			state.runPointer = 0;

		}
		const l1c = state.playback.lap1CrossStep;
		if ( startAtLap2 && script.lap2.length ) {

			// SKIP MODE — the v11 fast path (user order): ONE synchronous
			// burst simulates countdown + lap 1 at full speed (~half a
			// second); the crossing fires mid-burst, applies the exact
			// recorded crossing state and hands over to lap 2 REAL-TIME,
			// carrying all lap-1 physics history. Lap 1 is never played
			// in real time. If it never crosses in the burst (edited
			// script), the instant teleport below still skips lap 1.
			resetState( 'run' );
			state.runScript = script;
			state.skipMode = true;
			state.started = false;
			state.runEntries = script.lap1;
			state.runLaps = 2;
			ctx.fns.respawnVehicle();
			resetCarPhysicsHistory();
			ctx.fns.startCountdown();
			state.fastForward = true;
			let burst = 0;
			const l1Last = script.lap1.length ? script.lap1[ script.lap1.length - 1 ].step : 0;
			const burstCap = 60 * 5 + l1Last + 60 * 30;
			try {

				while ( state.phase === 'run' && state.lapsCompleted < 1 && burst ++ < burstCap ) {

					ctx.fns.stepOnce();
					if ( state.phase === 'run' ) probeLapCross();

				}

			} catch ( e ) { /* fall through to the teleport */ }
			state.fastForward = false;
			if ( state.lapsCompleted < 1 ) {

				// teleport fallback: exact recorded crossing state
				resetState( 'run' );
				state.runScript = script;
				state.skipMode = true;
				state.started = true;
				applyCrossState( script.crossState );
				state.runEntries = script.lap2;
				state.runLaps = 1;
				state.runPointer = 0;
				resetCarPhysicsHistory();
				if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();

			}

		} else {

			state.skipMode = false;
			seekTo( 0 );

		}
		post( 'tas-run-started', {
			mode: script.mode,
			steps: script.lap1.length + script.lap2.length,
			skipLap1: !! startAtLap2,
			totalSteps: state.playback.totalSteps,
			lap1CrossStep: l1c,
			calcTime: state.playback.time,
		} );
		updateOverlay();

	}

	// Deterministic scrub: re-anchor from respawn and burst to an exact
	// global step (sub-second); playback resumes real-time from there.
	function seekTo( target ) {

		const script = state.runScript;
		if ( ! script ) return;
		state.paused = false;
		const l1c = state.playback.lap1CrossStep;

		// Legacy lap-2-only scripts: no lap-1 timeline — instant teleport.
		if ( ! script.lap1.length && script.lap2.length ) {

			resetState( 'run' );
			state.runScript = script;
			state.skipMode = true;
			state.started = true;
			applyCrossState( script.crossState );
			state.runEntries = script.lap2;
			state.runLaps = 1;
			state.runPointer = 0;
			resetCarPhysicsHistory();
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			updateOverlay();
			return;

		}

		// Broken lap-1 timeline (crossing never fired) + lap-2 start: the
		// exact-state teleport fallback keeps heavily-edited runs alive.
		if ( target > 0 && l1c == null && script.lap2.length && script.crossState && ctx.fns.stepOnce ) {

			resetState( 'run' );
			state.runScript = script;
			state.skipMode = true;
			state.lapsCompleted = 1;
			applyCrossState( script.crossState );
			state.runEntries = script.lap2;
			state.runRaps = null; // (typo guard: never again)
			state.runLaps = 1;
			state.runPointer = 0;
			state.started = true;
			resetCarPhysicsHistory();
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			updateOverlay();
			return;

		}

		if ( ! ctx.fns.stepOnce || ! script.lap1.length ) return;

		resetState( 'run' );
		state.runScript = script;
		state.skipMode = false;
		state.stepIndex = 0;
		ctx.fns.respawnVehicle();
		state.runEntries = script.lap1;
		state.runLaps = script.lap2.length ? 2 : ( ctx.isLoop && script.mode === 'run' && ! script.crossState ? 2 : 1 );
		state.started = false;
		resetCarPhysicsHistory();
		ctx.fns.startCountdown();
		state.fastForward = true;
		const l1Last = script.lap1[ script.lap1.length - 1 ].step;
		const l2Last = script.lap2.length ? script.lap2[ script.lap2.length - 1 ].step : 0;
		const burstCap = 60 * 5 + ( l1Last + 60 * 30 ) + ( script.lap2.length ? l2Last + 60 * 30 : 0 );
		let burst = 0;
		try {

			if ( l1c != null && target < l1c ) {

				// target inside lap 1: stop before the crossing can fire
				while ( state.phase === 'run' && state.lapsCompleted === 0 && burst ++ < burstCap ) {

					ctx.fns.stepOnce();
					if ( state.phase === 'run' ) probeLapCross();
					if ( state.started && state.stepIndex >= target ) break;

				}

			} else {

				while ( state.phase === 'run' && state.lapsCompleted < 1 && burst ++ < burstCap ) {

					ctx.fns.stepOnce();
					if ( state.phase === 'run' ) probeLapCross();

				}
				const local = l1c == null ? target : target - l1c;
				while ( state.phase === 'run' && state.lapsCompleted === 1 && state.stepIndex < local && burst ++ < burstCap ) {

					ctx.fns.stepOnce();
					if ( state.phase === 'run' ) probeLapCross();

				}

			}

		} catch ( e ) {}
		state.fastForward = false;
		updateOverlay();

	}

	// Pause = the GAME's own pause (main.js `paused` flag): the sim loop
	// stops, the engine/camera/overlay keep rendering. Resume is instant
	// — the run simply continues from the paused step.
	function togglePause() {

		if ( state.phase !== 'run' || ! state.runScript ) return;
		if ( ! ctx.fns.setPaused ) return;
		state.paused = ! state.paused;
		ctx.fns.setPaused( state.paused );
post( 'tas-paused', { paused: state.paused } );

	}

	// ── Brute forcer ──────────────────────────────────────────────────────
	// Hill-climbing optimizer over the timed lap's input entries. Each round
	// mutates N random entries (checkbox: also appends one new input at the
	// timeline's end), quick-simulates the FULL run in one synchronous burst
	// (countdown + lap 1 + lap 2), and adopts the candidate only if it
	// finishes FASTER. Loop tracks mutate lap-2 entries only — the recorded
	// crossing state is hard-applied at the line, so lap-1 edits can never
	// change the timed lap (they can only break it).
	const randInput = () => [ -1, 0, 1 ][ Math.floor( Math.random() * 3 ) ];
	const fmtTime = ( t ) => t === Infinity ? 'DNF' : round6( t );

	function scriptToText( script ) {

		const lines = [ '# Skid Circuit TAS v11', `track: ${ ctx.trackId }`, 'mode: run' ];
		if ( ctx.isLoop && script.crossState ) {

			// Each line guarded: hand-edited scripts may carry a partial
			// state block and the forcer must never crash rebuilding text.
			const cs = script.crossState;
			if ( cs.pos ) lines.push( `state: pos ${ cs.pos.map( fmt ).join( ' ' ) }` );
			if ( cs.vel ) lines.push( `state: vel ${ cs.vel.map( fmt ).join( ' ' ) }` );
			if ( cs.angvel ) lines.push( `state: angvel ${ cs.angvel.map( fmt ).join( ' ' ) }` );
			if ( cs.rot ) lines.push( `state: rot ${ cs.rot.map( fmt ).join( ' ' ) }` );
			if ( cs.game ) lines.push( `state: game ${ JSON.stringify( cs.game ) }` );

		}
		for ( const e of script.lap1 ) lines.push( `step ${ e.step } x=${ fmt( e.x ) } z=${ fmt( e.z ) }` );
		if ( ctx.isLoop ) {

			lines.push( 'cross' );
			for ( const e of script.lap2 ) lines.push( `step ${ e.step } x=${ fmt( e.x ) } z=${ fmt( e.z ) }` );

		}
		lines.push( 'end' );
		return lines.join( '\n' );

	}

	function cloneScript( script ) {

		return {
			mode: script.mode, ver: script.ver, crossState: script.crossState,
			lap1: script.lap1.map( ( e ) => ( { step: e.step, x: e.x, z: e.z } ) ),
			lap2: script.lap2.map( ( e ) => ( { step: e.step, x: e.x, z: e.z } ) ),
		};

	}

	function pickOther( v ) {

		const opts = [ -1, 0, 1 ].filter( ( o ) => o !== v );
		return opts[ Math.floor( Math.random() * opts.length ) ];

	}

	// Mutation menu (per changed input) — 3-frame pulses by user spec:
	//   55% steering pulse — pick a RANDOM frame inside a segment, override
	//                        steering for exactly 3 steps, then a spliced
	//                        release entry restores the original value. The
	//                        change can NEVER exceed 3 frames.
	//   15% accel pulse     — same 3-frame override+release on accel (z).
	//   30% timing shift    — an entry's step slides strictly between its
	//                        neighbors; no input value changes at all.
	// Raw value flips (the old run-breakers: one steering flip persisted for
	// a whole multi-second segment) are gone for good.
	function mutateScript( script, mutations, addInput ) {

		const cand = cloneScript( script );
		const timedLap = cand.lap2.length ? cand.lap2 : cand.lap1;
		if ( ! timedLap.length ) return cand;
		for ( let m = 0; m < mutations; m ++ ) {

			const roll = Math.random();
			if ( roll < 0.70 ) {

				// 3-frame pulse at a random frame: override at f, release at f+3.
				const isAccel = roll >= 0.55;
				const key = isAccel ? 'z' : 'x';
				const idx = Math.floor( Math.random() * timedLap.length );
				const e = timedLap[ idx ];
				const next = idx < timedLap.length - 1 ? timedLap[ idx + 1 ].step : e.step + 120;
				const lo = e.step + 1;    // strictly inside the segment, after its entry
				const hi = next - 4;      // pulse (3 steps) + release fit before the next entry
				if ( hi < lo ) continue; // segment too short for a safe pulse
				const f = lo + Math.floor( Math.random() * ( hi - lo + 1 ) );
				const pulse = { step: f, x: e.x, z: e.z };
				pulse[ key ] = pickOther( e[ key ] );
				timedLap.splice( idx + 1, 0, pulse );
				timedLap.splice( idx + 2, 0, { step: f + 3, x: e.x, z: e.z } );

			} else {

				// timing: shift this entry between the previous and next entry
				const idx = Math.floor( Math.random() * timedLap.length );
				const e = timedLap[ idx ];
				const prev = idx > 0 ? timedLap[ idx - 1 ].step : -1;
				const next = idx < timedLap.length - 1 ? timedLap[ idx + 1 ].step : e.step + 120;
				const lo = prev + 1;
				const hi = Math.max( next - 1, lo );
				if ( hi > lo || ( hi === lo && lo !== e.step ) ) {

					let nStep = lo + Math.floor( Math.random() * ( hi - lo + 1 ) );
					if ( nStep === e.step ) nStep = lo !== e.step ? lo : hi;
					e.step = nStep;

				}

			}

		}
		if ( addInput ) {

			// New input at the timeline's end: fresh steering, keep the last
			// throttle (random accel at the run's tail almost only harms).
			const last = timedLap[ timedLap.length - 1 ];
			timedLap.push( { step: last.step + 1, x: pickOther( last.x ), z: last.z } );

		}
		return cand;

	}

	// Full-run quick simulation: one synchronous burst, no rendering. Returns
	// the timed lap's seconds, or Infinity when the candidate never finishes.
	function bruteEvaluate( script ) {

		state.bruteResult = null;
		resetState( 'run' );
		state.runScript = script;
		state.stepIndex = 0;
		ctx.fns.respawnVehicle();
		resetCarPhysicsHistory();
		state.runEntries = script.lap1;
		state.runLaps = script.lap2.length ? 2 : ( ctx.isLoop && script.mode === 'run' && ! script.crossState ? 2 : 1 );
		state.started = false;
		ctx.fns.startCountdown();
		state.fastForward = true;
		let burst = 0;
		// The cap must cover the countdown PLUS the full duration of EVERY
		// lap: the crossing step is far past the last input-change step, so
		// budgeting off entry steps starved lap 2 and every candidate DNF'd.
		const l1Last = script.lap1.length ? script.lap1[ script.lap1.length - 1 ].step : 0;
		const l2Last = script.lap2.length ? script.lap2[ script.lap2.length - 1 ].step : 0;
		const burstCap = 60 * 5 + ( l1Last + 60 * 30 ) + ( script.lap2.length ? l2Last + 60 * 30 : 0 );
		try {

			while ( state.phase === 'run' && burst ++ < burstCap ) {

				ctx.fns.stepOnce();
				if ( state.phase === 'run' ) probeLapCross();

			}

		} catch ( e ) { /* DNF */ }
		state.fastForward = false;
		return state.bruteResult === null ? Infinity : state.bruteResult;

	}

	async function bruteForce( payload ) {

		if ( state.brute ) return; // already running
		const script = parseScript( payload.script || '' );
		if ( script.errors.length ) { post( 'tas-bruteforce-error', { errors: script.errors } ); return; }
		if ( ! script.lap1.length && ! script.lap2.length ) {

			post( 'tas-bruteforce-error', { errors: [ 'script has no inputs to mutate' ] } );
			return;

		}
		const mutations = Math.max( 1, Math.min( 20, Number( payload.mutations ) || 1 ) );
		const addInput = !! payload.addInput;
		const rounds = Math.max( 1, Math.min( 2000, Number( payload.rounds ) || 10 ) );
		state.brute = { stop: false, round: 0, rounds, best: null, last: null, adopted: 0 };
		const baseline = bruteEvaluate( script );
		if ( ! Number.isFinite( baseline ) ) {

			// NEVER mutate a script whose own timed run does not finish:
			// with an infinite baseline any garbage finisher would count
			// as "better" and the brute would replace the user's run with
			// a wall-slam. Keep the script byte-identical and say why.
			state.brute = null;
			post( 'tas-bruteforce-error', { errors: [ 'Baseline run did not finish in the fast simulation — the script was NOT changed. Make the run finish (Run button) before brute-forcing.' ] } );
			return;

		}
		let bestScript = script;
		let bestTime = baseline;
		state.brute.best = baseline;
		post( 'tas-bruteforce-progress', { round: 0, rounds, bestTime: fmtTime( bestTime ), lastTime: fmtTime( baseline ), adopted: false } );
		for ( let round = 1; round <= rounds; round ++ ) {

			if ( state.brute.stop ) break;
			const candidate = mutateScript( bestScript, mutations, addInput );
			const t = bruteEvaluate( candidate );
			let adopted = false;
			if ( t < bestTime ) {

				bestTime = t;
				bestScript = candidate;
				adopted = true;
				state.brute.adopted ++;
				post( 'tas-bruteforce-update', { script: scriptToText( bestScript ) } );

			}
			state.brute.round = round;
			state.brute.best = bestTime;
			state.brute.last = t;
			post( 'tas-bruteforce-progress', { round, rounds, bestTime: fmtTime( bestTime ), lastTime: fmtTime( t ), adopted } );
			await new Promise( ( r ) => setTimeout( r, 0 ) ); // yield to the editor UI

		}
		const bestText = scriptToText( bestScript );
		state.lastRunText = bestText; // R / Run re-run the best found
		const improved = bestTime < baseline;
		state.brute = null;
		state.phase = 'done';
		post( 'tas-bruteforce-done', { bestTime: fmtTime( bestTime ), improved, script: bestText } );

	}

	window.addEventListener( 'message', ( event ) => {

		if ( event.source !== window.parent || ! event.data?.type ) return;
		const type = event.data.type;
		if ( type === 'tas-retry' ) retry();
		else if ( type === 'tas-run' ) run( event.data.script || '', !! event.data.startAtLap2 );
		else if ( type === 'tas-stop' ) { state.phase = 'done'; ctx.tasBeginNextLap(); updateOverlay(); }
		else if ( type === 'tas-bruteforce' ) bruteForce( event.data );
		else if ( type === 'tas-bruteforce-stop' ) { if ( state.brute ) state.brute.stop = true; }
		else if ( type === 'tas-toggle-pause' ) togglePause();
		else if ( type === 'tas-seek' && state.runScript && ( state.phase === 'run' || state.phase === 'done' ) ) {

			// Scrubbing while paused STAYS paused: capture BEFORE the seek
			// (seekTo's resetState clears state.paused), re-anchor, then
			// re-assert the game pause so the run holds at the sought step.
			const wasPaused = state.paused;
			seekTo( Math.max( 0, Math.round( Number( event.data.step ) || 0 ) ) );
			if ( wasPaused && ctx.fns.setPaused ) {

				state.paused = true;
				ctx.fns.setPaused( true );

			}

		}

	} );

	// R = restart. Recording (or done): fresh countdown + fresh recording —
	// steps stay frozen until the countdown finishes. During a run: restart
	// the replay instantly. Plain R only (no Ctrl/Cmd/etc).
	window.addEventListener( 'keydown', ( event ) => {

		if ( event.code !== 'KeyR' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ) return;
		event.preventDefault();
		event.stopPropagation();
		if ( state.brute ) return; // brute forcer owns the engine
		if ( state.phase === 'run' && state.lastRunText ) run( state.lastRunText, state.lastPlayLap1 );
		else retry();

	}, true );

	// ── Overlay (TAS-only timing UI, full precision) ─────────────────────
	const overlay = document.createElement( 'div' );
	overlay.id = 'tas-overlay';
	overlay.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;pointer-events:none;'
		+ 'font:600 12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#fff;'
		+ 'background:rgba(0,0,0,0.55);padding:6px 10px;border-radius:6px;white-space:pre;';
	document.body.appendChild( overlay );

	function updateOverlay() {

		if ( state.fastForward ) return; // burst: skip DOM writes

		const phaseLabel = ( state.phase === 'record' || state.phase === 'run' ) && ! state.started ? 'COUNTDOWN'
			: state.phase === 'record' ? 'REC' : state.phase === 'run' ? 'RUN' : 'DONE';
		const lapLabel = ctx.isLoop ? `LOOP · lap ${ state.lapsCompleted + 1 }/${ lapsNeeded }`
			: 'NON-LOOP · 1 lap';
		overlay.textContent = `TAS ${ phaseLabel } · ${ lapLabel }`
			+ `\nstep ${ state.phase === 'run' ? globalStep() : state.stepIndex }${ state.phase === 'run' && state.playback.totalSteps != null ? ' / ' + state.playback.totalSteps : '' } (${ TAS_STEP_HZ } Hz)`
			+ `\nlap ${ ( ctx.get.lapSeconds() || 0 ).toFixed( 6 ) }s`
			+ `\nsim ${ ctx.get.raceClock().toFixed( 2 ) }s`;

	}
	updateOverlay();

	post( 'tas-ready', { isLoop: ctx.isLoop, trackId: ctx.trackId, stepHz: TAS_STEP_HZ } );

	return { step, onLapComplete };

}
