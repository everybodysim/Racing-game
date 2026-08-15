/**
 * GameSettings.js — unified, persistent game settings for Skid Circuit.
 *
 * One source of truth for all player-tunable preferences (graphics, audio,
 * gameplay, controls, accessibility). Persists to localStorage AND, when the
 * player is signed into a cloud account, to the account profile via the
 * accounts worker (stored under `profile.settings`).
 *
 * Design notes:
 * - The game's subsystems each already read their OWN legacy localStorage keys
 *   (graphics quality, audio settings, fps toggle, fx ghosts, countdown,
 *   camera params...). To avoid a risky rewrite of main.js, GameSettings writes
 *   BOTH the unified key `racing-game-settings-v1` AND the matching legacy keys
 *   on every save. So every existing subsystem keeps working unchanged, and the
 *   unified object is what round-trips to the cloud.
 * - On first load with no unified key, settings are MIGRATED from whatever
 *   legacy keys already exist, so a returning player's previous choices are kept.
 * - Every read is defensive: corrupt/missing values fall back to defaults.
 *
 * Public API (window.GameSettings / default export):
 *   getSettings()            -> normalized settings object (live copy)
 *   saveSettings(next?)      -> validate + persist (localStorage + legacy keys); returns normalized
 *   patchSettings(patch)     -> deep-merge one section { graphics:{...} } and persist
 *   resetToDefaults()        -> restore defaults + persist
 *   applyLegacyKeys(next)    -> write the per-subsystem legacy keys for `next`
 *   isSignedIn()             -> bool (account session present)
 *   getCloudStatus()         -> { signedIn, username }
 *   saveSettingsToCloud()    -> POST profile.settings to accounts worker (throws on error)
 *   loadSettingsFromCloud()  -> GET profile, apply profile.settings, persist locally
 *   applyLive()              -> push live-applicable values into the running engine
 */
'use strict';

const UNIFIED_KEY = 'racing-game-settings-v1';
const LEGACY = {
	graphicsQuality: 'racing-graphics-quality',
	audio: 'racingGameAudioSettings',
	fps: 'racing-show-fps-v1',
	countdown: 'racing-countdown-enabled-v1',
	fx: 'racing-fx-settings-v1',
	session: 'racing-account-session-v1',
	playerName: 'racing-player-name-v1',
};
const ACCOUNT_API_BASE = 'https://racing-account-api.ga1010.workers.dev/api/accounts';
const SCHEMA_VERSION = 1;

// ---- Defaults ----
// Mirror the game's existing defaults (js/main.js + js/Audio.js) so a fresh
// install behaves exactly as before the settings page existed.
function defaultGraphicsPreset() {
	const coarse = Boolean( window.matchMedia && window.matchMedia( '(pointer: coarse)' ) && window.matchMedia( '(pointer: coarse)' ).matches );
	const small = window.innerWidth <= 760;
	const mobileUA = /Android|iPhone|iPad|iPod/i.test( navigator.userAgent );
	if ( coarse || small || mobileUA ) {
		const mem = Number( navigator.deviceMemory ) || 0;
		return ( mem && mem <= 4 ) ? 'low' : 'medium';
	}
	return 'high';
}

function defaultSettings() {
	return {
		v: SCHEMA_VERSION,
		graphics: {
			preset: defaultGraphicsPreset(),
			maxPixelRatio: null,
			shadows: null,
			shadowMapSize: null,
			bloomStrength: null,
			bloomRadius: null,
			smokeParticles: null,
			antialias: true,
			reduceMotion: false,
		},
		audio: {
			sfxVolume: 1,
			musicVolume: 1,
			musicMode: 0,
		},
		gameplay: {
			showFps: false,
			countdownEnabled: null,
			recentGhostsEnabled: false,
			recentGhostCount: 3,
			cameraDistance: null,
			cameraHeight: null,
			cameraLag: 1,
			autoRespawn: false,
		},
		controls: {
			invertSteer: false,
			keyboardOnly: false,
			steerSmoothing: 1,
		},
		accessibility: {
			highContrastHud: false,
			largeHud: false,
			screenShake: true,
			colorblindFilter: 'off',
		},
	};
}

// ---- Validation / normalization ----
function clampNum( v, min, max, fallback ) {
	const n = Number( v );
	if ( ! isFinite( n ) ) return fallback;
	return Math.max( min, Math.min( max, n ) );
}
function pick( v, allowed, fallback ) {
	return allowed.indexOf( v ) >= 0 ? v : fallback;
}
function maybeClamp( v, min, max ) {
	if ( v == null ) return null;
	return clampNum( v, min, max, null );
}
function maybeBool( v ) {
	return v == null ? null : Boolean( v );
}

function normalizeGraphics( src ) {
	src = src && typeof src === 'object' ? src : {};
	return {
		preset: pick( src.preset, [ 'low', 'medium', 'high' ], defaultGraphicsPreset() ),
		maxPixelRatio: maybeClamp( src.maxPixelRatio, 0.5, 2 ),
		shadows: maybeBool( src.shadows ),
		shadowMapSize: src.shadowMapSize == null ? null : Math.round( clampNum( src.shadowMapSize, 256, 8192, 2048 ) ),
		bloomStrength: maybeClamp( src.bloomStrength, 0, 0.1 ),
		bloomRadius: maybeClamp( src.bloomRadius, 0, 0.2 ),
		smokeParticles: src.smokeParticles == null ? null : Math.round( clampNum( src.smokeParticles, 0, 128, 64 ) ),
		antialias: src.antialias == null ? true : Boolean( src.antialias ),
		reduceMotion: Boolean( src.reduceMotion ),
	};
}
function normalizeAudio( src ) {
	src = src && typeof src === 'object' ? src : {};
	return {
		sfxVolume: clampNum( src.sfxVolume, 0, 1, 1 ),
		musicVolume: clampNum( src.musicVolume, 0, 1, 1 ),
		musicMode: Math.round( clampNum( src.musicMode, 0, 3, 0 ) ),
	};
}
function normalizeGameplay( src ) {
	src = src && typeof src === 'object' ? src : {};
	return {
		showFps: Boolean( src.showFps ),
		countdownEnabled: src.countdownEnabled == null ? null : Boolean( src.countdownEnabled ),
		recentGhostsEnabled: Boolean( src.recentGhostsEnabled ),
		recentGhostCount: Math.round( clampNum( src.recentGhostCount, 1, 20, 3 ) ),
		cameraDistance: maybeClamp( src.cameraDistance, 2, 30 ),
		cameraHeight: maybeClamp( src.cameraHeight, 0, 20 ),
		cameraLag: clampNum( src.cameraLag, 0.1, 1, 1 ),
		autoRespawn: Boolean( src.autoRespawn ),
	};
}
function normalizeControls( src ) {
	src = src && typeof src === 'object' ? src : {};
	return {
		invertSteer: Boolean( src.invertSteer ),
		keyboardOnly: Boolean( src.keyboardOnly ),
		steerSmoothing: clampNum( src.steerSmoothing, 0.2, 1, 1 ),
	};
}
function normalizeAccessibility( src ) {
	src = src && typeof src === 'object' ? src : {};
	return {
		highContrastHud: Boolean( src.highContrastHud ),
		largeHud: Boolean( src.largeHud ),
		screenShake: src.screenShake == null ? true : Boolean( src.screenShake ),
		colorblindFilter: pick( src.colorblindFilter, [ 'off', 'protan', 'deutan', 'tritan' ], 'off' ),
	};
}

function normalizeSettings( raw ) {
	const s = raw && typeof raw === 'object' ? raw : {};
	return {
		v: SCHEMA_VERSION,
		graphics: normalizeGraphics( s.graphics ),
		audio: normalizeAudio( s.audio ),
		gameplay: normalizeGameplay( s.gameplay ),
		controls: normalizeControls( s.controls ),
		accessibility: normalizeAccessibility( s.accessibility ),
	};
}

// ---- Migration: derive unified settings from legacy keys on first run ----
function migrateFromLegacy() {
	const s = defaultSettings();
	try {
		const gq = localStorage.getItem( LEGACY.graphicsQuality );
		if ( gq === 'low' || gq === 'medium' || gq === 'high' ) s.graphics.preset = gq;
	} catch ( e ) {}
	try {
		const raw = localStorage.getItem( LEGACY.audio );
		if ( raw ) {
			const a = JSON.parse( raw );
			if ( typeof a.sfxVolume === 'number' ) s.audio.sfxVolume = clampNum( a.sfxVolume, 0, 1, 1 );
			if ( typeof a.musicVolume === 'number' ) s.audio.musicVolume = clampNum( a.musicVolume, 0, 1, 1 );
			if ( typeof a.musicMode === 'number' ) s.audio.musicMode = Math.round( clampNum( a.musicMode, 0, 3, 0 ) );
		}
	} catch ( e ) {}
	try { s.gameplay.showFps = localStorage.getItem( LEGACY.fps ) === '1'; } catch ( e ) {}
	try {
		const cd = localStorage.getItem( LEGACY.countdown );
		if ( cd !== null ) s.gameplay.countdownEnabled = cd === '1';
	} catch ( e ) {}
	try {
		const fxRaw = localStorage.getItem( LEGACY.fx );
		if ( fxRaw ) {
			const fx = JSON.parse( fxRaw );
			if ( typeof fx.recentGhostsEnabled === 'boolean' ) s.gameplay.recentGhostsEnabled = fx.recentGhostsEnabled;
			if ( typeof fx.recentGhostCount === 'number' ) s.gameplay.recentGhostCount = Math.round( clampNum( fx.recentGhostCount, 1, 20, 3 ) );
		}
	} catch ( e ) {}
	return s;
}

// ---- Write the per-subsystem legacy keys so main.js picks them up ----
function applyLegacyKeys( s ) {
	try { localStorage.setItem( LEGACY.graphicsQuality, s.graphics.preset ); } catch ( e ) {}
	try { localStorage.setItem( LEGACY.audio, JSON.stringify( {
		musicMode: s.audio.musicMode, sfxVolume: s.audio.sfxVolume, musicVolume: s.audio.musicVolume,
	} ) ); } catch ( e ) {}
	try { localStorage.setItem( LEGACY.fps, s.gameplay.showFps ? '1' : '0' ); } catch ( e ) {}
	try {
		if ( s.gameplay.countdownEnabled != null ) localStorage.setItem( LEGACY.countdown, s.gameplay.countdownEnabled ? '1' : '0' );
	} catch ( e ) {}
	try { localStorage.setItem( LEGACY.fx, JSON.stringify( {
		recentGhostsEnabled: s.gameplay.recentGhostsEnabled, recentGhostCount: s.gameplay.recentGhostCount,
	} ) ); } catch ( e ) {}
}

// ---- Core load/save ----
let cache = null;

function readUnified() {
	try {
		const raw = localStorage.getItem( UNIFIED_KEY );
		if ( raw ) return normalizeSettings( JSON.parse( raw ) );
	} catch ( e ) {}
	return null;
}

function getSettings() {
	if ( cache ) return cache;
	cache = readUnified();
	if ( ! cache ) {
		cache = migrateFromLegacy();
		try { localStorage.setItem( UNIFIED_KEY, JSON.stringify( cache ) ); } catch ( e ) {}
	}
	return cache;
}

function saveSettings( next ) {
	const s = normalizeSettings( next || getSettings() );
	cache = s;
	try { localStorage.setItem( UNIFIED_KEY, JSON.stringify( s ) ); } catch ( e ) {}
	applyLegacyKeys( s );
	return s;
}

// Deep-merge one section { graphics:{ preset:'low' } } over current and persist.
function patchSettings( patch ) {
	const s = getSettings();
	const sections = [ 'graphics', 'audio', 'gameplay', 'controls', 'accessibility' ];
	for ( let i = 0; i < sections.length; i++ ) {
		const key = sections[ i ];
		if ( patch && patch[ key ] && typeof patch[ key ] === 'object' ) {
			s[ key ] = Object.assign( {}, s[ key ], patch[ key ] );
		}
	}
	return saveSettings( s );
}

function resetToDefaults() {
	cache = defaultSettings();
	try { localStorage.setItem( UNIFIED_KEY, JSON.stringify( cache ) ); } catch ( e ) {}
	applyLegacyKeys( cache );
	return cache;
}

// Drop the in-memory cache so the next getSettings() re-reads from localStorage.
// Used by the settings page's storage-event handler to pick up changes made in
// another tab.
function refresh() {
	cache = null;
	return getSettings();
}

// ---- Cloud sync (accounts worker) ----
function getSession() {
	try {
		const raw = localStorage.getItem( LEGACY.session );
		if ( raw ) {
			const parsed = JSON.parse( raw );
			if ( parsed && parsed.token && parsed.username ) return parsed;
		}
	} catch ( e ) {}
	return null;
}
function isSignedIn() { return Boolean( getSession() ); }
function getCloudStatus() {
	const s = getSession();
	return s ? { signedIn: true, username: s.username } : { signedIn: false, username: '' };
}

async function accountRequest( path, options ) {
	const response = await fetch( ACCOUNT_API_BASE + path, Object.assign( {
		headers: { 'Content-Type': 'application/json' },
	}, options || {} ) );
	const payload = await response.json().catch( () => ( {} ) );
	if ( ! response.ok || payload.ok === false ) {
		throw new Error( payload.error || ( 'Account API HTTP ' + response.status ) );
	}
	return payload;
}

// Save ONLY the settings slice to the cloud profile (merges with existing profile).
async function saveSettingsToCloud() {
	const session = getSession();
	if ( ! session ) throw new Error( 'Not signed in. Log in from the game\'s Account tab first.' );
	// Round-trip the full profile so we don't clobber coins/garage/etc.
	const get = await accountRequest( '/profile?token=' + encodeURIComponent( session.token ) );
	const profile = get.profile || {};
	profile.settings = getSettings();
	await accountRequest( '/profile', {
		method: 'POST',
		body: JSON.stringify( { token: session.token, profile: profile } ),
	} );
	return getCloudStatus();
}

async function loadSettingsFromCloud() {
	const session = getSession();
	if ( ! session ) throw new Error( 'Not signed in. Log in from the game\'s Account tab first.' );
	const get = await accountRequest( '/profile?token=' + encodeURIComponent( session.token ) );
	if ( ! get.profile || ! get.profile.settings ) throw new Error( 'No saved settings found in your cloud account.' );
	const local = getSettings();
	const cloud = get.profile.settings;
	const merged = normalizeSettings( Object.assign( {}, local, cloud ) );
	const sections = [ 'graphics', 'audio', 'gameplay', 'controls', 'accessibility' ];
	for ( let i = 0; i < sections.length; i++ ) {
		const k = sections[ i ];
		if ( cloud[ k ] ) merged[ k ] = Object.assign( {}, local[ k ], cloud[ k ] );
	}
	saveSettings( merged );
	return merged;
}

// ---- Live apply bridge (used by main.js) ----
// main.js sets window.__gameSettingsApplyLive to a function that pushes the
// camera/graphics/audio values into the running engine. The settings page
// calls this after a save so in-game changes take effect immediately for the
// fields that support live updates (graphics preset, audio, camera, fps).
function applyLive() {
	try {
		if ( typeof window.__gameSettingsApplyLive === 'function' ) window.__gameSettingsApplyLive( getSettings() );
	} catch ( e ) {
		console.warn( 'GameSettings live apply failed', e );
	}
}

const api = {
	UNIFIED_KEY,
	SCHEMA_VERSION,
	defaultSettings,
	getSettings,
	saveSettings,
	patchSettings,
	resetToDefaults,
	applyLegacyKeys,
	refresh,
	isSignedIn,
	getCloudStatus,
	saveSettingsToCloud,
	loadSettingsFromCloud,
	applyLive,
};

if ( typeof window !== 'undefined' ) {
	window.GameSettings = api;
	window.__gameSettings = api;
}

// Eager-load so window.GameSettings.getSettings() is ready immediately.
getSettings();

export default api;
