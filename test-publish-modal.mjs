import { readFileSync } from 'fs';

const t = readFileSync( './tracks.html', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

// 1. Modal exists and starts hidden
test( 'publish modal markup present', t.includes( 'id="publish-modal"' ) );
test( 'modal is hidden by default (no flash on page load)', /id="publish-modal" hidden/.test( t ) );
test( 'modal copy matches the requested wording', t.includes( 'Hold on — your track is publishing' ) );
test( 'modal is a proper dialog (role + aria-modal)', /role="dialog" aria-modal="true"/.test( t ) );

// 2. Overlay disables every other click
test( 'overlay covers the full screen (position:fixed; inset:0)', /#publish-modal\{position:fixed;inset:0/.test( t ) );
test( 'overlay sits above everything (z-index:9999)', /#publish-modal\{[^}]*z-index:9999/.test( t ) );
test( 'hidden modal is fully display:none', /#publish-modal\[hidden\]\{display:none/.test( t ) );

// 3. Loading bar
test( 'indeterminate shimmering loading bar present', t.includes( 'publish-modal-bar-fill' ) && /@keyframes publish-slide/.test( t ) );
test( 'loading bar animates (not a static strip)', /animation:publish-slide/.test( t ) );
test( 'bar uses the page accent gradient (cohesive theme)', /linear-gradient\(90deg,#5ac8ff,#77f3b1\)/.test( t ) );

// 4. Step-by-step status
test( 'shows upload step first', /setPublishModalStep\( 'Uploading track…' \)/.test( t ) );
test( 'then the board-refresh step', /setPublishModalStep\( 'Refreshing the Track Share Board…' \)/.test( t ) );

// 5. Anti-spam: in-flight lock
test( 'publishInFlight guard declared', /let publishInFlight = false;/.test( t ) );
test( 'click is a no-op while a publish is running', /if \( publishInFlight \) return;/.test( t ) );
test( 'guard set before the async publish starts', t.indexOf( 'publishInFlight = true;' ) < t.indexOf( 'addEntryFromGhostCode()\n' ) );
test( 'guard released in finally (also on errors)', /\.finally\( \(\) => \{ publishInFlight = false; \} \)/.test( t ) );

// 6. Modal lifecycle can never get stuck
test( 'modal shown before the POST', t.indexOf( 'showPublishModal();' ) < t.indexOf( "await apiRequest( '', {" ) );
test( 'modal hidden in finally — error-safe', /finally \{\s*\n\s*hidePublishModal\(\);/.test( t ) );
test( 'modal shown only inside the remote publish path (after validation)', t.indexOf( 'Ghost code is missing required race data.' ) < t.indexOf( "setPublishModalStep( 'Uploading track…' )" ) );

// 7. Hygiene
test( 'modal helpers null-guard their DOM refs', /function showPublishModal\(\) \{ if \( publishModal \) publishModal\.hidden = false; \}/.test( t ) );
test( 'no external assets / CDNs added', ! /https?:\/\/[^'\"\s]*(cdn|jsdelivr|unpkg)/i.test( t.slice( t.indexOf( 'publish-modal' ) ) ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
