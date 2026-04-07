const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 220;
const MAX_HISTORY = 120;

export default {
	async fetch( request, env ) {
		const url = new URL( request.url );
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );

		if ( url.pathname === '/api/chat/messages' && request.method === 'GET' ) {
			return withCors( await getMessages( url, env ) );
		}

		if ( url.pathname === '/api/chat/messages' && request.method === 'POST' ) {
			return withCors( await postMessage( request, url, env ) );
		}

		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

async function getMessages( url, env ) {
	const room = getRoomId( url.searchParams.get( 'room' ) );
	const since = Number( url.searchParams.get( 'since' ) || 0 );
	const messages = await loadRoomMessages( env, room );
	const filtered = Number.isFinite( since ) && since > 0
		? messages.filter( ( entry ) => entry.createdAt > since )
		: messages;
	const cursor = messages.length ? messages[ messages.length - 1 ].createdAt : 0;
	return json( { ok: true, room, cursor, messages: filtered } );
}

async function postMessage( request, url, env ) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json( { ok: false, error: 'Invalid JSON payload' }, 400 );
	}

	const room = getRoomId( url.searchParams.get( 'room' ) );
	const name = sanitizeName( payload?.name );
	const text = sanitizeMessage( payload?.text );
	if ( ! text ) return json( { ok: false, error: 'Message cannot be empty' }, 400 );

	const entry = {
		id: crypto.randomUUID(),
		name: name || 'Player',
		text,
		createdAt: Date.now(),
	};

	const messages = await loadRoomMessages( env, room );
	messages.push( entry );
	const trimmed = messages.slice( -MAX_HISTORY );

	await env.CHAT_KV.put( roomKey( room ), JSON.stringify( trimmed ) );
	return json( { ok: true, room, message: entry }, 201 );
}

async function loadRoomMessages( env, room ) {
	const raw = await env.CHAT_KV.get( roomKey( room ) );
	if ( ! raw ) return [];
	try {
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) return [];
		return parsed.filter( isValidEntry );
	} catch {
		return [];
	}
}

function isValidEntry( value ) {
	return value
		&& typeof value.id === 'string'
		&& typeof value.name === 'string'
		&& typeof value.text === 'string'
		&& Number.isFinite( value.createdAt );
}

function roomKey( room ) {
	return `chat:room:${ room }`;
}

function sanitizeName( value ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, MAX_NAME_LENGTH );
}

function sanitizeMessage( value ) {
	return String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, MAX_MESSAGE_LENGTH );
}

function getRoomId( value ) {
	const raw = String( value || 'global' ).toLowerCase();
	const cleaned = raw.replace( /[^a-z0-9-_]/g, '' ).slice( 0, 40 );
	return cleaned || 'global';
}

function withCors( response ) {
	const headers = new Headers( response.headers );
	for ( const [ key, value ] of Object.entries( CORS_HEADERS ) ) headers.set( key, value );
	return new Response( response.body, { status: response.status, headers } );
}

function json( body, status = 200 ) {
	return new Response( JSON.stringify( body ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}
