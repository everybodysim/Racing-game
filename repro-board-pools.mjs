// Load REAL tracks from the share board, keep the ones with pools, and
// render each at LOW vs MEDIUM quality — metric-compare the water region.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const board = await fetch( 'https://racing-track-board-api.ga1010.workers.dev/api/tracks' ).then( r => r.json() );
const entries = ( board.entries || [] ).slice( 0, 60 );

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );

// Decode mods in-page to find tracks with water cells / custom pools
const prep = await ctx.newPage();
await prep.goto( 'http://localhost:8123/editor.html' );
await prep.waitForTimeout( 1200 );
const decoded = await prep.evaluate( async ( entries ) => {
	const T = await import( './js/Track.js' );
	const out = [];
	for ( const e of entries ) {
		try {
			const u = new URL( e.playUrl );
			const modsParam = u.searchParams.get( 'mods' );
			if ( ! modsParam ) continue;
			let mods = null;
			try { mods = modsParam.startsWith( 'v3.' ) ? await T.decodeV3Json( modsParam ) : JSON.parse( modsParam ); } catch ( err ) { mods = null; }
			if ( ! mods || typeof mods !== 'object' ) continue;
			const water = Array.isArray( mods.water ) ? mods.water : ( Array.isArray( mods.q ) ? mods.q : [] );
			if ( ! water.length ) continue;
			out.push( { name: e.name, url: u.search, water: water.length, custom: !! ( mods.r?.colorsOn || mods.customPool ) } );
		} catch ( err ) { /* skip */ }
	}
	return out;
}, entries );
await prep.close();

console.log( `pool tracks on board: ${ decoded.length } / ${ entries.length } scanned` );
const picks = decoded.slice( 0, 5 );

const analyze = async ( page, file ) => {
	const dataUrl = 'data:image/png;base64,' + readFileSync( file ).toString( 'base64' );
	return await page.evaluate( async ( url ) => {
		const img = new Image();
		await new Promise( ( res, rej ) => { img.onload = res; img.onerror = rej; img.src = url; } );
		const c = document.createElement( 'canvas' );
		c.width = img.width; c.height = img.height;
		const g = c.getContext( '2d' );
		g.drawImage( img, 0, 0 );
		const x0 = Math.floor( img.width * 0.3 ), x1 = Math.floor( img.width * 0.7 );
		const y0 = Math.floor( img.height * 0.4 ), y1 = Math.floor( img.height * 0.8 );
		const d = g.getImageData( x0, y0, x1 - x0, y1 - y0 ).data;
		const W = x1 - x0, H = y1 - y0;
		let lum = 0, n = 0, black = 0, grad = 0, gradMax = 0;
		const L = ( i ) => 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];
		for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {
			const i = ( y * W + x ) * 4;
			const l = L( i ); lum += l; n ++;
			if ( l < 8 ) black ++;
			if ( x > 0 && y > 0 ) {
				const gx = Math.abs( l - L( i - 4 ) );
				const gy = Math.abs( l - L( i - W * 4 ) );
				const m = gx + gy; grad += m; if ( m > gradMax ) gradMax = m;
			}
		}
		return { meanLum: Math.round( lum / n ), blackPct: +( ( black / n ) * 100 ).toFixed( 1 ),
			gradMean: + ( grad / n ).toFixed( 1 ), gradMax };
	}, dataUrl );
};

for ( const t of picks ) {
	const line = { name: t.name, results: {} };
	for ( const quality of [ 'low', 'medium' ] ) {
		const page = await ctx.newPage();
		await page.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
		await page.goto( `http://localhost:8123/index.html${ t.url }` );
		await page.waitForTimeout( 9000 );
		// park a camera looking straight down at the biggest water cluster
		const info = await page.evaluate( () => {
			const D = window.__skidWaterDebug;
			const pools = [];
			D.getScene().traverse( o => { if ( o.userData?.waterWorldSphere ) pools.push( o ); } );
			if ( ! pools.length ) return null;
			const s = pools[ 0 ].userData.waterWorldSphere;
			const c = s ? s.center : null;
			if ( ! c ) return null;
			D.getFreecam().active = true;
			D.getCamera().position.set( c.x, c.y + 14, c.z + 2 );
			D.getFreecam().yaw = 0; D.getFreecam().pitch = -1.1;
			return { x: c.x, y: c.y, z: c.z };
		} );
		await page.waitForTimeout( 700 );
		const file = `board-${ quality }-${ t.name.replace( /[^a-z0-9]+/gi, '-' ).toLowerCase() }.png`;
		await page.screenshot( { path: file } );
		line.results[ quality ] = info ? await analyze( page, file ) : 'no-pool-found-in-scene';
		await page.close();
	}
	console.log( JSON.stringify( line ) );
}

await browser.close();
