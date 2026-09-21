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
import * as THREE from 'three';

const TAS_STEP_HZ = 60;

function zeroInput() { return { x: 0, z: 0 }; }

// ── AI driver pure helpers (module level, no state deps) ──────────────
// Nearest guide point with a forward search window: the car may legitimately
// leave the guide line (cutting a corner, a whole different route), so the
// projection only looks BACK a little and FORWARD a lot — progress never
// goes backwards unless the car actually drives backwards.
function guideProject( pts, lastIdx, x, z ) {

	if ( ! pts || ! pts.length ) return 0;
	const lo = Math.max( 0, Math.floor( lastIdx ) - 8 );
	const hi = Math.min( pts.length - 1, Math.ceil( lastIdx ) + 40 );
	let bestIdx = lo, bestD = Infinity;
	for ( let i = lo; i <= hi; i ++ ) {

		const d = ( pts[ i ].x - x ) ** 2 + ( pts[ i ].z - z ) ** 2;
		if ( d < bestD ) { bestD = d; bestIdx = i; }

	}
	return bestIdx;

}

// Carrot steering bias for mutations: the guide's own motion direction at a
// step vs the direction to a point ~2s further along the guide. Returns the
// steer input (-1 | +1) toward the carrot side, or null when the guide is
// ~stationary / ~straight there (no signal -> plain random mutation).
// Sign conventions verified against the game: ArrowRight -> x=+1, and the
// heading->carrot cross product is negative when the carrot is to the
// car's RIGHT, so cross < 0 means steer +1.
function guideSteerBias( samples, step ) {

	if ( ! samples || samples.length < 3 ) return null;
	const at = ( st ) => samples[ Math.max( 0, Math.min( samples.length - 1, Math.round( st ) ) ) ];
	const cur = at( step ), back = at( step - 45 ), fwd = at( step + 120 );
	const hx = cur.x - back.x, hz = cur.z - back.z;
	const hxz = Math.hypot( hx, hz );
	if ( hxz < 0.2 ) return null; // guide car was ~parked here
	const tx = fwd.x - cur.x, tz = fwd.z - cur.z;
	const txz = Math.hypot( tx, tz );
	if ( txz < 0.2 ) return null; // carrot sits on top of us
	const cross = ( hz * tx - hx * tz ) / ( hxz * txz ); // sin(signed angle)
	if ( Math.abs( cross ) < 0.12 ) return null; // guide ~straight here
	return cross < 0 ? 1 : -1;

}

// Fitness ranking: a FINISH always outranks progress (the carrot guides the
// search, it never becomes the law — a genuine shortcut must still win).
// Among finishers the precise time decides; among non-finishers the furthest
// guide progress decides, earlier-is-better as tiebreak.
function aiFitCompare( a, b ) {

	const af = Number.isFinite( a.finish ), bf = Number.isFinite( b.finish );
	if ( af !== bf ) return af ? -1 : 1;
	if ( af ) return a.finish - b.finish;
	if ( a.prog !== b.prog ) return b.prog - a.prog;
	return a.progStep - b.progStep;

}

// Crossover: splice two timed laps where each parent first reached the SAME
// progress fraction. B's tail is renumbered so the child is a valid ordered
// timeline (steps strictly increasing across the junction). Returns null
// when either parent's map can't support a cut at that fraction.
function aiSplice( lapA, mapA, bestA, lapB, mapB, bestB, frac ) {

	if ( ! lapA || ! lapB || ! mapA || ! mapB || bestA <= 0 || bestB <= 0 ) return null;
	const targetA = frac * bestA, targetB = frac * bestB;
	let sa = -1, sb = -1;
	for ( const [ st, pr ] of mapA ) if ( pr >= targetA ) { sa = st; break; }
	for ( const [ st, pr ] of mapB ) if ( pr >= targetB ) { sb = st; break; }
	if ( sa <= 0 || sb <= 0 ) return null;
	const head = lapA.filter( ( e ) => e.step < sa );
	const tail = lapB.filter( ( e ) => e.step >= sb ).map( ( e ) => ( { step: e.step - sb + sa, x: e.x, z: e.z } ) );
	const child = [ ...head ];
	for ( const e of tail ) {

		// ordered merge (tail steps are already increasing; guard anyway)
		if ( ! child.length || e.step > child[ child.length - 1 ].step ) child.push( e );

	}
	return child.length ? child : null;

}

// ── Neural driver helpers (a real learning model: an MLP policy whose
// weights are LEARNED by evolution each generation — MarI/O style) ────
// 7 inputs: [carrot sin, carrot cos, carrot dist, speed, last steer,
// last throttle, 1(bias)] -> 10 tanh hidden -> 2 tanh outputs (steer,
// throttle). Discrete actions via thresholds so runs stay RLE-friendly.
const NN_IN = 7, NN_H = 10, NN_OUT = 2;
const NN_W = NN_IN * NN_H + NN_H + NN_H * NN_OUT + NN_OUT;

function nnMakeGenome( scale ) {

	const w = new Float32Array( NN_W );
	for ( let i = 0; i < NN_W; i ++ ) w[ i ] = ( Math.random() * 2 - 1 ) * ( scale || 1 );
	return w;

}

function nnForward( w, inp ) {

	const h = new Float32Array( NN_H );
	for ( let j = 0; j < NN_H; j ++ ) {

		let sum = 0;
		for ( let i = 0; i < NN_IN; i ++ ) sum += w[ j * NN_IN + i ] * inp[ i ]; // inp[6] = 1 (bias)
		h[ j ] = Math.tanh( sum );

	}
	let p = NN_IN * NN_H + NN_H; // skip the reserved hidden-bias block
	const out = new Float32Array( NN_OUT );
	for ( let k = 0; k < NN_OUT; k ++ ) {

		const base = p + k * ( NN_H + 1 ); // NN_H weights + 1 bias per output
		let sum = w[ base + NN_H ];
		for ( let j = 0; j < NN_H; j ++ ) sum += w[ base + j ] * h[ j ];
		out[ k ] = Math.tanh( sum );

	}
	return out;

}

function nnMutate( w, sigma ) {

	const c = new Float32Array( w );
	// gaussian noise on a sparse subset (keeps learned structure)
	const n = Math.max( 1, Math.round( NN_W * 0.12 ) );
	for ( let i = 0; i < n; i ++ ) c[ ( Math.random() * NN_W ) | 0 ] += gauss() * sigma;
	return c;

}

function nnCrossover( a, b ) {

	const c = new Float32Array( NN_W );
	for ( let i = 0; i < NN_W; i ++ ) c[ i ] = Math.random() < 0.5 ? a[ i ] : b[ i ];
	return c;

}

function gauss() {

	let u = 0, v = 0;
	while ( u === 0 ) u = Math.random();
	while ( v === 0 ) v = Math.random();
	return Math.sqrt( -2 * Math.log( u ) ) * Math.cos( 2 * Math.PI * v );

}

// Compact "inputs the AI changed vs its seed" summary for the debug panel:
// "+step" = an entry the seed doesn't have at that step (added pulse),
// "~step" = same step but different steering/throttle values.
function aiDiffLines( seed, cand, maxLines ) {

	const seedLap = seed.lap2.length ? seed.lap2 : seed.lap1;
	const candLap = cand.lap2.length ? cand.lap2 : cand.lap1;
	const seedMap = new Map( seedLap.map( ( e ) => [ e.step, e ] ) );
	const out = [];
	for ( const e of candLap ) {

		const se = seedMap.get( e.step );
		if ( ! se ) out.push( `+${ e.step }:x${ e.x },z${ e.z }` );
		else if ( se.x !== e.x || se.z !== e.z ) out.push( `~${ e.step }:x${ e.x },z${ e.z }` );
		if ( out.length >= maxLines ) break;

	}
	return out.join( '  ' );

}

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
		targetMode: false,        // brute/run goal: 'time' (false) | 'target' (true)
		aiGuide: null,            // captured guide lap for the AI driver
		target: null,             // { x, z } world center of the target zone
		targetPlacing: false,
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
			targetMode: state.targetMode,
			aiGuide: state.aiGuide ? { pts: state.aiGuide.pts.length, samples: state.aiGuide.samples.length } : null,
			target: state.target ? { ...state.target } : null,
			targetPlacing: state.targetPlacing,
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
	const KEEP_SELECTOR = '#loading-screen, #countdown-hud, #export-ghost-btn, #import-ghost-btn, #tas-overlay, #replay-topbar, #tas-keys';
	const KEEP_IDS = new Set( [ 'loading-screen', 'countdown-hud', 'export-ghost-btn', 'import-ghost-btn', 'tas-overlay', 'replay-topbar', 'tas-keys' ] );
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

	// Unfinished-run grab (verify-a-hard-track workflow): exactly what has
	// been recorded SO FAR. Unlike buildScript() it never synthesizes a
	// 'cross' line — on a loop track mid-lap-1 the crossing hasn't happened,
	// so the export is lap 1 only and says so honestly.
	function buildPartialScript() {

		const lines = [ '# Skid Circuit TAS v11', `track: ${ ctx.trackId }`, 'mode: run' ];
		if ( ctx.isLoop && state.lapsCompleted >= 1 && state.crossState ) {

			lines.push( `state: pos ${ state.crossState.pos.map( fmt ).join( ' ' ) }` );
			lines.push( `state: vel ${ state.crossState.vel.map( fmt ).join( ' ' ) }` );
			lines.push( `state: angvel ${ state.crossState.angvel.map( fmt ).join( ' ' ) }` );
			lines.push( `state: rot ${ state.crossState.rot.map( fmt ).join( ' ' ) }` );
			if ( state.crossState.game ) lines.push( `state: game ${ JSON.stringify( state.crossState.game ) }` );

		}
		for ( const entry of state.lapBuffers[ 0 ] || [] ) lines.push( `step ${ entry.step } x=${ fmt( entry.x ) } z=${ fmt( entry.z ) }` );
		if ( ctx.isLoop && state.lapsCompleted >= 1 && state.crossState ) {

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

		// In-game arrow-key display: show the EFFECTIVE input — the pad
		// while recording (fingers on keys during the countdown too), the
		// scripted values while replaying, nothing once the run is done.
		// Skipped during fast-forward bursts: hundreds of raw steps per
		// frame would just thrash the DOM for one invisible flicker.
		if ( ctx.fns.updateTasKeys && ! state.fastForward ) {

			let display = input;
			if ( state.phase === 'done' ) display = zeroInput();
			else if ( state.phase === 'run' ) display = state.started ? scriptInputAt( state.stepIndex ) : zeroInput();
			ctx.fns.updateTasKeys( display );

		}

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

		// Neural driver: the MLP steers instead of a script. Same arming
		// rules (no injection until the countdown ends); every step the net
		// reads the world (carrot angle/dist, speed, its own last actions)
		// and decides steer/throttle. Input CHANGES are recorded as a
		// normal RLE timeline so a learned run can be adopted & replayed.
		if ( state.phase === 'run' && state.nnBrain && state.runScript ) {

			if ( ! state.started ) {

				if ( ctx.get.countdownActive() ) { if ( state.overlayTick % 6 === 0 ) updateOverlay(); return zeroInput(); }
				state.started = true;
				state.stepIndex = 0;

			}
			const a = nnBrainAct();
			if ( state.lastRecorded === null || state.lastRecorded.x !== a.x || state.lastRecorded.z !== a.z ) {

				state.nnRecord.push( { step: state.stepIndex, x: a.x, z: a.z } );
				state.lastRecorded = { x: a.x, z: a.z };

			}
			state.stepIndex ++;
			if ( state.overlayTick % 6 === 0 ) updateOverlay();
			return a;

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
			// Target-goal runs: reaching the zone IS the goal — the run
			// ends there (same "done" freeze a finish crossing produces).
			if ( state.started && state.targetMode && targetHit() ) {

				state.phase = 'done';
				ctx.tasBeginNextLap();
				post( 'tas-run-complete', { reachedTarget: true, stepCount: state.stepIndex } );
				updateOverlay();
				return zeroInput();

			}
			// Unfinished (imported partial) run: the calc learned no finish
			// crossing ever comes. End playback at the SAME bound the calc
			// broke at — last input + 10s coast — instead of driving off
			// forever on the held last input.
			if ( state.started && state.playback.unfinished ) {

				const es = state.runEntries;
				if ( es && es.length && state.stepIndex > es[ es.length - 1 ].step + 60 * 10 ) {

					state.phase = 'done';
					ctx.tasBeginNextLap();
					post( 'tas-run-complete', { unfinished: true, stepCount: state.stepIndex } );
					updateOverlay();
					return zeroInput();

				}

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

		// Post-run crossings are always junk: after a run (or a brute-force
		// pass) finishes, the car can still drift through the finish plane
		// with residual velocity — the per-frame detector fires it, the
		// 'done' phase skips the run branch below, and the RECORD path
		// used to take it: a bugged "Lap complete — use this run?" popup
		// with the half-finished junk state. Once done, crossings die here.
		if ( state.phase === 'done' ) return;

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
			if ( state.brute && ! state.targetMode ) state.bruteResult = lapSeconds; // target mode scores ZONE REACHES, not finishes
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

	// ── Brute target zone ("Goal: reach target area") ───────────────────
	// A tall transparent cylinder anywhere on the map (no grid snap — the
	// pick is a camera raycast against whatever you clicked, sky clicks
	// fall back to the y=0 ground plane). The car's hitbox entering the
	// cylinder counts as SUCCESS for brute runs and ends replay runs.
	const TARGET_RADIUS = 3, TARGET_SLACK = 1, TARGET_HEIGHT = 60; // tall: ground level through elevated decks
	const targetGeo = new THREE.CylinderGeometry( TARGET_RADIUS, TARGET_RADIUS, TARGET_HEIGHT, 32 );
	const mkTargetMat = ( op ) => new THREE.MeshBasicMaterial( { color: 0x3fb950, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide } );
	const targetMesh = new THREE.Mesh( targetGeo, mkTargetMat( 0.25 ) );
	const ghostMesh = new THREE.Mesh( targetGeo, mkTargetMat( 0.10 ) );
	for ( const m of [ targetMesh, ghostMesh ] ) {

		m.position.y = TARGET_HEIGHT / 2;
		m.visible = false;
		m.userData.tasTarget = true;
		m.raycast = () => {}; // never block its own placement pick

	}
	if ( ctx.fns.getScene ) ctx.fns.getScene().add( targetMesh, ghostMesh );

	function setPlacing( on ) {

		state.targetPlacing = on;
		const canvas = ctx.fns.getCanvas && ctx.fns.getCanvas();
		if ( canvas ) canvas.style.cursor = on ? 'crosshair' : '';
		ghostMesh.visible = false; // re-shown on the next mousemove

	}

	function targetHit() {

		if ( ! state.target ) return false;
		const p = ctx.vehicle.spherePos;
		const dx = p.x - state.target.x, dz = p.z - state.target.z;
		const r = TARGET_RADIUS + TARGET_SLACK;
		return dx * dx + dz * dz <= r * r;

	}

	window.addEventListener( 'mousemove', ( e ) => {

		if ( ! state.targetPlacing ) return;
		const p = ctx.fns.pickWorldPoint && ctx.fns.pickWorldPoint( e.clientX, e.clientY );
		if ( p ) { ghostMesh.position.set( p.x, TARGET_HEIGHT / 2, p.z ); ghostMesh.visible = true; }

	} );
	window.addEventListener( 'click', ( e ) => {

		if ( ! state.targetPlacing ) return;
		const canvas = ctx.fns.getCanvas && ctx.fns.getCanvas();
		if ( canvas && e.target !== canvas ) return; // overlay clicks don't place
		const p = ctx.fns.pickWorldPoint && ctx.fns.pickWorldPoint( e.clientX, e.clientY );
		if ( ! p ) return;
		state.target = { x: p.x, z: p.z };
		targetMesh.position.set( p.x, TARGET_HEIGHT / 2, p.z );
		targetMesh.visible = true;
		setPlacing( false );
		post( 'tas-target-placed', { x: p.x, z: p.z } );

	} );
	window.addEventListener( 'keydown', ( e ) => {

		if ( state.targetPlacing && e.code === 'Escape' ) {

			setPlacing( false );
			post( 'tas-target-canceled', {} );

		}

	} );

	// ── AI driver guide visuals: the carrot + the guide line ────────────
	// The carrot is the guide point ~2s ahead of the best candidate's
	// current reward position — exactly what guideSteerBias steers toward.
	const carrotMesh = new THREE.Mesh(
		new THREE.ConeGeometry( 0.45, 1.5, 12 ),
		new THREE.MeshBasicMaterial( { color: 0xff8c42 } )
	);
	carrotMesh.rotation.x = Math.PI; // tip pointing down, hovering over the road
	carrotMesh.position.y = 1.7;
	carrotMesh.visible = false;
	carrotMesh.userData.tasTarget = true;
	carrotMesh.raycast = () => {}; // never blocks the target placement pick
	let guideLine = null;
	if ( ctx.fns.getScene ) ctx.fns.getScene().add( carrotMesh );

	function showGuideLine( guide ) {

		hideGuideLine();
		if ( ! guide || ! ctx.fns.getScene || guide.pts.length < 2 ) return;
		const pts = guide.pts.map( ( p ) => new THREE.Vector3( p.x, 0.7, p.z ) );
		guideLine = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints( pts ),
			new THREE.LineBasicMaterial( { color: 0xff8c42, transparent: true, opacity: 0.45 } )
		);
		guideLine.userData.tasTarget = true;
		ctx.fns.getScene().add( guideLine );

	}

	function hideGuideLine() {

		if ( guideLine && ctx.fns.getScene ) {

			ctx.fns.getScene().remove( guideLine );
			guideLine.geometry.dispose();
			guideLine.material.dispose();
			guideLine = null;

		}

	}

	// prog is a guide POINT index (same scale guideProject tracks); the
	// visual carrot sits ~20 points (~2s at cruising speed) further along.
	function positionCarrot( guide, prog ) {

		if ( ! guide || ! guide.pts.length ) { carrotMesh.visible = false; return; }
		const idx = Math.max( 0, Math.min( guide.pts.length - 1, Math.round( prog ) + 20 ) );
		const p = guide.pts[ idx ];
		carrotMesh.position.set( p.x, 1.7, p.z );
		carrotMesh.visible = true;

	}

	function hideAiVisuals() {

		carrotMesh.visible = false;
		hideGuideLine();

	}

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
		// Every pass (record, run, seek, brute eval) starts the sim clock at
		// 0 — mods keyed on the absolute race clock (waves, timed effects)
		// then see the SAME window as the recorded drive.
		if ( ctx.fns.resetRaceClock ) ctx.fns.resetRaceClock();

	}

	function retry() {

		resetState( 'record' );
		ctx.fns.respawnVehicle();
		resetCarPhysicsHistory();
		ctx.fns.startCountdown();
		post( 'tas-retry-started', {} );
		updateOverlay();

	}

	function run( text, startAtLap2, goal ) {

		const script = parseScript( text );
		if ( script.errors.length ) {

			post( 'tas-run-invalid', { errors: script.errors } );
			return;

		}
		// Goal for this run: 'target' only counts with a placed zone;
		// everything else behaves exactly like a normal time run.
		state.targetMode = goal === 'target' && !! state.target;
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
		if ( ctx.fns.stepOnce && script.lap1.length ) {

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
					// Target-goal: the calc stops at the zone — the reach
					// step is the run's total; playback ends at the same
					// step via the step() check.
					if ( state.phase === 'run' && state.targetMode && targetHit() ) {

						state.playback.totalSteps = globalStep();
						break;

					}
					// Unfinished runs (imported partial attempts): the
					// inputs run out long before any finish exists. Keep
					// simulating only a 10s coast window past the last
					// input (a coasting finish still counts), then stop
					// burning burst steps and pin the slider bounds to
					// where the timeline actually ends — a null bound
					// meant slider max 0 and seeks that never fired.
					if ( state.phase === 'run' && state.started ) {

						const es = state.runEntries;
						const last = es && es.length ? es[ es.length - 1 ].step : null;
						if ( last != null && state.stepIndex > last + 60 * 10 ) {

							state.playback.totalSteps = globalStep();
							state.playback.unfinished = true;
							break;

						}

					}

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
		if ( startAtLap2 && l1c == null ) startAtLap2 = false; // no crossing learned — nothing to skip to
		if ( startAtLap2 && script.lap2.length ) {

			// Skip mode: the calc above learned the run's shape (crossing
			// step, total, precise time — the slider shows #/# and the
			// label shows the result). seekTo re-anchors and BURSTS lap 1
			// synchronously — never a real-time lap-1 replay — then lap 2
			// plays real-time from the exact recorded crossing state.
			// Edited scripts where lap 1 can't cross still get the instant
			// teleport fallback inside seekTo.
			seekTo( l1c != null ? l1c : 1 );

		} else seekTo( 0 );
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
					// Non-loop runs (and loop runs whose calc never found a
					// crossing) have NO lap-1 boundary to burst toward — the
					// target IS the position. Without this break the burst
					// ran the ENTIRE lap, "arriving" instantly at the finish
					// so the run zoomed past instead of playing (user bug:
					// non-loop runs unwatchable, checkbox irrelevant).
					if ( l1c == null && state.started && state.stepIndex >= target ) break;

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
	function mutateScript( script, mutations, addInput, guide, stats ) {

		const cand = cloneScript( script );
		const timedLap = cand.lap2.length ? cand.lap2 : cand.lap1;
		if ( ! timedLap.length ) return cand;
		// Carrot-biased steering pick (AI driver only; plain brute passes no
		// guide and gets the original uniform pickOther, byte-identical).
		// ~65% of steering pulses bend toward the side the guide's carrot
		// sits on; the rest stay random so the population keeps exploring.
		const pickSteer = ( e ) => {

			const bias = guide ? guideSteerBias( guide.samples, e.step ) : null;
			if ( bias == null || bias === e.x ) { if ( stats ) stats.steerRandom ++; return pickOther( e.x ); }
			if ( Math.random() < 0.65 ) { if ( stats ) stats.steerBiased ++; return bias; }
			if ( stats ) stats.steerRandom ++;
			return pickOther( e.x );

		};
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
				pulse[ key ] = ( key === 'x' && guide ) ? pickSteer( e ) : pickOther( e[ key ] );
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

	// Quick simulation of one candidate, no rendering. Returns the timed
	// lap's seconds, or Infinity when the candidate never finishes.
	//
	// SAVE-STATE FAST PATH (loop tracks with a recorded crossing state):
	// mutations only ever touch the TIMED lap's entries, so every
	// candidate's lap 1 is byte-identical — re-simulating the countdown and
	// lap 1 for each candidate is pure waste. Instead restore the recorded
	// line-crossing state directly (the exact call sequence the real
	// crossing runs: applyCrossState -> resetCarPhysicsHistory -> entries
	// swap -> tasBeginNextLap) and burst ONLY the timed lap. This is the
	// TMInterface-style save-state model: restore, simulate forward,
	// measure.
	//
	// PRUNING: only strictly-faster finishes are ever adopted, so once a
	// candidate's timed-lap clock has passed the current best time it
	// mathematically cannot win — abort immediately instead of grinding to
	// the burst cap (a wall-slammer used to burn its whole 30s-slack
	// budget before giving up). The +2-step margin is strictly safe: the
	// best a candidate can do from S elapsed steps is (S-1)/60 seconds
	// (sub-step crossing credit is < 1/60), so past bestTime*60+2 steps it
	// can never reach bestTime.
	function bruteEvaluate( script, pruneTime = Infinity, fast = false ) {

		state.bruteResult = null;
		const l1Last = script.lap1.length ? script.lap1[ script.lap1.length - 1 ].step : 0;
		const l2Last = script.lap2.length ? script.lap2[ script.lap2.length - 1 ].step : 0;
		let burstCap;
		let timedStart; // lapsCompleted value once the car is IN the timed lap
		if ( fast && script.crossState && script.crossState.pos && script.crossState.vel && script.lap2.length ) {

			resetState( 'run' );
			state.runScript = script;
			state.skipMode = true;
			state.lapsCompleted = 1;
			applyCrossState( script.crossState );
			resetCarPhysicsHistory();
			state.runEntries = script.lap2;
			state.runPointer = 0;
			state.runLaps = 1; // the finish crossing of the timed lap IS the done state
			state.stepIndex = 0;
			state.started = true;
			ctx.tasBeginNextLap();
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			timedStart = 1;
			burstCap = l2Last + 60 * 30; // timed-lap inputs + the same 30s finish slack

		} else {

			resetState( 'run' );
			state.runScript = script;
			state.stepIndex = 0;
			ctx.fns.respawnVehicle();
			resetCarPhysicsHistory();
			state.runEntries = script.lap1;
			state.runLaps = script.lap2.length ? 2 : ( ctx.isLoop && script.mode === 'run' && ! script.crossState ? 2 : 1 );
			state.started = false;
			ctx.fns.startCountdown();
			timedStart = script.lap2.length ? 1 : 0;
			// The cap must cover the countdown PLUS the full duration of EVERY
			// lap: the crossing step is far past the last input-change step, so
			// budgeting off entry steps starved lap 2 and every candidate DNF'd.
			burstCap = 60 * 5 + ( l1Last + 60 * 30 ) + ( script.lap2.length ? l2Last + 60 * 30 : 0 );

		}
		state.fastForward = true;
		// Target mode prunes in global steps against the current best
		// reach (pruneTime IS a step count there); time mode prunes in
		// lap-local steps past bestTime's 60Hz equivalent.
		const pruneSteps = Number.isFinite( pruneTime )
			? ( state.targetMode ? Math.floor( pruneTime ) + 1 : pruneTime * 60 + 2 )
			: Infinity;
		let burst = 0;
		try {

			while ( state.phase === 'run' && burst ++ < burstCap ) {

				ctx.fns.stepOnce();
				if ( state.phase === 'run' ) probeLapCross();
				// Target-goal scoring: the FIRST step whose car position is
				// inside the zone is the candidate's score (lower = better
				// = "use the fastest run" among the successes).
				if ( state.phase === 'run' && state.targetMode && targetHit() ) {

					state.bruteResult = globalStep();
					break;

				}
				if ( state.phase === 'run' && state.lapsCompleted >= timedStart
					&& ( state.targetMode ? globalStep() : state.stepIndex ) > pruneSteps ) break;

			}

		} catch ( e ) { /* DNF */ }
		state.fastForward = false;
		return state.bruteResult === null ? Infinity : state.bruteResult;

	}

	// End-of-brute viewport reset: the last burst leaves the car mid-track
	// (often near/past the finish) with residual velocity, still in 'run'
	// phase on the DNF path — it kept drifting, sometimes crossing the
	// finish again. Park the car at the start line, idle and done.
	function bruteCleanup() {

		resetState( 'done' );
		ctx.fns.respawnVehicle();
		resetCarPhysicsHistory();
		if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
		updateOverlay();

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
		// GOAL: 'time' = current behavior (fastest finish). 'target' =
		// success is the car entering the placed zone; among successes the
		// fastest (earliest reach) run wins; failures are trashed.
		const goal = payload.goal === 'target' ? 'target' : 'time';
		if ( goal === 'target' && ! state.target ) {

			post( 'tas-bruteforce-error', { errors: [ 'select a target area first (place the zone on the map)' ] } );
			return;

		}
		state.targetMode = goal === 'target';
		// Save-state acceleration applies when the script carries the recorded
		// line-crossing state (loop tracks). Non-loop scripts keep the full
		// countdown+lap re-simulation; pruning protects both paths. Target
		// runs always full-sim: the zone can sit anywhere on the timeline
		// (including lap 1), and mutations never touch lap 1 anyway.
		const fast = goal === 'time' && !!( script.crossState && script.crossState.pos && script.crossState.vel && script.lap2.length && ctx.tasBeginNextLap );
		// Target metrics are STEP counts, not seconds — show them as such.
		const fmtGoal = ( v ) => state.targetMode
			? ( Number.isFinite( v ) ? `${ Math.round( v ) } steps` : 'none yet' )
			: fmtTime( v );
		state.brute = { stop: false, round: 0, rounds, best: null, last: null, adopted: 0, evals: 0 };
		const baseline = bruteEvaluate( script, Infinity, fast );
		state.brute.evals ++;
		// Time mode refuses to mutate a DNF baseline (wall-slam protection).
		// Target mode allows an unreachable baseline — the brute then hunts
		// for ANY reach first, adopting only genuine successes.
		if ( goal === 'time' && ! Number.isFinite( baseline ) ) {

			// NEVER mutate a script whose own timed run does not finish:
			// with an infinite baseline any garbage finisher would count
			// as "better" and the brute would replace the user's run with
			// a wall-slam. Keep the script byte-identical and say why.
			state.brute = null;
			bruteCleanup();
			post( 'tas-bruteforce-error', { errors: [ 'Baseline run did not finish in the fast simulation — the script was NOT changed. Make the run finish (Run button) before brute-forcing.' ] } );
			return;

		}
		let bestScript = script;
		let bestTime = baseline;
		state.brute.best = baseline;
		post( 'tas-bruteforce-progress', { round: 0, rounds, bestTime: fmtGoal( bestTime ), lastTime: fmtGoal( baseline ), adopted: false } );
		// Beam search: keep the top `beamWidth` candidates (not just the
		// single best), mutate EVERY seed each round, re-rank by precise
		// finish time. Several live lineages escape the single-track dead
		// ends plain hill-climbing gets stuck in.
		const beamWidth = Math.max( 1, Math.min( 8, Number( payload.beam ) || 4 ) );
		let beam = [ { script, time: baseline } ];
		for ( let round = 1; round <= rounds; round ++ ) {

			if ( state.brute.stop ) break;
			const pool = beam.slice();
			for ( const seed of beam ) {

				const candidate = mutateScript( seed.script, mutations, addInput );
				pool.push( { script: candidate, time: bruteEvaluate( candidate, bestTime, fast ) } );
				state.brute.evals ++;

			}
			pool.sort( ( a, b ) => a.time - b.time );
			beam = pool.slice( 0, beamWidth );
			const best = beam[ 0 ];
			let adopted = false;
			if ( best.time < bestTime ) {

				bestTime = best.time;
				bestScript = best.script;
				adopted = true;
				state.brute.adopted ++;
				post( 'tas-bruteforce-update', { script: scriptToText( bestScript ) } );

			}
			state.brute.round = round;
			state.brute.best = bestTime;
			state.brute.last = best.time;
			post( 'tas-bruteforce-progress', { round, rounds, bestTime: fmtGoal( bestTime ), lastTime: fmtGoal( best.time ), adopted, evals: state.brute.evals, fast } );
			await new Promise( ( r ) => setTimeout( r, 0 ) ); // yield to the editor UI

		}
		const bestText = scriptToText( bestScript );
		state.lastRunText = bestText; // R / Run re-run the best found
		const improved = bestTime < baseline;
		state.brute = null;
		bruteCleanup();
		post( 'tas-bruteforce-done', { bestTime: fmtGoal( bestTime ), improved, script: bestText, targetMode: state.targetMode } );

	}

	// ── AI driver: evolve a full run from the user's lap (carrot method) ──
	// GUIDE: the recorded run is re-simulated once in a burst; every step's
	// car position is sampled (aligned to the timed lap's entry steps —
	// stepIndex restarts at 0 at the lap-1 crossing on loop tracks, exactly
	// where the mutated entries live). The samples are resampled to ~2-unit
	// guide points for progress tracking.
	function captureGuide( script ) {

		const fast = !!( script.crossState && script.crossState.pos && script.crossState.vel && script.lap2.length && ctx.tasBeginNextLap );
		const timed = fast ? script.lap2 : script.lap1;
		if ( ! timed.length ) return null;
		state.bruteResult = null;
		const lLast = timed[ timed.length - 1 ].step;
		let burstCap;
		if ( fast ) {

			resetState( 'run' );
			state.runScript = script;
			state.skipMode = true;
			state.lapsCompleted = 1;
			applyCrossState( script.crossState );
			resetCarPhysicsHistory();
			state.runEntries = script.lap2;
			state.runPointer = 0;
			state.runLaps = 1;
			state.stepIndex = 0;
			state.started = true;
			ctx.tasBeginNextLap();
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			burstCap = lLast + 60 * 30;

		} else {

			resetState( 'run' );
			state.runScript = script;
			state.stepIndex = 0;
			ctx.fns.respawnVehicle();
			resetCarPhysicsHistory();
			state.runEntries = script.lap1;
			state.runLaps = script.lap2.length ? 2 : ( ctx.isLoop && script.mode === 'run' && ! script.crossState ? 2 : 1 );
			state.started = false;
			ctx.fns.startCountdown();
			burstCap = 60 * 5 + ( lLast + 60 * 30 );

		}
		const samples = [];
		state.fastForward = true;
		let burst = 0, movedStep = 0;
		try {

			while ( state.phase === 'run' && burst ++ < burstCap ) {

				ctx.fns.stepOnce();
				if ( state.phase === 'run' ) probeLapCross();
				if ( state.started ) {

					const p = ctx.vehicle.spherePos;
					samples.push( { x: p.x, z: p.z } );
					// stop sampling once the baseline has been parked for 4s
					// (no NEW 2-unit-separated point): a crashed baseline
					// used to sample its whole 30s wall-coast budget.
					if ( samples.length > 1 ) {

						const ref = samples[ samples.length - 2 ];
						if ( ( p.x - ref.x ) ** 2 + ( p.z - ref.z ) ** 2 >= 0.04 ) movedStep = samples.length;

					}
					if ( samples.length - movedStep > 60 * 4 ) break;

				}

			}

		} catch ( e ) { /* baseline dying mid-guide is fine: the carrot covers what it drove */ }
		state.fastForward = false;
		if ( samples.length < 10 ) {

			window.__lastGuideDiag = { samples: samples.length, movedStep, burst, phase: state.phase, started: state.started, stepIndex: state.stepIndex };
			return null;

		}
		const pts = [ samples[ 0 ] ];
		for ( const smp of samples ) {

			const ref = pts[ pts.length - 1 ];
			if ( ( smp.x - ref.x ) ** 2 + ( smp.z - ref.z ) ** 2 >= 4 ) pts.push( smp ); // ~2 units apart

		}
		if ( pts.length < 2 ) return null;
		return { samples, pts };

	}

	// One AI candidate: quick-sim like a brute candidate, but scored by
	// carrot progress (furthest guide point reached) with the same
	// finish-first ranking the brute adoption rules demand. Stuck cars die
	// fast: 4 seconds without forward progress aborts the sim (a
	// wall-humper used to burn its full 30s slack budget).
	function aiEvaluate( script, guide, fast, refTotal ) {

		state.bruteResult = null;
		// Reward scale: guide mode = guide point index (0..pts-1);
		// guide-less mode = world units of furthest straight-line distance
		// from the sim's start point (refTotal = the baseline's distance).
		const total = guide ? guide.pts.length - 1 : ( refTotal || 1 );
		const timed = fast ? script.lap2 : script.lap1;
		const lLast = timed.length ? timed[ timed.length - 1 ].step : 0;
		let burstCap;
		if ( fast ) {

			resetState( 'run' );
			state.runScript = script;
			state.skipMode = true;
			state.lapsCompleted = 1;
			applyCrossState( script.crossState );
			resetCarPhysicsHistory();
			state.runEntries = script.lap2;
			state.runPointer = 0;
			state.runLaps = 1;
			state.stepIndex = 0;
			state.started = true;
			ctx.tasBeginNextLap();
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			burstCap = lLast + 60 * 30;

		} else {

			resetState( 'run' );
			state.runScript = script;
			state.stepIndex = 0;
			ctx.fns.respawnVehicle();
			resetCarPhysicsHistory();
			state.runEntries = script.lap1;
			state.runLaps = script.lap2.length ? 2 : ( ctx.isLoop && script.mode === 'run' && ! script.crossState ? 2 : 1 );
			state.started = false;
			ctx.fns.startCountdown();
			burstCap = 60 * 5 + ( lLast + 60 * 30 );

		}
		state.fastForward = true;
		let burst = 0, progIdx = 0, lastProgressStep = 0;
		let bestProg = 0, bestProgStep = 0;
		const map = []; // sparse [step, progress] every 30 steps (crossover cut points)
		// start point for the guide-less distance reward (spawn or the
		// lap-2 crossing, depending on mode)
		const startP = { x: ctx.vehicle.spherePos.x, z: ctx.vehicle.spherePos.z };
		try {

			while ( state.phase === 'run' && burst ++ < burstCap ) {

				ctx.fns.stepOnce();
				if ( state.phase === 'run' ) probeLapCross();
				if ( state.phase === 'run' && state.started ) {

					let progressed = false;
					if ( guide ) {

						const p = ctx.vehicle.spherePos;
						const idx = guideProject( guide.pts, progIdx, p.x, p.z );
						if ( idx > progIdx ) {

							progIdx = idx;
							lastProgressStep = state.stepIndex;
							progressed = true;
							if ( progIdx > bestProg ) { bestProg = progIdx; bestProgStep = state.stepIndex; }

						}

					} else {

						// guide-less reward: furthest distance from the start
						const p = ctx.vehicle.spherePos;
						const d = Math.hypot( p.x - startP.x, p.z - startP.z );
						if ( d > bestProg + 0.02 ) {

							bestProg = d;
							bestProgStep = state.stepIndex;
							lastProgressStep = state.stepIndex;
							progressed = true;

						}

					}
					if ( ! progressed && state.stepIndex - lastProgressStep > 60 * 4 ) break; // stuck
					if ( state.stepIndex % 30 === 0 ) map.push( [ state.stepIndex, bestProg ] );

				}

			}

		} catch ( e ) { /* DNF */ }
		state.fastForward = false;
		const finish = state.bruteResult === null ? Infinity : state.bruteResult;
		// a finish IS full progress for ranking purposes
		if ( Number.isFinite( finish ) ) { bestProg = total; bestProgStep = state.stepIndex; }
		return { finish, prog: bestProg, progStep: bestProgStep, steps: state.stepIndex, map, total };

	}

	// One MLP decision: build the sensor vector, forward pass, thresholds.
	function nnBrainAct() {

		const b = state.nnBrain, p = ctx.vehicle.spherePos;
		// heading & speed from consecutive positions (fixed 1/60 steps)
		let hx = p.x - b.px, hz = p.z - b.pz;
		const stepDist = Math.hypot( hx, hz );
		if ( stepDist > 1e-5 ) { b.hx = hx / stepDist; b.hz = hz / stepDist; }
		b.px = p.x; b.pz = p.z;
		// carrot = guide point ~2s ahead of the closest guide point
		let sin = 0, cos = 0, dist = 1;
		if ( b.guide && b.guide.pts.length > 1 ) {

			b.progIdx = guideProject( b.guide.pts, b.progIdx, p.x, p.z );
			const pts = b.guide.pts;
			const ci = Math.min( pts.length - 1, b.progIdx + 20 );
			const tx = pts[ ci ].x - p.x, tz = pts[ ci ].z - p.z;
			const d = Math.hypot( tx, tz );
			if ( d > 1e-5 ) {

				sin = ( b.hz * tx - b.hx * tz ) / d; // <0 = carrot right (verified convention)
				cos = ( b.hx * tx + b.hz * tz ) / d;
				dist = Math.min( 1, d / 30 );

			}

		}
		const out = nnForward( b.w, [ -sin, cos, dist, Math.min( 1, stepDist / 0.5 ), b.lastX, b.lastZ, 1 ] );
		// discrete actions; throttle biased to accelerate (rare braking)
		const x = out[ 0 ] > 0.25 ? 1 : out[ 0 ] < -0.25 ? -1 : 0;
		const z = out[ 1 ] > -0.2 ? 1 : -1;
		b.lastX = x; b.lastZ = z;
		return { x, z };

	}

	// Evaluate one genome: sim the lap with the net driving. Fitness is the
	// same finish-first carrot/distance reward the evolve driver uses.
	function nnEvaluate( genome, guide, fast ) {

		state.bruteResult = null;
		if ( fast ) {

			resetState( 'run' );
			state.runScript = { crossState: state.nnSeed.crossState, lap2: [ {} ], lap1: [] };
			state.skipMode = true;
			state.lapsCompleted = 1;
			applyCrossState( state.nnSeed.crossState );
			resetCarPhysicsHistory();
			state.runEntries = [];
			state.runPointer = 0;
			state.runLaps = 1;
			state.stepIndex = 0;
			state.started = true;
			ctx.tasBeginNextLap();
			if ( ctx.fns.cancelCountdown ) ctx.fns.cancelCountdown();
			state.lastRecorded = null;
			const p = ctx.vehicle.spherePos;
			state.nnBrain = { w: genome.w, guide, progIdx: 0, px: p.x, pz: p.z, hx: 0, hz: 1, lastX: 0, lastZ: 1 };
			state.nnRecord = [];
			burstNn( genome, guide );

		} else {

			resetState( 'run' );
			state.runScript = { lap1: [ {} ], lap2: [] };
			state.stepIndex = 0;
			ctx.fns.respawnVehicle();
			resetCarPhysicsHistory();
			state.runEntries = [];
			state.runPointer = 0;
			state.runLaps = 1;
			state.started = false;
			ctx.fns.startCountdown();
			state.lastRecorded = null;
			const p = ctx.vehicle.spherePos;
			state.nnBrain = { w: genome.w, guide, progIdx: 0, px: p.x, pz: p.z, hx: 0, hz: 1, lastX: 0, lastZ: 1 };
			state.nnRecord = [];
			burstNn( genome, guide );

		}

	}

	// The shared sim burst: steps until finish, stuck, or the cap; computes
	// the reward along the way (identical semantics to aiEvaluate).
	function burstNn( genome, guide ) {

		let progIdx = 0, lastProgressStep = 0, bestProg = 0, bestProgStep = 0;
		const startP = { x: state.nnBrain.px, z: state.nnBrain.pz };
		const total = guide ? guide.pts.length - 1 : 1;
		const cap = 60 * 40;
		let burst = 0;
		try {

			while ( state.phase === 'run' && burst ++ < cap ) {

				ctx.fns.stepOnce();
				if ( state.phase === 'run' ) probeLapCross();
				if ( state.phase === 'run' && state.started ) {

					let progressed = false;
					const p = ctx.vehicle.spherePos;
					if ( guide ) {

						const idx = guideProject( guide.pts, progIdx, p.x, p.z );
						if ( idx > progIdx ) {

							progIdx = idx; lastProgressStep = state.stepIndex; progressed = true;
							if ( progIdx > bestProg ) { bestProg = progIdx; bestProgStep = state.stepIndex; }

						}

					} else {

						const d = Math.hypot( p.x - startP.x, p.z - startP.z );
						if ( d > bestProg + 0.02 ) { bestProg = d; bestProgStep = state.stepIndex; lastProgressStep = state.stepIndex; progressed = true; }

					}
					if ( ! progressed && state.stepIndex - lastProgressStep > 60 * 4 ) break;

				}

			}

		} catch ( e ) { /* DNF */ }
		const finish = state.bruteResult === null ? Infinity : state.bruteResult;
		const stepsTaken = state.stepIndex;
		const rec = state.nnRecord.slice();
		state.nnBrain = null;
		state.nnRecord = null;
		genome.fit = { finish, prog: Number.isFinite( finish ) ? total : bestProg, progStep: bestProgStep, steps: stepsTaken, map: null, total };
		genome.rec = rec;

	}

	// The neural session: evolve MLP weights generation by generation.
	// A learned run that beats the seed's time is adopted into the inputs
	// box as a normal script (replayable, shareable — the net's "muscle
	// memory" is preserved as its driven timeline).
	async function nnDrive( payload ) {

		if ( state.brute || state.ai ) return;
		const seed = parseScript( payload.script || '' );
		if ( seed.errors.length ) { post( 'tas-ai-error', { errors: seed.errors } ); return; }
		if ( ! seed.lap1.length && ! seed.lap2.length ) {

			post( 'tas-ai-error', { errors: [ 'no seed run — drive a lap (or import a partial) so the net knows the track' ] } );
			return;

		}
		const rounds = Math.max( 1, Math.min( 2000, Number( payload.rounds ) || 20 ) );
		const popSize = Math.max( 4, Math.min( 32, Number( payload.population ) || 20 ) );
		const sigma = 0.05 * Math.max( 1, Math.min( 10, Number( payload.mutations ) || 2 ) );
		const useGuide = payload.useGuide !== false; // the guide is the net's EYES
		const fast = !!( seed.crossState && seed.crossState.pos && seed.crossState.vel && seed.lap2.length && ctx.tasBeginNextLap );
		state.nnSeed = seed;
		let guide = null;
		if ( useGuide ) {

			if ( ! state.aiGuide || state.aiGuide.fast !== fast ) {

				const g = captureGuide( seed );
				if ( ! g ) {

					hideAiVisuals();
					post( 'tas-ai-error', { errors: [ 'guide capture failed — the baseline run never moves; drive a lap first' ] } );
					return;

				}
				g.fast = fast;
				state.aiGuide = g;

			}
			guide = state.aiGuide;
			showGuideLine( guide );

		} else { hideAiVisuals(); }
		state.brute = { stop: false, round: 0, rounds, best: null, last: null, adopted: 0, evals: 0 };
		let population = [];
		for ( let i = 0; i < popSize; i ++ ) population.push( { w: nnMakeGenome( 1 ) } );
		const fmtPct = ( prog ) => {

			const scale = guide ? guide.pts.length - 1 : Math.max( 1, population[ 0 ].fit ? population[ 0 ].fit.prog : 1 );
			return `${ Math.max( 0, Math.min( 100, Math.round( ( prog / scale ) * 100 ) ) ) }%`;

		};
		let bestFinish = Infinity, bestRec = null, improved = false;
		for ( let round = 0; round <= rounds; round ++ ) {

			if ( state.brute.stop ) break;
			for ( const g of population ) if ( ! g.fit ) { nnEvaluate( g, guide, fast ); state.brute.evals ++; }
			population.sort( ( a, b ) => aiFitCompare( a.fit, b.fit ) );
			const top = population[ 0 ];
			if ( Number.isFinite( top.fit.finish ) && top.fit.finish < bestFinish ) {

				bestFinish = top.fit.finish;
				bestRec = top.rec;
				improved = true;
				state.brute.adopted ++;
				// adopt the net's driven timeline as a real script
				const cand = cloneScript( seed );
				if ( fast ) { cand.lap2 = bestRec.length ? bestRec : [ { step: 0, x: 0, z: 0 } ]; }
				else { cand.lap1 = bestRec.length ? bestRec : [ { step: 0, x: 0, z: 0 } ]; cand.crossState = null; }
				const bestText = scriptToText( cand );
				state.lastRunText = bestText;
				post( 'tas-bruteforce-update', { script: bestText } );

			}
			state.brute.round = round;
			state.brute.best = bestFinish;
			state.brute.last = top.fit.finish;
			post( 'tas-ai-progress', {
				round, rounds,
				bestTime: fmtTime( bestFinish ),
				bestProg: Number.isFinite( bestFinish ) ? '100%' : fmtPct( top.fit.prog ),
				genProg: fmtPct( top.fit.prog ),
				adopted: Number.isFinite( top.fit.finish ) && top.fit.finish === bestFinish, evals: state.brute.evals, fast, nn: true,
			} );
			post( 'tas-ai-debug', { text: nnDebugText( round, population, { sigma, popSize, guide, fast, bestFinish, fmtPct } ) } );
			if ( guide ) positionCarrot( guide, top.fit.prog );
			// next generation: elites survive, the rest are crossovers/mutants
			const keepN = Math.max( 2, Math.min( 6, Math.floor( popSize / 4 ) ) );
			const elite = population.slice( 0, keepN );
			const next = elite.map( ( e ) => ( { w: e.w } ) );
			while ( next.length < popSize ) {

				const a = elite[ Math.floor( Math.random() * elite.length ) ];
				let w;
				if ( Math.random() < 0.4 && elite.length > 1 ) {

					const b = elite[ Math.floor( Math.random() * elite.length ) ];
					w = nnMutate( nnCrossover( a.w, b.w ), sigma );

				} else w = nnMutate( a.w, sigma );
				next.push( { w } );

			}
			population = next;
			await new Promise( ( r ) => setTimeout( r, 0 ) );

		}
		state.brute = null;
		bruteCleanup();
		hideAiVisuals();
		post( 'tas-ai-done', { bestTime: fmtTime( bestFinish ), improved, finish: Number.isFinite( bestFinish ), script: Number.isFinite( bestFinish ) ? state.lastRunText : undefined, nn: true } );

	}

	function nnDebugText( round, population, o ) {

		const lines = [];
		lines.push( `session  NEURAL NET (7→10→2 MLP, ${ NN_W } weights, learned by evolution)` );
		lines.push( `mode     ${ o.fast ? 'save-state lap' : 'full re-sim' } · pop ${ o.popSize } · σ ${ o.sigma.toFixed( 2 ) } · eyes: ${ o.guide ? 'carrot guide' : 'BLIND (no guide!)' }` );
		lines.push( `── gen ${ round } · ${ state.brute.evals } sims ──` );
		const topN = Math.min( 3, population.length );
		for ( let i = 0; i < topN; i ++ ) {

			const c = population[ i ];
			const fin = Number.isFinite( c.fit.finish ) ? c.fit.finish.toFixed( 3 ) + 's ✓' : 'DNF';
			lines.push( `top${ i + 1 }     reward ${ o.fmtPct( c.fit.prog ) } · finish ${ fin } · ${ c.rec.length } input changes` );

		}
		lines.push( `best    ${ Number.isFinite( o.bestFinish ) ? o.bestFinish.toFixed( 3 ) + 's (adopted — in your inputs box)' : 'no finisher yet' }` );
		return lines.join( '\n' );

	}

	// The AI session. Same safety rails as brute force: state.brute owns the
	// engine (R is blocked), only FINISHERS are adopted, adoption is
	// strictly-faster (a DNF baseline only allows the FIRST finisher in),
	// and the end state is the same parked-at-start cleanup.
	async function aiDrive( payload ) {

		if ( payload.nn ) return nnDrive( payload );
		if ( state.brute || state.ai ) return;
		const script = parseScript( payload.script || '' );
		if ( script.errors.length ) { post( 'tas-ai-error', { errors: script.errors } ); return; }
		if ( ! script.lap1.length && ! script.lap2.length ) {

			post( 'tas-ai-error', { errors: [ 'script has no inputs to evolve — record or paste a run first' ] } );
			return;

		}
		const mutations = Math.max( 1, Math.min( 20, Number( payload.mutations ) || 1 ) );
		const addInput = !! payload.addInput;
		const rounds = Math.max( 1, Math.min( 2000, Number( payload.rounds ) || 20 ) );
		const popSize = Math.max( 4, Math.min( 32, Number( payload.population ) || 20 ) );
		const useGuide = payload.useGuide !== false; // carrot ON by default
		// debug feed always posts (one message per generation, cheap); the
		// editor page decides whether the panel displays it
		const fast = !!( script.crossState && script.crossState.pos && script.crossState.vel && script.lap2.length && ctx.tasBeginNextLap );
		// Guide (the carrot): only captured when the switch is ON. A fresh
		// capture is required when there isn't one, or when the save-state
		// mode changed vs the captured guide (full <-> fast sample
		// timelines are different step spaces).
		let guide = null;
		if ( useGuide ) {

			if ( ! state.aiGuide || state.aiGuide.fast !== fast ) {

				const g = captureGuide( script );
				if ( ! g ) {

					hideAiVisuals();
					post( 'tas-ai-error', { errors: [ 'guide capture failed — the baseline run never moves; drive a lap first' ] } );
					return;

				}
				g.fast = fast;
				state.aiGuide = g;

			}
			guide = state.aiGuide;
			showGuideLine( guide );

		} else {

			// Guide OFF: blind search — plain random mutations, reward =
			// furthest distance from the start (finish time still rules).
			hideAiVisuals();

		}
		state.brute = { stop: false, round: 0, rounds, best: null, last: null, adopted: 0, evals: 0 };
		const baseFit = aiEvaluate( script, guide, fast );
		state.brute.evals ++;
		state.brute.best = baseFit.finish;
		let bestFinish = baseFit.finish;
		let bestScript = script;
		let improved = false;
		let bestProgSeen = baseFit.prog; // highest reward seen on an ADOPTED run
		const total = guide ? ( baseFit.total || guide.pts.length - 1 ) : Math.max( 0.01, baseFit.prog );
		const fmtPct = ( f ) => `${ Math.max( 0, Math.min( 100, Math.round( ( f.prog / total ) * 100 ) ) ) }%`;
		// debug panel feed: everything the AI receives, per generation
		const sendDebug = ( round, population, genStats ) => {

			const lines = [];
			lines.push( `session  ${ useGuide ? 'carrot ON (guide lap)' : 'carrot OFF (blind search)' } · pop ${ popSize } · mut ${ mutations }/round${ addInput ? ' · +1 input/round' : '' } · rounds ${ rounds } · ${ fast ? 'save-state lap' : 'full re-sim' }` );
			lines.push( `inputs   seed ${ ( script.lap2.length ? script.lap2 : script.lap1 ).length } entries${ useGuide && guide ? ` · guide ${ guide.pts.length } pts / ${ guide.samples.length } samples` : '' }` );
			lines.push( `── gen ${ round } · ${ state.brute.evals } sims ──` );
			const topN = Math.min( 3, population.length );
			for ( let i = 0; i < topN; i ++ ) {

				const c = population[ i ];
				const fin = Number.isFinite( c.fit.finish ) ? `${ c.fit.finish.toFixed( 3 ) }s ✓` : 'DNF';
				lines.push( `top${ i + 1 }     reward ${ fmtPct( c.fit ) } (${ Math.round( c.fit.prog ) } @ step ${ c.fit.progStep }, ran ${ c.fit.steps }) · finish ${ fin }` );

			}
			if ( useGuide && guide ) lines.push( `steer   ${ genStats.steerBiased } carrot-biased / ${ genStats.steerRandom } random this gen` );
			lines.push( `best    ${ Number.isFinite( bestFinish ) ? fmtTime( bestFinish ) + 's' : 'no finish yet' } · reward ${ fmtPct( { prog: bestProgSeen } ) } · adopted ${ state.brute.adopted }` );
			lines.push( `Δ top1  ${ aiDiffLines( script, population[ 0 ].script, 10 ) || '(identical to seed)' }` );
			if ( useGuide && guide ) {

				const p = guide.pts[ Math.max( 0, Math.min( guide.pts.length - 1, Math.round( population[ 0 ].fit.prog ) + 20 ) ) ];
				lines.push( `carrot  @ x ${ p.x.toFixed( 1 ) }, z ${ p.z.toFixed( 1 ) } (≈2s ahead of top1 progress)` );

			}
			post( 'tas-ai-debug', { text: lines.join( '\n' ) } );

		};
		post( 'tas-ai-progress', {
			round: 0, rounds,
			bestTime: fmtTime( bestFinish ),
			bestProg: fmtPct( baseFit ),
			genProg: fmtPct( baseFit ),
			adopted: false, evals: state.brute.evals, fast,
		} );
		// generation 0: baseline + mutants of it
		let population = [ { script, fit: baseFit } ];
		let genStats = { steerBiased: 0, steerRandom: 0 };
		while ( population.length < popSize ) {

			const cand = mutateScript( script, mutations, addInput, guide, genStats );
			population.push( { script: cand, fit: aiEvaluate( cand, guide, fast ) } );
			state.brute.evals ++;

		}
		population.sort( ( a, b ) => aiFitCompare( a.fit, b.fit ) );
		sendDebug( 0, population, genStats );
		if ( guide ) positionCarrot( guide, population[ 0 ].fit.prog );
		const keepN = Math.max( 2, Math.min( 6, Math.floor( popSize / 4 ) ) );
		for ( let round = 1; round <= rounds; round ++ ) {

			if ( state.brute.stop ) break;
			genStats = { steerBiased: 0, steerRandom: 0 };
			const elite = population.slice( 0, keepN );
			const next = elite.map( ( e ) => ( { script: e.script, fit: e.fit } ) ); // elites carry their fitness
			while ( next.length < popSize ) {

				// weighted elite choice: rank 0 is most likely parent
				const pick = elite[ Math.min( elite.length - 1, Math.floor( -Math.log( 1 - Math.random() ) * 2 ) ) ];
				let cand = null;
				if ( next.length % 4 === 3 && elite.length > 1 ) {

					// crossover: splice two elites where each first reached
					// the same progress fraction
					const other = elite[ Math.floor( Math.random() * elite.length ) ];
					const frac = 0.2 + Math.random() * 0.6;
					const timedA = pick.script.lap2.length ? pick.script.lap2 : pick.script.lap1;
					const timedB = other.script.lap2.length ? other.script.lap2 : other.script.lap1;
					const childLap = aiSplice( timedA, pick.fit.map, pick.fit.prog, timedB, other.fit.map, other.fit.prog, frac );
					if ( childLap ) {

						cand = cloneScript( pick.script );
						if ( cand.lap2.length ) cand.lap2 = childLap;
						else cand.lap1 = childLap;
						cand = mutateScript( cand, Math.max( 1, Math.floor( mutations / 2 ) ), addInput, guide, genStats ); // + a light touch

					}

				}
				if ( ! cand ) cand = mutateScript( pick.script, mutations, addInput, guide, genStats );
				next.push( { script: cand, fit: aiEvaluate( cand, guide, fast ) } );
				state.brute.evals ++;

			}
			population = next;
			population.sort( ( a, b ) => aiFitCompare( a.fit, b.fit ) );
			const top = population[ 0 ];
			let adopted = false;
			if ( Number.isFinite( top.fit.finish ) && top.fit.finish < bestFinish ) {

				bestFinish = top.fit.finish;
				bestScript = top.script;
				improved = true;
				adopted = true;
				state.brute.adopted ++;
				bestProgSeen = top.fit.prog;
				post( 'tas-bruteforce-update', { script: scriptToText( bestScript ) } ); // editor adoption path (hidden state refresh included)

			}
			state.brute.round = round;
			state.brute.best = bestFinish;
			state.brute.last = top.fit.finish;
			post( 'tas-ai-progress', {
				round, rounds,
				bestTime: fmtTime( bestFinish ),
				bestProg: fmtPct( { prog: Number.isFinite( bestFinish ) ? total : population.find( ( c ) => Number.isFinite( c.fit.finish ) )?.fit.prog ?? top.fit.prog } ),
				genProg: fmtPct( top.fit ),
				adopted, evals: state.brute.evals, fast,
			} );
			sendDebug( round, population, genStats );
			if ( guide ) positionCarrot( guide, population[ 0 ].fit.prog );
			await new Promise( ( r ) => setTimeout( r, 0 ) ); // yield to the editor UI

		}
		const bestText = scriptToText( bestScript );
		state.lastRunText = bestText;
		state.brute = null;
		bruteCleanup();
		hideAiVisuals();
		post( 'tas-ai-done', { bestTime: fmtTime( bestFinish ), improved, finish: Number.isFinite( bestFinish ), script: bestText } );

	}

	window.addEventListener( 'message', ( event ) => {

		if ( event.source !== window.parent || ! event.data?.type ) return;
		const type = event.data.type;
		if ( type === 'tas-retry' ) retry();
		else if ( type === 'tas-run' ) run( event.data.script || '', !! event.data.startAtLap2, event.data.goal );
		else if ( type === 'tas-stop' ) { state.phase = 'done'; ctx.tasBeginNextLap(); updateOverlay(); }
		else if ( type === 'tas-bruteforce' ) bruteForce( event.data );
		else if ( type === 'tas-ai' ) aiDrive( event.data );
		else if ( type === 'tas-ai-guide' ) {

			// "Refresh guide lap": re-capture the guide from the box's script.
			const gscript = parseScript( event.data.script || '' );
			if ( gscript.errors.length || ( ! gscript.lap1.length && ! gscript.lap2.length ) ) {

				post( 'tas-ai-guide-error', { errors: [ 'no valid inputs to capture a guide from' ] } );
				return;

			}
			const gfast = !!( gscript.crossState && gscript.crossState.pos && gscript.crossState.vel && gscript.lap2.length && ctx.tasBeginNextLap );
			const g = captureGuide( gscript );
			if ( ! g ) { post( 'tas-ai-guide-error', { errors: [ 'guide capture failed — the baseline run never moves' ] } ); return; }
			g.fast = gfast;
			state.aiGuide = g;
			post( 'tas-ai-guide-ok', { pts: g.pts.length, samples: g.samples.length, fast: gfast } );

		}
		else if ( type === 'tas-bruteforce-stop' ) { if ( state.brute ) state.brute.stop = true; }
		else if ( type === 'tas-toggle-pause' ) togglePause();
		else if ( type === 'tas-target-place' ) {

			// Editor button: enter/leave placement mode (hover ghost +
			// click to drop, Esc cancels). A target already placed keeps
			// its place — cancel only cancels the placement.
			if ( event.data.on ) {

				if ( state.target ) { post( 'tas-target-placed', { x: state.target.x, z: state.target.z } ); return; }
				setPlacing( true );

			} else {

				setPlacing( false );
				if ( state.target ) post( 'tas-target-placed', { x: state.target.x, z: state.target.z } );
				else post( 'tas-target-canceled', {} );

			}

		}
		else if ( type === 'tas-target-remove' ) {

			state.target = null;
			targetMesh.visible = false;
			setPlacing( false );
			post( 'tas-target-removed', {} );

		}
		else if ( type === 'tas-grab-partial' ) {

			// "Import unfinished run": copy the live recording into the
			// editor's inputs box WITHOUT needing a completed lap — for
			// checking/verifying hard tracks you can't finish yet.
			const entries = state.lapBuffers.reduce( ( n, b ) => n + b.length, 0 );
			if ( state.phase !== 'record' || ! entries ) {

				post( 'tas-grab-empty', {} );
				return;

			}
			post( 'tas-grab-run', { script: buildPartialScript(), steps: state.stepIndex, entries } );

		}
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
		else if ( type === 'tas-setspeed' ) {

			// Playback rate: 1 = real time. Only the accumulator fuel is
			// scaled; sim steps stay fixed 1/60s, so physics is identical.
			if ( ctx.fns.setSimSpeed ) ctx.fns.setSimSpeed( Number( event.data.mult ) || 1 );

		}
		else if ( type === 'tas-hitbox' ) {

			if ( ctx.fns.setCollisionView ) ctx.fns.setCollisionView( !! event.data.on );

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
