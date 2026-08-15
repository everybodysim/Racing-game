// Video Recorder — records high-quality, high-FPS gameplay video straight from
// the WebGL canvas and game audio, then downloads the file to the player's
// browser. Driven by the official "Video Recorder" mod (mods/mods.json); the
// game only instantiates this when that mod is installed.
//
// Why canvas.captureStream() + MediaRecorder:
//   The renderer is created with `preserveDrawingBuffer: true`, so the canvas
//   keeps a readable frame buffer. captureStream() turns those frames into a
//   real-time MediaStream at the display refresh rate (or a requested FPS),
//   and MediaRecorder encodes it to WebM (VP8/VP9) or MP4 depending on the
//   browser. This is far higher quality / smoother than grabbing individual
//   frames to ImageBitmap, and it captures audio too. It runs in the existing
//   requestAnimationFrame loop with zero extra allocations.
//
// Audio mixing:
//   Engine/skid/impact sounds live in the WebAudio graph (THREE.AudioListener
//   -> AudioContext.destination). Music plays through an HTMLMediaElement
//   (`window.__gameAudio.musicElement`). We tap both: a MediaStreamAudioSource
//   from the AudioContext via a MediaStreamDestination, plus a
//   MediaElementSource for the music element, both summed into a single Gain
//   so the recording hears exactly what the player hears.

const REC_SETTINGS_KEY = 'racing-video-recorder-settings-v1';

// UI element selectors the recorder can hide while recording. Each entry maps
// the panel's setting key to a list of DOM selectors whose matching elements
// get `data-vr-hidden` toggled (display:none) for the duration of a recording.
// The recorder saves + restores the previous display value so it never clobbers
// the game's own show/hide logic.
const UI_TOGGLE_GROUPS = [
	{ key: 'hud',        label: 'HUD (lap/time/speed)', selectors: [ '#hud-grid', '#fps-hud' ] },
	{ key: 'speedo',     label: 'Speedometer',          selectors: [ '#speedometer', '#speedometer-canvas' ] },
	{ key: 'lapHud',     label: 'Lap HUD',              selectors: [ '#lap-hud', '#lap-hud-2' ] },
	{ key: 'countdown',  label: 'Countdown',            selectors: [ '#countdown-hud' ] },
	{ key: 'boost',      label: 'Boost UI',             selectors: [ '#boost-ui' ] },
	{ key: 'topMsg',     label: 'Top/effect messages',  selectors: [ '#top-message', '#effect-message' ] },
	{ key: 'vignette',   label: 'Speed-blur vignette',  selectors: [ '#speed-blur-vignette' ] },
	{ key: 'nav',        label: 'Menu buttons (nav)',  selectors: [ '#mode-menu-btn', '#home-menu-btn', '#respawnBtn', '#car-select', '#nav-panel', '#mobile-action-dock' ] },
	{ key: 'garage',     label: 'Garage panel',         selectors: [ '#garage-panel', '#garage-paint-studio' ] },
	{ key: 'hacks',      label: 'Hacks panel',          selectors: [ '#hacks-panel' ] },
	{ key: 'mp',         label: 'Multiplayer panel',    selectors: [ '#mp-panel' ] },
];

// ── HUD overlay helpers (canvas-drawn, styled to match the on-screen HUD) ──
// The recording composites these onto the relay canvas each frame so the video
// includes a HUD. The minimap is composited from the REAL minimap canvas pixels
// (drawImage), so it is pixel-accurate; the speedo/lap/messages are drawn with
// the 2D API using the SAME colors/fonts/positions/arc geometry as the live HTML
// HUD (#speedo-hud, #lap-hud, #countdown-hud, top/effect messages). Reads live
// game values via getOverlayState() (wired in main.js).

// Format seconds as MM:SS.mmm (matches main.js formatLapTime).
function fmtTime( totalSeconds ) {
	if ( totalSeconds === null || ! Number.isFinite( totalSeconds ) ) return '--:--.---';
	const m = Math.floor( totalSeconds / 60 );
	const s = Math.floor( totalSeconds % 60 );
	const ms = Math.floor( ( totalSeconds % 1 ) * 1000 );
	return `${ String( m ).padStart( 2, '0' ) }:${ String( s ).padStart( 2, '0' ) }.${ String( ms ).padStart( 3, '0' ) }`;
}

// Rounded-corner pill (matches #lap-hud border-radius 8px / #countdown 16px).
function pill( ctx, x, y, w, h, r, fill ) {
	ctx.beginPath();
	ctx.moveTo( x + r, y );
	ctx.arcTo( x + w, y, x + w, y + h, r );
	ctx.arcTo( x + w, y + h, x, y + h, r );
	ctx.arcTo( x, y + h, x, y, r );
	ctx.arcTo( x, y, x + w, y, r );
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();
}

// Text-shadow helpers (matches the HUD text-shadow: 0 1px 3px rgba(0,0,0,0.7)).
function shadowOn( ctx ) { ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1; }
function shadowOff( ctx ) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; }


const DEFAULT_SETTINGS = {
	fps: 60,            // target capture FPS (captureStream frame rate)
	bitrate: 12_000_000, // video bits-per-second (high quality)
	audioBitrate: 192_000,
	mimeType: 'auto',   // 'auto' = pick the best supported
	captureAudio: true,
	hideUiWhileRecording: false,
	// All hide-groups default OFF. Earlier defaults pre-checked 6 groups, so the
	// moment "Hide selected UI" was enabled most of the screen vanished — which
	// looked like "it always hides everything." Now nothing hides unless the user
	// explicitly checks a group, so the selection is respected.
	hideGroups: { hud: false, lapHud: false, countdown: false, boost: false, topMsg: false, vignette: false, nav: false, garage: false, hacks: false, mp: false },
	filenamePrefix: 'racing-gameplay',
};

// Pick the highest-quality MIME type the browser can actually encode.
function pickMimeType( preferred ) {
	const candidates = [];
	if ( preferred && preferred !== 'auto' ) candidates.push( preferred );
	candidates.push( 'video/webm;codecs=vp9,opus' );
	candidates.push( 'video/webm;codecs=vp8,opus' );
	candidates.push( 'video/webm;codecs=h264,opus' );
	candidates.push( 'video/webm' );
	candidates.push( 'video/mp4;codecs=h264,aac' );
	candidates.push( 'video/mp4' );
	for ( const type of candidates ) {
		try { if ( MediaRecorder.isTypeSupported( type ) ) return type; } catch { /* ignore */ }
	}
	return '';
}

function loadSettings() {
	try {
		const raw = localStorage.getItem( REC_SETTINGS_KEY );
		if ( raw ) {
			const parsed = JSON.parse( raw );
			return {
				...DEFAULT_SETTINGS,
				...parsed,
				hideGroups: { ...DEFAULT_SETTINGS.hideGroups, ...( parsed.hideGroups || {} ) },
			};
		}
	} catch { /* ignore */ }
	return { ...DEFAULT_SETTINGS, hideGroups: { ...DEFAULT_SETTINGS.hideGroups } };
}

function saveSettings( settings ) {
	try { localStorage.setItem( REC_SETTINGS_KEY, JSON.stringify( settings ) ); } catch { /* ignore */ }
}

export class VideoRecorder {
	constructor( options = {} ) {
		this.canvas = options.canvas || null;
		this.getAudioContext = options.getAudioContext || null; // () => AudioContext | null
		this.getMusicElement = options.getMusicElement || null; // () => HTMLMediaElement | null
		this.getOverlayState = options.getOverlayState || null; // () => HUD state for _drawOverlay (see below)
		this.getMessage = options.getMessage || ( ( () => {} ) );
		this.onDebug = options.onDebug || null; // (lineText) => void  -- appends to the debug panel
		this.settings = loadSettings();
		this.mediaRecorder = null;
		this.chunks = [];
		this.stream = null;
		this.videoTrack = null;
		this._manualFrames = false;
		this.lastFrameMs = 0;
		this.audioNodes = null;
		this.hiddenElements = []; // [{ el, prevDisplay }]
		this.recording = false;
		this.startTime = 0;
		this.mimeType = '';
		this.tickHandle = null;
		// Relay 2D canvas: we copy the WebGL canvas onto this RGBA8 2D canvas each
		// frame and captureStream() IT. The main renderer uses a half-float
		// drawing buffer (outputBufferType: HalfFloatType) for HDR tone mapping;
		// capturing that buffer directly yields grey/empty video because video
		// encoders expect RGBA8. The 2D relay always produces capturable frames.
		this.relayCanvas = null;
		this.relayCtx = null;
		this.frameCount = 0;
		this._debugLines = [];
	}

	isRecording() { return this.recording; }

	getElapsedSeconds() {
		if ( ! this.recording ) return 0;
		return ( performance.now() - this.startTime ) / 1000;
	}

	_updateStatus( text ) {
		if ( typeof this.getMessage === 'function' ) this.getMessage( text );
	}

	// Append a timestamped line to the debug panel (and console). Always logged
	// so the user can see exactly what the recorder did on stop/download.
	log( msg ) {
		const t = ( ( performance.now() - ( this.startTime || performance.now() ) ) / 1000 ).toFixed( 2 );
		const line = `[${ t }s] ${ msg }`;
		this._debugLines.push( line );
		try { if ( typeof this.onDebug === 'function' ) this.onDebug( line ); } catch { /* ignore */ }
		try { console.log( '[VideoRecorder] ' + line ); } catch { /* ignore */ }
	}

	getDebugLog() { return this._debugLines.join( '\n' ); }

	// Build the audio part of the capture stream. Returns a MediaStream (audio
	// only) or null if audio capture isn't available / disabled.
	_buildAudioStream() {
		if ( ! this.settings.captureAudio ) return null;
		try {
			const ctx = typeof this.getAudioContext === 'function' ? this.getAudioContext() : null;
			if ( ! ctx ) return null;
			const dest = ctx.createMediaStreamDestination();
			const mixer = ctx.createGain();
			mixer.gain.value = 1;
			mixer.connect( dest );

			const nodes = { ctx, dest, mixer, sources: [] };

			// 1) Game SFX graph. THREE.AudioListener exposes its input GainNode via
			//    getInput() (r140+); tap a copy into the recording mixer without disturbing
			//    the listener's own -> destination routing.
			const listenerInput = ( window.__gameAudio && window.__gameAudio.listener && typeof window.__gameAudio.listener.getInput === 'function' )
				? window.__gameAudio.listener.getInput()
				: null;
			if ( listenerInput ) {
				try {
					const sfxTap = ctx.createGain();
					sfxTap.gain.value = 1;
					listenerInput.connect( sfxTap );
					sfxTap.connect( mixer );
					nodes.sources.push( sfxTap );
					nodes.sfxTap = sfxTap;
					nodes.listenerInput = listenerInput;
				} catch { /* listener graph not routable here */ }
			}

			// 2) Music HTMLMediaElement. createMediaElementSource can only be
			//    called ONCE per element; cache it on the element so re-record works.
			const musicEl = typeof this.getMusicElement === 'function' ? this.getMusicElement() : null;
			if ( musicEl ) {
				try {
					let src = musicEl.__vrMediaSource;
					if ( ! src ) {
						src = ctx.createMediaElementSource( musicEl );
						musicEl.__vrMediaSource = src;
					}
					// Route music to BOTH the speakers (so the player still hears it)
					// and the recording mixer.
					src.connect( ctx.destination );
					const musicTap = ctx.createGain();
					musicTap.gain.value = 1;
					src.connect( musicTap );
					musicTap.connect( mixer );
					nodes.sources.push( musicTap );
					nodes.musicSrc = src;
				} catch { /* media element source already created elsewhere */ }
			}

			this.audioNodes = nodes;
			return dest.stream;
		} catch ( err ) {
			console.warn( 'VideoRecorder: audio capture failed', err );
			return null;
		}
	}

	_applyHideGroups() {
		if ( ! this.settings.hideUiWhileRecording ) {
			this.log( 'hide UI: master toggle OFF — nothing hidden' );
			return;
		}
		this.hiddenElements = [];
		const groups = this.settings.hideGroups || {};
		const applied = [];
		for ( const group of UI_TOGGLE_GROUPS ) {
			if ( ! groups[ group.key ] ) continue;
			let n = 0;
			for ( const sel of group.selectors ) {
				let els;
				try { els = document.querySelectorAll( sel ); } catch { continue; }
				els.forEach( ( el ) => {
					if ( ! el || el.dataset.vrHidden ) return;
					const prev = el.style.display;
					el.dataset.vrHidden = '1';
					el.style.display = 'none';
					this.hiddenElements.push( { el, prev } );
					n++;
				} );
			}
			applied.push( `${ group.key }(${ n } el)` );
		}
		this.log( `hide UI: applied groups = [ ${ applied.join( ', ' ) || 'none' } ]` );
	}

	_restoreHideGroups() {
		this.log( `restore UI: ${ this.hiddenElements.length } elements restored` );
		for ( const { el, prev } of this.hiddenElements ) {
			if ( ! el ) continue;
			delete el.dataset.vrHidden;
			el.style.display = prev;
		}
		this.hiddenElements = [];
	}

	async start() {
		if ( this.recording ) return false;
		if ( ! this.canvas ) { this._updateStatus( 'Recorder: no canvas available.' ); return false; }
		this._debugLines = [];
		this.frameCount = 0;
		this.startTime = performance.now();
		this.log( 'start() called' );
		this.log( `canvas size = ${ this.canvas.width }x${ this.canvas.height } (client ${ this.canvas.clientWidth }x${ this.canvas.clientHeight })` );
		if ( ! ( typeof MediaRecorder === 'function' ) ) {
			this.log( 'FAIL: MediaRecorder not supported' );
			this._updateStatus( 'Your browser does not support in-game recording (MediaRecorder).' );
			return false;
		}

		try {
			const fps = Math.max( 10, Math.min( 120, Number( this.settings.fps ) || 60 ) );
			this.log( `target fps = ${ fps }` );

			// --- Relay 2D canvas -------------------------------------------------
			// Copy the WebGL canvas onto an RGBA8 2D canvas and capture that.
			// This sidesteps the half-float drawing buffer (grey/empty capture).
			this.relayCanvas = document.createElement( 'canvas' );
			this.relayCanvas.width = this.canvas.width || this.canvas.clientWidth || 1280;
			this.relayCanvas.height = this.canvas.height || this.canvas.clientHeight || 720;
			this.relayCtx = this.relayCanvas.getContext( '2d' );
			this.log( `relay 2D canvas = ${ this.relayCanvas.width }x${ this.relayCanvas.height }` );

			let stream;
			try { stream = this.relayCanvas.captureStream( fps ); }
			catch { try { stream = this.relayCanvas.captureStream(); } catch { throw new Error( 'captureStream not supported' ); } }
			this.stream = stream;
			this.videoTrack = ( stream.getVideoTracks?.() || [] )[ 0 ] || null;
			this._manualFrames = Boolean( this.videoTrack && typeof this.videoTrack.requestFrame === 'function' );
			this.log( `video track readyState=${ this.videoTrack?.readyState } frameRate=${ this.videoTrack?.frameRate } requestFrame=${ this._manualFrames }` );

			// Prime the relay with one frame so the track isn't empty at start.
			try { this.relayCtx.drawImage( this.canvas, 0, 0 ); } catch ( e ) { this.log( `prime drawImage error: ${ e.message }` ); }
			if ( this._manualFrames ) { try { this.videoTrack.requestFrame(); } catch { /* ignore */ } }

			// --- Audio -----------------------------------------------------------
			const audioStream = this._buildAudioStream();
			if ( audioStream ) {
				const at = audioStream.getAudioTracks?.() || [];
				at.forEach( ( t ) => stream.addTrack( t ) );
				this.log( `audio tracks added: ${ at.length }` );
			} else {
				this.log( 'audio: none (disabled or unavailable)' );
			}

			// --- MediaRecorder ---------------------------------------------------
			this.mimeType = pickMimeType( this.settings.mimeType );
			this.log( `mimeType = ${ this.mimeType || '(default)' }` );
			const recorderOpts = {
				videoBitsPerSecond: Math.max( 500_000, Number( this.settings.bitrate ) || 12_000_000 ),
			};
			if ( this.settings.audioBitrate ) recorderOpts.audioBitsPerSecond = Number( this.settings.audioBitrate );
			if ( this.mimeType ) recorderOpts.mimeType = this.mimeType;
			this.log( `recorder opts = ${ JSON.stringify( recorderOpts ) }` );

			this.mediaRecorder = new MediaRecorder( stream, recorderOpts );
			this.chunks = [];
			let totalBytes = 0;
			this.mediaRecorder.ondataavailable = ( e ) => {
				if ( e.data && e.data.size > 0 ) {
					this.chunks.push( e.data );
					totalBytes += e.data.size;
					this.frameCount++;
					this.log( `dataavailable: ${ ( e.data.size / 1024 ).toFixed( 1 ) } KB (total ${( totalBytes / 1024 ).toFixed( 1 ) } KB, ${ this.frameCount } chunks)` );
				}
			};
			this.mediaRecorder.onstop = () => {
				this.log( `onstop: state=${ this.mediaRecorder?.state } chunks=${ this.chunks.length } bytes=${ totalBytes }` );
				this._finalize( totalBytes );
			};
			this.mediaRecorder.onerror = ( e ) => {
				this.log( `onerror: ${ e?.error?.name || e?.name || 'unknown' }: ${ e?.error?.message || e?.message || '' }` );
				this._updateStatus( 'Recording error — see debug.' );
			};

			this.mediaRecorder.start( 1000 );
			this.recording = true;
			this.log( `MediaRecorder.start() -> state=${ this.mediaRecorder.state }` );
			this._applyHideGroups();
			this._startTicker();
			this.captureFrame();
			const withAudio = audioStream ? ' + audio' : '';
			this._updateStatus( `Recording started (${fps}fps${ withAudio }).` );
			this.log( 'start() success' );
			return true;
		} catch ( err ) {
			this.log( `start FAILED: ${ err.message || err }` );
			console.error( 'VideoRecorder start failed', err );
			this._updateStatus( `Could not start recording: ${ err.message || err }` );
			this._cleanupStream();
			return false;
		}
	}

	// Called from the game's animate loop after renderer.render() each frame.
	// Copies the freshly rendered WebGL canvas onto the RGBA8 relay canvas, then
	// composites the HUD overlay on top (so the recording includes the UI), then
	// pushes a frame into the recording stream (throttled to the configured FPS).
	captureFrame() {
		if ( ! this.recording || ! this.videoTrack || ! this.relayCtx || ! this.canvas ) return;
		const now = performance.now();
		const minGap = 1000 / Math.max( 10, Math.min( 120, Number( this.settings.fps ) || 60 ) );
		if ( now - this.lastFrameMs < minGap ) return;
		this.lastFrameMs = now;
		// Keep the relay canvas sized to the WebGL drawing buffer.
		if ( this.relayCanvas.width !== this.canvas.width || this.relayCanvas.height !== this.canvas.height ) {
			this.relayCanvas.width = this.canvas.width;
			this.relayCanvas.height = this.canvas.height;
			this.log( `relay resized to ${ this.relayCanvas.width }x${ this.relayCanvas.height }` );
		}
		try {
			this.relayCtx.drawImage( this.canvas, 0, 0 );
		} catch ( e ) {
			this.log( `drawImage error: ${ e.message }` );
			return;
		}
		// Composite the HUD overlay (minimap + speedo + lap + messages) on top so the
		// recording shows the UI. Wrapped so an overlay error never stops recording.
		try { this._drawOverlay(); } catch ( e ) { /* keep recording */ }
		if ( this._manualFrames ) { try { this.videoTrack.requestFrame(); } catch { /* ignore */ } }
	}

	// Draw the HUD onto the relay canvas. The minimap is composited from the REAL
	// minimap canvas pixels (drawImage); the speedo/lap/messages are drawn with the
	// 2D API using the SAME colors/fonts/positions/arc geometry as the live HTML HUD.
	// State comes from this.getOverlayState() (wired in main.js): {
	//   minimap: HTMLCanvasElement|null,
	//   lap, lapTime (sec), bestTime (sec|null), totalLaps (0 if unknown),
	//   speedMph (number),
	//   countdown: string|null,            // big centered countdown text (#countdown-hud)
	//   topMessage: string|null,          // #top-message (warn shown)
	//   effectMessage: string|null,       // #effect-message (brief toast)
	//   split: { lap, lapTime, bestTime }|null,
	// }
	// Honors hide-groups: a piece is skipped when hideUiWhileRecording (master) is ON
	// and that group's checkbox is checked — so "hide selected UI" works in the video.
	_drawOverlay() {
		if ( typeof this.getOverlayState !== 'function' ) return;
		const st = this.getOverlayState();
		if ( ! st ) return;
		const ctx = this.relayCtx;
		const W = this.relayCanvas.width;
		const hg = this.settings.hideGroups || {};
		const hideOn = this.settings.hideUiWhileRecording; // master toggle
		const hidden = ( key ) => Boolean( hideOn ) && Boolean( hg[ key ] );
		// The on-screen HUD is laid out for a 1280-wide stage; scale so it matches at
		// any capture resolution. (CSS uses px positions assuming a ~1280 viewport.)
		const s = W / 1280;
		ctx.save();
		ctx.scale( s, s );
		ctx.textBaseline = 'alphabetic';
		const baseW = 1280, baseH = 720;

		// ── Minimap (top-left) — REAL canvas pixels, not redrawn ──
		// #minimap-hud is 140×140 at top:12px;left:12px (see HudExtras._buildMinimap).
		if ( ! hidden( 'nav' ) && st.minimap ) {
			try { ctx.drawImage( st.minimap, 12, 12, 140, 140 ); } catch { /* minimap not ready */ }
		}

		// ── Lap HUD (top-center) — matches #lap-hud ──
		// position:absolute; top:12px; left:50%; transform:translateX(-50%);
		// font: 600 14px/1.4 sans-serif; color:#fff; text-shadow 0 1px 3px rgba(0,0,0,.7);
		// background: rgba(0,0,0,0.4); border-radius:8px; padding:8px 12px.
		if ( ! hidden( 'lapHud' ) ) {
			const lap = st.lap != null ? st.lap : 1;
			const total = st.totalLaps != null ? st.totalLaps : 0;
			const lapLine = total ? `LAP ${ lap } / ${ total }` : `LAP ${ lap }`;
			const lapTimeStr = fmtTime( st.lapTime );
			const bestStr = st.bestTime != null ? fmtTime( st.bestTime ) : '--:--.---';
			// Two lines: "LAP n / total" (bold-ish) and "time · BEST time".
			ctx.font = '600 14px sans-serif';
			const w1 = ctx.measureText( lapLine ).width;
			ctx.font = '600 12px sans-serif';
			const w2 = ctx.measureText( lapTimeStr + '   BEST ' + bestStr ).width;
			const pw = Math.max( w1, w2 ) + 24; // padding 12 each side
			const ph = 44; // two lines + padding 8*2
			const px = baseW / 2 - pw / 2;
			const py = 12;
			pill( ctx, px, py, pw, ph, 8, 'rgba(0,0,0,0.4)' );
			ctx.fillStyle = '#fff';
			ctx.textAlign = 'center';
			ctx.font = '600 14px sans-serif';
			shadowOn( ctx );
			ctx.fillText( lapLine, baseW / 2, py + 18 );
			ctx.font = '600 12px sans-serif';
			ctx.fillStyle = '#cfe1f8';
			ctx.fillText( lapTimeStr + '   BEST ' + bestStr, baseW / 2, py + 34 );
			shadowOff( ctx );
		}

		// ── Speedometer (bottom-right) — matches #speedo-hud / #speedo-ring ──
		// #speedo-hud: bottom:20px; right:168px. SVG ring r=42, viewBox 100×100,
		// width 64. arc stroke-dasharray 263.9 (=2π·42), rotate(-90). #speedo-num
		// font 800 18px #fff; #speedo-label 700 9px #b5c2da. Colors: >55 #ff9f1c,
		// >35 #ffd95a, else #77f3b1.
		if ( ! hidden( 'speedo' ) ) {
			const mph = st.speedMph || 0;
			const MAX_MPH = 70;
			const ratio = Math.min( 1, mph / MAX_MPH );
			const ringSize = 64;
			const cx = baseW - 168 - ringSize / 2;
			const cy = baseH - 20 - ringSize / 2;
			// SVG is 64×64 but the 100×100 viewBox means scale 0.64; r=42 → 26.88px radius.
			const r = 42 * ( ringSize / 100 );
			const circ = 2 * Math.PI * r;
			ctx.save();
			ctx.translate( cx, cy );
			// track ring (full circle, faint)
			ctx.beginPath();
			ctx.arc( 0, 0, r, 0, Math.PI * 2 );
			ctx.strokeStyle = 'rgba(255,255,255,0.12)';
			ctx.lineWidth = 6 * ( ringSize / 100 );
			ctx.stroke();
			// value arc, starts at top (rotate -90), grows clockwise
			ctx.beginPath();
			ctx.arc( 0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio );
			const stroke = mph > 55 ? '#ff9f1c' : ( mph > 35 ? '#ffd95a' : '#77f3b1' );
			ctx.strokeStyle = stroke;
			ctx.lineCap = 'round';
			ctx.lineWidth = 6 * ( ringSize / 100 );
			ctx.stroke();
			ctx.restore();
			// number + label
			ctx.textAlign = 'center';
			shadowOn( ctx );
			ctx.fillStyle = '#fff';
			ctx.font = '800 18px sans-serif';
			ctx.fillText( String( Math.round( mph ) ), cx, cy + 6 );
			ctx.fillStyle = '#b5c2da';
			ctx.font = '700 9px sans-serif';
			ctx.fillText( 'MPH', cx, cy + 20 );
			shadowOff( ctx );
		}

		// ── Split-screen player-2 lap (center-lower) — matches #lap-hud-2 ──
		// left:50%; top:calc(50% + 12px); transform:translateX(-50%); font 600 14px;
		// background rgba(0,0,0,0.4); border-radius:8px; padding 8px 12px.
		if ( st.split && ! hidden( 'lapHud' ) ) {
			const sp = st.split;
			const line = `LAP ${ sp.lap }   ${ fmtTime( sp.lapTime ) }`;
			ctx.font = '600 14px sans-serif';
			const pw = ctx.measureText( line ).width + 24;
			const ph = 30;
			const px = baseW / 2 - pw / 2;
			const py = baseH / 2 + 12;
			pill( ctx, px, py, pw, ph, 8, 'rgba(0,0,0,0.4)' );
			ctx.fillStyle = '#fff';
			ctx.textAlign = 'center';
			shadowOn( ctx );
			ctx.fillText( line, baseW / 2, py + 20 );
			shadowOff( ctx );
		}

		// ── Countdown (big, centered) — matches #countdown-hud ──
		// font 800 clamp(48px,10vw,112px); centered; background rgba(0,0,0,0.52);
		// border-radius 16px; padding 18px 26px.
		if ( st.countdown && ! hidden( 'countdown' ) ) {
			const txt = String( st.countdown );
			ctx.font = '800 96px sans-serif';
			const w = ctx.measureText( txt ).width;
			const pw = w + 52, ph = 140;
			pill( ctx, baseW / 2 - pw / 2, baseH / 2 - ph / 2, pw, ph, 16, 'rgba(0,0,0,0.52)' );
			ctx.fillStyle = '#fff';
			ctx.textAlign = 'center';
			shadowOn( ctx );
			ctx.fillText( txt, baseW / 2, baseH / 2 + 32 );
			shadowOff( ctx );
		}

		// ── Transient messages — match #top-message (warn) / #effect-message ──
		// Both are centered-ish toasts with a dark pill + white text + shadow.
		if ( st.topMessage && ! hidden( 'topMsg' ) ) {
			const msg = String( st.topMessage );
			ctx.font = '700 18px sans-serif';
			const w = ctx.measureText( msg ).width;
			pill( ctx, baseW / 2 - w / 2 - 14, 60, w + 28, 34, 8, 'rgba(200,30,30,0.78)' );
			ctx.fillStyle = '#fff';
			ctx.textAlign = 'center';
			shadowOn( ctx );
			ctx.fillText( msg, baseW / 2, 82 );
			shadowOff( ctx );
		}
		if ( st.effectMessage && ! hidden( 'topMsg' ) ) {
			const msg = String( st.effectMessage );
			ctx.font = '700 20px sans-serif';
			const w = ctx.measureText( msg ).width;
			pill( ctx, baseW / 2 - w / 2 - 14, 110, w + 28, 36, 8, 'rgba(0,0,0,0.6)' );
			ctx.fillStyle = '#fff';
			ctx.textAlign = 'center';
			shadowOn( ctx );
			ctx.fillText( msg, baseW / 2, 134 );
			shadowOff( ctx );
		}

		ctx.restore();
	}

	stop() {
		if ( ! this.recording || ! this.mediaRecorder ) return false;
		this.log( 'stop() called' );
		this.captureFrame();
		try { if ( typeof this.mediaRecorder.requestData === 'function' ) { this.mediaRecorder.requestData(); this.log( 'requestData() sent' ); } } catch ( e ) { this.log( `requestData error: ${ e.message }` ); }
		try {
			if ( this.mediaRecorder.state !== 'inactive' ) this.mediaRecorder.stop();
		} catch ( e ) { this.log( `stop error: ${ e.message }` ); }
		this.recording = false;
		this._stopTicker();
		this._restoreHideGroups();
		this._updateStatus( 'Stopping & preparing download…' );
		return true;
	}

	_finalize( totalBytesIn ) {
		const secs = ( ( performance.now() - this.startTime ) / 1000 ).toFixed( 1 );
		const type = this.mimeType || '';
		const totalBytes = totalBytesIn || this.chunks.reduce( ( a, c ) => a + ( c.size || 0 ), 0 );
		const blob = new Blob( this.chunks, { type: type || 'video/webm' } );
		this.log( `finalize: blob size=${ blob.size } bytes (${ ( blob.size / 1024 / 1024 ).toFixed( 2 ) } MB) type=${ blob.type } frames pushed=${ this.frameCount } elapsed=${ secs }s` );
		this.chunks = [];
		this._cleanupStream();
		if ( blob.size === 0 ) {
			this.log( 'RESULT: empty blob — no data was captured. Likely the video track produced no frames.' );
			this._updateStatus( 'Recording was empty — nothing to save. See debug.' );
			return;
		}

		const ext = type.includes( 'mp4' ) ? 'mp4' : 'webm';
		const stamp = new Date();
		const pad = ( n ) => String( n ).padStart( 2, '0' );
		const name = `${ this.settings.filenamePrefix || 'racing-gameplay' }-${ stamp.getFullYear() }${ pad( stamp.getMonth() + 1 ) }${ pad( stamp.getDate() ) }-${ pad( stamp.getHours() ) }${ pad( stamp.getMinutes() ) }${ pad( stamp.getSeconds() ) }.${ ext }`;

		const url = URL.createObjectURL( blob );
		this.lastBlobUrl = url;
		this.lastBlobName = name;
		this.log( `blob URL: ${ url }` );

		// Open the recording in a new tab so the user can play/verify it directly.
		// This is the only automatic navigation we do, and it targets _blank so the
		// game page (and this debug log) stays put.
		try {
			const w = window.open( url, '_blank' );
			if ( ! w ) this.log( 'window.open was blocked — use the Download button in the panel' );
			else this.log( 'opened recording in a new tab' );
		} catch ( e ) { this.log( `window.open error: ${ e.message }` ); }

		// NOTE: we do NOT auto-trigger an <a download> click here. That click runs
		// inside the async onstop callback (outside a user gesture), so some
		// browsers ignore the `download` attribute and NAVIGATE the current tab to
		// the blob URL instead of downloading — which throws away the debug log.
		// Instead the panel shows a "Download recording" button (see main.js) that
		// performs the download from a real user click.
		this._updateStatus( `Ready: ${ name } (${ ( blob.size / 1024 / 1024 ).toFixed( 1 ) } MB, ${ secs }s). Opened in new tab; use Download to save.` );
		this.log( 'finalize done — waiting for user to click Download (or save from the new tab)' );
	}

	// Triggered from the panel's Download button (a real user gesture). Opens the
	// recording in a NEW TAB — the same proven mechanism as the auto-open on stop —
	// so the user can play + save it (right-click → Save Video As). The
	// <a download>.click() approach navigated the current tab to a broken blob URL
	// in some browsers, so we deliberately avoid it. A fresh URL is minted from the
	// retained blob url each call (kept alive for the new tab to load).
	downloadLast() {
		if ( ! this.lastBlobUrl ) { this.log( 'downloadLast: no recording available' ); return false; }
		try {
			const w = window.open( this.lastBlobUrl, '_blank' );
			if ( ! w ) {
				this.log( 'downloadLast: window.open was blocked by the browser' );
				this._updateStatus( 'Popup blocked — allow popups, then click Download again.' );
				return false;
			}
			this.log( `downloadLast: opened recording in a new tab (${ this.lastBlobName })` );
			this._updateStatus( `Opened ${ this.lastBlobName } in a new tab — right-click → Save Video As to download.` );
			return true;
		} catch ( e ) { this.log( `downloadLast error: ${ e.message }` ); return false; }
	}

	_cleanupStream() {
		try {
			if ( this.stream ) this.stream.getTracks().forEach( ( t ) => { try { t.stop(); } catch { /* ignore */ } } );
		} catch { /* ignore */ }
		this.stream = null;
		this.videoTrack = null;
		this.relayCanvas = null;
		this.relayCtx = null;
		try {
			if ( this.audioNodes ) {
				const { ctx, mixer, sources, sfxTap, listenerInput, musicSrc } = this.audioNodes;
				sources.forEach( ( n ) => { try { n.disconnect(); } catch { /* ignore */ } } );
				if ( sfxTap && listenerInput ) { try { sfxTap.disconnect(); } catch { /* ignore */ } try { listenerInput.disconnect( sfxTap ); } catch { /* ignore */ } }
				if ( mixer ) { try { mixer.disconnect(); } catch { /* ignore */ } }
				// Keep musicSrc -> ctx.destination so the player keeps hearing music.
				if ( musicSrc ) { try { musicSrc.connect( ctx.destination ); } catch { /* ignore */ } }
			}
		} catch { /* ignore */ }
		this.audioNodes = null;
		this.mediaRecorder = null;
	}

	_startTicker() {
		// captureStream() pulls frames from the canvas on its own schedule; we
		// only run a lightweight status ticker so the UI can show elapsed time.
		const tick = () => {
			if ( ! this.recording ) return;
			const s = this.getElapsedSeconds();
			const mm = String( Math.floor( s / 60 ) ).padStart( 2, '0' );
			const ss = String( Math.floor( s % 60 ) ).padStart( 2, '0' );
			this._updateStatus( `● REC ${ mm }:${ ss }`, true );
			this.tickHandle = setTimeout( tick, 500 );
		};
		tick();
	}

	_stopTicker() {
		if ( this.tickHandle ) { clearTimeout( this.tickHandle ); this.tickHandle = null; }
	}

	updateSettings( partial ) {
		this.settings = {
			...this.settings,
			...partial,
			hideGroups: { ...this.settings.hideGroups, ...( partial.hideGroups || {} ) },
		};
		saveSettings( this.settings );
	}

	dispose() {
		if ( this.recording ) this.stop();
		this._cleanupStream();
		this._restoreHideGroups();
	}
}

export { UI_TOGGLE_GROUPS, DEFAULT_SETTINGS, pickMimeType, loadSettings, saveSettings };
