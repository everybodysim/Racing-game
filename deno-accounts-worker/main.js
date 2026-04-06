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
 * Leaderboard endpoints:
 *   POST /api/leaderboard/submit      — submit a lap time (requires auth token)
 *   GET  /api/leaderboard/:trackId    — get top times for a track
 *
 * Storage: Deno KV (built-in, no config needed on Deno Deploy).
 *   Key ["user", username]      → { passwordHash, createdAt }
 *   Key ["profile", username]   → profile JSON blob (same format as Export Profile)
 *   Key ["token", tokenHex]     → { username, createdAt }   (auto-expires after 90 days)
 *   Key ["lb", trackId]         → { trackName, times: [ { username, lapTime, submittedAt } ] }
 */

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days in milliseconds
const USERNAME_RE = /^[a-zA-Z0-9_\-]{3,24}$/;
const MAX_PROFILE_BYTES = 64 * 1024; // 64 KB
const MAX_LEADERBOARD_ENTRIES = 50;
const MIN_LAP_TIME = 3; // reject impossibly fast times

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

	if ( url.pathname === '/api/leaderboard/submit' && request.method === 'POST' ) {

		return withCors( await handleLeaderboardSubmit( request ) );

	}

	const lbMatch = url.pathname.match( /^\/api\/leaderboard\/([a-f0-9]{1,64})$/ );
	if ( lbMatch && request.method === 'GET' ) {

		return withCors( await handleLeaderboardGet( lbMatch[ 1 ] ) );

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
// Leaderboard handlers
// ---------------------------------------------------------------------------

async function handleLeaderboardSubmit( request ) {

	const auth = await authenticate( request );
	if ( ! auth ) return json( { ok: false, error: 'Session expired — please re-login to verify' }, 401 );

	const body = await parseBody( request );
	if ( ! body ) return json( { ok: false, error: 'Invalid JSON body' }, 400 );

	const trackId = typeof body.trackId === 'string' ? body.trackId.trim() : '';
	const lapTime = Number( body.lapTime );
	const trackName = typeof body.trackName === 'string' ? body.trackName.trim().slice( 0, 64 ) : 'Unknown Track';

	if ( ! trackId || ! /^[a-f0-9]{1,64}$/.test( trackId ) ) return json( { ok: false, error: 'Invalid trackId' }, 400 );
	if ( ! Number.isFinite( lapTime ) || lapTime < MIN_LAP_TIME ) return json( { ok: false, error: 'Invalid lap time' }, 400 );
	if ( lapTime > 3600 ) return json( { ok: false, error: 'Lap time too large' }, 400 );

	const entry = await kv.get( [ 'lb', trackId ] );
	const board = entry.value || { trackName, times: [] };

	// Update track name if provided
	if ( trackName && trackName !== 'Unknown Track' ) board.trackName = trackName;

	// Check if user already has an entry — only keep their best
	const existingIndex = board.times.findIndex( ( t ) => t.username === auth.username );
	if ( existingIndex !== - 1 ) {

		if ( board.times[ existingIndex ].lapTime <= lapTime ) {

			// Existing time is better or equal, return current rank
			const rank = existingIndex + 1;
			return json( { ok: true, rank, totalEntries: board.times.length, personalBest: board.times[ existingIndex ].lapTime, message: 'Your existing time is faster' } );

		}

		// Remove old entry so we can insert the new better one
		board.times.splice( existingIndex, 1 );

	}

	// Insert in sorted position (ascending by lapTime)
	const newEntry = { username: auth.username, lapTime, submittedAt: Date.now() };
	let insertIndex = board.times.findIndex( ( t ) => t.lapTime > lapTime );
	if ( insertIndex === - 1 ) insertIndex = board.times.length;
	board.times.splice( insertIndex, 0, newEntry );

	// Trim to max entries
	if ( board.times.length > MAX_LEADERBOARD_ENTRIES ) board.times.length = MAX_LEADERBOARD_ENTRIES;

	await kv.set( [ 'lb', trackId ], board );

	const rank = insertIndex + 1;
	return json( { ok: true, rank, totalEntries: board.times.length, personalBest: lapTime } );

}

async function handleLeaderboardGet( trackId ) {

	const entry = await kv.get( [ 'lb', trackId ] );
	const board = entry.value || { trackName: 'Unknown Track', times: [] };
	return json( { ok: true, trackId, trackName: board.trackName, times: board.times } );

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
