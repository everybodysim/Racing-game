// REAL underwater flicker repro: car drives off a road straight into a pool,
// chase cam goes underwater, CPU-throttled. Video + per-frame analysis.
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const quality = process.argv[ 2 ] || 'medium';
const throttle = process.argv[ 3 ] || '1';
const dir = `drive-${ quality }-${ throttle }`;
execSync( `rm -rf ${ dir } && mkdir -p ${ dir }` );

const browser = await chromium.launch();
const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 }, recordVideo: { dir: `./${ dir }`, size: { width: 1280, height: 800 } } } );

// track: straight road north, ending in a pool
const prep = await ( async () => {
	const b = await browser.newContext();
	const p = await b.newPage();
	await p.goto( 'http://localhost:8123/editor.html' );
	await p.waitForTimeout( 1000 );
	const out = await p.evaluate( async () => {
		const T = await import( './js/Track.js' );
		const cells = [ [ 0, 0, 'track-start-finish', 0 ] ];
		for ( let z = 1; z <= 13; z ++ ) cells.push( [ 0, z, 'track-straight', 0 ] );
		const v3 = await T.encodeCellsV3( cells );
		const mods = { b: [], p: [], k: [], l: [], j: [], o: [], t: 'normal', e: [], u: [], d: [], m: [], a: [],
			w: { preset: 'clear' }, c: {}, y: {}, x: {}, z: [], r: { drag: 1.8, buoyancy: 0.28, colorsOn: false } };
		mods.q = [];
		for ( let gx = -2; gx <= 2; gx ++ ) for ( let gz = 14; gz <= 19; gz ++ ) mods.q.push( [ gx, gz ] );
		return { v3, mods: await T.encodeV3Json( mods ) };
	} );
	await b.close();
	return out;
} )();

const page = await ctx.newPage();
const errs = [];
page.on( 'pageerror', e => errs.push( String( e ).slice( 0, 120 ) ) );
await page.addInitScript( ( q ) => localStorage.setItem( 'racing-graphics-quality', q ), quality );
await page.goto( `http://localhost:8123/index.html?play=1&map=${ encodeURIComponent( prep.v3 ) }&mods=${ encodeURIComponent( prep.mods ) }` );
await page.waitForTimeout( 9000 );

// teleport the car above the pool center; it drops in and sinks (chase cam follows underwater)
await page.evaluate( async () => {
	const cc = await import( 'https://esm.sh/crashcat@0.0.2' );
	const v = window.__skidWaterDebug.getVehicle();
	cc.rigidBody.setPosition( v.physicsWorld, v.rigidBody, [ 0, 1.5, 16.5 * 9.99 ], false );
	cc.rigidBody.setLinearVelocity( v.physicsWorld, v.rigidBody, [ 0, 0, 0 ] );
	cc.rigidBody.setAngularVelocity( v.physicsWorld, v.rigidBody, [ 0, 0, 0 ] );
} );

const cdp = await ctx.newCDPSession( page );
if ( throttle !== '1' ) await cdp.send( 'Emulation.setCPUThrottlingRate', { rate: Number( throttle ) } );

// record while the car sinks
await page.waitForTimeout( 7000 );
const final = await page.evaluate( () => {
	const v = window.__skidWaterDebug.getVehicle();
	const D = window.__skidWaterDebug;
	return { y: v.spherePos.y, z: v.spherePos.z, camY: D.getCamera().position.y, fog: !! D.getScene().fog };
} );
console.log( 'final:', JSON.stringify( final ) );
await ctx.close();
await browser.close();

const video = execSync( `ls ${ dir }/*.webm | head -1` ).toString().trim();
execSync( `ffmpeg -y -loglevel error -i ${ video } -vf fps=30 ${ dir }/f%04d.png` );
const total = parseInt( execSync( `ls ${ dir }/*.png | wc -l` ).toString() );
const frames = execSync( `ls ${ dir }/f*.png | sort | tail -170` ).toString().trim().split( '\n' );
console.log( 'total frames:', total, 'analyzing last', frames.length );

const browser2 = await chromium.launch();
const p2 = await ( await browser2.newContext() ).newPage();
const L = [];
for ( const f of frames ) {
	const dataUrl = 'data:image/png;base64,' + readFileSync( f ).toString( 'base64' );
	L.push( await p2.evaluate( async ( url ) => {
		const img = new Image();
		await new Promise( ( res, rej ) => { img.onload = res; img.onerror = rej; img.src = url; } );
		const c = document.createElement( 'canvas' );
		c.width = img.width; c.height = img.height;
		const g = c.getContext( '2d' );
		g.drawImage( img, 0, 0 );
		// center band: around the car/camera target
		const d = g.getImageData( Math.floor( img.width * 0.4 ), Math.floor( img.height * 0.35 ), 128, 128 ).data;
		let lum = 0, mn = 999, mx = -1;
		for ( let j = 0; j < d.length; j += 4 ) {
			const v2 = 0.2126 * d[ j ] + 0.7152 * d[ j + 1 ] + 0.0722 * d[ j + 2 ];
			lum += v2; if ( v2 < mn ) mn = v2; if ( v2 > mx ) mx = v2;
		}
		return { m: Math.round( lum / ( 128 * 128 ) ), x: Math.round( mx ), n: Math.round( mn ) };
	}, dataUrl ) );
}
await browser2.close();
const M = L.map( f => f.m );
let spikes = 0;
for ( let i = 1; i < M.length - 1; i ++ ) if ( Math.abs( M[ i ] - M[ i - 1 ] ) > 12 && Math.abs( M[ i ] - M[ i + 1 ] ) > 12 ) spikes ++;
console.log( `q=${ quality } thr=${ throttle }x mean=${ ( M.reduce( ( a, b ) => a + b, 0 ) / M.length ).toFixed( 1 ) } min=${ Math.min( ...M ) } max=${ Math.max( ...M ) } singleFrameSpikes=${ spikes } errs=${ errs.length }` );
console.log( 'trace:', M.slice( 0, 160 ).join( ' ' ) );
