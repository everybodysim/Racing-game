// Repro: pads/surfaces on an ELEVATED deck in editor drive mode.
// Layout (+Z direction): start(0,0) → straight(0,1)+ground pad →
// slope-up(0,2,orient 2, rises toward +Z) → elevated deck (0,3)+pad,
// (0,4)+surface-bounce, (0,5) plain deck.
import { chromium } from 'playwright';
const cells = [
	[0,0,'track-start',0],
	[0,1,'track-straight',0],[0,2,'track-straight',0],[0,3,'track-straight',0],
	[0,4,'track-straight',0],[0,5,'track-straight',0],
];
const modsPayload = {
	b:[], p:[], k:[], l:[], j:[], o:[], d:[], m:[], a:[], q:[], z:[], x:{}, t:'normal',
	e: [[0,2,'slope-up',2],[0,3,'elevated-straight',0],[0,4,'elevated-straight',0],[0,5,'elevated-straight',0]],
	u: [[0,1,'pad-high-speed'],[0,3,'pad-high-speed'],[0,4,'surface-bounce']],
};
const b64url = s => Buffer.from(JSON.stringify(s)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const browser = await chromium.launch();
const page = await ( await browser.newContext( { viewport: { width: 1280, height: 900 } } ) ).newPage();
page.on( 'pageerror', ( e ) => console.log( 'PAGE-ERR', e.message ) );
await page.goto( 'http://localhost:8123/editor.html' );
await page.waitForTimeout( 2000 );
const enc = await page.evaluate( async ( cells ) => {
	const T = await import( 'http://localhost:8123/js/Track.js' );
	return T.encodeCells( cells );
}, cells );
await page.goto( 'http://localhost:8123/editor.html?map=' + encodeURIComponent( enc ) + '&mods=' + encodeURIComponent( b64url( modsPayload ) ) );
await page.waitForTimeout( 3000 );
await page.evaluate( () => window.__skidEditorDrive.respawn() );
await page.waitForTimeout( 300 );
const log = await page.evaluate( async () => {
	const seen = [];
	let last = '';
	const samples = [];
	const t0 = performance.now();
	window.__skidEditorDrive.onDriveKey( 'ArrowUp', true );
	while ( performance.now() - t0 < 45000 ) {
		await new Promise( r => setTimeout( r, 150 ) );
		const el = document.getElementById( 'toast' );
		if ( el.textContent && el.textContent !== last ) { last = el.textContent; seen.push( `${ ( ( performance.now() - t0 ) / 1000 ).toFixed( 1 ) }s: ${ last }` ); }
		const p = window.__skidEditorDrive.getVehiclePos();
		samples.push( { t: + ( ( performance.now() - t0 ) / 1000 ).toFixed( 1 ), z: +p[2].toFixed( 2 ), y: +p[1].toFixed( 2 ) } );
	}
	window.__skidEditorDrive.onDriveKey( 'ArrowUp', false );
	return { seen, samples };
} );
console.log( 'toasts:', JSON.stringify( log.seen ) );
// print y/z trajectory compressed: every ~1s plus any y-jump
let prevT = -1;
for ( const s of log.samples ) {
	if ( s.t - prevT >= 1 || s.y > 1 ) { console.log( `t=${s.t} z=${s.z} y=${s.y}` ); prevT = s.t; }
}
const maxY = Math.max( ...log.samples.map( s => s.y ) );
console.log( 'maxY:', maxY.toFixed( 2 ) );
await browser.close();
