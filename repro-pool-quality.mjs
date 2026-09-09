// Reproduce + diagnose the broken-pools-in-low-quality issue.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const quality = process.argv[ 2 ] || 'low';
const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );

// build the pool track payload
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
// force the quality preset before the game script runs
await page.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
await page.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( prep.v3 ) }&mods=${ encodeURIComponent( prep.mods ) }` );
await page.waitForTimeout( 9000 );

// park the freecam looking down at the pool from above at an angle
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
await page.waitForTimeout( 1000 );
const shot = `pool-quality-${ quality }.png`;
await page.screenshot( { path: shot } );

// dump diagnostics + pixel stats of the pool region (center band of screen)
const stats = await page.evaluate( () => {
	const D = window.__skidWaterDebug;
	const r = D.getRenderer();
	return { pixelRatio: r.getPixelRatio(), drawingBuffer: [ r.domElement.width, r.domElement.height ],
		shadowEnabled: r.shadowMap.enabled, errors: window.__pageErrors || [] };
} );

// pixel analysis: load the PNG back, sample a grid over the pool area
const dataUrl = 'data:image/png;base64,' + readFileSync( shot ).toString( 'base64' );
const px = await page.evaluate( async ( url ) => {
	const img = new Image();
	await new Promise( ( res, rej ) => { img.onload = res; img.onerror = rej; img.src = url; } );
	const c = document.createElement( 'canvas' );
	c.width = img.width; c.height = img.height;
	const g = c.getContext( '2d' );
	g.drawImage( img, 0, 0 );
	// pool occupies roughly the center of the frame from this camera
	const x0 = Math.floor( img.width * 0.35 ), x1 = Math.floor( img.width * 0.65 );
	const y0 = Math.floor( img.height * 0.45 ), y1 = Math.floor( img.height * 0.75 );
	const d = g.getImageData( x0, y0, x1 - x0, y1 - y0 ).data;
	let lum = 0, mn = 999, mx = -1, blueish = 0, n = 0;
	const vals = [];
	for ( let i = 0; i < d.length; i += 40 ) { // sparse sample
		const r = d[ i ], gg = d[ i + 1 ], b = d[ i + 2 ];
		const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
		lum += L; vals.push( L ); n ++;
		if ( L < mn ) mn = L; if ( L > mx ) mx = L;
		if ( b > r * 1.15 && b > 60 ) blueish ++;
	}
	vals.sort( ( a, b ) => a - b );
	return { meanLum: Math.round( lum / n ), minLum: Math.round( mn ), maxLum: Math.round( mx ), medianLum: Math.round( vals[ Math.floor( vals.length / 2 ) ] ),
		blueishPct: Math.round( 100 * blueish / n ), n };
}, dataUrl );

console.log( `quality=${ quality }`, JSON.stringify( stats ) );
console.log( `pool-region pixels:`, JSON.stringify( px ) );
console.log( 'pageerrors:', errs.length, errs.slice( 0, 2 ) );
await browser.close();
