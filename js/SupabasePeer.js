// ─────────────────────────────────────────────────────────────────────────────
// SupabasePeer — a PeerJS-compatible multiplayer transport that runs over
// Supabase Realtime (broadcast + presence) instead of WebRTC.
//
// Why: PeerJS is peer-to-peer — the host's browser tab is the "server", so a
// laggy/throttled host lags everyone, a closed tab kills the room, and NAT
// handshakes randomly fail. Supabase runs real managed servers: the room
// survives any player leaving, connections auto-reconnect, and nobody's
// laptop is a single point of failure.
//
// The class mimics the exact slice of the PeerJS API the game already uses:
//   new Peer( id, config )
//   peer.on( 'open' | 'connection' | 'error' | 'disconnected' | 'close' )
//   const conn = peer.connect( targetId, { reliable: true } )
//   conn.on( 'open' | 'data' | 'close' | 'error' )
//   conn.send( obj ) / conn.close() / conn.peer / conn.open
//   peer.destroy()
// so the game's multiplayer packet handlers need zero changes.
//
// Room model: every RACE-ROOM-<code> maps to one Supabase Realtime channel,
// shared by every SupabasePeer in this tab that belongs to that room.
//   • Presence (who's in the room) drives connection 'close' events — when
//     someone's presence vanishes (tab closed, wifi dropped), their conns
//     close cleanly for everyone else.
//   • A claiming host broadcasts a periodic 'host' beacon. A new claimant
//     listens briefly first; if it hears a beacon it emits the PeerJS-style
//     'unavailable-id' error (the game's host-takeover probe relies on that).
//   • Sends are coalesced into ≤40ms batches to stay well inside Realtime's
//     per-client message limits even with many cars streaming 30Hz poses —
//     but every batched item is delivered as its own 'data' event, so
//     receiver code sees exactly what PeerJS delivered.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Project credentials ──────────────────────────────────────────────────────
// The anon key is designed to be public: it only grants access gated by Row
// Level Security, and racing rooms need no database tables at all. Fill these
// in once after creating the project at https://supabase.com.
let SUPABASE_URL = 'https://qgpzrqepnclaocerowgk.supabase.co';
let SUPABASE_ANON_KEY = 'sb_publishable_ihLanRNKK65DmybkYPBI0Q_qDixxWZB';
// Runtime override: setting localStorage 'sc-supabase-url' / 'sc-supabase-key'
// lets credentials be swapped without editing code.
try {
	SUPABASE_URL = localStorage.getItem( 'sc-supabase-url' ) || SUPABASE_URL;
	SUPABASE_ANON_KEY = localStorage.getItem( 'sc-supabase-key' ) || SUPABASE_ANON_KEY;
} catch { /* private mode */ }

let sharedClient = null;
function getClient() {
	if ( ! SUPABASE_URL || ! SUPABASE_ANON_KEY ) {
		throw new Error( '[SupabasePeer] Not configured: set SUPABASE_URL and SUPABASE_ANON_KEY in js/SupabasePeer.js' );
	}
	// The bare project host is required (a /rest/v1 suffix breaks Realtime).
	const rtUrl = SUPABASE_URL.replace( /\/rest\/v1\/?$/, '' ).replace( /\/+$/, '' );
	if ( ! sharedClient ) {
		sharedClient = createClient( rtUrl, SUPABASE_ANON_KEY, {
			realtime: { params: { eventsPerSecond: 100 } },
			auth: { persistSession: false, autoRefreshToken: false },
		} );
	}
	return sharedClient;
}

function roomKeyFor( peerId ) {
	return 'room-' + String( peerId ).replace( ROOM_PREFIX_RE, '' ).toLowerCase();
}
function randomId() {
	return 'sc-' + Math.random().toString( 36 ).slice( 2, 10 ) + Date.now().toString( 36 ).slice( -4 );
}
function emitter() {
	const map = new Map();
	return {
		on( ev, cb ) {
			if ( ! map.has( ev ) ) map.set( ev, [] );
			map.get( ev ).push( cb );
			return this;
		},
		emit( ev, ...args ) {
			for ( const cb of map.get( ev ) || [] ) {
				try { cb( ...args ); } catch ( e ) { console.error( '[SupabasePeer] listener error', e ); }
			}
		},
	};
}

// Game room ids (RACE-ROOM-<code>) map to channel "room-<code>"; other
// explicit ids (e.g. EDITOR-ROOM-<code>) keep their full slug.
const ROOM_PREFIX_RE = /^RACE-ROOM-/;

// One Realtime room per RACE-ROOM-<code>, shared across every SupabasePeer in
// this tab. The channel's listeners dispatch to all attached peers.
const rooms = new Map();
function getRoom( code ) {
	let room = rooms.get( code );
	if ( room ) {
		room.refCount++;
		return room;
	}
	room = {
		code,
		refCount: 1,
		channel: null,
		subscribed: false,
		waiters: [],
		handlers: new Set(),   // attached SupabasePeer instances
		live: new Set(),       // presence keys currently in the room
		_cleanup: null,
	};
	rooms.set( code, room );
	return room;
}
function releaseRoom( room ) {
	room.refCount--;
	if ( room.refCount > 0 ) return;
	rooms.delete( room.code );
	if ( room._cleanup ) clearTimeout( room._cleanup );
	if ( room.channel ) {
		const ch = room.channel;
		room.channel = null;
		try { getClient().removeChannel( ch ); } catch { /* already gone */ }
	}
}
function whenReady( room ) {
	if ( room.subscribed ) return Promise.resolve();
	return new Promise( ( resolve ) => room.waiters.push( resolve ) );
}
function openChannel( room, presenceKeyId ) {
	const client = getClient();
	const ch = client.channel( room.code, {
		config: {
			broadcast: { self: false, ack: false },
			presence: { key: presenceKeyId },
		},
	} );
	room.channel = ch;
	ch.on( 'broadcast', { event: 'm' }, ( msg ) => {
		const env = msg && msg.payload;
		for ( const h of room.handlers ) h._onBroadcast( env );
	} );
	ch.on( 'presence', { event: 'sync' }, () => {
		const state = ch.presenceState ? ch.presenceState() : {};
		const live = new Set( Object.keys( state ) );
		const left = [ ...room.live ].filter( ( id ) => ! live.has( id ) );
		room.live = live;
		for ( const h of room.handlers ) h._onPresence( live, left );
	} );
	ch.subscribe( ( status ) => {
		if ( status === 'SUBSCRIBED' ) {
			room.subscribed = true;
			for ( const w of room.waiters ) w();
			room.waiters.length = 0;
		} else if ( status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ) {
			for ( const h of room.handlers ) h._netError( status );
		}
	} );
	return ch;
}
function bcast( room, env ) {
	if ( room.channel && room.subscribed ) {
		room.channel.send( { type: 'broadcast', event: 'm', payload: env } );
	}
}

const HOST_BEACON_MS = 2500;
// Data flush window: one room broadcast per window => ~15 broadcasts/s per
// page, safely under Supabase free tier's ~20 messages/s per client cap.
const DATA_FLUSH_MS = 66;
const CLAIM_LISTEN_MS = 350;

class SupabaseConnection {
	constructor( peer, remoteId, isInitiator ) {
		this.peer = remoteId;                 // PeerJS compat: remote peer id
		this.open = false;
		this._peer = peer;
		this._room = peer._room;
		this._me = peer._myId;
		this._ev = emitter();
		this._sendQueue = [];
		this._helloTimer = null;
		this._helloTries = 0;
		this._closed = false;
		this._isInitiator = isInitiator;
		if ( isInitiator ) this._startHello();
	}

	on( ev, cb ) { this._ev.on( ev, cb ); return this; }
	_on( ev, ...args ) { this._ev.emit( ev, ...args ); }

	_startHello() {
		whenReady( this._room ).then( () => {
			if ( this._closed || this.open ) return;
			bcast( this._room, this._peer._stamp( { k: 'hello', from: this._me, to: this.peer } ) );
			this._helloTimer = setTimeout( () => {
				this._helloTries++;
				if ( ! this._closed && ! this.open && this._helloTries < 12 ) this._startHello();
				else if ( ! this._closed && ! this.open ) this.close();
			}, 500 );
		} );
	}

	_stopHello() {
		if ( this._helloTimer ) { clearTimeout( this._helloTimer ); this._helloTimer = null; }
	}

	_gotAck() {
		this._stopHello();
		if ( this.open ) return;
		this.open = true;
		this._on( 'open' );
	}

	// One message per 'data' event on receive (we un-batch on arrival); on the
	// wire every connection's queue is bundled into ONE room broadcast per
	// flush window. Supabase's free tier drops messages past ~20 broadcasts
	// per second per client, so the transport paces itself under that cap:
	// one broadcast every DATA_FLUSH_MS no matter how many connections or
	// how hot the 30Hz pose streams are.
	send( data ) {
		if ( this._closed ) throw new Error( 'Connection is closed' );
		this._sendQueue.push( data );
		this._peer._armDataFlush();
	}

	close() {
		if ( this._closed ) return;
		this._closed = true;
		this._stopHello();
		bcast( this._room, this._peer._stamp( { k: 'bye', from: this._me, to: this.peer } ) );
		this._peer._dropConn( this.peer );
		this._ev.emit( 'close' );
	}
}

class SupabasePeer {
	constructor( id, _config ) {
		this.id = null;
		this._destroyed = false;
		this._opening = false;
		// PeerJS semantics: an explicit id means the peer CLAIMS that id.
		// Any prefix works (RACE-ROOM-, EDITOR-ROOM-, custom).
		this._isHostClaim = !! id;
		this._myId = this._isHostClaim ? id : ( id || randomId() );
		this._token = 'tk-' + randomId();
		this._ev = emitter();
		this._room = null;
		this._conns = new Map();      // remoteId -> SupabaseConnection
		this._hostBeacon = null;
		this._claimTimer = null;
		this._resolved = false;
		this._pendingHellos = [];
		this._dataTimer = null;
		if ( this._isHostClaim ) {
			this._resolveHostClaim();
		} else {
			this.id = this._myId;
			setTimeout( () => this._ev.emit( 'open', this.id ), 0 );
		}
	}

	on( ev, cb ) { this._ev.on( ev, cb ); return this; }

	_emitError( type, message ) {
		const err = new Error( message || type );
		err.type = type;
		this._ev.emit( 'error', err );
	}

	_attach( roomKey ) {
		const room = getRoom( roomKey );
		this._room = room;
		room.handlers.add( this );
		if ( ! room.channel ) openChannel( room, this._myId );
		return room;
	}

	// A host claim (explicit id): listen briefly for an existing
	// host's beacon, then claim (beacon + 'open'), or emit 'unavailable-id'.
	_resolveHostClaim() {
		const room = this._attach( roomKeyFor( this._myId ) );
		this._heardHost = false;
		whenReady( room ).then( () => {
			if ( this._destroyed ) return;
			// Ask any live host to identify itself right now, then listen briefly.
			bcast( room, this._stamp( { k: 'whois', from: this._myId, to: '*' } ) );
			this._claimTimer = setTimeout( () => {
				this._claimTimer = null;
				if ( this._destroyed ) return;
				if ( this._heardHost ) {
					room.handlers.delete( this );
					releaseRoom( room );
					this._room = null;
					this._emitError( 'unavailable-id', `ID "${ this._myId }" is taken` );
					return;
				}
				this._finishOpen();
				this._beaconHost();
				this._hostBeacon = setInterval( () => {
					if ( ! this._destroyed ) this._beaconHost();
				}, HOST_BEACON_MS );
			}, CLAIM_LISTEN_MS );
		} );
	}

	_finishOpen() {
		if ( this._destroyed || this._resolved ) return;
		this._resolved = true;
		this.id = this._myId;
		this._ev.emit( 'open', this.id );
		// Handshakes that arrived mid-claim now process in order.
		const hellos = this._pendingHellos;
		this._pendingHellos = [];
		for ( const env of hellos ) this._handleHello( env );
	}

	_handleHello( env ) {
		const conn = new SupabaseConnection( this, env.from, false );
		this._conns.set( env.from, conn );
		this._ev.emit( 'connection', conn );
		conn.open = true;
		conn._on( 'open' );
		bcast( this._room, this._stamp( { k: 'ack', from: this._myId, to: env.from } ) );
	}

	_stamp( env ) {
		env.tk = this._token;
		return env;
	}

	_beaconHost() {
		bcast( this._room, this._stamp( { k: 'host', from: this._myId, to: this._myId } ) );
	}

	// ── room event dispatch (called by the shared channel) ──────────────────
	_onBroadcast( env ) {
		if ( ! env || typeof env !== 'object' || env.tk === this._token ) return;
		switch ( env.k ) {
			case 'host':
				if ( this._isHostClaim && ! this._resolved ) this._heardHost = true;
				break;
			case 'whois':
				// A claiming peer is probing for a live host — answer immediately.
				if ( this._resolved && this._isHostClaim && ! this._destroyed ) {
					this._beaconHost();
				}
				break;
			case 'hello':
				if ( env.to !== this._myId ) break;
				if ( ! this._resolved ) { this._pendingHellos.push( env ); break; }
				if ( ! this._conns.has( env.from ) ) {
					this._handleHello( env );
				} else {
					// stray duplicate hello → re-ack so the joiner opens
					bcast( this._room, this._stamp( { k: 'ack', from: this._myId, to: env.from } ) );
				}
				break;
			case 'ack':
				if ( env.to === this._myId ) {
					const conn = this._conns.get( env.from );
					if ( conn ) conn._gotAck();
				}
				break;
			case 'data': {
				const conn = this._conns.get( env.from );
				if ( ! conn ) break;
				if ( Array.isArray( env.items ) ) {
					for ( const item of env.items ) {
						if ( item && item.to === this._myId && Array.isArray( item.b ) ) {
							for ( const x of item.b ) conn._on( 'data', x );
						}
					}
				} else if ( env.to === this._myId && Array.isArray( env.b ) ) {
					for ( const item of env.b ) conn._on( 'data', item );
				}
				break;
			}
			case 'bye': {
				if ( env.to !== this._myId ) return;
				const conn = this._conns.get( env.from );
				if ( conn && ! conn._closed ) conn.close();
				break;
			}
		}
	}

	_onPresence( live, left ) {
		for ( const remoteId of left ) {
			if ( remoteId === this._myId ) continue;
			const conn = this._conns.get( remoteId );
			if ( conn && ! conn._closed ) {
				conn._closed = true;    // remote is gone: no 'bye' needed
				conn._stopHello();
				this._dropConn( remoteId );
				conn._on( 'close' );
			}
		}
	}

	_netError( status ) {
		if ( ! this._resolved ) {
			this._emitError( 'server-error', `Realtime channel error: ${ status }` );
		} else {
			this._ev.emit( 'disconnected' );
		}
	}

	_dropConn( remoteId ) {
		this._conns.delete( remoteId );
	}

	// ── rate-limit-safe data flushing ────────────────────────────────────
	// All connections' queued messages leave as a single broadcast carrying
	// per-recipient items; receivers pick out items addressed to them. This
	// keeps total broadcasts per page at ~1000/DATA_FLUSH_MS per second,
	// under Supabase's free-tier per-client message cap.
	_armDataFlush() {
		if ( this._dataTimer || this._destroyed ) return;
		this._dataTimer = setTimeout( () => {
			this._dataTimer = null;
			this._flushDataOut();
		}, DATA_FLUSH_MS );
	}

	_flushDataOut() {
		if ( this._destroyed || ! this._room ) return;
		const items = [];
		for ( const conn of this._conns.values() ) {
			if ( conn._closed || ! conn._sendQueue.length ) continue;
			items.push( { to: conn.peer, b: conn._sendQueue } );
			conn._sendQueue = [];
		}
		if ( ! items.length ) return;
		whenReady( this._room ).then( () => {
			if ( this._destroyed ) return;
			// Conns may have queued more while waiting; re-arm instead of
			// bursting a second broadcast.
			if ( this._dataTimer ) { this._stashItems( items ); return; }
			bcast( this._room, this._stamp( { k: 'data', from: this._myId, items } ) );
			// Anything queued during the await rides the next window.
			let more = false;
			for ( const conn of this._conns.values() ) if ( conn._sendQueue.length ) { more = true; break; }
			if ( more ) this._armDataFlush();
		} );
	}

	_stashItems( items ) {
		// A broadcast is already scheduled; put these items back so they
		// ride that window (prepend keeps per-recipient ordering).
		for ( const item of items ) {
			const conn = this._conns.get( item.to );
			if ( conn ) conn._sendQueue = item.b.concat( conn._sendQueue );
		}
	}

	// ── public API ───────────────────────────────────────────────────────────
	connect( targetId, _opts ) {
		if ( this._destroyed ) throw new Error( 'Peer is destroyed' );
		// Joiners belong to the room named after the host id they dial.
		if ( ! this._room ) this._attach( roomKeyFor( targetId ) );
		const conn = new SupabaseConnection( this, targetId, true );
		this._conns.set( targetId, conn );
		return conn;
	}

	destroy() {
		if ( this._destroyed ) return;
		this._destroyed = true;
		if ( this._claimTimer ) { clearTimeout( this._claimTimer ); this._claimTimer = null; }
		if ( this._hostBeacon ) { clearInterval( this._hostBeacon ); this._hostBeacon = null; }
		if ( this._dataTimer ) { clearTimeout( this._dataTimer ); this._dataTimer = null; }
		for ( const conn of this._conns.values() ) {
			if ( ! conn._closed ) conn.close();
		}
		this._conns.clear();
		if ( this._room ) {
			this._room.handlers.delete( this );
			releaseRoom( this._room );
			this._room = null;
		}
		this._ev.emit( 'close' );
	}
}

export default SupabasePeer;
