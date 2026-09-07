// v3 URL codec verification — run against the local dev server (port 8123).
// 1) codec round-trips (compact + JSON paths) inside a real browser
// 2) compression stats on a realistic track
// 3) game boots cleanly from a v3 ?map=&mods= URL (no decode warnings)
// 4) game still boots from a legacy v2 URL
// 5) editor restores a v3-encoded track from localStorage without the failure toast
import { chromium } from 'playwright';

const results = [];
const check = ( name, ok, extra = '' ) => {
	results.push( { name, ok, extra } );
	console.log( `${ ok ? '✓' : '✗' } ${ name }${ extra ? ` — ${ extra }` : '' }` );
};

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 720 } } );

// ── page 1: editor — codec tests inside the real module ──
const ed = await ctx.newPage();
const edErrors = [];
ed.on( 'pageerror', ( e ) => edErrors.push( String( e ) ) );
await ed.goto( 'http://localhost:8123/editor.html' );
await ed.waitForTimeout( 1500 );

const codec = await ed.evaluate( async () => {
	const T = await import( './js/Track.js' );
	// compact path: only straight/corner/checkpoint/finish
	const compactCells = [];
	for ( let i = 0; i < 200; i ++ ) {
		const a = ( i / 200 ) * Math.PI * 2;
		compactCells.push( [ Math.round( Math.sin( a ) * 20 ), Math.round( Math.cos( a ) * 20 ), i % 20 === 0 ? 'track-checkpoint' : 'track-straight', 0 ] );
	}
	compactCells.push( [ 0, 20, 'track-finish', 0 ] );

	// mixed real pieces — now handled by the EXTENDED compact codec
	const cells = [];
	for ( let i = 0; i < 200; i ++ ) {
		const a = ( i / 200 ) * Math.PI * 2;
		cells.push( [ Math.round( Math.sin( a ) * 20 ), Math.round( Math.cos( a ) * 20 ), i % 30 === 0 ? 'track-3-way' : 'track-straight', 0 ] );
	}
	for ( let i = 0; i < 20; i += 4 ) cells.push( [ i - 10, 0, 'track-checkpoint', 0 ] );
	cells.push( [ 0, 20, 'track-start-finish', 0 ] );
	// rotations + out-of-range coords must fall back gracefully
	const farCells = cells.concat( [ [ 200, 0, 'track-straight', 16 ], [ 0, -200, 'track-corner', 10 ] ] );
	const far3 = await T.encodeCellsV3( farCells );
	const farBack = await T.decodeCellsAny( far3 );

	// JSON path (tokenized): unknown type name forces it
	const weird = [ [ 1, 2, 'weird-unknown-piece', 0 ] ];
	const w2 = T.encodeCells( weird );
	const w3 = await T.encodeCellsV3( weird );
	const wback = await T.decodeCellsAny( w3 );

	const v2 = T.encodeCells( cells );
	const v3 = await T.encodeCellsV3( cells );
	const back = await T.decodeCellsAny( v3 );
	const v2back = await T.decodeCellsAny( v2 );

	const c2 = T.encodeCells( compactCells );
	const c3 = await T.encodeCellsV3( compactCells );
	const cback = await T.decodeCellsAny( c3 );
	const c2back = await T.decodeCellsAny( c2 );

	// all-orient extended compact round-trip
	const rotCells = [];
	for ( const o of [ 0, 16, 10, 22 ] ) rotCells.push( [ o, -o, 'track-corner', o ] );
	rotCells.push( [ 9, 9, 'elevated-4-way', 16 ] );
	const rot3 = await T.encodeCellsV3( rotCells );
	const rotBack = await T.decodeCellsAny( rot3 );

	// mods-style JSON codec
	const modsJson = { b: [], p: [], k: [], l: [], j: [], o: [], e: [], u: [], d: [], m: [ [ 1, 2, 3, 'blue', 0.5, 10 ] ], a: [], t: 'normal', w: { preset: 'clear' }, c: {}, y: {}, x: {}, r: {}, q: [], z: [] };
	const m3 = await T.encodeV3Json( modsJson );
	const mback = await T.decodeV3Json( m3 );

	const eq = ( a, b ) => JSON.stringify( a ) === JSON.stringify( b );

	return {
		v3Prefix: v3.startsWith( 'v3.' ),
		mixedRoundTrip: eq( back, cells ),
		v2StillDecodes: eq( v2back, cells ),
		compactPath: ! c2.startsWith( 'v2.' ),
		compactRoundTrip: eq( cback, compactCells ) && eq( c2back, compactCells ),
		farFallback: eq( farBack, farCells ),
		rotRoundTrip: eq( rotBack, rotCells ),
		jsonPath: w2.startsWith( 'v2.' ) && w3.startsWith( 'v3.' ) && eq( wback, weird ),
		modsRoundTrip: eq( mback, modsJson ),
		v2Len: v2.length,
		v3Len: v3.length,
		c2Len: c2.length,
		c3Len: c3.length,
		m2Len: btoa( JSON.stringify( modsJson ) ).length,
		m3Len: m3.length,
		support: typeof CompressionStream === 'function',
	};
} );
console.log( 'codec:', JSON.stringify( codec ) );

check( 'browser supports CompressionStream', codec.support );
check( 'v3 prefix present', codec.v3Prefix );
check( 'v3 extended-compact round-trip (mixed types + rotations)', codec.mixedRoundTrip && codec.rotRoundTrip );
check( 'out-of-range coords fall back + round-trip', codec.farFallback );
check( 'v3 compact-path round-trip', codec.compactRoundTrip );
check( 'v3 JSON-path round-trip (unknown names)', codec.jsonPath );
check( 'v2/compact string still decodes', codec.v2StillDecodes );
check( 'v3 JSON (mods) round-trip', codec.modsRoundTrip );
const saved = ( 1 - codec.v3Len / codec.v2Len ) * 100;
check( 'v3 map shorter than v2', codec.v3Len < codec.v2Len, `mixed track: ${ codec.v2Len } → ${ codec.v3Len } chars (${ saved.toFixed( 0 ) }% smaller)` );
const csaved = ( 1 - codec.c3Len / codec.c2Len ) * 100;
check( 'v3 compact-path map shorter', codec.c3Len < codec.c2Len, `compact track: ${ codec.c2Len } → ${ codec.c3Len } chars (${ csaved.toFixed( 0 ) }% smaller)` );
check( 'v3 mods shorter than v2', codec.m3Len < codec.m2Len, `${ codec.m2Len } → ${ codec.m3Len } chars` );

// save a v3 map+mods for the game-URL test
const payload = await ed.evaluate( async () => {
	const T = await import( './js/Track.js' );
	const cells = [];
	for ( let i = 0; i < 200; i ++ ) {
		const a = ( i / 200 ) * Math.PI * 2;
		cells.push( [ Math.round( Math.sin( a ) * 20 ), Math.round( Math.cos( a ) * 20 ), i % 30 === 0 ? 'track-3-way' : 'track-straight', 0 ] );
	}
	cells.push( [ 0, 20, 'track-start-finish', 0 ] );
	const v2 = T.encodeCells( cells );
	const v3 = await T.encodeCellsV3( cells );
	const modsJson = { b: [], p: [], k: [], l: [ [ 1, 1, 0 ] ], j: [], o: [], e: [], u: [], d: [], m: [], a: [], t: 'normal', w: { preset: 'clear' }, c: {}, y: {}, x: {}, r: {}, q: [], z: [] };
	const mods3 = await T.encodeV3Json( modsJson );
	const mods2 = btoa( JSON.stringify( modsJson ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );
	return { v3, v2, mods3, mods2 };
} );

// ── page 2: game from v3 URL ──
const gm = await ctx.newPage();
const gmProblems = [];
gm.on( 'pageerror', ( e ) => gmProblems.push( 'pageerror: ' + String( e ).slice( 0, 100 ) ) );
gm.on( 'console', ( m ) => { if ( m.type() === 'warning' && /Invalid|Failed to load/.test( m.text() ) ) gmProblems.push( 'warn: ' + m.text().slice( 0, 100 ) ); } );
await gm.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( payload.v3 ) }&mods=${ encodeURIComponent( payload.mods3 ) }` );
await gm.waitForTimeout( 9000 );
const gmState = await gm.evaluate( () => ( { resolved: window.__resolvedTrackParams?.map?.startsWith( 'v3.' ) ?? null, title: document.title } ) );
check( 'game: no pageerrors / decode warnings from v3 URL', gmProblems.length === 0, gmProblems.join( ' | ' ) || 'clean' );
check( 'game: resolved v3 track params', gmState.resolved === true, gmState.title );

// ── page 3: game from legacy v2 URL (regression) ──
const gm2 = await ctx.newPage();
const gm2Problems = [];
gm2.on( 'pageerror', ( e ) => gm2Problems.push( 'pageerror: ' + String( e ).slice( 0, 100 ) ) );
gm2.on( 'console', ( m ) => { if ( m.type() === 'warning' && /Invalid|Failed to load/.test( m.text() ) ) gm2Problems.push( 'warn: ' + m.text().slice( 0, 100 ) ); } );
await gm2.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( payload.v2 ) }&mods=${ encodeURIComponent( payload.mods2 ) }` );
await gm2.waitForTimeout( 9000 );
check( 'game: legacy v2 URL still boots clean', gm2Problems.length === 0, gm2Problems.join( ' | ' ) || 'clean' );

// ── page 4: editor restores v3 cells from localStorage ──
const ed2 = await ctx.newPage();
await ed2.addInitScript( ( p ) => {
	localStorage.setItem( 'racing-editor-cells', p.v3 );
	localStorage.setItem( 'racing-editor-mods', p.mods3 );
}, payload );
const ed2Errors = [];
ed2.on( 'pageerror', ( e ) => ed2Errors.push( String( e ) ) );
const ed2Warns = [];
ed2.on( 'console', ( m ) => { if ( ( m.type() === 'warning' || m.type() === 'error' ) && /Could not load the saved track/.test( m.text() ) ) ed2Warns.push( m.text() ); } );
await ed2.goto( 'http://localhost:8123/editor.html' );
await ed2.waitForTimeout( 3000 );
check( 'editor: restores v3-encoded track without failure toast', ed2Errors.length === 0 && ed2Warns.length === 0, ed2Errors.concat( ed2Warns ).join( ' | ' ) || 'clean' );

// control: garbage in cells key MUST trigger the failure path (proves the check works)
const ctx3 = await browser.newContext( { viewport: { width: 1280, height: 720 } } );
const ed3 = await ctx3.newPage();
await ed3.addInitScript( () => {
	localStorage.setItem( 'racing-editor-cells', 'v3.notvalidbase64!!' );
} );
let sawFail = false;
ed3.on( 'console', ( m ) => { if ( /Failed to load saved map/.test( m.text() ) ) sawFail = true; } );
await ed3.goto( 'http://localhost:8123/editor.html' );
await ed3.waitForTimeout( 2500 );
check( 'control: invalid v3 triggers the known failure path', sawFail );

const pass = results.filter( ( r ) => r.ok ).length;
console.log( `\nresult: ${ pass } pass, ${ results.length - pass } fail` );
await browser.close();
process.exit( pass === results.length ? 0 : 1 );
