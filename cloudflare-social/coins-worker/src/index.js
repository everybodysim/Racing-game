const PLAYER_KEY_PREFIX = 'coins:player:';
const TOP_CACHE_KEY = 'coins:top';
const MAX_ROWS = 200;

export default {
	async fetch( request, env ) {
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );
		const url = new URL( request.url );
		if ( url.pathname === '/api/coins/top' && request.method === 'GET' ) return withCors( await getTopPlayers( env ) );
		if ( url.pathname === '/api/coins/submit' && request.method === 'POST' ) return withCors( await submitCoins( request, env ) );
		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

async function getTopPlayers( env ) {
	const raw = await env.COINS_KV.get( TOP_CACHE_KEY );
	if ( ! raw ) return json( { ok: true, entries: [] } );
	try {
		const parsed = JSON.parse( raw );
		return json( { ok: true, entries: Array.isArray( parsed ) ? parsed : [] } );
	} catch {
		return json( { ok: true, entries: [] } );
	}
}

async function submitCoins( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const name = sanitizeName( payload?.name );
	const coins = Number( payload?.coins );
	const records = Math.max( 0, Math.floor( Number( payload?.records ) || 0 ) );
	if ( ! name ) return json( { ok: false, error: 'name is required' }, 400 );
	if ( ! Number.isFinite( coins ) || coins < 0 ) return json( { ok: false, error: 'coins must be >= 0' }, 400 );

	const key = `${ PLAYER_KEY_PREFIX }${ name.toLowerCase() }`;
	const existing = await env.COINS_KV.get( key, 'json' );
	const row = {
		name,
		coins: Math.floor( coins ),
		records,
		updatedAt: Date.now(),
		bestCoins: Math.max( Math.floor( coins ), Math.floor( Number( existing?.bestCoins ) || 0 ) ),
	};
	await env.COINS_KV.put( key, JSON.stringify( row ) );
	await rebuildTopCache( env );
	return json( { ok: true, entry: row } );
}

async function rebuildTopCache( env ) {
	const list = await env.COINS_KV.list( { prefix: PLAYER_KEY_PREFIX, limit: 1000 } );
	const rows = [];
	for ( const keyInfo of list.keys ) {
		const row = await env.COINS_KV.get( keyInfo.name, 'json' );
		if ( ! row ) continue;
		rows.push( {
			name: sanitizeName( row?.name ) || 'Unknown',
			coins: Math.max( 0, Math.floor( Number( row?.coins ) || 0 ) ),
			records: Math.max( 0, Math.floor( Number( row?.records ) || 0 ) ),
			bestCoins: Math.max( 0, Math.floor( Number( row?.bestCoins ) || 0 ) ),
			updatedAt: Number( row?.updatedAt ) || Date.now(),
		} );
	}
	rows.sort( ( a, b ) => {
		if ( b.coins !== a.coins ) return b.coins - a.coins;
		if ( b.bestCoins !== a.bestCoins ) return b.bestCoins - a.bestCoins;
		return a.updatedAt - b.updatedAt;
	} );
	await env.COINS_KV.put( TOP_CACHE_KEY, JSON.stringify( rows.slice( 0, MAX_ROWS ) ) );
}

function sanitizeName( value ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 24 );
}

function withCors( response ) {
	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,POST,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type' );
	return new Response( response.body, { status: response.status, headers } );
}

function json( value, status = 200 ) {
	return new Response( JSON.stringify( value ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}
