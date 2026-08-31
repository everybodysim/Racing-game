// Community Custom Mods share board.
// Stores community-published custom mods in Cloudflare KV and serves them to
// the Mod Manager page (mods.html) and the Custom Mods Lab (custommods.html).
//
// Endpoints:
//   GET    /api/mods            -> list published mod summaries (newest first)
//   POST   /api/mods            -> publish a new mod (full share payload)
//   GET    /api/mods/:id        -> fetch one full mod payload (for install/remix)
//   POST   /api/mods/:id/install -> bump the install counter
//   POST   /api/mods/:id/vote    -> thumbs up (1) or down (-1)
//   DELETE /api/mods/:id        -> remove a mod (admin token required)
//
// KV keys:
//   mods:index  -> array of summary entries (capped at MAX_ENTRIES)
//   mod:<id>    -> full published payload for one mod

const INDEX_KEY = 'mods:index';
const MOD_KEY_PREFIX = 'mod:';
const MAX_ENTRIES = 300;
const MAX_FULL_BYTES = 1_500_000;        // full payload (xml + template) size cap
const MAX_NAME = 80;
const MAX_AUTHOR = 40;
const MAX_DESCRIPTION = 600;

export default {
	async fetch( request, env ) {
		const url = new URL( request.url );
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );

		if ( url.pathname === '/api/mods' && request.method === 'GET' ) {
			return withCors( await listMods( env ) );
		}
		if ( url.pathname === '/api/mods' && request.method === 'POST' ) {
			return withCors( await publishMod( request, env ) );
		}

		if ( url.pathname.startsWith( '/api/mods/' ) ) {
			const parts = url.pathname.split( '/' ); // ['', 'api', 'mods', '<id>', '<action>?']
			const id = parts[ 3 ] || '';
			const action = parts[ 4 ] || '';

			if ( request.method === 'GET' && ! action ) {
				return withCors( await getMod( id, env ) );
			}
			if ( request.method === 'POST' && action === 'install' ) {
				return withCors( await bumpInstall( id, env ) );
			}
			if ( request.method === 'POST' && action === 'vote' ) {
				return withCors( await voteMod( id, request, env ) );
			}
			if ( request.method === 'DELETE' && ! action ) {
				return withCors( await deleteMod( id, request, env ) );
			}
		}

		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

async function listMods( env ) {
	const entries = await loadIndex( env );
	return json( { ok: true, entries } );
}

async function publishMod( request, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}

	if ( ! payload || payload.type !== 'racing-custom-mod-share-v1' ) {
		return json( { ok: false, error: 'Payload must be a racing-custom-mod-share-v1 share' }, 400 );
	}

	const modId = sanitizeModId( payload.modId );
	const modName = sanitizeText( payload.modName, MAX_NAME ) || 'Custom Mod';
	const author = sanitizeText( payload.author, MAX_AUTHOR );
	const description = sanitizeText( payload.description, MAX_DESCRIPTION );
	const xml = String( payload.xml || '' ).slice( 0, 800_000 );
	const template = String( payload.template || '' ).slice( 0, 800_000 );

	if ( ! modId ) return json( { ok: false, error: 'modId is required' }, 400 );
	if ( ! template.trim() ) return json( { ok: false, error: 'mod template is required' }, 400 );

	const full = {
		id: crypto.randomUUID(),
		type: 'racing-custom-mod-share-v1',
		modId,
		modName,
		author,
		description,
		xml,
		template,
		createdAt: Date.now(),
	};

	const serialized = JSON.stringify( full );
	if ( serialized.length > MAX_FULL_BYTES ) {
		return json( { ok: false, error: 'Mod is too large to publish' }, 413 );
	}

	const summary = {
		id: full.id,
		modId: full.modId,
		modName: full.modName,
		author: full.author,
		description: full.description,
		installCount: 0,
		viewCount: 0,
		thumbsUp: 0,
		thumbsDown: 0,
		lastLikedAt: 0,
		createdAt: full.createdAt,
	};

	const entries = await loadIndex( env );
	entries.unshift( summary );
	const trimmed = entries.slice( 0, MAX_ENTRIES );

	await Promise.all( [
		env.MODS_KV.put( `${ MOD_KEY_PREFIX }${ full.id }`, serialized ),
		env.MODS_KV.put( INDEX_KEY, JSON.stringify( trimmed ) ),
	] );

	return json( { ok: true, entry: summary } );
}

async function getMod( id, env ) {
	if ( ! isValidId( id ) ) return json( { ok: false, error: 'Invalid mod id' }, 400 );
	const raw = await env.MODS_KV.get( `${ MOD_KEY_PREFIX }${ id }` );
	if ( ! raw ) return json( { ok: false, error: 'Mod not found' }, 404 );
	try {
		const parsed = JSON.parse( raw );
		// Bump view count on the index for popularity ranking.
		const entries = await loadIndex( env );
		const index = entries.findIndex( ( e ) => e.id === id );
		if ( index !== -1 ) {
			entries[ index ].viewCount = Number( entries[ index ].viewCount || 0 ) + 1;
			await env.MODS_KV.put( INDEX_KEY, JSON.stringify( entries ) );
		}
		return json( { ok: true, mod: parsed } );
	} catch {
		return json( { ok: false, error: 'Corrupt mod data' }, 500 );
	}
}

async function bumpInstall( id, env ) {
	if ( ! isValidId( id ) ) return json( { ok: false, error: 'Invalid mod id' }, 400 );
	const entries = await loadIndex( env );
	const index = entries.findIndex( ( e ) => e.id === id );
	if ( index === -1 ) return json( { ok: false, error: 'Mod not found' }, 404 );
	entries[ index ].installCount = Number( entries[ index ].installCount || 0 ) + 1;
	await env.MODS_KV.put( INDEX_KEY, JSON.stringify( entries ) );
	return json( { ok: true, entry: entries[ index ] } );
}

async function voteMod( id, request, env ) {
	if ( ! isValidId( id ) ) return json( { ok: false, error: 'Invalid mod id' }, 400 );
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON body' }, 400 );
	}
	const vote = Number( payload?.vote );
	if ( vote !== 1 && vote !== -1 ) return json( { ok: false, error: 'vote must be 1 or -1' }, 400 );

	const entries = await loadIndex( env );
	const index = entries.findIndex( ( e ) => e.id === id );
	if ( index === -1 ) return json( { ok: false, error: 'Mod not found' }, 404 );
	entries[ index ].thumbsUp = Number( entries[ index ].thumbsUp || 0 );
	entries[ index ].thumbsDown = Number( entries[ index ].thumbsDown || 0 );
	if ( vote > 0 ) entries[ index ].thumbsUp += 1;
	if ( vote < 0 ) entries[ index ].thumbsDown += 1;
	entries[ index ].lastLikedAt = Date.now();
	await env.MODS_KV.put( INDEX_KEY, JSON.stringify( entries ) );
	return json( { ok: true, entry: entries[ index ] } );
}

async function deleteMod( id, request, env ) {
	if ( ! isValidId( id ) ) return json( { ok: false, error: 'Invalid mod id' }, 400 );
	const token = request.headers.get( 'X-Admin-Token' ) || '';
	if ( ! env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN ) {
		return json( { ok: false, error: 'Unauthorized' }, 401 );
	}
	const entries = await loadIndex( env );
	const next = entries.filter( ( e ) => e.id !== id );
	await Promise.all( [
		env.MODS_KV.put( INDEX_KEY, JSON.stringify( next ) ),
		env.MODS_KV.delete( `${ MOD_KEY_PREFIX }${ id }` ),
	] );
	return json( { ok: true } );
}

async function loadIndex( env ) {
	const raw = await env.MODS_KV.get( INDEX_KEY );
	if ( ! raw ) return [];
	try {
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) return [];
		return parsed.map( normalizeSummary );
	} catch {
		return [];
	}
}

function normalizeSummary( entry ) {
	const n = ( v, d = 0 ) => ( Number.isFinite( Number( v ) ) ? Number( v ) : d );
	return {
		id: String( entry?.id || '' ),
		modId: sanitizeModId( entry?.modId ),
		modName: sanitizeText( entry?.modName, MAX_NAME ) || 'Custom Mod',
		author: sanitizeText( entry?.author, MAX_AUTHOR ),
		description: sanitizeText( entry?.description, MAX_DESCRIPTION ),
		installCount: n( entry?.installCount ),
		viewCount: n( entry?.viewCount ),
		thumbsUp: n( entry?.thumbsUp ),
		thumbsDown: n( entry?.thumbsDown ),
		lastLikedAt: n( entry?.lastLikedAt ),
		createdAt: n( entry?.createdAt ),
	};
}

function sanitizeModId( value ) {
	const cleaned = String( value || '' ).trim();
	return cleaned.replace( /[^a-zA-Z0-9_-]/g, '' ).slice( 0, 120 );
}

function sanitizeText( value, max ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, max );
}

function isValidId( id ) {
	const cleaned = String( id || '' ).trim();
	return cleaned.length > 0 && cleaned.length <= 128 && /^[a-zA-Z0-9-]+$/.test( cleaned );
}

function withCors( response ) {
	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token' );
	return new Response( response.body, { status: response.status, headers } );
}

function json( value, status = 200 ) {
	return new Response( JSON.stringify( value ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}
