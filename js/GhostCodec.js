// Compact binary ghost codec ("g2").
//
// A v1 ghost payload stored its samples as a JSON array of full-precision
// objects — roughly 90 characters per sample, so a 60-second lap at 20 Hz
// produced a ~145 KB base64 code. This codec packs the same data into 12
// bytes per sample (~87% smaller) with imperceptible quantization:
//
//   positions x/z: 1/16 unit (16 mm), first sample absolute i32 + per-sample
//                  deltas i16 (delta-of-quantized → zero drift, huge range)
//   y:             1/64 unit, i16
//   yaw:           full circle in u16 (≈1e-4 rad steps)
//   pitch/roll:    i8 at 1/256 rad (the body-lean clamp caps these at ~0.38,
//                  so ±0.496 covers everything with ~0.004 rad steps)
//   t:             u32 start ms + u16 per-sample delta ms
//
// Input saving was dropped from the format entirely: the only consumer of
// recorded inputs (ghost import) derives steering/playback inputs from the
// position samples, and the replay viewer never read them.
//
// Layout (little-endian):
//   0-1  magic 'g','2'
//   2    version (2)
//   3    flags: 0x01 car  0x02 cosmetics  0x04 bestLapSeconds  0x08 duration
//   [1]  u8 len + car key bytes
//   [2]  u16 len + cosmetics JSON bytes
//   [4]  u32 bestLapSeconds (ms)
//   [8]  u32 duration (ms)
//        u32 sampleCount
//   s0   u32 t0ms, i32 x*16, i32 z*16, i16 y*64, u16 yaw, i8 pitch*256, i8 roll*256
//   sN   u16 dtms, i16 dx*16, i16 dz*16, i16 y*64, u16 yaw, i8 pitch*256, i8 roll*256
//
// Every decode path validates the magic and bounds-checks every read, so a
// malformed or truncated blob returns null instead of throwing. Legacy v1
// JSON payloads remain readable via decodeGhostCode / decodeGhostBinary
// falling through to the caller's JSON path.

const G2_MAGIC_0 = 0x67; // 'g'
const G2_MAGIC_1 = 0x32; // '2'
const G2_VERSION = 2;
const MAX_G2_SAMPLES = 100000;
const MAX_G2_STRING_BYTES = 24 * 1024 * 1024;

const YAW_STEPS = 65536;
const TWO_PI = Math.PI * 2;
const PITCH_ROLL_MAX = 127 / 256;

// ---- base64url (browser btoa when available, Buffer in node for tests) ----

function bytesToBase64Url( bytes ) {

	if ( typeof btoa === 'function' ) {

		let binary = '';
		const CHUNK = 0x8000;
		for ( let i = 0; i < bytes.length; i += CHUNK ) {

			binary += String.fromCharCode.apply( null, bytes.subarray( i, Math.min( i + CHUNK, bytes.length ) ) );

		}
		return btoa( binary ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );

	}
	if ( typeof Buffer === 'function' && Buffer.from ) {

		return Buffer.from( bytes ).toString( 'base64' ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );

	}
	throw new Error( 'No base64 encoder available' );

}

function base64UrlToBytes( value ) {

	const normalized = String( value || '' ).replace( /-/g, '+' ).replace( /_/g, '/' );
	const padded = normalized + '='.repeat( ( 4 - ( normalized.length % 4 ) ) % 4 );
	if ( typeof atob === 'function' ) {

		const binary = atob( padded );
		const bytes = new Uint8Array( binary.length );
		for ( let i = 0; i < binary.length; i ++ ) bytes[ i ] = binary.charCodeAt( i );
		return bytes;

	}
	if ( typeof Buffer === 'function' && Buffer.from ) {

		return new Uint8Array( Buffer.from( padded, 'base64' ) );

	}
	throw new Error( 'No base64 decoder available' );

}

// ---- helpers ----

function quantizeYaw( yaw ) {

	let wrapped = ( ( Number.isFinite( yaw ) ? yaw : 0 ) % TWO_PI + TWO_PI ) % TWO_PI;
	return Math.round( wrapped / TWO_PI * YAW_STEPS ) % YAW_STEPS;

}

function quantizePitchRoll( value ) {

	const clamped = Math.max( - PITCH_ROLL_MAX, Math.min( PITCH_ROLL_MAX, Number.isFinite( value ) ? value : 0 ) );
	return Math.round( clamped * 256 );

}

function utf8Bytes( text ) {

	return new TextEncoder().encode( String( text ) );

}

function stringFromUtf8Bytes( bytes, offset, length ) {

	return new TextDecoder().decode( bytes.subarray( offset, offset + length ) );

}

// ---- encode ----

export function encodeGhostBinary( ghost ) {

	if ( ! ghost || ! Array.isArray( ghost.samples ) || ghost.samples.length < 2 ) return null;
	const samples = ghost.samples;
	const hasCar = typeof ghost.car === 'string' && ghost.car.length > 0;
	const carBytes = hasCar ? utf8Bytes( ghost.car ) : null;
	if ( carBytes && carBytes.length > 255 ) return null;
	const hasCosmetics = Boolean( ghost.cosmetics );
	const cosmeticsJson = hasCosmetics ? JSON.stringify( ghost.cosmetics ) : null;
	const cosmeticsBytes = hasCosmetics ? utf8Bytes( cosmeticsJson ) : null;
	if ( cosmeticsBytes && cosmeticsBytes.length > 65535 ) return null;
	const hasBestLap = Number.isFinite( ghost.bestLapSeconds );
	const hasDuration = Number.isFinite( ghost.duration );

	// Quantize up-front so deltas are computed between grid points (no drift).
	const xzGrid = new Int32Array( samples.length * 2 );
	const yGrid = new Int16Array( samples.length );
	const yaws = new Uint16Array( samples.length );
	const pitches = new Int8Array( samples.length );
	const rolls = new Int8Array( samples.length );
	const timesMs = new Float64Array( samples.length );
	for ( let i = 0; i < samples.length; i ++ ) {

		const s = samples[ i ];
		if ( ! Number.isFinite( s?.t ) || ! Number.isFinite( s?.x ) || ! Number.isFinite( s?.z ) ) return null;
		xzGrid[ i * 2 ] = Math.round( s.x * 16 );
		xzGrid[ i * 2 + 1 ] = Math.round( s.z * 16 );
		const y = Number.isFinite( s?.y ) ? s.y : 0;
		yGrid[ i ] = Math.max( - 32768, Math.min( 32767, Math.round( y * 64 ) ) );
		yaws[ i ] = quantizeYaw( s.yaw );
		pitches[ i ] = Math.max( - 127, Math.min( 127, quantizePitchRoll( s.pitch ) ) );
		rolls[ i ] = Math.max( - 127, Math.min( 127, quantizePitchRoll( s.roll ) ) );
		timesMs[ i ] = s.t * 1000;

	}
	let previousT = timesMs[ 0 ];
	for ( let i = 1; i < samples.length; i ++ ) {

		if ( timesMs[ i ] < previousT ) timesMs[ i ] = previousT; // enforce monotonic
		previousT = timesMs[ i ];

	}

	const headerSize =
		4 + // magic + version + flags
		( hasCar ? 1 + carBytes.length : 0 ) +
		( hasCosmetics ? 2 + cosmeticsBytes.length : 0 ) +
		( hasBestLap ? 4 : 0 ) +
		( hasDuration ? 4 : 0 ) +
		4 + // sampleCount
		18; // sample 0 (t0ms + x + z + y + yaw + pitch + roll)
	const totalSize = headerSize + ( samples.length - 1 ) * 12;
	if ( totalSize > MAX_G2_STRING_BYTES ) return null;

	const bytes = new Uint8Array( totalSize );
	const view = new DataView( bytes.buffer );
	let off = 0;
	bytes[ off ++ ] = G2_MAGIC_0;
	bytes[ off ++ ] = G2_MAGIC_1;
	bytes[ off ++ ] = G2_VERSION;
	bytes[ off ] = ( hasCar ? 1 : 0 ) | ( hasCosmetics ? 2 : 0 ) | ( hasBestLap ? 4 : 0 ) | ( hasDuration ? 8 : 0 );
	off ++;
	if ( hasCar ) {

		bytes[ off ++ ] = carBytes.length;
		bytes.set( carBytes, off );
		off += carBytes.length;

	}
	if ( hasCosmetics ) {

		view.setUint16( off, cosmeticsBytes.length, true );
		off += 2;
		bytes.set( cosmeticsBytes, off );
		off += cosmeticsBytes.length;

	}
	if ( hasBestLap ) {

		view.setUint32( off, Math.max( 0, Math.round( ghost.bestLapSeconds * 1000 ) ), true );
		off += 4;

	}
	if ( hasDuration ) {

		view.setUint32( off, Math.max( 0, Math.round( ghost.duration * 1000 ) ), true );
		off += 4;

	}
	view.setUint32( off, samples.length, true );
	off += 4;
	view.setUint32( off, Math.max( 0, Math.round( timesMs[ 0 ] ) ), true );
	off += 4;
	view.setInt32( off, xzGrid[ 0 ], true ); off += 4;
	view.setInt32( off, xzGrid[ 1 ], true ); off += 4;
	view.setInt16( off, yGrid[ 0 ], true ); off += 2;
	view.setUint16( off, yaws[ 0 ], true ); off += 2;
	view.setInt8( off, pitches[ 0 ] ); off ++;
	view.setInt8( off, rolls[ 0 ] ); off ++;
	for ( let i = 1; i < samples.length; i ++ ) {

		const dt = Math.min( 65535, Math.max( 0, Math.round( timesMs[ i ] ) - Math.round( timesMs[ i - 1 ] ) ) );
		view.setUint16( off, dt, true ); off += 2;
		view.setInt16( off, xzGrid[ i * 2 ] - xzGrid[ ( i - 1 ) * 2 ], true ); off += 2;
		view.setInt16( off, xzGrid[ i * 2 + 1 ] - xzGrid[ ( i - 1 ) * 2 + 1 ], true ); off += 2;
		view.setInt16( off, yGrid[ i ], true ); off += 2;
		view.setUint16( off, yaws[ i ], true ); off += 2;
		view.setInt8( off, pitches[ i ] ); off ++;
		view.setInt8( off, rolls[ i ] ); off ++;

	}
	if ( off !== totalSize ) return null;
	return bytesToBase64Url( bytes );

}

// ---- decode ----

export function decodeGhostBinary( value ) {

	let bytes;
	try {

		bytes = base64UrlToBytes( value );

	} catch ( e ) {

		return null;

	}
	if ( bytes.length < 20 || bytes[ 0 ] !== G2_MAGIC_0 || bytes[ 1 ] !== G2_MAGIC_1 ) return null;
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	let off = 2;
	const version = bytes[ off ++ ];
	if ( version !== G2_VERSION ) return null;
	const flags = bytes[ off ++ ];
	let car = null;
	if ( flags & 1 ) {

		if ( off >= bytes.length ) return null;
		const len = bytes[ off ++ ];
		if ( off + len > bytes.length ) return null;
		car = stringFromUtf8Bytes( bytes, off, len );
		off += len;

	}
	let cosmetics = null;
	if ( flags & 2 ) {

		if ( off + 2 > bytes.length ) return null;
		const len = view.getUint16( off, true );
		off += 2;
		if ( off + len > bytes.length ) return null;
		try {

			cosmetics = JSON.parse( stringFromUtf8Bytes( bytes, off, len ) );

		} catch ( e ) {

			return null;

		}
		off += len;

	}
	let bestLapSeconds = null;
	if ( flags & 4 ) {

		if ( off + 4 > bytes.length ) return null;
		bestLapSeconds = view.getUint32( off, true ) / 1000;
		off += 4;

	}
	let duration = null;
	if ( flags & 8 ) {

		if ( off + 4 > bytes.length ) return null;
		duration = view.getUint32( off, true ) / 1000;
		off += 4;

	}
	if ( off + 4 > bytes.length ) return null;
	const count = view.getUint32( off, true );
	off += 4;
	if ( count < 2 || count > MAX_G2_SAMPLES ) return null;
	if ( off + 18 + ( count - 1 ) * 12 > bytes.length ) return null;

	const samples = new Array( count );
	let t = view.getUint32( off, true ) / 1000; off += 4;
	let x = view.getInt32( off, true ) / 16; off += 4;
	let z = view.getInt32( off, true ) / 16; off += 4;
	let y = view.getInt16( off, true ) / 64; off += 2;
	let yaw = view.getUint16( off, true ) / YAW_STEPS * TWO_PI; off += 2;
	let pitch = view.getInt8( off ) / 256; off ++;
	let roll = view.getInt8( off ) / 256; off ++;
	samples[ 0 ] = { t, x, y, z, yaw, pitch, roll };
	for ( let i = 1; i < count; i ++ ) {

		t += view.getUint16( off, true ) / 1000; off += 2;
		x += view.getInt16( off, true ) / 16; off += 2;
		z += view.getInt16( off, true ) / 16; off += 2;
		y = view.getInt16( off, true ) / 64; off += 2;
		yaw = view.getUint16( off, true ) / YAW_STEPS * TWO_PI; off += 2;
		pitch = view.getInt8( off ) / 256; off ++;
		roll = view.getInt8( off ) / 256; off ++;
		samples[ i ] = { t, x, y, z, yaw, pitch, roll };

	}
	const ghost = { samples };
	if ( car ) ghost.car = car;
	if ( cosmetics ) ghost.cosmetics = cosmetics;
	if ( bestLapSeconds !== null ) ghost.bestLapSeconds = bestLapSeconds;
	if ( duration !== null ) ghost.duration = duration;
	return ghost;

}

// ---- v2 ghost code envelope ----
// Share codes wrap the binary blob in a tiny JSON shell so the track URL
// rides along: { v: 2, url, g: "<binary>" }. Legacy v1 codes
// ({ v: 1, url, ghost: { samples: [...] } }) remain decodable everywhere.

export function encodeGhostCode( url, ghost ) {

	const g = encodeGhostBinary( ghost );
	if ( ! g ) return null;
	return bytesToBase64Url( utf8Bytes( JSON.stringify( { v: 2, url: String( url || '' ), g } ) ) );

}

export function decodeGhostCode( code ) {

	const value = String( code || '' ).trim();
	if ( ! value ) return null;

	// v2 envelope first: cheap JSON peek, binary decode for the g field.
	let parsed = null;
	try {

		const bytes = base64UrlToBytes( value );
		if ( bytes.length > MAX_G2_STRING_BYTES ) return null;
		parsed = JSON.parse( stringFromUtf8Bytes( bytes, 0, bytes.length ) );

	} catch ( e ) {

		return null;

	}
	if ( parsed && typeof parsed === 'object' ) {

		if ( parsed.v === 2 && typeof parsed.g === 'string' ) {

			const ghost = decodeGhostBinary( parsed.g );
			if ( ghost ) return { url: typeof parsed.url === 'string' ? parsed.url : '', ghost };

		}
		// Legacy v1 (and untagged {url, ghost}) payloads.
		if ( parsed.ghost && typeof parsed.ghost === 'object' && Array.isArray( parsed.ghost.samples ) ) {

			return { url: typeof parsed.url === 'string' ? parsed.url : '', ghost: parsed.ghost };

		}

	}
	return null;

}

// Re-encode any decoded ghost ({url, ghost}) as a v1 JSON code. Used by the
// track board publish flow: the deployed board worker validates the v1
// shape, so clients translate v2 → v1 before POSTing until the worker is
// updated. Returns null for ghosts the v1 shape cannot represent.
export function ghostToLegacyV1Code( url, ghost ) {

	if ( ! ghost || ! Array.isArray( ghost.samples ) || ghost.samples.length < 2 ) return null;
	const legacy = {
		v: 1,
		url: String( url || '' ),
		ghost: {
			car: typeof ghost.car === 'string' ? ghost.car : undefined,
			cosmetics: ghost.cosmetics || undefined,
			bestLapSeconds: Number.isFinite( ghost.bestLapSeconds ) ? ghost.bestLapSeconds : undefined,
			duration: Number.isFinite( ghost.duration ) ? ghost.duration : undefined,
			samples: ghost.samples,
		},
	};
	return bytesToBase64Url( utf8Bytes( JSON.stringify( legacy ) ) );

}
