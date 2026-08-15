// Lightweight tests for js/VideoRecorder.js pure logic. Stubs the browser globals
// the module touches at import time (localStorage, MediaRecorder, document) so we
// can exercise settings persistence, MIME selection, and hide-group toggling
// without a real browser. Run: `node test-video-recorder.mjs`.

// ---- Browser global stubs -------------------------------------------------
class _Gain {
	constructor() { this.gain = { value: 1 }; this._to = []; }
	connect(n) { this._to.push(n); return n; }
	disconnect() {}
}
class _Node {
	constructor() { this._to = []; this._inputs = []; }
	connect(n) { this._to.push(n); return n; }
	disconnect() {}
}
class _AudioContext {
	constructor() { this.destination = new _Node(); this.state = 'running'; }
	createMediaStreamDestination() { return { stream: { getAudioTracks: () => [ {} ] }, connect() {}, disconnect() {} }; }
	createGain() { return new _Gain(); }
	createMediaElementSource() { return new _Node(); }
}
globalThis.AudioContext = _AudioContext;

class _MediaRecorder {
	constructor( stream, opts ) { this.stream = stream; this.opts = opts; this.state = 'inactive'; this._handlers = {}; }
	static isTypeSupported( t ) { return t === 'video/webm;codecs=vp9,opus' || t === 'video/webm' || t === 'video/mp4'; }
	set ondataavailable( fn ) { this._handlers.data = fn; }
	set onstop( fn ) { this._handlers.stop = fn; }
	set onerror( fn ) { this._handlers.error = fn; }
	start() { this.state = 'recording'; }
	stop() { this.state = 'inactive'; if ( this._handlers.stop ) this._handlers.stop(); }
}
globalThis.MediaRecorder = _MediaRecorder;

// localStorage stub
const _store = new Map();
globalThis.localStorage = {
	getItem: ( k ) => ( _store.has( k ) ? _store.get( k ) : null ),
	setItem: ( k, v ) => { _store.set( k, String( v ) ); },
	removeItem: ( k ) => { _store.delete( k ); },
	clear: () => _store.clear(),
};

// Minimal DOM stub supporting querySelectorAll + style + dataset.
function makeEl( id ) {
	return {
		id, style: { display: '' }, dataset: {},
		querySelectorAll: () => [],
	};
}
// A 2D-canvas stub for the relay: getContext('2d') returns a drawImage-capable
// ctx, captureStream returns a stream with a (optionally) requestFrame-capable
// video track. Set relayHasRequestFrame=false to simulate Firefox (auto mode).
let relayHasRequestFrame = true;
function makeRelayCanvas() {
	const videoTrack = relayHasRequestFrame
		? { stop() {}, requestFrame() { relayFrames++; }, readyState: 'live', frameRate: 60 }
		: { stop() {}, readyState: 'live', frameRate: 60 };
	return {
		width: 1280, height: 720, style: {}, dataset: {},
		getContext: () => ( { drawImage() { relayDraws++; } } ),
		captureStream: () => ( { getTracks: () => [ videoTrack ], getVideoTracks: () => [ videoTrack ], getAudioTracks: () => [], addTrack() {} } ),
	};
}
let relayDraws = 0;
let relayFrames = 0;
const _els = new Map();
globalThis.document = {
	querySelectorAll: ( sel ) => ( _els.has( sel ) ? [ _els.get( sel ) ] : [] ),
	createElement: ( tag ) => ( tag === 'canvas' ? makeRelayCanvas() : makeEl( tag ) ),
	body: { appendChild() {}, removeChild() {} },
};

globalThis.performance = { now: () => Date.now() };
globalThis.window = { __gameAudio: null };
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
globalThis.Blob = class { constructor( parts ) { this.size = parts.reduce( ( a, p ) => a + ( p.size || 0 ), 0 ); } };
globalThis.setTimeout = ( fn ) => { return 0; };
globalThis.clearTimeout = () => {};

// ---- Load the module -------------------------------------------------------
const { VideoRecorder, UI_TOGGLE_GROUPS, DEFAULT_SETTINGS, pickMimeType, loadSettings, saveSettings } = await import( './js/VideoRecorder.js' );

let passed = 0, failed = 0;
function ok( cond, msg ) { if ( cond ) { passed++; } else { failed++; console.error( 'FAIL:', msg ); } }

// 1) pickMimeType prefers vp9 when supported.
ok( pickMimeType( 'auto' ) === 'video/webm;codecs=vp9,opus', 'pickMimeType auto -> vp9' );
ok( pickMimeType( 'video/mp4' ) === 'video/mp4', 'pickMimeType honours preferred mp4' );
// 2) An unsupported preferred type falls back to best supported.
ok( pickMimeType( 'video/x-random' ) === 'video/webm;codecs=vp9,opus', 'pickMimeType falls back when preferred unsupported' );

// 3) DEFAULT_SETTINGS has the expected shape.
ok( DEFAULT_SETTINGS.fps === 60, 'default fps 60' );
ok( DEFAULT_SETTINGS.captureAudio === true, 'default captureAudio true' );
ok( typeof DEFAULT_SETTINGS.hideGroups === 'object', 'default hideGroups object' );
ok( DEFAULT_SETTINGS.hideGroups.hud === true, 'default hides hud' );

// 4) Settings persist round-trip.
_store.clear();
saveSettings( { ...DEFAULT_SETTINGS, fps: 90, bitrate: 20_000_000, hideGroups: { ...DEFAULT_SETTINGS.hideGroups, hud: false, boost: true } } );
const reloaded = loadSettings();
ok( reloaded.fps === 90, 'persisted fps' );
ok( reloaded.bitrate === 20_000_000, 'persisted bitrate' );
ok( reloaded.hideGroups.hud === false, 'persisted hideGroups.hud override' );
ok( reloaded.hideGroups.boost === true, 'persisted hideGroups.boost new' );
ok( reloaded.hideGroups.lapHud === true, 'persisted hideGroups keeps untouched defaults' );

// 5) loadSettings with no storage returns defaults.
_store.clear();
const fresh = loadSettings();
ok( fresh.fps === 60, 'no-storage fps default' );
ok( fresh.hideGroups.hud === true, 'no-storage hideGroups default' );

// 6) UI_TOGGLE_GROUPS covers the key UI pieces for clean recordings.
const keys = UI_TOGGLE_GROUPS.map( ( g ) => g.key );
ok( keys.includes( 'hud' ) && keys.includes( 'lapHud' ) && keys.includes( 'vignette' ) && keys.includes( 'nav' ), 'toggle groups cover HUD/lap/vignette/nav' );
for ( const g of UI_TOGGLE_GROUPS ) {
	ok( Array.isArray( g.selectors ) && g.selectors.length > 0, `group ${ g.key } has selectors` );
}

// 7) VideoRecorder lifecycle: start/stop via the 2D relay canvas.
_store.clear();
relayDraws = 0; relayFrames = 0;
const stubCanvas = { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 };
const rec = new VideoRecorder( {
	canvas: stubCanvas,
	getAudioContext: () => null, // skip audio path for this test
	getMessage: () => {},
} );
ok( rec.isRecording() === false, 'starts not recording' );
ok( typeof rec.start === 'function' && typeof rec.stop === 'function', 'has start/stop' );
ok( typeof rec.captureFrame === 'function', 'has captureFrame' );
const started = await rec.start();
ok( started === true, 'start returns true' );
ok( rec.isRecording() === true, 'isRecording true after start' );
ok( rec.relayCanvas !== null, 'relay 2D canvas created' );
ok( rec._manualFrames === true, 'manual frame mode detected on relay track' );
// start() primes + pushes an initial frame (drawImage + requestFrame).
ok( relayDraws >= 1, 'relay drawImage called on start' );
ok( relayFrames >= 1, 'first frame pushed on start' );
const beforeFrames = relayFrames;
const beforeDraws = relayDraws;
// captureFrame is throttled to the configured FPS, so an immediate call
// right after start() is intentionally skipped.
rec.captureFrame();
ok( relayFrames === beforeFrames, 'captureFrame throttled back-to-back calls' );
// Simulate elapsed time beyond the min gap; now a frame should be pushed.
rec.lastFrameMs = 0;
rec.captureFrame();
ok( relayDraws === beforeDraws + 1, 'captureFrame drawImage after gap' );
ok( relayFrames === beforeFrames + 1, 'captureFrame requestFrame after gap' );
// captureFrame is a no-op when not recording.
rec.stop();
ok( rec.isRecording() === false, 'isRecording false after stop' );
const afterStop = relayFrames;
rec.captureFrame();
ok( relayFrames === afterStop, 'captureFrame no-op when not recording' );
// Debug log captured key events.
ok( rec.getDebugLog().includes( 'start() called' ), 'debug log has start() called' );
ok( rec.getDebugLog().includes( 'relay 2D canvas' ), 'debug log has relay canvas info' );

// 8) updateSettings persists.
rec.updateSettings( { fps: 120 } );
ok( loadSettings().fps === 120, 'updateSettings persists fps' );

// 9) Start with no canvas fails gracefully.
const noCanvas = new VideoRecorder( { canvas: null, getMessage: () => {} } );
const bad = await noCanvas.start();
ok( bad === false, 'start fails without canvas' );

// 10) Auto-capture fallback when the track has no requestFrame (Firefox-like).
relayHasRequestFrame = false;
const autoRec = new VideoRecorder( { canvas: { width: 1280, height: 720 }, getAudioContext: () => null, getMessage: () => {} } );
const autoStarted = await autoRec.start();
ok( autoStarted === true, 'auto-capture start returns true' );
ok( autoRec._manualFrames === false, 'no requestFrame -> auto mode' );
autoRec.stop();
relayHasRequestFrame = true;

console.log( `\n${ passed } passed, ${ failed } failed` );
process.exit( failed ? 1 : 0 );
