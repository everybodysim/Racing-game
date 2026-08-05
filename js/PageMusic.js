const MENU_MUSIC_SOURCES = [ 'audio/menu.mp3', 'audio/music.mp3' ];
const MENU_MUSIC_VOLUME = 0.416; // 0.32 × 1.3 — 30% louder, no binary modification
const AUDIO_CACHE_NAME = 'racing-game-audio-v1';

const pathName = window.location.pathname.split( '/' ).pop() || 'index.html';
const params = new URLSearchParams( window.location.search );
const IS_ACTIVE_RACING_INDEX = pathName === 'index.html' && ( params.get( 'play' ) === '1' || params.has( 'map' ) || params.has( 'pack' ) || params.has( 'localPack' ) );

let menuMusic = null;
let unlocked = false;
let primed = false;
let sourceIndex = 0;

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

/**
 * Try to serve the audio file from the Cache API so subsequent page
 * loads are instant.  On first visit the file is fetched from the
 * network and stored for next time.  Falls back to the plain URL if
 * the Cache API is unavailable or the fetch fails.
 */
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
	menuMusic.addEventListener( 'error', tryNextSource );
	return menuMusic;

}

function setSource( src ) {

	const audio = ensureMenuMusic();
	getCachedAudioUrl( src ).then( url => {

		audio.pause();
		audio.setAttribute( 'src', url );
		audio.load();
		if ( unlocked ) playMenuMusic();

	} );

}

function tryNextSource() {

	if ( sourceIndex >= MENU_MUSIC_SOURCES.length - 1 ) {

		console.warn( `Menu music could not be loaded from ${ MENU_MUSIC_SOURCES.join( ' or ' ) }. See audio/README.md for asset requirements.` );
		return;

	}

	sourceIndex ++;
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

	if ( ! menuMusic ) return;
	menuMusic.pause();
	menuMusic.currentTime = 0;

}

function playMenuMusic() {

	if ( IS_ACTIVE_RACING_INDEX || document.hidden ) return;
	ensureMenuMusic().play().catch( () => {} );

}

function unlockMenuMusic() {

	if ( unlocked && menuMusic && ! menuMusic.paused ) return;
	unlocked = true;
	primeMenuMusic();
	playMenuMusic();

}

primeMenuMusic();
window.addEventListener( 'pointerdown', unlockMenuMusic, { once: true, capture: true } );
window.addEventListener( 'mousedown', unlockMenuMusic, { once: true, capture: true } );
window.addEventListener( 'keydown', unlockMenuMusic, { once: true, capture: true } );
window.addEventListener( 'touchstart', unlockMenuMusic, { once: true, capture: true } );
window.addEventListener( 'pagehide', stopMenuMusic );
window.addEventListener( 'beforeunload', stopMenuMusic );
document.addEventListener( 'visibilitychange', () => {

	if ( document.hidden ) stopMenuMusic();
	else if ( unlocked ) playMenuMusic();

} );
