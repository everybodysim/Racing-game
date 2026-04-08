const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

export default {
	async fetch( request ) {
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );
		const url = new URL( request.url );
		if ( url.pathname === '/api/season/current' && request.method === 'GET' ) {
			return withCors( json( buildSeasonPayload() ) );
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
	return {
		ok: true,
		seasonId,
		seasonSeed,
		daySeed,
		rewardPool,
		notes: 'Use seasonSeed/daySeed to drive TOTD-style seasonal track generation and reward distribution.',
	};
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
