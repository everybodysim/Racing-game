// ─────────────────────────────────────────────────────────────────────────────
// TAS Editor — parent controller (iframe embed architecture).
//
// The 3D viewport is the real game running in an iframe at index.html?tas=1.
// main.js exposes window.__tasBridge (and posts messages) inside that iframe;
// this file drives it from the parent: load a track, record a 2-lap run, review
// it, edit the captured inputs, run them back deterministically, and brute-force
// optimize them (mutate 3 frames per attempt, keep if faster).
//
// State machine (parent-side):
//   IDLE       — waiting for the iframe to report tas-ready, or a track to load
//   READY      — track loaded, can record
//   RECORDING  — user drives 2 laps; iframe captures per-substep inputs
//   REVIEW     — 2 laps captured; ask "keep?"; Yes → fill inputs box; No → restart
//   PLAYBACK   — running the (possibly edited) inputs visibly in the iframe
//   BRUTEFORCE — headless optimization via the iframe's eval() path
// ─────────────────────────────────────────────────────────────────────────────

import { parseInputLines, serializeSteps } from './tas-core.js';

// Engine tier → engine multiplier (sent to the iframe so its car matches).
const ENGINE_MULTS = [ 0.6, 0.8, 1.0, 1.1, 1.8 ];

const $ = ( id ) => document.getElementById( id );
const frame = $( 'game-frame' );

const els = {
	trackUrl: $( 'track-url' ),
	loadTrack: $( 'load-track-btn' ),
	carSelect: $( 'car-select' ),
	engineTier: $( 'engine-tier' ),
	record: $( 'record-btn' ),
	stopRecord: $( 'stop-record-btn' ),
	inputs: $( 'inputs' ),
	clearInputs: $( 'clear-inputs-btn' ),
	run: $( 'run-btn' ),
	stop: $( 'stop-btn' ),
	bfReps: $( 'bf-reps' ),
	bf: $( 'bf-btn' ),
	exportBtn: $( 'export-btn' ),
	lap: $( 'lap' ),
	banner: $( 'state-banner' ),
	reviewPrompt: $( 'review-prompt' ),
	reviewYes: $( 'review-yes' ),
	reviewNo: $( 'review-no' ),
	status: $( 'status' ),
	errors: $( 'run-errors' ),
};

let state = 'IDLE';            // IDLE | READY | RECORDING | REVIEW | PLAYBACK | BRUTEFORCE
let iframeReady = false;
let embedParams = new URLSearchParams(); // params forwarded into the iframe (?map=, ?mods=, ?pack=...)
let currentSteps = [];          // the accepted/edited inputs (array of {keys:{up,down,left,right}})
let bestT = null;               // best known 2-lap eval result { time, laps, dnf }
let lastRecordedSteps = null;  // steps captured during the active recording (awaiting review)

function formatTime( s ) {
	if ( ! Number.isFinite( s ) ) return '--:--.---';
	const m = Math.floor( s / 60 );
	const sec = s - m * 60;
	return `${ String( m ).padStart( 2, '0' ) }:${ sec.toFixed( 3 ).padStart( 6, '0' ) }`;
}

function setStatus( msg ) { if ( els.status ) els.status.textContent = msg || ''; }
function setError( msg ) { if ( els.errors ) els.errors.textContent = msg || ''; }
function setBanner( main, sub ) {
	if ( ! els.banner ) return;
	els.banner.innerHTML = `${ main }<span class="banner-sub">${ sub || '' }</span>`;
}
function setLap( text ) { if ( els.lap ) els.lap.textContent = text; }

function updateButtons() {
	const trackLoaded = state === 'READY' || state === 'RECORDING' || state === 'REVIEW' || state === 'PLAYBACK' || state === 'BRUTEFORCE';
	els.record.disabled = ! trackLoaded || state === 'RECORDING' || state === 'PLAYBACK' || state === 'BRUTEFORCE';
	els.stopRecord.disabled = state !== 'RECORDING';
	els.run.disabled = state === 'IDLE' || state === 'RECORDING' || state === 'PLAYBACK' || state === 'BRUTEFORCE' || currentSteps.length === 0;
	els.stop.disabled = state !== 'PLAYBACK';
	els.bf.disabled = state === 'IDLE' || state === 'RECORDING' || state === 'PLAYBACK' || state === 'BRUTEFORCE' || currentSteps.length === 0;
}

function setState( next ) {
	state = next;
	updateButtons();
	if ( state === 'IDLE' ) setBanner( 'Load a track to begin', 'Enter a track URL, then start recording.' );
	else if ( state === 'READY' ) setBanner( 'Ready to record', 'Click "Record a run" and drive 2 laps.' );
	else if ( state === 'RECORDING' ) setBanner( 'Recording…', 'Drive 2 laps. Click "Stop recording" when done.' );
	else if ( state === 'REVIEW' ) setBanner( 'Review your run', 'Keep these inputs, or restart?' );
	else if ( state === 'PLAYBACK' ) setBanner( 'Running TAS…', 'Playing back the edited inputs deterministically.' );
	else if ( state === 'BRUTEFORCE' ) setBanner( 'Brute-forcing…', 'Mutating 3 inputs per attempt; keeping faster runs.' );
}

// ── iframe communication ───────────────────────────────────────────────────
// Same-origin, so we prefer direct calls on frame.contentWindow.__tasBridge and
// fall back to postMessage for reliability across load timing.
function send( command, extra = {} ) {
	const w = frame.contentWindow;
	if ( ! w ) return;
	w.postMessage( { type: 'tas-command', command, ...extra }, '*' );
}
function bridge() { return frame.contentWindow?.__tasBridge || null; }
function callDirect( fnName, ...args ) {
	const b = bridge();
	if ( b && typeof b[ fnName ] === 'function' ) {
		try { return b[ fnName ]( ...args ); } catch ( e ) { setError( `iframe call ${ fnName } failed: ${ e?.message || e }` ); }
	}
	return undefined;
}

window.addEventListener( 'message', ( event ) => {
	const data = event.data;
	if ( ! data || data.source !== 'tas-embed' ) return;
	if ( data.type === 'tas-ready' ) {
		iframeReady = true;
		applyConfig();
		if ( state === 'IDLE' ) setState( 'READY' );
		setStatus( 'Game viewport ready.' );
	} else if ( data.type === 'tas-lap' ) {
		const info = ( () => { try { return bridge()?.getInfo?.(); } catch { return null; } } )() || {};
		setLap( `Lap ${ data.lapNumber || info.lapNumber || 1 } • ${ formatTime( data.lapTime ) }` );
		// Auto-stop the recording once the driver completes the target lap count
		// (default 2): the spec asks to record 2 laps, then prompt for review.
		const target = Number.isFinite( data.totalLaps ) ? data.totalLaps : info.targetLaps || 2;
		if ( state === 'RECORDING' && Number( data.lapNumber ) >= target ) {
			stopRecord();
		}
	} else if ( data.type === 'tas-record-stopped' ) {
		finishRecording( Array.isArray( data.steps ) ? data.steps : [] );
	} else if ( data.type === 'tas-frames' ) {
		finishRecording( Array.isArray( data.steps ) ? data.steps : [] );
	} else if ( data.type === 'tas-eval-result' ) {
		onEvalResult( data );
	} else if ( data.type === 'tas-error' ) {
		setError( data.message || 'iframe reported an error' );
	}
} );

// Wait for the iframe load, then ping it until the bridge reports ready.
frame.addEventListener( 'load', () => {
	iframeReady = false;
	const ping = () => {
		if ( bridge()?.ready?.() ) {
			iframeReady = true;
			applyConfig();
			if ( state === 'IDLE' ) setState( 'READY' );
			setStatus( 'Game viewport ready.' );
			return;
		}
		send( 'ready' );
		if ( ! iframeReady ) setTimeout( ping, 200 );
	};
	setTimeout( ping, 250 );
} );

// ── config: tell the iframe which car + engine tier to use ──────────────────
function applyConfig() {
	const tier = Number( els.engineTier.value ) || 0;
	const engineMult = ENGINE_MULTS[ Math.min( ENGINE_MULTS.length - 1, Math.max( 0, tier ) ) ];
	callDirect( 'setConfig', { carKey: els.carSelect.value, engineMult } );
	send( 'set-config', { config: { carKey: els.carSelect.value, engineMult } } );
}

// ── load track ──────────────────────────────────────────────────────────────
function buildEmbedUrl() {
	const p = new URLSearchParams();
	p.set( 'tas', '1' );
	for ( const [ k, v ] of embedParams.entries() ) p.set( k, v );
	return 'index.html?' + p.toString();
}
function loadTrack() {
	setError( '' );
	const raw = ( els.trackUrl.value || '' ).trim();
	embedParams = new URLSearchParams();
	if ( raw ) {
		try {
			const u = new URL( raw, window.location.href );
			const sp = u.searchParams;
			for ( const k of [ 'map', 'mods', 'pack' ] ) {
				const v = sp.get( k );
				if ( v ) embedParams.set( k, v );
			}
			if ( ! embedParams.get( 'map' ) && ! embedParams.get( 'pack' ) ) {
				setError( 'That URL has no ?map= or ?pack= parameter. Leave blank to use the default track.' );
				return;
			}
		} catch ( e ) {
			setError( 'Could not parse that URL. Leave blank for the default track.' );
			return;
		}
	}
	iframeReady = false;
	currentSteps = [];
	bestT = null;
	els.inputs.value = '';
	setState( 'IDLE' );
	setLap( 'Lap 1 • 00:00.000 • Last --:--.--- • Best --:--.---' );
	frame.src = buildEmbedUrl();
	setStatus( 'Loading track…' );
}

// ── record ─────────────────────────────────────────────────────────────────
function startRecord() {
	if ( ! iframeReady ) { setError( 'Game viewport not ready yet.' ); return; }
	applyConfig();
	lastRecordedSteps = null;
	setState( 'RECORDING' );
	send( 'start-record' );
	callDirect( 'startRecord' );
	setStatus( 'Recording — drive 2 laps.' );
	frame.focus(); // so keystrokes drive the car inside the iframe
}
function stopRecord() {
	if ( state !== 'RECORDING' ) return;
	// Prefer a direct pull (synchronous) for snappiness; the message listener
	// will also fire tas-record-stopped.
	const info = ( () => { try { return bridge()?.getInfo?.(); } catch { return null; } } )() || {};
	const direct = callDirect( 'getRecordedSteps' );
	setStatus( `stopRecord: iframe mode=${ info.mode } steps=${ info.recordedStepCount } direct=${ Array.isArray( direct ) ? direct.length : 'n/a' }` );
	if ( Array.isArray( direct ) && direct.length ) {
		finishRecording( direct );
	} else {
		send( 'stop-record' );
	}
}
function finishRecording( steps ) {
	if ( state !== 'RECORDING' ) return;
	lastRecordedSteps = Array.isArray( steps ) ? steps : [];
	// Put the iframe back to idle so the car stops moving while reviewing.
	send( 'set-mode', { mode: 'idle' } );
	callDirect( 'setMode', 'idle' );
	if ( lastRecordedSteps.length < 2 ) {
		setState( 'READY' );
		setStatus( 'No inputs captured (did you drive?). Try again.' );
		return;
	}
	setState( 'REVIEW' );
	els.reviewPrompt.style.display = 'flex';
	setStatus( `Recorded ${ lastRecordedSteps.length } input frames. Review below.` );
}

// ── review ──────────────────────────────────────────────────────────────────
function acceptRun() {
	els.reviewPrompt.style.display = 'none';
	currentSteps = lastRecordedSteps || [];
	els.inputs.value = serializeSteps( currentSteps );
	setState( 'READY' );
	setStatus( `Kept ${ currentSteps.length } frames. Edit above, then Run TAS.` );
}
function rejectRun() {
	els.reviewPrompt.style.display = 'none';
	lastRecordedSteps = null;
	setState( 'READY' );
	send( 'reset' );
	callDirect( 'reset' );
	setStatus( 'Recording discarded. Click "Record a run" to try again.' );
}

// ── run TAS (visible playback) ──────────────────────────────────────────────
function runTas() {
	const steps = parseEditedSteps();
	if ( ! steps.length ) { setError( 'No inputs to run.' ); return; }
	if ( ! iframeReady ) { setError( 'Game viewport not ready yet.' ); return; }
	applyConfig();
	setState( 'PLAYBACK' );
	send( 'playback', { steps } );
	callDirect( 'playback', steps );
	setStatus( 'Running TAS…' );
	frame.focus();
}
function stopTas() {
	send( 'stop-playback' );
	callDirect( 'stopPlayback' );
	setState( 'READY' );
	setStatus( 'Stopped.' );
}
function parseEditedSteps() {
	const text = els.inputs.value.trim();
	if ( ! text ) return currentSteps.slice();
	try { return parseInputLines( text ); } catch ( e ) { setError( `Parse error: ${ e?.message || e }` ); return []; }
}

// ── brute force ─────────────────────────────────────────────────────────────
// Mutate 3 random frames per attempt by a medium amount; keep the change only
// if the resulting 2-lap time improves. Uses the iframe's headless eval() so it
// reuses the real deterministic simulation.
function cloneSteps( steps ) { return steps.map( ( s ) => ( { keys: { ...s.keys } } ) ); }
function randomKeyMutate( keys ) {
	const k = { ...keys };
	const order = [ 'up', 'down', 'left', 'right' ];
	const idx = Math.floor( Math.random() * order.length );
	const keyName = order[ idx ];
	// "Medium amount": flip the chosen direction (the only meaningful discrete
	// mutation for key-based inputs). Sometimes also nudge a neighbour.
	k[ keyName ] = ! k[ keyName ];
	if ( Math.random() < 0.4 ) {
		const nIdx = ( idx + 1 ) % order.length;
		k[ order[ nIdx ] ] = ! k[ order[ nIdx ] ];
	}
	return k;
}

async function bruteForce() {
	const base = parseEditedSteps();
	if ( ! base.length ) { setError( 'No inputs to optimize.' ); return; }
	if ( ! iframeReady ) { setError( 'Game viewport not ready yet.' ); return; }
	applyConfig();
	const reps = Math.max( 1, Math.min( 5000, Number( els.bfReps.value ) || 50 ) );
	setState( 'BRUTEFORCE' );
	setError( '' );

	// Establish the baseline time for the current inputs.
	let bestSteps = cloneSteps( base );
	let best = await evalSteps( bestSteps );
	setStatus( `Baseline: ${ best.dnf ? 'DNF' : formatTime( best.time ) } (${ bestSteps.length } frames).` );
	if ( best.dnf ) {
		setError( 'Baseline run did not finish 2 laps (DNF). Fix inputs before brute-forcing.' );
		setState( 'READY' );
		return;
	}

	let kept = 0;
	for ( let i = 0; i < reps; i++ ) {
		if ( state !== 'BRUTEFORCE' ) break; // user navigated away / stopped
		const candidate = cloneSteps( bestSteps );
		// Mutate 3 random frames.
		for ( let m = 0; m < 3; m++ ) {
			const idx = Math.floor( Math.random() * candidate.length );
			candidate[ idx ].keys = randomKeyMutate( candidate[ idx ].keys );
		}
		const res = await evalSteps( candidate );
		if ( ! res.dnf && res.time < best.time - 1e-6 ) {
			bestSteps = candidate;
			best = res;
			kept++;
			els.inputs.value = serializeSteps( bestSteps );
			currentSteps = bestSteps;
			setStatus( `Attempt ${ i + 1 }/${ reps }: ${ formatTime( best.time ) } ★ kept (${ kept } improvements)` );
		} else {
			if ( i % 5 === 0 ) setStatus( `Attempt ${ i + 1 }/${ reps }: best ${ formatTime( best.time ) } (${ kept } kept)` );
		}
		await new Promise( ( r ) => setTimeout( r, 0 ) ); // keep UI responsive
	}
	currentSteps = bestSteps;
	els.inputs.value = serializeSteps( bestSteps );
	bestT = best;
	setState( 'READY' );
	setStatus( `Brute force done: ${ formatTime( best.time ) } (${ kept } improvements over ${ reps } attempts).` );
}

// Evaluate a candidate via the iframe. Prefer direct synchronous eval; fall back
// to postMessage with a promise.
let evalResolveQueue = [];
function evalSteps( steps ) {
	const b = bridge();
	if ( b && typeof b.eval === 'function' ) {
		try { return Promise.resolve( b.eval( steps ) ); } catch ( e ) { return Promise.reject( e ); }
	}
	return new Promise( ( resolve ) => {
		evalResolveQueue.push( resolve );
		send( 'eval', { steps } );
	} );
}
function onEvalResult( data ) {
	const resolve = evalResolveQueue.shift();
	if ( resolve ) resolve( { time: data.time, laps: data.laps, dnf: data.dnf } );
}

// ── export (copy serialized inputs + a shareable URL) ───────────────────────
function exportRun() {
	const text = serializeSteps( currentSteps );
	const url = new URL( window.location.href );
	if ( embedParams.get( 'map' ) ) url.searchParams.set( 'map', embedParams.get( 'map' ) );
	if ( embedParams.get( 'mods' ) ) url.searchParams.set( 'mods', embedParams.get( 'mods' ) );
	const payload = JSON.stringify( { steps: currentSteps, map: embedParams.get( 'map' ) || '', mods: embedParams.get( 'mods' ) || '', time: bestT } );
	const encoded = btoa( unescape( encodeURIComponent( payload ) ) ).replace( /\+/g, '-' ).replace( /\//g, '_' );
	const share = `${ url.origin }${ url.pathname }#tas=${ encoded }`;
	const out = `${ share }\n\n--- inputs ---\n${ text }`;
	navigator.clipboard?.writeText( out ).then(
		() => setStatus( 'Copied share URL + inputs to clipboard.' ),
		() => { els.inputs.value = text; setStatus( 'Clipboard unavailable; inputs shown in the box.' ); }
	);
}

// Restore from #tas= hash on load (shareable runs).
function restoreFromHash() {
	const h = new URLSearchParams( window.location.hash.startsWith( '#' ) ? window.location.hash.slice( 1 ) : '' );
	const tas = h.get( 'tas' );
	if ( ! tas ) return;
	try {
		const json = decodeURIComponent( escape( atob( tas.replace( /-/g, '+' ).replace( /_/g, '/' ) ) ) );
		const parsed = JSON.parse( json );
		if ( Array.isArray( parsed.steps ) && parsed.steps.length ) {
			currentSteps = parsed.steps;
			els.inputs.value = serializeSteps( currentSteps );
			if ( parsed.map ) { els.trackUrl.value = `${ window.location.origin }/index.html?map=${ parsed.map }${ parsed.mods ? '&mods=' + parsed.mods : '' }`; }
		}
	} catch ( e ) { /* ignore malformed hash */ }
}

// ── wire up ─────────────────────────────────────────────────────────────────
els.loadTrack.addEventListener( 'click', loadTrack );
els.engineTier.addEventListener( 'input', applyConfig );
els.carSelect.addEventListener( 'change', applyConfig );
els.record.addEventListener( 'click', startRecord );
els.stopRecord.addEventListener( 'click', stopRecord );
els.clearInputs.addEventListener( 'click', () => { els.inputs.value = ''; currentSteps = []; updateButtons(); } );
els.run.addEventListener( 'click', runTas );
els.stop.addEventListener( 'click', stopTas );
els.bf.addEventListener( 'click', bruteForce );
els.exportBtn.addEventListener( 'click', exportRun );
els.reviewYes.addEventListener( 'click', acceptRun );
els.reviewNo.addEventListener( 'click', rejectRun );

// Re-parse the inputs box into currentSteps when the user edits it.
els.inputs.addEventListener( 'input', () => { currentSteps = parseEditedSteps(); updateButtons(); } );

restoreFromHash();
setState( 'IDLE' );
updateButtons();
