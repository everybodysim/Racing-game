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
		this.captureMode = 'relay'; // 'display' (tab capture, includes HTML UI) or 'relay' (canvas only)
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

			// --- Capture source --------------------------------------------------
			// PRIMARY: getDisplayMedia (tab capture). This captures the COMPOSITED
			// tab — the WebGL canvas AND every HTML/CSS UI overlay (HUD, lap timer,
			// speedometer, buttons) — because it records what the user actually sees.
			// The relay-canvas fallback only captures the raw WebGL canvas (3D scene,
			// no HTML UI), so we only use it if the user denies tab capture.
			let stream = null;
			this.captureMode = 'relay'; // default fallback
			if ( typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function' ) {
				try {
					const dm = await navigator.mediaDevices.getDisplayMedia( {
						video: {
							frameRate: { ideal: fps, max: fps },
							displaySurface: 'tab',
						},
						audio: false, // we mix audio ourselves below for reliability
					} );
					if ( dm && dm.getVideoTracks?.().length ) {
						stream = dm;
						this.captureMode = 'display';
						this.log( 'capture source: getDisplayMedia (tab) — WebGL + HTML UI composited' );
						// If the user picked a window/screen instead of a tab, warn (UI
						// may not be captured as expected).
						const vt = dm.getVideoTracks()[ 0 ];
						const surf = vt.getSettings?.()?.displaySurface;
						this.log( `display track surface=${ surf || '?' } frameRate=${ vt.getSettings?.()?.frameRate || '?' }` );
					}
				} catch ( e ) {
					this.log( `getDisplayMedia denied/failed: ${ e?.name || e?.message || e } — falling back to canvas-only (no HTML UI)` );
				}
			} else {
				this.log( 'getDisplayMedia not available — using canvas-only capture (no HTML UI)' );
			}

			// FALLBACK: relay 2D canvas (WebGL 3D scene only — HTML UI NOT included).
			if ( ! stream ) {
				this.captureMode = 'relay';
				this.relayCanvas = document.createElement( 'canvas' );
				this.relayCanvas.width = this.canvas.width || this.canvas.clientWidth || 1280;
				this.relayCanvas.height = this.canvas.height || this.canvas.clientHeight || 720;
				this.relayCtx = this.relayCanvas.getContext( '2d' );
				this.log( `relay 2D canvas = ${ this.relayCanvas.width }x${ this.relayCanvas.height } (UI will NOT appear in this mode)` );
				try { stream = this.relayCanvas.captureStream( fps ); }
				catch { try { stream = this.relayCanvas.captureStream(); } catch { throw new Error( 'captureStream not supported' ); } }
			}

			this.stream = stream;
			this.videoTrack = ( stream.getVideoTracks?.() || [] )[ 0 ] || null;
			this._manualFrames = this.captureMode === 'relay' && Boolean( this.videoTrack && typeof this.videoTrack.requestFrame === 'function' );
			this.log( `video track readyState=${ this.videoTrack?.readyState } frameRate=${ this.videoTrack?.frameRate } requestFrame=${ this._manualFrames } (mode=${ this.captureMode })` );

			// Prime the relay with one frame (display mode captures live, no prime needed).
			if ( this.captureMode === 'relay' ) {
				try { this.relayCtx.drawImage( this.canvas, 0, 0 ); } catch ( e ) { this.log( `prime drawImage error: ${ e.message }` ); }
				if ( this._manualFrames ) { try { this.videoTrack.requestFrame(); } catch { /* ignore */ } }
			}

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

			// In display mode, if the user clicks the browser's native "Stop sharing"
			// button, the video track ends. Treat that as a normal stop so the file
			// is finalized + opened in a new tab, instead of silently dropping it.
			if ( this.captureMode === 'display' && this.videoTrack ) {
				this.videoTrack.addEventListener( 'ended', () => {
					this.log( 'display track ended (user stopped sharing via browser UI)' );
					if ( this.recording ) this.stop();
				} );
			}

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
	// Only the relay-canvas mode needs per-frame work (copy WebGL -> relay, push a
	// frame). In display mode the browser captures the composited tab itself.
	captureFrame() {
		if ( ! this.recording ) return;
		if ( this.captureMode !== 'relay' ) return;
		if ( ! this.videoTrack || ! this.relayCtx || ! this.canvas ) return;
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
		if ( this._manualFrames ) { try { this.videoTrack.requestFrame(); } catch { /* ignore */ } }
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
		this.lastBlob = blob; // retain the actual Blob so downloadLast can mint a fresh URL
		this.lastBlobUrl = url;
		this.lastBlobName = name;
		this.log( `blob URL: ${ url }` );

		// Open the recording in a new tab so the user can play/verify it directly.
		// This targets _blank so the game page (and this debug log) stays put.
		try {
			const w = window.open( url, '_blank' );
			if ( ! w ) this.log( 'window.open was blocked — use the Download button in the panel' );
			else this.log( 'opened recording in a new tab' );
		} catch ( e ) { this.log( `window.open error: ${ e.message }` ); }

		this._updateStatus( `Ready: ${ name } (${ ( blob.size / 1024 / 1024 ).toFixed( 1 ) } MB, ${ secs }s, ${ this.captureMode }). Opened in new tab; use Download to save.` );
		this.log( 'finalize done — click Download to save the file' );
	}

	// Triggered from the panel's Download button (a real user gesture). Mints a
	// FRESH blob URL from the retained Blob (re-using the URL already opened in the
	// new tab can confuse some browsers into navigating instead of downloading) and
	// keeps the <a> in the DOM briefly so Chrome doesn't cancel the download.
	downloadLast() {
		if ( ! this.lastBlob ) { this.log( 'downloadLast: no recording available' ); return false; }
		try {
			const url = URL.createObjectURL( this.lastBlob );
			const a = document.createElement( 'a' );
			a.href = url;
			a.download = this.lastBlobName || 'racing-gameplay.webm';
			a.style.display = 'none';
			a.rel = 'noopener';
			document.body.appendChild( a );
			a.click();
			this.log( `download triggered (user gesture): ${ a.download }` );
			// Delay removal + revoke so the browser finishes the download (removing
			// the anchor synchronously can abort the download and fall back to
			// navigating the current tab to the blob URL).
			setTimeout( () => { try { a.remove(); } catch { /* ignore */ } try { URL.revokeObjectURL( url ); } catch { /* ignore */ } }, 4000 );
			return true;
		} catch ( e ) { this.log( `download error: ${ e.message }` ); return false; }
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
