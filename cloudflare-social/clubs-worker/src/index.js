const CLUB_PREFIX = 'club:';
const MEMBER_PREFIX = 'club-member:';
const CLUB_INDEX_KEY = 'clubs:index';
const MAX_CLUBS = 500;

export default {
	async fetch( request, env ) {
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );
		const url = new URL( request.url );
		if ( url.pathname === '/api/clubs' && request.method === 'GET' ) return withCors( await listClubs( env ) );
		if ( url.pathname === '/api/clubs' && request.method === 'POST' ) return withCors( await createClub( request, env ) );
		if ( url.pathname.startsWith( '/api/clubs/' ) && request.method === 'GET' ) return withCors( await getClub( url.pathname.split( '/' )[ 3 ], env ) );
		if ( url.pathname.endsWith( '/join' ) && request.method === 'POST' ) return withCors( await joinClub( url.pathname.split( '/' )[ 3 ], request, env ) );
		if ( url.pathname.endsWith( '/stats' ) && request.method === 'POST' ) return withCors( await submitClubStats( url.pathname.split( '/' )[ 3 ], request, env ) );
		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

async function listClubs( env ) {
	const raw = await env.CLUBS_KV.get( CLUB_INDEX_KEY );
	if ( ! raw ) return json( { ok: true, clubs: [] } );
	try {
		const parsed = JSON.parse( raw );
		return json( { ok: true, clubs: Array.isArray( parsed ) ? parsed : [] } );
	} catch {
		return json( { ok: true, clubs: [] } );
	}
}

async function createClub( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const name = sanitizeText( payload?.name, 40 );
	const owner = sanitizeText( payload?.owner, 24 );
	if ( ! name || ! owner ) return json( { ok: false, error: 'name and owner are required' }, 400 );
	const clubId = crypto.randomUUID().slice( 0, 8 );
	const club = {
		id: clubId,
		name,
		owner,
		createdAt: Date.now(),
		memberCount: 1,
		totalCoins: 0,
		totalRecords: 0,
	};
	await env.CLUBS_KV.put( `${ CLUB_PREFIX }${ clubId }`, JSON.stringify( club ) );
	await env.CLUBS_KV.put( `${ MEMBER_PREFIX }${ clubId }:${ owner.toLowerCase() }`, JSON.stringify( {
		name: owner,
		coins: 0,
		records: 0,
		updatedAt: Date.now(),
	} ) );
	await refreshClubIndex( env );
	return json( { ok: true, club } );
}

async function getClub( clubId, env ) {
	const club = await env.CLUBS_KV.get( `${ CLUB_PREFIX }${ clubId }`, 'json' );
	if ( ! club ) return json( { ok: false, error: 'Club not found' }, 404 );
	const members = await loadClubMembers( env, clubId );
	members.sort( ( a, b ) => {
		if ( b.coins !== a.coins ) return b.coins - a.coins;
		if ( b.records !== a.records ) return b.records - a.records;
		return a.updatedAt - b.updatedAt;
	} );
	return json( { ok: true, club, membersByCoins: members, membersByRecords: [ ...members ].sort( ( a, b ) => b.records - a.records || b.coins - a.coins ) } );
}

async function joinClub( clubId, request, env ) {
	const club = await env.CLUBS_KV.get( `${ CLUB_PREFIX }${ clubId }`, 'json' );
	if ( ! club ) return json( { ok: false, error: 'Club not found' }, 404 );
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const name = sanitizeText( payload?.name, 24 );
	if ( ! name ) return json( { ok: false, error: 'name is required' }, 400 );
	const memberKey = `${ MEMBER_PREFIX }${ clubId }:${ name.toLowerCase() }`;
	const existing = await env.CLUBS_KV.get( memberKey, 'json' );
	if ( ! existing ) {
		await env.CLUBS_KV.put( memberKey, JSON.stringify( { name, coins: 0, records: 0, updatedAt: Date.now() } ) );
		club.memberCount = Math.max( 1, Number( club.memberCount ) + 1 );
		await env.CLUBS_KV.put( `${ CLUB_PREFIX }${ clubId }`, JSON.stringify( club ) );
		await refreshClubIndex( env );
	}
	return json( { ok: true, clubId, name } );
}

async function submitClubStats( clubId, request, env ) {
	const club = await env.CLUBS_KV.get( `${ CLUB_PREFIX }${ clubId }`, 'json' );
	if ( ! club ) return json( { ok: false, error: 'Club not found' }, 404 );
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const name = sanitizeText( payload?.name, 24 );
	const coins = Math.max( 0, Math.floor( Number( payload?.coins ) || 0 ) );
	const records = Math.max( 0, Math.floor( Number( payload?.records ) || 0 ) );
	if ( ! name ) return json( { ok: false, error: 'name is required' }, 400 );
	const memberKey = `${ MEMBER_PREFIX }${ clubId }:${ name.toLowerCase() }`;
	await env.CLUBS_KV.put( memberKey, JSON.stringify( { name, coins, records, updatedAt: Date.now() } ) );
	const members = await loadClubMembers( env, clubId );
	club.totalCoins = members.reduce( ( sum, item ) => sum + item.coins, 0 );
	club.totalRecords = members.reduce( ( sum, item ) => sum + item.records, 0 );
	club.memberCount = members.length;
	await env.CLUBS_KV.put( `${ CLUB_PREFIX }${ clubId }`, JSON.stringify( club ) );
	await refreshClubIndex( env );
	return json( { ok: true } );
}

async function loadClubMembers( env, clubId ) {
	const list = await env.CLUBS_KV.list( { prefix: `${ MEMBER_PREFIX }${ clubId }:`, limit: 1000 } );
	const members = [];
	for ( const keyInfo of list.keys ) {
		const row = await env.CLUBS_KV.get( keyInfo.name, 'json' );
		if ( ! row ) continue;
		members.push( {
			name: sanitizeText( row?.name, 24 ) || 'Unknown',
			coins: Math.max( 0, Math.floor( Number( row?.coins ) || 0 ) ),
			records: Math.max( 0, Math.floor( Number( row?.records ) || 0 ) ),
			updatedAt: Number( row?.updatedAt ) || Date.now(),
		} );
	}
	return members;
}

async function refreshClubIndex( env ) {
	const list = await env.CLUBS_KV.list( { prefix: CLUB_PREFIX, limit: 1000 } );
	const clubs = [];
	for ( const keyInfo of list.keys ) {
		const club = await env.CLUBS_KV.get( keyInfo.name, 'json' );
		if ( ! club ) continue;
		clubs.push( club );
	}
	clubs.sort( ( a, b ) => {
		if ( b.totalRecords !== a.totalRecords ) return b.totalRecords - a.totalRecords;
		if ( b.totalCoins !== a.totalCoins ) return b.totalCoins - a.totalCoins;
		return b.memberCount - a.memberCount;
	} );
	await env.CLUBS_KV.put( CLUB_INDEX_KEY, JSON.stringify( clubs.slice( 0, MAX_CLUBS ) ) );
}

function sanitizeText( value, maxLen ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, maxLen );
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
