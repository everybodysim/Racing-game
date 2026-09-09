// Verify the pad/surface panel split + editor pool physics + checkbox gating.
import { chromium } from 'playwright';

const results = [];
const check = ( name, ok, extra = '' ) => {
	results.push( { name, ok } );
	console.log( `${ ok ? '✓' : '✗' } ${ name }${ extra ? ` — ${ extra }` : '' }` );
};

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );
const problems = [];

// ── build payload: start tile surrounded by a pool, custom pool ON at buoyancy 2.5 ──
const prep = await ( async () => {
	const b = await browser.newContext();
	const p = await b.newPage();
	await p.goto( 'http://localhost:8123/editor.html' );
	await p.waitForTimeout( 1000 );
	const out = await p.evaluate( async () => {
		const T = await import( './js/Track.js' );
		const cells = [ [ 0, 0, 'track-start-finish', 0 ] ];
		const water = [];
		for ( let gx = -3; gx <= 3; gx ++ ) for ( let gz = -3; gz <= 3; gz ++ ) {
			if ( gx === 0 && gz === 0 ) continue;
			water.push( [ gx, gz ] );
		}
		const mods = { b: [], p: [], k: [], l: [], j: [], o: [], t: 'normal',
			q: water, r: { drag: 1.8, buoyancy: 3, colorsOn: true, waterColor: '#ff0055', edgeColor: '#00ff99', transparent: true },
			e: [], u: [], d: [], m: [], a: [], w: { preset: 'clear' }, c: {}, y: {}, x: {}, z: [] };
		return { map: T.encodeCells( cells ), mods: await T.encodeV3Json( mods ) };
	} );
	await b.close();
	return out;
} )();

const page = await ctx.newPage();
page.on( 'pageerror', e => problems.push( String( e ).slice( 0, 120 ) ) );
await page.goto( `http://localhost:8123/editor.html?map=${ encodeURIComponent( prep.map ) }&mods=${ encodeURIComponent( prep.mods ) }` );
await page.waitForTimeout( 4000 );
check( 'editor boots clean with pool payload', problems.length === 0, problems[ 0 ] || '' );

// ── 1. dropdown cleanup: no pad-custom options, buttons still there ──
const dropdown = await page.evaluate( () => {
	const opts = [ ... document.getElementById( 'pad-select' ).options ].map( o => o.value );
	return { opts, padA: !! document.getElementById( 'btn-pad-custom-a' ), surfA: !! document.getElementById( 'btn-surface-custom-a' ) };
} );
check( 'pad dropdown has no custom pad options', ! dropdown.opts.some( v => v.startsWith( 'pad-custom-' ) ) );
check( 'standalone pad/surface buttons kept', dropdown.padA && dropdown.surfA );

// ── 2. panel split: pad editor opens the pad panel only ──
await page.click( '#btn-pad-custom-a' );
let panelState = await page.evaluate( () => ( {
	padVisible: ! document.getElementById( 'custom-pad-panel' ).hidden,
	surfaceVisible: ! document.getElementById( 'custom-surface-panel' ).hidden,
	padTitle: document.getElementById( 'custom-pad-title' ).textContent,
	padHasGravity: !! document.getElementById( 'custom-pad-panel' ).querySelector( '#cs-pad-gravity' ),
	padHasGrip: !! document.getElementById( 'custom-pad-panel' ).querySelector( '#cs-grip' ),
	padHasForce: !! document.getElementById( 'custom-pad-panel' ).querySelector( '#cs-force-forward' ),
	surfaceHasGrip: !! document.getElementById( 'custom-surface-panel' ).querySelector( '#cs-grip' ),
	surfaceHasGravity: !! document.getElementById( 'custom-surface-panel' ).querySelector( '#cs-pad-gravity' ),
	padHasOwnColor: !! document.getElementById( 'custom-pad-panel' ).querySelector( '#cs-pad-color' ),
	surfaceHasColor: !! document.getElementById( 'custom-surface-panel' ).querySelector( '#cs-color' ),
} ) );
check( 'Pad A opens only the pad panel', panelState.padVisible && ! panelState.surfaceVisible );
check( 'pad panel title', panelState.padTitle.includes( 'Pad' ) && panelState.padTitle.includes( 'A' ), panelState.padTitle );
check( 'pad panel has only pad settings', panelState.padHasGravity && ! panelState.padHasGrip && ! panelState.padHasForce && panelState.padHasOwnColor && ! panelState.surfaceHasGravity && panelState.surfaceHasGrip && panelState.surfaceHasColor );

// pad save flow
await page.evaluate( () => { document.getElementById( 'cs-pad-gravity' ).value = '2.5'; } );
await page.click( '#csp-save' );
await page.waitForTimeout( 300 );
await page.click( '#btn-pad-custom-a' );
const padPersist = await page.evaluate( () => document.getElementById( 'cs-pad-gravity' ).value );
check( 'pad settings persist through save', padPersist === '2.5', `value=${ padPersist }` );

// ── 3. surface editor opens the surface panel only ──
await page.click( '#btn-surface-custom-a' );
panelState = await page.evaluate( () => ( {
	padVisible: ! document.getElementById( 'custom-pad-panel' ).hidden,
	surfaceVisible: ! document.getElementById( 'custom-surface-panel' ).hidden,
	surfaceTitle: document.getElementById( 'custom-surface-title' ).textContent,
} ) );
check( 'Surface A opens only the surface panel', panelState.surfaceVisible && ! panelState.padVisible );
check( 'surface panel title', panelState.surfaceTitle.includes( 'Surface' ) && panelState.surfaceTitle.includes( 'A' ), panelState.surfaceTitle );
await page.evaluate( () => { document.getElementById( 'cs-grip' ).value = '3.3'; } );
await page.click( '#cs-save' );
await page.waitForTimeout( 300 );
await page.click( '#btn-surface-custom-a' );
const surfPersist = await page.evaluate( () => document.getElementById( 'cs-grip' ).value );
check( 'surface settings persist through save', surfPersist === '3.3', `value=${ surfPersist }` );

// ── 4. pool physics: checkbox ON + buoyancy 2.5 → car floats ──
const driveIntoPool = async ( settleMs ) => {
	await page.evaluate( () => window.__skidEditorDrive.respawn() );
	await page.waitForTimeout( 400 );
	await page.evaluate( () => window.__skidEditorDrive.onDriveKey( 'ArrowUp', true ) );
	let inWater = false, pos = null;
	for ( let i = 0; i < 30; i ++ ) {
		await page.waitForTimeout( 500 );
		const s = await page.evaluate( () => ( { inWater: window.__skidEditorDrive.isVehicleInWater(), pos: window.__skidEditorDrive.getVehiclePos() } ) );
		if ( s.inWater ) { inWater = true; pos = s.pos; break; }
	}
	if ( inWater ) await page.waitForTimeout( settleMs );
	const final = await page.evaluate( () => ( { inWater: window.__skidEditorDrive.isVehicleInWater(), pos: window.__skidEditorDrive.getVehiclePos() } ) );
	await page.evaluate( () => window.__skidEditorDrive.onDriveKey( 'ArrowUp', false ) );
	return { reached: inWater, final };
};

const floatRun = await driveIntoPool( 4000 );
check( 'car reaches the pool', floatRun.reached, `pos=${ JSON.stringify( floatRun.final.pos ) }` );
check( 'car FLOATS with buoyancy 3 (checkbox ON)', floatRun.final.pos && floatRun.final.pos[ 1 ] > -0.9, `y=${ floatRun.final.pos?.[ 1 ]?.toFixed( 2 ) }` );

// ── 5. uncheck the custom pool box → classic physics, car sinks ──
await page.evaluate( () => document.getElementById( 'cp-colors-toggle' ).click() );
await page.waitForTimeout( 1200 ); // let the drive sim rebuild
const sinkRun = await driveIntoPool( 5000 );
check( 'car SINKS with checkbox OFF (classic physics)', sinkRun.reached && sinkRun.final.pos && sinkRun.final.pos[ 1 ] < -1.0, `y=${ sinkRun.final.pos?.[ 1 ]?.toFixed( 2 ) }` );

// re-enable for good measure
await page.evaluate( () => document.getElementById( 'cp-colors-toggle' ).click() );

check( 'no page errors during the run', problems.length === 0, problems[ 0 ] || '' );
await page.screenshot( { path: 'verify-pads-pools.png' } );
const failed = results.filter( r => ! r.ok ).length;
console.log( `\n${ results.length - failed }/${ results.length } checks passed` );
await browser.close();
process.exit( failed ? 1 : 0 );
