const MENU_MUSIC_SOURCES = [ 'audio/menu.mp3', 'audio/music.mp3' ];
const MENU_MUSIC_VOLUME = 0.32;
const pathName = window.location.pathname.split( '/' ).pop() || 'index.html';
const params = new URLSearchParams( window.location.search );
const IS_ACTIVE_RACING_INDEX = pathName === 'index.html' && ( params.get( 'play' ) === '1' || params.has( 'map' ) || params.has( 'pack' ) || params.has( 'localPack' ) );

let menuMusic = null;
let musicButton = null;
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

function updateButton( playing ) {

	if ( ! musicButton ) return;
	musicButton.textContent = playing ? '♪ Music on' : '♪ Play music';
	musicButton.classList.toggle( 'playing', playing );

}

function ensureMusicButton() {

	if ( IS_ACTIVE_RACING_INDEX || musicButton ) return musicButton;
	musicButton = document.createElement( 'button' );
	musicButton.type = 'button';
	musicButton.id = 'menu-music-toggle';
	musicButton.textContent = '♪ Play music';
	musicButton.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;border:1px solid rgba(255,255,255,.28);border-radius:999px;background:rgba(7,12,22,.78);color:#fff;padding:8px 12px;font:800 12px/1 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.26);cursor:pointer;backdrop-filter:blur(8px)';
	musicButton.addEventListener( 'click', () => {

		if ( menuMusic && ! menuMusic.paused ) stopMenuMusic();
		else unlockMenuMusic();

	} );
	document.body.appendChild( musicButton );
	return musicButton;

}

function setSource( src ) {

	const audio = ensureMenuMusic();
	if ( audio.getAttribute( 'src' ) === src ) return audio;
	audio.pause();
	audio.setAttribute( 'src', src );
	audio.load();
	return audio;

}

function tryNextSource() {

	if ( sourceIndex >= MENU_MUSIC_SOURCES.length - 1 ) {

		console.warn( `Menu music could not be loaded from ${ MENU_MUSIC_SOURCES.join( ' or ' ) }. See audio/README.md for asset requirements.` );
		updateButton( false );
		return;

	}

	sourceIndex ++;
	addPreloadHint( currentSource() );
	setSource( currentSource() );
	if ( unlocked ) playMenuMusic();

}

function ensureMenuMusic() {

	if ( menuMusic ) return menuMusic;
	menuMusic = new Audio();
	menuMusic.loop = true;
	menuMusic.preload = 'auto';
	menuMusic.volume = MENU_MUSIC_VOLUME;
	menuMusic.addEventListener( 'playing', () => updateButton( true ) );
	menuMusic.addEventListener( 'pause', () => updateButton( false ) );
	menuMusic.addEventListener( 'error', tryNextSource );
	menuMusic.setAttribute( 'src', currentSource() );
	menuMusic.load();
	return menuMusic;

}

function primeMenuMusic() {

	if ( IS_ACTIVE_RACING_INDEX || primed ) return;
	primed = true;
	addPreloadHint( currentSource() );
	ensureMenuMusic();
	if ( document.readyState === 'loading' ) document.addEventListener( 'DOMContentLoaded', ensureMusicButton, { once: true } );
	else ensureMusicButton();

}

function stopMenuMusic() {

	if ( ! menuMusic ) return;
	menuMusic.pause();
	menuMusic.currentTime = 0;

}

function playMenuMusic() {

	if ( IS_ACTIVE_RACING_INDEX || document.hidden ) return;
	ensureMenuMusic().play().then( () => updateButton( true ) ).catch( () => updateButton( false ) );

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
