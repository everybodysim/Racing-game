const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const PRESENCE_INTERVAL_MS = 100;
const FIREBASE_CONFIG_STORAGE_KEY = 'racing-firebase-config-v1';

function randomRoomCode() {
	let code = '';
	for ( let i = 0; i < ROOM_CODE_LENGTH; i ++ ) {

		code += ROOM_CODE_CHARS[ Math.floor( Math.random() * ROOM_CODE_CHARS.length ) ];

	}
	return code;
}

function readFirebaseConfig() {

	if ( window.__RACING_FIREBASE_CONFIG && typeof window.__RACING_FIREBASE_CONFIG === 'object' ) return window.__RACING_FIREBASE_CONFIG;

	try {

		const parsed = JSON.parse( localStorage.getItem( FIREBASE_CONFIG_STORAGE_KEY ) || 'null' );
		if ( parsed && typeof parsed === 'object' ) return parsed;

	} catch {

		// Ignore parse errors.

	}

	return null;

}

export class FirebaseMultiplayer {

	constructor( { mapId, getLocalSnapshot, onRemotePlayers, onStatus, onError } ) {

		this.mapId = mapId;
		this.getLocalSnapshot = getLocalSnapshot;
		this.onRemotePlayers = onRemotePlayers;
		this.onStatus = onStatus;
		this.onError = onError;
		this.playerId = crypto.randomUUID().slice( 0, 8 );
		this.roomCode = null;
		this.isHost = false;
		this.sendInterval = null;
		this.unsubPlayers = null;
		this.dbApi = null;
		this.db = null;
		this.connected = false;
		this.disconnectOps = [];

	}

	async ensureReady() {

		if ( this.connected ) return;
		const firebaseConfig = readFirebaseConfig();
		if ( ! firebaseConfig ) throw new Error( 'Missing Firebase config. Set window.__RACING_FIREBASE_CONFIG or localStorage key racing-firebase-config-v1.' );

		const [ appMod, dbMod ] = await Promise.all( [
			import( 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js' ),
			import( 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js' ),
		] );

		const app = appMod.initializeApp( firebaseConfig );
		this.dbApi = dbMod;
		this.db = dbMod.getDatabase( app );
		this.connected = true;
		this.onStatus?.( 'Firebase connected' );

	}

	async allocateRoomCode() {

		for ( let i = 0; i < 20; i ++ ) {

			const candidate = randomRoomCode();
			const snap = await this.dbApi.get( this.dbApi.ref( this.db, `rooms/${ candidate }` ) );
			if ( ! snap.exists() ) return candidate;

		}

		throw new Error( 'Could not allocate room code. Try again.' );

	}

	async host() {

		await this.ensureReady();
		await this.leave();
		const code = await this.allocateRoomCode();
		this.roomCode = code;
		this.isHost = true;

		const roomRef = this.dbApi.ref( this.db, `rooms/${ code }` );
		await this.dbApi.set( roomRef, {
			hostId: this.playerId,
			mapId: this.mapId,
			status: 'open',
			createdAt: this.dbApi.serverTimestamp(),
		} );

		await this.writeLocalPlayer();
		this.bindDisconnectHandlers();
		this.listenPlayers();
		this.startPresenceLoop();
		this.onStatus?.( `Hosting room ${ code }` );
		return code;

	}

	async join( rawCode ) {

		await this.ensureReady();
		await this.leave();
		const code = String( rawCode || '' ).trim().toUpperCase();
		if ( code.length !== ROOM_CODE_LENGTH ) throw new Error( 'Room code must be 6 characters.' );
		const roomRef = this.dbApi.ref( this.db, `rooms/${ code }` );
		const roomSnap = await this.dbApi.get( roomRef );
		if ( ! roomSnap.exists() ) throw new Error( 'Room not found.' );
		const room = roomSnap.val() || {};
		if ( room.status !== 'open' ) throw new Error( 'Room is not open.' );
		if ( room.mapId !== this.mapId ) throw new Error( 'Map mismatch. Pick the same map as host.' );

		const playersSnap = await this.dbApi.get( this.dbApi.ref( this.db, `rooms/${ code }/players` ) );
		const playerCount = Object.keys( playersSnap.val() || {} ).length;
		if ( playerCount >= 2 ) throw new Error( 'Room already has 2 players.' );

		this.roomCode = code;
		this.isHost = false;
		await this.writeLocalPlayer();
		this.bindDisconnectHandlers();
		this.listenPlayers();
		this.startPresenceLoop();
		this.onStatus?.( `Joined room ${ code }` );

	}

	async writeLocalPlayer() {

		if ( ! this.roomCode ) return;
		const snap = this.getLocalSnapshot?.() || {};
		await this.dbApi.set( this.dbApi.ref( this.db, `rooms/${ this.roomCode }/players/${ this.playerId }` ), {
			id: this.playerId,
			x: Number( snap.x ) || 0,
			y: Number( snap.y ) || 0,
			z: Number( snap.z ) || 0,
			yaw: Number( snap.yaw ) || 0,
			v: Number( snap.v ) || 0,
			t: Date.now(),
		} );

	}

	bindDisconnectHandlers() {

		this.disconnectOps = [];
		if ( ! this.roomCode ) return;
		const playerRef = this.dbApi.ref( this.db, `rooms/${ this.roomCode }/players/${ this.playerId }` );
		const playerDisconnect = this.dbApi.onDisconnect( playerRef );
		playerDisconnect.remove();
		this.disconnectOps.push( playerDisconnect );
		if ( this.isHost ) {

			const roomRef = this.dbApi.ref( this.db, `rooms/${ this.roomCode }` );
			const roomDisconnect = this.dbApi.onDisconnect( roomRef );
			roomDisconnect.remove();
			this.disconnectOps.push( roomDisconnect );

		}

	}

	listenPlayers() {

		if ( ! this.roomCode ) return;
		if ( this.unsubPlayers ) {

			this.unsubPlayers();
			this.unsubPlayers = null;

		}

		const playersRef = this.dbApi.ref( this.db, `rooms/${ this.roomCode }/players` );
		this.unsubPlayers = this.dbApi.onValue( playersRef, ( snap ) => {

			const payload = snap.val() || {};
			const remote = new Map();
			for ( const [ playerId, playerState ] of Object.entries( payload ) ) {

				if ( playerId === this.playerId ) continue;
				remote.set( playerId, playerState );

			}
			this.onRemotePlayers?.( remote );

		} );

	}

	startPresenceLoop() {

		if ( this.sendInterval ) {

			clearInterval( this.sendInterval );
			this.sendInterval = null;

		}

		this.sendInterval = setInterval( () => {

			if ( ! this.roomCode || ! this.db ) return;
			const snap = this.getLocalSnapshot?.();
			if ( ! snap ) return;
			this.dbApi.update( this.dbApi.ref( this.db, `rooms/${ this.roomCode }/players/${ this.playerId }` ), {
				x: Number( snap.x ) || 0,
				y: Number( snap.y ) || 0,
				z: Number( snap.z ) || 0,
				yaw: Number( snap.yaw ) || 0,
				v: Number( snap.v ) || 0,
				t: Date.now(),
			} ).catch( ( error ) => this.onError?.( error ) );

		}, PRESENCE_INTERVAL_MS );

	}

	async leave() {

		if ( this.sendInterval ) {

			clearInterval( this.sendInterval );
			this.sendInterval = null;

		}
		if ( this.unsubPlayers ) {

			this.unsubPlayers();
			this.unsubPlayers = null;

		}
		for ( const op of this.disconnectOps ) {

			try {

				op.cancel();

			} catch {

				// Ignore disconnect cancellation failures.

			}

		}
		this.disconnectOps = [];

		if ( this.db && this.roomCode ) {

			const code = this.roomCode;
			await this.dbApi.remove( this.dbApi.ref( this.db, `rooms/${ code }/players/${ this.playerId }` ) ).catch( () => {} );
			if ( this.isHost ) await this.dbApi.remove( this.dbApi.ref( this.db, `rooms/${ code }` ) ).catch( () => {} );

		}
		this.roomCode = null;
		this.isHost = false;
		this.onRemotePlayers?.( new Map() );
		this.onStatus?.( 'Offline' );

	}

	async dispose() {

		await this.leave();

	}

}
