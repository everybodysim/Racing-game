export default {

	async fetch( request, env ) {

		const url = new URL( request.url );

		if ( url.pathname !== '/ws' ) {

			return new Response( 'OK', { status: 200 } );

		}

		if ( request.headers.get( 'Upgrade' ) !== 'websocket' ) {

			return new Response( 'Expected websocket', { status: 426 } );

		}

		const roomId = ( url.searchParams.get( 'room' ) || 'default' ).slice( 0, 64 );
		const playerId = ( url.searchParams.get( 'player' ) || crypto.randomUUID() ).slice( 0, 64 );
		const id = env.ROOM.idFromName( roomId );
		const room = env.ROOM.get( id );

		const roomUrl = new URL( 'https://room.internal/ws' );
		roomUrl.searchParams.set( 'room', roomId );
		roomUrl.searchParams.set( 'player', playerId );

		return room.fetch( roomUrl.toString(), {
			headers: request.headers,
		} );

	},

};

export class Room {

	constructor() {

		this.clients = new Set();
		this.lastByPlayer = new Map();

	}

	async fetch( request ) {

		if ( request.headers.get( 'Upgrade' ) !== 'websocket' ) return new Response( 'Expected websocket', { status: 426 } );

		const [ client, server ] = new WebSocketPair();
		server.accept();

		const url = new URL( request.url );
		const room = url.searchParams.get( 'room' ) || 'default';
		const player = url.searchParams.get( 'player' ) || crypto.randomUUID();

		const info = { socket: server, room, player };
		this.clients.add( info );

		const existing = [ ...this.lastByPlayer.values() ].filter( ( state ) => state.player !== player );
		for ( const state of existing ) {

			server.send( JSON.stringify( state ) );

		}

		server.addEventListener( 'message', ( event ) => {

			let msg;
			try {

				msg = JSON.parse( event.data );

			} catch {

				return;

			}

			if ( ! msg || typeof msg !== 'object' ) return;
			if ( msg.type === 'state' && msg.player ) this.lastByPlayer.set( msg.player, msg );
			if ( msg.type === 'leave' && msg.player ) this.lastByPlayer.delete( msg.player );

			const text = JSON.stringify( msg );
			for ( const peer of this.clients ) {

				if ( peer.socket === server ) continue;
				try {

					peer.socket.send( text );

				} catch {

					// dropped socket
				}

			}

		} );

		const cleanup = () => {

			this.clients.delete( info );
			this.lastByPlayer.delete( player );
			const leaveMsg = JSON.stringify( { type: 'leave', player, room, t: Date.now() } );
			for ( const peer of this.clients ) {

				try {

					peer.socket.send( leaveMsg );

				} catch {

					// dropped socket
				}

			}

		};

		server.addEventListener( 'close', cleanup );
		server.addEventListener( 'error', cleanup );

		return new Response( null, { status: 101, webSocket: client } );

	}

}
