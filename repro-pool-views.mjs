// Compare pools in low vs medium from UNDERWATER + pool-filled preset views.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const mode = process.argv[ 2 ] || 'underwater'; // 'underwater' | 'grazing' | 'poolfilled'
const quality = process.argv[ 3 ] || 'low';
const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 } } );
const prep = await ( async () => {
	const b = await browser.newContext();
	const p = await b.newPage();
	await p.goto( 'http://localhost:8123/editor.html' );
	await p.waitForTimeout( 1000 );
	const out = await p.evaluate( async ( mode ) => {
		const T = await import( './js/Track.js' );
		const cells = [];
		for ( let i = 0; i < 120; i ++ ) { const a = ( i / 120 ) * Math.PI * 2; cells.push( [ Math.round( Math.sin( a ) * 14 ), Math.round( Math.cos( a ) * 14 ), 'track-straight', 0 ] ); }
		cells.push( [ 0, 14, 'track-start-finish', 0 ] );
		const v3 = await T.encodeCellsV3( cells );
		const mods = { b: [], p: [], k: [], l: [], j: [], o: [], t: 'normal', e: [], u: [], d: [], m: [], a: [],
			w: { preset: 'clear' }, c: {}, y: {}, x: {}, z: [], q: [], r: {} };
		if ( mode === 'poolfilled' ) mods.t = 'pool-filled';
		else { mods.t = 'normal'; mods.q = []; for ( let gx = 0; gx <= 6; gx ++ ) for ( let gz = 3; gz <= 6; gz ++ ) mods.q.push( [ gx, gz ] ); }
		mods.r = { drag: 1.8, buoyancy: 0.28, colorsOn: true, waterColor: '#1f8fd6', edgeColor: '#5cc7ff', transparent: true };
		return { v3, mods: await T.encodeV3Json( mods ) };
	}, mode );
	await b.close();
	return out;
} )();

const page = await ctx.newPage();
const errs = [];
page.on( 'pageerror', e => errs.push( String( e ).slice( 0, 150 ) ) );
await page.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
await page.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( prep.v3 ) }&mods=${ encodeURIComponent( prep.mods ) }` );
await page.waitForTimeout( 9000 );
const camSetup = await page.evaluate( ( m ) => {
	const D = window.__skidWaterDebug;
	const f = D.getFreecam();
	f.active = true;
	const c = D.getCamera();
	if ( m === 'underwater' ) {
		c.position.set( 3.5 * 9.99, -1.5, 4.5 * 9.99 );
		f.yaw = Math.PI * 0.25; f.pitch = -0.15;
	} else if ( m === 'grazing' ) {
		c.position.set( 3.5 * 9.99, 1.2, 2.2 * 9.99 );
		f.yaw = 0; f.pitch = -0.12;
	} else {
		c.position.set( 0, 4, -8 * 9.99 );
		f.yaw = 0; f.pitch = -0.5;
	}
	return c.position.toArray();
}, mode );
await page.waitForTimeout( 900 );
const shot = `pool-${ mode }-${ quality }.png`;
await page.screenshot( { path: shot } );

// ASCII structure view
const dataUrl = 'data:image/png;base64,' + readFileSync( shot ).toString( 'base64' );
const ascii = await page.evaluate( async ( url ) => {
	const img = new Image();
	await new Promise( ( res, rej ) => { img.onload = res; img.onerror = rej; img.src = url; } );
	const c = document.createElement( 'canvas' );
	c.width = 72; c.height = 26;
	const g = c.getContext( '2d' );
	g.drawImage( img, 0, 0, 72, 26 );
	const d = g.getImageData( 0, 0, 72, 26 ).data;
	const chars = ' .:-=+*#%@';
	const out = [];
	for ( let y = 0; y < 26; y ++ ) {
		let line = '';
		for ( let x = 0; x < 72; x ++ ) {
			const i = ( y * 72 + x ) * 4;
			const L = ( 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ] ) / 255;
			line += chars[ Math.min( 9, Math.floor( L * 10 ) ) ];
		}
		out.push( line );
	}
	// full stats
	const d2 = g.getImageData( 0, 0, img.width, img.height ).data;
	let lum = 0, mn = 999, mx = -1, black = 0, n = 0;
	for ( let i = 0; i < d2.length; i += 160 ) {
		const L = 0.2126 * d2[ i ] + 0.7152 * d2[ i + 1 ] + 0.0722 * d2[ i + 2 ];
		lum += L; n ++;
		if ( L < mn ) mn = L; if ( L > mx ) mx = L;
		if ( L < 25 ) black ++;
	}
	return { ascii: out, stats: { meanLum: Math.round( lum / n ), minLum: Math.round( mn ), maxLum: Math.round( mx ), blackPct: Math.round( 1000 * black / n ) / 10 } };
}, dataUrl );
console.log( `${ mode }/${ quality } camAt=${ camSetup.map( v => v.toFixed( 1 ) ) }`, JSON.stringify( ascii.stats ), 'errs:', errs.length );
console.log( ascii.ascii.join( '\n' ) );
await browser.close();
