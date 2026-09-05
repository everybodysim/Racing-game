// Mobile UI (?is-mobile param) test suite.
//
// The mobile UI is activated ONLY by the ?is-mobile URL param — no device,
// UA, or touch auto-detection. Everything is scoped to body.mobile, which the
// param script adds at the top of <body>. Desktop gameplay without the param
// is pixel-identical to before.
// Run: node test-mobile-ui.mjs

import { readFileSync } from 'node:fs';

const html = readFileSync( './index.html', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

// 1. Param activation — no auto-detection
test( '?is-mobile URL param adds body.mobile', /has\( 'is-mobile' \) \)/.test( html ) && /classList\.add\( 'mobile' \)/.test( html ) );
test( 'param check runs in the early body script (FOUC-safe)', html.indexOf( "has( 'is-mobile' )" ) > 0 && html.indexOf( "has( 'is-mobile' )" ) < html.indexOf( '</body>' ) );
const iife = html.slice( html.indexOf( 'Mobile UI is opt-in' ), html.indexOf( 'Mobile UI is opt-in' ) + 900 );
const activeIife = iife.slice( 0, iife.indexOf( '// Future auto-detection' ) );
test( 'NO active detection logic (UA / touch / screen size all commented out)', ! /navigator\.userAgent|maxTouchPoints|ontouchstart/.test( activeIife ) );
test( 'old detection flow preserved as comments for later', /\/\/ var isTouch = 'ontouchstart'/.test( html ) );

// 2. Desktop untouched
test( 'desktop home lock still force-applies without body.mobile', /#home-body \{ grid-template-columns: 1\.4fr 1fr !important; \}/.test( html ) );
test( 'all new CSS scoped to body.mobile (no bare selectors in the new block)', ( () => {
	const block = html.slice( html.indexOf( 'MOBILE UI — ?is-mobile URL PARAM' ), html.indexOf( 'MOBILE UI — ?is-mobile URL PARAM' ) + 4200 );
	const ruleLines = block.split( '\n' ).filter( ( l ) => /\t\t[a-zA-Z#][^{]*\{\s*$/.test( l ) || /\t\t[a-zA-Z#].*\{\s/.test( l ) );
	return ruleLines.every( ( l ) => l.trim().startsWith( 'body.mobile' ) || l.trim().startsWith( '@media' ) );
} )() );

// 3. Mobile rearrangement covers the key surfaces
const mob = ( sel ) => html.includes( `body.mobile ${ sel }` );
test( 'home page drops to one column on mobile', mob( '#home-body { grid-template-columns: 1fr !important; }' ) );
test( 'desktop float chrome hidden (recorder, HUD editor)', mob( '#video-recorder-btn,' ) && mob( '#hud-edit-toggle,' ) );
test( 'stunt points clear of the action dock', mob( '#stunt-points {' ) );
test( 'touch-sized buttons in mode menu + hacks panel', mob( '#mode-menu button,' ) );
test( 'advancements close button touch-sized', mob( '#adv-close { min-height: 44px' ) );
test( 'landscape compact chrome present', /orientation: landscape/.test( html ) );

// 4. Existing mobile layer wired to the class
test( 'mobile action dock exists and shows via body.mobile', /<nav id="mobile-action-dock"/.test( html ) && /body\.mobile #mobile-action-dock \{ display: flex; \}/.test( html ) );
test( 'mobile menu sheet exists + opens via body.mobile', /<section id="mobile-menu-sheet"/.test( html ) && /body\.mobile #mobile-menu-sheet\.open/.test( html ) );
test( 'sheet wiring honors body.mobile class (isMobileUi)', /classList\.contains\('mobile'\)/.test( html ) );
test( 'sheet has back-to-home + settings + official tracks entries', ( () => {
	const sheet = html.slice( html.indexOf( 'class="mobile-actions-sheet"' ), html.indexOf( 'class="mobile-actions-sheet"' ) + 1600 );
	return sheet.includes( 'Back to home' ) && sheet.includes( 'Settings' ) && sheet.includes( 'Official tracks' );
} )() );

// 5. Emulator file
const emu = readFileSync( './mobile-emulator.html', 'utf8' );
test( 'mobile-emulator.html exists — single file, iframe-based', emu.includes( '<iframe' ) && ! /<script[^>]+src=/.test( emu ) );
test( 'emulator has phone presets + rotate + zoom', emu.includes( 'iPhone 15 Pro' ) && emu.includes( 'Rotate' ) && emu.includes( 'zoom' ) );
test( 'emulator appends ?is-mobile automatically', /searchParams\.set\( 'is-mobile', '1' \)/.test( emu ) );

// 6. Cache bumped
test( 'index.html cache bumped to 1000210', /v=1000210/.test( html ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
