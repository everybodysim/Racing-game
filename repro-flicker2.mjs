// Underwater shadow flicker repro: camera underwater on the pool floor,
// CPU-throttled to force low fps, shadow luminance sampled over time.
import { chromium } from 'playwright';

const quality = process.argv[ 2 ] || 'medium';
const throttle = process.argv[ 3 ] || '4'; // CPU throttle multiplier
const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );

// pool track with a car parked at the start (shadows from the ring + car)
const prep = await ( async () => {
	const b = await browser.newContext();
	const p = await b.newPage();
	await p.goto( 'http://localhost:8123/editor.html' );
	await p.waitForTimeout( 1000 );
	const out = await p.evaluate( async () => {
		const T = await import( './js/Track.js' );
		const cells = [];
		for ( let i = 0; i < 120; i ++ ) { const a = ( i / 120 ) * Math.PI * 2; cells.push( [ Math.round( Math.sin( a ) * 14 ), Math.round( Math.cos( a ) * 14 ), 'track-straight', 0 ] ); }
		cells.push( [ 0, 14, 'track-start-finish', 0 ] );
		const v3 = await T.encodeCellsV3( cells );
		const mods = { b: [], p: [], k: [], l: [], j: [], o: [], t: 'normal', e: [], u: [], d: [], m: [], a: [],
			w: { preset: 'clear' }, c: {}, y: {}, x: {}, z: [], r: { drag: 1.8, buoyancy: 0.28, colorsOn: true, waterColor: '#1f8fd6', edgeColor: '#5cc7ff', transparent: true } };
		mods.q = [];
		for ( let gx = 0; gx <= 6; gx ++ ) for ( let gz = 3; gz <= 6; gz ++ ) mods.q.push( [ gx, gz ] );
		return { v3, mods: await T.encodeV3Json( mods ) };
	} );
	await b.close();
	return out;
} )();

const page = await ctx.newPage();
const errs = [];
page.on( 'pageerror', e => errs.push( String( e ).slice( 0, 120 ) ) );
await page.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
await page.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( prep.v3 ) }&mods=${ encodeURIComponent( prep.mods ) }` );
await page.waitForTimeout( 9000 );

// park freecam underwater: on the pool floor looking across it (shadows visible)
await page.evaluate( () => {
	const D = window.__skidWaterDebug;
	const f = D.getFreecam();
	f.active = true;
	const c = D.getCamera();
	c.position.set( 1.1 * 9.99, -2.8, 3.6 * 9.99 );
	f.yaw = Math.PI * 0.5; f.pitch = -0.28;
} );
await page.waitForTimeout( 600 );

// throttle the CPU to force low fps
const cdp = await ctx.newCDPSession( page );
await cdp.send( 'Emulation.setCPUThrottlingRate', { rate: Number( throttle ) } );

// sample a shadow-region patch luminance ~10Hz for 6 seconds
const samples = [];
for ( let i = 0; i < 60; i ++ ) {
	const s = await page.evaluate( () => {
		const D = window.__skidWaterDebug;
		const r = D.getRenderer();
		// read a small patch from the drawing buffer (center-left band)
		const gl = r.getContext();
		const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
		const px = new Uint8Array( 4 * 32 * 32 );
		r.flush?.();
		gl.readPixels( Math.floor( W * 0.25 ), Math.floor( H * 0.4 ), 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px );
		let lum = 0;
		for ( let j = 0; j < px.length; j += 4 ) lum += 0.2126 * px[ j ] + 0.7152 * px[ j + 1 ] + 0.0722 * px[ j + 2 ];
		return lum / ( 32 * 32 );
	} );
	samples.push( Math.round( s * 10 ) / 10 );
	await page.waitForTimeout( 100 );
}
await cdp.send( 'Emulation.setCPUThrottlingRate', { rate: 1 } );

const min = Math.min( ... samples ), max = Math.max( ... samples );
const mean = samples.reduce( ( a, b ) => a + b, 0 ) / samples.length;
const varr = samples.reduce( ( a, b ) => a + ( b - mean ) ** 2, 0 ) / samples.length;
const jumps = samples.filter( ( v, i ) => i > 0 && Math.abs( v - samples[ i - 1 ] ) > 12 ).length;
console.log( `quality=${ quality } throttle=${ throttle }x meanLum=${ mean.toFixed( 1 ) } min=${ min } max=${ max } spread=${ ( max - min ).toFixed( 1 ) } stddev=${ Math.sqrt( varr ).toFixed( 1 ) } bigJumps=${ jumps }` );
console.log( 'samples:', samples.join( ' ' ) );
console.log( 'errs:', errs.length );
await browser.close();
