// Unit tests for the Firebase-backed public-server multiplayer helpers.
//
// Run: `node test-multiplayer-firebase-vote.mjs`.

import {
        normalizeFirebaseVoteDoc,
        tallyFirebaseVotes,
        countFreshRoomPlayers,
} from './js/multiplayer-firebase-vote.js';

let pass = 0, fail = 0;
function assert( name, cond ) {
        if ( cond ) { pass ++; console.log( '  PASS:', name ); }
        else { fail ++; console.error( '  FAIL:', name ); }
}

const baseVoteDoc = {
        voteId: 'vote-1',
        initiatorId: 'p-init',
        initiatorVote: 'yes',
        playUrl: 'https://x.example/index.html?map=ABC',
        trackName: 'Twisty',
        startedAt: 1000,
        votes: { 'p-a': 'yes', 'p-b': 'no' },
};

assert( 'null doc to null', normalizeFirebaseVoteDoc( null,30000 ) === null );
assert( 'non-object doc to null', normalizeFirebaseVoteDoc( 'nope',30000 ) === null );
assert( 'empty voteId doc to null', normalizeFirebaseVoteDoc( { ...baseVoteDoc, voteId: '' },30000 ) === null );
assert( 'invalid startedAt doc to null', normalizeFirebaseVoteDoc( { ...baseVoteDoc, startedAt: 0 },30000 ) === null );

const normalized = normalizeFirebaseVoteDoc( baseVoteDoc,30000 );
assert( 'normalizes basic fields', normalized && normalized.voteId === 'vote-1' && normalized.initiatorId === 'p-init' && normalized.trackName === 'Twisty' );
assert( 'playUrl preserved', normalized && normalized.playUrl.includes( 'map=ABC' ) );
assert( 'endsAt = startedAt + duration', normalized && normalized.endsAt === 31000 );
assert( 'peer votes included', normalized && normalized.votes[ 'p-a' ] === 'yes' && normalized.votes[ 'p-b' ] === 'no' );
assert( 'initiator auto-vote seeded', normalized && normalized.votes[ 'p-init' ] === 'yes' );
assert( 'initiatorVote no respected', normalizeFirebaseVoteDoc( { ...baseVoteDoc, initiatorVote: 'no' },30000 ).votes[ 'p-init' ] === 'no' );
assert( 'initiator own explicit vote wins over auto-seed', normalizeFirebaseVoteDoc( { ...baseVoteDoc, votes: { 'p-init': 'no', 'p-a': 'yes' } },30000 ).votes[ 'p-init' ] === 'no' );
assert( 'malformed vote coerces to yes', normalizeFirebaseVoteDoc( { ...baseVoteDoc, votes: { 'p-a': 'banana' } },30000 ).votes[ 'p-a' ] === 'yes' );
assert( 'result doc piped through', normalizeFirebaseVoteDoc( { ...baseVoteDoc, result: { passed: true, playUrl: 'U', trackName: 'T', yes: 1, no:  1, total: 2 } },30000 ).result.passed === true );
assert( 'no result doc to result null', normalizeFirebaseVoteDoc( baseVoteDoc,30000 ).result === null );

assert( 'no votes fails', tallyFirebaseVotes( {},0.60 ).passed === false && tallyFirebaseVotes( {},0.60 ).total ===  0 );
assert( 'null votes handled', tallyFirebaseVotes( null,0.60 ).total ===   0 );
assert( 'one yes passes', tallyFirebaseVotes( { a: 'yes' },0.60 ).passed === true );
assert( 'one no fails', tallyFirebaseVotes( { a: 'no' },0.60 ).passed === false );
assert( '2 yes  3 no fails', tallyFirebaseVotes( { a: 'yes', b: 'yes', c: 'no', d: 'no', e: 'no' },0.60 ).passed === false );
assert( 'exactly 60 percent yes fails strict', tallyFirebaseVotes( { a: 'yes', b: 'yes', c: 'yes', d: 'no', e: 'no' },0.60 ).passed === false );
assert( 'strictly over 60 percent passes', tallyFirebaseVotes( { a: 'yes', b: 'yes', c: 'yes', d: 'yes', e: 'no' },0.60 ).passed === true );
const tallyTest = tallyFirebaseVotes( { a: 'yes', b: 'yes', c: 'yes', d: 'no', e: 'no' },0.60 );
assert( 'tally counts return three over two', tallyTest.yes ===  3 && tallyTest.no ===  2 && tallyTest.total ===  5 );

const now = 100000;
assert( 'empty players to self only', countFreshRoomPlayers( {}, now,10000,'p-me' ) ===  1 );
assert( 'fresh entry plus self counts', countFreshRoomPlayers( { a: { updatedAt: now -  1000 } },now,10000,'p-me' ) ===  2 );
assert( 'stale entry excluded self still counts', countFreshRoomPlayers( { a: { updatedAt: now -  20000 } },now,10000,'p-me' ) ===  1 );
assert( 'self counted when missing', countFreshRoomPlayers( { },now,10000,'p-me' ) ===  1 );
assert( 'self not double-counted', countFreshRoomPlayers( { 'p-me': { updatedAt: now -  1000 } },now,10000,'p-me' ) === 1 );
assert( 'unlisted self adds listed self not', countFreshRoomPlayers( { 'p-other': { updatedAt: now } },now,10000,'p-me' ) === 2 );
assert( 'bad timestamps skipped', countFreshRoomPlayers( { a: { updatedAt: 'nope' }, b: {} },now,10000,'p-me' ) === 1 );

console.log(
        `\n${ pass } passed, ${ fail } failed.`
);
process.exit( fail >  0 ? 1 : 0 );
