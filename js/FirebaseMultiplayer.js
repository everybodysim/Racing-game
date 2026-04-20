import firebaseConfig from './firebase-config.js';

const CONFIG_KEYS = [
	'apiKey',
	'authDomain',
	'databaseURL',
	'projectId',
	'storageBucket',
	'messagingSenderId',
	'appId',
];

const LOCAL_STORAGE_CONFIG_KEYS = [
	'racing-firebase-config-v1',
	'racing-firebase-config',
];

const PLACEHOLDER_PREFIXES = [ 'PASTE_', 'YOUR_', 'REPLACE_' ];

function normalizeConfigShape( input ) {

	if ( ! input || typeof input !== 'object' ) return null;
	const next = {};
	for ( const key of CONFIG_KEYS ) {

		const value = input[ key ];
		next[ key ] = typeof value === 'string' ? value.trim() : '';

	}
	return next;

}

function hasRealConfigValues( config ) {

	if ( ! config ) return false;
	for ( const key of CONFIG_KEYS ) {

		const value = config[ key ];
		if ( ! value ) return false;
		if ( PLACEHOLDER_PREFIXES.some( ( prefix ) => value.startsWith( prefix ) ) ) return false;

	}
	return true;

}

function readLegacyWindowConfig() {

	return normalizeConfigShape( window.__RACING_FIREBASE_CONFIG );

}

function readLegacyStorageConfig() {

	for ( const storageKey of LOCAL_STORAGE_CONFIG_KEYS ) {

		const raw = localStorage.getItem( storageKey );
		if ( ! raw ) continue;
		try {

			const parsed = JSON.parse( raw );
			const normalized = normalizeConfigShape( parsed );
			if ( normalized ) return normalized;

		} catch {

			// Ignore malformed legacy config entries.

		}

	}

	return null;

}

export function readFirebaseConfig() {

	const primaryConfig = normalizeConfigShape( firebaseConfig );
	if ( hasRealConfigValues( primaryConfig ) ) return primaryConfig;

	const windowConfig = readLegacyWindowConfig();
	if ( hasRealConfigValues( windowConfig ) ) return windowConfig;

	const storageConfig = readLegacyStorageConfig();
	if ( hasRealConfigValues( storageConfig ) ) return storageConfig;

	return null;

}

export function getMissingFirebaseConfigMessage() {

	return 'Set Firebase keys in js/firebase-config.js';

}

export function createHostCode() {

	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for ( let i = 0; i < 6; i ++ ) {

		code += alphabet[ Math.floor( Math.random() * alphabet.length ) ];

	}
	return code;

}

export function canJoinMap( hostMapId, joinerMapId ) {

	return Boolean( hostMapId && joinerMapId && hostMapId === joinerMapId );

}

export function isRemoteCarGhost() {

	return true;

}
