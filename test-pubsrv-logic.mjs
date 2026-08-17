import { cycleInfo, buildServerTrackRedirectUrl, mapSignatureFromPlayUrl, pickTrackForCycle, ROUND_EPOCH, CYCLE_MS, PLAY_DURATION_MS, RANKINGS_WINDOW_MS } from './js/PublicServers.js';

let pass = 0, fail = 0;
function assert(name, cond) { if (cond) { pass++; console.log('  PASS:', name); } else { fail++; console.log('  FAIL:', name); } }

// 1. cycleInfo produces correct rankings window
const now = Date.UTC(2026, 7, 16, 23, 0, 0);
const info = cycleInfo(now);
assert('cycleInfo has roundId', typeof info.roundId === 'number');
assert('cycleInfo has cycleIndex', info.cycleIndex === info.roundId);
assert('cycleInfo has playEnd', typeof info.playEnd === 'number');
assert('cycleInfo has cycleEnd', typeof info.cycleEnd === 'number');
assert('playEnd = cycleStart + 5min', info.playEnd - (info.cycleStart || (info.playEnd - PLAY_DURATION_MS)) === PLAY_DURATION_MS);
assert('cycleEnd = playEnd + 5s', info.cycleEnd - info.playEnd === RANKINGS_WINDOW_MS);

// 2. Test inRankings window: pick a time 2s into the rankings window
const inRankingsTime = info.playEnd + 2000;
const info2 = cycleInfo(inRankingsTime);
assert('inRankings=true during rankings window', info2.inRankings === true);
assert('roundOver=false during rankings window', info2.roundOver === false);
assert('same roundId during rankings', info2.roundId === info.roundId);

// 3. Test after cycle end (new round)
const nextRoundTime = info.cycleEnd + 1000;
const info3 = cycleInfo(nextRoundTime);
assert('roundId increments after cycle', info3.roundId === info.roundId + 1);

// 4. Test buildServerTrackRedirectUrl with absolute playUrl (THE BUG FIX)
global.window = { location: { href: 'http://localhost:12000/index.html', pathname: '/index.html', hash: '' } };
const absPlayUrl = 'https://everybodysim.github.io/Racing-game/index.html?map=v2.eyJ2IjoyLCJjZWxscyI6W1sxLDJd&mods=none';
const redirectUrl = buildServerTrackRedirectUrl(absPlayUrl, 'server-1');
assert('redirect uses current pathname', redirectUrl.startsWith('/index.html?'));
assert('redirect has map param', redirectUrl.includes('map=v2.'));
assert('redirect has pubServer param', redirectUrl.includes('pubServer=server-1'));
assert('redirect has play=1', redirectUrl.includes('play=1'));
assert('redirect does NOT contain github.io', !redirectUrl.includes('github.io'));
assert('redirect does NOT contain /Racing-game/', !redirectUrl.includes('/Racing-game/'));
assert('redirect filters mods=none', !redirectUrl.includes('mods=none'));

// 5. Test with a relative playUrl too (backward compat)
const relPlayUrl = 'index.html?map=testmap';
const redirectUrl2 = buildServerTrackRedirectUrl(relPlayUrl, 'server-2');
assert('relative playUrl redirect uses current pathname', redirectUrl2.startsWith('/index.html?'));
assert('relative playUrl redirect has map', redirectUrl2.includes('map=testmap'));
assert('relative playUrl redirect has pubServer=server-2', redirectUrl2.includes('pubServer=server-2'));

// 6. Test mapSignatureFromPlayUrl
const sig = mapSignatureFromPlayUrl(absPlayUrl);
assert('signature extracts map', sig.startsWith('v2.'));
assert('signature has |none', sig.endsWith('|none'));

// 7. Test pickTrackForCycle is deterministic
const trackList = [
	{ id: 'a', name: 'A', playUrl: 'index.html?map=a' },
	{ id: 'b', name: 'B', playUrl: 'index.html?map=b' },
	{ id: 'c', name: 'C', playUrl: 'index.html?map=c' },
];
const pick1 = pickTrackForCycle(5, 'server-1', trackList);
const pick2 = pickTrackForCycle(5, 'server-1', trackList);
assert('pickTrackForCycle is deterministic', pick1?.playUrl === pick2?.playUrl);
assert('pickTrackForCycle returns a valid entry', pick1 && typeof pick1.playUrl === 'string');

// 8. Test with empty track list
const emptyPick = pickTrackForCycle(0, 'server-1', []);
assert('pickTrackForCycle handles empty list', emptyPick === null || emptyPick === undefined);

console.log('\n=== Results: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail > 0 ? 1 : 0);
