const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

export default {
	async fetch( request, env ) {
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );
		const url = new URL( request.url );
		if ( url.pathname === '/api/season/current' && request.method === 'GET' ) {
			return withCors( json( buildSeasonPayload() ) );
		}
		if ( url.pathname === '/api/season/board' && request.method === 'GET' ) {
			return withCors( await getSeasonBoard( url, env ) );
		}
		if ( url.pathname === '/api/season/record' && request.method === 'POST' ) {
			return withCors( await postSeasonRecord( request, env ) );
		}
		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

function buildSeasonPayload() {
	const now = Date.now();
	const epoch = Date.UTC( 2026, 0, 5 ); // Monday epoch for season alignment
	const weekIndex = Math.max( 0, Math.floor( ( now - epoch ) / WEEK_MS ) );
	const seasonId = `S${ 1 + weekIndex }`;
	const seasonSeed = hash32( `racing-season:${ seasonId }` );
	const daySeed = hash32( `racing-day:${ Math.floor( now / DAY_MS ) }` );
	const rewardPool = 5000 + ( seasonSeed % 4000 );
	const trackSeeds = Array.from( { length: 12 }, ( _, index ) => {
		const seed = hash32( `racing-season-track:${ seasonId }:${ index + 1 }` );
		const pseudoDate = new Date( Date.UTC( 2026, 0, 1 + index ) ).toISOString().slice( 0, 10 );
		return {
			slot: index + 1,
			seed,
			label: `Season Track ${ index + 1 }`,
			totdDate: pseudoDate,
			playUrl: `totd.html?date=${ pseudoDate }&season=${ seasonId }&slot=${ index + 1 }`,
		};
	} );
	return {
		ok: true,
		seasonId,
		seasonSeed,
		daySeed,
		rewardPool,
		trackSeeds,
		notes: 'Use seasonSeed/daySeed to drive TOTD-style seasonal track generation and reward distribution.',
	};
}

async function getSeasonBoard( url, env ) {
	const seasonId = sanitizeSeasonId( url.searchParams.get( 'seasonId' ) || '' );
	if ( ! seasonId ) return json( { ok: false, error: 'seasonId is required' }, 400 );
	const rows = await loadSeasonRows( env, seasonId );
	return json( { ok: true, seasonId, entries: rows } );
}

async function postSeasonRecord( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const seasonId = sanitizeSeasonId( payload?.seasonId );
	const name = sanitizeName( payload?.name );
	const records = Math.max( 0, Math.floor( Number( payload?.records ) || 0 ) );
	if ( ! seasonId ) return json( { ok: false, error: 'seasonId is required' }, 400 );
	if ( ! name ) return json( { ok: false, error: 'name is required' }, 400 );
	const key = `season:records:${ seasonId }`;
	const rows = await loadSeasonRows( env, seasonId );
	const map = new Map( rows.map( ( row ) => [ row.name.toLowerCase(), row ] ) );
	const existing = map.get( name.toLowerCase() );
	map.set( name.toLowerCase(), {
		name,
		records: Math.max( records, Number( existing?.records ) || 0 ),
		updatedAt: Date.now(),
	} );
	const next = [ ...map.values() ].sort( ( a, b ) => b.records - a.records || a.updatedAt - b.updatedAt ).slice( 0, 200 );
	await env.SEASON_KV.put( key, JSON.stringify( next ) );
	return json( { ok: true, entries: next } );
}

async function loadSeasonRows( env, seasonId ) {
	const key = `season:records:${ seasonId }`;
	const raw = await env.SEASON_KV.get( key );
	if ( ! raw ) return [];
	try {
		const parsed = JSON.parse( raw );
		return Array.isArray( parsed ) ? parsed.map( ( row ) => ( {
			name: sanitizeName( row?.name ) || 'Unknown',
			records: Math.max( 0, Math.floor( Number( row?.records ) || 0 ) ),
			updatedAt: Number( row?.updatedAt ) || Date.now(),
		} ) ) : [];
	} catch {
		return [];
	}
}

function sanitizeName( value ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 24 );
}

function sanitizeSeasonId( value ) {
	return String( value || '' ).replace( /[^A-Za-z0-9_-]/g, '' ).slice( 0, 30 );
}

function hash32( str ) {
	let h = 0x811c9dc5;
	for ( let i = 0; i < str.length; i ++ ) {
		h ^= str.charCodeAt( i );
		h = Math.imul( h, 0x01000193 );
	}
	return h >>> 0;
}

function withCors( response ) {
	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type' );
	return new Response( response.body, { status: response.status, headers } );
}

function json( value, status = 200 ) {
	return new Response( JSON.stringify( value ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}
