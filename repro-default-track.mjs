// Boot the game on its default track; compare default view low vs medium,
// including a live quality flip while looking at whatever the default scene has.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );
const quality = process.argv[ 2 ] || 'low';
const page = await ctx.newPage();
const errs = [];
page.on( 'pageerror', e => errs.push( String( e ).slice( 0, 150 ) ) );
await page.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
await page.goto( 'http://localhost:8123/index.html?play=1' );
await page.waitForTimeout( 9000 );

const info = await page.evaluate( () => {
	const D = window.__skidWaterDebug;
	const water = D.getScene().children.filter( ( c ) => c.userData?.waterWorldSphere || c.material?.uniforms?.tDiffuse ).length;
	return { waterPlanes: water, camPos: D.getCamera().position.toArray(), fog: !! D.getScene().fog };
} );
await page.screenshot( { path: `default-${ quality }.png` } );

const dataUrl = 'data:image/png;base64,' + readFileSync( `default-${ quality }.png` ).toString( 'base64' );
const ascii = await page.evaluate( async ( url ) => {
	const img = new Image();
	await new Promise( ( res, rej ) => { img.onload = res; img.onerror = rej; img.src = url; } );
	const c = document.createElement( 'canvas' );
	c.width = img.width; c.height = img.height;
	const g = c.getContext( '2d' );
	g.drawImage( img, 0, 0 );
	const W = 72, H = 26;
	g.drawImage( img, 0, 0, W, H );
	const d = g.getImageData( 0, 0, W, H ).data;
	const chars = ' .:-=+*#%@';
	const out = [];
	let lum = 0, n = 0, black = 0;
	for ( let y = 0; y < H; y ++ ) {
		let line = '';
		for ( let x = 0; x < W; x ++ ) {
			const i = ( y * W + x ) * 4;
			const L = ( 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ] ) / 255;
			line += chars[ Math.min( 9, Math.floor( L * 10 ) ) ];
			lum += L; n ++;
			if ( L < 0.1 ) black ++;
		}
		out.push( line );
	}
	return { ascii: out, meanLum: Math.round( lum / n * 100 ) / 100, blackPct: Math.round( 1000 * black / n ) / 10 };
}, dataUrl );
console.log( `default-track/${quality}`, JSON.stringify( info ), 'meanLum', ascii.meanLum, 'black%', ascii.blackPct, 'errs', errs.length );
console.log( ascii.ascii.join( '\n' ) );
await browser.close();
