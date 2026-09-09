// Real-UI verification: obstacles cannot be placed on a cross block (editor.html).
// A = canvas center pixel, B = offset pixel (different cell).
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await ( await browser.newContext( { viewport: { width: 1280, height: 800 } } ) ).newPage();
const errors = [];
page.on( 'pageerror', e => errors.push( 'PAGEERR: ' + e.message ) );
await page.goto( 'http://localhost:8123/editor.html' );
await page.waitForTimeout( 2500 );
const canvas = page.locator( 'canvas' ).nth( 1 ); // renderer.domElement (minimap is nth 0)
const box = await canvas.boundingBox();
const A = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const B = { x: box.x + box.width * 0.62, y: box.y + box.height / 2 };
const toast = () => page.evaluate( () => document.getElementById( 'toast' ).textContent );

async function click( pt ) { await page.mouse.click( pt.x, pt.y ); await page.waitForTimeout( 120 ); }
async function tool( sel ) { await page.click( sel ); await page.waitForTimeout( 80 ); }

await tool( '#btn-elevated-cross' ); await click( A ); // cross at A
await tool( '#btn-pole' );        await click( B ); // pole at B (control)
const afterControl = await toast();

await click( A ); // pole onto cross cell → expect guard toast
const t1 = await toast();
await tool( '#btn-elevated-cross' ); await click( B ); // cross onto pole cell → expect guard toast
const t2 = await toast();
await page.waitForTimeout( 2200 ); // let step-4 toast hide (text lingers after hide)
await tool( '#btn-pole' ); await click( B ); // toggling existing pole OFF stays allowed
await page.waitForTimeout( 150 );
const t3 = await page.evaluate( () => document.getElementById( 'toast' ).classList.contains( 'show' ) ? document.getElementById( 'toast' ).textContent : '(no toast)' );

const pass = [];
pass.push( [ 'pole on non-cross cell ok', ! afterControl.includes( 'cross' ) ] );
pass.push( [ 'obstacle-on-cross blocked', t1.includes( 'Obstacles cannot be placed on a cross block' ) ] );
pass.push( [ 'cross-on-obstacle blocked', t2.includes( 'erase them first' ) ] );
pass.push( [ 'toggle-off still allowed', ! t3.includes( 'cannot' ) ] );
for ( const [ name, ok ] of pass ) console.log( ( ok ? 'PASS' : 'FAIL' ) + ' — ' + name );
console.log( 'page errors:', errors.length ? errors : 'none' );
await browser.close();
if ( errors.length || pass.some( p => ! p[ 1 ] ) ) process.exit( 1 );
