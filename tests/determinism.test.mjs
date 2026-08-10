// Standalone determinism self-test for js/Determinism.js.
// Runs in Node with no dependencies. Verifies that the seeded RNG and
// accumulator produce identical sequences for identical inputs across two
// independent runs — the core guarantee the TAS feature relies on.
import { FIXED_DT, MAX_STEPS_PER_FRAME, DEFAULT_RNG_SEED, SeededRandom, gameRng, resetGameRng, seedFromString } from '../js/Determinism.js';

let failures = 0;
function assertEqual( actual, expected, label ) {

	const a = JSON.stringify( actual );
	const e = JSON.stringify( expected );
	if ( a !== e ) {

		failures += 1;
		console.error( `FAIL: ${ label }\n  expected: ${ e }\n  actual:   ${ a }` );

	} else console.log( `ok: ${ label }` );

}

// 1) Two SeededRandom instances with the same seed produce identical sequences.
const rngA = new SeededRandom( 0x1234abcd );
const rngB = new SeededRandom( 0x1234abcd );
const seqA = Array.from( { length: 1000 }, () => rngA.next() );
const seqB = Array.from( { length: 1000 }, () => rngB.next() );
assertEqual( seqA, seqB, 'SeededRandom: identical seed -> identical 1000-sample sequence' );

// 2) reset() restores the exact sequence.
rngA.reset( 0x1234abcd );
const seqA2 = Array.from( { length: 1000 }, () => rngA.next() );
assertEqual( seqA2, seqA, 'SeededRandom: reset() reproduces the original sequence' );

// 3) resetGameRng mutates the shared instance deterministically.
resetGameRng( DEFAULT_RNG_SEED );
const shared1 = Array.from( { length: 50 }, () => gameRng.next() );
resetGameRng( DEFAULT_RNG_SEED );
const shared2 = Array.from( { length: 50 }, () => gameRng.next() );
assertEqual( shared1, shared2, 'gameRng: resetGameRng reproduces sequence' );

// 4) Different seeds produce different sequences (sanity).
const rngC = new SeededRandom( 1 );
const rngD = new SeededRandom( 2 );
assertEqual( rngC.next() === rngD.next(), false, 'SeededRandom: different seeds differ' );

// 5) seedFromString is stable and deterministic.
assertEqual( seedFromString( 'sky|night' ), seedFromString( 'sky|night' ), 'seedFromString: stable hash' );
assertEqual( seedFromString( 'a' ) !== seedFromString( 'b' ), true, 'seedFromString: different inputs differ' );

// 6) FIXED_DT / MAX_STEPS_PER_FRAME are the expected contract values.
assertEqual( FIXED_DT, 1 / 120, 'FIXED_DT is 1/120' );
assertEqual( MAX_STEPS_PER_FRAME, 8, 'MAX_STEPS_PER_FRAME is 8' );

// 7) Simulated fixed-timestep accumulator: two runs with identical per-step
// RNG consumption produce identical accumulated state. This models the
// main.js runSimulationStep loop.
function simulatedRun( steps ) {

	resetGameRng( DEFAULT_RNG_SEED );
	let raceClock = 0;
	const positions = [];
	for ( let i = 0; i < steps; i ++ ) {

		raceClock += FIXED_DT;
		// consume RNG the way gameplay/visual loops do
		const jitter = ( gameRng.next() - 0.5 ) * FIXED_DT;
		positions.push( raceClock + jitter );

	}
	return { raceClock, positions };

}

const run1 = simulatedRun( 600 ); // 5 seconds @ 120hz
const run2 = simulatedRun( 600 );
assertEqual( run1, run2, 'simulated fixed-timestep run is reproducible (600 steps)' );
// Accumulated clock is deterministic (identical bit-for-bit each run) but
// carries IEEE754 drift vs the ideal N*FIXED_DT — that drift itself is
// reproducible, which is what matters for TAS. Confirm drift is stable.
const idealClock = 600 * FIXED_DT;
assertEqual( run1.raceClock === run2.raceClock, true, 'accumulated race clock is bit-identical across runs' );
assertEqual( Math.abs( run1.raceClock - idealClock ) < 1e-9, true, 'accumulated clock stays within 1e-9 of ideal' );

if ( failures ) {

	console.error( `\n${ failures } determinism check(s) FAILED` );
	process.exit( 1 );

} else console.log( '\nAll determinism checks passed.' );
