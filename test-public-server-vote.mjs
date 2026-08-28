// Verifies the simplified public-server module: the track-board lookup
// (findTrackByPlayUrl), the map-signature + redirect-URL helpers, and the
// vote tally math that main.js uses (>60% yes, with at least one vote).
//
// The vote packet flow + 30s timer + redirect live in main.js (browser-only,
// PeerJS/DOM) so they aren't unit-testable here; this covers the pure helpers
// that ARE unit-testable. Run: `node test-public-server-vote.mjs`.

import { findTrackByPlayUrl, mapSignatureFromPlayUrl, buildServerTrackRedirectUrl, isRacingGameTrackUrl } from './js/PublicServers.js';

let pass = 0, fail = 0;
function assert( name, cond ) {

	if ( cond ) { pass ++; console.log( '  PASS:', name ); }
	else { fail ++; console.error( '  FAIL:', name ); }

}

// --- findTrackByPlayUrl -------------------------------------------------

global.window = { location: { href: 'http://localhost:12000/index.html', pathname: '/index.html', hash: '' } };

const tracks = [
	{ id: 'a', name: 'Twisty Canyon', playUrl: 'https://everybodysim.github.io/Racing-game/index.html?map=ABC&mods=none#ghost=bigblob' },
	{ id: 'b', name: '  Speed Ring ', playUrl: 'https://everybodysim.github.io/Racing-game/index.html?mods=cool&map=DEF' },
	{ id: 'c', name: '   ', playUrl: 'https://everybodysim.github.io/Racing-game/index.html?map=GHI' }, // blank name
];

// Exact match returns the entry with a trimmed name.
const a = findTrackByPlayUrl( 'https://everybodysim.github.io/Racing-game/index.html?map=ABC&mods=none#ghost=other', tracks );
assert( 'findTrackByPlayUrl matches by map+mods ignoring hash', a && a.name === 'Twisty Canyon' );
assert( 'findTrackByPlayUrl returns the original playUrl', a && a.playUrl.includes( 'map=ABC' ) );

// Query-order independence: mods before map still matches entry b.
const b = findTrackByPlayUrl( 'https://everybodysim.github.io/Racing-game/index.html?map=DEF&mods=cool', tracks );
assert( 'findTrackByPlayUrl matches regardless of query order', b && b.name === 'Speed Ring' );

// No match → null.
assert( 'findTrackByPlayUrl returns null on no match', findTrackByPlayUrl( 'https://other.example/x?map=ZZZ', tracks ) === null );
assert( 'findTrackByPlayUrl returns null on empty url', findTrackByPlayUrl( '', tracks ) === null );
assert( 'findTrackByPlayUrl returns null on empty list', findTrackByPlayUrl( tracks[ 0 ].playUrl, [] ) === null );

// A missing/blank name falls back to "Shared track".
const c = findTrackByPlayUrl( 'https://everybodysim.github.io/Racing-game/index.html?map=GHI', tracks );
assert( 'findTrackByPlayUrl falls back to "Shared track" for blank name', c && c.name === 'Shared track' );

// --- isRacingGameTrackUrl (custom-track fallback) -----------------------

assert( 'isRacingGameTrackUrl true for a URL with map=', isRacingGameTrackUrl( 'index.html?map=ABC&mods=cool' ) === true );
assert( 'isRacingGameTrackUrl true for an absolute URL with map=', isRacingGameTrackUrl( 'https://everybodysim.github.io/Racing-game/index.html?map=ABC' ) === true );
assert( 'isRacingGameTrackUrl false when map is missing', isRacingGameTrackUrl( 'index.html?mods=cool' ) === false );
assert( 'isRacingGameTrackUrl false when map is empty', isRacingGameTrackUrl( 'index.html?map=' ) === false );
assert( 'isRacingGameTrackUrl false for a non-url', isRacingGameTrackUrl( 'not a url' ) === false );
assert( 'isRacingGameTrackUrl false for empty', isRacingGameTrackUrl( '' ) === false );

// --- mapSignatureFromPlayUrl -------------------------------------------

assert( 'mapSignatureFromPlayUrl maps+mods', mapSignatureFromPlayUrl( 'index.html?map=ABC&mods=cool' ) === 'ABC|cool' );
assert( 'mapSignatureFromPlayUrl defaults mods to none', mapSignatureFromPlayUrl( 'index.html?map=ABC' ) === 'ABC|none' );
assert( 'mapSignatureFromPlayUrl defaults map to default', mapSignatureFromPlayUrl( 'index.html?mods=cool' ) === 'default|cool' );
assert( 'mapSignatureFromPlayUrl handles garbage', mapSignatureFromPlayUrl( 'not a url' ) === 'default|none' );

// --- buildServerTrackRedirectUrl ---------------------------------------

global.window = { location: { href: 'http://localhost:12000/index.html?leftover=1', pathname: '/index.html', hash: '' } };

const redir = buildServerTrackRedirectUrl(
	'https://everybodysim.github.io/Racing-game/index.html?map=ABC&mods=cool',
	'server-1',
);
assert( 'redirect uses current pathname (not the playUrl origin)', redir.startsWith( '/index.html?' ) );
assert( 'redirect carries map param', redir.includes( 'map=ABC' ) );
assert( 'redirect carries mods param', redir.includes( 'mods=cool' ) );
assert( 'redirect carries pubServer param', redir.includes( 'pubServer=server-1' ) );
assert( 'redirect carries play=1', redir.includes( 'play=1' ) );
assert( 'redirect does NOT contain the github.io origin', ! /everybodysim\.github\.io/.test( redir ) );
assert( 'redirect does NOT carry leftover query from the current page', ! /leftover=/.test( redir ) );

// mods=none is filtered out of the redirect.
const redirNone = buildServerTrackRedirectUrl( 'https://x/index.html?map=ABC&mods=none', 'server-2' );
assert( 'redirect filters mods=none', ! /mods=/.test( redirNone ) );
assert( 'redirect keeps pubServer for mods=none', redirNone.includes( 'pubServer=server-2' ) );

// --- Vote tally math (mirrors main.js tallyPublicServerVotes + the pass gate) ---
// A vote passes if strictly more than 60% of the cast votes are "yes" AND at
// least one vote was cast. This mirrors the logic in main.js endPublicServerVote.

const PASS_RATIO = 0.60;
function passes( yes, no ) {

	const total = yes + no;
	return total > 0 && ( yes / total ) > PASS_RATIO;

}
assert( 'vote: 3 yes / 1 no (75%) passes', passes( 3, 1 ) === true );
assert( 'vote: 2 yes / 1 no (66.7%) passes', passes( 2, 1 ) === true );
assert( 'vote: 3 yes / 2 no (60%) does NOT pass (strictly >60%)', passes( 3, 2 ) === false );
assert( 'vote: 1 yes / 1 no (50%) does not pass', passes( 1, 1 ) === false );
assert( 'vote: 0 yes / 0 no does not pass (no votes)', passes( 0, 0 ) === false );
assert( 'vote: 0 yes / 3 no does not pass', passes( 0, 3 ) === false );
assert( 'vote: 1 yes / 0 no (100%) passes (initiator alone)', passes( 1, 0 ) === true );

console.log( `\n${ pass } passed, ${ fail } failed` );
if ( fail ) process.exit( 1 );
