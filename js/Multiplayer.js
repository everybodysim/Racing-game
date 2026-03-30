const DEFAULT_SEND_INTERVAL_MS = 80;

function randomId() {

	if ( typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ) return crypto.randomUUID();
	return `p-${ Math.random().toString( 36 ).slice( 2, 10 ) }`;

}

export class MultiplayerClient {

	constructor( { roomId, playerId, carKey, wsBaseUrl, onMessage } ) {

		this.roomId = roomId;
		this.playerId = playerId || randomId();
		this.carKey = carKey || 'vehicle-truck-yellow';
		this.wsBaseUrl = wsBaseUrl;
		this.onMessage = onMessage;

		this.ws = null;
		this.connected = false;
		this.closed = false;
		this.reconnectTimer = null;

		this.lastSendAt = 0;
		this.sendIntervalMs = DEFAULT_SEND_INTERVAL_MS;

	}

	connect() {

		if ( ! this.wsBaseUrl || ! this.roomId ) return;
		if ( this.closed ) return;
		if ( this.ws && ( this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING ) ) return;

		const url = new URL( this.wsBaseUrl );
		url.searchParams.set( 'room', this.roomId );
		url.searchParams.set( 'player', this.playerId );

		const ws = new WebSocket( url.toString() );
		this.ws = ws;

		ws.addEventListener( 'open', () => {

			this.connected = true;
			this.send( {
				type: 'join',
				player: this.playerId,
				room: this.roomId,
				car: this.carKey,
				t: Date.now(),
			} );

		} );

		ws.addEventListener( 'message', ( event ) => {

			try {

				const msg = JSON.parse( event.data );
				if ( this.onMessage ) this.onMessage( msg );

			} catch ( e ) {

				console.warn( 'Invalid multiplayer message', e );

			}

		} );

		const onDisconnect = () => {

			this.connected = false;
			if ( this.closed ) return;
			clearTimeout( this.reconnectTimer );
			this.reconnectTimer = setTimeout( () => this.connect(), 1200 );

		};

		ws.addEventListener( 'close', onDisconnect );
		ws.addEventListener( 'error', onDisconnect );

	}

	setCar( carKey ) {

		this.carKey = carKey;
		this.send( {
			type: 'car',
			player: this.playerId,
			car: this.carKey,
			t: Date.now(),
		} );

	}

	sendState( state ) {

		const now = Date.now();
		if ( now - this.lastSendAt < this.sendIntervalMs ) return;
		this.lastSendAt = now;

		this.send( {
			type: 'state',
			player: this.playerId,
			car: this.carKey,
			t: now,
			...state,
		} );

	}

	send( payload ) {

		if ( ! this.ws || this.ws.readyState !== WebSocket.OPEN ) return;
		this.ws.send( JSON.stringify( payload ) );

	}

	disconnect() {

		this.closed = true;
		clearTimeout( this.reconnectTimer );
		if ( this.ws && this.ws.readyState === WebSocket.OPEN ) {

			this.send( { type: 'leave', player: this.playerId, room: this.roomId, t: Date.now() } );

		}

		this.ws?.close();
		this.ws = null;

	}

}

function hashRoomKey( value ) {

	let h = 2166136261;
	for ( let i = 0; i < value.length; i ++ ) {

		h ^= value.charCodeAt( i );
		h += ( h << 1 ) + ( h << 4 ) + ( h << 7 ) + ( h << 8 ) + ( h << 24 );

	}
	return ( h >>> 0 ).toString( 36 );

}

export function readMultiplayerConfig() {

	const params = new URLSearchParams( window.location.search );
	const mapKey = params.get( 'map' ) || 'default';
	const modsKey = params.get( 'mods' ) || '';
	const derivedRoom = `map-${ hashRoomKey( `${ mapKey }|${ modsKey }` ) }`;
	const roomId = params.get( 'room' ) || derivedRoom;
	const playerId = params.get( 'player' ) || randomId();
	const wsParam = params.get( 'ws' );

	let wsBaseUrl = wsParam;
	if ( ! wsBaseUrl ) {

		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		wsBaseUrl = `${ protocol }//${ window.location.host }/ws`;

	}

	return { roomId, playerId, wsBaseUrl };

}
