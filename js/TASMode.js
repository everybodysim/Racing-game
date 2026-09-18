// js/TASMode.js — game-side TAS mode (?tas=1), see docs/tas-editor-plan.md.
// Only loaded when ?tas=1 is in the game URL; normal gameplay never imports
// this module. Records the effective per-step input {x,z} in exact 1/60s sim
// steps (fixed-step sim = deterministic), injects scripts step-for-step, and
// captures/applies the cross-line body state for looping-track lap 2 runs.

const TAS_STEP_HZ = 60;

function zeroInput() { return { x: 0, z: 0 }; }

export function activate( ctx ) {

	if ( window.__tasActive ) return;
	window.__tasActive = true;

	const state = {
		phase: 'record',           // record | run | done
		lapsCompleted: 0,
		started: false,            // first driving step seen after countdown
		countdownSeen: false,
		stepIndex: 0,
		lastRecorded: null,
		lapBuffers: [ [] ],        // per-lap RLE buffers of {step, x, z}
		crossState: null,          // captured at lap1->2 cross (loop tracks)
		runScript: null,
		runPointer: 0,
		overlayTick: 0,
	};

	window.__tasState = () => ( {
		phase: state.phase,
		lapsCompleted: state.lapsCompleted,
		started: state.started,
		stepIndex: state.stepIndex,
		inputsRecorded: state.lapBuffers.reduce( ( n, b ) => n + b.length, 0 ),
		isLoop: ctx.isLoop,
		pos: [ ctx.vehicle.spherePos.x, ctx.vehicle.spherePos.y, ctx.vehicle.spherePos.z ],
		yaw: ctx.vehicle.container.rotation.y,
	} );

	const post = ( type, payload ) => {

		if ( window.parent && window.parent !== window ) window.parent.postMessage( { type, ...payload }, '*' );

	};

	// ── Cross-line state capture / apply ───────────────────────────────
	function captureCrossState() {

		const v = ctx.vehicle;
		const mp = v.rigidBody?.motionProperties;
		return {
			pos: [ v.spherePos.x, v.spherePos.y, v.spherePos.z ],
			vel: mp ? [ ...mp.linearVelocity ] : [ 0, 0, 0 ],
			angvel: mp ? [ ...mp.angularVelocity ] : [ 0, 0, 0 ],
			rot: [ v.container.rotation.x, v.container.rotation.y, v.container.rotation.z ],
			at: ctx.get.raceClock(),
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

	}

	// ── Script build / parse ──────────────────────────────────────────
	function fmt( n ) { return Number( n.toFixed( 4 ) ); }

	function buildScript( buffer, mode, crossState ) {

		const lines = [ '# Skid Circuit TAS v1', `track: ${ ctx.trackId }`, `mode: ${ mode }` ];
		if ( crossState ) {

			lines.push( `state: pos ${ crossState.pos.map( fmt ).join( ' ' ) }` );
			lines.push( `state: vel ${ crossState.vel.map( fmt ).join( ' ' ) }` );
			lines.push( `state: angvel ${ crossState.angvel.map( fmt ).join( ' ' ) }` );
			lines.push( `state: rot ${ crossState.rot.map( fmt ).join( ' ' ) }` );

		}
		for ( const entry of buffer ) lines.push( `step ${ entry.step } x=${ fmt( entry.x ) } z=${ fmt( entry.z ) }` );
		lines.push( 'end' );
		return lines.join( '\n' );

	}

	function parseScript( text ) {

		const script = { mode: 'lap1', crossState: null, entries: [], errors: [] };
		const num = ( s ) => Number( s );
		let lastStep = -1;
		for ( const rawLine of String( text ).split( /\r?\n/ ) ) {

			const line = rawLine.replace( /#.*$/, '' ).trim();
			if ( ! line ) continue;
			if ( line === 'end' ) break;
			if ( line.startsWith( 'track:' ) || line.startsWith( 'Skid Circuit TAS' ) ) continue;
			if ( line.startsWith( 'mode:' ) ) {

				const mode = line.slice( 5 ).trim();
				if ( mode !== 'lap1' && mode !== 'lap2' ) script.errors.push( `unknown mode "${ mode }"` );
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

					const m = /^(x|z)=(-?[0-9.]+)$/.exec( part );
					if ( m ) kv[ m[ 1 ] ] = num( m[ 2 ] );
					else script.errors.push( `bad token "${ part }" in: "${ line }"` );

				}
				script.entries.push( { step, x: clampInput( kv.x ), z: clampInput( kv.z ) } );
				continue;

			}
			script.errors.push( `unrecognized line: "${ line }"` );

		}
		if ( ! script.entries.length ) script.errors.push( 'no step lines' );
		if ( script.mode === 'lap2' ) {

			if ( ! script.crossState?.pos || ! script.crossState?.vel ) script.errors.push( 'lap2 scripts need "state: pos" and "state: vel" lines' );
			if ( ! script.crossState?.rot ) script.crossState = { ...script.crossState, rot: [ 0, 0, 0 ] };

		}
		return script;

	}

	function clampInput( v ) { return Number.isFinite( v ) ? Math.max( -1, Math.min( 1, v ) ) : 0; }

	function scriptInputAt( script, i ) {

		const entries = script.entries;
		while ( state.runPointer < entries.length - 1 && entries[ state.runPointer + 1 ].step <= i ) state.runPointer ++;
		const e = entries[ state.runPointer ];
		return e && e.step <= i ? { x: e.x, z: e.z } : zeroInput();

	}

	// ── Per-step hook (called from runSimulationStep after pad modifiers) ──
	function step( input ) {

		const raceClock = ctx.get.raceClock();
		const countdownActive = ctx.get.countdownActive();
		state.overlayTick ++;

		if ( state.phase === 'record' ) {

			if ( ! state.started ) {

				// Arm during the countdown; the first step AFTER it ends is
				// step 0 of the recording. If the countdown is disabled the
				// first sim step starts the recording directly.
				if ( countdownActive ) state.countdownSeen = true;
				else {

					state.started = true;
					state.stepIndex = 0;

				}

			}
			if ( state.started ) {

				const buffer = state.lapBuffers[ state.lapBuffers.length - 1 ];
				if ( state.lastRecorded === null || state.lastRecorded.x !== input.x || state.lastRecorded.z !== input.z ) {

					buffer.push( { step: state.stepIndex, x: input.x, z: input.z } );
					state.lastRecorded = { x: input.x, z: input.z };

				}
				state.stepIndex ++;
				if ( state.overlayTick % 6 === 0 ) updateOverlay( raceClock );
				return input;

			}
			if ( state.overlayTick % 6 === 0 ) updateOverlay( raceClock );
			return input;

		}

		if ( state.phase === 'run' ) {

			const scripted = scriptInputAt( state.runScript, state.stepIndex );
			state.stepIndex ++;
			if ( state.overlayTick % 6 === 0 ) updateOverlay( raceClock );
			return scripted;

		}

		// done: freeze driving
		if ( state.overlayTick % 6 === 0 ) updateOverlay( raceClock );
		return zeroInput();

	}

	// ── Lap cross hook (replaces the normal lap-transition block in TAS) ──
	function onLapComplete() {

		const lapSeconds = ctx.get.raceClock() - ctx.get.lapStart();
		state.lapsCompleted ++;

		if ( state.phase === 'run' ) {

			const stepCount = state.stepIndex;
			state.phase = 'done';
			ctx.tasBeginNextLap();
			post( 'tas-run-complete', { lapSeconds: round6( lapSeconds ), stepCount } );
			updateOverlay();
			return;

		}

		if ( ctx.isLoop && state.lapsCompleted === 1 ) {

			// Rolling straight into lap 2 — capture the flying-start state.
			state.crossState = captureCrossState();
			ctx.tasBeginNextLap();
			state.lapBuffers.push( [] );
			state.stepIndex = 0;
			state.lastRecorded = null;
			state.started = true;
			post( 'tas-lap-cross', { lap: 1, lapSeconds: round6( lapSeconds ) } );
			updateOverlay();
			return;

		}

		// Required lap count reached: hand the script to the editor.
		const buffer = ctx.isLoop ? state.lapBuffers[ 1 ] : state.lapBuffers[ 0 ];
		const mode = ctx.isLoop ? 'lap2' : 'lap1';
		const script = buildScript( buffer || [], mode, state.crossState );
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
	function resetRecording() {

		state.phase = 'record';
		state.lapsCompleted = 0;
		state.started = false;
		state.countdownSeen = false;
		state.stepIndex = 0;
		state.lastRecorded = null;
		state.lapBuffers = [ [] ];
		state.crossState = null;
		state.runScript = null;
		state.runPointer = 0;

	}

	function retry() {

		resetRecording();
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
		ctx.fns.respawnVehicle();
		if ( script.mode === 'lap2' ) applyCrossState( script.crossState );
		state.phase = 'run';
		state.stepIndex = 0;
		state.runScript = script;
		state.runPointer = 0;
		post( 'tas-run-started', { mode: script.mode, steps: script.entries.length } );
		updateOverlay();

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

	function updateOverlay( raceClock ) {

		const phaseLabel = state.phase === 'record' ? ( state.started ? 'REC' : 'ARM' )
			: state.phase === 'run' ? 'RUN' : 'DONE';
		const lapLabel = ctx.isLoop ? 'LOOP (2-lap record)' : 'NON-LOOP (1-lap record)';
		overlay.textContent = `TAS ${ phaseLabel } · ${ lapLabel }`
			+ `\nlap ${ state.lapsCompleted + ( state.phase === 'done' ? 0 : 1 ) } · step ${ state.stepIndex } (${ TAS_STEP_HZ } Hz)`
			+ ( raceClock !== undefined ? `\nsim ${ raceClock.toFixed( 2 ) }s` : '' );

	}
	updateOverlay( 0 );

	post( 'tas-ready', { isLoop: ctx.isLoop, trackId: ctx.trackId, stepHz: TAS_STEP_HZ } );

	return { step, onLapComplete };

}
