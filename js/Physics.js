import * as THREE from 'three';
import { rigidBody, box, sphere, MotionType, MotionQuality } from 'crashcat';
import { TRACK_CELLS, CELL_RAW, ORIENT_DEG, GRID_SCALE } from './Track.js';
import { THIN_WALL_SPECS } from './thin-wall-specs.js?v=13';

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
	depthTest: false,
} );

// MEGA PAD WALL BOOST — grows every registered wall collider (bottom
// anchored, so walls rise UP from the ground) while the mega pad effect is
// active: the mega car must not be able to hop over walls. Wall colliders
// register from buildWallColliders via its addWallBody helper.
const WALL_BOOST = { bodies: [], active: false, mult: 2 };

export function setWallHeightBoost( active ) {

	const on = Boolean( active );
	if ( on === WALL_BOOST.active ) return;
	WALL_BOOST.active = on;
	for ( const e of WALL_BOOST.bodies ) {

		const hy = on ? e.baseHY * WALL_BOOST.mult : e.baseHY;
		e.body.shape = box.create( { halfExtents: [ e.hx, hy, e.hz ] } );
		rigidBody.updateShape( e.world, e.body );
		const bottomY = e.y - e.baseHY;
		rigidBody.setPosition( e.world, e.body, [ e.x, bottomY + hy, e.z ], false );
		if ( e.debugMesh ) { e.debugMesh.scale.y = hy / e.baseHY; e.debugMesh.position.y = bottomY + hy; }

	}

}

function addDebugBox( group, halfExtents, position, quaternion ) {

	const geo = new THREE.BoxGeometry( halfExtents[ 0 ] * 2, halfExtents[ 1 ] * 2, halfExtents[ 2 ] * 2 );
	const mesh = new THREE.Mesh( geo, _debugMat );
	mesh.userData.isHackHitboxDebug = true;
	mesh.renderOrder = 999;
	mesh.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
	if ( quaternion ) mesh.quaternion.set( quaternion[ 0 ], quaternion[ 1 ], quaternion[ 2 ], quaternion[ 3 ] );
	group.add( mesh );
	return mesh;

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

	// MEGA PAD WALL BOOST bookkeeping: the registry is rebuilt per track; if
	// the boost is active when a new track loads, re-apply it to the fresh
	// wall set at the end of this build.
	const wallBoostWasActive = WALL_BOOST.active;
	WALL_BOOST.active = false;
	WALL_BOOST.bodies.length = 0;

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
	// Ramp collider = EXACT same box as the visual mesh (Track.js: BoxGeometry
	// of JUMP_RAMP_SIZE x JUMP_RAMP_DEPTH x JUMP_RAMP_SIZE = CELL_RAW*0.36 x
	// CELL_RAW*0.18 x CELL_RAW*0.36). The old [*, 0.26*S, 0.44*S] slab was
	// ~3x thicker and longer than the mesh — an invisible wall around the
	// ramp. Same center, same 30-degree pitch, same sink as before.
	const jumpRampHalfExtents = [ CELL_HALF * S * 0.36, CELL_HALF * S * 0.18, CELL_HALF * S * 0.36 ];
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
	const ORIENT_180 = { 0: 10, 10: 0, 16: 22, 22: 16 };
	const ELEVATED_WALL_HALF_H = WALL_HALF_H * S;
	const elevatedWallY = groundY + ELEVATED_HEIGHT + ELEVATED_WALL_HALF_H;
	const elevatedSurfaceY = groundY + ELEVATED_HEIGHT - FLAT_ELEVATED_SURFACE_DROP;
	const slopeDeckTopY = elevatedSurfaceY + ELEVATED_SURFACE_HALF_H;
	// How far the slope collider tucks past the flat-deck cell's edge
	// (edgeOverhang * 0.5 — see getSlopeGeometry +
	// addFlatElevatedSurfaceColliders).
	const SLOPE_DECK_EDGE_PROTRUSION = CELL_RAW * S * 0.03 * 0.5;
	// Slope↔slope seams (two high ends meeting = a peak, or a deck-less top)
	// are sealed with a small coplanar overlap so the ball can never drop
	// into a gap at the seam line.
	const SLOPE_SEAM_OVERLAP = 0.02;
	// The two pitched side rails were centred on the slope box and sat too low;
	// raise them by half their own height so they read as a proper kerb.
	const SLOPE_SIDE_WALL_RAISE = ELEVATED_WALL_HALF_H;
	// Choke blocks: the wall center-line runs a cosine pinch along the
	// block — WALL_X (4.75) at the two open ends, pinching to CHOKE_APEX_X
	// (2.5 from the block edge, per the Blender sculpt) at mid-length.
	// 8 rotated box segments per curved side (same pattern as the corner
	// arcs) approximate the curve; a straight wall fills the flat side of
	// the half-choke.
	const CHOKE_APEX_X = 2.5;
	const CHOKE_SEGS = 8;
	// "elev-choke" pinwheel block (new mesh, 2026-09-27): 4 diagonal walls,
	// one from each of the block's 4 corners, tapering in toward a tight
	// diamond-shaped center opening that still lets the car through in all
	// 4 cardinal directions. Measured directly off the user's top-down
	// reference image (own PCA fit of the wall silhouette, corner-blob by
	// corner-blob, image = exactly 10x10 units): each wall's box CENTER sits
	// 3 units in from its corner along BOTH x and z, its long axis runs on
	// the exact 45° corner-to-center diagonal with half-length 2.8, and its
	// perpendicular half-thickness is 1.4. 4-fold symmetric (rotating the
	// whole pattern 90° maps it onto itself), so `orient` only spins the
	// pattern in place — kept anyway for consistency with every other wall
	// helper here. Works both as a normal ground block and as an elevated
	// deck (raise = the standard ELEVATED_HEIGHT reused via elevatedWallY,
	// same as every other elevated piece) — see addChokeCrossWalls below.
	// Wall geometry, in diagonal coordinates (distance from cell center):
	// outer tip pinned at the cell corner (d = 5*sqrt(2) = 7.07), inner tip
	// pulled 1.75 units back from the old reach (d 1.44 -> 3.19) per user
	// request — walls used to crowd the center diamond. Box center sits
	// halfway between the tips: d = 5.12 -> per-axis offset 3.62; half
	// length = (7.07 - 3.19) / 2 = 1.93.
	const CHOKE_CROSS_OFFSET = 3.62;
	const CHOKE_CROSS_HALF_LEN = 1.93;
	const CHOKE_CROSS_HALF_THICK = 0.35;
	const FLAT_ELEVATED_TYPES = new Set( [ 'elevated-straight', 'elevated-cross', 'elevated-corner', 'elevated-cross-corner', 'elevated-checkpoint', 'elevated-checkpoint-corner', 'elevated-3-way', 'elevated-4-way', 'elevated-choke-half', 'elevated-choke-both', 'elevated-choke-cross', 'elevated-thin-straight', 'elevated-thin-corner', 'elevated-thin-3-way', 'elevated-thin-4-way', 'elevated-wide-thin', 'elevated-wide-thin-corner', 'pool-cross' ] );

	// PERFECT SLOPE SEAM MATH. The slope's driving surface is the TOP face of a
	// tilted box (half-thickness hy = ELEVATED_SURFACE_HALF_H). The old geometry
	// pinned that face's low end to groundY and high end to the deck top at the
	// CELL boundaries — but the flat deck's surface box protrudes
	// SLOPE_DECK_EDGE_PROTRUSION into the slope cell, so at the deck box's edge
	// the slope face had already fallen (protrusion + high-edge overhang) * tan
	// ≈ 0.072 below the deck top. That protruding box edge exposed a lip: going
	// UP, the sphere hit the edge face head-on and popped; going DOWN, it
	// launched off the edge and slammed the slope below — the classic
	// "bounced at the top both ways" feel.
	//
	// Fix: pin the top face's HIGH edge at slopeDeckTopY exactly AT the deck
	// box's protruding edge (the two faces meet that line coplanar — zero lip,
	// the sphere rolls straight across), and the LOW edge at groundY exactly at
	// the downhill cell boundary (coplanar with the ground road). The uphill
	// horizontal run shrinks by the protrusion, so the driving angle steepens
	// slightly (≈26.57° → ≈27.08°) — imperceptible next to the seam being
	// actually seamless. When the uphill neighbour is NOT a flat deck (slope
	// peaks, or nothing), the high edge pins at the boundary + a small overlap
	// so peaks stay sealed.
	function getSlopeGeometry( gx, gz, orient, elevatedMap ) {

		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		// The slope pitches up toward local -z; find the uphill neighbour cell.
		const upX = - Math.sin( yaw );
		const upZ = - Math.cos( yaw );
		const neighbour = elevatedMap?.get( `${ gx + Math.round( upX ) },${ gz + Math.round( upZ ) }` );
		const upIsFlatDeck = !! neighbour && FLAT_ELEVATED_TYPES.has( neighbour.type );

		const spanLow = CELL_HALF * S;
		const spanHigh = upIsFlatDeck ? CELL_HALF * S - SLOPE_DECK_EDGE_PROTRUSION : CELL_HALF * S + SLOPE_SEAM_OVERLAP;
		const rise = slopeDeckTopY - groundY;
		const angle = Math.atan2( rise, spanLow + spanHigh );
		const halfLen = Math.hypot( ( spanLow + spanHigh ) * 0.5, rise * 0.5 );
		// Top-face centre sits half the face-centre offset below the box centre...
		const centerY = ( groundY + slopeDeckTopY ) * 0.5 - ELEVATED_SURFACE_HALF_H * Math.cos( angle );
		// ...and horizontally at the midpoint of the two pinned edges. The box
		// centre's z-extent maps to (spanLow + spanHigh)/2, BUT the tilted
		// half-thickness displaces the top-face edges hy*sin(angle) downhill of
		// the centre's own extent — subtract it or the pinned edges land
		// ~0.04 downhill of the deck box edge / ground boundary.
		const shift = ( spanLow - spanHigh ) * 0.5 - ELEVATED_SURFACE_HALF_H * Math.sin( angle );
		return { angle, halfLen, centerY, shift, upIsFlatDeck };

	}

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

	// Wall-type static collider: creates the body AND registers it for the
	// mega-pad height boost (see setWallHeightBoost at module level).
	function addWallBody( halfExtents, position, quaternion ) {

		const body = rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			quaternion,
			friction: 0.0,
			restitution: 0.0,
		} );
		const debugMesh = debugGroup ? addDebugBox( debugGroup, halfExtents, position, quaternion ) : null;
		WALL_BOOST.bodies.push( { world, body, hx: halfExtents[ 0 ], hz: halfExtents[ 2 ], baseHY: halfExtents[ 1 ], x: position[ 0 ], y: position[ 1 ], z: position[ 2 ], debugMesh } );
		return body;

	}

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

			addWallBody( halfExtents, position, quaternion );

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
			addWallBody( halfExtents, position, quaternion );

		}

	}

	function addChokeWalls( gx, gz, orient = 0, chokeSides = [ - 1 ], centerY = wallY, wallHalfHeight = hHeight ) {

		// Choke road walls. For every side: if it chokes, 8 rotated boxes
		// trace a cosine pinch from the block end (local x = ±WALL_X at
		// local z = ±CELL_HALF) to the apex (±CHOKE_APEX_X at z = 0); if it
		// is flat, one straight wall identical to a normal straight block.
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		const span = CELL_RAW;
		const halfSpan = CELL_HALF;
		for ( const side of [ - 1, 1 ] ) {

			if ( ! chokeSides.includes( side ) ) {

				// flat side: normal straight wall
				const lx = side * WALL_X;
				const wx = cx + ( lx * cr ) * S;
				const wz = cz + ( - lx * sr ) * S;
				const halfExtents = [ hThick, wallHalfHeight, hLen ];
				const position = [ wx, centerY, wz ];
				const quaternion = [ 0, Math.sin( rad / 2 ), 0, Math.cos( rad / 2 ) ];
				addWallBody( halfExtents, position, quaternion );
				continue;

			}
			// choked side: 8 tangent-rotated boxes along the pinch curve.
			// Center-line: x(t) = APEX + (WALL_X-APEX) * 0.5*(1+cos(2π t)),
			// t = (z + halfSpan) / span → WALL_X at both ends, APEX at z = 0.
			for ( let i = 0; i < CHOKE_SEGS; i ++ ) {

				const zc = - halfSpan + ( ( i + 0.5 ) / CHOKE_SEGS ) * span;
				const t = ( zc + halfSpan ) / span;
				const xLine = CHOKE_APEX_X + ( WALL_X - CHOKE_APEX_X ) * 0.5 * ( 1 + Math.cos( 2 * Math.PI * t ) );
				const dx = - ( WALL_X - CHOKE_APEX_X ) * Math.PI * Math.sin( 2 * Math.PI * t ) / span;
				const lx = side * xLine;
				// world position follows the add3WayWalls local->world convention; zc
				// spreads the 8 boxes along the block instead of stacking at its center.
				const wx = cx + ( lx * cr + zc * sr ) * S;
				const wz = cz + ( - lx * sr + zc * cr ) * S;
				// box long axis follows the tangent (dx, dz = 1) in local
				// space; the block yaw adds on top of the per-segment tilt.
				const segTilt = Math.atan( side * dx );
				const yaw = rad + segTilt;
				const halfLen = ( span / CHOKE_SEGS * 0.5 ) / Math.cos( segTilt ) + 0.09;
				const halfExtents = [ hThick, wallHalfHeight, halfLen ];
				const position = [ wx, centerY, wz ];
				const quaternion = [ 0, Math.sin( yaw / 2 ), 0, Math.cos( yaw / 2 ) ];
				addWallBody( halfExtents, position, quaternion );

			}

		}

	}

	function addChokeCrossWalls( gx, gz, orient = 0, centerY = wallY, wallHalfHeight = hHeight ) {

		// 4 boxes, one per corner. Box center = (±CHOKE_CROSS_OFFSET,
		// ±CHOKE_CROSS_OFFSET) in local cell space; box long axis (local Z
		// before rotation) is tilted by atan2(lx,lz) so it lies exactly on
		// that corner's diagonal, then the whole thing is rotated by the
		// block's own orient like every other wall helper.
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		const halfExtents = [ CHOKE_CROSS_HALF_THICK * S, wallHalfHeight, CHOKE_CROSS_HALF_LEN * S ];

		for ( const lx of [ - CHOKE_CROSS_OFFSET, CHOKE_CROSS_OFFSET ] ) {

			for ( const lz of [ - CHOKE_CROSS_OFFSET, CHOKE_CROSS_OFFSET ] ) {

				const wx = cx + ( lx * cr + lz * sr ) * S;
				const wz = cz + ( - lx * sr + lz * cr ) * S;
				const total = rad + Math.atan2( lx, lz );
				const position = [ wx, centerY, wz ];
				const quaternion = [ 0, Math.sin( total / 2 ), 0, Math.cos( total / 2 ) ];

				addWallBody( halfExtents, position, quaternion );

				if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

			}

		}

	}

	// Thin-road / wide-to-thin transition blocks: hitbox walls come from
	// AUTO-GENERATED specs (js/thin-wall-specs.js) fitted to the actual
	// white-wall triangles in each GLB, so the colliders follow the exact
	// funnel/arc geometry instead of hand-tuned constants.
	const THIN_TYPE_TO_SPEC = {
		'track-straight': 'straight',
		'track-finish': 'straight',
		'track-checkpoint': 'straight',
		'track-start': 'straight',
		'track-start-finish': 'straight',
		'track-corner': 'corner',
		'track-checkpoint-corner': 'corner',
		'track-4-way': '4-way',
		'track-thin-straight': 'thin-straight',
		'track-thin-corner': 'thin-corner',
		'track-thin-3-way': 'thin-3-way',
		'track-thin-4-way': 'thin-4-way',
		'track-wide-thin': 'wide-thin',
		'track-wide-thin-corner': 'wide-thin-corner',
		'elevated-thin-straight': 'thin-straight',
		'elevated-thin-corner': 'thin-corner',
		'elevated-thin-3-way': 'thin-3-way',
		'elevated-thin-4-way': 'thin-4-way',
		'elevated-wide-thin': 'wide-thin',
		'elevated-wide-thin-corner': 'wide-thin-corner',
	};

	function addSpecWalls( gx, gz, orient = 0, specKey, centerY = wallY, wallHalfHeight = hHeight ) {

		const spec = THIN_WALL_SPECS[ specKey ];
		if ( ! spec ) return;
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const rad = ( ORIENT_DEG[ orient ] ?? 0 ) * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		for ( const seg of spec ) {

			const lx = seg[ 0 ], lz = seg[ 1 ];
			const hThk = seg[ 2 ] * S, hLen = seg[ 3 ] * S;
			const wx = cx + ( lx * cr + lz * sr ) * S;
			const wz = cz + ( - lx * sr + lz * cr ) * S;
			const total = rad + seg[ 4 ];
			const halfExtents = [ hThk, wallHalfHeight, hLen ];
			const position = [ wx, centerY, wz ];
			const quaternion = [ 0, Math.sin( total / 2 ), 0, Math.cos( total / 2 ) ];
			addWallBody( halfExtents, position, quaternion );

		}

	}

	// Build the road-piece wall hitbox at any Y level. This is deliberately
	// the SAME geometry used by the normal road blocks below; tunnel blocks
	// only change centerY, so a tunnel choke/corner/3-way/etc. is an exact
	// vertical copy of its normal counterpart.
	function addRoadTypeWallsAtHeight( gx, gz, roadType, orient = 0, centerY = wallY, wallHalfHeight = hHeight ) {

		const baseKey = roadType === 'track-bump' ? 'track-straight' : roadType;
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );

		if ( baseKey === 'track-straight' || baseKey === 'track-finish' || baseKey === 'track-checkpoint' || baseKey === 'track-start' || baseKey === 'track-start-finish' ) {

			for ( const side of [ - 1, 1 ] ) {

				const lx = side * WALL_X;
				const wx = cx + ( lx * cr ) * S;
				const wz = cz + ( - lx * sr ) * S;
				const halfExtents = [ hThick, wallHalfHeight, hLen ];
				const position = [ wx, centerY, wz ];
				const quaternion = [ 0, Math.sin( rad / 2 ), 0, Math.cos( rad / 2 ) ];
				addWallBody( halfExtents, position, quaternion );

			}

			return;
		}

		if ( baseKey === 'track-choke-half' ) {

			addChokeWalls( gx, gz, orient, [ - 1 ], centerY, wallHalfHeight );
			return;

		}
		if ( baseKey === 'track-choke-both' ) {

			addChokeWalls( gx, gz, orient, [ - 1, 1 ], centerY, wallHalfHeight );
			return;

		}
		if ( baseKey === 'track-choke-cross' ) {

			addChokeCrossWalls( gx, gz, orient, centerY, wallHalfHeight );
			return;

		}
		if ( baseKey === 'track-thin-straight' || baseKey === 'track-thin-corner' || baseKey === 'track-thin-3-way' || baseKey === 'track-thin-4-way' || baseKey === 'track-wide-thin' || baseKey === 'track-wide-thin-corner' ) {

			addSpecWalls( gx, gz, orient, THIN_TYPE_TO_SPEC[ baseKey ], centerY, wallHalfHeight );
			return;

		}
		if ( baseKey === 'track-corner' || baseKey === 'track-checkpoint-corner' ) {

			const wcx = cx + ( ARC_CENTER_X * cr + ARC_CENTER_Z * sr ) * S;
			const wcz = cz + ( - ARC_CENTER_X * sr + ARC_CENTER_Z * cr ) * S;
			const arcStart = - rad;
			addArcWall( wcx, wcz, arcStart, OUTER_R, OUTER_SEG, OUTER_SEG_HALF_LEN, centerY, wallHalfHeight );
			addArcWall( wcx, wcz, arcStart, INNER_R, INNER_SEG, INNER_SEG_HALF_LEN, centerY, wallHalfHeight );
			return;

		}
		if ( baseKey === 'track-3-way' ) {

			add3WayWalls( gx, gz, orient, centerY, wallHalfHeight );
			return;

		}
		if ( baseKey === 'track-4-way' ) {

			add4WayWalls( gx, gz, orient, centerY, wallHalfHeight );
			return;

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
				addWallBody( halfExtents, position, quaternion );

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

	function addElevatedCrossCornerSupport( gx, gz, orient = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const deg = ORIENT_DEG[ orient ] ?? 0;
		const rad = deg * Math.PI / 180;
		const cr = Math.cos( rad ), sr = Math.sin( rad );
		const supportTopY = groundY + ( CELL_HALF * S ) - SUPPORT_SINK - 0.12;
		const centerY = supportTopY - SUPPORT_HALF_HEIGHT;
		const armHalfLen = CELL_HALF - WALL_HALF_THICK;
		const armHalfThick = WALL_HALF_THICK;
		const arms = [
		{ lx: 0, lz: ( CELL_HALF - armHalfThick ), hx: armHalfLen, hz: armHalfThick },
		{ lx: -( CELL_HALF - armHalfThick ), lz: 0, hx: armHalfThick, hz: armHalfLen },
		];
		const yawQuat = [ 0, Math.sin( rad / 2 ), 0, Math.cos( rad / 2 ) ];
		for ( const arm of arms ) {

			const wx = cx + ( arm.lx * cr + arm.lz * sr ) * S;
			const wz = cz + ( - arm.lx * sr + arm.lz * cr ) * S;
			const halfExtents = [ arm.hx * S, SUPPORT_HALF_HEIGHT, arm.hz * S ];
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
		addWallBody( halfExtents, position, quaternion );

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

	function addSlopeSideWalls( gx, gz, orient = 0, geom = null ) {

		if ( ! geom ) geom = getSlopeGeometry( gx, gz, orient, null );
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const pitch = geom.angle;
		const shiftX = Math.sin( yaw ) * geom.shift;
		const shiftZ = Math.cos( yaw ) * geom.shift;
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( pitch, yaw, 0, 'YXZ' ) );
		const quaternion = [ quat.x, quat.y, quat.z, quat.w ];

		for ( const side of [ - 1, 1 ] ) {

			const localX = side * WALL_X * S;
			const offsetX = localX * Math.cos( yaw );
			const offsetZ = - localX * Math.sin( yaw );
			const halfExtents = [ hThick, ELEVATED_WALL_HALF_H, geom.halfLen ];
			const position = [ cx + shiftX + offsetX, geom.centerY + SLOPE_SIDE_WALL_RAISE, cz + shiftZ + offsetZ ];
			addWallBody( halfExtents, position, quaternion );

		}

	}

	function addSlopeCollider( gx, gz, orient = 0, up = true, elevatedMap = null ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
		const geom = getSlopeGeometry( gx, gz, orient, elevatedMap );
		const shiftX = Math.sin( yaw ) * geom.shift;
		const shiftZ = Math.cos( yaw ) * geom.shift;
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( up ? geom.angle : - geom.angle, yaw, 0, 'YXZ' ) );
		const halfExtents = [ ELEVATED_SURFACE_HALF_XZ, ELEVATED_SURFACE_HALF_H, geom.halfLen ];
		const position = [ cx + shiftX, geom.centerY, cz + shiftZ ];
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
		addSlopeSideWalls( gx, gz, orient, geom );
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
			addWallBody( halfExtents, position, quaternion );

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
	// floor so the car can drive in/out. PINNED SEAM MATH (mirrors
	// getSlopeGeometry above): the ramp is a DESCENDING tilted box whose high
	// end is local +z (the ground-road side, via the 180°-flipped yaw).
	//   - high edge pinned at the GROUND DRIVING PLANE (groundY + 0.01 — the top
	//     of the thick ground surface box, see createGroundSurfaceCollider in
	//     js/main.js) exactly at the cell boundary + a small overlap into the
	//     ground box → coplanar, sealed, zero lip
	//   - low edge pinned at the POOL FLOOR TOP (floor box top = groundY −
	//     0.34·cell + 0.04·S) exactly at the inner boundary + a small overlap
	//     into the floor box → coplanar, sealed
	// The old geometry centered a fixed-length box on the cell: its high edge
	// floated ~0.10 ABOVE the ground plane (a lip that popped the sphere both
	// entering and leaving the pool) and its low edge floated ~0.03 above the
	// pool floor (a step at the bottom). The half-thickness displacement term
	// hy·sin(angle) is applied to the box centre toward the ground side so the
	// pinned edges land exactly on the boundaries.
	const POOL_FLOOR_DROP = CELL_RAW * S * 0.34;
	const poolFloorBoxTop = groundY - POOL_FLOOR_DROP + 0.04 * S;
	const poolGroundTop = groundY + 0.01;
	const poolSlopeSpan = CELL_HALF * S + SLOPE_SEAM_OVERLAP;
	const poolSlopeRise = poolGroundTop - poolFloorBoxTop;
	const poolSlopeAngle = Math.atan2( poolSlopeRise, poolSlopeSpan * 2 );
	const poolSlopeHalfLen = Math.hypot( poolSlopeSpan, poolSlopeRise * 0.5 );
	const poolSlopeCenterY = ( poolGroundTop + poolFloorBoxTop ) * 0.5
		- ELEVATED_SURFACE_HALF_H * Math.cos( poolSlopeAngle );
	// The tilted half-thickness displaces the top-face edges; shift the box
	// centre hy·sin(angle) toward local +z (the ground side) to compensate.
	const poolSlopeShift = ELEVATED_SURFACE_HALF_H * Math.sin( poolSlopeAngle );
	// TUNNEL slope math: same ramp geometry, but the drop is the FULL tunnel
	// depth (5 units = elevated height, user order), not the shallow pool.
	const TUNNEL_FLOOR_DROP = CELL_RAW * S * 0.5;
	const tunnelFloorBoxTop = groundY - TUNNEL_FLOOR_DROP + 0.04 * S;
	const tunnelSlopeRise = poolGroundTop - tunnelFloorBoxTop;
	const tunnelSlopeAngle = Math.atan2( tunnelSlopeRise, poolSlopeSpan * 2 );
	const tunnelSlopeHalfLen = Math.hypot( poolSlopeSpan, tunnelSlopeRise * 0.5 );
	const tunnelSlopeCenterY = ( poolGroundTop + tunnelFloorBoxTop ) * 0.5
		- ELEVATED_SURFACE_HALF_H * Math.cos( tunnelSlopeAngle );
	const tunnelSlopeShift = ELEVATED_SURFACE_HALF_H * Math.sin( tunnelSlopeAngle );
	function addTunnelSlopeCollider( gx, gz, orient = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const flipOrient = ORIENT_180[ orient ] ?? orient;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ flipOrient ] ?? 0 );
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( - tunnelSlopeAngle, yaw, 0, 'YXZ' ) );
		const halfExtents = [ ELEVATED_SURFACE_HALF_XZ, ELEVATED_SURFACE_HALF_H, tunnelSlopeHalfLen ];
		const position = [ cx + Math.sin( yaw ) * tunnelSlopeShift, tunnelSlopeCenterY, cz + Math.cos( yaw ) * tunnelSlopeShift ];
		const quaternion = [ quat.x, quat.y, quat.z, quat.w ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position,
			quaternion,
			friction: 0.9,
			restitution: 0.0
		} );
		if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

	}
	function addPoolSlopeCollider( gx, gz, orient = 0 ) {

		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const flipOrient = ORIENT_180[ orient ] ?? orient;
		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ flipOrient ] ?? 0 );
		const quat = new THREE.Quaternion().setFromEuler( new THREE.Euler( - poolSlopeAngle, yaw, 0, 'YXZ' ) );
		const halfExtents = [ ELEVATED_SURFACE_HALF_XZ, ELEVATED_SURFACE_HALF_H, poolSlopeHalfLen ];
		const position = [ cx + Math.sin( yaw ) * poolSlopeShift, poolSlopeCenterY, cz + Math.cos( yaw ) * poolSlopeShift ];
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

	function addFlatElevatedSurfaceColliders( elevatedList ) {

		// One collider per flat elevated cell. The old greedy rectangle merge
		// (adjacent flat decks fused into single spanning boxes with a 3%
		// edgeOverhang) was a seam-clipping workaround. Seam clipping is now
		// fixed at the physics level, and the merged boxes caused their own
		// problems — one rect covered every cell in the run, including edges
		// hanging past blocks that shouldn't have them. Ground-level cells are
		// untouched (they were never merged).
		const half = CELL_HALF * S;
		for ( const entry of elevatedList ) {

			if ( ! Array.isArray( entry ) ) continue;
			const [ gxRaw, gzRaw, elevatedType ] = entry;
			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
			if ( ! FLAT_ELEVATED_TYPES.has( elevatedType ) ) continue;

			const halfExtents = [ half, ELEVATED_SURFACE_HALF_H, half ];
			// Pool Cross: the same deck collider, dropped to pool level (no
			// ELEVATED_HEIGHT lift) — it sits over the water, not above it.
			const surfaceY = elevatedType === 'pool-cross' ? elevatedSurfaceY - ELEVATED_HEIGHT : elevatedSurfaceY;
			const position = [ ( gx + 0.5 ) * CELL_RAW * S, surfaceY, ( gz + 0.5 ) * CELL_RAW * S ];
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
	// OPEN-TOP TUNNELS (user order 2026-09-28): a tunnel cell reuses the pool
	// bowl collider set — floor at the exact pool depth + bowl walls — a dry
	// pool. Car-in-water physics keys off extras.water elsewhere, so tunnels
	// stay dry.
	const waterEntries = extras && Array.isArray( extras.water ) ? extras.water : [];
	const tunnelEntriesForBowl = extras && Array.isArray( extras.tunnels ) ? extras.tunnels : [];
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
	// ── TUNNEL BOWL COLLIDERS (user order 2026-09-28) ──
	// Dedicated set at the FULL 5-unit depth (matching elevated height) —
	// NOT the shallow pool bowl. Floor at pit bottom, walls rim-flush to
	// floor, thin roof on closed tops (camera ceiling probe bows the chase
	// cam down into the tunnel, exactly like pool cross decks).
	const tunnelCellSet = new Set( tunnelEntriesForBowl.map( ( entry ) => `${ Number( entry[ 0 ] ) },${ Number( entry[ 1 ] ) }` ) );
	for ( const entry of tunnelEntriesForBowl ) {

		const gx = Number( entry[ 0 ] );
		const gz = Number( entry[ 1 ] );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const closedTop = Array.isArray( entry ) && entry.length >= 5 && entry[ 2 ] === 1;
		const cx = ( gx + 0.5 ) * CELL_RAW * S;
		const cz = ( gz + 0.5 ) * CELL_RAW * S;
		const floorHalfExtents = [ CELL_HALF * S, 0.04 * S, CELL_HALF * S ];
		rigidBody.create( world, {
			shape: box.create( { halfExtents: floorHalfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ cx, groundY - TUNNEL_FLOOR_DROP, cz ],
			friction: 0.25,
			restitution: 0.0
		} );
		if ( debugGroup ) addDebugBox( debugGroup, floorHalfExtents, [ cx, groundY - TUNNEL_FLOOR_DROP, cz ] );
		if ( closedTop ) {

			const roofHalfExtents = [ CELL_HALF * S, 0.05 * S, CELL_HALF * S ];
			rigidBody.create( world, {
				shape: box.create( { halfExtents: roofHalfExtents } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ cx, groundY + 0.01 - 0.05 * S, cz ],
				friction: 0.25,
				restitution: 0.0
			} );
			if ( debugGroup ) addDebugBox( debugGroup, roofHalfExtents, [ cx, groundY + 0.01 - 0.05 * S, cz ] );

		}
		const exitSide = poolSlopeExit.get( `${ gx },${ gz }` );
		const wallHalfH = TUNNEL_FLOOR_DROP * 0.5 + 0.05 * S;
		const sides = [ [ 0, - 1, 0, - CELL_HALF * S, 0 ], [ 1, 0, CELL_HALF * S, 0, Math.PI / 2 ], [ 0, 1, 0, CELL_HALF * S, 0 ], [ - 1, 0, - CELL_HALF * S, 0, Math.PI / 2 ] ];
		for ( const [ dx, dz, ox, oz, yaw ] of sides ) {
			if ( tunnelCellSet.has( `${ gx + dx },${ gz + dz }` ) ) continue;
			if ( exitSide === `${ dx },${ dz }` ) continue;
			const halfExtents = [ CELL_HALF * S, wallHalfH, CELL_RAW * S * 0.04 ];
			const quaternion = [ 0, Math.sin( yaw / 2 ), 0, Math.cos( yaw / 2 ) ];
			// Top flush with the ground surface; bottom buried below the pit
			// floor top — no lip, no gap, no seam between wall and floor.
			const position = [ cx + ox, groundY + 0.01 - wallHalfH, cz + oz ];
			rigidBody.create( world, { shape: box.create( { halfExtents } ), motionType: MotionType.STATIC, objectLayer: world._OL_STATIC, position, quaternion, friction: 0.9, restitution: 0.0 } );
			if ( debugGroup ) addDebugBox( debugGroup, halfExtents, position, quaternion );

		}

	}
	// Slope-up pit blocks ARE ramps (pit floor → surface): the proven
	// tunnel-slope ramp collider, centered on the block cell.
	for ( const rampEntry of ( extras && Array.isArray( extras.tunnels ) ? extras.tunnels : [] ) ) {

		if ( ! Array.isArray( rampEntry ) || rampEntry.length < 5 || rampEntry[ 4 ] !== 'slope-up' ) continue;
		addTunnelSlopeCollider( Number( rampEntry[ 0 ] ), Number( rampEntry[ 1 ] ), Number( rampEntry[ 3 ] ) || 0 );

	}
	// Tunnel road-piece walls are exact vertical copies of the normal road
	// piece: same X/Z geometry, same orientation, same wall height. The ONLY
	// difference is that the complete wall set is translated to the tunnel floor.
	const tunnelWallY = wallY - TUNNEL_FLOOR_DROP;
	for ( const roadEntry of ( extras && Array.isArray( extras.tunnels ) ? extras.tunnels : [] ) ) {

		if ( ! Array.isArray( roadEntry ) || roadEntry.length < 5 ) continue;
		const tunnelType = roadEntry[ 4 ];
		if ( typeof tunnelType !== 'string' || tunnelType === 'slope-up' ) continue;
		addRoadTypeWallsAtHeight(
			Number( roadEntry[ 0 ] ),
			Number( roadEntry[ 1 ] ),
			tunnelType,
			Number( roadEntry[ 3 ] ) || 0,
			tunnelWallY,
			hHeight
		);

	}
	// Tunnel slopes: same exit-side mapping (SEPARATE data key from pool slopes).
	if ( Array.isArray( extras?.tunnelSlopes ) ) {
		for ( const [ gx, gz, orient = 0 ] of extras.tunnelSlopes ) {
			const rad = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] ?? 0 );
			const dx = - Math.round( Math.sin( rad ) );
			const dz = - Math.round( Math.cos( rad ) );
			poolSlopeExit.set( `${ Number( gx ) },${ Number( gz ) }`, `${ dx },${ dz }` );
		}
	}
	// Pool Cross cells: the block deck seals the whole cell at ground level
	// and its own walls are the boundary, so the pool bowl wall collider on
	// every ground-facing side of the cell is skipped — the same trust the
	// pool slope's exit side already gets.
	const poolCrossCells = new Set();
	for ( const [ gx, gz, elevatedType ] of elevatedEntries ) {

		if ( elevatedType === 'pool-cross' ) poolCrossCells.add( `${ Number( gx ) },${ Number( gz ) }` );

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
			if ( poolCrossCells.has( `${ gx },${ gz }` ) ) continue;
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

		addRoadTypeWallsAtHeight( gx, gz, baseKey, orient, wallY, hHeight );

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

	addFlatElevatedSurfaceColliders( elevatedEntries );

	for ( const [ gx, gz, elevatedType, orient = 0 ] of elevatedEntries ) {

		if ( ! Number.isFinite( Number( gx ) ) || ! Number.isFinite( Number( gz ) ) ) continue;
		const normalizedType = elevatedType === 'slope-down' ? 'slope-up' : elevatedType;
		const normalizedOrient = elevatedType === 'slope-down' ? ( ORIENT_180[ orient ] ?? orient ) : orient;
		const nx = Number( gx );
		const nz = Number( gz );
		// The elevated-corner support pillar is curved (matching the corner mesh),
		// so the generic full-square support box is skipped for corners and rebuilt
		// by addElevatedCornerSupport() as an L-shaped + outer-arc footprint below.
		if ( normalizedType !== 'slope-up' && normalizedType !== 'elevated-corner' && normalizedType !== 'elevated-cross' && normalizedType !== 'elevated-cross-corner' && normalizedType !== 'pool-cross' ) addElevatedSupportCollider( nx, nz );
		if ( normalizedType === 'slope-up' ) {

			addSlopeCollider( nx, nz, normalizedOrient, true, elevatedMap );
			continue;

		}
		if ( normalizedType === 'elevated-straight' || normalizedType === 'elevated-checkpoint' ) {

			addElevatedRoadWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-choke-half' || normalizedType === 'elevated-choke-both' ) {

			// Same choke wall colliders at the elevated deck height; the
			// generic big support rectangle below the deck is added above.
			addChokeWalls( nx, nz, normalizedOrient, normalizedType === 'elevated-choke-both' ? [ - 1, 1 ] : [ - 1 ], elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-choke-cross' ) {

			// Pinwheel block, elevated variant: 4 diagonal corner walls at
			// deck height (support box + flat driving-deck surface are both
			// generic — added above / via FLAT_ELEVATED_TYPES respectively).
			addChokeCrossWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-thin-straight' || normalizedType === 'elevated-thin-corner' || normalizedType === 'elevated-thin-3-way' || normalizedType === 'elevated-thin-4-way' || normalizedType === 'elevated-wide-thin' || normalizedType === 'elevated-wide-thin-corner' ) {

			// Thin / transition blocks, elevated variant: spec walls at deck
			// height (support box + flat driving-deck surface are generic —
			// added above / via FLAT_ELEVATED_TYPES respectively).
			addSpecWalls( nx, nz, normalizedOrient, THIN_TYPE_TO_SPEC[ normalizedType ], elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-cross' ) {

			addElevatedRoadWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			const throughOrient = { 0: 16, 10: 22, 16: 0, 22: 10 }[ normalizedOrient ] ?? normalizedOrient;
			addElevatedRoadWalls( nx, nz, throughOrient, wallY, hHeight );
			continue;

		}
		if ( normalizedType === 'pool-cross' ) {

			// Pool Cross: the elevated-cross hitbox set dropped to pool level.
			// Deck walls (road direction) land exactly on the normal ground
			// wall line. The two underpass walls (perpendicular, the
			// "bottom" pair) follow the block down by ELEVATED_HEIGHT so
			// they line up with the submerged underpass opening, and they
			// are 2.5x taller than a standard ground wall. Raised 2 units
			// from the original sunken position per user tuning.
			addElevatedRoadWalls( nx, nz, normalizedOrient, wallY, ELEVATED_WALL_HALF_H );
			const throughOrient = { 0: 16, 10: 22, 16: 0, 22: 10 }[ normalizedOrient ] ?? normalizedOrient;
			addElevatedRoadWalls( nx, nz, throughOrient, wallY - ELEVATED_HEIGHT + 2, hHeight * 2.5 );
			continue;

		}
		if ( normalizedType === 'elevated-corner' ) {

			addElevatedCornerSupport( nx, nz, normalizedOrient );
			addElevatedCornerWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-checkpoint-corner' ) {

			// Same deck-height corner walls as an elevated corner, but keep the
			// generic SQUARE support box (added above) — the corner-checkpoint
			// GLB carries its own square support visually, so no curved pillar.
			addElevatedCornerWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			continue;

		}
		if ( normalizedType === 'elevated-cross-corner' ) {

			addElevatedCrossCornerSupport( nx, nz, normalizedOrient );
			addElevatedCornerWalls( nx, nz, normalizedOrient, elevatedWallY, ELEVATED_WALL_HALF_H );
			const bottomOrient = ORIENT_180[ normalizedOrient ] ?? normalizedOrient;
			addElevatedCornerWalls( nx, nz, bottomOrient, wallY, hHeight );
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
	// Tunnel slopes: dedicated 5-unit ramp colliders (separate data).
	const tunnelSlopeEntries = extras && Array.isArray( extras.tunnelSlopes ) ? extras.tunnelSlopes : [];
	for ( const [ gxRaw, gzRaw, orient = 0 ] of tunnelSlopeEntries ) {

		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		addTunnelSlopeCollider( gx, gz, orient );

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

	if ( wallBoostWasActive ) setWallHeightBoost( true );
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
		// The physics engine's default max angular velocity is .25*PI*60
		// = 47.12 rad/s — the ball could never roll faster than ~17 u/s
		// (~50-64 mph), silently eating every speed boost (pads, hacks,
		// engine upgrades past ~1.8). Lift it well past the rolling speed
		// any reachable top speed needs (~640 rad/s at the 10x pad cap)
		// while keeping a finite safety net against tumble explosions.
		maxAngularVelocity: 2000,
		gravityFactor: 1.5,
		motionQuality: MotionQuality.LINEAR_CAST,
	} );

	return body;

}
