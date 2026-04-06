const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 220;
const MAX_HISTORY = 80;

export default {
	async fetch( request, env ) {
		const url = new URL( request.url );

		if ( request.method === 'OPTIONS' ) {
			return withCors( new Response( null, { status: 204 } ) );
		}

		if ( url.pathname === '/api/chat/messages' && request.method === 'GET' ) {
			const room = getRoomId( url.searchParams.get( 'room' ) );
			const obj = env.CHAT_ROOM.idFromName( room );
			const stub = env.CHAT_ROOM.get( obj );
			return withCors( await stub.fetch( 'https://chat.internal/messages' ) );
		}

		if ( url.pathname === '/api/chat/messages' && request.method === 'POST' ) {
			const room = getRoomId( url.searchParams.get( 'room' ) );
			const obj = env.CHAT_ROOM.idFromName( room );
			const stub = env.CHAT_ROOM.get( obj );
			return withCors( await stub.fetch( 'https://chat.internal/messages', request ) );
		}

		if ( url.pathname === '/api/chat/stream' && request.method === 'GET' ) {
			const room = getRoomId( url.searchParams.get( 'room' ) );
			const obj = env.CHAT_ROOM.idFromName( room );
			const stub = env.CHAT_ROOM.get( obj );
			return withCors( await stub.fetch( 'https://chat.internal/stream' ) );
		}

		return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
	},
};

export class ChatRoom {
	constructor( state ) {
		this.state = state;
		this.messages = [];
		this.sessions = new Set();
		this.boot = this.loadState();
	}

	async fetch( request ) {
		await this.boot;
		const url = new URL( request.url );

		if ( url.pathname === '/messages' && request.method === 'GET' ) {
			return json( { ok: true, messages: this.messages } );
		}

		if ( url.pathname === '/messages' && request.method === 'POST' ) {
			let payload;
			try {
				payload = await request.json();
			} catch {
				return json( { ok: false, error: 'Invalid JSON payload' }, 400 );
			}

			const name = sanitizeName( payload?.name );
			const text = sanitizeMessage( payload?.text );
			if ( ! text ) return json( { ok: false, error: 'Message cannot be empty' }, 400 );

			const entry = {
				id: crypto.randomUUID(),
				name: name || 'Player',
				text,
				createdAt: Date.now(),
			};

			this.messages.push( entry );
			if ( this.messages.length > MAX_HISTORY ) {
				this.messages = this.messages.slice( -MAX_HISTORY );
			}

			await this.state.storage.put( 'messages', this.messages );
			this.broadcast( entry );

			return json( { ok: true, message: entry }, 201 );
		}

		if ( url.pathname === '/stream' && request.method === 'GET' ) {
			const pair = new WebSocketPair();
			const client = pair[ 0 ];
			const server = pair[ 1 ];
			server.accept();

			this.sessions.add( server );
			server.send( JSON.stringify( { type: 'snapshot', messages: this.messages } ) );

			const cleanup = () => this.sessions.delete( server );
			server.addEventListener( 'close', cleanup );
			server.addEventListener( 'error', cleanup );
			server.addEventListener( 'message', ( event ) => {
				if ( event.data === 'ping' ) server.send( 'pong' );
			} );

			return new Response( null, { status: 101, webSocket: client } );
		}

		return json( { ok: false, error: 'Not found' }, 404 );
	}

	async loadState() {
		const saved = await this.state.storage.get( 'messages' );
		if ( Array.isArray( saved ) ) this.messages = saved;
	}

	broadcast( message ) {
		const payload = JSON.stringify( { type: 'message', message } );
		for ( const socket of this.sessions ) {
			try {
				socket.send( payload );
			} catch {
				this.sessions.delete( socket );
			}
		}
	}
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
