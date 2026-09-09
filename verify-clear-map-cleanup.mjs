// Real-UI verification: Clearing the map removes pool holes + pool slopes.
// Normalizes with one Clear (editor may auto-load a saved track), then:
// S0 = pristine ground → paint water cell + pool slope → S1 → Clear → S2.
// S1 must show pool water at the cell; S2 must show none, and no screen
// region may drift (AA seam noise is fine — a leftover hole/slope is not).
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
const C = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

await page.click( '#btn-clear' ); // normalize: boot may auto-load a saved track
await page.waitForTimeout( 400 );
await canvas.screenshot( { path: '/tmp/clear-S0.png' } );

await page.click( '#btn-water' );
await page.mouse.click( C.x, C.y ); // water cell at center
await page.click( '#btn-pool-slope' );
await page.mouse.click( C.x, C.y ); // pool slope on that cell
await page.waitForTimeout( 600 );
await canvas.screenshot( { path: '/tmp/clear-S1.png' } );

await page.click( '#btn-clear' );
await page.waitForTimeout( 600 );
await canvas.screenshot( { path: '/tmp/clear-S2.png' } );

const report = execSync( `python3 - <<'PYEOF'
from PIL import Image
def load(p):
    return Image.open(p).convert('RGB')
im0 = load('/tmp/clear-S0.png'); im1 = load('/tmp/clear-S1.png'); im2 = load('/tmp/clear-S2.png')
w, h = im0.size
p0, p1, p2 = im0.load(), im1.load(), im2.load()
def water(px):
    n = 0
    for y in range(h//2-50, h//2+50):
        for x in range(w//2-50, w//2+50):
            c = px[x,y]
            if c[2] > c[1] + 15 and c[2] > 80: n += 1
    return n
w1 = water(p1)  # pool visible while placed
w2 = water(p2)  # pool residue after clear — must be zero
RX, RY = 10, 6
def regions(im):
    px = im.load(); out = []
    for ry in range(RY):
        row = []
        for rx in range(RX):
            x0 = rx*w//RX; x1 = (rx+1)*w//RX; y0 = ry*h//RY; y1 = (ry+1)*h//RY
            n = 0; r = g = b = 0
            for y in range(y0, y1, 4):
                for x in range(x0, x1, 4):
                    c = px[x,y]; r += c[0]; g += c[1]; b += c[2]; n += 1
            row.append((r//n, g//n, b//n))
        out.append(row)
    return out
r0, r2 = regions(im0), regions(im2)
max_drift = max(sum(abs(a-bb) for a,bb in zip(r0[ry][rx], r2[ry][rx])) for ry in range(RY) for rx in range(RX))
print(f'{w1} {w2} {max_drift}')
PYEOF` ).toString().trim();
const [ w1, w2, maxDrift ] = report.split( ' ' ).map( Number );
console.log( `water pixels while placed: ${ w1 } (want > 400)` );
console.log( `water pixels after clear: ${ w2 } (want < 50, gridline AA ok)` );
console.log( `max region drift after clear: ${ maxDrift } (want < 15)` );
console.log( 'page errors:', errors.length ? errors : 'none' );
await browser.close();
process.exit( w1 > 400 && w2 < 50 && maxDrift < 15 && ! errors.length ? 0 : 1 );
