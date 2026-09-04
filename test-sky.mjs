import { readFileSync } from 'fs';

const main = readFileSync( './js/main.js', 'utf8' );
const editor = readFileSync( './editor.html', 'utf8' );
let passed = 0, failed = 0;
function test( name, cond ) { if ( cond ) { passed ++; console.log( `  ✓ ${ name }` ); } else { failed ++; console.log( `  ✗ ${ name }` ); } }

const shaderStart = main.indexOf( 'const skyDome' );
const shaderEnd = main.indexOf( 'skyDome.frustumCulled' );
const shader = main.slice( shaderStart, shaderEnd );
const decor = main.slice( main.indexOf( 'const CONSTELLATIONS' ), main.indexOf( 'function createMovingObstacleState' ) );

// 1. New preset is registered everywhere
test( 'night-constellations in WEATHER_PRESETS lighting', /'night-constellations': \{ bg: 0x071226/.test( main ) );
test( 'night-constellations in sky gradients', /'night-constellations': \{ top: '#01020a'/.test( main ) );
test( 'night-constellations in decor presets (with constellations flag)', /constellations: true \}/.test( main ) );
test( 'editor weather select offers Night (Constellations)', editor.includes( '<option value="night-constellations">Night (Constellations)</option>' ) );
test( 'normalizeWeatherPreset accepts it via WEATHER_PRESETS membership', main.includes( "return WEATHER_PRESETS[ preset ] ? preset : WEATHER_DEFAULT;" ) );

// 2. Constellations
test( 'five constellations defined', ( main.match( /name: '(?:Orion|Big Dipper|Cassiopeia|Cygnus|Lyra)'/g ) || [] ).length === 5 );
test( 'constellation lines connect valid star indices', ( () => {
	const block = main.slice( main.indexOf( 'const CONSTELLATIONS' ), main.indexOf( '];', main.indexOf( 'const CONSTELLATIONS' ) ) );
	const consBlocks = block.split( '{ name:' ).slice( 1 );
	return consBlocks.every( ( cb ) => {
		const starsMatch = cb.match( /stars: \[ ([\s\S]*?) \], lines: \[ ([\s\S]*?) \] \}/ );
		if ( ! starsMatch ) return false;
		const starCount = ( starsMatch[ 1 ].match( /\], \[/g ) || [] ).length + 1;
		const lineMatches = [ ...starsMatch[ 2 ].matchAll( /\[ (\d+), (\d+) \]/g ) ];
		return lineMatches.length > 0 && lineMatches.every( ( lm ) => Number( lm[ 1 ] ) < starCount && Number( lm[ 2 ] ) < starCount );
	} );
} )() );
test( 'constellation lines are faint (well below full opacity)', /LineBasicMaterial\( \{ color: 0x9fc4ff, transparent: true, opacity: 0\.22/.test( decor ) );
test( 'constellation member stars drawn brighter/bigger', /size: 0\.55, sizeAttenuation/.test( decor ) );
test( 'constellation objects disposed on preset switch', /skyDecorState\.constellationLines\.geometry\?\.dispose\(\)/.test( main ) );

// 3. Deterministic sky
test( 'star field uses seeded RNG (mulberry32)', /function mulberry32/.test( main ) && /const rng = mulberry32\( 20260904 \)/.test( main ) );
test( 'moon craters are seeded too', /mulberry32\( 777 \)/.test( main ) );

// 4. Sky dome shader
test( 'sun disc + glow uniforms exist', /uniform vec3 sunDir;/.test( shader ) && /uniform float sunDisc;/.test( shader ) && /uniform float sunGlow;/.test( shader ) );
test( 'sunset sun rides LOW on the horizon', /sunset: \{ sunDir: \[ 0\.74, 0\.1, - 0\.36 \]/.test( main ) );
test( 'milky way band rendered for night presets', /uniform float milkyWay;/.test( shader ) && /mwNormal/.test( shader ) && /'night-constellations': \{ sunDir: \[ 0\.58, 0\.55, - 0\.27 \], sunColor: '#000000', disc: 0, glow: 0, milkyWay: 0\.28 \}/.test( main ) );
test( 'dithering kills gradient banding (dark skies need it)', /hash\( gl_FragCoord\.xy \) - 0\.5/.test( shader ) );
test( 'richer sunset palette', /sunset: \{ top: '#23134d', mid: '#c04a7f', horizon: '#ff7a3d'/.test( main ) );
test( 'night got more stars + brighter lighting', /stars: 900, moon: true \}/.test( main ) && /night: \{ bg: 0x0a1730, fogNearMul: 1\.92, fogFarMul: 4\.0, sun: 1\.9, hemi: 0\.55, exposure: 0\.78 \}/.test( main ) );
test( 'moon is a cratered canvas disc with halo', /getMoonTexture\(\)/.test( decor ) && /getMoonGlowTexture\(\)/.test( decor ) );

// 5. Hygiene
test( 'no external CDN / texture downloads for the sky', ! /https?:\/\/[^'\"\s]*(cdn|jsdelivr|unpkg|polyhaven)/i.test( main ) );
test( 'no leftover unseeded Math.random in the star loop', ! /const theta = Math\.random\(\) \* Math\.PI \* 2;/.test( main ) );
test( 'cache bumped', /v=1000204/.test( readFileSync( './index.html', 'utf8' ) ) );

console.log( `\n${ passed } passed, ${ failed } failed${ failed ? ' — WITH FAILURES' : '' }` );
process.exit( failed ? 1 : 0 );
