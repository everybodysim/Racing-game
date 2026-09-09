// What do pools look like inside the EDITOR (no refraction pass ever runs there)?
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );

// Build the v3 payloads via the editor's own Track.js import
const prep = await ctx.newPage();
await prep.goto( 'http://localhost:8123/editor.html' );
await prep.waitForTimeout( 1200 );
const out = await prep.evaluate( async () => {
	const T = await import( './js/Track.js' );
	const cells = [];
	for ( let i = 0; i < 60; i ++ ) {
		const a = ( i / 60 ) * Math.PI * 2;
		cells.push( [ Math.round( Math.sin( a ) * 10 ), Math.round( Math.cos( a ) * 10 ), 'track-straight', 0 ] );
	}
	cells.push( [ 0, 10, 'track-start-finish', 0 ] );
	const water = [];
	for ( let gx = 1; gx <= 3; gx ++ ) for ( let gz = 3; gz <= 5; gz ++ ) water.push( [ gx, gz ] );
	const mods = { q: water, r: { colorsOn: true, waterColor: '#1180e6', edgeColor: '#5cc7ff' } };
	return { v3: await T.encodeCellsV3( cells ), mods: await T.encodeV3Json( mods ) };
} );
await prep.close();

const page = await ctx.newPage();
await page.goto( `http://localhost:8123/editor.html?map=${ encodeURIComponent( out.v3 ) }&mods=${ encodeURIComponent( out.mods ) }` );
await page.waitForTimeout( 3500 );
await page.screenshot( { path: 'editor-pool-view.png' } );

// metric on the pool region (center of the 20-cell ring, slightly below center)
const stats = await page.evaluate( ( ) => {
	const img = new Image();
	return 'dom-ready';
} );
void stats;

const analyze = ( file ) => {
	const { execSync } = require( 'child_process' );
	void execSync; void file;
};
// analyze in a fresh page (sharpness + luminance on the water)
const ap = await ctx.newPage();
await ap.goto( 'http://localhost:8123/editor.html' );
await ap.waitForTimeout( 500 );
const dataUrl = 'data:image/png;base64,' + readFileSync( 'editor-pool-view.png' ).toString( 'base64' );
const m = await ap.evaluate( async ( url ) => {
	const img = new Image();
	await new Promise( ( r, j ) => { img.onload = r; img.onerror = j; img.src = url; } );
	const c = document.createElement( 'canvas' );
	c.width = img.width; c.height = img.height;
	const g = c.getContext( '2d' );
	g.drawImage( img, 0, 0 );
	const x0 = Math.floor( img.width * 0.42 ), x1 = Math.floor( img.width * 0.58 );
	const y0 = Math.floor( img.height * 0.42 ), y1 = Math.floor( img.height * 0.62 );
	const d = g.getImageData( x0, y0, x1 - x0, y1 - y0 ).data;
	const W = x1 - x0, H = y1 - y0;
	let lum = 0, n = 0, grad = 0, black = 0, white = 0;
	const L = ( i ) => 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {
		const i = ( y * W + x ) * 4;
		const l = L( i ); lum += l; n ++;
		if ( l < 10 ) black ++;
		if ( l > 245 ) white ++;
		if ( x > 0 ) grad += Math.abs( l - L( i - 4 ) );
	}
	return { meanLum: Math.round( lum / n ), blackPct: + ( ( black / n ) * 100 ).toFixed( 1 ), whitePct: + ( ( white / n ) * 100 ).toFixed( 1 ), gradMean: + ( grad / n ).toFixed( 1 ) };
}, dataUrl );
console.log( 'editor pool region:', JSON.stringify( m ) );
await browser.close();
