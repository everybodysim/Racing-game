// Verifies the public-server fixes: deterministic track picking, and that the
// worker write-coalescing actually reduces KV puts.
import { strict as assert } from 'node:assert';

// --- Deterministic picker (mirrors js/PublicServers.js) ---
function mulberry32( seed ) {
	let a = seed >>> 0;
	return function () {
		a |= 0; a = ( a + 0x6D2B79F5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
}
function hashString( str ) {
	let h = 2166136261 >>> 0;
	for ( let i = 0; i < str.length; i++ ) { h ^= str.charCodeAt( i ); h = Math.imul( h, 16777619 ); }
	return h >>> 0;
}
function pickTrackForCycle( cycleIndex, serverId, trackList ) {
	if ( ! Array.isArray( trackList ) || trackList.length === 0 ) return null;
	let seed = ( Math.imul( Number( cycleIndex ) || 0, 2654435761 ) ) >>> 0;
	seed = ( seed ^ hashString( String( serverId || '' ) ) ) >>> 0;
	const rng = mulberry32( seed );
	const idx = Math.floor( rng() * trackList.length );
	return trackList[ idx ] || null;
}

const tracks = [ 'a', 'b', 'c', 'd', 'e' ].map( ( id ) => ( { id, playUrl: `index.html?map=${ id }` } ) );

// Determinism: same cycle + server -> same track, always.
const t1 = pickTrackForCycle( 1000, 'server-1', tracks );
const t2 = pickTrackForCycle( 1000, 'server-1', tracks );
assert.equal( t1.id, t2.id, 'same cycle+server picks same track across calls' );

// Different servers get different sequences (variety), but each is deterministic.
// Check across several cycles — at least some cycle should differ between servers.
let anyDiffer = false;
for ( let c = 0; c < 20; c++ ) {
	const a = pickTrackForCycle( c, 'server-1', tracks ).id;
	const b = pickTrackForCycle( c, 'server-2', tracks ).id;
	const c2 = pickTrackForCycle( c, 'server-3', tracks ).id;
	if ( new Set( [ a, b, c2 ] ).size >= 2 ) { anyDiffer = true; break; }
}
assert.ok( anyDiffer, 'servers should vary on at least some cycles' );

// Stability across cycle progression: changing the list size only affects picks
// from cycles AFTER the change for the appended entry (sort-stable by id). The
// key invariant: for a FIXED list, the pick for a given cycle never changes.
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

// --- Worker write-coalescing simulation ---
// Minimal in-process KV + worker state to count puts and verify the coalescing.
const HOST_STALE_MS = 45000;
const MEMBER_STALE_MS = 120000;
const MEMBER_LASTSEEN_REFRESH_MS = 60000;
const HOST_HEARTBEAT_REFRESH_MS = 30000;

function cycleInfo( now, epoch, cycleMs ) {
	const cycleIndex = Math.floor( ( now - epoch ) / cycleMs );
	return { cycleIndex };
}

function makeWorker() {
	const kv = new Map();
	let puts = 0;
	const env = {
		SERVERS_KV: {
			get: async ( k ) => kv.get( k ) || null,
			put: async ( k, v ) => { puts++; kv.set( k, v ); },
		},
	};
	const EPOCH = Date.UTC( 2026, 0, 1 );
	const CYCLE_MS = 305000;
	function initServer( id ) {
		return { id, name: id, code: id.toUpperCase(), hostId: '', hostHeartbeatAt: 0, members: {}, laps: {}, tracks: {}, updatedAt: 0 };
	}
	async function load( id ) {
		const raw = kv.get( 'server:' + id );
		if ( raw ) return JSON.parse( raw );
		return initServer( id );
	}
	function pruneMembers( s, now ) {
		let changed = false;
		for ( const [ cid, m ] of Object.entries( s.members ) ) {
			if ( now - ( Number( m.lastSeenAt ) || 0 ) > MEMBER_STALE_MS ) { delete s.members[ cid ]; changed = true; }
		}
		if ( s.hostId && ( ! s.members[ s.hostId ] || now - ( Number( s.hostHeartbeatAt ) || 0 ) > HOST_STALE_MS ) ) {
			s.hostId = ''; s.hostHeartbeatAt = 0; changed = true;
		}
		return changed;
	}
	const isHostFresh = ( s, now ) => Boolean( s.hostId ) && s.members[ s.hostId ] && ( now - ( Number( s.hostHeartbeatAt ) || 0 ) <= HOST_STALE_MS );
	async function save( s ) { s.updatedAt = Date.now(); kv.set( 'server:' + s.id, JSON.stringify( s ) ); puts++; }
	async function heartbeat( id, clientId, now ) {
		const s = await load( id );
		const pruned = pruneMembers( s, now );
		const prevLastSeen = Number( s.members[ clientId ]?.lastSeenAt ) || 0;
		s.members[ clientId ] = { name: 'P', lastSeenAt: now };
		let hostChanged = false;
		const prevHostHb = Number( s.hostHeartbeatAt ) || 0;
		if ( ! isHostFresh( s, now ) ) { s.hostId = clientId; s.hostHeartbeatAt = now; hostChanged = true; }
		else if ( s.hostId === clientId ) { if ( now - prevHostHb > HOST_HEARTBEAT_REFRESH_MS ) hostChanged = true; s.hostHeartbeatAt = now; }
		const stale = ( now - prevLastSeen ) > MEMBER_LASTSEEN_REFRESH_MS;
		if ( hostChanged || pruned || stale ) await save( s );
		return { isHost: s.hostId === clientId };
	}
	async function submitLap( id, clientId, time, now ) {
		const s = await load( id );
		const pruned = pruneMembers( s, now );
		const info = cycleInfo( now, EPOCH, CYCLE_MS );
		s.laps[ info.cycleIndex ] = s.laps[ info.cycleIndex ] || {};
		const ex = s.laps[ info.cycleIndex ][ clientId ];
		let improved = false;
		if ( ! ex || time < Number( ex.time ) ) { s.laps[ info.cycleIndex ][ clientId ] = { name: 'P', time, updatedAt: now }; improved = true; }
		if ( improved || pruned ) await save( s );
	}
	return { env, heartbeat, submitLap, getPuts: () => puts };
}

// Simulate the OLD behaviour vs NEW for a single player idling 3 hours with
// 12s heartbeats, plus a few laps.
(async () => {
	const w = makeWorker();
	const start = Date.UTC( 2026, 5, 1, 12, 0, 0 );
	const cid = 'client-A';
	// join (1 put)
	await w.heartbeat( 'server-1', cid, start ); // first heartbeat == join-ish
	let t = start;
	const threeHours = 3 * 60 * 60 * 1000;
	let lapTime = 60;
	while ( t < start + threeHours ) {
		await w.heartbeat( 'server-1', cid, t );
		// a lap improvement roughly every 10 minutes
		if ( ( ( t - start ) % ( 10 * 60 * 1000 ) ) === 0 && t > start ) {
			lapTime -= 0.5;
			await w.submitLap( 'server-1', cid, lapTime, t );
		}
		t += 12000; // 12s heartbeat
	}
	const puts = w.getPuts();
	// OLD code would have written ~2 puts per heartbeat (server + index) every
	// 4s = ~5400 puts in 3h. NEW code must be WELL under the 1000/day limit.
	// Host writes ~every 30s + member refresh ~every 60s -> ~180 host writes +
	// ~90 liveness writes + ~18 laps = ~300. Allow generous headroom.
	assert.ok( puts < 1000, `3h idle should be well under 1000 puts (got ${ puts })` );
	console.log( `PASS: 3h single-player idle = ${ puts } KV puts (old code ~5400)` );

	// Verify a no-op heartbeat shortly after a persisting one writes nothing.
	// First force a persisting heartbeat by making the member's lastSeen stale.
	const staleT = t + 70000; // > MEMBER_LASTSEEN_REFRESH_MS since last persist
	await w.heartbeat( 'server-1', cid, staleT ); // persists (liveness stale)
	const before = w.getPuts();
	await w.heartbeat( 'server-1', cid, staleT + 5000 ); // 5s later, inside all coalesce windows
	const after = w.getPuts();
	assert.equal( after, before, `back-to-back heartbeat must not write (before=${ before }, after=${ after })` );
	console.log( 'PASS: back-to-back heartbeat writes nothing' );

	// Non-improving lap must not write. First establish a best lap in this cycle
	// (writes once), then submit a slower time in the SAME cycle (must NOT write).
	await w.submitLap( 'server-1', cid, 55.0, staleT + 1000 ); // establishes best -> writes
	const before2 = w.getPuts();
	await w.submitLap( 'server-1', cid, 60.0, staleT + 2000 ); // slower, same cycle -> no improve
	const after2 = w.getPuts();
	assert.equal( after2, before2, 'non-improving lap must not write' );
	console.log( 'PASS: non-improving lap writes nothing' );

	console.log( '\\nAll public-server fix assertions passed.' );
} )();
