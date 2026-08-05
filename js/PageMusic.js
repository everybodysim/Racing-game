const MENU_MUSIC_SOURCES = [ 'audio/menu.mp3', 'audio/music.mp3' ];
const MENU_MUSIC_VOLUME = 0.416;
const AUDIO_CACHE_NAME = 'racing-game-audio-v1';

const pathName = window.location.pathname.split( '/' ).pop() || 'index.html';
const params = new URLSearchParams( window.location.search );
const IS_ACTIVE_RACING_INDEX = pathName === 'index.html' && ( params.get( 'play' ) === '1' || params.has( 'map' ) || params.has( 'pack' ) || params.has( 'localPack' ) );

let menuMusic = null;
let unlocked = false;
let primed = false;
let sourceIndex = 0;
let wantToPlay = false;   // set when play is requested but audio isn't ready yet
let sourceReady = false;  // set when the current source can play

function currentSource() {
	return MENU_MUSIC_SOURCES[ Math.min( sourceIndex, MENU_MUSIC_SOURCES.length - 1 ) ];
}

function addPreloadHint( src = currentSource() ) {
	if ( document.querySelector( `link[rel="preload"][href="${ src }"]` ) ) return;
	const link = document.createElement( 'link' );
	link.rel = 'preload';
	link.as = 'audio';
	link.href = src;
	document.head.appendChild( link );
}

async function getCachedAudioUrl( src ) {
	if ( ! ( 'caches' in window ) ) return src;
	try {
		const cache = await caches.open( AUDIO_CACHE_NAME );
		const cached = await cache.match( src );
		if ( cached ) {
			const blob = await cached.blob();
			return URL.createObjectURL( blob );
		}
		const response = await fetch( src );
		if ( response.ok ) {
			await cache.put( src, response.clone() );
			const blob = await response.blob();
			return URL.createObjectURL( blob );
		}
	} catch ( e ) {
		console.warn( 'Audio cache miss for', src, e );
	}
	return src;
}

function ensureMenuMusic() {
	if ( menuMusic ) return menuMusic;
	menuMusic = new Audio();
	menuMusic.loop = true;
	menuMusic.preload = 'auto';
	menuMusic.volume = MENU_MUSIC_VOLUME;

	// When the audio can play, kick off playback if we were waiting
	menuMusic.addEventListener( 'canplay', () => {
		sourceReady = true;
		if ( wantToPlay && unlocked && ! IS_ACTIVE_RACING_INDEX && ! document.hidden ) {
			menuMusic.play().catch( () => {} );
			wantToPlay = false;
		}
	} );

	// Handle errors — try the next source
	menuMusic.addEventListener( 'error', tryNextSource );
	return menuMusic;
}

function setSource( src ) {
	sourceReady = false;
	const audio = ensureMenuMusic();
	getCachedAudioUrl( src ).then( url => {
		if ( ! audio ) return;
		audio.pause();
		audio.setAttribute( 'src', url );
		audio.load();
		// canplay event will fire after the browser buffers enough.
		// If it's already cached it may fire almost instantly.
	} );
}

function tryNextSource() {
	if ( sourceIndex >= MENU_MUSIC_SOURCES.length - 1 ) {
		console.warn( `Menu music could not be loaded from ${ MENU_MUSIC_SOURCES.join( ' or ' ) }.` );
		return;
	}
	sourceIndex++;
	addPreloadHint( currentSource() );
	setSource( currentSource() );
}

function primeMenuMusic() {
	if ( IS_ACTIVE_RACING_INDEX || primed ) return;
	primed = true;
	addPreloadHint( currentSource() );
	ensureMenuMusic();
	setSource( currentSource() );
}

function stopMenuMusic() {
	wantToPlay = false;
	if ( menuMusic ) menuMusic.pause();
}

function playMenuMusic() {
	if ( IS_ACTIVE_RACING_INDEX || document.hidden ) return;
	const audio = ensureMenuMusic();
	if ( sourceReady ) {
		// Audio is loaded — play directly
		audio.play().catch( () => {} );
	} else {
		// Audio isn't ready — set the flag and canplay will trigger playback
		wantToPlay = true;
	}
}

function unlockMenuMusic() {
	if ( unlocked && menuMusic && ! menuMusic.paused ) return;
	unlocked = true;
	primeMenuMusic();
	playMenuMusic();
}

// Kick off preloading immediately
primeMenuMusic();

// Browsers block autoplay until user interaction — unlock on first gesture
window.addEventListener( 'pointerdown', unlockMenuMusic, { once: true, capture: true } );
window.addEventListener( 'mousedown', unlockMenuMusic, { once: true, capture: true } );
window.addEventListener( 'keydown', unlockMenuMusic, { once: true, capture: true } );
window.addEventListener( 'touchstart', unlockMenuMusic, { once: true, capture: true } );

// Stop when leaving, resume when returning
window.addEventListener( 'pagehide', stopMenuMusic );
window.addEventListener( 'beforeunload', stopMenuMusic );
document.addEventListener( 'visibilitychange', () => {
	if ( document.hidden ) stopMenuMusic();
	else if ( unlocked ) playMenuMusic();
} );
