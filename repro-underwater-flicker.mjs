import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );

// ── page 1: build a v3 map + mods with a water pool ──
const ed = await ctx.newPage();
await ed.goto( 'http://localhost:8123/editor.html' );
await ed.waitForTimeout( 1500 );
const payload = await ed.evaluate( async () => {
	const T = await import( './js/Track.js' );
	const cells = [];
	for ( let i = 0; i < 120; i ++ ) {
		const a = ( i / 120 ) * Math.PI * 2;
		cells.push( [ Math.round( Math.sin( a ) * 14 ), Math.round( Math.cos( a ) * 14 ), i % 17 === 0 ? 'track-3-way' : 'track-straight', 0 ] );
	}
	cells.push( [ 0, 14, 'track-start-finish', 0 ] );
	const v3 = await T.encodeCellsV3( cells );
	// 3x3 pool at cells (0..2, 3..5) — mods key q = water cells
	const mods = { b: [], p: [], k: [], l: [ [ 1, 1, 0 ] ], j: [], o: [], e: [], u: [], d: [], m: [], a: [],
		t: 'normal', w: { preset: 'clear' }, c: {}, y: {}, x: {}, r: {}, q: [ [ 0, 3 ], [ 1, 3 ], [ 2, 3 ], [ 0, 4 ], [ 1, 4 ], [ 2, 4 ], [ 0, 5 ], [ 1, 5 ], [ 2, 5 ] ], z: [] };
	const mods3 = await T.encodeV3Json( mods );
	return { v3, mods3 };
} );
await ed.close();

// ── page 2: the game ──
const gm = await ctx.newPage();
const errs = [];
gm.on( 'pageerror', e => errs.push( String( e ).slice( 0, 120 ) ) );
await gm.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( payload.v3 ) }&mods=${ encodeURIComponent( payload.mods3 ) }` );
await gm.waitForTimeout( 9000 );

// spoof pointer lock so freecam toggles cleanly
await gm.evaluate( () => {
	const canvas = document.querySelector( 'canvas' );
	canvas.requestPointerLock = () => {};
	Object.defineProperty( document, 'pointerLockElement', { get: () => canvas, configurable: true } );
} );
await gm.evaluate( () => window.dispatchEvent( new KeyboardEvent( 'keydown', { bubbles: true, cancelable: true, code: 'KeyF' } ) ) );
await gm.waitForTimeout( 300 );
const camState = await gm.evaluate( () => {
	const D = window.__skidWaterDebug;
	return { freecam: D.getFreecam().active, hook: !!D };
} );
console.log( 'freecam active:', camState.freecam, '| hook:', camState.hook, '| pageerrors:', errs.length );

// park the camera underwater inside the pool, looking at the floor
// pool spans cells gx 0..2, gz 3..5 -> world center ~ (1.5*9.99, *, 4.5*9.99)
await gm.evaluate( () => {
	const D = window.__skidWaterDebug;
	const c = D.getCamera();
	c.position.set( 1.5 * 9.99, -2, 4.5 * 9.99 );
	const f = D.getFreecam();
	f.yaw = 0; f.pitch = -1.2; // look steeply down
} );
await gm.waitForTimeout( 1200 ); // let the underwater state + caustic gain settle

// per-frame luminance sampler over the pool floor
const series = await gm.evaluate( () => new Promise( ( resolve ) => {
	const canvas = document.querySelector( 'canvas' );
	const gl = canvas.getContext( 'webgl2' ) || canvas.getContext( 'webgl' );
	const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
	const buf = new Uint8Array( 4 );
	const samples = [];
	let n = 0;
	function sample() {
		// 3x3 grid of points around screen center
		let lum = 0;
		for ( const [ fx, fy ] of [ [ 0.44, 0.44 ], [ 0.5, 0.44 ], [ 0.56, 0.44 ], [ 0.44, 0.5 ], [ 0.5, 0.5 ], [ 0.56, 0.5 ], [ 0.44, 0.56 ], [ 0.5, 0.56 ], [ 0.56, 0.56 ] ] ) {
			const px = Math.floor( fx * w ), py = Math.floor( ( 1 - fy ) * h );
			gl.readPixels( px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf );
			lum += 0.2126 * buf[ 0 ] + 0.7152 * buf[ 1 ] + 0.0722 * buf[ 2 ];
		}
		samples.push( lum / 9 );
		n ++;
		if ( n >= 90 ) resolve( samples.map( v => Math.round( v * 10 ) / 10 ) );
		else requestAnimationFrame( sample );
	}
	requestAnimationFrame( sample );
} ) );

// analyze: every-other-frame alternation => |L[i]-L[i+2]| small while |L[i]-L[i+1]| large
let big = 0, small = 0;
for ( let i = 0; i + 2 < series.length; i ++ ) {
	const d1 = Math.abs( series[ i ] - series[ i + 1 ] );
	const d2 = Math.abs( series[ i ] - series[ i + 2 ] );
	if ( d1 > 6 ) big ++;
	if ( d1 > 6 && d2 < 3 ) small ++;
}
console.log( 'luminance series (90 frames):', JSON.stringify( series ) );
console.log( `consecutive-frame jumps >6: ${big} | of those, back-to-same-value-2-frames-later: ${small}` );
console.log( small > big * 0.4 ? 'FLICKER REPRODUCED (alternating pattern)' : 'no strong alternation detected' );
await gm.screenshot( { path: 'underwater-repro.png' } );
await browser.close();
