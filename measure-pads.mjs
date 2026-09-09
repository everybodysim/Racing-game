import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await ( await browser.newContext( { viewport: { width: 1280, height: 900 } } ) ).newPage();
page.on( 'pageerror', ( e ) => console.log( 'ERR', e.message ) );
await page.goto( 'http://localhost:8123/editor.html' );
await page.waitForTimeout( 2500 );
await page.evaluate( () => {
	window.__skidEditorFrameHook = () => {
		window.__skidEditorFrameHook = null;
		const mk = ( gx, gz, fn ) => {
			setCell( gx, gz, 'track-straight', 0 );
			const cell = grid.get( cellKey( gx, gz ) );
			fn( cell );
			placeOverlayMesh( gx, gz, cell );
		};
		mk( 0, 0, ( c ) => { c.bump = true; } );
		mk( 1, 0, ( c ) => { c.surfaceTypes.push( 'pad-high-speed' ); } );
		mk( 2, 0, ( c ) => { c.bump = true; c.surfaceTypes.push( 'pad-high-speed' ); } );
		mk( 3, 0, ( c ) => { c.elevatedType = 'elevated-cross'; c.elevatedOrient = 0; c.surfaceTypes.push( 'pad-high-speed' ); } );
		mk( 4, 0, ( c ) => { c.jump = true; c.jumpOrient = 0; c.surfaceTypes.push( 'pad-high-speed' ); } );
		// measure after a frame of build (meshes now exist)
		const out = {};
		for ( const gx of [ 0, 1, 2, 3, 4 ] ) {
			const x = ( gx + 0.5 ) * CELL_RAW;
			for ( const o of trackGroup.children ) {
				if ( Math.abs( o.position.x - x ) > 1 ) continue;
				const b = new THREE.Box3().setFromObject( o );
				out[ `c${ gx }:${ o.type || o.constructor.name }(${ o.children.length }ch)` ] = `${ b.min.y.toFixed( 3 ) } → ${ b.max.y.toFixed( 3 ) }`;
			}
		}
		window.__padMeasures = out;
	};
} );
await page.waitForTimeout( 800 );
console.log( JSON.stringify( await page.evaluate( () => window.__padMeasures ), null, 1 ) );
await browser.close();
