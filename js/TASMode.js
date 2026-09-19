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
			state.stepIndex ++;
			if ( state.overlayTick % 6 === 0 ) updateOverlay();
			return scripted;

		}

		// done: freeze driving
		if ( state.overlayTick % 6 === 0 ) updateOverlay();
		return zeroInput();

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

	}

	function retry() {

		resetState( 'record' );
		ctx.fns.respawnVehicle();
		resetCarPhysicsHistory();
		ctx.fns.startCountdown();
		post( 'tas-retry-started', {} );
		updateOverlay();

	}

	function run( text, playLap1 ) {

		const script = parseScript( text );
		if ( script.errors.length ) {

			post( 'tas-run-invalid', { errors: script.errors } );
			return;

		}
		state.lastRunText = text;
		state.lastPlayLap1 = !! playLap1;
		resetState( 'run' );
		state.runScript = script;
		state.stepIndex = 0;
		ctx.fns.respawnVehicle();
		// FAST mode (checkbox OFF): super-fast-simulate lap 1 in ONE
		// synchronous burst — respawn, contact wipe, countdown settle and
		// the whole lap-1 input timeline, thousands of fixed steps with no
		// rendering (sub-second). The lap-1 crossing fires mid-burst and
		// applies the exact recorded line state, so lap 2 then runs in
		// real time entering the engine EXACTLY like a full real-time
		// replay — every bit of lap-1 history included.
		if ( ! playLap1 && script.lap2.length && script.lap1.length && ctx.fns.stepOnce ) {

			state.runEntries = script.lap1;
			state.runLaps = 2;
			state.started = false;
			resetCarPhysicsHistory();
			ctx.fns.startCountdown();
			state.fastForward = true;
			let burst = 0;
			const burstCap = 60 * 4 + script.lap1[ script.lap1.length - 1 ].step + 60 * 30;
			try {

				while ( state.phase === 'run' && state.lapsCompleted < 1 && burst ++ < burstCap ) ctx.fns.stepOnce();

			} catch ( e ) { /* fall through to the exact-state fallback */ }
			state.fastForward = false;
			if ( state.lapsCompleted >= 1 ) {

				// crossing fired mid-burst: lap-2 entries are live, the
				// recorded line state is applied, contacts wiped. Real time
				// takes over from the very next frame.
				post( 'tas-run-started', { mode: script.mode, steps: script.lap2.length, skipLap1: true, fastForwarded: true } );
				updateOverlay();
				return;

			}
			// Lap 1 never crossed (heavily edited script): fall back to the
			// exact-state teleport so the run still works.
			state.lapsCompleted = 1;
			applyCrossState( script.crossState );
			resetCarPhysicsHistory();
			ctx.tasBeginNextLap();
			state.runEntries = script.lap2;
			state.runLaps = 1;
			state.stepIndex = 0;
			state.runPointer = 0;
			state.started = true;
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			post( 'tas-run-started', { mode: script.mode, steps: script.lap2.length, skipLap1: true, fastForwarded: false } );
			updateOverlay();
			return;

		}
		// TELEPORT mode: legacy lap-2-only scripts (no lap-1 timeline to
		// simulate) start AT the recorded crossing state, instantly.
		const skipLap1 = script.lap2.length > 0 && ( ! playLap1 || ! script.lap1.length );
		if ( skipLap1 ) {

			state.started = true;
			applyCrossState( script.crossState );
			state.runEntries = script.lap2;
			state.runLaps = 1;
			resetCarPhysicsHistory();
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			post( 'tas-run-started', { mode: script.mode, steps: script.lap2.length, skipLap1: true, fastForwarded: false } );
			updateOverlay();
			return;

		}
		state.runEntries = script.lap1;
		resetCarPhysicsHistory();
		if ( script.ver >= 6 ) {

			// v6+ play-lap-1 mode mirrors the recording: countdown settle
			// first, injection arms when it ends — exactly like recording.
			state.runLaps = script.lap2.length ? 2 : 1;
			state.started = false;
			ctx.fns.startCountdown();

		} else {

			// Legacy pre-v6 flat scripts keep their instant-start behavior.
			state.runLaps = ( ctx.isLoop && script.mode === 'run' ) || ( script.lap1.length && script.lap2.length ) ? 2 : 1;
			state.started = true;
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();

		}
		post( 'tas-run-started', { mode: script.mode, steps: script.lap1.length + script.lap2.length, skipLap1: false, fastForwarded: false } );
		updateOverlay();

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

	// Mutation menu (per changed input):
	//   40% steering value — x from {-1,0,1}, never a no-op
	//   10% accel value     — z from {-1,0,1}, rare (breaks runs easily)
	//   25% timing shift    — step slides strictly between neighbors
	//   25% steering pulse  — override steering for 3-24 steps inside one
	//                         segment, then the original input resumes: a
	//                         true 'few frames of gameplay' nudge, the small
	//                         blast-radius change random search needs.
	function mutateScript( script, mutations, addInput ) {

		const cand = cloneScript( script );
		const timedLap = cand.lap2.length ? cand.lap2 : cand.lap1;
		if ( ! timedLap.length ) return cand;
		for ( let m = 0; m < mutations; m ++ ) {

			const idx = Math.floor( Math.random() * timedLap.length );
			const e = timedLap[ idx ];
			const roll = Math.random();
			if ( roll < 0.40 ) {

				e.x = pickOther( e.x ); // steering: -1 / 0 / 1, never a no-op

			} else if ( roll < 0.50 ) {

				e.z = pickOther( e.z ); // accel: -1 / 0 / 1, rarer by design

			} else if ( roll < 0.75 ) {

				// timing: shift this entry between the previous and next entry
				const prev = idx > 0 ? timedLap[ idx - 1 ].step : -1;
				const next = idx < timedLap.length - 1 ? timedLap[ idx + 1 ].step : e.step + 120;
				const lo = prev + 1;
				const hi = Math.max( next - 1, lo );
				if ( hi > lo || ( hi === lo && lo !== e.step ) ) {

					let nStep = lo + Math.floor( Math.random() * ( hi - lo + 1 ) );
					if ( nStep === e.step ) nStep = lo !== e.step ? lo : hi;
					e.step = nStep;

				}

			} else if ( idx < timedLap.length - 1 ) {

				// steering pulse: new steering now, original resumes mid-segment
				const segEnd = timedLap[ idx + 1 ].step;
				const maxWin = Math.min( 24, segEnd - e.step - 1 );
				if ( maxWin >= 3 ) {

					const w = 3 + Math.floor( Math.random() * ( maxWin - 2 ) );
					timedLap.splice( idx + 1, 0, { step: e.step + w, x: e.x, z: e.z } );
					e.x = pickOther( e.x );

				} else e.x = pickOther( e.x );

			} else e.x = pickOther( e.x ); // last entry: no segment to pulse into

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

			while ( state.phase === 'run' && burst ++ < burstCap ) ctx.fns.stepOnce();

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
		else if ( type === 'tas-run' ) run( event.data.script || '', !! event.data.playLap1 );
		else if ( type === 'tas-stop' ) { state.phase = 'done'; ctx.tasBeginNextLap(); updateOverlay(); }
		else if ( type === 'tas-bruteforce' ) bruteForce( event.data );
		else if ( type === 'tas-bruteforce-stop' ) { if ( state.brute ) state.brute.stop = true; }

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
			+ `\nstep ${ state.stepIndex } (${ TAS_STEP_HZ } Hz)`
			+ `\nlap ${ ( ctx.get.lapSeconds() || 0 ).toFixed( 6 ) }s`
			+ `\nsim ${ ctx.get.raceClock().toFixed( 2 ) }s`;

	}
	updateOverlay();

	post( 'tas-ready', { isLoop: ctx.isLoop, trackId: ctx.trackId, stepHz: TAS_STEP_HZ } );

	return { step, onLapComplete };

}
