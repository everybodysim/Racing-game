// E2E: side rail navigation + creator credit on the track share board.
// - Rail renders all 7 section buttons, jumps instantly, scroll-spy highlights
// - Cards show "by <creator>" with Anonymous fallback for legacy entries
// - Remote publish POSTs the logged-in player name as creator
// - Local (hash) publish stores creator on the entry
// Run: node verify-board-rail.mjs
import { chromium } from 'playwright';

const GAME_URL = 'https://everybodysim.github.io/Racing-game/index.html?map=compacttoken&mods=none';
const ghostCodeObj = { url: GAME_URL, ghost: { bestLapSeconds: 12.34, samples: [ { t: 0, x: 0, z: 1 }, { t: 1, x: 0, z: 2 } ] } };

const LEGACY_ENTRY = { id: 'old1', name: 'Legacy No Creator', playUrl: GAME_URL, viewCount: 4, thumbsUp: 2, thumbsDown: 0, createdAt: Date.now() - 9e7 };
const CREDITED_ENTRY = { id: 'new1', name: 'Credited Track', playUrl: GAME_URL, viewCount: 1, thumbsUp: 0, thumbsDown: 0, creator: 'Speedy Dave', createdAt: Date.now() };

const browser = await chromium.launch();
let pass = 0, fail = 0;
const check = ( label, cond ) => { cond ? pass ++ : fail ++; console.log( `  ${ cond ? '✓' : '✗' } ${ label }` ); };
const errors = [];

async function newPage( mode ) {
	const ctx = await browser.newContext( { viewport: { width: 1400, height: 900 } } );
	let postedBody = null;
	await ctx.route( '**/*', async ( route ) => {
		const url = route.request().url();
		if ( url.startsWith( 'http://localhost:8123/' ) ) return route.continue();
		if ( url.includes( 'racing-track-board-api' ) || url.includes( 'racing-leaderboard-api' ) ) {
			if ( mode === 'remote' ) {
				if ( route.request().method() === 'POST' && url.includes( '/api/tracks' ) ) {
					postedBody = route.request().postDataJSON();
					return route.fulfill( { json: { ok: true, entry: { id: 'fresh' } } } );
				}
				return route.fulfill( { json: { ok: true, entries: [ CREDITED_ENTRY, LEGACY_ENTRY ] } } );
			}
			return route.abort(); // local mode: force fallback
		}
		return route.abort();
	} );
	const page = await ctx.newPage();
	page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
	await page.addInitScript( ( name ) => localStorage.setItem( 'racing-player-name-v1', name ), mode === 'remote' ? 'TestDriver' : 'HashDriver' );
	return { ctx, page, getPosted: () => postedBody };
}

// ── Remote mode: rail + creator display + publish POST body ──
{
	const { ctx, page, getPosted } = await newPage( 'remote' );
	await page.goto( 'http://localhost:8123/tracks.html' );
	await page.waitForTimeout( 1500 );

	// rail buttons
	const railBtns = await page.locator( '#board-rail button' ).all();
	check( 'rail has 7 buttons', railBtns.length === 7 );
	const labels = await page.evaluate( () => [ ...document.querySelectorAll( '#board-rail button' ) ].map( ( b ) => b.textContent ) );
	check( 'rail labels match sections', JSON.stringify( labels ) === JSON.stringify( [ 'Featured', 'Trending', 'New This Week', 'Top Rated', 'Fastest', 'Records', 'All Tracks' ] ) );

	// creator badges on cards
	const legacyBy = await page.evaluate( () => {
		const card = [ ...document.querySelectorAll( '.card' ) ].find( ( c ) => c.textContent.includes( 'Legacy No Creator' ) );
		return card?.querySelector( '.creator-badge' )?.textContent || null;
	} );
	check( 'legacy entry shows "by Anonymous"', legacyBy === 'by Anonymous' );
	const creditedBy = await page.evaluate( () => {
		const card = [ ...document.querySelectorAll( '.card' ) ].find( ( c ) => c.textContent.includes( 'Credited Track' ) );
		return card?.querySelector( '.creator-badge' )?.textContent || null;
	} );
	check( 'credited entry shows "by Speedy Dave"', creditedBy === 'by Speedy Dave' );

	// publishing-as chip reflects logged-in account
	const chip = await page.evaluate( () => document.getElementById( 'publishing-as' )?.textContent || '' );
	check( 'publishing-as chip shows TestDriver', chip.includes( 'TestDriver' ) );

	// rail click jumps instantly to All Tracks and highlights it
	const before = await page.evaluate( () => window.scrollY );
	await page.click( '#board-rail button:has-text("All Tracks")' );
	await page.waitForTimeout( 300 );
	const after = await page.evaluate( () => ( { y: window.scrollY, active: document.querySelector( '#board-rail button.active' )?.textContent, libTop: document.getElementById( 'section-library' ).getBoundingClientRect().top, maxScroll: document.documentElement.scrollHeight - window.innerHeight } ) );
	check( 'click scrolls down instantly', after.y > before );
	check( 'section lands at viewport top (or page-bottom clamp)', Math.abs( after.libTop ) < 8 || after.y >= after.maxScroll - 2 );
	check( 'All Tracks button highlighted', after.active === 'All Tracks' );

	// scroll back up: spy moves to an earlier section
	await page.evaluate( () => window.scrollTo( 0, 0 ) );
	await page.waitForTimeout( 300 );
	const topActive = await page.evaluate( () => document.querySelector( '#board-rail button.active' )?.textContent );
	check( 'scroll-spy resets to Featured at top', topActive === 'Featured' );

	// publish: fill ghost code and submit; POST body must carry creator
	await page.evaluate( ( gc ) => {
		document.getElementById( 'publish-drawer' ).open = true;
		document.getElementById( 'publish-drawer' ).scrollIntoView();
		document.getElementById( 'track-name' ).value = 'Fresh Upload';
		document.getElementById( 'ghost-code' ).value = gc;
	}, b64( ghostCodeObj ) );
	await page.click( '#add-btn' );
	await page.waitForTimeout( 1200 );
	const posted = getPosted();
	check( 'publish POST reached API', !! posted );
	check( 'POST body carries creator TestDriver', posted?.creator === 'TestDriver' );
	check( 'POST body still carries ghostCode', typeof posted?.ghostCode === 'string' );
	await ctx.close();
}

// ── Local hash mode: publish stores creator on the entry ──
{
	const { ctx, page } = await newPage( 'local' );
	await page.goto( 'http://localhost:8123/tracks.html' );
	await page.waitForTimeout( 1500 );
	const status = await page.waitForFunction( () => ( document.getElementById( 'status' )?.textContent || '' ).includes( 'local share-link mode' ), null, { timeout: 12000 } ).then( () => true ).catch( () => false );
	check( 'local mode fallback active', status === true );
	await page.evaluate( ( gc ) => {
		document.getElementById( 'publish-drawer' ).open = true;
		document.getElementById( 'publish-drawer' ).scrollIntoView();
		document.getElementById( 'track-name' ).value = 'Hash Board Track';
		document.getElementById( 'ghost-code' ).value = gc;
	}, b64( ghostCodeObj ) );
	await page.click( '#add-btn' );
	await page.waitForTimeout( 1000 );
	const stored = await page.evaluate( () => entries[ 0 ] );
	check( 'local publish stores creator HashDriver', stored?.creator === 'HashDriver' );
	const cardBy = await page.evaluate( () => {
		const card = [ ...document.querySelectorAll( '.card' ) ].find( ( c ) => c.textContent.includes( 'Hash Board Track' ) );
		return card?.querySelector( '.creator-badge' )?.textContent || null;
	} );
	check( 'local card shows "by HashDriver"', cardBy === 'by HashDriver' );
	const chip = await page.evaluate( () => document.getElementById( 'publishing-as' )?.textContent || '' );
	check( 'local chip shows HashDriver', chip.includes( 'HashDriver' ) );
	await ctx.close();
}

function b64( v ) { return Buffer.from( JSON.stringify( v ) ).toString( 'base64url' ); }

console.log( `\nboard rail/creator tests: ${ pass } pass, ${ fail } fail` );
console.log( 'page errors:', errors.length ? errors : 'none' );
await browser.close();
process.exit( fail ? 1 : 0 );
