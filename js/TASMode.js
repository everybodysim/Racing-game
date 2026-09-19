// js/TASMode.js — game-side TAS mode (?tas=1), see docs/tas-editor-plan.md.
// Only loaded when ?tas=1 is in the game URL; normal gameplay never imports
// this module.
//
// DETERMINISM CONTRACT (v2): a run is bit-identical to its recording because
// record and replay execute the SAME state machine over the SAME events:
//   1. every session (record or replay) starts with respawnVehicle() +
//      startCountdown() — the canonical "settled spawn" state;
//   2. the recorder arms at the FIRST countdown step and records a single
//      flat per-step input timeline (global step counter, laps included —
//      lap crossings emerge from physics, they are not scripted);
//   3. a replay arms at the same first countdown step and injects that exact
//      timeline step-for-step, zero-input before/after it;
//   4. nothing is snapshotted or rounded on the replay path — the cross-line
//      state of loop tracks is RE-DERIVED by replaying lap 1.
// Legacy 'lap1'/'lap2' snapshot scripts still parse and run (best-effort),
// but the recorder only emits 'mode: run' flat scripts.

const TAS_STEP_HZ = 60;

function zeroInput() { return { x: 0, z: 0 }; }

export function activate( ctx ) {

	if ( window.__tasActive ) return;
	window.__tasActive = true;

	const lapsNeeded = ctx.isLoop ? 2 : 1;

	const state = {
		phase: 'record',           // record | run | done
		started: false,            // armed at the FIRST countdown step
		stepIndex: 0,              // global step counter since arm
		lastRecorded: null,
		lapsCompleted: 0,
		buffer: [],                // ONE flat RLE buffer of {step, x, z}
		crossState: null,          // captured at lap1->2 cross (DISPLAY ONLY)
		runScript: null,
		runPointer: 0,
		overlayTick: 0,
		runId: 0,                  // bumped by run()/retry() — observers use
		                           // it to detect a NEW session, not stale state
		stream: [],                // {s, x, y, z, yaw} per step (probe/E2E)
	};

	window.__tasState = () => ( {
		phase: state.phase,
		lapsCompleted: state.lapsCompleted,
		started: state.started,
		stepIndex: state.stepIndex,
		inputsRecorded: state.buffer.length,
		runId: state.runId,
		isLoop: ctx.isLoop,
		pos: [ ctx.vehicle.spherePos.x, ctx.vehicle.spherePos.y, ctx.vehicle.spherePos.z ],
		yaw: ctx.vehicle.container.rotation.y,
	} );

	window.__tasStream = () => state.stream;

	const post = ( type, payload ) => {

		if ( window.parent && window.parent !== window ) window.parent.postMessage( { type, ...payload }, '*' );

	};

	// ── Cross-line state capture (DISPLAY ONLY — replays re-derive it) ──
	function captureCrossState() {

		const v = ctx.vehicle;
		const mp = v.rigidBody?.motionProperties;
		return {
			pos: [ v.spherePos.x, v.spherePos.y, v.spherePos.z ],
			vel: mp ? [ ...mp.linearVelocity ] : [ 0, 0, 0 ],
			angvel: mp ? [ ...mp.angularVelocity ] : [ 0, 0, 0 ],
			rot: [ v.container.rotation.x, v.container.rotation.y, v.container.rotation.z ],
		};

	}

	// ── Script build / parse ──────────────────────────────────────────
	function fmt( n ) { return String( n ); }

	function buildScript( buffer ) {

		const lines = [ '# Skid Circuit TAS v2', `track: ${ ctx.trackId }`, 'mode: run' ];
		for ( const entry of buffer ) lines.push( `step ${ entry.step } x=${ fmt( entry.x ) } z=${ fmt( entry.z ) }` );
		lines.push( 'end' );
		return lines.join( '\n' );

	}

	function parseScript( text ) {

		const script = { mode: 'run', crossState: null, entries: [], errors: [] };
		const num = ( s ) => Number( s );
		let lastStep = -1;
		for ( const rawLine of String( text ).split( /\r?\n/ ) ) {

			const line = rawLine.replace( /#.*$/, '' ).trim();
			if ( ! line ) continue;
			if ( line === 'end' ) break;
			if ( line.startsWith( 'track:' ) || line.startsWith( 'Skid Circuit TAS' ) ) continue;
			if ( line.startsWith( 'mode:' ) ) {

				const mode = line.slice( 5 ).trim();
				if ( mode !== 'run' && mode !== 'lap1' && mode !== 'lap2' ) script.errors.push( `unknown mode "${ mode }"` );
				else script.mode = mode;
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
				script.entries.push( { step, x: clampInput( kv.x ), z: clampInput( kv.z ) } );
				continue;

			}
			script.errors.push( `unrecognized line: "${ line }"` );

		}
		if ( ! script.entries.length ) script.errors.push( 'no step lines' );
		if ( script.mode === 'lap2' && ( ! script.crossState?.pos || ! script.crossState?.vel ) ) {

			script.errors.push( 'legacy lap2 scripts need "state: pos" and "state: vel" lines' );

		}
		return script;

	}

	function clampInput( v ) { return Number.isFinite( v ) ? Math.max( -1, Math.min( 1, v ) ) : 0; }

	function scriptInputAt( i ) {

		const entries = state.runScript.entries;
		while ( state.runPointer < entries.length - 1 && entries[ state.runPointer + 1 ].step <= i ) state.runPointer ++;
		const e = entries[ state.runPointer ];
		return e && e.step <= i ? { x: e.x, z: e.z } : zeroInput();

	}

	// ── Per-step hook (called from runSimulationStep after pad modifiers) ──
	function probe() {

		const v = ctx.vehicle;
		state.stream.push( {
			s: state.stepIndex,
			x: v.spherePos.x, y: v.spherePos.y, z: v.spherePos.z,
			yaw: v.container.rotation.y,
		} );

	}

	function step( input ) {

		const countdownActive = ctx.get.countdownActive();
		state.overlayTick ++;

		if ( state.phase === 'record' ) {

			// Arm at the FIRST countdown step — replay arms at the exact
			// same step, so both sessions run an identical event sequence
			// (respawn -> countdown steps -> drive) from identical state.
			if ( ! state.started ) {

				if ( countdownActive ) {

					state.started = true;
					state.stepIndex = 0;

				}

			}
			if ( state.started ) {

				probe();
				if ( state.lastRecorded === null || state.lastRecorded.x !== input.x || state.lastRecorded.z !== input.z ) {

					state.buffer.push( { step: state.stepIndex, x: input.x, z: input.z } );
					state.lastRecorded = { x: input.x, z: input.z };

				}
				state.stepIndex ++;

			}
			if ( state.overlayTick % 6 === 0 ) updateOverlay();
			return input;

		}

		if ( state.phase === 'run' && state.runScript ) {

			const legacy = state.runScript.legacy;
			// Arm exactly like the recorder: on the arm step itself, fall
			// through and inject step 0 (no one-step skew).
			if ( ! legacy && ! state.started ) {

				if ( ! countdownActive ) {

					if ( state.overlayTick % 6 === 0 ) updateOverlay();
					return zeroInput();

				}
				state.started = true;
				state.stepIndex = 0;

			}
			probe();
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
	function onLapComplete() {

		const lapSeconds = ctx.get.lapSeconds();
		state.lapsCompleted ++;

		if ( state.phase === 'run' ) {

			if ( state.lapsCompleted < lapsNeeded ) {

				ctx.tasBeginNextLap();
				updateOverlay();
				return;

			}
			const stepCount = state.stepIndex;
			state.phase = 'done';
			ctx.tasBeginNextLap();
			post( 'tas-run-complete', { lapSeconds: round6( lapSeconds ), stepCount } );
			updateOverlay();
			return;

		}

		if ( state.lapsCompleted < lapsNeeded ) {

			// Loop track, lap 1 done: rolling straight into lap 2 — the
			// cross state is captured for display only; the replay does NOT
			// restore it (it re-derives it by replaying lap 1's inputs).
			state.crossState = captureCrossState();
			ctx.tasBeginNextLap();
			post( 'tas-lap-cross', { lap: 1, lapSeconds: round6( lapSeconds ) } );
			updateOverlay();
			return;

		}

		// Recording complete: hand the flat script to the editor.
		const script = buildScript( state.buffer );
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

	// ── Parent commands ────────────────────────────────────────────────
	function resetState( phase ) {

		state.phase = phase;
		state.started = false;
		state.stepIndex = 0;
		state.lastRecorded = null;
		state.lapsCompleted = 0;
		state.buffer = [];
		state.crossState = null;
		state.runScript = null;
		state.runPointer = 0;
		state.stream = [];

	}

	function retry() {

		resetState( 'record' );
		state.runId ++;
		ctx.fns.respawnVehicle();
		ctx.fns.startCountdown();
		post( 'tas-retry-started', {} );
		updateOverlay();

	}

	function run( text ) {

		const script = parseScript( text );
		if ( script.errors.length ) {

			post( 'tas-run-invalid', { errors: script.errors } );
			return;

		}
		resetState( 'run' );
		state.runId ++;
		script.legacy = script.mode !== 'run';
		state.runScript = script;
		ctx.fns.respawnVehicle();
		if ( script.mode === 'lap2' && script.crossState ) applyLegacyCrossState( script.crossState );
		if ( script.legacy ) state.started = true; // legacy: inject from step 0
		else ctx.fns.startCountdown();
		post( 'tas-run-started', { mode: script.mode, steps: script.entries.length } );
		updateOverlay();

	}

	// Legacy lap1/lap2 snapshot scripts only — never used by mode: run.
	function applyLegacyCrossState( cs ) {

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

	}

	window.addEventListener( 'message', ( event ) => {

		if ( event.source !== window.parent || ! event.data?.type ) return;
		const type = event.data.type;
		if ( type === 'tas-retry' ) retry();
		else if ( type === 'tas-run' ) run( event.data.script || '' );
		else if ( type === 'tas-stop' ) { state.phase = 'done'; ctx.tasBeginNextLap(); updateOverlay(); }

	} );

	// ── Overlay (TAS-only timing UI) ───────────────────────────────────
	const overlay = document.createElement( 'div' );
	overlay.id = 'tas-overlay';
	overlay.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;pointer-events:none;'
		+ 'font:600 12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#fff;'
		+ 'background:rgba(0,0,0,0.55);padding:6px 10px;border-radius:6px;white-space:pre;';
	document.body.appendChild( overlay );

	function updateOverlay() {

		const phaseLabel = state.phase === 'record' ? 'REC'
			: state.phase === 'run' ? 'RUN' : 'DONE';
		const lapLabel = ctx.isLoop ? `LOOP · lap ${ state.lapsCompleted + 1 }/${ lapsNeeded }`
			: 'NON-LOOP · 1 lap';
		overlay.textContent = `TAS ${ phaseLabel } · ${ lapLabel }`
			+ `\nstep ${ state.stepIndex } (${ TAS_STEP_HZ } Hz)`
			+ `\nsim ${ ctx.get.raceClock().toFixed( 2 ) }s`;

	}
	updateOverlay();

	post( 'tas-ready', { isLoop: ctx.isLoop, trackId: ctx.trackId, stepHz: TAS_STEP_HZ } );

	// Replay boot: tas.html stores a pending script in sessionStorage and
	// reloads this frame. Consuming it HERE — synchronously at init, before
	// the first sim step — makes the replay session state-for-state
	// identical to a fresh recording boot (same spawn, same fresh physics
	// world, same countdown, movers anchored at raceClock 0).
	try {

		const pending = sessionStorage.getItem( 'tas-pending-run' );
		sessionStorage.removeItem( 'tas-pending-run' );
		if ( pending ) run( pending );

	} catch ( e ) { /* storage unavailable — in-page run still works */ }

	return { step, onLapComplete };

}
