const USER_KEY_PREFIX = 'user:';
const SESSION_KEY_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_USERNAME_LENGTH = 24;
const MAX_PROFILE_BYTES = 12000;
const MAX_COIN_LEADERBOARD_SCAN = 5000;

export default {
	async fetch( request, env ) {
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );
		const url = new URL( request.url );

		if ( url.pathname === '/api/accounts/signup' && request.method === 'POST' ) {
			return withCors( await signup( request, env ) );
		}
		if ( url.pathname === '/api/accounts/login' && request.method === 'POST' ) {
			return withCors( await login( request, env ) );
		}
		if ( url.pathname === '/api/accounts/profile' && request.method === 'GET' ) {
			return withCors( await getProfile( url, env ) );
		}
		if ( url.pathname === '/api/accounts/profile' && request.method === 'POST' ) {
			return withCors( await saveProfile( request, env ) );
		}
		if ( url.pathname === '/api/accounts/coins-leaderboard' && request.method === 'GET' ) {
			return withCors( await getCoinsLeaderboard( url, env ) );
		}

		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

async function signup( request, env ) {
	const payload = await parseJsonBody( request );
	if ( ! payload.ok ) return payload.response;
	const username = sanitizeUsername( payload.value?.username );
	const password = sanitizePassword( payload.value?.password );
	if ( ! username ) return json( { ok: false, error: 'username is required (3-24 chars)' }, 400 );
	if ( ! password ) return json( { ok: false, error: 'password is required (6-80 chars)' }, 400 );

	const usernameKey = normalizeUsernameKey( username );
	const existing = await env.ACCOUNTS_KV.get( keyForUser( usernameKey ), 'json' );
	if ( existing ) return json( { ok: false, error: 'Username already exists' }, 409 );

	const salt = crypto.randomUUID();
	const passwordHash = await hashPassword( password, salt );
	const profile = sanitizeProfile( payload.value?.profile );

	const userRecord = {
		username,
		usernameKey,
		passwordHash,
		salt,
		createdAt: Date.now(),
		profile,
	};
	await env.ACCOUNTS_KV.put( keyForUser( usernameKey ), JSON.stringify( userRecord ) );
	const token = await createSession( env, usernameKey );
	return json( { ok: true, username, token, profile } );
}

async function login( request, env ) {
	const payload = await parseJsonBody( request );
	if ( ! payload.ok ) return payload.response;
	const username = sanitizeUsername( payload.value?.username );
	const password = sanitizePassword( payload.value?.password );
	if ( ! username || ! password ) return json( { ok: false, error: 'username and password are required' }, 400 );
	const usernameKey = normalizeUsernameKey( username );
	const userRecord = await env.ACCOUNTS_KV.get( keyForUser( usernameKey ), 'json' );
	if ( ! userRecord ) return json( { ok: false, error: 'Invalid username or password' }, 401 );
	const incomingHash = await hashPassword( password, userRecord.salt );
	if ( incomingHash !== userRecord.passwordHash ) return json( { ok: false, error: 'Invalid username or password' }, 401 );
	const token = await createSession( env, usernameKey );
	return json( { ok: true, username: userRecord.username, token, profile: sanitizeProfile( userRecord.profile ) } );
}

async function getProfile( url, env ) {
	const token = String( url.searchParams.get( 'token' ) || '' ).trim();
	if ( ! token ) return json( { ok: false, error: 'token is required' }, 400 );
	const session = await loadSession( env, token );
	if ( ! session ) return json( { ok: false, error: 'Invalid or expired token' }, 401 );
	const userRecord = await env.ACCOUNTS_KV.get( keyForUser( session.usernameKey ), 'json' );
	if ( ! userRecord ) return json( { ok: false, error: 'Account not found' }, 404 );
	return json( { ok: true, username: userRecord.username, profile: sanitizeProfile( userRecord.profile ) } );
}

async function saveProfile( request, env ) {
	const payload = await parseJsonBody( request );
	if ( ! payload.ok ) return payload.response;
	const token = String( payload.value?.token || '' ).trim();
	if ( ! token ) return json( { ok: false, error: 'token is required' }, 400 );
	const session = await loadSession( env, token );
	if ( ! session ) return json( { ok: false, error: 'Invalid or expired token' }, 401 );
	const userRecord = await env.ACCOUNTS_KV.get( keyForUser( session.usernameKey ), 'json' );
	if ( ! userRecord ) return json( { ok: false, error: 'Account not found' }, 404 );
	const profile = sanitizeProfile( payload.value?.profile );
	if ( byteLength( JSON.stringify( profile ) ) > MAX_PROFILE_BYTES ) {
		return json( { ok: false, error: 'profile payload is too large' }, 400 );
	}
	userRecord.profile = profile;
	userRecord.updatedAt = Date.now();
	await env.ACCOUNTS_KV.put( keyForUser( session.usernameKey ), JSON.stringify( userRecord ) );
	return json( { ok: true, username: userRecord.username, profile } );
}

async function getCoinsLeaderboard( url, env ) {
	const limit = Math.max( 1, Math.min( 100, Math.floor( Number( url.searchParams.get( 'limit' ) || 25 ) ) ) );
	let cursor = undefined;
	let scanned = 0;
	const entries = [];
	while ( scanned < MAX_COIN_LEADERBOARD_SCAN ) {
		const batch = await env.ACCOUNTS_KV.list( { prefix: USER_KEY_PREFIX, cursor, limit: 100 } );
		const keys = Array.isArray( batch?.keys ) ? batch.keys : [];
		if ( keys.length === 0 ) break;
		const userRecords = await Promise.all( keys.map( ( key ) => env.ACCOUNTS_KV.get( key.name, 'json' ) ) );
		for ( const user of userRecords ) {
			scanned ++;
			if ( ! user || typeof user !== 'object' ) continue;
			const coins = Math.max( 0, Math.floor( Number( user?.profile?.economy?.coins ) || 0 ) );
			const username = sanitizePlayerName( user?.username || '' );
			const playerName = sanitizePlayerName( user?.profile?.playerName || '' ) || username;
			entries.push( {
				username,
				playerName,
				coins,
			} );
			if ( scanned >= MAX_COIN_LEADERBOARD_SCAN ) break;
		}
		if ( ! batch?.list_complete ) {
			cursor = batch?.cursor;
			if ( ! cursor ) break;
		} else {
			break;
		}
	}
	entries.sort( ( a, b ) => b.coins - a.coins || a.playerName.localeCompare( b.playerName ) );
	return json( {
		ok: true,
		entries: entries.slice( 0, limit ),
		scanned,
	} );
}

function keyForUser( usernameKey ) {
	return `${ USER_KEY_PREFIX }${ usernameKey }`;
}

function keyForSession( token ) {
	return `${ SESSION_KEY_PREFIX }${ token }`;
}

async function createSession( env, usernameKey ) {
	const token = crypto.randomUUID().replace( /-/g, '' ) + crypto.randomUUID().replace( /-/g, '' );
	await env.ACCOUNTS_KV.put( keyForSession( token ), JSON.stringify( {
		usernameKey,
		createdAt: Date.now(),
	} ), { expirationTtl: SESSION_TTL_SECONDS } );
	return token;
}

async function loadSession( env, token ) {
	return env.ACCOUNTS_KV.get( keyForSession( token ), 'json' );
}

function sanitizeUsername( value ) {
	const cleaned = String( value || '' ).replace( /\s+/g, ' ' ).trim();
	if ( cleaned.length < 3 || cleaned.length > MAX_USERNAME_LENGTH ) return '';
	if ( ! /^[a-zA-Z0-9_\-.]+$/.test( cleaned ) ) return '';
	return cleaned;
}

function normalizeUsernameKey( value ) {
	return String( value || '' ).toLowerCase();
}

function sanitizePassword( value ) {
	const str = String( value || '' );
	if ( str.length < 6 || str.length > 80 ) return '';
	return str;
}

function sanitizeProfile( value ) {
	const profile = value && typeof value === 'object' ? value : {};
	const name = sanitizePlayerName( profile?.playerName );
	const cosmetics = sanitizeGarageCosmetics( profile?.garage?.cosmetics );
	return {
		version: Number.isFinite( Number( profile?.version ) ) ? Number( profile.version ) : 2,
		playerName: name,
		economy: {
			coins: Math.max( 0, Math.floor( Number( profile?.economy?.coins ) || 0 ) ),
			engineTier: Math.max( 0, Math.floor( Number( profile?.economy?.engineTier ) || 0 ) ),
		},
		garage: {
			mods: {
				grip: Number( profile?.garage?.mods?.grip ) || 1,
				accel: Number( profile?.garage?.mods?.accel ) || 1,
				drive: Number( profile?.garage?.mods?.drive ) || 1,
			},
			unlocked: {
				grip: Boolean( profile?.garage?.unlocked?.grip ),
				accel: Boolean( profile?.garage?.unlocked?.accel ),
				drive: Boolean( profile?.garage?.unlocked?.drive ),
			},
			cosmetics,
		},
		campaign: profile?.campaign && typeof profile.campaign === 'object' ? profile.campaign : null,
		carKey: typeof profile?.carKey === 'string' ? profile.carKey : '',
		hud: sanitizeHudLayout( profile?.hud ),
		settings: sanitizeSettings( profile?.settings ),
	};
}

// Game settings slice (mirrors js/GameSettings.js normalizeSettings). Persisted
// verbatim once validated so the player's graphics/audio/gameplay/controls/
// accessibility preferences round-trip to the cloud account. Every field is
// optional; null means "follow the preset/default" (see GameSettings defaults).
function sanitizeSettings( value ) {
	const s = value && typeof value === 'object' ? value : {};
	const g = s.graphics && typeof s.graphics === 'object' ? s.graphics : {};
	const a = s.audio && typeof s.audio === 'object' ? s.audio : {};
	const gp = s.gameplay && typeof s.gameplay === 'object' ? s.gameplay : {};
	const c = s.controls && typeof s.controls === 'object' ? s.controls : {};
	const ac = s.accessibility && typeof s.accessibility === 'object' ? s.accessibility : {};
	const clamp = ( v, min, max, fb ) => {
		const n = Number( v );
		if ( ! Number.isFinite( n ) ) return fb;
		return Math.max( min, Math.min( max, n ) );
	};
	const maybeClamp = ( v, min, max ) => ( v == null ? null : clamp( v, min, max, null ) );
	const pick = ( v, allowed, fb ) => ( allowed.indexOf( v ) >= 0 ? v : fb );
	return {
		v: Number.isFinite( Number( s.v ) ) ? Number( s.v ) : 1,
		graphics: {
			preset: pick( g.preset, [ 'low', 'medium', 'high' ], 'high' ),
			maxPixelRatio: maybeClamp( g.maxPixelRatio, 0.5, 2 ),
			shadows: g.shadows == null ? null : Boolean( g.shadows ),
			shadowMapSize: g.shadowMapSize == null ? null : Math.round( clamp( g.shadowMapSize, 256, 8192, 2048 ) ),
			bloomStrength: maybeClamp( g.bloomStrength, 0, 0.1 ),
			bloomRadius: maybeClamp( g.bloomRadius, 0, 0.2 ),
			smokeParticles: g.smokeParticles == null ? null : Math.round( clamp( g.smokeParticles, 0, 128, 64 ) ),
			antialias: g.antialias == null ? true : Boolean( g.antialias ),
			reduceMotion: Boolean( g.reduceMotion ),
		},
		audio: {
			sfxVolume: clamp( a.sfxVolume, 0, 1, 1 ),
			musicVolume: clamp( a.musicVolume, 0, 1, 1 ),
			musicMode: Math.round( clamp( a.musicMode, 0, 3, 0 ) ),
		},
		gameplay: {
			showFps: Boolean( gp.showFps ),
			countdownEnabled: gp.countdownEnabled == null ? null : Boolean( gp.countdownEnabled ),
			recentGhostsEnabled: Boolean( gp.recentGhostsEnabled ),
			recentGhostCount: Math.round( clamp( gp.recentGhostCount, 1, 20, 3 ) ),
			cameraDistance: maybeClamp( gp.cameraDistance, 2, 30 ),
			cameraHeight: maybeClamp( gp.cameraHeight, 0, 20 ),
			cameraLag: clamp( gp.cameraLag, 0.1, 1, 1 ),
			autoRespawn: Boolean( gp.autoRespawn ),
		},
		controls: {
			invertSteer: Boolean( c.invertSteer ),
			keyboardOnly: Boolean( c.keyboardOnly ),
			steerSmoothing: clamp( c.steerSmoothing, 0.2, 1, 1 ),
		},
		accessibility: {
			highContrastHud: Boolean( ac.highContrastHud ),
			largeHud: Boolean( ac.largeHud ),
			screenShake: ac.screenShake == null ? true : Boolean( ac.screenShake ),
			colorblindFilter: pick( ac.colorblindFilter, [ 'off', 'protan', 'deutan', 'tritan' ], 'off' ),
		},
	};
}

// HUD layout = array of rows of widget type strings (see js/HudGrid.js).
// Persist it verbatim once validated so the player's HUD customizations round-trip
// to the cloud account instead of being silently dropped on save.
function sanitizeHudLayout( value ) {
	if ( ! Array.isArray( value ) ) return undefined;
	const MAX_ROWS = 8;
	const MAX_PER_ROW = 8;
	const MAX_TYPE_LEN = 32;
	const rows = value.slice( 0, MAX_ROWS ).map( ( row ) => {
		if ( ! Array.isArray( row ) ) return [];
		return row.slice( 0, MAX_PER_ROW ).filter( ( t ) => {
			return typeof t === 'string' && t.length > 0 && t.length <= MAX_TYPE_LEN;
		} );
	} );
	return rows;
}

function sanitizeGarageCosmetics( value ) {
	const source = value && typeof value === 'object' ? value : {};
	const unlockedPaints = {};
	if ( source?.unlockedPaints && typeof source.unlockedPaints === 'object' ) {
		for ( const [ paintId, unlocked ] of Object.entries( source.unlockedPaints ) ) {
			if ( typeof paintId === 'string' && paintId.length <= 32 && unlocked ) unlockedPaints[ paintId ] = true;
		}
	}
	const cars = {};
	if ( source?.cars && typeof source.cars === 'object' ) {
		for ( const [ carKey, entry ] of Object.entries( source.cars ) ) {
			if ( typeof carKey !== 'string' || carKey.length > 64 ) continue;
			const mappings = Array.isArray( entry?.mappings ) ? entry.mappings : [];
			cars[ carKey ] = {
				mappings: mappings.slice( 0, 48 ).map( ( mapping ) => ( {
					sourceHex: typeof mapping?.sourceHex === 'string' ? mapping.sourceHex.slice( 0, 7 ) : '#ff0000',
					targetColorId: typeof mapping?.targetColorId === 'string' ? mapping.targetColorId.slice( 0, 32 ) : '',
					tolerance: Math.max( 8, Math.min( 180, Math.floor( Number( mapping?.tolerance ) || 40 ) ) ),
				} ) ),
			};
		}
	}
	return { unlockedPaints, cars };
}

function sanitizePlayerName( value ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 24 );
}

async function hashPassword( password, salt ) {
	const input = new TextEncoder().encode( `${ salt }:${ password }` );
	const digest = await crypto.subtle.digest( 'SHA-256', input );
	return hexFromBytes( new Uint8Array( digest ) );
}

function hexFromBytes( bytes ) {
	let out = '';
	for ( const b of bytes ) out += b.toString( 16 ).padStart( 2, '0' );
	return out;
}

async function parseJsonBody( request ) {
	try {
		const value = await request.json();
		return { ok: true, value };
	} catch {
		return { ok: false, response: json( { ok: false, error: 'Invalid JSON body' }, 400 ) };
	}
}

function byteLength( value ) {
	return new TextEncoder().encode( value ).length;
}

function withCors( response ) {
	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,POST,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type' );
	return new Response( response.body, { status: response.status, headers } );
}

function json( payload, status = 200 ) {
	return new Response( JSON.stringify( payload ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}
