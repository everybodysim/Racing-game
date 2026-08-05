const MENU_MUSIC_SRC = 'audio/menu.mp3';
const MENU_MUSIC_VOLUME = 0.32;

let menuMusic = null;
let unlocked = false;

function ensureMenuMusic() {

	if ( menuMusic ) return menuMusic;
	menuMusic = new Audio( MENU_MUSIC_SRC );
	menuMusic.loop = true;
	menuMusic.preload = 'auto';
	menuMusic.volume = MENU_MUSIC_VOLUME;
	menuMusic.addEventListener( 'error', () => {

		console.warn( `Menu music could not be loaded from ${ MENU_MUSIC_SRC }.` );

	}, { once: true } );
	return menuMusic;

}

function stopMenuMusic() {

	if ( ! menuMusic ) return;
	menuMusic.pause();
	menuMusic.currentTime = 0;

}

function playMenuMusic() {

	if ( document.hidden ) return;
	ensureMenuMusic().play().catch( () => {

		// Browsers require a user gesture before music starts; the unlock listeners retry.

	} );

}

function unlockMenuMusic() {

	if ( unlocked ) return;
	unlocked = true;
	playMenuMusic();

}

window.addEventListener( 'pointerdown', unlockMenuMusic, { once: true } );
window.addEventListener( 'keydown', unlockMenuMusic, { once: true } );
window.addEventListener( 'touchstart', unlockMenuMusic, { once: true } );
window.addEventListener( 'pagehide', stopMenuMusic );
window.addEventListener( 'beforeunload', stopMenuMusic );
document.addEventListener( 'visibilitychange', () => {

	if ( document.hidden ) stopMenuMusic();
	else if ( unlocked ) playMenuMusic();

} );

ensureMenuMusic();
