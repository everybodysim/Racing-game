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
const ELEVATED_HEIGHT = CELL_RAW * 0.5;
const SUPPORT_HEIGHT = CELL_RAW * 0.5;
const SUPPORT_COLOR = 0x0d0d0d;
const SLOPE_ANGLE = Math.atan2( ELEVATED_HEIGHT, CELL_RAW );
const SUPPORT_SINK = 0.03;
const SLOPE_VISUAL_DROP = CELL_RAW * 0.04;
const ORIENT_180 = { 0: 10, 10: 0, 16: 22, 22: 16 };

const ELEVATED_TYPES = new Set( [ 'elevated-straight', 'elevated-corner', 'elevated-checkpoint', 'slope-up', 'slope-down' ] );

function getSurfaceVisual( surfaceType, customSurfaces = null ) {

	switch ( surfaceType ) {

		case 'surface-ice': return { color: 0x7ad8ff, emissive: 0x1f6f8a, metalness: 0.2, roughness: 0.15 };
		case 'surface-boost': return { color: 0xff4b4b, emissive: 0xc1121f, metalness: 0.0, roughness: 0.9 };
		case 'surface-sand': return { color: 0xd7b46a, emissive: 0x6f4f22, metalness: 0.0, roughness: 1.0 };
		case 'surface-bounce': return { color: 0xbaff7a, emissive: 0x2f8f2f, metalness: 0.0, roughness: 0.75 };
		case 'surface-kick-l': return { color: 0xc683ff, emissive: 0x54208f, metalness: 0.0, roughness: 0.8 };
		case 'surface-kick-r': return { color: 0xff83d0, emissive: 0x8f2054, metalness: 0.0, roughness: 0.8 };
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
	if ( type === 'elevated-straight' || type === 'slope-up' || type === 'slope-down' ) modelKey = 'track-straight';
	else if ( type === 'elevated-corner' ) modelKey = 'track-corner';
	else if ( type === 'elevated-checkpoint' ) modelKey = 'track-finish';
	if ( ! modelKey || ! models[ modelKey ] ) return null;

	const piece = models[ modelKey ].clone();
	const yAdjust = type === 'slope-up' ? - SLOPE_VISUAL_DROP : 0;
	piece.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + VISUAL_HEIGHT_OFFSET + ELEVATED_HEIGHT + yAdjust, ( gz + 0.5 ) * CELL_RAW );
	const deg = ORIENT_DEG[ orient ] ?? 0;
	piece.rotation.y = THREE.MathUtils.degToRad( deg );
	if ( type === 'slope-up' || type === 'slope-down' ) {

		piece.rotation.order = 'YXZ';
		piece.rotation.x = type === 'slope-up' ? - SLOPE_ANGLE : SLOPE_ANGLE;
		piece.scale.z = 1.08;

	}

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
	[ -2, -3, 'track-straight', 22 ],
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

export function buildTrack( scene, models, customCells, extras = null ) {

	const trackGroup = new THREE.Group();
	trackGroup.position.y = -0.5;

	const trackPieceGroup = new THREE.Group();
	const decoGroup = new THREE.Group();

	const cells = customCells || TRACK_CELLS;

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
		const customSurfaces = extras?.customSurfaces && typeof extras.customSurfaces === 'object' ? extras.customSurfaces : {};

		for ( const [ gx, gz ] of bumpCells ) {

			const piece = placePiece( models, 'track-bump', gx, gz, 0 );
			if ( piece ) trackPieceGroup.add( piece );

		}

		for ( const [ gx, gz ] of poleCells ) {

			const pole = new THREE.Mesh(
				new THREE.CylinderGeometry( POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 16 ),
				new THREE.MeshStandardMaterial( { color: 0x8c8f96, roughness: 0.65, metalness: 0.15 } )
			);
			pole.position.set( ( gx + 0.5 ) * CELL_RAW, ( POLE_HEIGHT * 0.5 ) - 0.06, ( gz + 0.5 ) * CELL_RAW );
			pole.castShadow = true;
			pole.receiveShadow = true;
			trackPieceGroup.add( pole );

		}

		for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedCells ) {

			if ( ! ELEVATED_TYPES.has( elevatedType ) ) continue;
			const piece = cloneElevatedPiece( models, elevatedType, orient, gx, gz );
			if ( piece ) trackPieceGroup.add( piece );
			trackPieceGroup.add( createElevatedSupport( gx, gz, orient, elevatedType ) );

		}

		for ( const [ gx, gz ] of cubeCells ) {

			const cube = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW * 0.16, CELL_RAW * 0.16, CELL_RAW * 0.16 ),
				new THREE.MeshStandardMaterial( { color: 0x9da5b1, roughness: 0.65, metalness: 0.08 } )
			);
			cube.position.set( ( gx + 0.5 ) * CELL_RAW, ( CELL_RAW * 0.08 ) - 0.06, ( gz + 0.5 ) * CELL_RAW );
			cube.castShadow = true;
			cube.receiveShadow = true;
			trackPieceGroup.add( cube );

		}

		for ( const [ gx, gz, orient = 0 ] of wallCells ) {

			const wall = new THREE.Mesh(
				new THREE.BoxGeometry( CELL_RAW * 0.62, CELL_RAW * 0.15, CELL_RAW * 0.08 ),
				new THREE.MeshStandardMaterial( { color: 0x868a90, roughness: 0.75, metalness: 0.05 } )
			);
			wall.position.set( ( gx + 0.5 ) * CELL_RAW, ( CELL_RAW * 0.075 ) - 0.06, ( gz + 0.5 ) * CELL_RAW );
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
			jump.position.set( ( gx + 0.5 ) * CELL_RAW, JUMP_RAMP_Y + VISUAL_HEIGHT_OFFSET, ( gz + 0.5 ) * CELL_RAW );
			jump.rotation.order = 'YXZ';
			jump.rotation.y = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
			jump.rotation.x = - JUMP_RAMP_ANGLE;
			jump.castShadow = true;
			jump.receiveShadow = true;
			trackPieceGroup.add( jump );

		}

		for ( const [ gx, gz, key, orient ] of decorations ) {

			const piece = placePiece( models, key, gx, gz, orient || 0 );
			if ( piece ) decoGroup.add( piece );

		}

		for ( const [ gx, gz, surfaceType ] of surfaces ) {

			const visual = getSurfaceVisual( surfaceType, customSurfaces );
			const patch = new THREE.Mesh(
				new THREE.PlaneGeometry( CELL_RAW * 0.78, CELL_RAW * 0.78 ),
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
			patch.position.set( ( gx + 0.5 ) * CELL_RAW, 0.505 + VISUAL_HEIGHT_OFFSET, ( gz + 0.5 ) * CELL_RAW );
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

		for ( const [ gx, gz ] of cells ) {

			occupied.add( gx + ',' + gz );
			minX = Math.min( minX, gx );
			maxX = Math.max( maxX, gx );
			minZ = Math.min( minZ, gz );
			maxZ = Math.max( maxZ, gz );

			const minBlockX = Math.floor( gx );
			const maxBlockX = Math.ceil( gx + 1 ) - 1;
			const minBlockZ = Math.floor( gz );
			const maxBlockZ = Math.ceil( gz + 1 ) - 1;
			for ( let bx = minBlockX; bx <= maxBlockX; bx ++ ) {

				for ( let bz = minBlockZ; bz <= maxBlockZ; bz ++ ) treeBlocked.add( bx + ',' + bz );

			}

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

					emptyPositions.push( x, z );
					continue;

				}

				if ( dist <= NO_DECO_BUFFER_CELLS + 1 ) {

					emptyPositions.push( x, z );

				} else {

					forestPositions.push( x, z );

				}

			}

		}

		function createInstances( src, positions ) {

			if ( positions.length === 0 || ! src ) return;

			const count = positions.length / 2;

			src.traverse( ( child ) => {

				if ( ! child.isMesh ) return;

				const inst = new THREE.InstancedMesh( child.geometry, child.material, count );
				inst.castShadow = true;
				inst.receiveShadow = true;

				for ( let i = 0; i < count; i ++ ) {

					_dummy.position.set( positions[ i * 2 ], 0.5, positions[ i * 2 + 1 ] );
					_dummy.updateMatrix();
					inst.setMatrixAt( i, _dummy.matrix );

				}

				decoGroup.add( inst );

			} );

		}

		createInstances( models[ 'decoration-empty' ], emptyPositions );
		createInstances( models[ 'decoration-forest' ], forestPositions );

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
	const yOffset = String( key || '' ).startsWith( 'decoration-' ) ? DECORATION_HEIGHT_OFFSET : VISUAL_HEIGHT_OFFSET;
	piece.position.set( ( gx + 0.5 ) * CELL_RAW, 0.5 + yOffset, ( gz + 0.5 ) * CELL_RAW );

	const deg = ORIENT_DEG[ orient ] ?? 0;
	piece.rotation.y = THREE.MathUtils.degToRad( deg );
	const tintColor = key === 'track-start'
		? new THREE.Color( 0x66cc66 )
		: ( key === 'track-finish' ? new THREE.Color( 0xcc6666 ) : ( key === 'track-start-finish' ? new THREE.Color( 0xcc9955 ) : null ) );
	if ( tintColor ) {

		piece.traverse( ( c ) => {

			if ( ! c.isMesh || ! c.material ) return;
			if ( Array.isArray( c.material ) ) {

				c.material = c.material.map( ( mat ) => {

					const clone = mat.clone();
					if ( clone.color ) clone.color.lerp( tintColor, 0.22 );
					return clone;

				} );
				return;

			}
			const clone = c.material.clone();
			if ( clone.color ) clone.color.lerp( tintColor, 0.22 );
			c.material = clone;

		} );

	}

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
