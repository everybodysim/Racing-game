// Verifies the public-server no-worker rework: deterministic track picking,
// the wall-clock cycle timing math, P2P lap collection, and the host-election
// state machine. Public servers now make ZERO calls to the racing-servers-api
// worker (round/rotation/rankings are all derived locally or P2P), so this
// test no longer simulates KV writes — it asserts the local math instead.
import { strict as assert } from 'node:assert';

// Import the real module (it has no browser-only top-level code besides the
// fetchTrackList fetch, which we don't call here).
const mod = await import( './js/PublicServers.js' );
const { pickTrackForCycle, cycleInfo, ROUND_EPOCH, CYCLE_MS, PLAY_DURATION_MS, RANKINGS_WINDOW_MS } = mod;

// --- Deterministic picker (from the real module) ---
const tracks = [ 'a', 'b', 'c', 'd', 'e' ].map( ( id ) => ( { id, playUrl: `index.html?map=${ id }` } ) );

// Determinism: same cycle + server -> same track, always.
const t1 = pickTrackForCycle( 1000, 'server-1', tracks );
const t2 = pickTrackForCycle( 1000, 'server-1', tracks );
assert.equal( t1.id, t2.id, 'same cycle+server picks same track across calls' );

// Different servers get different sequences (variety), but each is deterministic.
let anyDiffer = false;
for ( let c = 0; c < 20; c++ ) {
	const a = pickTrackForCycle( c, 'server-1', tracks ).id;
	const b = pickTrackForCycle( c, 'server-2', tracks ).id;
	const c2 = pickTrackForCycle( c, 'server-3', tracks ).id;
	if ( new Set( [ a, b, c2 ] ).size >= 2 ) { anyDiffer = true; break; }
}
assert.ok( anyDiffer, 'servers should vary on at least some cycles' );

// Stability: for a FIXED list, the pick for a given cycle never changes.
for ( let c = 0; c < 50; c++ ) {
	const a = pickTrackForCycle( c, 'server-1', tracks ).id;
	const b = pickTrackForCycle( c, 'server-1', tracks ).id;
	assert.equal( a, b, `cycle ${ c } stable` );
}

// Empty list -> null (graceful).
assert.equal( pickTrackForCycle( 5, 'server-1', [] ), null );
assert.equal( pickTrackForCycle( 5, 'server-1', null ), null );

// Distribution sanity: over many cycles, all tracks get used (no permanent bias).
const counts = {};
for ( let c = 0; c < 500; c++ ) {
	const id = pickTrackForCycle( c, 'server-1', tracks ).id;
	counts[ id ] = ( counts[ id ] || 0 ) + 1;
}
for ( const id of [ 'a', 'b', 'c', 'd', 'e' ] ) {
	assert.ok( counts[ id ] > 0, `track ${ id } never picked over 500 cycles` );
}
console.log( 'PASS: deterministic track picker' );

// --- Wall-clock cycle timing (the synced round timer, no backend) ---
// The timer is PURE math against UTC — it can never freeze and is identical for
// every player regardless of join time. cycleIndex = floor((now-epoch)/CYCLE_MS).
assert.equal( CYCLE_MS, PLAY_DURATION_MS + RANKINGS_WINDOW_MS, 'CYCLE_MS = play + rankings' );
assert.equal( PLAY_DURATION_MS, 5 * 60 * 1000, '5 min play' );
assert.equal( RANKINGS_WINDOW_MS, 5 * 1000, '5 s rankings' );

// At the exact epoch, cycleIndex is 0, not in rankings.
const info0 = cycleInfo( ROUND_EPOCH );
assert.equal( info0.cycleIndex, 0, 'epoch -> cycle 0' );
assert.equal( info0.roundId, 0, 'epoch -> roundId 0' );
assert.equal( info0.inRankings, false, 'epoch not in rankings' );
assert.equal( info0.playEnd, ROUND_EPOCH + PLAY_DURATION_MS, 'playEnd correct' );
assert.equal( info0.cycleEnd, ROUND_EPOCH + CYCLE_MS, 'cycleEnd correct' );

// 1ms before playEnd -> still playing, not in rankings.
const info1 = cycleInfo( ROUND_EPOCH + PLAY_DURATION_MS - 1 );
assert.equal( info1.inRankings, false, '1ms before playEnd not in rankings' );
assert.equal( info1.cycleIndex, 0, 'still cycle 0' );

// Exactly at playEnd -> in rankings window.
const info2 = cycleInfo( ROUND_EPOCH + PLAY_DURATION_MS );
assert.equal( info2.inRankings, true, 'at playEnd -> in rankings' );
assert.equal( info2.cycleIndex, 0, 'still cycle 0 during rankings' );

// 1ms before cycleEnd -> still in rankings.
const info3 = cycleInfo( ROUND_EPOCH + CYCLE_MS - 1 );
assert.equal( info3.inRankings, true, '1ms before cycleEnd still in rankings' );
assert.equal( info3.cycleIndex, 0, 'still cycle 0' );

// At cycleEnd -> next cycle begins. The cycleIndex/roundId increment (this is
// the actual "round over" signal the client uses via roundId !== lastRoundId).
// `roundOver` is a vestigial field that's always false under floor-based cycle
// math (now is always < the current cycle's cycleEnd), so we don't assert it.
const info4 = cycleInfo( ROUND_EPOCH + CYCLE_MS );
assert.equal( info4.cycleIndex, 1, 'cycleEnd -> cycle 1' );
assert.equal( info4.roundId, 1, 'cycleEnd -> roundId 1' );
assert.equal( info4.inRankings, false, 'new cycle not in rankings' );

// Join-time independence: two players joining at very different times within the
// same cycle see the SAME roundId. (The cycle is derived from the clock, not
// from join time, so this is what makes the timer host-independent.)
const earlyJoin = cycleInfo( ROUND_EPOCH + 10_000 ); // 10s into cycle 0
const lateJoin = cycleInfo( ROUND_EPOCH + 4 * 60 * 1000 ); // 4min into cycle 0
assert.equal( earlyJoin.roundId, lateJoin.roundId, 'join-time-independent roundId' );
assert.equal( earlyJoin.cycleIndex, 0, 'early join cycle 0' );
assert.equal( lateJoin.cycleIndex, 0, 'late join cycle 0' );
console.log( 'PASS: wall-clock cycle timing (host-independent, never freezes)' );

// --- P2P lap collection (replaces the worker lap-submit write) ---
// Each peer keeps the MINIMUM lap time per playerId per round. Mirrors the
// ingestPublicServerPeerLap logic in main.js.
function makeLapStore() {
	const byRound = {};
	function ingest( playerId, packet ) {
		const pid = String( playerId || packet?.playerId || '' );
		if ( ! pid ) return;
		const roundId = Number( packet?.roundId );
		if ( ! Number.isFinite( roundId ) ) return;
		const time = Number( packet?.time );
		if ( ! Number.isFinite( time ) || time < 0 ) return;
		if ( ! byRound[ roundId ] ) byRound[ roundId ] = {};
		const existing = byRound[ roundId ][ pid ];
		if ( ! existing || time < Number( existing.time ) ) {
			byRound[ roundId ][ pid ] = { name: packet?.name || existing?.name || 'Player', time };
		}
	}
	return { ingest, byRound };
}
const store = makeLapStore();
store.ingest( 'p1', { roundId: 5, time: 60.0, name: 'Alice' } );
store.ingest( 'p1', { roundId: 5, time: 58.5, name: 'Alice' } ); // improvement
store.ingest( 'p1', { roundId: 5, time: 61.0, name: 'Alice' } ); // slower — ignored
store.ingest( 'p2', { roundId: 5, time: 55.0, name: 'Bob' } );
assert.equal( store.byRound[ 5 ].p1.time, 58.5, 'keeps minimum per player' );
assert.equal( store.byRound[ 5 ].p2.time, 55.0, 'separate player separate entry' );

// Laps are scoped per round: a lap in round 6 doesn't overwrite round 5.
store.ingest( 'p1', { roundId: 6, time: 57.0, name: 'Alice' } );
assert.equal( store.byRound[ 5 ].p1.time, 58.5, 'round 5 untouched by round 6 lap' );
assert.equal( store.byRound[ 6 ].p1.time, 57.0, 'round 6 lap recorded' );

// Invalid laps are ignored.
store.ingest( 'p3', { roundId: 5, time: NaN } );
store.ingest( 'p3', { roundId: 5, time: -1 } );
assert.ok( ! store.byRound[ 5 ].p3, 'invalid laps ignored' );
console.log( 'PASS: P2P lap collection (min per player per round, no worker)' );

// --- Host-election state machine (PeerJS-native, no worker) ---
// Mirrors the startPublicServerPeer logic: claiming the RACE-ROOM-<code> id
// succeeds (host) or fails with 'unavailable-id' (joiner). Self-healing: a
// joiner that loses the host reclaims the id.
function makeHostElection() {
	const ownedIds = new Set();
	let role = null;
	function claimHost( id ) {
		// Simulate PeerJS: if the id is already owned, it's 'unavailable-id'.
		if ( ownedIds.has( id ) ) return { ok: false, error: 'unavailable-id' };
		ownedIds.add( id );
		role = 'host';
		return { ok: true };
	}
	function releaseHost( id ) { ownedIds.delete( id ); role = null; }
	function join() { role = 'join'; }
	function currentRole() { return role; }
	return { claimHost, releaseHost, join, currentRole, isOwned: ( id ) => ownedIds.has( id ) };
}
const elect = makeHostElection();
// First player claims host.
assert.equal( elect.claimHost( 'RACE-ROOM-PUBSV1' ).ok, true, 'first claim succeeds -> host' );
assert.equal( elect.currentRole(), 'host', 'first player is host' );
// Second player's claim fails (id taken) -> becomes joiner.
assert.equal( elect.claimHost( 'RACE-ROOM-PUBSV1' ).ok, false, 'second claim fails (unavailable-id)' );
elect.join();
assert.equal( elect.currentRole(), 'join', 'second player is joiner' );
// Host leaves -> id released. Joiner can now reclaim (self-healing).
elect.releaseHost( 'RACE-ROOM-PUBSV1' );
assert.equal( elect.isOwned( 'RACE-ROOM-PUBSV1' ), false, 'host id released on leave' );
assert.equal( elect.claimHost( 'RACE-ROOM-PUBSV1' ).ok, true, 'joiner reclaims host id (self-healing)' );
assert.equal( elect.currentRole(), 'host', 'reclaimed joiner is now host' );
console.log( 'PASS: PeerJS-native host election + self-healing' );

// --- No worker dependency: the module exports NO server-fetch wrappers ---
// (fetchServerState/joinServer/heartbeatServer/submitServerLap/setServerTrack/
// leaveServer/claimServerHost/SERVERS_API_BASE were all removed.) The only
// network call left is fetchTrackList (read-only GET to the track board, zero
// KV writes).
assert.equal( typeof mod.fetchTrackList, 'function', 'fetchTrackList still exported (read-only board)' );
assert.equal( mod.SERVERS_API_BASE, undefined, 'SERVERS_API_BASE removed (no servers worker)' );
assert.equal( typeof mod.fetchServerState, 'undefined', 'fetchServerState removed' );
assert.equal( typeof mod.joinServer, 'undefined', 'joinServer removed' );
assert.equal( typeof mod.heartbeatServer, 'undefined', 'heartbeatServer removed' );
assert.equal( typeof mod.submitServerLap, 'undefined', 'submitServerLap removed' );
assert.equal( typeof mod.setServerTrack, 'undefined', 'setServerTrack removed' );
assert.equal( typeof mod.leaveServer, 'undefined', 'leaveServer removed' );
assert.equal( typeof mod.claimServerHost, 'undefined', 'claimServerHost removed' );
assert.equal( typeof mod.isPublicServerConfigured, 'function', 'isPublicServerConfigured kept' );
assert.equal( mod.isPublicServerConfigured(), true, 'public servers always configured (no backend needed)' );
console.log( 'PASS: no servers-worker dependency in PublicServers.js' );

console.log( '\nAll public-server no-worker assertions passed.' );
