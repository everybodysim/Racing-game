import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const browser = await chromium.launch();
const page = await ( await browser.newContext() ).newPage();
await page.goto( 'about:blank' );
const url = 'data:image/png;base64,' + readFileSync( '../incoming_files/934e150d5_Screenshot2026-09-0870608PM.png' ).toString( 'base64' );
const out = await page.evaluate( async ( u ) => {
	const img = new Image();
	await new Promise( ( r, j ) => { img.onload = r; img.onerror = j; img.src = u; } );
	const W = img.width, H = img.height;
	const c = document.createElement( 'canvas' );
	c.width = W; c.height = H;
	const g = c.getContext( '2d' );
	g.drawImage( img, 0, 0 );
	const d = g.getImageData( 0, 0, W, H ).data;
	const L = ( x, y ) => { const i = ( y * W + x ) * 4; return 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ]; };
	// 40x24 tile grid; per-tile mean gradient + mean luminance
	const TX = 40, TY = 24, tw = Math.floor( W / TX ), th = Math.floor( H / TY );
	const lines = [];
	for ( let ty = 0; ty < TY; ty ++ ) {
		let gradLine = '', lumLine = '';
		for ( let tx = 0; tx < TX; tx ++ ) {
			let grad = 0, lum = 0, n = 0;
			for ( let y = ty * th; y < ( ty + 1 ) * th; y += 2 ) for ( let x = tx * tw; x < ( tx + 1 ) * tw; x += 2 ) {
				const l = L( x, y ); lum += l; n ++;
				if ( x < ( tx + 1 ) * tw - 2 ) grad += Math.abs( L( x + 2, y ) - l );
				if ( y < ( ty + 1 ) * th - 2 ) grad += Math.abs( L( x, y + 2 ) - l );
			}
			const gm = grad / n, lm = lum / n;
			gradLine += gm > 8 ? '#' : gm > 4 ? '+' : gm > 1.5 ? '.' : ' ';
			lumLine += lm > 200 ? '9' : lm > 170 ? '7' : lm > 140 ? '5' : lm > 110 ? '3' : lm > 80 ? '2' : lm > 50 ? '1' : '0';
		}
		lines.push( `G|${ gradLine }|  L|${ lumLine }` );
	}
	return lines;
}, url );
console.log( out.join( '\n' ) );
await browser.close();
