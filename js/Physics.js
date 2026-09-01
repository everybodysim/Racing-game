import * as THREE from 'three';
import { rigidBody, box, sphere, MotionType, MotionQuality, castRay, filter, createAllCastRayCollector, createDefaultCastRaySettings } from 'crashcat';
import { TRACK_CELLS, CELL_RAW, ORIENT_DEG, GRID_SCALE } from './Track.js';

// Building model definitions. The game's loadModels() scales every 'building-*'
// model up 10x (see js/main.js); the editor renders the same models at 10x too.
// The hitbox for each building is a single cube centered on the cell:
//   - footprint = 0.9 of the rescaled mesh = 0.9 * 10 = 9 world units per side
//     (half-extent 4.5 before the grid scale S), and
//   - height = the actual 10x mesh height (so the collider seals the building),
//     so the user can fine-tune heights later by editing BUILDING_HITBOX_FRACTIONS.
// These are LOCAL glb heights (as authored); the 10x scale is applied here.
const BUILDING_HITBOX_FRACTIONS = {
        'building-garage': 0.55,
        'building-small-a': 0.95,
        'building-small-b': 1.6265,
        'building-small-c': 1.75,
        'building-small-d': 1.0,
};


const _debugMat = new THREE.MeshBasicMaterial( {
	color: 0x2244ff,
	transparent: true,
	opacity: 0.5,
	depthWrite: false,
	depthTest: false,
} );

function addDebugBox( group, halfExtents, position, quaternion ) {

	const geo = new THREE.BoxGeometry( halfExtents[ 0 ] * 2, halfExtents[ 1 ] * 2, halfExtents[ 2 ] * 2 );
	const mesh = new THREE.Mesh( geo, _debugMat );
	mesh.userData.isHackHitboxDebug = true;
	mesh.renderOrder = 999;
	mesh.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
	if ( quaternion ) mesh.quaternion.set( quaternion[ 0 ], quaternion[ 1 ], quaternion[ 2 ], quaternion[ 3 ] );
	group.add( mesh );

}

function addDebugSphere( group, radius, position ) {

	const geo = new THREE.SphereGeometry( radius, 16, 12 );
	const mesh = new THREE.Mesh( geo, _debugMat );
	mesh.userData.isHackHitboxDebug = true;
	mesh.renderOrder = 999;
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
	const ELEVATED_HEIGHT = CELL_RAW * 0.5 * S;
	const SUPPORT_SINK = 0.03 * S;
	const SUPPORT_HALF_HEIGHT = CELL_HALF * 0.85 * S;
	const SUPPORT_HALF_EXTENTS = [ CELL_HALF * S, SUPPORT_HALF_HEIGHT, CELL_HALF * S ];
	const MAGNET_HALF_SIZE = CELL_RAW * S * 0.08;
	const MAGNET_BASE_Y = ( CELL_RAW * S * 0.08 ) - 0.06;
	const ELEVATED_SURFACE_HALF_H = 0.12 * S;
	const ELEVATED_SURFACE_HALF_XZ = CELL_HALF * S * 1.08;
	const FLAT_ELEVATED_SURFACE_DROP = 0.06;
	// The slope box stays centred on its cell; its top face is positioned to
	// meet the adjacent flat surfaces EXACTLY (no shift/fudge needed).
	const SLOPE_LOWER_EDGE_SHIFT = 0;
	const ORIENT_180 = { 0: 10, 10: 0, 16: 22, 22: 16 };
	const ELEVATED_WALL_HALF_H = WALL_HALF_H * S;
	const elevatedWallY = groundY + ELEVATED_HEIGHT + ELEVATED_WALL_HALF_H;
	const elevatedSurfaceY = groundY + ELEVATED_HEIGHT - FLAT_ELEVATED_SURFACE_DROP;
	const slopeAngle = Math.atan2( CELL_RAW * 0.5, CELL_RAW );
	// Slope driving surface = the TOP face of the tilted box (half-thickness hy,
	// pitched by slopeAngle). Its end-Y values are centerY + hy*cos ∓ hl*sin.
	// Forcing the low end onto the ground road surface (groundY) and the high
	// end onto the flat elevated deck top (elevatedSurfaceY + hy) and solving
	// both equations yields an exact center + half-length, eliminating the seam
	// step that caused clipping at the top and bottom of the slope.
	const slopeDeckTopY = elevatedSurfaceY + ELEVATED_SURFACE_HALF_H;
	const slopeTargetHalfLen = ( slopeDeckTopY - groundY ) / ( 2 * Math.sin( slopeAngle ) );
	const slopeTargetCenterY = ( groundY + slopeDeckTopY ) * 0.5
		- ELEVATED_SURFACE_HALF_H * Math.cos( slopeAngle );
	// The two pitched side rails were centred on the slope box and sat too low;
	// raise them by half their own height so they read as a proper kerb.
	const SLOPE_SIDE_WALL_RAISE = ELEVATED_WALL_HALF_H;

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

	function addArcWall( wcx, wcz, arcStart, radius, numSeg, segHalfLen, centerY = wallY, wallHalfHeight = hHeight ) {

		for ( let i = 0; i < numSeg; i ++ ) {

			const aMid = arcStart + ( ( i + 0.5 ) / numSeg ) * ARC_SPAN;
			const halfExtents = [ hThick, wallHalfHeight, segHalfLen ];
			const position = [
				wcx + radius * Math.cos( aMid ) * S,
				centerY,
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

	function addJumpRampCollider( gx, gz, orient = 0, yOffset = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const yaw = deg * Math.PI / 180;
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( - JUMP_RAMP_ANGLE, yaw, 0, 'YXZ' ) );
		const position = [ cx, groundY - JUMP_RAMP_SINK + yOffset, cz ];
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

	function addElevatedSupportCollider( gx, gz ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const supportTopY = groundY + ( CELL_HALF * S ) - SUPPORT_SINK - 0.12;
		const position = [ cx, supportTopY - SUPPORT_HALF_EXTENTS[ 1 ], cz ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents: SUPPORT_HALF_EXTENTS } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			friction: 0.95,
			restitution: 0.0,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, SUPPORT_HALF_EXTENTS, position );

	}

	function addElevatedRoadWalls( gx, gz, orient = 0, centerY = elevatedWallY, wallHalfHeight = ELEVATED_WALL_HALF_H ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		for ( const side of [ - 1, 1 ] ) {

			const lx = side * WALL_X;
			const wx = cx + ( lx * cr ) * S;
			const wz = cz + ( - lx * sr ) * S;
			const halfExtents = [ hThick, wallHalfHeight, hLen ];
			const position = [ wx, centerY, wz ];
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

	}

	function addElevatedCornerWalls( gx, gz, orient = 0, centerY = elevatedWallY, wallHalfHeight = ELEVATED_WALL_HALF_H ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		const wcx = cx + ( ARC_CENTER_X * cr + ARC_CENTER_Z * sr ) * S;
		const wcz = cz + ( - ARC_CENTER_X * sr + ARC_CENTER_Z * cr ) * S;
		const arcStart = - rad;
		for ( const [ radius, segCount, segHalfLen ] of [ [ OUTER_R, OUTER_SEG, OUTER_SEG_HALF_LEN ], [ INNER_R, INNER_SEG, INNER_SEG_HALF_LEN ] ] ) {

			for ( let i = 0; i < segCount; i ++ ) {

				const aMid = arcStart + ( ( i + 0.5 ) / segCount ) * ARC_SPAN;
				const halfExtents = [ hThick, wallHalfHeight, segHalfLen ];
				const position = [ wcx + radius * Math.cos( aMid ) * S, centerY, wcz + radius * Math.sin( aMid ) * S ];
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

	}

	function addElevatedCornerSupport( gx, gz, orient = 0 ) {

		// Replaces the old full-square support box for elevated corners. The corner
		// mesh is curved (quarter-annulus), so the support pillar below must match:
		// two straight arm boxes fill the L under the two road stubs (the sides
		// adjacent to the tight inside corner), and the outer-corner arc segments
		// are duplicated at the support height so the rounded outer edge still
		// reads as a curve even below the elevated block. The vertical extent
		// matches the old support box so the road deck above is never blocked.
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		const supportTopY = groundY + ( CELL_HALF * S ) - SUPPORT_SINK - 0.12;
		const centerY = supportTopY - SUPPORT_HALF_HEIGHT;
		const halfHeight = SUPPORT_HALF_HEIGHT;
		const armHalfLen = CELL_HALF - WALL_HALF_THICK; // road half-width along the stub edge
		// The arms are thin walls flush with the block's two stub edges (the sides
		// nearest the inside corner), NOT solid blocks reaching toward the center —
		// the corner's below-deck mesh is a curved shell, so the support matches it.
		const armHalfThick = WALL_HALF_THICK;

		// Two L arms (local space, then yaw-rotated by `rad`). For orient 0 the
		// inside corner sits at (-CELL_HALF, +CELL_HALF): arm A runs along +z
		// (the north stub edge), arm B along -x (the west stub edge). Each is a
		// thin wall spanning the road width along its edge, flush with the face.
		const arms = [
			{ lx: 0,                              lz: CELL_HALF - armHalfThick, hx: armHalfLen,   hz: armHalfThick },
			{ lx: - ( CELL_HALF - armHalfThick ), lz: 0,                         hx: armHalfThick, hz: armHalfLen },
		];
		const yawQuat = [ 0, Math.sin( rad / 2 ), 0, Math.cos( rad / 2 ) ];
		for ( const a of arms ) {

			const wx = cx + ( a.lx * cr + a.lz * sr ) * S;
			const wz = cz + ( - a.lx * sr + a.lz * cr ) * S;
			const halfExtents = [ a.hx * S, halfHeight, a.hz * S ];
			const position = [ wx, centerY, wz ];
			rigidBody.create( world, {
				shape: box.create( { halfExtents } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position,
				quaternion: yawQuat,
				friction: 0.95,
				restitution: 0.0,
			} );
			if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, yawQuat );

		}

		// Outer corner arc, lowered to the support height. Same XZ position and
		// rotation as the road-level outer walls — only the Y center / half-height
		// change, expanding the rounded outer edge downward to match the mesh.
		const wcx = cx + ( ARC_CENTER_X * cr + ARC_CENTER_Z * sr ) * S;
		const wcz = cz + ( - ARC_CENTER_X * sr + ARC_CENTER_Z * cr ) * S;
		const arcStart = - rad;
		for ( let i = 0; i < OUTER_SEG; i ++ ) {

			const aMid = arcStart + ( ( i + 0.5 ) / OUTER_SEG ) * ARC_SPAN;
			const halfExtents = [ hThick, halfHeight, OUTER_SEG_HALF_LEN ];
			const position = [ wcx + OUTER_R * Math.cos( aMid ) * S, centerY, wcz + OUTER_R * Math.sin( aMid ) * S ];
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

	function add3WayWalls( gx, gz, orient = 0, centerY = wallY, wallHalfHeight = hHeight ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		// Rotate the 3-way hitboxes 180° around the block center so the blocked side
		// and the open T-junction face the correct way for the model.
		const rad = ( deg * Math.PI / 180 ) + Math.PI;
		const cr = Math.cos( rad ), sr = Math.sin( rad );

		// Two inner corner arcs at the open T-junction side (-z/north, opposite the wall)
		// Northwest inner corner: local center (-CELL_HALF, -CELL_HALF)
		const lcx = cx + ( - CELL_HALF * cr - CELL_HALF * sr ) * S;
		const lcz = cz + ( CELL_HALF * sr - CELL_HALF * cr ) * S;
		addArcWall( lcx, lcz, - rad + Math.PI / 2, INNER_R, INNER_SEG, INNER_SEG_HALF_LEN, centerY, wallHalfHeight );

		// Northeast inner corner: local center (+CELL_HALF, -CELL_HALF)
		const rcx = cx + ( CELL_HALF * cr - CELL_HALF * sr ) * S;
		const rcz = cz + ( - CELL_HALF * sr - CELL_HALF * cr ) * S;
		addArcWall( rcx, rcz, - rad + Math.PI, INNER_R, INNER_SEG, INNER_SEG_HALF_LEN, centerY, wallHalfHeight );

		// Straight wall on the blocked side (local +z/south — matching the model's wall)
		const wx = cx + ( WALL_X * sr ) * S;
		const wz = cz + ( WALL_X * cr ) * S;
		const halfExtents = [ hLen, wallHalfHeight, hThick ];
		const position = [ wx, centerY, wz ];
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

	function add4WayWalls( gx, gz, orient = 0, centerY = wallY, wallHalfHeight = hHeight ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );

		// Four inner corner arcs (small radius) at each cell corner
		const corners = [
			{ x: - CELL_HALF, z:  CELL_HALF, offset: 0 },               // bottom-left
			{ x:  CELL_HALF, z:  CELL_HALF, offset: - Math.PI / 2 },    // bottom-right
			{ x:  CELL_HALF, z: - CELL_HALF, offset: Math.PI },         // top-right
			{ x: - CELL_HALF, z: - CELL_HALF, offset: Math.PI / 2 },   // top-left
		];
		for ( const c of corners ) {
			const wcx = cx + ( c.x * cr + c.z * sr ) * S;
			const wcz = cz + ( - c.x * sr + c.z * cr ) * S;
			addArcWall( wcx, wcz, - rad + c.offset, INNER_R, INNER_SEG, INNER_SEG_HALF_LEN, centerY, wallHalfHeight );
		}

	}

	function addSlopeSideWalls( gx, gz, orient = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const pitch = slopeAngle;
		const shiftX = Math.sin( yaw ) * SLOPE_LOWER_EDGE_SHIFT;
		const shiftZ = Math.cos( yaw ) * SLOPE_LOWER_EDGE_SHIFT;
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( pitch, yaw, 0, 'YXZ' ) );
		const quaternion = [ quat.x, quat.y, quat.z, quat.w ];

		for ( const side of [ - 1, 1 ] ) {

			const localX = side * WALL_X * S;
			const offsetX = localX * Math.cos( yaw );
			const offsetZ = - localX * Math.sin( yaw );
			const halfExtents = [ hThick, ELEVATED_WALL_HALF_H, slopeTargetHalfLen ];
			const position = [ cx + shiftX + offsetX, slopeTargetCenterY + SLOPE_SIDE_WALL_RAISE, cz + shiftZ + offsetZ ];
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

	function addSlopeCollider( gx, gz, orient = 0, up = true ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const shiftX = Math.sin( yaw ) * SLOPE_LOWER_EDGE_SHIFT;
		const shiftZ = Math.cos( yaw ) * SLOPE_LOWER_EDGE_SHIFT;
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( up ? slopeAngle : - slopeAngle, yaw, 0, 'YXZ' ) );
		const halfExtents = [ ELEVATED_SURFACE_HALF_XZ, ELEVATED_SURFACE_HALF_H, slopeTargetHalfLen ];
		const position = [ cx + shiftX, slopeTargetCenterY, cz + shiftZ ];
		const quaternion = [ quat.x, quat.y, quat.z, quat.w ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			quaternion,
			// The car is a sphere that drives by rolling — friction converts angular
			// velocity into forward motion. Low friction (1.0) makes the sphere slip
			// and spin in place on the incline, so the car can't grip/accelerate
			// uphill (it "glides"). Match the ground surface (5.0) so the slope grips
			// like the flat road. Side walls below stay frictionless (rails).
			friction: 5.0,
			restitution: 0.0,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );
		addSlopeSideWalls( gx, gz, orient );
		addSlopeGroundWalls( gx, gz, orient );

	}

	// Ground-level U of road walls sealing the open space under/around the
	// slope wedge. The slope collider only covers the pitched driving surface;
	// below it the solid mesh is un-collided, so a car on the ground could clip
	// in through the sides or the tall high end. Add three straight-road-style
	// walls at ground level: two arms running along the slope (local z, at the
	// road edges) + one cross wall capping the HIGH end. The HIGH end is local
	// -z: the slope pitches up toward -z (top-face Y = centerY + hy*cos ∓ hl*sin
	// is maximal at lz = -hl), so the deck-meeting end is always local -z for a
	// normalized slope-up. The low end (local +z) stays open as the ramp mouth.
	function addSlopeGroundWalls( gx, gz, orient = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const rad = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		const quaternion = [ 0, Math.sin( rad / 2 ), 0, Math.cos( rad / 2 ) ];

		// Two arms — identical to straight road walls: lateral offset ±WALL_X,
		// run along the slope length (local z), full cell long.
		for ( const side of [ - 1, 1 ] ) {

			const lx = side * WALL_X;
			const wx = cx + ( lx * cr ) * S;
			const wz = cz + ( - lx * sr ) * S;
			const halfExtents = [ hThick, hHeight, hLen ];
			const position = [ wx, wallY, wz ];
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

		// Cross wall at the HIGH end (local -z). local z offset = -CELL_HALF
		// (cell units) -> world dx = -hLen*sr, dz = -hLen*cr. Spans across the
		// road (local x), full cell wide.
		const hx = cx - hLen * sr;
		const hz = cz - hLen * cr;
		const crossHalfExtents = [ hLen, hHeight, hThick ];
		const crossPosition = [ hx, wallY, hz ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents: crossHalfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: crossPosition,
			quaternion,
			friction: 0.0,
			restitution: 0.0,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, crossHalfExtents, crossPosition, quaternion );

	}

	// Pool slope: a ramp that descends from the ground surface down to the pool
	// floor so the car can drive in/out. It reuses the slope collider shape but
	// is centered around the pool floor depth and scaled to match the pool.
	const POOL_FLOOR_DROP = CELL_RAW * S * 0.34;
	const poolSlopeAngle = Math.atan2( POOL_FLOOR_DROP, CELL_RAW * S );
	const poolSlopeHalfLen = Math.max(
		ELEVATED_SURFACE_HALF_XZ,
		( ( Math.abs( POOL_FLOOR_DROP ) * 0.5 ) / Math.sin( poolSlopeAngle ) )
	);
	const poolSlopeCenterY = groundY - POOL_FLOOR_DROP * 0.5;
	function addPoolSlopeCollider( gx, gz, orient = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const flipOrient = ORIENT_180[ orient ] ?? orient;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ flipOrient ] ?? 0 );
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( - poolSlopeAngle, yaw, 0, 'YXZ' ) );
		const halfExtents = [ ELEVATED_SURFACE_HALF_XZ, ELEVATED_SURFACE_HALF_H, poolSlopeHalfLen ];
		const position = [ cx, poolSlopeCenterY, cz ];
		const quaternion = [ quat.x, quat.y, quat.z, quat.w ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			quaternion,
			friction: 5.0,
			restitution: 0.0,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

	}

	function addMergedElevatedSurfaceColliders( elevatedList ) {

		const flatSet = new Set();
		for ( const entry of elevatedList ) {

			if ( ! Array.isArray( entry ) ) continue;
			const [ gxRaw, gzRaw, elevatedType ] = entry;
			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			if ( elevatedType !== 'elevated-straight' && elevatedType !== 'elevated-corner' && elevatedType !== 'elevated-checkpoint' && elevatedType !== 'elevated-3-way' && elevatedType !== 'elevated-4-way' ) continue;
			flatSet.add( `${ gx },${ gz }` );

		}

		if ( flatSet.size === 0 ) return;

		const rows = new Map();
		for ( const cellKey of flatSet ) {

			const [ gx, gz ] = cellKey.split( ',' ).map( Number );
			if ( ! rows.has( gz ) ) rows.set( gz, [] );
			rows.get( gz ).push( gx );

		}

		const rowKeys = [ ...rows.keys() ].sort( ( a, b ) => a - b );
		const activeRects = new Map();
		const finishedRects = [];

		for ( const gz of rowKeys ) {

			const xs = rows.get( gz ).sort( ( a, b ) => a - b );
			const spans = [];
			let start = xs[ 0 ];
			let prev = xs[ 0 ];
			for ( let i = 1; i < xs.length; i ++ ) {

				const x = xs[ i ];
				if ( x === prev + 1 ) {

					prev = x;
					continue;

				}
				spans.push( [ start, prev ] );
				start = x;
				prev = x;

			}
			spans.push( [ start, prev ] );

			const nextActive = new Map();
			for ( const [ spanStart, spanEnd ] of spans ) {

				const spanKey = `${ spanStart },${ spanEnd }`;
				const existing = activeRects.get( spanKey );
				if ( existing ) {

					existing.maxZ = gz;
					nextActive.set( spanKey, existing );

				} else {

					nextActive.set( spanKey, { minX: spanStart, maxX: spanEnd, minZ: gz, maxZ: gz } );

				}

			}

			for ( const [ spanKey, rect ] of activeRects ) {

				if ( ! nextActive.has( spanKey ) ) finishedRects.push( rect );

			}

			activeRects.clear();
			for ( const [ spanKey, rect ] of nextActive ) activeRects.set( spanKey, rect );

		}

		for ( const rect of activeRects.values() ) finishedRects.push( rect );

		const edgeOverhang = CELL_RAW * S * 0.03;
		for ( const rect of finishedRects ) {

			const spanCellsX = rect.maxX - rect.minX + 1;
			const spanCellsZ = rect.maxZ - rect.minZ + 1;
			const fullX = spanCellsX * CELL_RAW * S + edgeOverhang;
			const fullZ = spanCellsZ * CELL_RAW * S + edgeOverhang;
			const halfExtents = [ fullX * 0.5, ELEVATED_SURFACE_HALF_H, fullZ * 0.5 ];
			const centerX = ( ( rect.minX + rect.maxX + 1 ) * 0.5 ) * CELL_RAW * S;
			const centerZ = ( ( rect.minZ + rect.maxZ + 1 ) * 0.5 ) * CELL_RAW * S;
			const position = [ centerX, elevatedSurfaceY, centerZ ];
			rigidBody.create( world, {
				shape: box.create( { halfExtents } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position,
				friction: 1.0,
				restitution: 0.0,
			} );
			if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position );

		}

	}


	const cells = customCells || TRACK_CELLS;
	const bumpSet = new Set();
	const poleSet = new Set();
	const cubeSet = new Set();
	const wallMap = new Map();
	const jumpMap = new Map();
	const magnetEntries = extras && Array.isArray( extras.magnets ) ? extras.magnets : [];
	const elevatedEntries = extras && Array.isArray( extras.elevated ) ? extras.elevated : [];
	const waterEntries = extras && Array.isArray( extras.water ) ? extras.water : [];
	const elevatedMap = new Map();
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
	if ( extras && Array.isArray( extras.jumps ) ) {

		for ( const [ gx, gz, orient = 0 ] of extras.jumps ) jumpMap.set( gx + ',' + gz, orient );

	}
	for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedEntries ) {

		const key = `${ gx },${ gz }`;
		if ( elevatedType === 'slope-down' ) elevatedMap.set( key, { type: 'slope-up', orient: ORIENT_180[ orient ] ?? orient } );
		else elevatedMap.set( key, { type: elevatedType, orient } );

	}

	const waterSet = new Set( waterEntries.map( ( [ gx, gz ] ) => `${ gx },${ gz }` ) );
	// Map each pool-slope cell to the (dx,dz) side it exits toward, so the
	// corresponding pool wall can be skipped (otherwise it blocks the car).
	const poolSlopeExit = new Map();
	if ( Array.isArray( extras?.poolSlopes ) ) {
		for ( const [ gx, gz, orient = 0 ] of extras.poolSlopes ) {
			const rad = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
			// Exit side = high end of the ramp (opposite the low end at +z).
			const dx = - Math.round( Math.sin( rad ) );
			const dz = - Math.round( Math.cos( rad ) );
			poolSlopeExit.set( `${ Number( gx ) },${ Number( gz ) }`, `${ dx },${ dz }` );
		}
	}
	const WATER_BEVEL_ANGLE = THREE.MathUtils.degToRad( 1.6 );
	for ( const [ gx, gz ] of waterEntries ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const floorHalfExtents = [ CELL_HALF * S, 0.04 * S, CELL_HALF * S ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents: floorHalfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ cx, groundY - CELL_RAW * S * 0.34, cz ],
			friction: 0.25,
			restitution: 0.0,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, floorHalfExtents, [ cx, groundY - CELL_RAW * S * 0.34, cz ] );
		const exitSide = poolSlopeExit.get( `${ gx },${ gz }` );
		const sides = [ [ 0, - 1, 0, - CELL_HALF * S, 0 ], [ 1, 0, CELL_HALF * S, 0, Math.PI / 2 ], [ 0, 1, 0, CELL_HALF * S, 0 ], [ - 1, 0, - CELL_HALF * S, 0, Math.PI / 2 ] ];
		for ( const [ dx, dz, ox, oz, yaw ] of sides ) {
			if ( waterSet.has( `${ gx + dx },${ gz + dz }` ) ) continue;
			if ( exitSide === `${ dx },${ dz }` ) continue;
			const halfExtents = [ CELL_HALF * S, CELL_RAW * S * 0.19, CELL_RAW * S * 0.04 ];
			const quaternion = [ 0, Math.sin( yaw / 2 ), 0, Math.cos( yaw / 2 ) ];
			// Lower wall so its top is flush with groundY (below the ground surface),
			// preventing a lip that catches the sphere. The thick ground collider
			// (0.5 half-height, top at groundY+0.01) now overlaps this wall top.
			const position = [ cx + ox, groundY - CELL_RAW * S * 0.19, cz + oz ];
			rigidBody.create( world, { shape: box.create( { halfExtents } ), motionType: MotionType.STATIC, objectLayer: world._OL_STATIC, position, quaternion, friction: 0.9, restitution: 0.0 } );
			if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );


		}

	}

	function getOverlayHeightOffset( gx, gz ) {

		const elevatedEntry = elevatedMap.get( `${ gx },${ gz }` );
		if ( ! elevatedEntry ) return 0;
		return elevatedEntry.type === 'slope-up' ? ELEVATED_HEIGHT * 0.5 : ELEVATED_HEIGHT;

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
		const position = [ cx, groundY + poleRise + getOverlayHeightOffset( gx, gz ), cz ];

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
		const position = [ cx, groundY + halfExtents[ 1 ] + getOverlayHeightOffset( gx, gz ), cz ];
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

	for ( const [ gxRaw, gzRaw, yGridRaw ] of magnetEntries ) {

		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const halfExtents = [ MAGNET_HALF_SIZE, MAGNET_HALF_SIZE, MAGNET_HALF_SIZE ];
		const position = [ cx, groundY + MAGNET_BASE_Y + yGrid * CELL_RAW * S, cz ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			friction: 0.8,
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
		const position = [ cx, groundY + halfExtents[ 1 ] + getOverlayHeightOffset( gx, gz ), cz ];
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

			addJumpRampCollider( gx, gz, jumpMap.get( jumpKey ), getOverlayHeightOffset( gx, gz ) );
			jumpMap.delete( jumpKey );

		}

		const baseKey = key === 'track-bump' ? 'track-straight' : key;

		if ( hasBump ) {

			const position = [ cx, bumpY + getOverlayHeightOffset( gx, gz ), cz ];

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

		} else if ( baseKey === 'track-3-way' ) {

			add3WayWalls( gx, gz, orient );

		} else if ( baseKey === 'track-4-way' ) {

			add4WayWalls( gx, gz, orient );

		}

	}

	// Add bump colliders that were placed on empty/grass cells (no base track tile in map data)
	for ( const key of bumpSet ) {

		const [ gx, gz ] = key.split( ',' ).map( Number );
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const position = [ cx, bumpY + getOverlayHeightOffset( gx, gz ), cz ];

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
		addJumpRampCollider( gx, gz, orient, getOverlayHeightOffset( gx, gz ) );

	}

	addMergedElevatedSurfaceColliders( elevatedEntries );

	for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedEntries ) {

		if ( ! Number.isFinite( Number( gx ) ) || ! Number.isFinite( Number( gz ) ) ) continue;
		const normalizedType = elevatedType === 'slope-down' ? 'slope-up' : elevatedType;
		const normalizedOrient = elevatedType === 'slope-down' ? ( ORIENT_180[ orient ] ?? orient ) : orient;
		const nx = Number( gx );
		const nz = Number( gz );
		// The elevated-corner support pillar is curved (matching the corner mesh),
		// so the generic full-square support box is skipped for corners and rebuilt
		// by addElevatedCornerSupport() as an L-shaped + outer-arc footprint below.
		if ( normalizedType !== 'slope-up' && normalizedType !== 'elevated-corner' ) addElevatedSupportCollider( nx, nz );
		if ( normalizedType === 'slope-up' ) {

			addSlopeCollider( nx, nz, normalizedOrient, true );
			continue;

		}
		if ( normalizedType === 'elevated-straight' || normalizedType === 'elevated-checkpoint' ) {

			addElevatedRoadWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-corner' ) {

			addElevatedCornerSupport( nx, nz, normalizedOrient );
			addElevatedCornerWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-3-way' ) {

			add3WayWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-4-way' ) {

			add4WayWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );

		}

	}

	const poolSlopeEntries = extras && Array.isArray( extras.poolSlopes ) ? extras.poolSlopes : [];
	for ( const [ gxRaw, gzRaw, orient = 0 ] of poolSlopeEntries ) {

		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		addPoolSlopeCollider( gx, gz, orient );

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

	// Building decorations (built-in models) get a single centering cube:
	// footprint 9x9 (0.9 of the 10x-rescaled mesh) and height = the 10x mesh
	// height so the collider seals the whole building.
	for ( const [ gx, gz, decoKey, orient = 0 ] of decorationEntries ) {

		if ( typeof decoKey !== 'string' || ! decoKey.startsWith( 'building-' ) ) continue;
		const localHeight = BUILDING_HITBOX_FRACTIONS[ decoKey ];
		if ( ! Number.isFinite( localHeight ) || localHeight <= 0 ) continue;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const rotQuat = new THREE.Quaternion().setFromEuler( new THREE.Euler( 0, yaw, 0 ) );
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		// Half-extents in world units: footprint half = 0.4 * 10 * S = 4 * S;
		// height half = 0.5 * (localHeight * 10) * S.
		const halfExtents = [
			4.5 * S,
			0.5 * localHeight * 10 * S,
			4.5 * S,
		];
		// Base the collider at world Y 0, which is where the building's
		// visual base lands after Track.js's -0.5 group offset and 0.75
		// grid scale, so the hitbox seals the whole building.
		const position = [ cx, halfExtents[ 1 ], cz ];
		const quaternion = [ rotQuat.x, rotQuat.y, rotQuat.z, rotQuat.w ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			quaternion,
			friction: 0.9,
			restitution: 0.0,
		} );
		if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

	}


	return [];

}

export function createCameraObstacleProbe( world ) {

	const settings = createDefaultCastRaySettings();
	const collector = createAllCastRayCollector();
	const worldFilter = world && world.settings ? filter.create( world.settings.layers ) : null;
	const ignoredBodyIds = new Set();
	const hits = collector.hits;
	return {

		probe( origin, direction, maxDistance, isBodyIgnored ) {

			if ( ! world || ! origin || ! direction ) return null;
			ignoredBodyIds.clear();
			const bodyCount = world.bodies?.pool?.length || 0;
			for ( let i = 0; i < bodyCount; i ++ ) {

				const body = world.bodies.pool[ i ];
				if ( body && ! body._pooled && isBodyIgnored && isBodyIgnored( body ) ) ignoredBodyIds.add( body.id );

			}
			collector.reset();
			if ( ! worldFilter ) return null;
			castRay( world, collector, settings, origin, direction, maxDistance, worldFilter );
			for ( let n =  0; n < hits.length; n ++ ) {

				const hit = hits[ n ];
				if ( hit.status !== 1 ) continue; // CastRayStatus.COLLIDING
				if ( ! ignoredBodyIds.has( hit.bodyIdB ) ) return hit;

			}
			return null;

		},

	};

}
export function createSphereBody( world, spawnPos ) {

	const body = rigidBody.create( world, {
		shape: sphere.create( { radius: 0.5 } ),
		motionType: MotionType.DYNAMIC,
		objectLayer: world._OL_MOVING,
		position: spawnPos || [ 3.5, 0.5, 5 ],
		mass: 1000.0,
		friction: 5.0,
		restitution: 0.0,
		linearDamping: 0.1,
		angularDamping: 4.0,
		gravityFactor: 1.5,
		motionQuality: MotionQuality.LINEAR_CAST,
	} );

	return body;

}
