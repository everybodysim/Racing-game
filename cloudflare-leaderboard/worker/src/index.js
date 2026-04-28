const BOARD_KEY_PREFIX = 'leaderboard:';
const MAX_ROWS_PER_TRACK = 25;
const MIN_TIME_SECONDS = 1;
const MAX_TIME_SECONDS = 3600;
const MAX_GHOST_SAMPLES = 2500;
const USER_KEY_PREFIX = 'user:';
const MAX_NOTIFICATIONS_PER_USER = 120;

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
	const ghost = sanitizeGhostPayload( payload?.ghost );

	if ( ! trackId ) return json( { ok: false, error: 'trackId is required' }, 400 );
	if ( ! playerName ) return json( { ok: false, error: 'name is required' }, 400 );
	if ( ! Number.isFinite( timeSeconds ) || timeSeconds < MIN_TIME_SECONDS || timeSeconds > MAX_TIME_SECONDS ) {
		return json( { ok: false, error: 'timeSeconds must be a reasonable number' }, 400 );
	}

	const entries = await loadTrackEntries( env, trackId );
	const previousBest = entries.length > 0 ? entries[ 0 ] : null;
	entries.push( {
		name: playerName,
		timeSeconds: roundTime( timeSeconds ),
		trackName,
		ghost,
		createdAt: Date.now(),
	} );

	const trimmed = dedupeAndSortEntries( entries ).slice( 0, MAX_ROWS_PER_TRACK );
	await env.LEADERBOARD_KV.put( keyForTrack( trackId ), JSON.stringify( trimmed ) );
	const nextBest = trimmed.length > 0 ? trimmed[ 0 ] : null;
	await maybeNotifyBeatenRecordHolder( env, previousBest, nextBest, trackId, trackName );
	return json( { ok: true, entries: trimmed } );
}

async function maybeNotifyBeatenRecordHolder( env, previousBest, nextBest, trackId, trackName ) {
	if ( ! previousBest || ! nextBest ) return;
	const prevKey = normalizeNameKey( previousBest.name );
	const nextKey = normalizeNameKey( nextBest.name );
	if ( ! prevKey || ! nextKey || prevKey === nextKey ) return;
	if ( ! env.ACCOUNTS_KV ) return;
	const userRecord = await env.ACCOUNTS_KV.get( `${ USER_KEY_PREFIX }${ prevKey }`, 'json' );
	if ( ! userRecord || typeof userRecord !== 'object' ) return;
	const notifications = sanitizeNotificationState( userRecord.notifications );
	if ( notifications.settings.recordBeaten === false ) return;
	const now = Date.now();
	notifications.items.unshift( {
		id: `${ now }-${ Math.random().toString( 36 ).slice( 2, 10 ) }`,
		type: 'record_beaten',
		message: `Your record on ${ trackName || 'a track' } was beaten by ${ nextBest.name } (${ nextBest.timeSeconds.toFixed( 3 ) }s).`,
		createdAt: now,
		readAt: null,
		metadata: {
			trackId,
			trackName: trackName || '',
			previousHolder: previousBest.name,
			newHolder: nextBest.name,
			newTimeSeconds: nextBest.timeSeconds,
		},
	} );
	if ( notifications.items.length > MAX_NOTIFICATIONS_PER_USER ) notifications.items.length = MAX_NOTIFICATIONS_PER_USER;
	userRecord.notifications = notifications;
	userRecord.updatedAt = now;
	await env.ACCOUNTS_KV.put( `${ USER_KEY_PREFIX }${ prevKey }`, JSON.stringify( userRecord ) );
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
		const valid = parsed.filter( ( entry ) => {
			return typeof entry?.name === 'string' && Number.isFinite( Number( entry?.timeSeconds ) );
		} );
		return dedupeAndSortEntries( valid );
	} catch {
		return [];
	}
}

function dedupeAndSortEntries( entries ) {
	const bestByName = new Map();
	for ( const entry of entries ) {
		const key = normalizeNameKey( entry?.name );
		if ( ! key ) continue;
		const timeSeconds = Number( entry.timeSeconds );
		if ( ! Number.isFinite( timeSeconds ) ) continue;
		const normalized = {
			name: sanitizePlayerName( entry.name ) || 'Anonymous',
			timeSeconds: roundTime( timeSeconds ),
			trackName: sanitizeTrackName( entry.trackName ),
			ghost: sanitizeGhostPayload( entry.ghost ),
			createdAt: Number.isFinite( Number( entry.createdAt ) ) ? Number( entry.createdAt ) : Date.now(),
		};
		const existing = bestByName.get( key );
		if ( ! existing || normalized.timeSeconds < existing.timeSeconds || ( normalized.timeSeconds === existing.timeSeconds && normalized.createdAt < existing.createdAt ) ) {
			bestByName.set( key, normalized );
		}
	}
	return [ ...bestByName.values() ].sort( ( a, b ) => {
		if ( a.timeSeconds !== b.timeSeconds ) return a.timeSeconds - b.timeSeconds;
		return a.createdAt - b.createdAt;
	} );
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

function normalizeNameKey( value ) {
	return sanitizePlayerName( value ).toLowerCase();
}

function roundTime( value ) {
	return Math.round( value * 1000 ) / 1000;
}

function sanitizeNotificationState( value ) {
	const source = value && typeof value === 'object' ? value : {};
	const settingsSource = source.settings && typeof source.settings === 'object' ? source.settings : {};
	const settings = {
		recordBeaten: settingsSource.recordBeaten !== false,
		totdUpdates: settingsSource.totdUpdates !== false,
		cotwUpdates: settingsSource.cotwUpdates !== false,
	};
	const rawItems = Array.isArray( source.items ) ? source.items : [];
	const items = rawItems
		.map( ( item ) => sanitizeNotificationItem( item ) )
		.filter( Boolean )
		.slice( 0, MAX_NOTIFICATIONS_PER_USER );
	return { settings, items };
}

function sanitizeNotificationItem( item ) {
	if ( ! item || typeof item !== 'object' ) return null;
	const id = String( item.id || '' ).trim().slice( 0, 80 );
	const type = String( item.type || 'info' ).trim().slice( 0, 40 );
	const message = String( item.message || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 240 );
	const createdAt = Number( item.createdAt );
	if ( ! id || ! message || ! Number.isFinite( createdAt ) ) return null;
	const readAt = Number( item.readAt );
	return {
		id,
		type,
		message,
		createdAt,
		readAt: Number.isFinite( readAt ) ? readAt : null,
		metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : null,
	};
}

function sanitizeGhostPayload( payload ) {
	if ( ! payload || typeof payload !== 'object' ) return null;
	const car = typeof payload.car === 'string' ? payload.car.trim().slice( 0, 40 ) : '';
	const duration = Number( payload.duration );
	if ( ! car || ! Number.isFinite( duration ) || duration <= 0 || duration > MAX_TIME_SECONDS ) return null;
	const sourceSamples = Array.isArray( payload.samples ) ? payload.samples.slice( 0, MAX_GHOST_SAMPLES ) : [];
	const samples = [];
	for ( const sample of sourceSamples ) {
		const t = Number( sample?.t );
		const x = Number( sample?.x );
		const y = Number( sample?.y );
		const z = Number( sample?.z );
		const yaw = Number( sample?.yaw );
		if ( ! Number.isFinite( t ) || ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) || ! Number.isFinite( yaw ) ) continue;
		samples.push( {
			t: roundTime( t ),
			x: roundTime( x ),
			y: roundTime( y ),
			z: roundTime( z ),
			yaw: roundTime( yaw ),
		} );
	}
	if ( samples.length < 2 ) return null;
	const cosmetics = sanitizeGhostCosmetics( payload.cosmetics );
	return {
		car,
		bestLapSeconds: Number.isFinite( Number( payload.bestLapSeconds ) ) ? roundTime( Number( payload.bestLapSeconds ) ) : undefined,
		duration: roundTime( duration ),
		samples,
		cosmetics,
	};
}

function sanitizeGhostCosmetics( payload ) {
	if ( ! payload || typeof payload !== 'object' ) return null;
	const sourceMappings = Array.isArray( payload.mappings ) ? payload.mappings.slice( 0, 48 ) : [];
	const mappings = [];
	for ( const entry of sourceMappings ) {
		const sourceHex = typeof entry?.sourceHex === 'string' ? entry.sourceHex.trim() : '';
		const targetHex = typeof entry?.targetHex === 'string' ? entry.targetHex.trim() : '';
		if ( ! /^#[0-9a-fA-F]{6}$/.test( sourceHex ) || ! /^#[0-9a-fA-F]{6}$/.test( targetHex ) ) continue;
		const tolerance = Number( entry?.tolerance );
		mappings.push( {
			sourceHex: sourceHex.toLowerCase(),
			targetHex: targetHex.toLowerCase(),
			tolerance: Number.isFinite( tolerance ) ? Math.max( 8, Math.min( 180, Math.round( tolerance ) ) ) : 40,
			finish: entry?.finish === 'shiny' ? 'shiny' : 'matte',
		} );
	}
	return mappings.length > 0 ? { mappings } : null;
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
