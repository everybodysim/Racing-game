// Verifies the public-server round-end flow: pre-resolution of the next cycle's
// track, instant redirect when the round changes, and rankings-window timing.
import { cycleInfo, PLAY_DURATION_MS, RANKINGS_WINDOW_MS, CYCLE_MS, ROUND_EPOCH, pickTrackForCycle } from './js/PublicServers.js';

let pass = 0, fail = 0;
function assert( cond, msg ) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }

// 1. cycleInfo: the rankings window is the last 5s of each cycle.
const base = ROUND_EPOCH + 10 * CYCLE_MS; // some arbitrary cycle start
const playing = base + 1000;
const infoP = cycleInfo( playing );
assert( infoP.inRankings === false, 'mid-round is not in rankings' );
assert( infoP.roundOver === false, 'mid-round is not over' );

const atPlayEnd = base + PLAY_DURATION_MS;
const infoE = cycleInfo( atPlayEnd );
assert( infoE.inRankings === true, 'at playEnd → inRankings' );
assert( infoE.roundId === 10, 'rankings window keeps the same roundId' );

const midRankings = base + PLAY_DURATION_MS + 2000;
const infoR = cycleInfo( midRankings );
assert( infoR.inRankings === true, 'mid-rankings → inRankings' );
assert( infoR.roundId === 10, 'rankings window roundId unchanged' );

const atCycleEnd = base + CYCLE_MS;
const infoC = cycleInfo( atCycleEnd );
assert( infoC.inRankings === false, 'at cycleEnd → not inRankings (new round)' );
assert( infoC.roundId === 11, 'at cycleEnd → new roundId' );
// roundOver means the CURRENT cycle has ended; at the exact boundary we've
// just entered cycle 11, whose own cycleEnd is a full CYCLE_MS away.
assert( infoC.roundOver === false, 'at cycle boundary → in new round, not over' );

// 2. Pre-resolution: the next cycle's track can be computed BEFORE the round
// ends, so the redirect is instant when the round changes.
const serverId = 'server-1';
const fakeList = [
	{ id: 'aaa', playUrl: 'index.html?map=aaa' },
	{ id: 'bbb', playUrl: 'index.html?map=bbb' },
	{ id: 'ccc', playUrl: 'index.html?map=ccc' },
];
const cur = pickTrackForCycle( 10, serverId, fakeList );
const next = pickTrackForCycle( 11, serverId, fakeList );
assert( cur && cur.playUrl, 'current cycle resolves a track' );
assert( next && next.playUrl, 'next cycle resolves a track (pre-resolvable)' );
// Determinism: same cycle + server → same track every time.
assert( pickTrackForCycle( 10, serverId, fakeList ).playUrl === cur.playUrl, 'deterministic pick' );

// 3. Different servers fold their id into the seed. With few tracks two servers
// can collide on a given cycle, so just verify determinism per-server (already
// done above) rather than cross-server uniqueness.
const s2 = pickTrackForCycle( 10, 'server-2', fakeList );
assert( typeof s2.playUrl === 'string', 'server-2 resolves a track' );
// Over enough cycles, different servers diverge.
let divergence = 0;
for ( let c = 0; c < 50; c++ ) {
	if ( pickTrackForCycle( c, 'server-1', fakeList ).playUrl !== pickTrackForCycle( c, 'server-2', fakeList ).playUrl ) divergence++;
}
assert( divergence > 0, 'servers diverge over many cycles' );

// 4. Empty track list → null (graceful, no crash).
assert( pickTrackForCycle( 10, serverId, [] ) === null, 'empty list → null' );
assert( pickTrackForCycle( 10, serverId, null ) === null, 'null list → null' );

// 5. The rankings window is exactly RANKINGS_WINDOW_MS wide.
const windowStart = base + PLAY_DURATION_MS;
const windowEnd = base + CYCLE_MS;
assert( windowEnd - windowStart === RANKINGS_WINDOW_MS, 'rankings window is 5s wide' );

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
