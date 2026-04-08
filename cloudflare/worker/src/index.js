const TRACKS_KEY = 'tracks:all';
const MAX_ENTRIES = 300;

export default {
	async fetch( request, env ) {
		const url = new URL( request.url );
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );

		if ( url.pathname === '/api/tracks' && request.method === 'GET' ) {
			return withCors( await getTracks( env ) );
		}

		if ( url.pathname === '/api/tracks' && request.method === 'POST' ) {
			return withCors( await addTrack( request, env ) );
		}

		if ( url.pathname === '/api/tracks/link' && request.method === 'POST' ) {
			return withCors( await addTrackFromPlayUrl( request, env ) );
		}

		if ( url.pathname.startsWith( '/api/tracks/' ) && request.method === 'DELETE' ) {
			const id = url.pathname.split( '/' ).pop();
			return withCors( await deleteTrack( id, request, env ) );
		}

		if ( url.pathname.startsWith( '/api/tracks/' ) && url.pathname.endsWith( '/view' ) && request.method === 'POST' ) {
			const id = url.pathname.split( '/' )[ 3 ];
			return withCors( await incrementTrackViews( id, env ) );
		}

		return withCors( new Response( JSON.stringify( { ok: false, error: 'Not found' } ), {
			status: 404,
			headers: { 'Content-Type': 'application/json' },
		} ) );
	},
};

function withCors( response ) {
	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token' );
	return new Response( response.body, { status: response.status, headers } );
}

async function getTracks( env ) {
	const entries = await loadEntries( env );
	return json( { ok: true, entries } );
}

async function addTrack( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch ( e ) {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}

	const name = String( payload?.name || '' ).trim();
	const ghostCode = String( payload?.ghostCode || '' ).trim();
	if ( ! ghostCode ) return json( { ok: false, error: 'ghostCode is required' }, 400 );

	let decoded;
	try {
		decoded = decodeBase64UrlJson( ghostCode );
	} catch ( e ) {
		return json( { ok: false, error: 'Could not decode ghost code' }, 400 );
	}

	if ( ! decoded?.url || ! decoded?.ghost?.samples || decoded.ghost.samples.length < 2 ) {
		return json( { ok: false, error: 'Ghost code is missing required data' }, 400 );
	}

	const entry = {
		id: crypto.randomUUID(),
		name: name || inferTrackName( decoded.url ),
		playUrl: buildPlayUrl( decoded.url, decoded.ghost ),
		bestLapSeconds: Number( decoded.ghost.bestLapSeconds ),
		sampleCount: Array.isArray( decoded.ghost.samples ) ? decoded.ghost.samples.length : 0,
		viewCount: 0,
		createdAt: Date.now(),
	};

	const entries = await loadEntries( env );
	entries.unshift( entry );
	const trimmed = entries.slice( 0, MAX_ENTRIES );
	await env.TRACKS_KV.put( TRACKS_KEY, JSON.stringify( trimmed ) );
	return json( { ok: true, entry } );
}

async function deleteTrack( id, request, env ) {
	const token = request.headers.get( 'X-Admin-Token' ) || '';
	if ( ! env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN ) return json( { ok: false, error: 'Unauthorized' }, 401 );

	const entries = await loadEntries( env );
	const next = entries.filter( ( entry ) => entry.id !== id );
	await env.TRACKS_KV.put( TRACKS_KEY, JSON.stringify( next ) );
	return json( { ok: true } );
}

async function addTrackFromPlayUrl( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const name = String( payload?.name || '' ).trim().slice( 0, 80 );
	const playUrl = String( payload?.playUrl || '' ).trim();
	if ( ! playUrl ) return json( { ok: false, error: 'playUrl is required' }, 400 );
	try {
		new URL( playUrl );
	} catch {
		return json( { ok: false, error: 'playUrl must be a valid URL' }, 400 );
	}
	const entry = {
		id: crypto.randomUUID(),
		name: name || inferTrackName( playUrl ),
		playUrl,
		bestLapSeconds: null,
		sampleCount: 0,
		viewCount: 0,
		createdAt: Date.now(),
	};
	const entries = await loadEntries( env );
	entries.unshift( entry );
	const trimmed = entries.slice( 0, MAX_ENTRIES );
	await env.TRACKS_KV.put( TRACKS_KEY, JSON.stringify( trimmed ) );
	return json( { ok: true, entry } );
}

async function incrementTrackViews( id, env ) {
	if ( ! id ) return json( { ok: false, error: 'id is required' }, 400 );
	const entries = await loadEntries( env );
	const index = entries.findIndex( ( entry ) => entry.id === id );
	if ( index === - 1 ) return json( { ok: false, error: 'Not found' }, 404 );
	const current = Number( entries[ index ].viewCount );
	entries[ index ].viewCount = Number.isFinite( current ) ? current + 1 : 1;
	await env.TRACKS_KV.put( TRACKS_KEY, JSON.stringify( entries ) );
	return json( { ok: true, entry: entries[ index ] } );
}

async function loadEntries( env ) {
	const raw = await env.TRACKS_KV.get( TRACKS_KEY );
	if ( ! raw ) return [];
	try {
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) return [];
		return parsed.map( ( entry ) => ( {
			...entry,
			viewCount: Number.isFinite( Number( entry?.viewCount ) ) ? Number( entry.viewCount ) : 0,
		} ) );
	} catch {
		return [];
	}
}

function buildPlayUrl( baseUrl, ghostPayload ) {
	const ghostBlob = encodeBase64UrlJson( ghostPayload );
	const separator = baseUrl.includes( '#' ) ? '&' : '#';
	return `${ baseUrl }${ separator }ghost=${ ghostBlob }`;
}

function inferTrackName( url ) {
	try {
		const parsed = new URL( url );
		const map = parsed.searchParams.get( 'map' );
		if ( map ) return `Custom Track (${ map.slice( 0, 8 ) }...)`;
		return parsed.pathname.split( '/' ).pop() || 'Shared Track';
	} catch {
		return 'Shared Track';
	}
}

function encodeBase64UrlJson( value ) {
	return btoa( JSON.stringify( value ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );
}

function decodeBase64UrlJson( value ) {
	const normalized = value.replace( /-/g, '+' ).replace( /_/g, '/' );
	const padded = normalized + '='.repeat( ( 4 - normalized.length % 4 ) % 4 );
	return JSON.parse( atob( padded ) );
}

function json( value, status = 200 ) {
	return new Response( JSON.stringify( value ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}
