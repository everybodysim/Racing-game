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
//   COUNTDOWN  — 3-2-1 inside the iframe (car + lap timer frozen); record pending
//   RECORDING  — user drives the target laps; iframe captures per-substep inputs
//   REVIEW     — recording captured; ask "keep?"; Yes → fill inputs box; No → restart
//   PLAYBACK   — running the (prefix + edited) inputs visibly in the iframe
//   BRUTEFORCE — headless optimization via the iframe's eval() path
//
// Lap handling: combined start/finish tracks record 2 laps; only lap 2's inputs
// are kept (editable), while lap 1 is stored as a hidden "prefix" replayed before
// the target lap so the car carries the correct start-of-lap-2 speed. Tracks with
// separate start AND finish blocks respawn after finishing, so they need 1 lap.
// ─────────────────────────────────────────────────────────────────────────────

import { parseInputLines, serializeSteps } from './tas-core.js';

const $ = ( id ) => document.getElementById( id );
const frame = $( 'game-frame' );

const els = {
	trackUrl: $( 'track-url' ),
	loadTrack: $( 'load-track-btn' ),
	carSelect: $( 'car-select' ),
	record: $( 'record-btn' ),
	stopRecord: $( 'stop-record-btn' ),
	inputs: $( 'inputs' ),
	clearInputs: $( 'clear-inputs-btn' ),
	run: $( 'run-btn' ),
	stop: $( 'stop-btn' ),
	bfReps: $( 'bf-reps' ),
	bfTurbo: $( 'bf-turbo' ),
	bf: $( 'bf-btn' ),
	exportBtn: $( 'export-btn' ),
	lap: $( 'lap' ),
	banner: $( 'state-banner' ),
	reviewPrompt: $( 'review-prompt' ),
	reviewYes: $( 'review-yes' ),
	reviewNo: $( 'review-no' ),
	reviewTime: $( 'review-time' ),
	status: $( 'status' ),
	errors: $( 'run-errors' ),
	lapTargetHint: $( 'lap-target-hint' ),
};

let state = 'IDLE';            // IDLE | READY | COUNTDOWN | RECORDING | REVIEW | PLAYBACK | BRUTEFORCE
let iframeReady = false;
let embedParams = new URLSearchParams(); // params forwarded into the iframe (?map=, ?mods=, ?pack=...)
let currentSteps = [];          // the accepted/edited TARGET-lap inputs (array of {keys:{up,down,left,right}})
let prefixSteps = [];          // hidden lap-1 inputs replayed before currentSteps to build start speed
let bestT = null;               // best known target-lap eval result { time, laps, dnf }
let lastRecording = null;      // { prefix, lap2, targetLaps } captured during the active recording
let targetLaps = 2;            // 1 for separate start/finish tracks, else 2

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
	const trackLoaded = [ 'READY', 'COUNTDOWN', 'RECORDING', 'REVIEW', 'PLAYBACK', 'BRUTEFORCE' ].includes( state );
	els.record.disabled = ! trackLoaded || [ 'COUNTDOWN', 'RECORDING', 'PLAYBACK', 'BRUTEFORCE' ].includes( state );
	els.stopRecord.disabled = state !== 'RECORDING';
	els.run.disabled = [ 'IDLE', 'COUNTDOWN', 'RECORDING', 'PLAYBACK', 'BRUTEFORCE' ].includes( state ) || currentSteps.length === 0;
	els.stop.disabled = state !== 'PLAYBACK';
	els.bf.disabled = [ 'IDLE', 'COUNTDOWN', 'RECORDING', 'PLAYBACK', 'BRUTEFORCE' ].includes( state ) || currentSteps.length === 0;
}

function setState( next ) {
	state = next;
	updateButtons();
	if ( state === 'IDLE' ) setBanner( 'Load a track to begin', 'Enter a track URL, then start recording.' );
	else if ( state === 'READY' ) setBanner( 'Ready to record', `Click "Record a run"${ targetLaps > 1 ? ' and drive 2 laps' : ' and drive 1 lap' }.` );
	else if ( state === 'COUNTDOWN' ) setBanner( 'Get ready…', '3 · 2 · 1 — drive when the countdown ends.' );
	else if ( state === 'RECORDING' ) setBanner( 'Recording…', `${ targetLaps > 1 ? 'Drive 2 laps' : 'Drive 1 lap' }. Recording stops automatically at the finish.` );
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
		syncTargetLaps();
		applyConfig();
		if ( state === 'IDLE' ) setState( 'READY' );
		setStatus( 'Game viewport ready.' );
	} else if ( data.type === 'tas-countdown' ) {
		if ( state === 'RECORDING' || state === 'COUNTDOWN' ) return;
		setState( 'COUNTDOWN' );
		setStatus( '3 · 2 · 1 — drive when it hits GO!' );
	} else if ( data.type === 'tas-record-start' ) {
		if ( state === 'COUNTDOWN' ) setState( 'RECORDING' );
		setStatus( 'Recording — drive!' );
	} else if ( data.type === 'tas-lap' ) {
		const info = ( () => { try { return bridge()?.getInfo?.(); } catch { return null; } } )() || {};
		setLap( `Lap ${ data.lapNumber || info.lapNumber || 1 } • ${ formatTime( data.lapTime ) }` );
		// Auto-stop the recording once the driver completes the target lap count.
		const target = Number.isFinite( data.totalLaps ) ? data.totalLaps : ( info.targetLaps || targetLaps || 2 );
		if ( state === 'RECORDING' && Number( data.lapNumber ) >= target ) {
			stopRecord();
		}
	} else if ( data.type === 'tas-record-stopped' ) {
		finishRecording( data.recording || {} );
	} else if ( data.type === 'tas-frames' ) {
		finishRecording( data.recording || {} );
	} else if ( data.type === 'tas-playback-finished' ) {
		if ( state === 'PLAYBACK' ) { setState( 'READY' ); setStatus( `Run finished: ${ formatTime( data.time ) }` ); }
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
			syncTargetLaps();
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

// Pull the track's target lap count (1 for separate start/finish, else 2) from
// the iframe and update the editor hints/button labels accordingly.
function syncTargetLaps() {
	const info = ( () => { try { return bridge()?.getInfo?.(); } catch { return null; } } )() || {};
	if ( Number.isFinite( info.targetLaps ) ) {
		targetLaps = info.targetLaps;
		if ( els.lapTargetHint ) {
			els.lapTargetHint.textContent = targetLaps > 1
				? 'Most tracks: drive 2 laps (lap 1 just builds speed; only lap 2 is saved). Tracks with separate start & finish blocks need only 1 lap.'
				: 'This track has separate start & finish blocks, so only 1 lap is needed.';
		}
	}
}

// ── config: tell the iframe which car to use (normal gameplay stats) ─────────
function applyConfig() {
	callDirect( 'setConfig', { carKey: els.carSelect.value } );
	send( 'set-config', { config: { carKey: els.carSelect.value } } );
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
// Recording starts with a 3-2-1 countdown handled inside the iframe (car + lap
// timer frozen, sim alive). The iframe posts tas-countdown then tas-record-start.
function startRecord() {
	if ( ! iframeReady ) { setError( 'Game viewport not ready yet.' ); return; }
	applyConfig();
	lastRecording = null;
	hideReview();
	send( 'start-record' );
	callDirect( 'startRecord' );
	// The iframe replies with tas-countdown -> COUNTDOWN, then tas-record-start.
	frame.focus(); // so keystrokes drive the car inside the iframe
}
function stopRecord() {
	if ( state !== 'RECORDING' ) return;
	// Prefer a direct pull (synchronous) for snappiness; the message listener
	// will also fire tas-record-stopped with the split recording.
	const direct = callDirect( 'getRecording' );
	if ( direct && ( Array.isArray( direct.lap2 ) || Array.isArray( direct.prefix ) ) ) {
		finishRecording( direct );
	} else {
		send( 'stop-record' );
	}
}
function finishRecording( recording ) {
	if ( state !== 'RECORDING' ) return;
	const prefix = Array.isArray( recording?.prefix ) ? recording.prefix : [];
	const lap2 = Array.isArray( recording?.lap2 ) ? recording.lap2 : [];
	const tl = Number.isFinite( recording?.targetLaps ) ? recording.targetLaps : targetLaps;
	const lapTime = Number.isFinite( recording?.lapTime ) ? recording.lapTime : null;
	lastRecording = { prefix, lap2, targetLaps: tl, lapTime };
	// Put the iframe back to idle so the car stops moving while reviewing.
	send( 'set-mode', { mode: 'idle' } );
	callDirect( 'setMode', 'idle' );
	if ( lap2.length < 2 ) {
		setState( 'READY' );
		setStatus( 'No inputs captured for the saved lap (did you drive?). Try again.' );
		return;
	}
	setState( 'REVIEW' );
	const timeStr = lapTime != null ? ` — ${ formatTime( lapTime ) }` : '';
	els.reviewPrompt.style.display = 'flex';
	if ( els.reviewTime ) els.reviewTime.textContent = timeStr ? `Target-lap time: ${ formatTime( lapTime ) }` : '';
	// Replay the pop animation each time the prompt reappears.
	els.reviewPrompt.classList.remove( 'pop' );
	void els.reviewPrompt.offsetWidth;
	els.reviewPrompt.classList.add( 'pop' );
	setStatus( `Captured ${ lap2.length } target-lap frames${ prefix.length ? ` (+${ prefix.length } lap-1 prefix)` : '' }${ timeStr }. Review below.` );
}

// ── review ──────────────────────────────────────────────────────────────────
function hideReview() { if ( els.reviewPrompt ) els.reviewPrompt.style.display = 'none'; }
function acceptRun() {
	hideReview();
	if ( ! lastRecording ) { setState( 'READY' ); return; }
	prefixSteps = lastRecording.prefix || [];
	currentSteps = lastRecording.lap2 || [];
	els.inputs.value = serializeSteps( currentSteps );
	setState( 'READY' );
	setStatus( `Kept ${ currentSteps.length } target-lap frames${ prefixSteps.length ? ` (with ${ prefixSteps.length }-frame speed-build prefix)` : '' }. Edit above, then Run TAS.` );
}
function rejectRun() {
	hideReview();
	lastRecording = null;
	prefixSteps = [];
	currentSteps = [];
	els.inputs.value = '';
	setState( 'READY' );
	send( 'reset' );
	callDirect( 'reset' );
	setStatus( 'Recording discarded. Click "Record a run" to try again.' );
}

// Combine the hidden lap-1 prefix with the edited target-lap inputs. The prefix
// is replayed (headlessly during eval, visibly during playback) so the car
// carries the same start-of-lap-2 speed as the original recording.
function fullSteps() { return [ ...prefixSteps, ...parseEditedSteps() ]; }

// ── run TAS (visible playback) ──────────────────────────────────────────────
function runTas() {
	const steps = fullSteps();
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
// if the resulting target-lap time improves. Uses the iframe's headless eval()
// so it reuses the real deterministic simulation. The hidden lap-1 prefix is
// always replayed before the (mutated) editable lap-2 inputs so the car starts
// the target lap with the correct carried speed.
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
	const editable = parseEditedSteps();
	if ( ! editable.length ) { setError( 'No inputs to optimize.' ); return; }
	if ( ! iframeReady ) { setError( 'Game viewport not ready yet.' ); return; }
	applyConfig();
	const turbo = !! els.bfTurbo?.checked;
	const reps = Math.max( 1, Math.min( turbo ? 50000 : 5000, Number( els.bfReps.value ) || 50 ) );
	setState( 'BRUTEFORCE' );
	setError( '' );

	// bestSteps holds the editable (target-lap) inputs only; the fixed lap-1
	// prefix is prepended for every eval so start-of-lap speed is preserved.
	let bestSteps = cloneSteps( editable );
	let best = await evalSteps( [ ...prefixSteps, ...bestSteps ] );
	setStatus( `Baseline: ${ best.dnf ? 'DNF' : formatTime( best.time ) } (${ bestSteps.length } frames)${ turbo ? ' · TURBO' : '' }.` );
	if ( best.dnf ) {
		setError( 'Baseline run did not finish the target lap (DNF). Fix inputs before brute-forcing.' );
		setState( 'READY' );
		return;
	}

	// Turbo mode: batch many evals per UI yield and skip per-keep live edits so
	// the optimizer runs as fast as possible.
	const yieldEvery = turbo ? 25 : 1;
	const statusEvery = turbo ? 200 : 5;
	let kept = 0;
	for ( let i = 0; i < reps; i++ ) {
		if ( state !== 'BRUTEFORCE' ) break; // user stopped
		const candidate = cloneSteps( bestSteps );
		// Mutate 3 random frames.
		for ( let m = 0; m < 3; m++ ) {
			const idx = Math.floor( Math.random() * candidate.length );
			candidate[ idx ].keys = randomKeyMutate( candidate[ idx ].keys );
		}
		const res = await evalSteps( [ ...prefixSteps, ...candidate ] );
		if ( ! res.dnf && res.time < best.time - 1e-6 ) {
			bestSteps = candidate;
			best = res;
			kept++;
			if ( ! turbo ) {
				els.inputs.value = serializeSteps( bestSteps );
				currentSteps = bestSteps;
				setStatus( `Attempt ${ i + 1 }/${ reps }: ${ formatTime( best.time ) } ★ kept (${ kept } improvements)` );
			}
		} else if ( i % statusEvery === 0 ) {
			setStatus( `Attempt ${ i + 1 }/${ reps }: best ${ formatTime( best.time ) } (${ kept } kept)${ turbo ? ' · TURBO' : '' }` );
		}
		if ( i % yieldEvery === 0 ) await new Promise( ( r ) => setTimeout( r, 0 ) ); // keep UI responsive
	}
	currentSteps = bestSteps;
	els.inputs.value = serializeSteps( bestSteps );
	bestT = best;
	setState( 'READY' );
	setStatus( `Brute force done: ${ formatTime( best.time ) } (${ kept } improvements over ${ reps } attempts)${ turbo ? ' · TURBO' : '' }.` );
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
	const payload = JSON.stringify( { steps: currentSteps, prefix: prefixSteps, targetLaps, map: embedParams.get( 'map' ) || '', mods: embedParams.get( 'mods' ) || '', time: bestT } );
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
			prefixSteps = Array.isArray( parsed.prefix ) ? parsed.prefix : [];
			if ( Number.isFinite( parsed.targetLaps ) ) targetLaps = parsed.targetLaps;
			els.inputs.value = serializeSteps( currentSteps );
			if ( parsed.map ) { els.trackUrl.value = `${ window.location.origin }/index.html?map=${ parsed.map }${ parsed.mods ? '&mods=' + parsed.mods : '' }`; }
		}
	} catch ( e ) { /* ignore malformed hash */ }
}

// Prevent arrow keys / space / PageUp/Down from scrolling the page while the
// user is driving inside the iframe. We only suppress keys when the focus is
// NOT in a text field (so editing the inputs box still works normally).
const SCROLL_KEYS = new Set( [ 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End' ] );
function isTypingTarget( t ) { return t && ( t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ); }
window.addEventListener( 'keydown', ( e ) => {
	if ( isTypingTarget( e.target ) ) return;
	if ( SCROLL_KEYS.has( e.key ) ) e.preventDefault();
} );

// ── wire up ─────────────────────────────────────────────────────────────────
els.loadTrack.addEventListener( 'click', loadTrack );
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
