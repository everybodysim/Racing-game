// Per-frame underwater flicker probe: sample the SAME screen patch after
// every rendered frame (rAF registered after the game's loop), record
// luminance + shadow state, then detect alternation strobing.
import { chromium } from 'playwright';

const quality = process.argv[ 2 ] || 'medium';
const throttle = process.argv[ 3 ] || '1';
const secs = 6;
const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );

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

// park freecam underwater looking across the pool floor
await page.evaluate( () => {
	const D = window.__skidWaterDebug;
	const f = D.getFreecam();
	f.active = true;
	const c = D.getCamera();
	c.position.set( 1.1 * 9.99, -2.8, 3.6 * 9.99 );
	f.yaw = Math.PI * 0.5; f.pitch = -0.28;
} );
await page.waitForTimeout( 500 );

const cdp = await ctx.newCDPSession( page );
if ( throttle !== '1' ) await cdp.send( 'Emulation.setCPUThrottlingRate', { rate: Number( throttle ) } );

// install per-frame sampler (runs AFTER the game's rAF in each frame)
await page.evaluate( () => {
	window.__flick = { frames: [], t0: performance.now() };
	const probe = () => {
		const D = window.__skidWaterDebug;
		const r = D.getRenderer();
		const gl = r.getContext();
		const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
		const px = new Uint8Array( 4 * 32 * 32 );
		gl.readPixels( Math.floor( W * 0.25 ), Math.floor( H * 0.4 ), 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px );
		let lum = 0;
		for ( let j = 0; j < px.length; j += 4 ) lum += 0.2126 * px[ j ] + 0.7152 * px[ j + 1 ] + 0.0722 * px[ j + 2 ];
		window.__flick.frames.push( {
			l: Math.round( lum / ( 32 * 32 ) * 10 ) / 10,
			t: Math.round( performance.now() - window.__flick.t0 ),
			needsShadow: r.shadowMap.needsUpdate,
		} );
		requestAnimationFrame( probe );
	};
	requestAnimationFrame( probe );
} );
await page.waitForTimeout( secs * 1000 );

const res = await page.evaluate( ( frames ) => window.__flick.frames.slice( -frames ), Math.floor( secs * 60 ) );
const L = res.map( f => f.l );
const n = L.length;
const mean = L.reduce( ( a, b ) => a + b, 0 ) / n;
let spikes = 0, altStrobe = 0, needsShadowTrue = 0;
for ( let i = 1; i < n - 1; i ++ ) {
	const spike = Math.abs( L[ i ] - L[ i - 1 ] ) > 12 && Math.abs( L[ i ] - L[ i + 1 ] ) > 12;
	if ( spike ) { spikes ++; if ( L[ i ] > L[ i - 1 ] && L[ i ] > L[ i + 1 ] ) altStrobe ++; }
}
for ( const f of res ) if ( f.needsShadow ) needsShadowTrue ++;
// inter-frame interval => fps
const dts = [];
for ( let i = 1; i < res.length; i ++ ) dts.push( res[ i ].t - res[ i - 1 ].t );
dts.sort( ( a, b ) => a - b );
const medianDt = dts[ Math.floor( dts.length / 2 ) ] || 0;
console.log( `q=${ quality } throttle=${ throttle }x frames=${ n } fps≈${ medianDt ? Math.round( 1000 / medianDt ) : '?' } meanLum=${ mean.toFixed( 1 ) } minLum=${ Math.min( ...L ) } maxLum=${ Math.max( ...L ) } spikes=${ spikes } singleFrameSpikes=${ altStrobe } needsShadowTrue=${ needsShadowTrue }/${ n }` );
console.log( 'lum trace:', L.slice( 0, 120 ).join( ' ' ) );
console.log( 'errs:', errs.length );
await browser.close();
