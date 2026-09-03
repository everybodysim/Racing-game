import * as THREE from 'three';

export const ORIENT_DEG = { 0: 0, 10: 180, 16: 90, 22: 270 };

export const CELL_RAW = 9.99;
export const GRID_SCALE = 0.75;

const _dummy = new THREE.Object3D();
const JUMP_RAMP_ANGLE = THREE.MathUtils.degToRad( 30 );
const JUMP_RAMP_SIZE = CELL_RAW * 0.36;
const JUMP_RAMP_DEPTH = CELL_RAW * 0.18;
const JUMP_RAMP_Y = 0.24;
const VISUAL_HEIGHT_OFFSET = 0.012;
const DECORATION_HEIGHT_OFFSET = VISUAL_HEIGHT_OFFSET * 0.5;
const NO_DECO_BUFFER_CELLS = 1;
const POLE_RADIUS = CELL_RAW * 0.08;
const POLE_HEIGHT = CELL_RAW * 0.13;
const MAGNET_HALF_SIZE = CELL_RAW * 0.08;
const MAGNET_BASE_Y = ( CELL_RAW * 0.08 ) - 0.06;
const ELEVATED_HEIGHT = CELL_RAW * 0.5;
const SUPPORT_HEIGHT = CELL_RAW * 0.5;
const SUPPORT_COLOR = 0x0d0d0d;
const SLOPE_ANGLE = Math.atan2( ELEVATED_HEIGHT, CELL_RAW );
const SUPPORT_SINK = 0.03;
const ORIENT_180 = { 0: 10, 10: 0, 16: 22, 22: 16 };

const WATER_DEPTH = CELL_RAW * 0.34;
const WATER_WALL_HEIGHT = CELL_RAW * 0.38;

const WATER_SHADER_ASSET_ROOT = 'https://cdn.jsdelivr.net/gh/martinRenou/threejs-water@master/';
let waterWaveTexture = null;
let waterTileTexture = null;
function getWaterTextures() {
	if ( waterWaveTexture && waterTileTexture ) return { waterWaveTexture, waterTileTexture };
	const waterTextureLoader = new THREE.TextureLoader();
	waterTextureLoader.setCrossOrigin( 'anonymous' );
	waterWaveTexture = waterTextureLoader.load( `${ WATER_SHADER_ASSET_ROOT }water.png`, ( texture ) => {
		texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
	} );
	waterTileTexture = waterTextureLoader.load( `${ WATER_SHADER_ASSET_ROOT }tiles.jpg`, ( texture ) => {
		texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	} );
	return { waterWaveTexture, waterTileTexture };
}

function normalizePoolVisuals( extras = null ) {
	const cfg = extras?.customPool && typeof extras.customPool === 'object' ? extras.customPool : {};
	const isHex = ( value ) => /^#[0-9a-f]{6}$/i.test( String( value || '' ) );
	return {
		waterColor: isHex( cfg.waterColor ) ? cfg.waterColor : '#1f8fd6',
		edgeColor: isHex( cfg.edgeColor ) ? cfg.edgeColor : '#5cc7ff',
		transparent: cfg.transparent !== false,
	};
}

function createRepositoryWaterMaterial( visuals = normalizePoolVisuals() ) {

	const { waterWaveTexture, waterTileTexture } = getWaterTextures();
	return new THREE.ShaderMaterial( {
		uniforms: {
			time: { value: 0 },
			waveTex: { value: waterWaveTexture },
			tileTex: { value: waterTileTexture },
			lightDir: { value: new THREE.Vector3( 0.62, 0.74, - 0.25 ).normalize() },
			shallowColor: { value: new THREE.Color( visuals.waterColor ).lerp( new THREE.Color( 0xffffff ), 0.28 ) },
			deepColor: { value: new THREE.Color( visuals.waterColor ).lerp( new THREE.Color( 0x001b2f ), 0.45 ) },
			waterAlpha: { value: visuals.transparent ? 0.68 : 1.0 },
		},
		vertexShader: `
			varying vec2 vUv;
			varying vec3 vWorldPosition;
			uniform sampler2D waveTex;
			uniform float time;
			void main() {
				vUv = uv;
				vec3 transformed = position;
				vec2 waveUvA = uv * 3.0 + vec2( time * 0.035, time * 0.022 );
				vec2 waveUvB = uv * 7.0 + vec2( - time * 0.018, time * 0.031 );
				float waveA = texture2D( waveTex, waveUvA ).r;
				float waveB = texture2D( waveTex, waveUvB ).g;
				transformed.z += ( waveA + waveB - 1.0 ) * 0.045;
				vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
				vWorldPosition = worldPosition.xyz;
				gl_Position = projectionMatrix * viewMatrix * worldPosition;
			}
		`,
		fragmentShader: `
			uniform sampler2D waveTex;
			uniform sampler2D tileTex;
			uniform vec3 lightDir;
			uniform vec3 shallowColor;
			uniform vec3 deepColor;
			uniform float waterAlpha;
			uniform float time;
			varying vec2 vUv;
			varying vec3 vWorldPosition;
			void main() {
				vec2 flowA = vUv * 4.0 + vec2( time * 0.045, - time * 0.025 );
				vec2 flowB = vUv * 9.0 + vec2( - time * 0.018, time * 0.036 );
				vec3 waveA = texture2D( waveTex, flowA ).rgb;
				vec3 waveB = texture2D( waveTex, flowB ).rgb;
				vec2 ripple = ( waveA.rg + waveB.gb - 1.0 ) * 0.045;
				float foam = smoothstep( 0.74, 0.99, waveA.b * 0.65 + waveB.r * 0.35 );
				vec3 tile = texture2D( tileTex, vUv * 2.5 + ripple ).rgb;
				float caustic = pow( max( max( tile.r, tile.g ), tile.b ), 3.0 );
				vec3 normal = normalize( vec3( ripple.x * 3.2, 1.0, ripple.y * 3.2 ) );
				vec3 viewDir = normalize( cameraPosition - vWorldPosition );
				float fresnel = pow( 1.0 - max( dot( normal, viewDir ), 0.0 ), 3.0 );
				float sparkle = pow( max( dot( reflect( - lightDir, normal ), viewDir ), 0.0 ), 46.0 );
				vec3 color = mix( deepColor, shallowColor, 0.52 + 0.18 * waveA.b );
				color += tile * 0.045 + caustic * vec3( 0.35, 0.95, 1.15 ) * 0.23;
				color = mix( color, vec3( 0.78, 0.97, 1.0 ), fresnel * 0.62 + foam * 0.2 );
				color += sparkle * vec3( 1.0, 0.9, 0.62 ) * 1.25;
				gl_FragColor = vec4( color, waterAlpha );
			}
		`,
		transparent: visuals.transparent,
		depthWrite: ! visuals.transparent,
		side: THREE.DoubleSide,
	} );

}

const ELEVATED_TYPES = new Set( [ 'elevated-straight', 'elevated-corner', 'elevated-checkpoint', 'slope-up', 'slope-down', 'elevated-3-way', 'elevated-4-way' ] );

function normalizeElevatedEntry( elevatedType, orient = 0 ) {

	if ( elevatedType === 'slope-down' ) return { type: 'slope-up', orient: ORIENT_180[ orient ] ?? orient };
	return { type: elevatedType, orient };

}

function getOverlayHeightOffset( elevatedEntry ) {

	if ( ! elevatedEntry ) return 0;
	return elevatedEntry.type === 'slope-up' ? ELEVATED_HEIGHT * 0.5 : ELEVATED_HEIGHT;

}

function getSurfaceVisual( surfaceType, customSurfaces = null, customPads = null ) {

	switch ( surfaceType ) {

		case 'surface-ice': return { color: 0x7ad8ff, emissive: 0x1f6f8a, metalness: 0.2, roughness: 0.15 };
		case 'surface-boost': return { color: 0xff4b4b, emissive: 0xc1121f, metalness: 0.0, roughness: 0.9 };
		case 'surface-sand': return { color: 0xd7b46a, emissive: 0x6f4f22, metalness: 0.0, roughness: 1.0 };
		case 'surface-bounce': return { color: 0xbaff7a, emissive: 0x2f8f2f, metalness: 0.0, roughness: 0.75 };
		case 'surface-kick-l': return { color: 0xc683ff, emissive: 0x54208f, metalness: 0.0, roughness: 0.8 };
		case 'surface-kick-r': return { color: 0xff83d0, emissive: 0x8f2054, metalness: 0.0, roughness: 0.8 };
		case 'pad-reset': return { color: 0xffffff, emissive: 0x557c92, metalness: 0.1, roughness: 0.35 };
		case 'pad-low-gravity': return { color: 0x9bc2ff, emissive: 0x2e4f9f, metalness: 0.05, roughness: 0.55 };
		case 'pad-heavy-gravity': return { color: 0x4a5f85, emissive: 0x111b36, metalness: 0.05, roughness: 0.8 };
		case 'pad-high-grip': return { color: 0x5cff9a, emissive: 0x0d6a39, metalness: 0.02, roughness: 0.95 };
		case 'pad-high-speed': return { color: 0xffbc4f, emissive: 0x8a4e06, metalness: 0.0, roughness: 0.8 };
		case 'pad-no-brakes': return { color: 0xff6f6f, emissive: 0x7d1a1a, metalness: 0.0, roughness: 0.82 };
		case 'pad-no-steering': return { color: 0xff7ed8, emissive: 0x7a1f65, metalness: 0.02, roughness: 0.78 };
		case 'pad-no-acceleration': return { color: 0x85ffd8, emissive: 0x156e58, metalness: 0.0, roughness: 0.72 };
		case 'pad-slow-motion': return { color: 0x6ab5ff, emissive: 0x104f88, metalness: 0.05, roughness: 0.68 };
		case 'pad-fast-motion': return { color: 0xff9f3c, emissive: 0x8a2f00, metalness: 0.02, roughness: 0.7 };
		case 'pad-drift': return { color: 0xd6ff6a, emissive: 0x5c7a0f, metalness: 0.03, roughness: 0.8 };
		case 'pad-size-small': return { color: 0x58dcff, emissive: 0x156b8f, metalness: 0.04, roughness: 0.72 };
		case 'pad-size-normal': return { color: 0xffffff, emissive: 0x4f5f7a, metalness: 0.06, roughness: 0.7 };
		case 'pad-size-mega': return { color: 0xff8c5a, emissive: 0x7a2f12, metalness: 0.02, roughness: 0.78 };
		case 'pad-trick-yaw-1':
		case 'pad-trick-pitch-1':
		case 'pad-trick-roll-1':
		case 'pad-trick-yaw-pitch-1':
		case 'pad-trick-yaw-roll-1':
		case 'pad-trick-pitch-roll-1':
		case 'pad-trick-yaw-pitch-roll-1':
		case 'pad-trick-yaw-roll-pitch':
		case 'pad-trick-pitch-yaw-roll':
			return { color: 0x9c7dff, emissive: 0x311c72, metalness: 0.06, roughness: 0.62 };
		case 'pad-custom-a':
		case 'pad-custom-b':
		case 'pad-custom-c': {
			const colorHex = customPads?.[ surfaceType ]?.color || '#88c4ff';
			const color = new THREE.Color( colorHex );
			return { color: color.getHex(), emissive: color.clone().multiplyScalar( 0.45 ).getHex(), metalness: 0.04, roughness: 0.72 };
		}
		case 'surface-custom-a':
		case 'surface-custom-b':
		case 'surface-custom-c': {
			const colorHex = customSurfaces?.[ surfaceType ]?.color || '#9c7bff';
			const color = new THREE.Color( colorHex );
			return { color: color.getHex(), emissive: color.clone().multiplyScalar( 0.45 ).getHex(), metalness: 0.02, roughness: 0.72 };
		}
		default: return { color: 0xb88657, emissive: 0x4a2b12, metalness: 0.0, roughness: 0.9 };

	}

}

function cloneElevatedPiece( models, type, orient, gx, gz ) {

	if ( type === 'slope-down' ) {

		type = 'slope-up';
		orient = ORIENT_180[ orient ] ?? orient;

	}

	let modelKey = null;
	if ( type === 'elevated-straight' ) modelKey = 'elev-track-straight';
	else if ( type === 'elevated-corner' ) modelKey = 'elev-track-corner';
	else if ( type === 'elevated-checkpoint' ) modelKey = 'elev-track-checkpoint';
	else if ( type === 'slope-up' || type === 'slope-down' ) modelKey = 'elev-track-slope';
	else if ( type === 'elevated-3-way' ) modelKey = 'elev-track-3-way';
	else if ( type === 'elevated-4-way' ) modelKey = 'elev-track-4-way';
	if ( ! modelKey || ! models[ modelKey ] ) return null;

	const piece = models[ modelKey ].clone();
	// Slope model is pre-sloped at the correct size — place at ground level, no scaling
	const yAdjust = ( type === 'slope-up' || type === 'slope-down' ) ? - ELEVATED_HEIGHT : 0;
	piece.position.set(
		( gx + 0.5 ) * CELL_RAW,
		0.5 + VISUAL_HEIGHT_OFFSET + ELEVATED_HEIGHT + yAdjust,
		( gz + 0.5 ) * CELL_RAW
	);
	const deg = ORIENT_DEG[ orient ] ?? 0;
	piece.rotation.y = THREE.MathUtils.degToRad( deg );

	return piece;

}

function createSlopeSupportGeometry( slopeType ) {

	const geometry = new THREE.BoxGeometry( CELL_RAW, SUPPORT_HEIGHT, CELL_RAW );
	const position = geometry.attributes.position;
	const halfHeight = SUPPORT_HEIGHT * 0.5;
	const isSlopeUp = slopeType === 'slope-up';
	for ( let i = 0; i < position.count; i ++ ) {

		const y = position.getY( i );
		if ( y < halfHeight - 1e-5 ) continue;
		const z = position.getZ( i );
		const nearIsLow = isSlopeUp;
		const isNearEdge = z >= 0;
		const topY = ( nearIsLow ? ( isNearEdge ? 0 : SUPPORT_HEIGHT ) : ( isNearEdge ? SUPPORT_HEIGHT : 0 ) ) - halfHeight;
		position.setY( i, topY );

	}
	position.needsUpdate = true;
	geometry.computeVertexNormals();
	return geometry;

}

function createElevatedSupport( gx, gz, orient = 0, elevatedType = 'elevated-straight' ) {

	if ( elevatedType === 'slope-down' ) {

		elevatedType = 'slope-up';
		orient = ORIENT_180[ orient ] ?? orient;

	}

	const geometry = elevatedType === 'slope-up' || elevatedType === 'slope-down'
		? createSlopeSupportGeometry( elevatedType )
		: new THREE.BoxGeometry( CELL_RAW, SUPPORT_HEIGHT, CELL_RAW );

	const support = new THREE.Mesh(
		geometry,
		new THREE.MeshStandardMaterial( { color: SUPPORT_COLOR, roughness: 0.95, metalness: 0.0 } )
	);
	support.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + VISUAL_HEIGHT_OFFSET + ( SUPPORT_HEIGHT * 0.5 ) - SUPPORT_SINK, ( gz + 0.5 ) * CELL_RAW );
	support.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
	support.castShadow = true;
	support.receiveShadow = true;
	return support;

}

export const TRACK_CELLS = [
	[ -3, -3, 'track-corner',   16 ],
	[ -2, -3, 'track-checkpoint', 22 ],
	[ -1, -3, 'track-straight', 22 ],
	[  0, -3, 'track-corner',    0 ],
	[ -3, -2, 'track-straight',  0 ],
	[  0, -2, 'track-straight',  0 ],
	[ -3, -1, 'track-corner',   10 ],
	[ -2, -1, 'track-corner',    0 ],
	[  0, -1, 'track-straight',  0 ],
	[ -2,  0, 'track-checkpoint', 10 ],
	[  0,  0, 'track-finish',    0 ],
	[ -2,  1, 'track-straight', 10 ],
	[ -1,d  1,'track-checkpoint', 16 ],
	[  0,  1, 'track-straight',  0 ],
	[ -2,  2, 'track-corner',   10 ],
	[ -1,  2, 'track-straight', 16 ],
	[  0,  2, 'track-corner',   22 ],
];

const DECO_CELLS = [
	[ -4, -2, 'decoration-tents', 10 ],
	[ -1, -4, 'decoration-tents', 22 ],
	[ -1,  1, 'decoration-tents', 22 ],
	[ -8, -9, 'decoration-forest', 0 ], [ -7, -9, 'decoration-forest', 0 ],
	[ -6, -9, 'decoration-forest', 0 ], [ -5, -9, 'decoration-forest', 0 ],
	[ -4, -9, 'decoration-forest', 0 ], [ -3, -9, 'decoration-forest', 0 ],
	[ -2, -9, 'decoration-forest', 0 ], [ -1, -9, 'decoration-forest', 0 ],
	[  0, -9, 'decoration-forest', 0 ], [  1, -9, 'decoration-forest', 0 ],
	[  2, -9, 'decoration-forest', 0 ],
	[ -8, -8, 'decoration-forest', 0 ], [ -7, -8, 'decoration-forest', 0 ],
	[ -6, -8, 'decoration-forest', 0 ], [ -5, -8, 'decoration-forest', 0 ],
	[ -4, -8, 'decoration-forest', 0 ], [ -3, -8, 'decoration-forest', 0 ],
	[ -2, -8, 'decoration-forest', 0 ], [ -1, -8, 'decoration-forest', 0 ],
	[  0, -8, 'decoration-forest', 0 ], [  1, -8, 'decoration-forest', 0 ],
	[  2, -8, 'decoration-forest', 0 ],
	[ -8, -7, 'decoration-forest', 0 ], [ -7, -7, 'decoration-forest', 0 ],
	[ -6, -7, 'decoration-forest', 0 ], [ -5, -7, 'decoration-forest', 0 ],
	[ -4, -7, 'decoration-forest', 0 ], [ -3, -7, 'decoration-forest', 0 ],
	[ -2, -7, 'decoration-forest', 0 ], [ -1, -7, 'decoration-forest', 0 ],
	[  0, -7, 'decoration-forest', 0 ], [  1, -7, 'decoration-forest', 0 ],
	[  2, -7, 'decoration-forest', 0 ],
	[ -8, -6, 'decoration-forest', 0 ], [ -7, -6, 'decoration-forest', 0 ],
	[ -6, -6, 'decoration-forest', 0 ], [ -5, -6, 'decoration-forest', 0 ],
	[ -4, -6, 'decoration-forest', 0 ], [ -3, -6, 'decoration-empty', 0 ],
	[ -2, -6, 'decoration-empty', 0 ],  [ -1, -6, 'decoration-empty', 0 ],
	[  0, -6, 'decoration-empty', 0 ],  [  1, -6, 'decoration-forest', 0 ],
	[  2, -6, 'decoration-forest', 0 ],
	[ -8, -5, 'decoration-forest', 0 ], [ -7, -5, 'decoration-forest', 0 ],
	[ -6, -5, 'decoration-forest', 0 ], [ -5, -5, 'decoration-forest', 0 ],
	[ -4, -5, 'decoration-empty', 0 ],  [ -3, -5, 'decoration-empty', 0 ],
	[ -2, -5, 'decoration-empty', 0 ],  [ -1, -5, 'decoration-empty', 0 ],
	[  0, -5, 'decoration-empty', 0 ],  [  1, -5, 'decoration-forest', 0 ],
	[  2, -5, 'decoration-forest', 0 ],
	[ -8, -4, 'decoration-forest', 0 ], [ -7, -4, 'decoration-forest', 0 ],
	[ -6, -4, 'decoration-forest', 0 ], [ -5, -4, 'decoration-forest', 0 ],
	[ -4, -4, 'decoration-empty', 0 ],
	[  1, -4, 'decoration-forest', 0 ],
	[  2, -4, 'decoration-forest', 0 ],
	[ -8, -3, 'decoration-forest', 0 ], [ -7, -3, 'decoration-forest', 0 ],
	[ -6, -3, 'decoration-forest', 0 ], [ -5, -3, 'decoration-forest', 0 ],
	[ -4, -3, 'decoration-empty', 0 ],
	[  1, -3, 'decoration-forest', 0 ],
	[  2, -3, 'decoration-forest', 0 ],
	[ -8, -2, 'decoration-forest', 0 ], [ -7, -2, 'decoration-forest', 0 ],
	[ -6, -2, 'decoration-forest', 0 ], [ -5, -2, 'decoration-forest', 0 ],
	[  1, -2, 'decoration-forest', 0 ],
	[  2, -2, 'decoration-forest', 0 ],
	[ -8, -1, 'decoration-forest', 0 ], [ -7, -1, 'decoration-forest', 0 ],
	[ -6, -1, 'decoration-forest', 0 ], [ -5, -1, 'decoration-forest', 0 ],
	[ -4, -1, 'decoration-empty', 0 ],  [ -1, -1, 'decoration-empty', 0 ],
	[  1, -1, 'decoration-forest', 0 ],
	[  2, -1, 'decoration-forest', 0 ],
	[ -8,  0, 'decoration-forest', 0 ], [ -7,  0, 'decoration-forest', 0 ],
	[ -6,  0, 'decoration-forest', 0 ], [ -5,  0, 'decoration-forest', 0 ],
	[ -4,  0, 'decoration-empty', 0 ],  [ -3,  0, 'decoration-empty', 0 ],
	[ -1,  0, 'decoration-empty', 0 ],
	[  1,  0, 'decoration-forest', 0 ],
	[  2,  0, 'decoration-forest', 0 ],
	[ -8,  1, 'decoration-forest', 0 ], [ -7,  1, 'decoration-forest', 0 ],
	[ -6,  1, 'decoration-forest', 0 ], [ -5,  1, 'decoration-forest', 0 ],
	[ -4,  1, 'decoration-empty', 0 ],  [ -3,  1, 'decoration-empty', 0 ],
	[  1,  1, 'decoration-forest', 0 ],
	[  2,  1, 'decoration-forest', 0 ],
	[ -8,  2, 'decoration-forest', 0 ], [ -7,  2, 'decoration-forest', 0 ],
	[ -6,  2, 'decoration-forest', 0 ], [ -5,  2, 'decoration-forest', 0 ],
	[ -4,  2, 'decoration-empty', 0 ],  [ -3,  2, 'decoration-empty', 0 ],
	[  1,  2, 'decoration-forest', 0 ],
	[  2,  2, 'decoration-forest', 0 ],
	[ -8,  3, 'decoration-forest', 0 ], [ -7,  3, 'decoration-forest', 0 ],
	[ -6,  3, 'decoration-forest', 0 ], [ -5,  3, 'decoration-forest', 0 ],
	[ -4,  3, 'decoration-forest', 0 ], [ -3,  3, 'decoration-forest', 0 ],
	[ -2,  3, 'decoration-forest', 0 ], [ -1,  3, 'decoration-forest', 0 ],
	[  0,  3, 'decoration-forest', 0 ], [  1,  3, 'decoration-forest', 0 ],
	[  2,  3, 'decoration-forest', 0 ],
	[ -8,  4, 'decoration-forest', 0 ], [ -7,  4, 'decoration-forest', 0 ],
	[ -6,  4, 'decoration-forest', 0 ], [ -5,  4, 'decoration-forest', 0 ],
	[ -4,  4, 'decoration-forest', 0 ], [ -3,  4, 'decoration-forest', 0 ],
	[ -2,  4, 'decoration-forest', 0 ], [ -1,  4, 'decoration-forest', 0 ],
	[  0,  4, 'decoration-forest', 0 ], [  1,  4, 'decoration-forest', 0 ],
	[  2,  4, 'decoration-forest', 0 ],
];

const NPC_TRUCKS = [
	[ 'vehicle-truck-green',  -3.51, -0.01,  12.70,  98.0 ],
	[ 'vehicle-truck-purple', -23.78, -0.14, -13.56,   0.0 ],
	[ 'vehicle-truck-red',    -1.36, -0.15, -23.80, 155.9 ],
];


export function computePoolPresetWaterCells( cells = TRACK_CELLS, extras = null ) {

	const roadCells = [];
	const occupied = new Set();
	const addOccupied = ( gx, gz ) => {
		if ( Number.isFinite( Number( gx ) ) && Number.isFinite( Number( gz ) ) ) occupied.add( `${ Number( gx ) },${ Number( gz ) }` );
	};
	const addRoad = ( gx, gz ) => {
		if ( ! Number.isFinite( Number( gx ) ) || ! Number.isFinite( Number( gz ) ) ) return;
		const nx = Number( gx );
		const nz = Number( gz );
		roadCells.push( [ nx, nz ] );
		addOccupied( nx, nz );
	};

	for ( const [ gx, gz ] of ( Array.isArray( cells ) && cells.length ? cells : TRACK_CELLS ) ) addRoad( gx, gz );
	const blockerLists = [ extras?.bumps, extras?.poles, extras?.cubes, extras?.walls, extras?.jumps, extras?.movingObstacles, extras?.elevated, extras?.surfaces, extras?.decorations, extras?.magnets, extras?.arcLinks ];
	for ( const list of blockerLists ) {
		if ( ! Array.isArray( list ) ) continue;
		for ( const entry of list ) {
			if ( ! Array.isArray( entry ) ) continue;
			addOccupied( entry[ 0 ], entry[ 1 ] );
			roadCells.push( [ Number( entry[ 0 ] ), Number( entry[ 1 ] ) ] );
		}
	}

	if ( roadCells.length === 0 ) addRoad( 0, 0 );
	let minGx = Infinity, maxGx = - Infinity, minGz = Infinity, maxGz = - Infinity;
	for ( const [ gx, gz ] of roadCells ) {
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		minGx = Math.min( minGx, gx );
		maxGx = Math.max( maxGx, gx );
		minGz = Math.min( minGz, gz );
		maxGz = Math.max( maxGz, gz );
	}
	const pad = 12;
	const water = [];
	for ( let gx = minGx - pad; gx <= maxGx + pad; gx ++ ) {
		for ( let gz = minGz - pad; gz <= maxGz + pad; gz ++ ) {
			if ( ! occupied.has( `${ gx },${ gz }` ) ) water.push( [ gx, gz ] );
		}
	}
	return water;

}

export function buildTrack( scene, models, customCells, extras = null ) {

	const trackGroup = new THREE.Group();
	trackGroup.position.y = -0.5;

	const trackPieceGroup = new THREE.Group();
	const decoGroup = new THREE.Group();

	const cells = customCells || TRACK_CELLS;
	const waterCellsForDeco = extras && Array.isArray( extras.water ) ? extras.water : [];

	for ( const [ gx, gz, key, orient ] of cells ) {

		const piece = placePiece( models, key, gx, gz, orient );
		if ( piece ) trackPieceGroup.add( piece );

	}

	if ( extras ) {

		const bumpCells = Array.isArray( extras.bumps ) ? extras.bumps : [];
		const boostCells = Array.isArray( extras.boosts ) ? extras.boosts : [];
		const jumpCells = Array.isArray( extras.jumps ) ? extras.jumps : [];
		const cubeCells = Array.isArray( extras.cubes ) ? extras.cubes : [];
		const wallCells = Array.isArray( extras.walls ) ? extras.walls : [];
		const poleCells = Array.isArray( extras.poles ) ? extras.poles : [];
		const elevatedCells = Array.isArray( extras.elevated ) ? extras.elevated : [];
		const decorations = Array.isArray( extras.decorations ) ? extras.decorations : [];
		const surfaces = Array.isArray( extras.surfaces ) ? extras.surfaces : [];
		const magnets = Array.isArray( extras.magnets ) ? extras.magnets : [];
		const arcLinks = Array.isArray( extras.arcLinks ) ? extras.arcLinks : [];
		const waterCells = Array.isArray( extras.water ) ? extras.water : [];
		const poolSlopeCells = Array.isArray( extras.poolSlopes ) ? extras.poolSlopes : [];
		const customSurfaces = extras?.customSurfaces && typeof extras.customSurfaces === 'object' ? extras.customSurfaces : {};
		const customPads = extras?.customPads && typeof extras.customPads === 'object' ? extras.customPads : {};
		const poolVisuals = normalizePoolVisuals( extras );
		const elevatedMap = new Map();
		for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedCells ) {

			if ( ! ELEVATED_TYPES.has( elevatedType ) ) continue;
			elevatedMap.set( `${ gx },${ gz }`, normalizeElevatedEntry( elevatedType, orient ) );

		}
		// Cells covered by a slope block (slope-up / slope-down). Trees must
		// not spawn under a slope, so both auto-forest and hand-placed
		// decorations skip these cells.
		const slopeCells = new Set();
		for ( const [ gx, gz, elevatedType ] of elevatedCells ) {

			if ( elevatedType === 'slope-up' || elevatedType === 'slope-down' ) {

				slopeCells.add( `${ Number( gx ) },${ Number( gz ) }` );

			}

		}

		const waterSet = new Set( waterCells.map( ( [ gx, gz ] ) => `${ gx },${ gz }` ) );
		const isWaterCell = ( gx, gz ) => waterSet.has( `${ gx },${ gz }` );
		// Build a quick lookup of pool slope orientation per cell for edge removal.
		const poolSlopeOrientByCell = new Map();
		for ( const [ gx, gz, orient = 0 ] of poolSlopeCells ) {

			poolSlopeOrientByCell.set( `${ Number( gx ) },${ Number( gz ) }`, orient || 0 );

		}
		if ( waterCells.length > 0 ) {

			let minWaterGx = Infinity, maxWaterGx = - Infinity, minWaterGz = Infinity, maxWaterGz = - Infinity;
			for ( const [ gx, gz ] of waterCells ) {

				minWaterGx = Math.min( minWaterGx, gx );
				maxWaterGx = Math.max( maxWaterGx, gx + 1 );
				minWaterGz = Math.min( minWaterGz, gz );
				maxWaterGz = Math.max( maxWaterGz, gz + 1 );

			}
			const waterWidth = Math.max( CELL_RAW, ( maxWaterGx - minWaterGx + 2 ) * CELL_RAW );
			const waterDepth = Math.max( CELL_RAW, ( maxWaterGz - minWaterGz + 2 ) * CELL_RAW );
			const waterPlane = new THREE.Mesh(
				new THREE.PlaneGeometry( waterWidth, waterDepth ),
				createRepositoryWaterMaterial( poolVisuals )
			);
			waterPlane.rotation.x = - Math.PI / 2;
			waterPlane.position.set( ( ( minWaterGx + maxWaterGx ) * 0.5 ) * CELL_RAW, 0.32, ( ( minWaterGz + maxWaterGz ) * 0.5 ) * CELL_RAW );
			waterPlane.userData.waterSurface = true;
			waterPlane.onBeforeRender = () => { waterPlane.material.uniforms.time.value = performance.now() * 0.001; };
			trackPieceGroup.add( waterPlane );

		}
		for ( const [ gx, gz ] of waterCells ) {

			const pool = new THREE.Group();
			pool.position.set( ( gx + 0.5 ) * CELL_RAW, 0, ( gz + 0.5 ) * CELL_RAW );
			const floor = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW, CELL_RAW * 0.04, CELL_RAW ),
				new THREE.MeshStandardMaterial( { color: 0x31433e, roughness: 0.95, metalness: 0.0 } )
			);
			floor.position.y = - WATER_DEPTH;
			floor.receiveShadow = true;
			pool.add( floor );
			// If this pool tile has a pool slope, omit the wall + edge lip on the
			// exit side (where the ramp's high end meets ground level).
			const slopeOrient = poolSlopeOrientByCell.get( `${ gx },${ gz }` );
			let exitSide = null;
			if ( slopeOrient !== undefined ) {
				const rad = THREE.MathUtils.degToRad( ORIENT_DEG[ slopeOrient ] ?? 0 );
				// High end is opposite the low end (+z at orient 0).
				exitSide = `${ - Math.round( Math.sin( rad ) ) },${ - Math.round( Math.cos( rad ) ) }`;
			}
			const sides = [
				{ dx: 0, dz: - 1, x: 0, z: - CELL_RAW * 0.5, ry: 0 },
				{ dx: 1, dz: 0, x: CELL_RAW * 0.5, z: 0, ry: Math.PI / 2 },
				{ dx: 0, dz: 1, x: 0, z: CELL_RAW * 0.5, ry: 0 },
				{ dx: - 1, dz: 0, x: - CELL_RAW * 0.5, z: 0, ry: Math.PI / 2 },
			];
			for ( const side of sides ) {
				if ( isWaterCell( gx + side.dx, gz + side.dz ) ) continue;
				if ( exitSide === `${ side.dx },${ side.dz }` ) continue;
				const wall = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, WATER_WALL_HEIGHT, CELL_RAW * 0.08 ), new THREE.MeshStandardMaterial( { color: 0x20312e, roughness: 0.9, metalness: 0.0 } ) );
				wall.position.set( side.x, 0.5 - WATER_WALL_HEIGHT * 0.5, side.z );
				wall.rotation.y = side.ry;
				wall.castShadow = true;
				wall.receiveShadow = true;
				pool.add( wall );
				const edge = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, CELL_RAW * 0.035, CELL_RAW * 0.09 ), new THREE.MeshStandardMaterial( { color: poolVisuals.edgeColor, emissive: poolVisuals.edgeColor, emissiveIntensity: 0.28, roughness: 0.4 } ) );
				edge.position.set( side.x, 0.515, side.z );
				edge.rotation.y = side.ry;
				pool.add( edge );
			}
			trackPieceGroup.add( pool );

		}

		// Pool slope: the normal elev-track-slope GLB placed at ground/block
		// level facing the slope's orient (no 180 flip, no elevation offset).
		for ( const [ gxRaw, gzRaw, orient = 0 ] of poolSlopeCells ) {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			const slopeSrc = models[ 'elev-track-slope' ];
			if ( ! slopeSrc ) continue;
			const slope = slopeSrc.clone();
			slope.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + VISUAL_HEIGHT_OFFSET - 5, ( gz + 0.5 ) * CELL_RAW );
			slope.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
			slope.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = true; c.receiveShadow = true; } } );
			trackPieceGroup.add( slope );

		}

		for ( const [ gx, gz ] of bumpCells ) {

			const piece = placePiece( models, 'track-bump', gx, gz, 0 );
			if ( piece ) {

				const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
				piece.position.y += yOffset;
				trackPieceGroup.add( piece );

			}

		}

		for ( const [ gx, gz ] of poleCells ) {

			const pole = new THREE.Mesh(
				new THREE.CylinderGeometry( POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 16 ),
				new THREE.MeshStandardMaterial( { color: 0x8c8f96, roughness: 0.65, metalness: 0.15 } )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			pole.position.set( ( gx + 0.5 ) * CELL_RAW, ( POLE_HEIGHT * 0.5 ) - 0.06 + yOffset, ( gz + 0.5 ) * CELL_RAW );
			pole.castShadow = true;
			pole.receiveShadow = true;
			trackPieceGroup.add( pole );

		}

		for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedCells ) {

			if ( ! ELEVATED_TYPES.has( elevatedType ) ) continue;
			const piece = cloneElevatedPiece( models, elevatedType, orient, gx, gz );
			if ( piece ) trackPieceGroup.add( piece );
			// Black support box removed — elevated models have built-in supports

		}

		for ( const [ gx, gz ] of cubeCells ) {

			const cube = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW * 0.16, CELL_RAW * 0.16, CELL_RAW * 0.16 ),
				new THREE.MeshStandardMaterial( { color: 0x9da5b1, roughness: 0.65, metalness: 0.08 } )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			cube.position.set( ( gx + 0.5 ) * CELL_RAW, ( CELL_RAW * 0.08 ) - 0.06 + yOffset, ( gz + 0.5 ) * CELL_RAW );
			cube.castShadow = true;
			cube.receiveShadow = true;
			trackPieceGroup.add( cube );

		}

		for ( const [ gxRaw, gzRaw, yGridRaw, variant ] of magnets ) {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const magnetKind = String( variant );
			const isRed = magnetKind === 'red';
			const isGrapple = magnetKind === 'grapple';
			const magnet = new THREE.Mesh(
				isGrapple
					? new THREE.SphereGeometry( MAGNET_HALF_SIZE * 0.95, 14, 10 )
					: new THREE.BoxGeometry( MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2 ),
				new THREE.MeshStandardMaterial( {
					color: isGrapple ? 0xb48cff : ( isRed ? 0xff5d5d : 0x4f96ff ),
					emissive: isGrapple ? 0x8a5cff : ( isRed ? 0x7a1111 : 0x1b45a9 ),
					emissiveIntensity: 0.24,
					roughness: 0.5,
					metalness: 0.28,
				} )
			);
			magnet.position.set( ( gx + 0.5 ) * CELL_RAW, MAGNET_BASE_Y + yGrid * CELL_RAW, ( gz + 0.5 ) * CELL_RAW );
			magnet.castShadow = true;
			magnet.receiveShadow = true;
			trackPieceGroup.add( magnet );

		}

		for ( const [ gxRaw, gzRaw, yGridRaw, variant ] of arcLinks ) {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const arcVariant = String( variant );
			const colors = arcVariant === 'orange'
				? { color: 0xffae52, emissive: 0x8c4b00 }
				: ( arcVariant === 'portal-purple' || arcVariant === 'purple'
					? { color: 0xb468ff, emissive: 0x4a1677 }
					: ( arcVariant === 'portal-yellow' || arcVariant === 'yellow'
						? { color: 0xffef4a, emissive: 0x8f7b00 }
						: { color: 0x6dff6d, emissive: 0x1f6d1f } ) );
			const arcNode = new THREE.Mesh(
				new THREE.BoxGeometry( MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2, MAGNET_HALF_SIZE * 2 ),
				new THREE.MeshStandardMaterial( {
					color: colors.color,
					emissive: colors.emissive,
					emissiveIntensity: 0.24,
					roughness: 0.5,
					metalness: 0.28,
				} )
			);
			arcNode.position.set( ( gx + 0.5 ) * CELL_RAW, MAGNET_BASE_Y + yGrid * CELL_RAW, ( gz + 0.5 ) * CELL_RAW );
			arcNode.castShadow = true;
			arcNode.receiveShadow = true;
			trackPieceGroup.add( arcNode );

		}

		for ( const [ gx, gz, orient = 0 ] of wallCells ) {

			const wall = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW * 0.62, CELL_RAW * 0.15, CELL_RAW * 0.08 ),
				new THREE.MeshStandardMaterial( { color: 0x868a90, roughness: 0.75, metalness: 0.05 } )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			wall.position.set( ( gx + 0.5 ) * CELL_RAW, ( CELL_RAW * 0.075 ) - 0.06 + yOffset, ( gz + 0.5 ) * CELL_RAW );
			wall.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
			wall.castShadow = true;
			wall.receiveShadow = true;
			trackPieceGroup.add( wall );

		}

		for ( const [ gx, gz ] of boostCells ) {

			const piece = placePiece( models, 'track-bump', gx, gz, 0 );
			if ( piece ) {

				piece.traverse( ( c ) => {

					if ( c.isMesh ) {

						c.material = c.material.clone();
						c.material.color = new THREE.Color( 0xff8a00 );
						c.material.emissive = new THREE.Color( 0xff4d00 );
						c.material.emissiveIntensity = 0.6;

					}

				} );
				const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
				piece.position.y += yOffset;
				trackPieceGroup.add( piece );

			}

		}

		for ( const [ gx, gz, orient = 0 ] of jumpCells ) {

			const jump = new THREE.Mesh(
				new THREE.BoxGeometry( JUMP_RAMP_SIZE, JUMP_RAMP_DEPTH, JUMP_RAMP_SIZE ),
				new THREE.MeshStandardMaterial( {
					color: 0x7f6a58,
					roughness: 0.85,
					metalness: 0.02,
				} )
			);
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			jump.position.set( ( gx + 0.5 ) * CELL_RAW, JUMP_RAMP_Y + VISUAL_HEIGHT_OFFSET + yOffset, ( gz + 0.5 ) * CELL_RAW );
			jump.rotation.order = 'YXZ';
			jump.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
			jump.rotation.x = - JUMP_RAMP_ANGLE;
			jump.castShadow = true;
			jump.receiveShadow = true;
			trackPieceGroup.add( jump );

		}

		for ( const [ gx, gz, key, orient ] of decorations ) {

			if ( waterSet.has( `${ gx },${ gz }` ) ) continue;
			// Don't place a decoration tree under a slope block.
			if ( slopeCells.has( `${ Number( gx ) },${ Number( gz ) }` ) ) continue;
			const piece = placePiece( models, key, gx, gz, orient || 0 );
			if ( piece ) decoGroup.add( piece );

		}

		for ( const [ gx, gz, surfaceType ] of surfaces ) {

			const visual = getSurfaceVisual( surfaceType, customSurfaces, customPads );
			const isPad = String( surfaceType || '' ).startsWith( 'pad-' );
			const geometry = isPad
				? new THREE.CircleGeometry( CELL_RAW * 0.39, 24 )
				: new THREE.PlaneGeometry( CELL_RAW * 0.78, CELL_RAW * 0.78 );
			const patch = new THREE.Mesh(
				geometry,
				new THREE.MeshStandardMaterial( {
					color: visual.color,
					emissive: visual.emissive,
					emissiveIntensity: 0.2,
					transparent: true,
					opacity: 0.58,
					metalness: visual.metalness,
					roughness: visual.roughness
				} )
			);
			patch.rotation.x = - Math.PI / 2;
			const yOffset = getOverlayHeightOffset( elevatedMap.get( `${ gx },${ gz }` ) );
			patch.position.set( ( gx + 0.5 ) * CELL_RAW, 0.505 + VISUAL_HEIGHT_OFFSET + yOffset, ( gz + 0.5 ) * CELL_RAW );
			patch.receiveShadow = true;
			trackPieceGroup.add( patch );

		}

	}

	if ( ! customCells ) {

		// Place hand-authored decorations for the default track
		for ( const [ gx, gz, key, orient ] of DECO_CELLS ) {

			const piece = placePiece( models, key, gx, gz, orient );
			if ( piece ) decoGroup.add( piece );

		}

	}

	{

		// Auto-generate decorations to fill any gaps
		const occupied = new Set();
		const treeBlocked = new Set();
		let minX = Infinity, maxX = - Infinity;
		let minZ = Infinity, maxZ = - Infinity;

		// Helper: mark every integer grid cell whose footprint overlaps a
		// (possibly off-grid) cell's footprint as tree-blocked, and expand
		// the coverage bounds so ground fills all gaps.
		//
		// A cell at (gx, gz) covers (gx, gz) to (gx+1, gz+1).
		// Integer cell (cx, cz) covers (cx, cz) to (cx+1, cz+1).
		// The two footprints overlap (with non-zero area) when:
		//   gx < cx+1  AND  cx < gx+1   →   floor(gx) <= cx <= ceil(gx)
		//
		// For on-grid cells (integer gx): floor(gx) == ceil(gx), so exactly
		// one cell matches (itself) — same as before.
		// For off-grid cells (fractional gx): the piece straddles a grid seam,
		// so BOTH neighbouring integer cells overlap it and must be cleared of
		// trees. (The old center-based math missed the far-side cell, leaving
		// trees poking through off-grid roads.)
		function blockCellForTrees( gx, gz, markOccupied ) {
			gx = Number( gx );
			gz = Number( gz );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) return;

			minX = Math.min( minX, gx );
			maxX = Math.max( maxX, gx );
			minZ = Math.min( minZ, gz );
			maxZ = Math.max( maxZ, gz );

			if ( markOccupied ) occupied.add( gx + ',' + gz );

			const minBlockX = Math.floor( gx );
			const maxBlockX = Math.ceil( gx );
			const minBlockZ = Math.floor( gz );
			const maxBlockZ = Math.ceil( gz );
			for ( let bx = minBlockX; bx <= maxBlockX; bx ++ ) {
				for ( let bz = minBlockZ; bz <= maxBlockZ; bz ++ ) {
					treeBlocked.add( bx + ',' + bz );
				}
			}
		}

		// Track cells + water cells: occupied (skip ground) + tree-blocked
		for ( const [ gx, gz ] of [ ...cells, ...waterCellsForDeco ] ) {
			blockCellForTrees( gx, gz, true );
		}

		// Solid extras that should erase trees beneath them (but NOT ramps,
		// bumps, or other see-through elements per user spec). Tree-blocked
		// only — ground still placed underneath to avoid visual holes.
		if ( extras ) {
			// Elevated pieces (including slope-up / slope-down, the "slope"
			// block) block trees beneath them, same as normal solid blocks.
			if ( Array.isArray( extras.elevated ) ) {
				for ( const entry of extras.elevated ) {
					if ( ! Array.isArray( entry ) ) continue;
					blockCellForTrees( entry[ 0 ], entry[ 1 ], false );
				}
			}
			// Walls, cubes, moving obstacles: solid → erase trees.
			// Surfaces, water: replace ground → erase trees.
			const solidLists = [
				extras.walls, extras.cubes, extras.surfaces,
				extras.movingObstacles, extras.water, extras.customPool,
			];
			for ( const list of solidLists ) {
				if ( ! Array.isArray( list ) ) continue;
				for ( const entry of list ) {
					if ( ! Array.isArray( entry ) ) continue;
					blockCellForTrees( entry[ 0 ], entry[ 1 ], false );
				}
			}
			// Buildings are solid too — they erase trees beneath them using the exact same
			// off-grid-aware footprint math as the blocks above. (Other decorations — tents, trees,
			// bushes — stay see-through.)
			if ( Array.isArray( extras.decorations ) ) {
				for ( const entry of extras.decorations ) {
					if ( ! Array.isArray( entry ) ) continue;
					const decoKey = String( entry[ 2 ] || '' );
					if ( decoKey.startsWith( 'building-' ) ) blockCellForTrees( entry[ 0 ], entry[ 1 ], false );
				}
			}
			// NOT included (trees can go through these):
			//   bumps, boosts, jumps, poles, magnets, arcLinks, decorations
		}

		// Also mark existing decoration cells as occupied
		if ( ! customCells ) {

			for ( const [ gx, gz ] of DECO_CELLS ) {

				occupied.add( gx + ',' + gz );
				minX = Math.min( minX, gx );
				maxX = Math.max( maxX, gx );
				minZ = Math.min( minZ, gz );
				maxZ = Math.max( maxZ, gz );

			}

		}

		const pad = 3;
		const emptyPositions = [];
		const grassPositions = [];   // cells cleared of trees by a road/wall/etc. footprint
		const forestPositions = [];

		// Simple hash for deterministic pseudo-random placement
		function hash( gx, gz ) {

			let h = gx * 374761393 + gz * 668265263;
			h = ( h ^ ( h >> 13 ) ) * 1274126177;
			return ( h ^ ( h >> 16 ) ) >>> 0;

		}

		const startX = Math.floor( minX - pad );
		const endX = Math.ceil( maxX + pad );
		const startZ = Math.floor( minZ - pad );
		const endZ = Math.ceil( maxZ + pad );

		for ( let gz = startZ; gz <= endZ; gz ++ ) {

			for ( let gx = startX; gx <= endX; gx ++ ) {

				if ( occupied.has( gx + ',' + gz ) ) continue;

				const distX = gx < minX ? minX - gx : gx > maxX ? gx - maxX : 0;
				const distZ = gz < minZ ? minZ - gz : gz > maxZ ? gz - maxZ : 0;
				const dist = Math.max( distX, distZ );

				const x = ( gx + 0.5 ) * CELL_RAW;
				const z = ( gz + 0.5 ) * CELL_RAW;

				if ( treeBlocked.has( gx + ',' + gz ) ) {

					grassPositions.push( x, z );
					continue;

				}

				if ( dist <= NO_DECO_BUFFER_CELLS + 1 ) {

					emptyPositions.push( x, z );

				} else {

					forestPositions.push( x, z );

				}

			}

		}

		function createInstances( src, positions, randomY ) {

			if ( positions.length === 0 || ! src ) return;

			const count = positions.length / 2;

			src.traverse( ( child ) => {

				if ( ! child.isMesh ) return;

				const inst = new THREE.InstancedMesh( child.geometry, child.material, count );
				inst.castShadow = true;
				inst.receiveShadow = true;

				for ( let i = 0; i < count; i ++ ) {

					_dummy.position.set( positions[ i * 2 ], 0.5, positions[ i * 2 + 1 ] );
					// Per-instance Y rotation for 3D trees/bushes (decoration-forest +
					// decoration-empty) breaks up the repetitive grid pattern. Limited to
					// 90° intervals (0, 90, 180, 270) so nothing looks oddly tilted.
					// Stable hash of cell coords → same angle every reload (no reshuffle).
					// Flat grass quads (empty-deco-grass) keep rotation 0.
					if ( randomY ) {
						const px = positions[ i * 2 ];
						const pz = positions[ i * 2 + 1 ];
						const frac = Math.sin( px * 12.9898 + pz * 78.233 ) * 43758.5453 % 1;
						const idx = Math.floor( Math.abs( frac ) * 4 ) % 4;
						_dummy.rotation.y = idx * ( Math.PI / 2 );
					} else {
						_dummy.rotation.y = 0;
					}
					_dummy.updateMatrix();
					inst.setMatrixAt( i, _dummy.matrix );

				}

				decoGroup.add( inst );

			} );

		}

		createInstances( models[ 'decoration-empty' ], emptyPositions, true );
		createInstances( models[ 'empty-deco-grass' ], grassPositions );
		createInstances( models[ 'decoration-forest' ], forestPositions, true );

	}

	trackGroup.add( trackPieceGroup );
	trackGroup.add( decoGroup );

	trackGroup.scale.setScalar( 0.75 );
	scene.add( trackGroup );

	trackGroup.updateMatrixWorld( true );

	trackGroup.traverse( ( child ) => {

		if ( child.isMesh ) {

			child.castShadow = true;
			child.receiveShadow = true;

		}

	} );

	if ( ! customCells ) {

		for ( const [ key, x, y, z, rotDeg ] of NPC_TRUCKS ) {

			const src = models[ key ];
			if ( ! src ) continue;

			const npc = src.clone();
			npc.position.set( x, y, z );
			npc.rotation.y = THREE.MathUtils.degToRad( rotDeg + 180 );
			npc.traverse( ( c ) => {

				if ( c.isMesh ) {

					c.castShadow = true;
					c.receiveShadow = true;

				}

			} );
			trackGroup.add( npc );

		}

	}

	return trackGroup;

}

export function placePiece( models, key, gx, gz, orient ) {

	const modelKey = key === 'track-checkpoint' || key === 'track-start' || key === 'track-start-finish' ? 'track-finish' : key;
	const src = models[ modelKey ];
	if ( ! src ) return null;

	const piece = src.clone();
	const yOffset = ( String( key || '' ).startsWith( 'decoration-' ) || String( key || '' ).startsWith( 'building-' ) ) ? DECORATION_HEIGHT_OFFSET : VISUAL_HEIGHT_OFFSET;
	piece.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + yOffset, ( gz + 0.5 ) * CELL_RAW );

	const deg = ORIENT_DEG[ orient ] ?? 0;
	piece.rotation.y = THREE.MathUtils.degToRad( deg );
        // Start/finish blocks no longer tinted (checkpoint textures read cleanly).

	return piece;

}

// ─── Track Codec ──────────────────────────────────────────

const TYPE_NAMES = [ 'track-straight', 'track-corner', 'track-checkpoint', 'track-finish' ];
const TYPE_INDEX = {};
for ( let i = 0; i < TYPE_NAMES.length; i ++ ) TYPE_INDEX[ TYPE_NAMES[ i ] ] = i;

const ORIENT_TO_GODOT = [ 0, 16, 10, 22 ];
const GODOT_TO_ORIENT = { 0: 0, 16: 1, 10: 2, 22: 3 };

export { TYPE_NAMES };

export function encodeCells( cells ) {

	const supportsCompactCodec = cells.every( ( cell ) => {

		const [ gx, gz, name ] = cell;
		const normalizedName = name === 'track-bump' ? 'track-checkpoint' : name;
		return Number.isInteger( gx )
			&& Number.isInteger( gz )
			&& gx >= - 128 && gx <= 127
			&& gz >= - 128 && gz <= 127
			&& TYPE_INDEX[ normalizedName ] !== undefined;

	} );

	if ( supportsCompactCodec ) {

		const bytes = new Uint8Array( cells.length * 3 );

		for ( let i = 0; i < cells.length; i ++ ) {

			const [ gx, gz, name, godotOrient ] = cells[ i ];
			const normalizedName = name === 'track-bump' ? 'track-checkpoint' : name;
			const ti = TYPE_INDEX[ normalizedName ] ?? 0;
			const oi = GODOT_TO_ORIENT[ godotOrient ] ?? 0;

			bytes[ i * 3 ] = gx + 128;
			bytes[ i * 3 + 1 ] = gz + 128;
			bytes[ i * 3 + 2 ] = ( ti << 2 ) | oi;

		}

		return bytesToBase64url( bytes );

	}

	const payload = JSON.stringify( { v: 2, cells } );
	const encoded = btoa( unescape( encodeURIComponent( payload ) ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );
	return `v2.${ encoded }`;

}

export function decodeCells( str ) {

	if ( str.startsWith( 'v2.' ) ) {

		const raw = str.slice( 3 ).replace( /-/g, '+' ).replace( /_/g, '/' );
		const padded = raw + '==='.slice( ( raw.length + 3 ) % 4 );
		const payload = decodeURIComponent( escape( atob( padded ) ) );
		const parsed = JSON.parse( payload );
		const entries = Array.isArray( parsed?.cells ) ? parsed.cells : [];
		return entries
			.filter( ( cell ) => Array.isArray( cell ) && cell.length >= 4 )
			.map( ( [ gx, gz, name, orient ] ) => [ Number( gx ), Number( gz ), name, orient ] );

	}

	const bytes = base64urlToBytes( str );
	const cells = [];

	for ( let i = 0; i + 2 < bytes.length; i += 3 ) {

		const gx = bytes[ i ] - 128;
		const gz = bytes[ i + 1 ] - 128;
		const packed = bytes[ i + 2 ];
		const ti = ( packed >> 2 ) & 0x03;
		const oi = packed & 0x03;

		cells.push( [ gx, gz, TYPE_NAMES[ ti ], ORIENT_TO_GODOT[ oi ] ] );

	}

	return cells;

}

export function computeSpawnPosition( cells ) {

	let cell = cells[ 0 ];

	for ( const c of cells ) {

		if ( c[ 2 ] === 'track-start' ) {

			cell = c;
			break;

		}

	}

	if ( cell?.[ 2 ] !== 'track-start' ) {

		for ( const c of cells ) {

			if ( c[ 2 ] === 'track-start-finish' ) {

				cell = c;
				break;

			}

		}

	}

	if ( cell?.[ 2 ] !== 'track-start' && cell?.[ 2 ] !== 'track-start-finish' ) {

		for ( const c of cells ) {

			if ( c[ 2 ] === 'track-finish' ) {

				cell = c;
				break;

			}

		}

	}

	if ( ! cell ) return { position: [ 3.5, 0.5, 5 ], angle: 0 };

	const gx = cell[ 0 ];
	const gz = cell[ 1 ];
	const x = ( gx + 0.5 ) * CELL_RAW * GRID_SCALE;
	const z = ( gz + 0.5 ) * CELL_RAW * GRID_SCALE;

	const orient = cell[ 3 ];
	const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );

	return { position: [ x, 0.5, z ], angle };

}

export function computeTrackBounds( cells ) {

	if ( ! cells || cells.length === 0 ) return { centerX: 0, centerZ: 0, halfWidth: 30, halfDepth: 30 };

	let minX = Infinity, maxX = - Infinity;
	let minZ = Infinity, maxZ = - Infinity;

	for ( const [ gx, gz ] of cells ) {

		minX = Math.min( minX, gx );
		maxX = Math.max( maxX, gx );
		minZ = Math.min( minZ, gz );
		maxZ = Math.max( maxZ, gz );

	}

	const S = CELL_RAW * GRID_SCALE;
	const centerX = ( minX + maxX + 1 ) / 2 * S;
	const centerZ = ( minZ + maxZ + 1 ) / 2 * S;
	const halfWidth = ( maxX - minX + 1 ) / 2 * S + S;
	const halfDepth = ( maxZ - minZ + 1 ) / 2 * S + S;

	return { centerX, centerZ, halfWidth, halfDepth };

}

function bytesToBase64url( bytes ) {

	let binary = '';
	for ( let i = 0; i < bytes.length; i ++ ) binary += String.fromCharCode( bytes[ i ] );

	return btoa( binary ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );

}

function base64urlToBytes( str ) {

	const base64 = str.replace( /-/g, '+' ).replace( /_/g, '/' );
	const binary = atob( base64 );
	const bytes = new Uint8Array( binary.length );
	for ( let i = 0; i < binary.length; i ++ ) bytes[ i ] = binary.charCodeAt( i );

	return bytes;

}


