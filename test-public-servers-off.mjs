// Public servers disabled test suite.
//
// Public servers are broken — their UI is removed (buttons + rows hidden)
// while the entire implementation is kept behind one flag for later.
// Private Host/Join is untouched.
// Run: node test-public-servers-off.mjs

import { readFileSync } from 'node:fs';

const main = readFileSync( './js/main.js', 'utf8' );
const html = readFileSync( './index.html', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

// 1. Single feature flag, default OFF
test( 'PUBLIC_SERVERS_UI_ENABLED flag exists and is false', /const PUBLIC_SERVERS_UI_ENABLED = false;/.test( main ) );
test( 'flag declared BEFORE the module-eval-time initMultiplayerPanel() call (no TDZ)', main.indexOf( 'const PUBLIC_SERVERS_UI_ENABLED' ) < main.indexOf( 'initMultiplayerPanel();' ) );

// 2. All public-server UI entry points gated
test( 'buildPublicServerButtons early-returns when disabled', /function buildPublicServerButtons\(\) \{\s*\n\t*if \( ! PUBLIC_SERVERS_UI_ENABLED \) return;/.test( main ) );
test( 'updatePublicServerButtonStates early-returns when disabled', /function updatePublicServerButtonStates\(\) \{\s*\n\t*if \( ! PUBLIC_SERVERS_UI_ENABLED \) return;/.test( main ) );
test( '?pubServer= URL auto-join gated behind the flag', /const pubServerParam = PUBLIC_SERVERS_UI_ENABLED\s*\n\s*\? String\(/.test( main ) );

// 3. UI hidden in the DOM (kept for later, not deleted)
test( 'mp-public-row kept but hidden', /<div id="mp-public-row" hidden>/.test( html ) );
test( 'mp-pubtrack-row kept but hidden', /<div id="mp-pubtrack-row" hidden>/.test( html ) );
test( 'hidden actually hides (explicit display rules beat the hidden attribute)', /#mp-public-row\[hidden\], #mp-pubtrack-row\[hidden\] \{ display: none !important; \}/.test( html ) );
test( 'hidden rows still present exactly once (code kept for later)', html.split( '<div id="mp-public-row"' ).length - 1 === 1 && html.split( '<div id="mp-pubtrack-row"' ).length - 1 === 1 );

// 4. Private host/join untouched
test( 'Host/Join buttons still active (no hidden attr)', ! /<div id="mp-actions"[^>]*hidden/.test( html ) && /<button id="mp-host-btn"/.test( html ) && /<button id="mp-join-btn"/.test( html ) );
test( 'room code row still active', /<div id="mp-code-row">/.test( html ) );

// 5. Implementation kept intact for the flag flip
for ( const fn of [ 'joinPublicServer', 'leavePublicServer', 'onPublicServerMapSync', 'onPublicServerVoteStart', 'broadcastPublicServerMapSync', 'isPublicServerConfigured' ] ) {
	test( `${ fn }() implementation still present`, new RegExp( `function ${ fn }|const ${ fn }|import[^;]*${ fn }`, 's' ).test( main ) );
}
test( 'PublicServers.js module still imported (not ripped out)', /from '\.\/PublicServers\.js/.test( main ) );

// 6. Cache bumped (main.js changed)
test( 'index.html cache bumped to 1000207', /v=1000209/.test( html ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
