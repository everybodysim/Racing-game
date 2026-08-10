// Deterministic simulation utilities for the Racing game and TAS feature.
//
// The simulation must be 100% deterministic: given identical inputs, the same
// sequence of physics + game-logic steps must reproduce bit-for-bit. To achieve
// this we (1) run every simulation step at a fixed delta time and (2) replace
// all sources of randomness with a shared, resettable seeded PRNG.
//
// Visual-only randomness (particles, weather, camera shake, sky decoration) is
// also routed through the seeded RNG so that recorded TAS output frames are
// reproducible, not just the physics result.

// Fixed simulation timestep (seconds). All gameplay, physics, timers, and
// visual-fx state advance by exactly this amount per simulation step.
export const FIXED_DT = 1 / 120;

// Hard cap on simulation steps processed per render frame. Prevents the
// "spiral of death" when real frame time spikes; the accumulator is clamped so
// the simulation never falls further behind than this many steps.
export const MAX_STEPS_PER_FRAME = 8;

// Default seed used when no explicit seed is provided. Stable across runs so
// the out-of-the-box experience is reproducible.
export const DEFAULT_RNG_SEED = 0x1234abcd;

// mulberry32 — a small, fast, fully deterministic 32-bit PRNG. The output
// sequence depends only on the seed, never on the host, clock, or Math.random.
export class SeededRandom {
	constructor( seed = DEFAULT_RNG_SEED ) {
		this.state = seed >>> 0;
	}

	next() {
		// mulberry32
		this.state = ( this.state + 0x6d2b79f5 ) >>> 0;
		let t = this.state;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 0x100000000;
	}

	range( min, max ) {
		return min + this.next() * ( max - min );
	}

	int( min, maxInclusive ) {
		return min + Math.floor( this.next() * ( maxInclusive - min + 1 ) );
	}

	pick( array ) {
		return array[ Math.floor( this.next() * array.length ) ];
	}

	reset( seed = DEFAULT_RNG_SEED ) {
		this.state = seed >>> 0;
	}
}

// Shared RNG instance used by all gameplay + visual loops. It is reset at the
// start of every race / TAS run so identical inputs produce identical output.
export const gameRng = new SeededRandom( DEFAULT_RNG_SEED );

export function resetGameRng( seed = DEFAULT_RNG_SEED ) {
	gameRng.reset( seed );
}

// Derive a stable numeric RNG seed from a string (track id, extras, etc.) so
// each track reproducibly picks its own decorations / cars / weather variants.
export function seedFromString( value = '' ) {
	let h = 2166136261 >>> 0;
	const str = String( value );
	for ( let i = 0; i < str.length; i ++ ) {
		h ^= str.charCodeAt( i );
		h = Math.imul( h, 16777619 ) >>> 0;
	}
	return h >>> 0;
}
