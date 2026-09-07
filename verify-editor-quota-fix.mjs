// verify-editor-quota-fix.mjs — runtime verification of the blank-screen fixes.
import { chromium } from 'playwright';

const url = 'http://localhost:8123/editor.html';
const b64 = ( o ) => Buffer.from( JSON.stringify( o ) ).toString( 'base64' )
	.replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );
const cellsV2 = ( cells ) => 'v2.' + b64( { v: 2, cells } );
const cells = []; for ( let gx = 2; gx < 40; gx++ ) cells.push( [ gx, 5, 'track-straight', 0 ] );
const mods = b64( { b: [], p: [], k: [], l: [], j: [], o: [ [ 8, 3, 'horizontal', 0, 1, null ] ], t: 'normal', q: [ [ 8, 8 ], [ 9, 8 ] ], r: { depth: 2, colorsOn: true }, e: [], u: [], d: [], m: [], a: [], w: { preset: 'normal' }, c: {}, y: {}, z: [], x: {} } );

let pass = 0, fail = 0;
const check = ( name, cond ) => { cond ? pass ++ : fail ++; console.log( ( cond ? '  ✓ ' : '  ✗ ' ) + name ); };

async function openPage( { initScripts = [] } = {} ) {
	const browser = await chromium.launch();
	const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );
	const page = await ctx.newPage();
	const pageErrors = [];
	page.on( 'pageerror', ( e ) => pageErrors.push( e ) );
	for ( const [ fn, arg ] of initScripts ) await page.addInitScript( fn, arg );
	await page.goto( url ).catch( () => {} );
	await page.waitForTimeout( 3000 );
	return { browser, page, pageErrors };
}

console.log( '1) Quota exceeded on slot writes — editor must boot and slots must work' );
{
	const { browser, page, pageErrors } = await openPage( {
		initScripts: [
			[ () => {
				const orig = Storage.prototype.setItem;
				Storage.prototype.setItem = function ( k, v ) {
					if ( String( k ).startsWith( 'racing-editor-slot-' ) ) {
						const err = new Error( 'The quota has been exceeded.' );
						err.name = 'QuotaExceededError';
						throw err;
					}
					return orig.call( this, k, v );
				};
			} ],
			[ ( [ c, m ] ) => {
				localStorage.setItem( 'racing-editor-cells', c );
				localStorage.setItem( 'racing-editor-mods', m );
			}, [ cellsV2( cells ), mods ] ],
		],
	} );
	for ( const pe of pageErrors ) console.log( '    [pageerror] ' + ( pe.stack || pe ).slice( 0, 700 ).split( '\\n' ).slice( 0, 10 ).join( ' // ' ) );
	check( 'no uncaught page errors during boot', pageErrors.length === 0 );
	check( 'module reported ready', await page.evaluate( () => window.__editorReady === true ) );
	check( 'render canvas exists', await page.evaluate( () => document.querySelectorAll( 'canvas' ).length >= 2 ) );
	check( 'no boot overlay shown', await page.evaluate( () => ! document.getElementById( 'editor-boot-overlay' ) ) );
	await page.click( '#track-slots button[data-track-slot="2"]' ).catch( () => {} );
	await page.waitForTimeout( 800 );
	check( 'slot 3 click switches active slot', await page.evaluate( () => document.querySelector( '#track-slots button.active' )?.dataset.trackSlot === '2' ) );
	check( 'slot 3 click shows toast', await page.evaluate( () => /Saved current track to slot 3/.test( document.getElementById( 'toast' ).textContent || '' ) ) );
	await browser.close();
}

console.log( '2) Corrupt saved track — editor must still boot clean' );
{
	const { browser, page, pageErrors } = await openPage( {
		initScripts: [ [ () => {
			localStorage.setItem( 'racing-editor-cells', 'v2.GARBAGE_NOT_BASE64!!' );
			localStorage.setItem( 'racing-editor-mods', '###' );
		} ] ],
	} );
	for ( const pe of pageErrors ) console.log( '    [pageerror] ' + ( pe.stack || pe ).slice( 0, 700 ).split( '\\n' ).slice( 0, 10 ).join( ' // ' ) );
	check( 'no uncaught page errors during boot', pageErrors.length === 0 );
	check( 'module reported ready', await page.evaluate( () => window.__editorReady === true ) );
	check( 'render canvas exists', await page.evaluate( () => document.querySelectorAll( 'canvas' ).length >= 2 ) );
	await browser.close();
}

console.log( '3) Fresh browser — normal boot, no overlay, slots save + load round-trip' );
{
	const { browser, page, pageErrors } = await openPage();
	check( 'no uncaught page errors', pageErrors.length === 0 );
	check( 'module reported ready', await page.evaluate( () => window.__editorReady === true ) );
	check( 'no boot overlay shown', await page.evaluate( () => ! document.getElementById( 'editor-boot-overlay' ) ) );
	await page.click( '#track-slots button[data-track-slot="1"]' ).catch( () => {} );
	await page.waitForTimeout( 700 );
	check( 'slot 2 active after click', await page.evaluate( () => document.querySelector( '#track-slots button.active' )?.dataset.trackSlot === '1' ) );
	check( 'slot 2 persisted', await page.evaluate( () => Boolean( localStorage.getItem( 'racing-editor-slot-1' ) ) ) );
	await page.reload().catch( () => {} );
	await page.waitForTimeout( 2500 );
	check( 'after reload still ready', await page.evaluate( () => window.__editorReady === true ) );
	check( 'after reload slot 2 still active', await page.evaluate( () => document.querySelector( '#track-slots button.active' )?.dataset.trackSlot === '1' ) );
	await browser.close();
}

console.log( '4) Watchdog — simulated total module failure shows the recovery overlay' );
{
	const browser = await chromium.launch();
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto( 'http://localhost:8123/404-blank.html' ).catch( () => {} );
	// Serve a page that never boots: evaluate the watchdog behavior on the real editor
	// by blocking the module script.
	await ctx.route( '**/js/Track.js*', ( route ) => route.abort() );
	await page.goto( url ).catch( () => {} );
	await page.waitForTimeout( 9000 );
	check( 'boot overlay appeared', await page.evaluate( () => Boolean( document.getElementById( 'editor-boot-overlay' ) ) ) );
	check( 'overlay shows a captured error', await page.evaluate( () => ( document.querySelector( '#editor-boot-overlay pre' )?.textContent || '' ).length > 10 ) );
	await browser.close();
}

console.log( `result: ${pass} pass, ${fail} fail` );
process.exit( fail ? 1 : 0 );
