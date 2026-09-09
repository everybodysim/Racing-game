// Real-UI verification: obstacle/moving-obstacle ghost previews + off-grid
// placement landing under the mouse.
// 1) Ghost visible when wall/jump/moving-slide/moving-custom tool selected.
// 2) Off-grid cube placement lands centered under the click point (<12px),
//    not half a cell right+down (~21px) as before the fix.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const browser = await chromium.launch();
const page = await ( await browser.newContext( { viewport: { width: 1280, height: 800 } } ) ).newPage();
const errors = [];
page.on( 'pageerror', e => errors.push( e.message ) );
await page.goto( 'http://localhost:8123/editor.html' );
await page.waitForTimeout( 2500 );
const canvas = page.locator( 'canvas' ).nth( 1 );
const box = await canvas.boundingBox();
await page.click( '#btn-clear' );
await page.waitForTimeout( 400 );
await canvas.screenshot( { path: '/tmp/ghost-G0.png' } );

async function ghostDiff( toolBtn, fx, fy, name, minPixels ) {
	await page.click( toolBtn );
	await page.mouse.move( box.x + box.width * fx, box.y + box.height * fy );
	await page.waitForTimeout( 300 );
	const shot = `/tmp/ghost-${name}.png`;
	await canvas.screenshot( { path: shot } );
	return execSync( `python3 - <<'PYEOF'
from PIL import Image
base = Image.open('/tmp/ghost-G0.png').convert('RGB').load()
im = Image.open('${shot}').convert('RGB'); px = im.load(); w, h = im.size
cx, cy = int(w*${fx}), int(h*${fy})
n = 0
for y in range(max(0,cy-45), min(h,cy+45)):
    for x in range(max(0,cx-45), min(w,cx+45)):
        a, b = base[x,y], px[x,y]
        if abs(a[0]-b[0])+abs(a[1]-b[1])+abs(a[2]-b[2]) > 40: n += 1
print(n)
PYEOF` ).toString().trim();
}
const wallGhost = await ghostDiff( '#btn-wall', 0.40, 0.60, 'wall', 60 );
const jumpGhost = await ghostDiff( '#btn-jump', 0.52, 0.55, 'jump', 40 );
const slideGhost = await ghostDiff( '#btn-moving-slide', 0.45, 0.65, 'slide', 60 );

// Custom mover: 3 orbiting blocks
await page.evaluate( () => {
	const set = ( id, v ) => { const el = document.getElementById( id ); el.value = v; el.dispatchEvent( new Event( 'input', { bubbles: true } ) ); };
	set( 'moving-custom-count', '3' );
	set( 'moving-custom-orbit', '2' );
} );
const customGhost = await ghostDiff( '#btn-moving-custom', 0.48, 0.62, 'custom', 100 );

// Off-grid cube placement under the mouse
await page.click( '#btn-offgrid' );
await page.click( '#btn-cube' );
const P = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.50 };
await page.mouse.click( P.x, P.y );
await page.waitForTimeout( 1000 );
await canvas.screenshot( { path: '/tmp/ghost-place.png' } );
const placeReport = execSync( `python3 - <<'PYEOF'
from PIL import Image
im = Image.open('/tmp/ghost-place.png').convert('RGB'); px = im.load(); w, h = im.size
cx, cy = int(w*0.55), int(h*0.50)
pts = []
for y in range(max(0,cy-30), min(h,cy+30)):
    for x in range(max(0,cx-30), min(w,cx+30)):
        r, g, b = px[x,y]
        # placed cube grey-blue (0x9da5b1): red~150s, b clearly above g
        if 110 < r < 210 and b > g + 5 and b > 130 and abs(r-g) < 30:
            pts.append((x,y))
if len(pts) < 12:
    print(f'NO_CUBE {len(pts)}')
else:
    mx = sum(p[0] for p in pts)/len(pts); my = sum(p[1] for p in pts)/len(pts)
    print(f'{mx-cx:.1f} {my-cy:.1f} {len(pts)}')
PYEOF` ).toString().trim();
console.log( `wall ghost px:      ${ wallGhost } (want > 60)` );
console.log( `jump ghost px:     ${ jumpGhost } (want > 40)` );
console.log( `slide ghost px:    ${ slideGhost } (want > 60)` );
console.log( `custom ghost px:   ${ customGhost } (want > 100)` );
console.log( `cube placement:    ${ placeReport } (want dx dy within ±12)` );
console.log( 'page errors:', errors.length ? errors : 'none' );
const [ dx, dy, n ] = placeReport.split(' ').map(Number);
await browser.close();
const ok = +wallGhost > 60 && +jumpGhost > 40 && +slideGhost > 60 && +customGhost > 100
	&& placeReport.startsWith('NO_CUBE') === false && Math.abs(dx) < 12 && Math.abs(dy) < 12 && ! errors.length;
process.exit( ok ? 0 : 1 );
