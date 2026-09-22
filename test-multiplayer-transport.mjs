// Multiplayer transport test suite.
//
// Simulates every device/network class the game faces:
//   1. Normal home network (WebRTC fine)
//   2. Symmetric NAT / CGNAT (needs TURN relay creds)
//   3. School network: PeerJS cloud blocked, Firebase works
//   4. School network: Firebase blocked, PeerJS works
//   5. Flapping network (transient signalling errors → retry ladder)
//   6. Bad TURN credentials endpoint (degrades to STUN-only, never throws)
//
// Run: node test-multiplayer-transport.mjs

import assert from 'node:assert/strict';
import {
	classifyPeerError,
	peerRetryDelayMs,
	isFirebaseNetworkError,
	describeSelectedIcePair,
} from './js/mp-net.js';
import {
	resolveIceServers,
	resetIceServersForTests,
	TURN_STUN_SERVERS,
	TURN_STATIC_CREDENTIALS,
	TURN_CREDENTIALS_URL,
	TURN_RELAY_URLS,
} from './js/turn-config.js';

let passed = 0;
function test( name, fn ) {

	return Promise.resolve()
		.then( fn )
		.then( () => { passed++; console.log( `  ✓ ${ name }` ); } )
		.catch( ( error ) => {

			console.error( `  ✗ ${ name }` );
			console.error( `    ${ error?.message || error }` );
			process.exitCode = 1;

		} );

}

console.log( '--- PeerJS error classification (device class → behavior) ---' );
await test( 'flapping network: network error is retryable', () => {

	assert.equal( classifyPeerError( { type: 'network' } ), 'retryable' );

} );
await test( 'signalling server hiccup: server-error is retryable', () => {

	assert.equal( classifyPeerError( { type: 'server-error' } ), 'retryable' );

} );
await test( 'socket broke mid-session: socket-error/socket-closed retryable', () => {

	assert.equal( classifyPeerError( { type: 'socket-error' } ), 'retryable' );
	assert.equal( classifyPeerError( { type: 'socket-closed' } ), 'retryable' );

} );
await test( 'room genuinely absent: peer-unavailable is NOT retried blindly', () => {

	assert.equal( classifyPeerError( { type: 'peer-unavailable' } ), 'unavailable' );

} );
await test( 'no WebRTC support: browser-incompatible is fatal', () => {

	assert.equal( classifyPeerError( { type: 'browser-incompatible' } ), 'fatal' );

} );
await test( 'unknown error types never crash the classifier', () => {

	assert.equal( classifyPeerError( {} ), 'unknown' );
	assert.equal( classifyPeerError( null ), 'unknown' );
	assert.equal( classifyPeerError( new Error( 'weird' ) ), 'unknown' );

} );

console.log( '--- Retry backoff ladder ---' );
await test( 'backoff is 1s → 2.5s → 5s (capped)', () => {

	assert.equal( peerRetryDelayMs( 0 ), 1000 );
	assert.equal( peerRetryDelayMs( 1 ), 2500 );
	assert.equal( peerRetryDelayMs( 2 ), 5000 );
	assert.equal( peerRetryDelayMs( 3 ), 5000 );
	assert.equal( peerRetryDelayMs( 99 ), 5000 );

} );

console.log( '--- Firebase failure classification ---' );
await test( 'network-level failures are recognized (fetch TypeError)', () => {

	assert.equal( isFirebaseNetworkError( new TypeError( 'fetch failed' ) ), true );

} );
await test( 'our own abort timeout is a network failure, not "room missing"', () => {

	const abort = new DOMException ? new DOMException( 'signal timed out', 'AbortError' ) : { name: 'AbortError', message: 'signal timed out' };
	assert.equal( isFirebaseNetworkError( abort ), true );

} );
await test( 'HTTP 401 permission denial is NOT a network failure', () => {

	assert.equal( isFirebaseNetworkError( new Error( 'room-http-401' ) ), false );

} );
await test( 'null/garbage errors are not network failures', () => {

	assert.equal( isFirebaseNetworkError( null ), false );
	assert.equal( isFirebaseNetworkError( undefined ), false );

} );

console.log( '--- ICE telemetry parsing (what did we actually connect over?) ---' );
const fakeStats = ( pairs, candidates ) => ( {

	forEach( cb ) {

		for ( const pair of pairs ) cb( pair );
		for ( const candidate of candidates ) cb( candidate );

	},

} );
await test( 'direct srflx pair is described as direct', () => {

	const stats = fakeStats(
		[ { type: 'candidate-pair', id: 'p1', selected: true, localCandidateId: 'l1', remoteCandidateId: 'r1' } ],
		[
			{ type: 'local-candidate', id: 'l1', candidateType: 'srflx', protocol: 'udp' },
			{ type: 'remote-candidate', id: 'r1', candidateType: 'host', protocol: 'udp' },
		],
	);
	const desc = describeSelectedIcePair( stats );
	assert.equal( desc.kind, 'srflx' );
	assert.ok( desc.description.includes( 'udp' ) );

} );
await test( 'TURN relay pair is described as relay with relay protocol', () => {

	const stats = fakeStats(
		[ { type: 'candidate-pair', id: 'p1', selected: true, localCandidateId: 'l1', remoteCandidateId: 'r1' } ],
		[
			{ type: 'local-candidate', id: 'l1', candidateType: 'relay', protocol: 'tcp', relayProtocol: 'tls' },
			{ type: 'remote-candidate', id: 'r1', candidateType: 'srflx', protocol: 'tcp' },
		],
	);
	const desc = describeSelectedIcePair( stats );
	assert.equal( desc.kind, 'relay' );
	assert.ok( desc.description.includes( 'relay: tls' ) );

} );
await test( 'no selected pair yet → null, never throws', () => {

	assert.equal( describeSelectedIcePair( fakeStats( [], [] ) ), null );
	assert.equal( describeSelectedIcePair( null ), null );

} );
await test( 'Map-style stats objects are supported', () => {

	const stats = new Map( [
		[ 'p1', { type: 'candidate-pair', id: 'p1', nominated: true, state: 'succeeded', localCandidateId: 'l1', remoteCandidateId: 'r1' } ],
		[ 'l1', { type: 'local-candidate', id: 'l1', candidateType: 'host', protocol: 'udp' } ],
		[ 'r1', { type: 'remote-candidate', id: 'r1', candidateType: 'host', protocol: 'udp' } ],
	] );
	const desc = describeSelectedIcePair( stats );
	assert.equal( desc.kind, 'direct' );

} );

console.log( '--- ICE config resolution ---' );
await test( 'default config (no signup): STUN-only, openrelay absent, never throws', async () => {

	resetIceServersForTests();
	const iceServers = await resolveIceServers();
	assert.ok( iceServers.length >= TURN_STUN_SERVERS.length );
	const urls = JSON.stringify( iceServers );
	assert.ok( ! urls.includes( 'openrelay' ), 'openrelay must be fully gone' );
	assert.equal( TURN_CREDENTIALS_URL, '', 'no external credential endpoint by default' );
	assert.equal( TURN_STATIC_CREDENTIALS.username, '', 'no static creds by default' );

} );
await test( 'ICE entries always carry a urls array (RTCPeerConnection shape)', async () => {

	resetIceServersForTests();
	for ( const server of await resolveIceServers() ) {

		assert.ok( Array.isArray( server.urls ) || typeof server.urls === 'string' );
		assert.notEqual( server.urls, undefined );

	}

} );

console.log( '--- Runtime credential fetch (rotating creds via URL) ---' );
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {

	fetchCalls++;
	return { ok: true, json: async () => ( { username: 'ephemeral-user', credential: 'ephemeral-pass', ttlMs: 50 } ) };

};
await test( 'credentials from URL are merged into TURN entries', async () => {

	resetIceServersForTests();
	const iceServers = await resolveIceServers( { credentialsUrl: 'https://example.test/turn' } );
	const turnEntry = iceServers.find( ( s ) => s.username === 'ephemeral-user' );
	assert.ok( turnEntry, 'TURN entry with fetched creds must exist' );
	assert.equal( turnEntry.credential, 'ephemeral-pass' );
	assert.deepEqual( turnEntry.urls, TURN_RELAY_URLS );

} );
await test( 'fetched credentials are cached until TTL expires', async () => {

	fetchCalls = 0;
	await resolveIceServers( { credentialsUrl: 'https://example.test/turn' } ); // cache hit — no new fetch
	assert.equal( fetchCalls, 0 );
	await new Promise( ( r ) => setTimeout( r, 60 ) );
	await resolveIceServers( { credentialsUrl: 'https://example.test/turn' } ); // TTL expired → re-fetch
	assert.equal( fetchCalls, 1 );

} );
globalThis.fetch = async () => { throw new TypeError( 'fetch failed' ); };
await test( 'dead credential endpoint degrades to STUN-only, never throws', async () => {

	resetIceServersForTests();
	const iceServers = await resolveIceServers( { credentialsUrl: 'https://example.test/turn' } );
	assert.equal( iceServers.length, TURN_STUN_SERVERS.length );

} );
globalThis.fetch = originalFetch;

console.log( `\n${ passed } tests passed${ process.exitCode ? ' — WITH FAILURES' : '' }` );
