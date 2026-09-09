// Smoke test after removing the select/copy/paste toolset:
// editor must boot clean, Select button gone, paint/erase shortcuts intact.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );
const page = await ctx.newPage();
const errors = [];
page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( 'console: ' + m.text() ); } );
await page.goto( 'http://localhost:8123/editor.html' );
await page.waitForTimeout( 3000 );
const r = await page.evaluate( () => ( {
	btnSelect: !! document.getElementById( 'btn-select' ),
	selectionBox: !! document.getElementById( 'selection-box' ),
	clipboardHint: !! document.getElementById( 'clipboard-hint' ),
	selectMode: typeof selectMode !== 'undefined',
	clipboardVar: typeof clipboard !== 'undefined',
	editorBooted: !! window.scene || !! document.getElementById( 'toolbar' ),
} ) );
let pass = 0, fail = 0;
const check = ( label, cond ) => { cond ? pass ++ : fail ++; console.log( `  ${ cond ? '✓' : '✗' } ${ label }` ); };
check( 'Select button removed', r.btnSelect === false );
check( 'selection-box removed', r.selectionBox === false );
check( 'clipboard-hint removed', r.clipboardHint === false );
check( 'selectMode variable gone', r.selectMode === false );
check( 'clipboard variable gone', r.clipboardVar === false );
check( 'editor booted', r.editorBooted === true );
// keyboard shortcuts 1/2 still switch tools via the real keydown path
await page.keyboard.press( '2' );
await page.waitForTimeout( 150 );
const eraseActive = await page.evaluate( () => document.getElementById( 'btn-erase' )?.classList.contains( 'active' ) || document.querySelector( '#toolbar button.active' )?.id );
await page.keyboard.press( '1' );
await page.waitForTimeout( 150 );
const paintActive = await page.evaluate( () => document.getElementById( 'btn-paint' )?.classList.contains( 'active' ) || document.querySelector( '#toolbar button.active' )?.id );
check( 'key 2 activates erase tool', eraseActive === true || eraseActive === 'btn-erase' );
check( 'key 1 re-activates paint tool', paintActive === true || paintActive === 'btn-paint' );
console.log( 'page errors:', errors.length ? errors.slice( 0, 3 ) : 'none' );
await browser.close();
console.log( `\neditor no-select smoke: ${ pass } pass, ${ fail } fail` );
process.exit( fail || errors.length ? 1 : 0 );
