import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const browser = await chromium.launch();
const page = await ( await browser.newContext() ).newPage();
await page.goto( 'about:blank' );
const url = 'data:image/png;base64,' + readFileSync( 'lowq-cam-low.png' ).toString( 'base64' );
const out = await page.evaluate( async ( u ) => {
	const img = new Image();
	await new Promise( ( r, j ) => { img.onload = r; img.onerror = j; img.src = u; } );
	const W = img.width, H = img.height;
	const c = document.createElement( 'canvas' );
	c.width = W; c.height = H;
	const g = c.getContext( '2d' );
	g.drawImage( img, 0, 0 );
	const d = g.getImageData( 0, 0, W, H ).data;
	const L = new Float32Array( W * H );
	for ( let i = 0, p = 0; i < d.length; i += 4, p ++ ) L[ p ] = 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];

	// For each 8x8 block: smallScale = mean |grad| at 1-2px, largeScale = block
	// min/max range. Refracted detail => large range; caustics-on-flat => high
	// small-scale but narrow range; flat => low both.
	const B = 8, BX = Math.floor( W / B ), BY = Math.floor( H / B );
	const rows = [];
	for ( let by = 0; by < BY; by ++ ) {
		let line = '';
		for ( let bx = 0; bx < BX; bx ++ ) {
			let lo = 255, hi = 0, grad = 0, n = 0;
			for ( let y = 0; y < B; y ++ ) for ( let x = 0; x < B; x ++ ) {
				const px = bx * B + x, py = by * B + y;
				const l = L[ py * W + px ];
				if ( l < lo ) lo = l; if ( l > hi ) hi = l;
				if ( x > 0 ) grad += Math.abs( l - L[ py * W + px - 1 ] );
				n ++;
			}
			const range = hi - lo, sg = grad / n;
			// classify: R=refracted(detail, wide range), C=caustics(narrow range, texture), .=flat
			line += range > 60 ? 'R' : ( sg > 6 ? 'c' : ( range > 25 ? 'r' : '.' ) );
		}
		rows.push( line );
	}
	return { W, H, B, BX, BY, rows };
}, url );
console.log( `img ${ out.W }x${ out.H }, block ${ out.B }, grid ${ out.BX }x${ out.BY }` );
console.log( out.rows.join( '\n' ) );
await browser.close();
