import { readFileSync } from 'fs';

const main = readFileSync( './js/main.js', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

const cloudStart = main.indexOf( 'function mulberry32' );
const cloudEnd = main.indexOf( 'function buildSkyDecorations' );
const clouds = main.slice( cloudStart, cloudEnd );

test( 'old flat cutout builder is gone', ! main.includes( 'makeLowPolyCloud' ) );
test( 'clouds are LIT (MeshStandardMaterial, not MeshBasicMaterial)', /MeshStandardMaterial\(/.test( clouds ) && ! /MeshBasicMaterial/.test( clouds ) );
test( 'flat shading kept (stylized low-poly look)', /flatShading: true/.test( clouds ) );
test( 'vertex-shaded puffs give clouds volume', /vertexColors: true/.test( clouds ) );
test( 'vertical AO gradient: bright tops, shaded undersides', /Math\.pow\( t, 0\.65 \)/.test( clouds ) && /shade\.clone\(\)\.lerp\( base/.test( clouds ) );
test( 'cumulus structure: wide base anvil + crowning puffs', /basePuffs/.test( clouds ) && /crownPuffs/.test( clouds ) );
test( 'shade tint mixes toward a shadowy blue, not pure black', /0x2a3550/.test( clouds ) );
test( 'cloud shapes are seeded (deterministic per index)', /mulberry32\( 4000 \+ i \)/.test( main ) );
test( 'seeded RNG helper defined once', ( main.match( /function mulberry32/g ) || [] ).length === 1 );
test( 'call site passes the rng through', /makeStylizedCloud\( scale, config\.clouds\.color, config\.clouds\.opacity, mulberry32/.test( main ) );
test( 'transparency + no fog on clouds (unchanged behavior)', /transparent: opacity < 1/.test( clouds ) && /fog: false/.test( clouds ) );
test( 'no external CDN / downloaded cloud assets', ! /https?:\/\/[^'\"\s]*(cdn|jsdelivr|unpkg)/i.test( clouds ) );
test( 'cache bumped', /v=1000204/.test( readFileSync( './index.html', 'utf8' ) ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
