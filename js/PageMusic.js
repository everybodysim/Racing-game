const MENU_MUSIC_SRC = 'audio/menu.mp3';
const MENU_MUSIC_VOLUME = 0.32;
const pathName = window.location.pathname.split( '/' ).pop() || 'index.html';
const params = new URLSearchParams( window.location.search );
const IS_ACTIVE_RACING_INDEX = pathName === 'index.html' && ( params.get( 'play' ) === '1' || params.has( 'map' ) || params.has( 'pack' ) || params.has( 'localPack' ) );

let menuMusic = null;
let unlocked = false;
let primed = false;

function addPreloadHint() {

	if ( document.querySelector( `link[rel="preload"][href="${ MENU_MUSIC_SRC }"]` ) ) return;
	const link = document.createElement( 'link' );
	link.rel = 'preload';
	link.as = 'audio';
	link.href = MENU_MUSIC_SRC;
	document.head.appendChild( link );

}

function ensureMenuMusic() {

	if ( menuMusic ) return menuMusic;
	menuMusic = new Audio( MENU_MUSIC_SRC );
	menuMusic.loop = true;
	menuMusic.preload = 'auto';
	menuMusic.volume = MENU_MUSIC_VOLUME;
	menuMusic.load();
	menuMusic.addEventListener( 'error', () => {

		console.warn( `Menu music could not be loaded from ${ MENU_MUSIC_SRC }. See audio/README.md for asset requirements.` );

	}, { once: true } );
	return menuMusic;

}

function primeMenuMusic() {

	if ( IS_ACTIVE_RACING_INDEX || primed ) return;
	primed = true;
	addPreloadHint();
	ensureMenuMusic();

}

function stopMenuMusic() {

	if ( ! menuMusic ) return;
	menuMusic.pause();
	menuMusic.currentTime = 0;

}

function playMenuMusic() {

	if ( IS_ACTIVE_RACING_INDEX || document.hidden ) return;
	ensureMenuMusic().play().catch( () => {

		// Browsers require a user gesture before music starts; the unlock listeners retry.

	} );

}

function unlockMenuMusic() {

	if ( unlocked ) return;
	unlocked = true;
	primeMenuMusic();
	playMenuMusic();

}

primeMenuMusic();
window.addEventListener( 'pointerdown', unlockMenuMusic, { once: true } );
window.addEventListener( 'mousedown', unlockMenuMusic, { once: true } );
window.addEventListener( 'keydown', unlockMenuMusic, { once: true } );
window.addEventListener( 'touchstart', unlockMenuMusic, { once: true } );
window.addEventListener( 'pagehide', stopMenuMusic );
window.addEventListener( 'beforeunload', stopMenuMusic );
document.addEventListener( 'visibilitychange', () => {

	if ( document.hidden ) stopMenuMusic();
	else if ( unlocked ) playMenuMusic();

} );
