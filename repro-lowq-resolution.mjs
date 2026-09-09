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

async function loadAt( quality ) {
	const gm = await ctx.newPage();
	await gm.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
	await gm.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( payload.v3 ) }&mods=${ encodeURIComponent( payload.mods3 ) }` );
	await gm.waitForTimeout( 8000 );
	const info = await gm.evaluate( () => {
		const D = window.__skidWaterDebug;
		return {
			waterUniforms: D.getWaterUniforms(),
			drawingBuffer: D.getDrawingBufferSize(),
			cssSize: [ window.innerWidth, window.innerHeight ],
			dpr: window.devicePixelRatio,
			rendererPixelRatio: D.getRenderer().getPixelRatio(),
			canvasWH: [ D.getRenderer().domElement.width, D.getRenderer().domElement.height ],
		};
	} );
	console.log( quality, JSON.stringify( info ) );
	await gm.screenshot( { path: `lowq-repro-${ quality }.png` } );
	await gm.close();
}

await loadAt( 'low' );
await loadAt( 'medium' );

await browser.close();
