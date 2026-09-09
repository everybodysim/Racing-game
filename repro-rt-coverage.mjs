// Read the water refraction RT directly: check whether the scene content
// covers the FULL texture or only a bottom-left sub-rect (the 0.85 pixelRatio
// squeeze). Sample 5x5 pixel blocks at center / top-right / bottom-left /
// right-edge / top-edge and compare against the freshly-cleared background.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } );

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
	const mods = { b: [], p: [], k: [], l: [ [ 1, 1, 0 ] ], j: [], o: [], e: [], u: [], d: [], m: [], a: [],
		t: 'normal', w: { preset: 'clear' }, c: {}, y: {}, x: {}, r: {}, q: [ [ 0, 3 ], [ 1, 3 ], [ 2, 3 ], [ 0, 4 ], [ 1, 4 ], [ 2, 4 ], [ 0, 5 ], [ 1, 5 ], [ 2, 5 ] ], z: [] };
	const mods3 = await T.encodeV3Json( mods );
	return { v3, mods3 };
} );
await ed.close();

async function probe( quality ) {
	const gm = await ctx.newPage();
	await gm.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
	await gm.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( payload.v3 ) }&mods=${ encodeURIComponent( payload.mods3 ) }` );
	await gm.waitForTimeout( 7000 );
	const out = await gm.evaluate( () => {
		const D = window.__skidWaterDebug;
		const r = D.getRenderer();
		const rt = window.__waterRT;
		if ( ! rt ) return { err: 'no RT captured' };
		const W = rt.width, H = rt.height;
		const db = [ r.domElement.width, r.domElement.height ];
		const pr = r.getPixelRatio();
		const block = ( x, y ) => {
			const b = new Uint8Array( 4 * 5 * 5 );
			r.readRenderTargetPixels( rt, Math.floor( x ), Math.floor( y ), 5, 5, b );
			let lum = 0;
			for ( let i = 0; i < b.length; i += 4 ) lum += 0.2126 * b[ i ] + 0.7152 * b[ i + 1 ] + 0.0722 * b[ i + 2 ];
			return Math.round( lum / 25 );
		};
		// coverage hypothesis: rendered region = bottom-left (0..0.85W, 0..0.85H) at pr 0.85
		const fx = pr < 1 ? 0.85 : 1.0;
		return {
			lsq: localStorage.getItem('racing-graphics-quality'), rtSize: [ W, H ], db, pr,
			samples: {
				center: block( W * 0.5, H * 0.5 ),
				'bottom-left (inside rendered region)': block( 4, 4 ),
				'right-edge (beyond 0.85W)': block( W - 6, H * 0.5 ),
				'top-edge (beyond 0.85H)': block( W * 0.5, H - 6 ),
				'top-right corner': block( W - 6, H - 6 ),
			},
			expectedCoverage: fx,
		};
	} );
	console.log( quality, JSON.stringify( out ) );
	await gm.close();
}

await probe( 'low' );
await probe( 'medium' );
await browser.close();
