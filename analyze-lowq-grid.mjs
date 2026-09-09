import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );
const page = await ctx.newPage();
await page.goto( 'http://localhost:8123/editor.html' );
await page.waitForTimeout( 800 );

for ( const q of [ 'low', 'medium' ] ) {
	const url = 'data:image/png;base64,' + readFileSync( `lowq-cam-${ q }.png` ).toString( 'base64' );
	const grid = await page.evaluate( async ( u ) => {
		const img = new Image();
		await new Promise( ( r, j ) => { img.onload = r; img.onerror = j; img.src = u; } );
		const c = document.createElement( 'canvas' );
		c.width = img.width; c.height = img.height;
		const g = c.getContext( '2d' );
		g.drawImage( img, 0, 0 );
		const TW = 12, TH = 8;
		const tw = Math.floor( img.width / TW ), th = Math.floor( img.height / TH );
		const tiles = [];
		for ( let ty = 0; ty < TH; ty ++ ) {
			const row = [];
			for ( let tx = 0; tx < TW; tx ++ ) {
				const d = g.getImageData( tx * tw, ty * th, tw, th ).data;
				let lum = 0, grad = 0, n = 0;
				const L = ( i ) => 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];
				for ( let y = 0; y < th; y += 2 ) for ( let x = 0; x < tw; x += 2 ) {
					const i = ( y * tw + x ) * 4;
					const l = L( i ); lum += l; n ++;
					if ( x > 0 ) grad += Math.abs( l - L( i - 8 ) );
					if ( y > 0 ) grad += Math.abs( l - L( i - tw * 8 ) );
				}
				row.push( { m: Math.round( lum / n ), g: + ( grad / n ).toFixed( 1 ) } );
			}
			tiles.push( row );
		}
		return tiles;
	}, url );
	const grads = grid.flat().map( t => t.g ).sort( ( a, b ) => a - b );
	console.log( q, 'grad median:', grads[ Math.floor( grads.length / 2 ) ], 'min:', grads[ 0 ], 'max:', grads[ grads.length - 1 ] );
	console.log( q, 'gradient grid (rows top->bottom):' );
	for ( const row of grid ) console.log( row.map( t => String( t.g ).padStart( 5 ) ).join( '' ) );
}
await browser.close();
