/**
 * Racing Game — Accounts Worker (Deno Deploy + Deno KV)
 *
 * Endpoints:
 *   POST /api/accounts/signup   — create a new account
 *   POST /api/accounts/login    — authenticate and return profile
 *   POST /api/accounts/save     — save profile data (requires auth token)
 *   GET  /api/accounts/profile   — load profile data (requires auth token)
 *   POST /api/accounts/delete   — delete account (requires auth token)
 *
 * Storage: Deno KV (built-in, no config needed on Deno Deploy).
 *   Key ["user", username]      → { passwordHash, createdAt }
 *   Key ["profile", username]   → profile JSON blob (same format as Export Profile)
 *   Key ["token", tokenHex]     → { username, createdAt }   (auto-expires after 90 days)
 */

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days in milliseconds
const USERNAME_RE = /^[a-zA-Z0-9_\-]{3,24}$/;
const MAX_PROFILE_BYTES = 64 * 1024; // 64 KB

const kv = await Deno.openKv();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

Deno.serve( async ( request ) => {

	const url = new URL( request.url );
	if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );

	if ( url.pathname === '/api/accounts/signup' && request.method === 'POST' ) {

		return withCors( await handleSignup( request ) );

	}

	if ( url.pathname === '/api/accounts/login' && request.method === 'POST' ) {

		return withCors( await handleLogin( request ) );

	}

	if ( url.pathname === '/api/accounts/save' && request.method === 'POST' ) {

		return withCors( await handleSave( request ) );

	}

	if ( url.pathname === '/api/accounts/profile' && request.method === 'GET' ) {

		return withCors( await handleLoadProfile( request ) );

	}

	if ( url.pathname === '/api/accounts/delete' && request.method === 'POST' ) {

		return withCors( await handleDelete( request ) );

	}

	return withCors( json( { ok: false, error: 'Not found' }, 404 ) );

} );

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSignup( request ) {

	const body = await parseBody( request );
	if ( ! body ) return json( { ok: false, error: 'Invalid JSON body' }, 400 );

	const username = normalizeUsername( body.username );
	const password = body.password || '';

	if ( ! username ) return json( { ok: false, error: 'Username must be 3-24 chars (letters, digits, _ or -)' }, 400 );
	if ( password.length < 4 ) return json( { ok: false, error: 'Password must be at least 4 characters' }, 400 );
	if ( password.length > 128 ) return json( { ok: false, error: 'Password must be 128 characters or fewer' }, 400 );

	const existing = await kv.get( [ 'user', username ] );
	if ( existing.value ) return json( { ok: false, error: 'Username is already taken' }, 409 );

	const passwordHash = await hashPassword( password );
	await kv.set( [ 'user', username ], { passwordHash, createdAt: Date.now() } );

	const token = await createToken( username );
	return json( { ok: true, token, username } );

}

async function handleLogin( request ) {

	const body = await parseBody( request );
	if ( ! body ) return json( { ok: false, error: 'Invalid JSON body' }, 400 );

	const username = normalizeUsername( body.username );
	const password = body.password || '';

	if ( ! username || ! password ) return json( { ok: false, error: 'Username and password are required' }, 400 );

	const entry = await kv.get( [ 'user', username ] );
	if ( ! entry.value ) return json( { ok: false, error: 'Invalid username or password' }, 401 );

	const valid = await verifyPassword( password, entry.value.passwordHash );
	if ( ! valid ) return json( { ok: false, error: 'Invalid username or password' }, 401 );

	const token = await createToken( username );

	// Return saved profile if it exists
	const profileEntry = await kv.get( [ 'profile', username ] );
	const profile = profileEntry.value || null;

	return json( { ok: true, token, username, profile } );

}

async function handleSave( request ) {

	const auth = await authenticate( request );
	if ( ! auth ) return json( { ok: false, error: 'Unauthorized — please log in again' }, 401 );

	const body = await parseBody( request );
	if ( ! body || ! body.profile ) return json( { ok: false, error: 'Missing profile data' }, 400 );

	const profileStr = JSON.stringify( body.profile );
	if ( profileStr.length > MAX_PROFILE_BYTES ) return json( { ok: false, error: 'Profile data too large' }, 400 );

	await kv.set( [ 'profile', auth.username ], body.profile );
	return json( { ok: true } );

}

async function handleLoadProfile( request ) {

	const auth = await authenticate( request );
	if ( ! auth ) return json( { ok: false, error: 'Unauthorized — please log in again' }, 401 );

	const profileEntry = await kv.get( [ 'profile', auth.username ] );
	const profile = profileEntry.value || null;
	return json( { ok: true, username: auth.username, profile } );

}

async function handleDelete( request ) {

	const auth = await authenticate( request );
	if ( ! auth ) return json( { ok: false, error: 'Unauthorized — please log in again' }, 401 );

	await kv.delete( [ 'user', auth.username ] );
	await kv.delete( [ 'profile', auth.username ] );
	await kv.delete( [ 'token', auth.tokenKey ] );
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

async function createToken( username ) {

	const bytes = new Uint8Array( 32 );
	crypto.getRandomValues( bytes );
	const tokenHex = bufToHex( bytes.buffer );
	await kv.set(
		[ 'token', tokenHex ],
		{ username, createdAt: Date.now() },
		{ expireIn: TOKEN_TTL_MS }
	);
	return tokenHex;

}

async function authenticate( request ) {

	const header = request.headers.get( 'Authorization' ) || '';
	const token = header.startsWith( 'Bearer ' ) ? header.slice( 7 ).trim() : '';
	if ( ! token ) return null;

	const entry = await kv.get( [ 'token', token ] );
	if ( ! entry.value ) return null;

	return { username: entry.value.username, tokenKey: token };

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
