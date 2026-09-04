// Car horn + siren test suite.
//
// Verifies the synthesized OGGs (from tools/make-horns.py) are present,
// decodable, and — critically — NOT MONOTONE:
//
//   1. All seven files exist with sane sizes and decode via ffmpeg
//   2. Horns: each design fundamental dominates detuned probes (Goertzel)
//   3. Everything: RMS envelope varies substantially over time (no flat,
//      one-note droning — double honks, glides, growls all show up here)
//   4. Sirens: the dominant frequency MOVES (sweeps/alternations verified
//      via zero-crossing frequency estimates across windows)
//   5. tools/make-horns.py regenerates all seven without error
//
// Run: node test-horns.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
function test( name, cond, detail = '' ) {

	if ( cond ) { passed++; console.log( `  ✓ ${ name }` ); }
	else { failed++; console.error( `  ✗ ${ name }${ detail ? ' — ' + detail : '' }` ); }

}

const SR = 44100;
const FILES = {
	'horn-classic': { fundamentals: [ 420, 500 ], window: [ 0.08, 0.30 ] },
	'horn-truck': { fundamentals: [ 233, 350 ], window: [ 0.15, 0.60 ] },
	'horn-sport': { fundamentals: [ 570, 690 ], window: [ 0.18, 0.34 ] }, // mid-glide pitch (chirp climbs +10%)
	'horn-compact': { fundamentals: [ 620 ], window: [ 0.05, 0.25 ] },
	'siren-police': { siren: true },
	'siren-ambulance': { siren: true },
	'siren-fire': { siren: true },
};

function decode( file ) {

	const buf = execFileSync( 'ffmpeg', [ '-loglevel', 'error', '-i', `audio/${ file }.ogg`, '-ac', '1', '-ar', String( SR ), '-f', 'wav', '-' ], { maxBuffer: 16 * 1024 * 1024 } );
	let off = 12;
	while ( off + 8 <= buf.length ) {

		const id = buf.toString( 'ascii', off, off + 4 );
		const size = buf.readUInt32LE( off + 4 );
		if ( id === 'data' ) {

			// The final chunk can claim bytes past the buffer — clamp.
			const avail = Math.min( size, buf.length - ( off + 8 ) );
			const n = Math.floor( avail / 2 );
			const samples = new Float64Array( n );
			for ( let i = 0; i < n; i ++ ) samples[ i ] = buf.readInt16LE( off + 8 + i * 2 ) / 32768;
			return samples;

		}
		off += 8 + size + ( size % 2 );

	}
	return null;

}

function goertzel( seg, freq ) {

	const k = 2 * Math.PI * freq / SR;
	const coeff = 2 * Math.cos( k );
	let s1 = 0, s2 = 0;
	for ( let i = 0; i < seg.length; i ++ ) {

		const s0 = seg[ i ] + coeff * s1 - s2;
		s2 = s1; s1 = s0;

	}
	return s1 * s1 + s2 * s2 - coeff * s1 * s2;

}

// Zero-crossing frequency estimate over a window (saw harmonics inflate it,
// but it tracks the SWEEP direction/motion, which is what we assert on).
function zcFreqs( samples, winSec = 0.09 ) {

	const w = Math.floor( winSec * SR );
	const out = [];
	for ( let i = 0; i + w <= samples.length; i += w ) {

		let z = 0;
		let prevSign = samples[ i ] >= 0;
		for ( let j = 1; j < w; j ++ ) {

			const sign = samples[ i + j ] >= 0;
			if ( sign !== prevSign ) z ++;
			prevSign = sign;

		}
		out.push( ( z / 2 ) / winSec ); // avg fundamental-ish frequency

	}
	return out;

}

console.log( '--- Sound files ---' );

let allGood = true;
for ( const [ file, spec ] of Object.entries( FILES ) ) {

	if ( ! existsSync( `audio/${ file }.ogg` ) ) { allGood = false; test( `${ file } exists`, false ); continue; }
	if ( statSync( `audio/${ file }.ogg` ).size < 2048 ) { allGood = false; test( `${ file } sane size`, false ); continue; }
	const samples = decode( file );
	if ( ! samples || samples.length < SR / 4 ) { allGood = false; test( `${ file } decodes`, false ); continue; }
	test( `${ file } decodes (${ ( samples.length / SR ).toFixed( 2 ) }s)`, true );

	// Anti-monotone: 50ms-window RMS must vary (CV > 0.10). Single flat honks
	// sit near 0.03; double honks, glides, sweeps all blow past 0.10.
	const w = Math.floor( 0.05 * SR );
	const nWin = Math.floor( samples.length / w );
	const rms = new Float64Array( nWin );
	for ( let i = 0; i < nWin; i ++ ) {

		let acc = 0;
		for ( let j = 0; j < w; j ++ ) { const v = samples[ i * w + j ]; acc += v * v; }
		rms[ i ] = Math.sqrt( acc / w );

	}
	const mean = rms.reduce( ( a, b ) => a + b, 0 ) / nWin;
	const sd = Math.sqrt( rms.reduce( ( a, b ) => a + ( b - mean ) ** 2, 0 ) / nWin );
	const cv = mean > 0 ? sd / mean : 0;
	test( `${ file }: envelope varies (CV ${ cv.toFixed( 2 ) })`, cv > 0.10 );
	if ( cv <= 0.10 ) allGood = false;

	if ( spec.fundamentals ) {

		const from = Math.floor( spec.window[ 0 ] * SR );
		const to = Math.floor( spec.window[ 1 ] * SR );
		const seg = samples.subarray( from, to );
		for ( const f0 of spec.fundamentals ) {

			const at = goertzel( seg, f0 );
			const low = goertzel( seg, f0 * 0.93 );
			const high = goertzel( seg, f0 * 1.07 );
			const ok = at > 4 * low && at > 4 * high;
			test( `${ file }: ${ f0 } Hz dominates`, ok, `power ${ at.toFixed( 1 ) } vs probes ${ low.toFixed( 1 ) }/${ high.toFixed( 1 ) }` );
			if ( ! ok ) allGood = false;

		}

	}

	if ( spec.siren ) {

		// The dominant frequency must MOVE: sirens sweep or alternate, so the
		// spread of per-window zero-crossing frequency estimates must be wide.
		const freqs = zcFreqs( samples );
		const fmin = Math.min( ...freqs ), fmax = Math.max( ...freqs );
		const mid = ( fmin + fmax ) / 2;
		const spread = ( fmax - fmin ) / mid;
		test( `${ file }: frequency sweeps (spread ${ ( spread * 100 ).toFixed( 0 ) }%, ${ fmin.toFixed( 0 ) }–${ fmax.toFixed( 0 ) } Hz)`, spread > 0.25 );
		if ( spread <= 0.25 ) allGood = false;

	}

}

test( 'all seven sounds present, decodable, non-monotone', allGood );

console.log( '--- Generator still runs clean ---' );

{

	try {

		const tmp = mkdtempSync( join( tmpdir(), 'skid-horns-' ) );
		execFileSync( 'python3', [ 'tools/make-horns.py', '--out', tmp ], { stdio: 'pipe' } );
		const files = readdirSync( tmp ).filter( ( f ) => f.endsWith( '.ogg' ) ).sort();
		test( 'regenerates all seven sounds', files.length === 7, files.join( ', ' ) );

	} catch ( err ) {

		test( 'generator runs clean', false, err.message );

	}

}

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exitCode = failed ? 1 : 0;
