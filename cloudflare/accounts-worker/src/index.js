/**
 * Racing Game — Accounts Worker
 *
 * Endpoints:
 *   POST /api/accounts/signup   — create a new account
 *   POST /api/accounts/login    — authenticate and return profile
 *   POST /api/accounts/save     — save profile data (requires auth token)
 *   GET  /api/accounts/profile   — load profile data (requires auth token)
 *   POST /api/accounts/delete   — delete account (requires auth token)
 *
 * Storage: Cloudflare KV via the ACCOUNTS_KV binding.
 *   Key "user:<username>"  → { passwordHash, createdAt }
 *   Key "profile:<username>" → profile JSON blob (the same format as Export Profile)
 *   Key "token:<tokenHex>"  → { username, createdAt }
 */

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const USERNAME_RE = /^[a-zA-Z0-9_\-]{3,24}$/;
const MAX_PROFILE_BYTES = 64 * 1024; // 64 KB

export default {
	async fetch( request, env ) {

		const url = new URL( request.url );
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );

		if ( url.pathname === '/api/accounts/signup' && request.method === 'POST' ) {

			return withCors( await handleSignup( request, env ) );

		}

		if ( url.pathname === '/api/accounts/login' && request.method === 'POST' ) {

			return withCors( await handleLogin( request, env ) );

		}

		if ( url.pathname === '/api/accounts/save' && request.method === 'POST' ) {

			return withCors( await handleSave( request, env ) );

		}

		if ( url.pathname === '/api/accounts/profile' && request.method === 'GET' ) {

			return withCors( await handleLoadProfile( request, env ) );

		}

		if ( url.pathname === '/api/accounts/delete' && request.method === 'POST' ) {

			return withCors( await handleDelete( request, env ) );

		}

		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );

	},
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSignup( request, env ) {

	const body = await parseBody( request );
	if ( ! body ) return json( { ok: false, error: 'Invalid JSON body' }, 400 );

	const username = normalizeUsername( body.username );
	const password = body.password || '';

	if ( ! username ) return json( { ok: false, error: 'Username must be 3-24 chars (letters, digits, _ or -)' }, 400 );
	if ( password.length < 4 ) return json( { ok: false, error: 'Password must be at least 4 characters' }, 400 );
	if ( password.length > 128 ) return json( { ok: false, error: 'Password must be 128 characters or fewer' }, 400 );

	const existing = await env.ACCOUNTS_KV.get( `user:${ username }` );
	if ( existing ) return json( { ok: false, error: 'Username is already taken' }, 409 );

	const passwordHash = await hashPassword( password );
	await env.ACCOUNTS_KV.put( `user:${ username }`, JSON.stringify( { passwordHash, createdAt: Date.now() } ) );

	const token = await createToken( env, username );
	return json( { ok: true, token, username } );

}

async function handleLogin( request, env ) {

	const body = await parseBody( request );
	if ( ! body ) return json( { ok: false, error: 'Invalid JSON body' }, 400 );

	const username = normalizeUsername( body.username );
	const password = body.password || '';

	if ( ! username || ! password ) return json( { ok: false, error: 'Username and password are required' }, 400 );

	const raw = await env.ACCOUNTS_KV.get( `user:${ username }` );
	if ( ! raw ) return json( { ok: false, error: 'Invalid username or password' }, 401 );

	const record = JSON.parse( raw );
	const valid = await verifyPassword( password, record.passwordHash );
	if ( ! valid ) return json( { ok: false, error: 'Invalid username or password' }, 401 );

	const token = await createToken( env, username );

	// Return saved profile if it exists
	const profileRaw = await env.ACCOUNTS_KV.get( `profile:${ username }` );
	const profile = profileRaw ? JSON.parse( profileRaw ) : null;

	return json( { ok: true, token, username, profile } );

}

async function handleSave( request, env ) {

	const auth = await authenticate( request, env );
	if ( ! auth ) return json( { ok: false, error: 'Unauthorized — please log in again' }, 401 );

	const body = await parseBody( request );
	if ( ! body || ! body.profile ) return json( { ok: false, error: 'Missing profile data' }, 400 );

	const profileStr = JSON.stringify( body.profile );
	if ( profileStr.length > MAX_PROFILE_BYTES ) return json( { ok: false, error: 'Profile data too large' }, 400 );

	await env.ACCOUNTS_KV.put( `profile:${ auth.username }`, profileStr );
	return json( { ok: true } );

}

async function handleLoadProfile( request, env ) {

	const auth = await authenticate( request, env );
	if ( ! auth ) return json( { ok: false, error: 'Unauthorized — please log in again' }, 401 );

	const profileRaw = await env.ACCOUNTS_KV.get( `profile:${ auth.username }` );
	const profile = profileRaw ? JSON.parse( profileRaw ) : null;
	return json( { ok: true, username: auth.username, profile } );

}

async function handleDelete( request, env ) {

	const auth = await authenticate( request, env );
	if ( ! auth ) return json( { ok: false, error: 'Unauthorized — please log in again' }, 401 );

	await env.ACCOUNTS_KV.delete( `user:${ auth.username }` );
	await env.ACCOUNTS_KV.delete( `profile:${ auth.username }` );
	await env.ACCOUNTS_KV.delete( `token:${ auth.tokenKey }` );
	return json( { ok: true } );

}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function hashPassword( password ) {

	const encoder = new TextEncoder();
	const data = encoder.encode( password );
	const hashBuffer = await crypto.subtle.digest( 'SHA-256', data );
	return bufToHex( hashBuffer );

}

async function verifyPassword( password, storedHash ) {

	const hash = await hashPassword( password );
	return hash === storedHash;

}

async function createToken( env, username ) {

	const bytes = new Uint8Array( 32 );
	crypto.getRandomValues( bytes );
	const tokenHex = bufToHex( bytes.buffer );
	await env.ACCOUNTS_KV.put(
		`token:${ tokenHex }`,
		JSON.stringify( { username, createdAt: Date.now() } ),
		{ expirationTtl: TOKEN_TTL_SECONDS }
	);
	return tokenHex;

}

async function authenticate( request, env ) {

	const header = request.headers.get( 'Authorization' ) || '';
	const token = header.startsWith( 'Bearer ' ) ? header.slice( 7 ).trim() : '';
	if ( ! token ) return null;

	const raw = await env.ACCOUNTS_KV.get( `token:${ token }` );
	if ( ! raw ) return null;

	const record = JSON.parse( raw );
	return { username: record.username, tokenKey: token };

}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizeUsername( value ) {

	if ( typeof value !== 'string' ) return null;
	const trimmed = value.trim().toLowerCase();
	return USERNAME_RE.test( trimmed ) ? trimmed : null;

}

function bufToHex( buffer ) {

	return [ ...new Uint8Array( buffer ) ].map( ( b ) => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );

}

async function parseBody( request ) {

	try {

		return await request.json();

	} catch {

		return null;

	}

}

function withCors( response ) {

	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,POST,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type,Authorization' );
	return new Response( response.body, { status: response.status, headers } );

}

function json( value, status = 200 ) {

	return new Response( JSON.stringify( value ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );

}
