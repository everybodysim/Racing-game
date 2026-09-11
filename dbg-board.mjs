import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await ( await browser.newContext() ).newPage();
const errs = []; const failed = [];
page.on( 'pageerror', e => errs.push( e.message.split( '\n' )[ 0 ] ) );
page.on( 'requestfailed', r => failed.push( r.url() + ' :: ' + r.failure()?.errorText ) );
page.on( 'console', m => { if ( m.type() === 'error' ) errs.push( 'CONSOLE: ' + m.text().split( '\n' )[ 0 ] ); } );
await page.goto( 'https://everybodysim.github.io/Racing-game/tracks.html', { waitUntil: 'networkidle' } );
await page.waitForTimeout( 2500 );
const state = await page.evaluate( () => ( {
  cards: document.querySelectorAll( '.track-card, .board-card, article' ).length,
  empty: ( document.body.innerText.match( /nothing here yet/i ) || [] ).length,
  gridText: document.getElementById( 'tracks-grid' )?.innerText?.slice( 0, 120 ) || 'no #tracks-grid',
  bodySnippet: document.body.innerText.slice( 0, 200 )
} ) );
console.log( JSON.stringify( state, null, 1 ) );
console.log( 'errors:', errs.slice( 0, 6 ) );
console.log( 'failed requests:', failed.slice( 0, 6 ) );
await browser.close();
