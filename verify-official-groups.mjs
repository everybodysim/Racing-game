// E2E: official tracks page — A–E group sidebar, 15 slots each, 3 filled,
// unfinished placeholders clearly marked, hash deep-linking, record stats.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1400, height: 900 } } );
await ctx.route( '**/*', ( route ) => {
	const url = route.request().url();
	if ( url.startsWith( 'http://localhost:8123/' ) ) return route.continue();
	if ( url.includes( 'racing-leaderboard-api' ) ) {
		return route.fulfill( { json: { entries: [ { name: 'Speedy', timeSeconds: 41.2 }, { name: '', timeSeconds: 1 } ] } } );
	}
	return route.abort();
} );
const page = await ctx.newPage();
const errors = [];
page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
await page.goto( 'http://localhost:8123/official-tracks.html' );
await page.waitForTimeout( 1500 );
let pass = 0, fail = 0;
const check = ( l, c ) => { c ? pass ++ : fail ++; console.log( `  ${ c ? '✓' : '✗' } ${ l }` ); };

const r = await page.evaluate( () => ( {
	navButtons: [ ...document.querySelectorAll( '#group-nav .group-btn' ) ].map( ( b ) => ( { text: b.textContent, active: b.classList.contains( 'active' ) } ) ),
	cards: document.querySelectorAll( '#grid .card' ).length,
	empty: document.querySelectorAll( '#grid .card.empty-slot' ).length,
	wip: document.querySelectorAll( '#grid .wip-badge' ).length,
	firstCardName: document.querySelector( '#grid .card h3' )?.textContent,
	firstEmptyLabel: document.querySelector( '#grid .card.empty-slot h3' )?.textContent,
	firstHolder: document.querySelector( '#grid .card .holder .name' )?.textContent,
	statTotal: document.getElementById( 'stat-total' )?.textContent,
	hash: window.location.hash,
} ) );
check( 'sidebar shows 5 groups A–E', r.navButtons.length === 5 && r.navButtons.every( ( b, i ) => b.text.trim().startsWith( 'ABCDE'[ i ] ) ) );
check( 'each group button shows 3/15', r.navButtons.every( ( b ) => b.text.includes( '3/15' ) ) );
check( 'group A active by default', r.navButtons[ 0 ].active === true && r.navButtons.slice( 1 ).every( ( b ) => ! b.active ) );
check( 'grid shows 15 slots', r.cards === 15 );
check( '12 unfinished placeholders', r.empty === 12 && r.wip === 12 );
check( 'first card is A01 Race', /A01 Race/.test( r.firstCardName || '' ) );
check( 'placeholders clearly marked Not finished', /A04.*Not finished/.test( r.firstEmptyLabel || '' ) );
check( 'record holder loaded from API', r.firstHolder === 'Speedy' );
check( 'stat-total shows 15 / 75', r.statTotal === '15 / 75' );

// switch to C group
await page.click( '#group-nav .group-btn:nth-child(3)' );
await page.waitForTimeout( 300 );
const c = await page.evaluate( () => ( {
	cards: document.querySelectorAll( '#grid .card' ).length,
	first: document.querySelector( '#grid .card h3' )?.textContent,
	active: document.querySelector( '#group-nav .group-btn.active' )?.textContent,
	hash: window.location.hash,
} ) );
check( 'C group shows 15 slots', c.cards === 15 );
check( 'C group starts at C01 Acrobatic', /C01 Acrobatic/.test( c.first || '' ) );
check( 'C button highlighted', /C Tracks/.test( c.active || '' ) );
check( 'hash deep-link updates to #c', c.hash === '#c' );

// reload keeps the group
await page.reload();
await page.waitForTimeout( 1200 );
const after = await page.evaluate( () => ( { active: document.querySelector( '#group-nav .group-btn.active' )?.textContent, first: document.querySelector( '#grid .card h3' )?.textContent } ) );
check( 'reload with #c restores C group', /C Tracks/.test( after.active || '' ) && /C01/.test( after.first || '' ) );

console.log( 'page errors:', errors.length ? errors : 'none' );
await browser.close();
console.log( `\nofficial groups tests: ${ pass } pass, ${ fail } fail` );
process.exit( fail || errors.length ? 1 : 0 );
