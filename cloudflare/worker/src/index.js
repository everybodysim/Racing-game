const TRACKS_KEY = 'tracks:all';
const MAX_ENTRIES = 300;
const PACK_KEY_PREFIX = 'pack:';
const MAX_PACK_BYTES = 20_000_000;

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

		if ( url.pathname.startsWith( '/api/tracks/' ) && request.method === 'DELETE' ) {
			const id = url.pathname.split( '/' ).pop();
			return withCors( await deleteTrack( id, request, env ) );
		}

		if ( url.pathname.startsWith( '/api/tracks/' ) && url.pathname.endsWith( '/view' ) && request.method === 'POST' ) {
			const id = url.pathname.split( '/' )[ 3 ];
			return withCors( await incrementTrackViews( id, env ) );
		}

		if ( url.pathname.startsWith( '/api/tracks/' ) && url.pathname.endsWith( '/vote' ) && request.method === 'POST' ) {
			const id = url.pathname.split( '/' )[ 3 ];
			return withCors( await voteTrack( id, request, env ) );
		}

		if ( url.pathname === '/api/packs' && request.method === 'POST' ) {
			return withCors( await createPack( request, env ) );
		}

		if ( url.pathname.startsWith( '/api/packs/' ) && request.method === 'GET' ) {
			const id = url.pathname.split( '/' ).pop();
			return withCors( await getPack( id, env ) );
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
	const description = String( payload?.description || '' ).trim().slice( 0, 600 );
	const thumbnailDataUrl = String( payload?.thumbnailDataUrl || '' ).trim();
	if ( ! ghostCode ) return json( { ok: false, error: 'ghostCode is required' }, 400 );
	if ( thumbnailDataUrl && ! /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test( thumbnailDataUrl ) ) {
		return json( { ok: false, error: 'thumbnailDataUrl must be a valid image data URL' }, 400 );
	}

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
		thumbsUp: 0,
		thumbsDown: 0,
		lastLikedAt: 0,
		description,
		thumbnailDataUrl: thumbnailDataUrl.slice( 0, 400000 ),
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

async function voteTrack( id, request, env ) {
	if ( ! id ) return json( { ok: false, error: 'id is required' }, 400 );
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const vote = Number( payload?.vote );
	if ( vote !== 1 && vote !== -1 ) return json( { ok: false, error: 'vote must be 1 or -1' }, 400 );
	const entries = await loadEntries( env );
	const index = entries.findIndex( ( entry ) => entry.id === id );
	if ( index === - 1 ) return json( { ok: false, error: 'Not found' }, 404 );
	const currentUp = Number( entries[ index ].thumbsUp );
	const currentDown = Number( entries[ index ].thumbsDown );
	entries[ index ].thumbsUp = Number.isFinite( currentUp ) ? currentUp : 0;
	entries[ index ].thumbsDown = Number.isFinite( currentDown ) ? currentDown : 0;
	if ( vote > 0 ) entries[ index ].thumbsUp += 1;
	if ( vote < 0 ) entries[ index ].thumbsDown += 1;
	entries[ index ].lastLikedAt = Date.now();
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
			thumbsUp: Number.isFinite( Number( entry?.thumbsUp ) ) ? Number( entry.thumbsUp ) : 0,
			thumbsDown: Number.isFinite( Number( entry?.thumbsDown ) ) ? Number( entry.thumbsDown ) : 0,
			description: String( entry?.description || '' ),
			thumbnailDataUrl: String( entry?.thumbnailDataUrl || '' ),
			lastLikedAt: Number.isFinite( Number( entry?.lastLikedAt ) ) ? Number( entry.lastLikedAt ) : 0,
		} ) );
	} catch {
		return [];
	}
}

async function createPack( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const map = String( payload?.map || '' ).trim();
	const mods = String( payload?.mods || '' ).trim();
	if ( ! map ) return json( { ok: false, error: 'map is required' }, 400 );
	const entry = { map, mods, createdAt: Date.now() };
	const serialized = JSON.stringify( entry );
	if ( serialized.length > MAX_PACK_BYTES ) return json( { ok: false, error: 'Pack too large' }, 413 );
	const id = crypto.randomUUID().replace( /-/g, '' ).slice( 0, 16 );
	await env.TRACKS_KV.put( `${ PACK_KEY_PREFIX }${ id }`, serialized );
	return json( { ok: true, id } );
}

async function getPack( id, env ) {
	const safeId = String( id || '' ).trim();
	if ( safeId.length < 1 || safeId.length > 128 || ! /^[a-zA-Z0-9._-]+$/.test( safeId ) ) return json( { ok: false, error: 'Invalid pack id' }, 400 );
	const raw = await env.TRACKS_KV.get( `${ PACK_KEY_PREFIX }${ safeId }` );
	if ( ! raw ) return json( { ok: false, error: 'Not found' }, 404 );
	try {
		const parsed = JSON.parse( raw );
		return json( { ok: true, map: String( parsed?.map || '' ), mods: String( parsed?.mods || '' ) } );
	} catch {
		return json( { ok: false, error: 'Corrupt pack' }, 500 );
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
