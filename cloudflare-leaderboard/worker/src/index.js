const BOARD_KEY_PREFIX = 'leaderboard:';
const MAX_ROWS_PER_TRACK = 25;
const MIN_TIME_SECONDS = 1;
const MAX_TIME_SECONDS = 3600;

export default {
	async fetch( request, env ) {
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );
		const url = new URL( request.url );

		if ( url.pathname === '/api/leaderboard' && request.method === 'GET' ) {
			return withCors( await getLeaderboard( url, env ) );
		}

		if ( url.pathname === '/api/leaderboard' && request.method === 'POST' ) {
			return withCors( await postLeaderboardTime( request, env ) );
		}

		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

async function getLeaderboard( url, env ) {
	const trackId = sanitizeTrackId( url.searchParams.get( 'trackId' ) || '' );
	if ( ! trackId ) return json( { ok: false, error: 'trackId is required' }, 400 );
	const entries = await loadTrackEntries( env, trackId );
	return json( { ok: true, trackId, entries } );
}

async function postLeaderboardTime( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}

	const trackId = sanitizeTrackId( payload?.trackId );
	const trackName = sanitizeTrackName( payload?.trackName );
	const playerName = sanitizePlayerName( payload?.name );
	const timeSeconds = Number( payload?.timeSeconds );

	if ( ! trackId ) return json( { ok: false, error: 'trackId is required' }, 400 );
	if ( ! playerName ) return json( { ok: false, error: 'name is required' }, 400 );
	if ( ! Number.isFinite( timeSeconds ) || timeSeconds < MIN_TIME_SECONDS || timeSeconds > MAX_TIME_SECONDS ) {
		return json( { ok: false, error: 'timeSeconds must be a reasonable number' }, 400 );
	}

	const entries = await loadTrackEntries( env, trackId );
	entries.push( {
		name: playerName,
		timeSeconds: roundTime( timeSeconds ),
		trackName,
		createdAt: Date.now(),
	} );

	entries.sort( ( a, b ) => {
		if ( a.timeSeconds !== b.timeSeconds ) return a.timeSeconds - b.timeSeconds;
		return a.createdAt - b.createdAt;
	} );

	const trimmed = entries.slice( 0, MAX_ROWS_PER_TRACK );
	await env.LEADERBOARD_KV.put( keyForTrack( trackId ), JSON.stringify( trimmed ) );
	return json( { ok: true, entries: trimmed } );
}

function keyForTrack( trackId ) {
	return `${ BOARD_KEY_PREFIX }${ trackId }`;
}

async function loadTrackEntries( env, trackId ) {
	const raw = await env.LEADERBOARD_KV.get( keyForTrack( trackId ) );
	if ( ! raw ) return [];
	try {
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) return [];
		return parsed.filter( ( entry ) => {
			return typeof entry?.name === 'string' && Number.isFinite( Number( entry?.timeSeconds ) );
		} );
	} catch {
		return [];
	}
}

function sanitizeTrackId( value ) {
	const cleaned = String( value || '' ).trim();
	if ( ! cleaned ) return '';
	return cleaned.replace( /[^a-zA-Z0-9_-]/g, '' ).slice( 0, 120 );
}

function sanitizeTrackName( value ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 80 ) || 'Unknown Track';
}

function sanitizePlayerName( value ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 24 );
}

function roundTime( value ) {
	return Math.round( value * 1000 ) / 1000;
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
