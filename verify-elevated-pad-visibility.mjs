// Real-UI verification: pads on elevated tiles render ABOVE their deck plate.
// Places an elevated tile, paints a pink pad (pad-no-steering — no model uses
// pink), screenshots the center crop and counts pink pixels. Straight is the
// control (flush even pre-fix); 3-way/4-way/checkpoint decks sit above the
// model origin and buried pads pre-fix.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const TYPES = [
	[ 'btn-elevated-straight', 'straight (control)' ],
	[ 'btn-elevated-3way', 'elevated 3-way' ],
	[ 'btn-elevated-4way', 'elevated 4-way' ],
	[ 'btn-elevated-checkpoint', 'elevated checkpoint' ],
];

const browser = await chromium.launch();
let allPass = true;
for ( const [ btn, label ] of TYPES ) {
	const page = await ( await browser.newContext( { viewport: { width: 1280, height: 800 } } ) ).newPage();
	const errors = [];
	page.on( 'pageerror', e => errors.push( e.message ) );
	await page.goto( 'http://localhost:8123/editor.html' );
	await page.waitForTimeout( 2500 );
	const canvas = page.locator( 'canvas' ).nth( 1 );
	const box = await canvas.boundingBox();
	const C = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await page.click( '#' + btn );
	await page.mouse.click( C.x, C.y ); // place the elevated tile
	await page.selectOption( '#pad-select', 'pad-no-steering' ); // select pad tool
	await page.waitForTimeout( 300 );
	await page.mouse.click( C.x, C.y ); // paint the pad on the same cell
	await page.waitForTimeout( 600 );
	await canvas.screenshot( { path: `/tmp/padvis-${ btn }.png` } );
	const count = Number( execSync( `python3 -c "
from PIL import Image
im = Image.open('/tmp/padvis-${ btn }.png').convert('RGB')
w, h = im.size
cx, cy, half = w // 2, h // 2, 300
px = im.load()
n = sum(1 for y in range(cy - half, cy + half) for x in range(cx - half, cx + half)
        if px[x,y][0] > 140 and px[x,y][0] - px[x,y][1] > 50 and px[x,y][2] - px[x,y][1] > 20)
print(n)
"` ).toString().trim() );
	const ok = count > 150;
	if ( ! ok ) allPass = false;
	console.log( ( ok ? 'PASS' : 'FAIL' ) + ` — ${ label }: ${ count } pink pixels` + ( errors.length ? ' PAGEERR: ' + errors[ 0 ] : '' ) );
	await page.close();
}
await browser.close();
process.exit( allPass ? 0 : 1 );
