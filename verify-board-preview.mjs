// End-to-end test: the failing v3 share URL (from the user's browserpad) must
// produce a real preview on the track share board, and v1/v2 URLs must keep
// working. Uses the local #board= hash mode (remote API is blocked).
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const failingUrl = readFileSync( '../incoming_files/049b33008_browserpad.txt' ).toString( 'utf8' ).trim();

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 900 } } );
// Block the remote board API so the page falls back to the local hash board
await ctx.route( '**/*', ( route ) => {
	const u = route.request().url();
	if ( u.includes( 'localhost:8123' ) ) return route.continue();
	return route.abort();
} );
const page = await ctx.newPage();
const errors = [];
page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( 'console: ' + m.text() ); } );

// Build the board hash: entries with the failing URL
const board = await page.evaluate( ( [ url ] ) => {
	const b64 = ( v ) => btoa( unescape( encodeURIComponent( JSON.stringify( v ) ) ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );
	return b64( { entries: [
		{ id: 'v3fail', name: 'v3 Custom Pads Track', playUrl: url, viewCount: 3, thumbsUp: 1, thumbsDown: 0 },
		{ id: 'v2ok', name: 'v2 Legacy Track', playUrl: 'index.html?map=v2.' + b64( { v: 2, cells: [ [ 0, 14, 'track-start-finish', 0 ], [ 1, 14, 'track-straight', 16 ], [ 2, 14, 'track-corner', 10 ] ] } ) + '&mods=none', viewCount: 1, thumbsUp: 0, thumbsDown: 0 },
	] } );
}, [ failingUrl ] );

await page.goto( `http://localhost:8123/tracks.html#board=${ board }` );
await page.waitForTimeout( 1500 );
// Scroll through the page so every preview canvas intersects the viewport
for ( let i = 0; i < 6; i ++ ) {
	await page.evaluate( () => window.scrollBy( 0, Math.round( window.innerHeight * 0.8 ) ) );
	await page.waitForTimeout( 350 );
}
for ( let i = 0; i < 6; i ++ ) {
	await page.evaluate( () => window.scrollBy( 0, -Math.round( window.innerHeight * 0.8 ) ) );
	await page.waitForTimeout( 150 );
}
await page.waitForTimeout( 1500 );

const result = await page.evaluate( async ( [ url ] ) => {
	const out = {};
	// 1. decode sanity
	try {
		const parsed = await parseTrackLayoutFromUrlAsync( url );
		out.v3Cells = parsed.cells.length;
		out.v3CellTypes = [ ...new Set( parsed.cells.map( ( c ) => c[ 2 ] ) ) ].slice( 0, 6 );
		out.v3ModsKeys = Object.keys( parsed.mods || {} );
		out.v3ModsArrays = Object.fromEntries( Object.entries( parsed.mods || {} ).filter( ( [ k, v ] ) => Array.isArray( v ) ).map( ( [ k, v ] ) => [ k, v.length ] ) );
		out.v3GhostPts = ( parsed.ghost || [] ).length;
	} catch ( e ) { out.v3DecodeError = String( e ); }
	// 2. cache primed
	out.cacheSize = v3PreviewCache.size;
	// 3. card canvas painted (v3 card + v2 card)
	for ( const [ id, label ] of [ [ 'v3fail', 'v3 Custom' ], [ 'v2ok', 'v2 Legacy' ] ] ) {
		const cards = [ ...document.querySelectorAll( '.card' ) ].filter( ( c ) => c.querySelector( 'h3' ) && c.textContent.includes( label ) );
		out[ id + 'CardCount' ] = cards.length;
		const paintCounts = [];
		for ( const card of cards ) {
			const canvas = card.querySelector( '.preview-canvas' );
			if ( ! canvas ) { paintCounts.push( -1 ); continue; }
			try {
				const g = canvas.getContext( '2d' );
				const d = g.getImageData( 0, 0, canvas.width, canvas.height ).data;
				let nonBg = 0;
				for ( let i = 0; i < d.length; i += 4 ) {
					if ( d[ i + 3 ] > 0 && ( d[ i ] !== 13 || d[ i + 1 ] !== 17 || d[ i + 2 ] !== 24 ) ) nonBg ++;
				}
				paintCounts.push( nonBg );
			} catch ( e ) { paintCounts.push( -2 ); }
		}
		out[ id + 'PaintCounts' ] = paintCounts;
		out[ id + 'Verdict' ] = paintCounts.some( ( n ) => n > 500 ) ? 'PAINTED' : 'EMPTY';
	}
	// 4. v2 regression: sync parse still works (no cache for it)
	const v2token = document.querySelectorAll( '.card' ).length >= 2;
	out.v2CardsRendered = document.querySelectorAll( '.card' ).length;
	return out;
}, [ failingUrl ] );

console.log( JSON.stringify( result, null, 1 ) );
console.log( 'page errors:', errors.length ? errors.slice( 0, 4 ) : 'none' );
await browser.close();
