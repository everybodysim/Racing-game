const USER_KEY_PREFIX = 'user:';
const SESSION_KEY_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_USERNAME_LENGTH = 24;
const MAX_PROFILE_BYTES = 12000;

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
		},
		campaign: profile?.campaign && typeof profile.campaign === 'object' ? profile.campaign : null,
		carKey: typeof profile?.carKey === 'string' ? profile.carKey : '',
	};
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
