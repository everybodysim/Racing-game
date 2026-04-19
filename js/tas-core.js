export const TAS_NEUTRAL_STEP = Object.freeze( {
	keys: Object.freeze( { left: false, right: false, up: false, down: false } )
} );

export function normalizeStepInput( rawStep ) {

	const keys = rawStep?.keys || {};
	const x = Number( rawStep?.x );
	const z = Number( rawStep?.z );
	return {
		keys: {
			left: Boolean( keys.left || keys.ArrowLeft || keys.KeyA || keys.a || ( Number.isFinite( x ) && x < - 0.25 ) ),
			right: Boolean( keys.right || keys.ArrowRight || keys.KeyD || keys.d || ( Number.isFinite( x ) && x > 0.25 ) ),
			up: Boolean( keys.up || keys.forward || keys.ArrowUp || keys.KeyW || keys.w || ( Number.isFinite( z ) && z > 0.25 ) ),
			down: Boolean( keys.down || keys.back || keys.ArrowDown || keys.KeyS || keys.s || ( Number.isFinite( z ) && z < - 0.25 ) ),
		}
	};

}

export function parseInputLines( text ) {

	const direct = tryParseDirectStepArray( text );
	if ( direct ) return direct;
	const out = [];
	for ( const line of String( text || '' ).split( '\n' ) ) {

		const trimmed = line.trim();
		if ( ! trimmed ) continue;
		const csvMatch = trimmed.match( /^(.*?)[,\s]+(-?\d+(?:\.\d+)?)$/ );
		const tokenPart = csvMatch ? csvMatch[ 1 ].trim() : trimmed;
		let fRaw = csvMatch ? csvMatch[ 2 ] : '1';
		const cols = tokenPart.split( ',' ).map( ( v ) => v.trim() ).filter( Boolean );
		const inputRaw = cols[ 0 ] || tokenPart;
		let legacyAxes = null;
		if ( cols.length >= 3 && Number.isFinite( Number( cols[ 0 ] ) ) && Number.isFinite( Number( cols[ 1 ] ) ) ) {

			legacyAxes = { x: Number( cols[ 0 ] ), z: Number( cols[ 1 ] ) };
			fRaw = cols[ 2 ] || '1';

		} else if ( cols.length === 2 && Number.isFinite( Number( cols[ 0 ] ) ) && Number.isFinite( Number( cols[ 1 ] ) ) ) {

			legacyAxes = { x: Number( cols[ 0 ] ), z: Number( cols[ 1 ] ) };

		}
		const frames = Math.max( 1, Math.min( 1200, Math.floor( Number( fRaw ) || 1 ) ) );
		const keys = legacyAxes
			? normalizeStepInput( legacyAxes ).keys
			: normalizeStepInput( {
				keys: (() => {

					const token = String( inputRaw ).trim();
					const parts = token.split( '+' ).map( ( v ) => v.trim() ).filter( Boolean );
					return {
						left: parts.includes( 'ArrowLeft' ) || parts.includes( 'KeyA' ) || parts.includes( 'A' ),
						right: parts.includes( 'ArrowRight' ) || parts.includes( 'KeyD' ) || parts.includes( 'D' ),
						up: parts.includes( 'ArrowUp' ) || parts.includes( 'KeyW' ) || parts.includes( 'W' ),
						down: parts.includes( 'ArrowDown' ) || parts.includes( 'KeyS' ) || parts.includes( 'S' ),
					};

				})()
			} ).keys;
		for ( let i = 0; i < frames; i ++ ) out.push( { keys } );

	}
	return out;

}

export function serializeSteps( stepArray ) {

	if ( ! stepArray.length ) return '';
	const rows = [];
	const keyLabel = ( step ) => {

		const keys = [];
		if ( step.keys?.up ) keys.push( 'ArrowUp' );
		if ( step.keys?.down ) keys.push( 'ArrowDown' );
		if ( step.keys?.left ) keys.push( 'ArrowLeft' );
		if ( step.keys?.right ) keys.push( 'ArrowRight' );
		return keys.join( '+' ) || 'None';

	};
	let prev = stepArray[ 0 ], count = 1;
	for ( let i = 1; i < stepArray.length; i ++ ) {

		const s = stepArray[ i ];
		const same = JSON.stringify( s.keys ) === JSON.stringify( prev.keys );
		if ( same ) count ++;
		else {

			rows.push( `${ keyLabel( prev ) },${ count }` );
			prev = s;
			count = 1;

		}

	}
	rows.push( `${ keyLabel( prev ) },${ count }` );
	return rows.join( '\n' );

}

export function keysToAxes( keys ) {

	if ( ! keys ) return { x: 0, z: 0 };
	const x = ( keys.right ? 1 : 0 ) - ( keys.left ? 1 : 0 );
	const z = ( keys.up ? 1 : 0 ) - ( keys.down ? 1 : 0 );
	return { x, z };

}

export function decodeStepsFromQuery( searchParams, key = 'tas' ) {

	if ( ! searchParams ) return null;
	const raw = searchParams.get( key );
	if ( ! raw ) return null;
	try {

		const normalized = raw.replace( /-/g, '+' ).replace( /_/g, '/' );
		const json = decodeURIComponent( escape( atob( normalized ) ) );
		const parsed = JSON.parse( json );
		if ( Array.isArray( parsed ) ) return parsed.map( normalizeStepInput );
		if ( Array.isArray( parsed?.steps ) ) return parsed.steps.map( normalizeStepInput );
		return null;

	} catch {

		return null;

	}

}

function tryParseDirectStepArray( text ) {

	const trimmed = String( text || '' ).trim();
	if ( ! trimmed ) return null;
	if ( ! ( trimmed.startsWith( '[' ) || trimmed.startsWith( '{' ) ) ) return null;
	try {

		const parsed = JSON.parse( trimmed );
		if ( Array.isArray( parsed ) ) return parsed.map( ( step ) => normalizeStepInput( step ) );
		if ( Array.isArray( parsed?.steps ) ) return parsed.steps.map( ( step ) => normalizeStepInput( step ) );
		return null;

	} catch {

		return null;

	}

}

export class DeterministicPlaybackController {

	constructor() {

		this.steps = [];
		this.frameIndex = 0;
		this.running = false;

	}

	loadSteps( steps ) {

		this.steps = Array.isArray( steps ) ? steps.map( ( step ) => normalizeStepInput( step ) ) : [];
		this.frameIndex = 0;

	}

	loadFromText( text ) {

		this.loadSteps( parseInputLines( text ) );
		return this.steps;

	}

	start() {

		this.running = true;

	}

	stop() {

		this.running = false;

	}

	resetFrame() {

		this.frameIndex = 0;

	}

	nextStep() {

		if ( ! this.running ) return null;
		if ( this.frameIndex >= this.steps.length ) {

			this.running = false;
			return null;

		}
		const step = this.steps[ this.frameIndex ];
		this.frameIndex += 1;
		return step;

	}

	nextAxes( fallbackInput = { x: 0, z: 0 } ) {

		const step = this.nextStep();
		return step ? keysToAxes( step.keys ) : fallbackInput;

	}

}
