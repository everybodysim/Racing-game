import * as THREE from 'three';
import { rigidBody, box, sphere, MotionType, MotionQuality } from 'crashcat';
import { TRACK_CELLS, CELL_RAW, ORIENT_DEG, GRID_SCALE } from './Track.js';

const _debugMat = new THREE.MeshBasicMaterial( { color: 0x00ff00, wireframe: true } );

function addDebugBox( group, halfExtents, position, quaternion ) {

	const geo = new THREE.BoxGeometry( halfExtents[ 0 ] * 2, halfExtents[ 1 ] * 2, halfExtents[ 2 ] * 2 );
	const mesh = new THREE.Mesh( geo, _debugMat );
	mesh.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
	if ( quaternion ) mesh.quaternion.set( quaternion[ 0 ], quaternion[ 1 ], quaternion[ 2 ], quaternion[ 3 ] );
	group.add( mesh );

}

function addDebugSphere( group, radius, position ) {

	const geo = new THREE.SphereGeometry( radius, 16, 12 );
	const mesh = new THREE.Mesh( geo, _debugMat );
	mesh.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
	group.add( mesh );

}

export function buildWallColliders( world, debugGroup, customCells, extras = null ) {

	const S = GRID_SCALE;
	const CELL_HALF = CELL_RAW / 2;

	const WALL_HALF_THICK = 0.25;
	const WALL_X = 4.75;
	const WALL_HALF_H = 0.45;

	const wallY = ( 0.5 + WALL_HALF_H ) * S - 0.5;
	const hThick = WALL_HALF_THICK * S;
	const hHeight = WALL_HALF_H * S;
	const hLen = CELL_HALF * S;
	const groundY = - 0.125;
	const jumpRampHalfExtents = [ CELL_HALF * S * 0.36, 0.26 * S, CELL_HALF * S * 0.44 ];
	const JUMP_RAMP_ANGLE = THREE.MathUtils.degToRad( 30 );
	const JUMP_RAMP_SINK = 0.14;

	// Bump collision approximation: embed a sphere in the ground to make a smooth "dome"
	const BUMP_RADIUS = 7.5 * S;
	const BUMP_RISE = 0.42 * S;
	const bumpY = groundY + BUMP_RISE - BUMP_RADIUS;

	const ARC_SPAN = - Math.PI / 2;
	const ARC_CENTER_X = - CELL_HALF;
	const ARC_CENTER_Z = CELL_HALF;
	const OUTER_R = 2 * CELL_HALF - WALL_HALF_THICK;
	const OUTER_SEG = 8;
	const OUTER_SEG_HALF_LEN = ( OUTER_R * ( Math.PI / 2 ) / OUTER_SEG / 2 ) * S;
	const INNER_R = WALL_HALF_THICK;
	const INNER_SEG = 3;
	const INNER_SEG_HALF_LEN = ( INNER_R * ( Math.PI / 2 ) / INNER_SEG / 2 ) * S;

	function addArcWall( wcx, wcz, arcStart, radius, numSeg, segHalfLen ) {

		for ( let i = 0; i < numSeg; i ++ ) {

			const aMid = arcStart + ( ( i + 0.5 ) / numSeg ) * ARC_SPAN;
			const halfExtents = [ hThick, hHeight, segHalfLen ];
			const position = [
				wcx + radius * Math.cos( aMid ) * S,
				wallY,
				wcz + radius * Math.sin( aMid ) * S
			];
			const quaternion = [ 0, Math.sin( - aMid / 2 ), 0, Math.cos( - aMid / 2 ) ];

			rigidBody.create( world, {
				shape: box.create( { halfExtents } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position,
				quaternion,
				friction: 0.0,
				restitution: 0.0,
			} );

			if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

		}

	}

	function addJumpRampCollider( gx, gz, orient = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const yaw = deg * Math.PI / 180;
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( - JUMP_RAMP_ANGLE, yaw, 0, 'YXZ' ) );
		const position = [ cx, groundY - JUMP_RAMP_SINK, cz ];
		const quaternion = [ quat.x, quat.y, quat.z, quat.w ];

		rigidBody.create( world, {
			shape: box.create( { halfExtents: jumpRampHalfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			quaternion,
			friction: 1.0,
			restitution: 0.0,
		} );

		if ( debugGroup ) addDebugBox( debugGroup, jumpRampHalfExtents, position, quaternion );

	}

	const cells = customCells || TRACK_CELLS;
	const bumpSet = new Set();
	const poleSet = new Set();
	const cubeSet = new Set();
	const wallMap = new Map();
	const physicsBoxSet = new Set();
	const jumpMap = new Map();
	const resettableDynamicBodies = [];
	const customAssetColliders = extras?.customAssets && typeof extras.customAssets === 'object' ? extras.customAssets : {};
	const decorationEntries = extras && Array.isArray( extras.decorations ) ? extras.decorations : [];
	if ( extras && Array.isArray( extras.bumps ) ) {

		for ( const [ gx, gz ] of extras.bumps ) bumpSet.add( gx + ',' + gz );

	}
	if ( extras && Array.isArray( extras.poles ) ) {

		for ( const [ gx, gz ] of extras.poles ) poleSet.add( `${ gx },${ gz }` );

	}
	if ( extras && Array.isArray( extras.cubes ) ) {

		for ( const [ gx, gz ] of extras.cubes ) cubeSet.add( `${ gx },${ gz }` );

	}
	if ( extras && Array.isArray( extras.walls ) ) {

		for ( const [ gx, gz, orient = 0 ] of extras.walls ) wallMap.set( `${ gx },${ gz }`, orient );

	}
	if ( extras && Array.isArray( extras.physicsBoxes ) ) {

		for ( const [ gx, gz ] of extras.physicsBoxes ) physicsBoxSet.add( `${ gx },${ gz }` );

	}
	if ( extras && Array.isArray( extras.jumps ) ) {

		for ( const [ gx, gz, orient = 0 ] of extras.jumps ) jumpMap.set( gx + ',' + gz, orient );

	}

	for ( const poleKey of poleSet ) {

		const [ gxRaw, gzRaw ] = poleKey.split( ',' );
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const poleRadius = CELL_RAW * S * 0.08;
		const poleRise = CELL_RAW * S * 0.065;
		const position = [ cx, groundY + poleRise, cz ];

		rigidBody.create( world, {
			shape: sphere.create( { radius: poleRadius } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			friction: 1.0,
			restitution: 0.02,
		} );
		if ( debugGroup ) addDebugSphere( debugGroup, poleRadius, position );

	}

	for ( const cubeKey of cubeSet ) {

		const [ gxRaw, gzRaw ] = cubeKey.split( ',' );
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const halfExtents = [ CELL_RAW * S * 0.08, CELL_RAW * S * 0.08, CELL_RAW * S * 0.08 ];
		const position = [ cx, groundY + halfExtents[ 1 ], cz ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			friction: 0.9,
			restitution: 0.02,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position );

	}

	for ( const [ wallKey, orient ] of wallMap ) {

		const [ gxRaw, gzRaw ] = wallKey.split( ',' );
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const halfExtents = [ CELL_RAW * S * 0.31, CELL_RAW * S * 0.075, CELL_RAW * S * 0.04 ];
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const quaternion = [ 0, Math.sin( yaw / 2 ), 0, Math.cos( yaw / 2 ) ];
		const position = [ cx, groundY + halfExtents[ 1 ], cz ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			quaternion,
			friction: 0.9,
			restitution: 0.01,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

	}

	for ( const physKey of physicsBoxSet ) {

		const [ gxRaw, gzRaw ] = physKey.split( ',' );
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const halfExtents = [ CELL_RAW * S * 0.07, CELL_RAW * S * 0.07, CELL_RAW * S * 0.07 ];
		const position = [ cx, groundY + halfExtents[ 1 ], cz ];
		const body = rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.DYNAMIC,
			objectLayer: world._OL_MOVING,
			position,
			mass: 12.0,
			friction: 0.9,
			restitution: 0.06,
			linearDamping: 0.08,
			angularDamping: 0.3,
			motionQuality: MotionQuality.LINEAR_CAST,
		} );
		resettableDynamicBodies.push( { body, position } );
		if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position );

	}

	for ( const [ gx, gz, key, orient ] of cells ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;

		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );

		const hasBump = key === 'track-bump' || bumpSet.has( gx + ',' + gz );
		if ( hasBump ) bumpSet.delete( gx + ',' + gz );
		const jumpKey = gx + ',' + gz;
		if ( jumpMap.has( jumpKey ) ) {

			addJumpRampCollider( gx, gz, jumpMap.get( jumpKey ) );
			jumpMap.delete( jumpKey );

		}

		const baseKey = key === 'track-bump' ? 'track-straight' : key;

		if ( hasBump ) {

			const position = [ cx, bumpY, cz ];

			rigidBody.create( world, {
				shape: sphere.create( { radius: BUMP_RADIUS } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position,
				friction: 3.0,
				restitution: 0.0,
			} );

			if ( debugGroup ) addDebugSphere( debugGroup, BUMP_RADIUS, position );

		}

		if ( baseKey === 'track-straight' || baseKey === 'track-finish' || baseKey === 'track-checkpoint' || baseKey === 'track-start' || baseKey === 'track-start-finish' ) {

			for ( const side of [ - 1, 1 ] ) {

				const lx = side * WALL_X;
				const wx = cx + ( lx * cr ) * S;
				const wz = cz + ( - lx * sr ) * S;
				const halfExtents = [ hThick, hHeight, hLen ];
				const position = [ wx, wallY, wz ];
				const quaternion = [ 0, Math.sin( rad / 2 ), 0, Math.cos( rad / 2 ) ];

				rigidBody.create( world, {
					shape: box.create( { halfExtents } ),
					motionType: MotionType.STATIC,
					objectLayer: world._OL_STATIC,
					position,
					quaternion,
					friction: 0.0,
					restitution: 0.0,
				} );

				if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

			}

		} else if ( baseKey === 'track-corner' ) {

			const wcx = cx + ( ARC_CENTER_X * cr + ARC_CENTER_Z * sr ) * S;
			const wcz = cz + ( - ARC_CENTER_X * sr + ARC_CENTER_Z * cr ) * S;
			const arcStart = - rad;

			addArcWall( wcx, wcz, arcStart, OUTER_R, OUTER_SEG, OUTER_SEG_HALF_LEN );
			addArcWall( wcx, wcz, arcStart, INNER_R, INNER_SEG, INNER_SEG_HALF_LEN );

		}

	}

	// Add bump colliders that were placed on empty/grass cells (no base track tile in map data)
	for ( const key of bumpSet ) {

		const [ gx, gz ] = key.split( ',' ).map( Number );
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const position = [ cx, bumpY, cz ];

		rigidBody.create( world, {
			shape: sphere.create( { radius: BUMP_RADIUS } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			friction: 3.0,
			restitution: 0.0,
		} );

		if ( debugGroup ) addDebugSphere( debugGroup, BUMP_RADIUS, position );

	}

	for ( const [ key, orient ] of jumpMap ) {

		const [ gx, gz ] = key.split( ',' ).map( Number );
		addJumpRampCollider( gx, gz, orient );

	}

	for ( const [ gx, gz, decoKey, orient = 0 ] of decorationEntries ) {

		if ( typeof decoKey !== 'string' || ! decoKey.startsWith( 'custom:' ) ) continue;
		const assetId = decoKey.slice( 'custom:'.length );
		const colliderBoxes = Array.isArray( customAssetColliders?.[ assetId ]?.colliderBoxes ) ? customAssetColliders[ assetId ].colliderBoxes : [];
		if ( colliderBoxes.length === 0 ) continue;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const rotQuat = new THREE.Quaternion().setFromEuler( new THREE.Euler( 0, yaw, 0 ) );
		const cellCenter = new THREE.Vector3( ( gx + 0.5 ) * CELL_RAW * S, 0.01, ( gz + 0.5 ) * CELL_RAW * S );
		for ( const boxEntry of colliderBoxes.slice( 0, 96 ) ) {

			const localCenter = new THREE.Vector3(
				Number( boxEntry?.c?.[ 0 ] ) || 0,
				Number( boxEntry?.c?.[ 1 ] ) || 0,
				Number( boxEntry?.c?.[ 2 ] ) || 0
			).multiplyScalar( S );
			localCenter.applyQuaternion( rotQuat );
			const worldCenter = cellCenter.clone().add( localCenter );
			const halfExtents = [
				Math.max( 0.02, Number( boxEntry?.e?.[ 0 ] ) || 0.02 ) * S,
				Math.max( 0.02, Number( boxEntry?.e?.[ 1 ] ) || 0.02 ) * S,
				Math.max( 0.02, Number( boxEntry?.e?.[ 2 ] ) || 0.02 ) * S,
			];
			const position = [ worldCenter.x, worldCenter.y, worldCenter.z ];
			const quaternion = [ rotQuat.x, rotQuat.y, rotQuat.z, rotQuat.w ];
			rigidBody.create( world, {
				shape: box.create( { halfExtents } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position,
				quaternion,
				friction: 0.7,
				restitution: 0.05,
			} );
			if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

		}

	}

	return resettableDynamicBodies;

}

export function createSphereBody( world, spawnPos ) {

	const body = rigidBody.create( world, {
		shape: sphere.create( { radius: 0.5 } ),
		motionType: MotionType.DYNAMIC,
		objectLayer: world._OL_MOVING,
		position: spawnPos || [ 3.5, 0.5, 5 ],
		mass: 1000.0,
		friction: 5.0,
		restitution: 0.1,
		linearDamping: 0.1,
		angularDamping: 4.0,
		gravityFactor: 1.5,
		motionQuality: MotionQuality.LINEAR_CAST,
	} );

	return body;

}
