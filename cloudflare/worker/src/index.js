const TRACKS_KEY = 'tracks:all';
const TRACKS_META_KEY = 'tracks:meta';
const TRACKS_CHUNK_PREFIX = 'tracks:chunk:';
const SLIM_INDEX_KEY = 'tracks:slim-index';
const ENTRY_KEY_PREFIX = 'tracks:entry:';
const MAX_ENTRIES = 300;
const MAX_TRACKS_CHUNK_BYTES = 5_000_000;
const PACK_KEY_PREFIX = 'pack:';
const MAX_PACK_BYTES = 20_000_000;

export default {
	async fetch( request, env ) {
		const url = new URL( request.url );
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );

		if ( url.pathname === '/api/tracks' && request.method === 'GET' ) {
			return withCors( await getTracks( url, env ) );
		}

		// Single track thumbnail (lazy-loaded by board cards). Keeps the main
		// list payload thumbnail-free (fields=list) so the board stays fast as
		// the track database grows.
		if ( url.pathname.startsWith( '/api/tracks/' ) && url.pathname.endsWith( '/thumb' ) && request.method === 'GET' ) {
			const id = url.pathname.split( '/' )[ 3 ];
			return withCors( await getTrackThumb( id, env ) );
		}

		// Full single board entry (playUrl WITH its #ghost blob). The slim
		// list strips ghosts so the board loads fast; the page refetches the
		// complete entry on demand when a player opens or shares a track.
		if ( url.pathname.startsWith( '/api/tracks/' ) && request.method === 'GET' && ! url.pathname.endsWith( '/thumb' ) ) {
			const id = url.pathname.split( '/' )[ 3 ];
			return withCors( await getTrackById( id, env ) );
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

async function getTracks( url, env ) {
	// fields=slim reads the lightweight index (no thumbnails, no ghost blobs
	// inside playUrl) instead of the full ~30MB entry set — the fast path the
	// board page uses. Every other fields value reads full entries.
	const entries = String( url.searchParams.get( 'fields' ) || '' ).trim() === 'slim'
		? await loadSlimIndex( env )
		: await loadEntries( env );

	// All query params are OPTIONAL and default to the legacy behaviour
	// (full list, newest-first, thumbnails inline) so older frontends keep
	// working against this worker unchanged.
	const author = String( url.searchParams.get( 'author' ) || '' ).trim().toLowerCase();
	const search = String( url.searchParams.get( 'search' ) || '' ).trim().toLowerCase();
	const sort = String( url.searchParams.get( 'sort' ) || 'newest' );
	const fields = String( url.searchParams.get( 'fields' ) || '' ).trim();
	// NB: Number(null) === 0, so an absent param must NOT fall into the
	// numeric default — check it explicitly (a bare Number()||0 here made the
	// no-params legacy request return a single entry).
	const limitRaw = Number( url.searchParams.get( 'limit' ) );
	const limit = Number.isFinite( limitRaw ) && limitRaw > 0 ? Math.min( 300, Math.floor( limitRaw ) ) : 0;
	const offset = Math.max( 0, Math.floor( Number( url.searchParams.get( 'offset' ) ) || 0 ) );

	let filtered = entries;
	if ( author ) {
		filtered = filtered.filter( ( entry ) => String( entry?.creator || '' ).trim().toLowerCase() === author );
	}
	if ( search ) {
		filtered = filtered.filter( ( entry ) => {
			const name = String( entry?.name || '' ).toLowerCase();
			const description = String( entry?.description || '' ).toLowerCase();
			const creator = String( entry?.creator || '' ).toLowerCase();
			return name.includes( search ) || description.includes( search ) || creator.includes( search );
		} );
	}

	const sorted = [ ...filtered ];
	if ( sort === 'popular' ) {
		sorted.sort( ( a, b ) => ( Number( b.viewCount ) || 0 ) - ( Number( a.viewCount ) || 0 ) );
	} else if ( sort === 'most-liked' ) {
		sorted.sort( ( a, b ) => ( Number( b.thumbsUp ) || 0 ) - ( Number( a.thumbsUp ) || 0 ) );
	} else if ( sort === 'best-time' ) {
		sorted.sort( ( a, b ) => ( Number( a.bestLapSeconds ) || Infinity ) - ( Number( b.bestLapSeconds ) || Infinity ) );
	} else if ( sort === 'alpha' ) {
		sorted.sort( ( a, b ) => String( a?.name || '' ).localeCompare( String( b?.name || '' ) ) );
	}
	// 'newest' (default): entries are stored newest-first via unshift.

	const total = sorted.length;
	let page = sorted;
	if ( limit > 0 ) page = sorted.slice( offset, offset + limit );

	if ( fields === 'list' ) {
		page = page.map( ( entry ) => {
			const { thumbnailDataUrl, ...rest } = entry;
			return { ...rest, hasThumbnail: Boolean( thumbnailDataUrl ) };
		} );
	}

	return json( { ok: true, entries: page, total, offset, limit } );
}

async function getTrackThumb( id, env ) {
	if ( ! id ) return json( { ok: false, error: 'id is required' }, 400 );
	const entries = await loadEntries( env );
	const entry = entries.find( ( e ) => e.id === id );
	const dataUrl = String( entry?.thumbnailDataUrl || '' );
	const match = dataUrl.match( /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=]+)$/ );
	if ( ! entry || ! match ) return json( { ok: false, error: 'Not found' }, 404 );
	const bytes = Uint8Array.from( atob( match[ 2 ] ), ( c ) => c.charCodeAt( 0 ) );
	return new Response( bytes, {
		status: 200,
		headers: {
			'Content-Type': match[ 1 ],
			// Thumbnails are immutable once published — let the browser cache them.
			'Cache-Control': 'public, max-age=86400',
		},
	} );
}

// Creator field: stored on new entries so the board can credit track
// authors. Empty/missing creator falls back to 'Anonymous' (legacy
// entries simply have no field and the UI applies the same fallback).
function sanitizeCreator( value ) {
	const stripped = String( value || '' ).replace( /\s+/g, ' ' ).trim().replace( /[<>]/g, '' );
	return stripped.slice( 0, 32 ) || 'Anonymous';
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
		creator: sanitizeCreator( payload?.creator ),
		description,
		thumbnailDataUrl: thumbnailDataUrl.slice( 0, 400000 ),
		createdAt: Date.now(),
	};

	// Per-entry key so GET /api/tracks/:id for this track never needs the
	// full chunk scan. Failure is non-fatal — the scan fallback still works.
	try { await env.TRACKS_KV.put( `${ ENTRY_KEY_PREFIX }${ entry.id }`, JSON.stringify( entry ) ); } catch {}

	const entries = await loadEntries( env );
	entries.unshift( entry );
	const trimmed = entries.slice( 0, MAX_ENTRIES );
	await saveEntries( trimmed, env );
	return json( { ok: true, entry } );
}

async function deleteTrack( id, request, env ) {
	const token = request.headers.get( 'X-Admin-Token' ) || '';
	if ( ! env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN ) return json( { ok: false, error: 'Unauthorized' }, 401 );

	const entries = await loadEntries( env );
	const next = entries.filter( ( entry ) => entry.id !== id );
	await saveEntries( next, env );
	return json( { ok: true } );
}

async function incrementTrackViews( id, env ) {
	if ( ! id ) return json( { ok: false, error: 'id is required' }, 400 );
	const entries = await loadEntries( env );
	const index = entries.findIndex( ( entry ) => entry.id === id );
	if ( index === -1 ) return json( { ok: false, error: 'Not found' }, 404 );
	const current = Number( entries[ index ].viewCount );
	entries[ index ].viewCount = Number.isFinite( current ) ? current + 1 : 1;
	await saveEntries( entries, env );
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
	if ( index === -1 ) return json( { ok: false, error: 'Not found' }, 404 );
	const currentUp = Number( entries[ index ].thumbsUp );
	const currentDown = Number( entries[ index ].thumbsDown );
	entries[ index ].thumbsUp = Number.isFinite( currentUp ) ? currentUp : 0;
	entries[ index ].thumbsDown = Number.isFinite( currentDown ) ? currentDown : 0;
	if ( vote > 0 ) entries[ index ].thumbsUp += 1;
	if ( vote < 0 ) entries[ index ].thumbsDown += 1;
	entries[ index ].lastLikedAt = Date.now();
	await saveEntries( entries, env );
	return json( { ok: true, entry: entries[ index ] } );
}

// Strip the #ghost= blob from a play URL; the board list only needs the
// map+mods link. The full URL is served per-track via GET /api/tracks/:id.
function slimPlayUrl( playUrl ) {
	const url = String( playUrl || '' );
	const hashIndex = url.indexOf( '#ghost=' );
	return hashIndex === -1 ? url : url.slice( 0, hashIndex );
}

function playUrlHasGhost( playUrl ) {
	return String( playUrl || '' ).indexOf( '#ghost=' ) !== -1;
}

// Slim index entries: everything the board page needs to list, search and
// sort tracks — no thumbnail data, no ghost blobs. A few hundred KB total
// instead of tens of MB, so the worker stays far under its CPU limit.
function buildSlimIndex( entries ) {
	return entries.map( ( entry ) => {
		const { thumbnailDataUrl, ...rest } = entry;
		return {
			...rest,
			playUrl: slimPlayUrl( entry?.playUrl ),
			hasThumbnail: Boolean( thumbnailDataUrl ),
			hasGhost: playUrlHasGhost( entry?.playUrl ),
		};
	} );
}

async function loadSlimIndex( env ) {
	const raw = await env.TRACKS_KV.get( SLIM_INDEX_KEY );
	if ( raw ) {
		try {
			const parsed = JSON.parse( raw );
			if ( Array.isArray( parsed ) ) return parsed;
		} catch {
			// Corrupt index — fall through and rebuild it.
		}
	}
	// First request after this update: build the index once from the full
	// entries, then every future fields=slim read is a tiny KV get.
	const slim = buildSlimIndex( await loadEntries( env ) );
	try { await env.TRACKS_KV.put( SLIM_INDEX_KEY, JSON.stringify( slim ) ); } catch {}
	return slim;
}

// Single full entry. Reads the dedicated per-entry key (cheap) so Play
// clicks never re-parse the whole board; older tracks without a
// per-entry key fall back to one chunk scan, then self-heal by writing
// their key.
async function getTrackById( id, env ) {
	if ( ! id ) return json( { ok: false, error: 'id is required' }, 400 );
	const key = `${ ENTRY_KEY_PREFIX }${ id }`;
	const raw = await env.TRACKS_KV.get( key );
	if ( raw ) {
		try {
			const entry = JSON.parse( raw );
			if ( entry?.playUrl ) return json( { ok: true, entry } );
		} catch {}
	}
	const entries = await loadEntries( env );
	const entry = entries.find( ( e ) => String( e?.id || '' ) === String( id ) );
	if ( ! entry ) return json( { ok: false, error: 'Track not found' }, 404 );
	try { await env.TRACKS_KV.put( key, JSON.stringify( entry ) ); } catch {}
	return json( { ok: true, entry } );
}

async function loadEntries( env ) {
	const metaRaw = await env.TRACKS_KV.get( TRACKS_META_KEY );
	if ( metaRaw ) {
		try {
			const meta = JSON.parse( metaRaw );
			if ( Array.isArray( meta?.chunks ) ) {
				const chunks = await Promise.all( meta.chunks.map( ( key ) => env.TRACKS_KV.get( key ) ) );
				const entries = [];
				for ( const raw of chunks ) {
					if ( ! raw ) continue;
					try {
						const parsed = JSON.parse( raw );
						if ( Array.isArray( parsed ) ) entries.push( ...parsed );
					} catch {
						// Ignore a corrupt chunk instead of making the whole board unreadable.
					}
				}
				return normalizeEntries( entries );
			}
		} catch {
			// Fall through to the legacy single-key format.
		}
	}

	const raw = await env.TRACKS_KV.get( TRACKS_KEY );
	if ( ! raw ) return [];
	try {
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) return [];
		return normalizeEntries( parsed );
	} catch {
		return [];
	}
}

function normalizeEntries( entries ) {
	return entries.map( ( entry ) => ( {
		...entry,
		viewCount: Number.isFinite( Number( entry?.viewCount ) ) ? Number( entry.viewCount ) : 0,
		thumbsUp: Number.isFinite( Number( entry?.thumbsUp ) ) ? Number( entry.thumbsUp ) : 0,
		thumbsDown: Number.isFinite( Number( entry?.thumbsDown ) ) ? Number( entry.thumbsDown ) : 0,
		description: String( entry?.description || '' ),
		thumbnailDataUrl: String( entry?.thumbnailDataUrl || '' ),
		lastLikedAt: Number.isFinite( Number( entry?.lastLikedAt ) ) ? Number( entry.lastLikedAt ) : 0,
	} ) );
}

async function saveEntries( entries, env ) {
	const chunks = [];
	let current = [];
	let currentBytes = 2;

	for ( const entry of entries ) {
		const entryBytes = byteLength( JSON.stringify( entry ) );
		if ( entryBytes + 2 > MAX_TRACKS_CHUNK_BYTES ) {
			throw new Error( `Track entry is too large for a storage chunk: ${ entryBytes } bytes` );
		}

		const separatorBytes = current.length ? 1 : 0;
		if ( current.length && currentBytes + separatorBytes + entryBytes > MAX_TRACKS_CHUNK_BYTES ) {
			chunks.push( current );
			current = [];
			currentBytes = 2;
		}

		current.push( entry );
		currentBytes += separatorBytes + entryBytes;
	}

	if ( current.length || chunks.length === 0 ) chunks.push( current );

	const newKeys = chunks.map( ( _, index ) => `${ TRACKS_CHUNK_PREFIX }${ index }` );
	for ( let i = 0; i < chunks.length; i++ ) {
		await env.TRACKS_KV.put( newKeys[ i ], JSON.stringify( chunks[ i ] ) );
	}

	// Keep the slim board index in sync so fields=slim reads stay cheap.
	// An index write failure must never break a publish/delete/vote.
	try { await env.TRACKS_KV.put( SLIM_INDEX_KEY, JSON.stringify( buildSlimIndex( entries ) ) ); } catch {}

	await env.TRACKS_KV.put( TRACKS_META_KEY, JSON.stringify( {
		version: 1,
		chunks: newKeys,
		entryCount: entries.length,
	} ) );

	// Once the new chunked layout is safely published, remove the legacy giant value.
	try {
		await env.TRACKS_KV.delete( TRACKS_KEY );
	} catch {
		// The old value is no longer used; failure to delete it should not break writes.
	}
}

function byteLength( value ) {
	return new TextEncoder().encode( value ).byteLength;
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
