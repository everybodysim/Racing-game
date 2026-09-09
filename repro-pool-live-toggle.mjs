// Diagnose: does switching quality LIVE break pools? (clean-boot looked fine)
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

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
		for ( let i = 0; i < 120; i ++ ) {
			const a = ( i / 120 ) * Math.PI * 2;
			cells.push( [ Math.round( Math.sin( a ) * 14 ), Math.round( Math.cos( a ) * 14 ), 'track-straight', 0 ] );
		}
		cells.push( [ 0, 14, 'track-start-finish', 0 ] );
		const v3 = await T.encodeCellsV3( cells );
		const water = [];
		for ( let gx = 0; gx <= 6; gx ++ ) for ( let gz = 3; gz <= 6; gz ++ ) water.push( [ gx, gz ] );
		const mods = { b: [], p: [], k: [], l: [], j: [], o: [], t: 'normal',
			q: water, r: { drag: 1.8, buoyancy: 0.28, colorsOn: true, waterColor: '#1f8fd6', edgeColor: '#5cc7ff', transparent: true },
			e: [], u: [], d: [], m: [], a: [], w: { preset: 'clear' }, c: {}, y: {}, x: {}, z: [] };
		return { v3, mods: await T.encodeV3Json( mods ) };
	} );
	await b.close();
	return out;
} )();

const page = await ctx.newPage();
const errs = [];
page.on( 'pageerror', e => errs.push( String( e ).slice( 0, 150 ) ) );
await page.addInitScript( () => localStorage.setItem( 'racing-graphics-quality', 'medium' ) );
await page.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( prep.v3 ) }&mods=${ encodeURIComponent( prep.mods ) }` );
await page.waitForTimeout( 9000 );
await page.evaluate( () => {
	const canvas = document.querySelector( 'canvas' );
	canvas.requestPointerLock = () => {};
	Object.defineProperty( document, 'pointerLockElement', { get: () => canvas, configurable: true } );
	const D = window.__skidWaterDebug;
	D.getFreecam().active = true; // freecam mod not installed in tests — flip state directly
} );
await page.waitForTimeout( 300 );
await page.evaluate( () => {
	const D = window.__skidWaterDebug;
	D.getCamera().position.set( 3.5 * 9.99, 6, 4.5 * 9.99 );
	D.getFreecam().yaw = Math.PI; D.getFreecam().pitch = -0.7;
} );
await page.waitForTimeout( 800 );
await page.screenshot( { path: 'pool-live-before.png' } );

// ── flip to LOW live ──
await page.evaluate( () => document.querySelector( '[data-graphics-quality="low"]' )?.click() );
await page.waitForTimeout( 1500 );
await page.screenshot( { path: 'pool-live-after-low.png' } );
const diag = await page.evaluate( () => {
	const D = window.__skidWaterDebug;
	const r = D.getRenderer();
	return { pixelRatio: r.getPixelRatio(), shadowEnabled: r.shadowMap.enabled, castShadow: D.getLight().castShadow };
} );

// compare before/after pool regions
const analyze = async ( file ) => {
	const dataUrl = 'data:image/png;base64,' + readFileSync( file ).toString( 'base64' );
	return await page.evaluate( async ( url ) => {
		const img = new Image();
		await new Promise( ( res, rej ) => { img.onload = res; img.onerror = rej; img.src = url; } );
		const c = document.createElement( 'canvas' );
		c.width = img.width; c.height = img.height;
		const g = c.getContext( '2d' );
		g.drawImage( img, 0, 0 );
		const x0 = Math.floor( img.width * 0.35 ), x1 = Math.floor( img.width * 0.65 );
		const y0 = Math.floor( img.height * 0.45 ), y1 = Math.floor( img.height * 0.75 );
		const d = g.getImageData( x0, y0, x1 - x0, y1 - y0 ).data;
		let lum = 0, mn = 999, mx = -1, black = 0, n = 0;
		for ( let i = 0; i < d.length; i += 40 ) {
			const L = 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];
			lum += L; n ++;
			if ( L < mn ) mn = L; if ( L > mx ) mx = L;
			if ( L < 25 ) black ++;
		}
		return { meanLum: Math.round( lum / n ), minLum: Math.round( mn ), maxLum: Math.round( mx ), blackPct: Math.round( 1000 * black / n ) / 10 };
	}, dataUrl );
};
console.log( 'before :', JSON.stringify( await analyze( 'pool-live-before.png' ) ) );
console.log( 'after  :', JSON.stringify( await analyze( 'pool-live-after-low.png' ) ) );
console.log( 'diag:', JSON.stringify( diag ), 'errors:', errs.length );
await browser.close();
