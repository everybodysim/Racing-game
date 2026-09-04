// Pure multiplayer transport helpers. No side effects, no browser APIs —
// imported by js/main.js AND by test-multiplayer-transport.mjs (Node) so the
// decision logic stays unit-testable.

// --- PeerJS error classification ------------------------------------------
//
// PeerJS error types (peerjs/src/broker + util errors):
//   'network'              — lost connection to the signalling server → retry
//   'server-error'         — server-side error → retry (often transient)
//   'socket-error'         — signalling socket broke → retry
//   'socket-closed'        — signalling socket closed unexpectedly → retry
//   'peer-unavailable'     — the target peer id doesn't exist (room not hosted)
//   'unavailable-id'       — the id we wanted is taken (used by host election)
//   'browser-incompatible'— no WebRTC support → fatal
//   'webrtc'/'secure'...   — other WebRTC errors → don't blind-retry these
export function classifyPeerError( error ) {

	const type = String( error?.type || '' );
	switch ( type ) {

		case 'network':
		case 'server-error':
		case 'socket-error':
		case 'socket-closed':
			return 'retryable';
		case 'peer-unavailable':
			return 'unavailable';
		case 'browser-incompatible':
			return 'fatal';
		default:
			return 'unknown';

	}

}

// Backoff schedule for transient PeerJS signalling failures: 1s / 2.5s / 5s.
export function peerRetryDelayMs( attempt ) {

	if ( ! Number.isFinite( attempt ) || attempt <= 0 ) return 1000;
	if ( attempt === 1 ) return 2500;
	return 5000;

}

// --- Firebase REST failure classification ---------------------------------
//
// firebaseRoomsRequest() (js/main.js) turns fetch/abort failures into thrown
// errors. Network-level failures (offline, DNS block, school firewall, our own
// 2.2s abort timeout) must NOT be treated like "room doesn't exist" — the room
// may be perfectly fine over the PeerJS mesh, Firebase is just unreachable.
export function isFirebaseNetworkError( error ) {

	if ( ! error ) return false;
	if ( error instanceof TypeError ) return true; // fetch: "Failed to fetch"
	const name = String( error?.name || '' );
	if ( name === 'AbortError' ) return true; // our FIREBASE_ROOM_TIMEOUT_MS abort
	const message = String( error?.message || '' ).toLowerCase();
	if ( message.includes( 'failed to fetch' ) ) return true;
	if ( message.includes( 'network' ) ) return true;
	if ( message.includes( 'load failed' ) ) return true;
	return false;

}

// --- ICE transport telemetry ----------------------------------------------
//
// Given an RTCStatsReport (or any iterable/Map of stat objects), find the
// selected candidate pair and describe it in one human-readable line so every
// "it doesn't work" report comes with data: are we direct (host/srflx), or
// relayed through TURN, and over which protocol?
export function describeSelectedIcePair( stats ) {

	if ( ! stats ) return null;

	const pairs = [];
	const candidates = new Map();
	const visit = ( item ) => {

		if ( ! item || typeof item !== 'object' ) return;
		if ( item.type === 'candidate-pair' ) pairs.push( item );
		if ( item.type === 'local-candidate' || item.type === 'remote-candidate' ) {

			candidates.set( item.id, item );

		}

	};

	if ( typeof stats.forEach === 'function' ) {

		stats.forEach( ( value ) => visit( value ) );

	} else if ( typeof stats[ Symbol.iterator ] === 'function' ) {

		for ( const [ , value ] of stats ) visit( value );

	} else if ( stats.result && typeof stats.result === 'function' ) {

		// Legacy Chrome callback-based API.
		for ( const entry of stats.result() ) {

			visit( { type: entry.type, id: entry.id, ...entry.stat ? entry.stat() : {} } );

		}

	}

	let selected = pairs.find( ( pair ) => pair.selected === true || pair.nominated === true );
	if ( ! selected ) selected = pairs.find( ( pair ) => pair.state === 'succeeded' );
	if ( ! selected ) return null;

	const local = candidates.get( selected.localCandidateId );
	const remote = candidates.get( selected.remoteCandidateId );
	const localType = local?.candidateType || '?';
	const remoteType = remote?.candidateType || '?';
	const relayProtocol = local?.relayProtocol || remote?.relayProtocol || '';
	const protocol = local?.protocol || remote?.protocol || '?';

	let kind = 'direct';
	if ( localType === 'relay' || remoteType === 'relay' ) kind = 'relay';
	else if ( localType === 'srflx' || remoteType === 'srflx' ) kind = 'srflx';

	const viaRelay = kind === 'relay' && relayProtocol ? ` (relay: ${ relayProtocol })` : '';
	const description = `${ kind } — local ${ localType } → remote ${ remoteType } over ${ protocol }${ viaRelay }`;
	return { kind, localType, remoteType, protocol, relayProtocol, description };

}
