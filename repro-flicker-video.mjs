// Record actual video of the underwater view, extract frames with ffmpeg,
// measure per-frame luminance of a fixed patch -> detect strobing.
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const quality = process.argv[ 2 ] || 'medium';
const throttle = process.argv[ 3 ] || '1';
const dir = `flick-${ quality }-${ throttle }`;
execSync( `rm -rf ${ dir } && mkdir -p ${ dir }` );

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 }, recordVideo: { dir: `./${ dir }`, size: { width: 1280, height: 800 } } } );

const prep = await ( async () => {
	const b = await browser.newContext();
	const p = await b.newPage();
	await p.goto( 'http://localhost:8123/editor.html' );
	await p.waitForTimeout( 1000 );
	const out = await p.evaluate( async () => {
		const T = await import( './js/Track.js' );
		const cells = [];
		for ( let i = 0; i < 120; i ++ ) { const a = ( i / 120 ) * Math.PI * 2; cells.push( [ Math.round( Math.sin( a ) * 14 ), Math.round( Math.cos( a ) * 14 ), 'track-straight', 0 ] ); }
		cells.push( [ 0, 14, 'track-start-finish', 0 ] );
		const v3 = await T.encodeCellsV3( cells );
		const mods = { b: [], p: [], k: [], l: [], j: [], o: [], t: 'normal', e: [], u: [], d: [], m: [], a: [],
			w: { preset: 'clear' }, c: {}, y: {}, x: {}, z: [], r: { drag: 1.8, buoyancy: 0.28, colorsOn: true, waterColor: '#1f8fd6', edgeColor: '#5cc7ff', transparent: true } };
		mods.q = [];
		for ( let gx = 0; gx <= 6; gx ++ ) for ( let gz = 3; gz <= 6; gz ++ ) mods.q.push( [ gx, gz ] );
		return { v3, mods: await T.encodeV3Json( mods ) };
	} );
	await b.close();
	return out;
} )();

const page = await ctx.newPage();
const errs = [];
page.on( 'pageerror', e => errs.push( String( e ).slice( 0, 120 ) ) );
await page.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
await page.goto( `http://localhost:8123/index.html?map=${ encodeURIComponent( prep.v3 ) }&mods=${ encodeURIComponent( prep.mods ) }` );
await page.waitForTimeout( 9000 );
await page.evaluate( () => {
	const D = window.__skidWaterDebug;
	const f = D.getFreecam();
	f.active = true;
	const c = D.getCamera();
	c.position.set( 1.1 * 9.99, -2.8, 3.6 * 9.99 );
	f.yaw = Math.PI * 0.5; f.pitch = -0.28;
} );
const cdp = await ctx.newCDPSession( page );
if ( throttle !== '1' ) await cdp.send( 'Emulation.setCPUThrottlingRate', { rate: Number( throttle ) } );
await page.waitForTimeout( 8000 );
await ctx.close(); // finalizes the video
await browser.close();

// find the webm and extract frames
const video = execSync( `ls ${ dir }/*.webm | head -1` ).toString().trim();
console.log( 'video:', video );
execSync( `ffmpeg -y -loglevel error -i ${ video } -vf fps=30 ${ dir }/f%04d.png` );
const frameList = execSync( `ls ${ dir }/*.png | head -400` ).toString().trim().split( '\n' );
console.log( 'frames:', frameList.length );

// analyze patch luminance per frame (25%..30% x, 40%..45% y region scaled to 1280x800)
const browser2 = await chromium.launch();
const p2 = await ( await browser2.newContext() ).newPage();
const lums = [];
for ( const f of frameList ) {
	const dataUrl = 'data:image/png;base64,' + readFileSync( f ).toString( 'base64' );
	lums.push( await p2.evaluate( async ( url ) => {
		const img = new Image();
		await new Promise( ( res, rej ) => { img.onload = res; img.onerror = rej; img.src = url; } );
		const c = document.createElement( 'canvas' );
		c.width = img.width; c.height = img.height;
		const g = c.getContext( '2d' );
		g.drawImage( img, 0, 0 );
		const d = g.getImageData( Math.floor( img.width * 0.25 ), Math.floor( img.height * 0.4 ), 64, 64 ).data;
		let lum = 0;
		for ( let j = 0; j < d.length; j += 4 ) lum += 0.2126 * d[ j ] + 0.7152 * d[ j + 1 ] + 0.0722 * d[ j + 2 ];
		return Math.round( lum / ( 64 * 64 ) );
	}, dataUrl ) );
}
await browser2.close();
const L = lums;
const mean = L.reduce( ( a, b ) => a + b, 0 ) / L.length;
let spikes = 0;
for ( let i = 1; i < L.length - 1; i ++ ) if ( Math.abs( L[ i ] - L[ i - 1 ] ) > 15 && Math.abs( L[ i ] - L[ i + 1 ] ) > 15 ) spikes ++;
console.log( `q=${ quality } thr=${ throttle }x frames=${ L.length } mean=${ mean.toFixed( 1 ) } min=${ Math.min( ...L ) } max=${ Math.max( ...L ) } singleFrameSpikes=${ spikes } errs=${ errs.length }` );
console.log( 'trace:', L.slice( 0, 150 ).join( ' ' ) );
