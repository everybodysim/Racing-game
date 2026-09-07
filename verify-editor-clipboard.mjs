// Editor select/move/copy/paste system verification.
// Drives the real editor with synthetic pointer + keyboard events via the
// __skidEditorSelect hooks and checks grid state through saved v2 maps.
import { chromium } from 'playwright';

const results = [];
const check = ( name, ok, extra = '' ) => {
	results.push( { name, ok } );
	console.log( `${ ok ? '✓' : '✗' } ${ name }${ extra ? ` — ${ extra }` : '' }` );
};

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );
const page = await ctx.newPage();
const problems = [];
page.on( 'pageerror', ( e ) => problems.push( String( e ).slice( 0, 120 ) ) );

// build a 3x3 known track via the real codec, boot the editor with it
const payload = await ( async () => {
	const b = await browser.newContext();
	const p = await b.newPage();
	await p.goto( 'http://localhost:8123/editor.html' );
	await p.waitForTimeout( 1000 );
	const out = await p.evaluate( async () => {
		const T = await import( './js/Track.js' );
		const cells = [];
		for ( let gx = 0; gx <= 2; gx ++ ) for ( let gz = 0; gz <= 2; gz ++ ) cells.push( [ gx, gz, 'track-straight', 0 ] );
		cells.push( [ 1, 1, 'track-checkpoint', 0 ] );
		return T.encodeCells( cells );
	} );
	await b.close();
	return out;
} )();

await page.goto( `http://localhost:8123/editor.html?map=${ encodeURIComponent( payload ) }` );
await page.waitForTimeout( 2500 );
const boot = await page.evaluate( () => window.__skidEditorSelect.gridInfo() );
check( 'boot loads the 9-cell map', boot.size === 9, `size=${ boot.size }` );

const gridCells = async () => {
	const info = await page.evaluate( () => window.__skidEditorSelect.gridInfo() );
	return info.cells.sort();
};

// pointer + keyboard event helpers
const ev = ( name, x, y ) => `document.dispatchEvent(new PointerEvent('${name}', {bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 0, buttons: 1, isPrimary: true}))`;
const key = ( k, mods = {} ) => {
	const m = { ctrl: false, ...mods };
	return `window.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, key: '${k}', ctrlKey: ${m.ctrl}, metaKey: false}))`;
};

// ── UI removals + Select button ──
const ui = await page.evaluate( () => ( {
	speedSlider: !! document.getElementById( 'moving-speed-wrap' ),
	autosave: !! document.getElementById( 'autosave-enable' ),
	autosaveInterval: !! document.getElementById( 'autosave-interval' ),
	selectBtn: !! document.getElementById( 'btn-select' ),
} ) );
check( 'move-speed slider removed', ! ui.speedSlider );
check( 'autosave UI removed', ! ui.autosave && ! ui.autosaveInterval );
check( 'Select button present', ui.selectBtn );

// ── select mode on, drag a selection over the 3x3 block ──
await page.click( '#btn-select' );
await page.waitForTimeout( 300 );
let state = await page.evaluate( () => window.__skidEditorSelect.inSelectMode() );
check( 'select mode toggles on', state === true );

const pts = await page.evaluate( () => {
	const H = window.__skidEditorSelect;
	return { a: H.gridToScreen( 0, 0 ), b: H.gridToScreen( 2, 2 ), far: H.gridToScreen( 6, 6 ), mid: H.gridToScreen( 1, 1 ), drop: H.gridToScreen( 9, 6 ), center09: H.gridToScreen( 0, 9 ) };
} );
await page.evaluate( ev( 'pointerdown', pts.a.x, pts.a.y ) );
await page.evaluate( ev( 'pointermove', pts.b.x, pts.b.y ) );
await page.evaluate( ev( 'pointerup', pts.b.x, pts.b.y ) );
await page.waitForTimeout( 300 );
state = await page.evaluate( () => ( { n: window.__skidEditorSelect.selectionCount(), box: document.getElementById( 'selection-box' ).style.display } ) );
check( 'drag selects the 9 cells', state.n === 9, `selected=${ state.n }` );
check( 'selection box visible', state.box === 'block' );

// ── copy → localStorage persistence ──
await page.evaluate( key( 'c', { ctrl: true } ) );
await page.waitForTimeout( 200 );
const stored = await page.evaluate( () => {
	const raw = localStorage.getItem( 'racing-editor-clipboard-v1' );
	if ( ! raw ) return null;
	const p = JSON.parse( raw );
	return p.cells ? p.cells.length : 0;
} );
check( 'Ctrl+C stores clipboard in localStorage', stored === 9, `cells=${ stored }` );

// ── reload: clipboard survives ──
await page.reload();
await page.waitForTimeout( 2500 );
state = await page.evaluate( () => ( { size: window.__skidEditorSelect.clipboardSize(), toast: document.getElementById( 'toast' ).textContent } ) );
check( 'clipboard restored after reload', state.size === 9, `restored=${ state.size }` );
check( 'restore toast shown', /Clipboard restored/.test( state.toast ), state.toast.slice( 0, 60 ) );

// select mode does not survive a reload — re-arm it for the rest of the flow
await page.click( '#btn-select' );
await page.waitForTimeout( 200 );
state = await page.evaluate( () => window.__skidEditorSelect.inSelectMode() );
check( 'select mode re-armed after reload', state === true );

// ── paste mode: ghost preview follows, click stamps ──
await page.evaluate( key( 'v', { ctrl: true } ) );
await page.waitForTimeout( 200 );
state = await page.evaluate( () => window.__skidEditorSelect.inPasteMode() );
check( 'Ctrl+V enters paste mode', state === true );
await page.evaluate( ev( 'pointermove', pts.center09.x, pts.center09.y ) );
await page.waitForTimeout( 200 );
state = await page.evaluate( () => window.__skidEditorSelect.ghostInfo() );
check( 'ghost preview visible before paste', state.visible === true && state.count === 9, `ghosts=${ state.count }` );
await page.evaluate( ev( 'pointerdown', pts.center09.x, pts.center09.y ) );
await page.waitForTimeout( 400 );
await page.evaluate( key( 'Escape' ) );
await page.waitForTimeout( 200 );
state = await page.evaluate( () => window.__skidEditorSelect.inPasteMode() );
check( 'Esc exits paste mode', state === false );
let cells = await gridCells();
// ghost anchored at hovered cell (0,9) -> pasted at 0..2 x 9..11
const hasPasted = [ '0,9:track-straight', '2,11:track-straight', '1,9:track-straight' ].every( c => cells.includes( c ) );
console.log( 'cells after paste:', JSON.stringify( cells.slice( 0, 12 ) ) );
check( 'click pastes the clipboard region', cells.length === 18 && hasPasted, `total=${ cells.length }` );

// ── move: select pasted block, drag it — ghost shows during drag ──
const selPast = await page.evaluate( () => {
	const H = window.__skidEditorSelect;
	return { a: H.gridToScreen( 0, 9 ), b: H.gridToScreen( 2, 11 ) };
} );
await page.evaluate( ev( 'pointerdown', selPast.a.x, selPast.a.y ) );
await page.evaluate( ev( 'pointermove', selPast.b.x, selPast.b.y ) );
await page.evaluate( ev( 'pointerup', selPast.b.x, selPast.b.y ) );
await page.waitForTimeout( 300 );
state = await page.evaluate( () => window.__skidEditorSelect.selectionCount() );
check( 're-selected the pasted block', state === 9, `selected=${ state }` );
// grab center (1,10) and drag to (5,10)
const pts2 = await page.evaluate( () => {
	const H = window.__skidEditorSelect;
	return { grab: H.gridToScreen( 1, 10 ), drop: H.gridToScreen( 5, 10 ) };
} );
await page.evaluate( ev( 'pointerdown', pts2.grab.x, pts2.grab.y ) );
await page.evaluate( ev( 'pointermove', pts2.drop.x, pts2.drop.y ) );
await page.waitForTimeout( 200 );
const ghostDuringMove = await page.evaluate( () => window.__skidEditorSelect.ghostInfo() );
check( 'ghost preview visible during move drag', ghostDuringMove.visible === true && ghostDuringMove.count === 9, `ghosts=${ ghostDuringMove.count }` );
await page.evaluate( ev( 'pointerup', pts2.drop.x, pts2.drop.y ) );
await page.waitForTimeout( 400 );
cells = await gridCells();
const movedOk = cells.includes( '4,9:track-straight' ) && cells.includes( '6,11:track-straight' ) && ! cells.includes( '0,9:track-straight' ) && ! cells.includes( '1,10:track-checkpoint' );
check( 'drag moves the region (source cleared, target filled)', movedOk, `total=${ cells.length }` );

// ── delete: select + Del ──
const pts3 = await page.evaluate( () => {
	const H = window.__skidEditorSelect;
	return { a: H.gridToScreen( 3, 8 ), b: H.gridToScreen( 6, 11 ) };
} );
await page.evaluate( ev( 'pointerdown', pts3.a.x, pts3.a.y ) );
await page.evaluate( ev( 'pointermove', pts3.b.x, pts3.b.y ) );
await page.evaluate( ev( 'pointerup', pts3.b.x, pts3.b.y ) );
await page.waitForTimeout( 200 );
await page.evaluate( key( 'Delete' ) );
await page.waitForTimeout( 400 );
cells = await gridCells();
check( 'Delete removes the selection', ! cells.includes( '4,9:track-straight' ) && ! cells.includes( '6,11:track-straight' ) && cells.length === 9, `remaining=${ cells.length }` );

// ── cut: copy + delete in one ──
const pts4 = await page.evaluate( () => {
	const H = window.__skidEditorSelect;
	return { a: H.gridToScreen( 0, 0 ), b: H.gridToScreen( 2, 2 ) };
} );
await page.evaluate( ev( 'pointerdown', pts4.a.x, pts4.a.y ) );
await page.evaluate( ev( 'pointermove', pts4.b.x, pts4.b.y ) );
await page.evaluate( ev( 'pointerup', pts4.b.x, pts4.b.y ) );
await page.waitForTimeout( 200 );
const sizeBeforeCut = await page.evaluate( () => window.__skidEditorSelect.clipboardSize() );
await page.evaluate( key( 'x', { ctrl: true } ) );
await page.waitForTimeout( 400 );
const afterCut = await page.evaluate( () => ( { clip: window.__skidEditorSelect.clipboardSize(), cells: 0 } ) );
cells = await gridCells();
check( 'Ctrl+X cuts (copies + deletes)', afterCut.clip === 9 && ! cells.includes( '1,1:track-checkpoint' ) && cells.length === 0, `clipboard=${ afterCut.clip }, remaining cells=${ cells.length }` );

check( 'no pageerrors during the whole flow', problems.length === 0, problems.join( ' | ' ) || 'clean' );

const pass = results.filter( r => r.ok ).length;
console.log( `\nresult: ${ pass } pass, ${ results.length - pass } fail` );
await browser.close();
process.exit( pass === results.length ? 0 : 1 );
