/**
 * SkidMarks.js — tire skid marks laid on the road while drifting.
 *
 * Behavior:
 *   - Marks are emitted ONLY while the car is actually drifting. The trigger
 *     mirrors the skid smoke (Particles.js): enough speed + driftIntensity
 *     above the threshold, so marks and smoke appear together from the exact
 *     same rear wheels (wheelBL / wheelBR world positions).
 *   - Each rear tire draws its own strip: every frame a small flat quad is
 *     stamped between the tire's previous and current contact position.
 *   - Teleports (race restart, checkpoint respawn, track reset) are detected
 *     per tire — if a tire jumps further than TELEPORT_BREAK_UNITS in one
 *     frame, the strip is BROKEN instead of connecting. This is what prevents
 *     the classic "line from wherever you were back to the start block"
 *     artifact the instant the car snaps back to spawn.
 *   - Rendering uses a single InstancedMesh ring buffer: fixed budget, no
 *     allocations per frame, oldest marks silently recycled. The quads follow
 *     the 3D path of the tire (they bank through jumps/slopes) and sit just
 *     above the road via a small lift + polygon offset to avoid z-fighting.
 *
 *   - Airborne suppression: if a `groundTest( vehicle, contactPoint )` callback
 *     is supplied, each rear tire also probes for ground contact (the game
 *     passes a real crashcat physics raycast against the static track — no
 *     height checks). An airborne tire breaks its trail; landing re-anchors.
 *
 * Public API:
 *   new SkidMarks( scene, options )   — options: { maxSegments, width, color, opacity, groundTest }
 *   update( dt, vehicle )             — call once per frame per vehicle
 *   clear()                           — erase all marks (track switch)
 *   setQuality( options )             — { maxSegments } adjusts the budget
 *   dispose( scene )                  — remove from scene
 */
import * as THREE from 'three';

const DEFAULT_MAX_SEGMENTS = 1400;
const DRIFT_MIN_SPEED = 0.25;        // |linearSpeed| — matches Audio.js skid sfx
const DRIFT_MIN_INTENSITY = 0.62;    // matches Particles.js drift smoke
const TELEPORT_BREAK_UNITS = 3.0;    // per-frame jump that means "snapped" (legit top speed is <1 unit/frame)
const MIN_SEGMENT_LENGTH = 0.05;    // below this, wait for more movement
const SEGMENT_LIFT = 0.02;           // sit just above the road surface
const ZERO_MATRIX = new THREE.Matrix4().makeScale( 0, 0, 0 );

const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _tmpSize = new THREE.Vector3();
const _tmpDir = new THREE.Vector3();
const _tmpSide = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
const _tmpMid = new THREE.Vector3();
const _tmpMat = new THREE.Matrix4();
const _tmpBox = new THREE.Box3();

export class SkidMarks {

	constructor( scene, options = {} ) {

		this.scene = scene;
		this.maxSegments = Math.max( 64, Math.floor( Number( options.maxSegments ) || DEFAULT_MAX_SEGMENTS ) );
		this.width = Math.max( 0.05, Number( options.width ) || 0.32 );
		this.opacity = THREE.MathUtils.clamp( Number( options.opacity ?? 0.42 ), 0.05, 1 );
		this.enabled = options.enabled !== false;
		// Optional grounded probe: ( vehicle, contactPoint ) => boolean.
		// When provided, marks are only laid while the tire actually touches
		// ground (real raycast/collision test supplied by the game).
		this.groundTest = typeof options.groundTest === 'function' ? options.groundTest : null;

		// Flat unit quad: X = strip width, Z = strip length.
		const geometry = new THREE.PlaneGeometry( 1, 1 );
		geometry.rotateX( - Math.PI / 2 );

		const material = new THREE.MeshBasicMaterial( {
			color: new THREE.Color( options.color || '#101014' ),
			transparent: true,
			opacity: this.opacity,
			depthWrite: false,
			polygonOffset: true,
			polygonOffsetFactor: - 4,
			polygonOffsetUnits: - 4,
		} );

		this.mesh = new THREE.InstancedMesh( geometry, material, this.maxSegments );
		this.mesh.frustumCulled = false;
		this.mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		this.mesh.renderOrder = 1;
		for ( let i = 0; i < this.maxSegments; i ++ ) this.mesh.setMatrixAt( i, ZERO_MATRIX );

		// Ring-buffer cursor + per-vehicle trail state.
		this.cursor = 0;
		this.trails = new Map();
		// wheel node -> cached contact radius (distance from axle to tread).
		this.wheelRadii = new Map();

		scene.add( this.mesh );

	}

	/**
	 * Graphics preset hook. `{ maxSegments: 0 }` disables marks entirely;
	 * a missing/undefined budget keeps the current pool (just re-enables).
	 */
	setQuality( options = {} ) {

		if ( options.maxSegments === 0 ) {

			this.enabled = false;
			return;

		}
		this.enabled = true;
		const maxSegments = Math.floor( Number( options.maxSegments ) || 0 );
		if ( maxSegments <= 0 || maxSegments === this.maxSegments ) return;

		this.dispose( this.scene );
		this.maxSegments = Math.max( 64, maxSegments );
		this.cursor = 0;
		this.trails.clear();
		this.mesh = this._rebuildMesh();
		this.scene.add( this.mesh );

	}

	_rebuildMesh() {

		const geometry = new THREE.PlaneGeometry( 1, 1 );
		geometry.rotateX( - Math.PI / 2 );
		const mesh = new THREE.InstancedMesh( geometry, this.mesh.material, this.maxSegments );
		mesh.frustumCulled = false;
		mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		mesh.renderOrder = 1;
		for ( let i = 0; i < this.maxSegments; i ++ ) mesh.setMatrixAt( i, ZERO_MATRIX );
		return mesh;

	}

	/** Erase all marks and break every trail. */
	clear() {

		for ( let i = 0; i < this.maxSegments; i ++ ) this.mesh.setMatrixAt( i, ZERO_MATRIX );
		this.mesh.instanceMatrix.needsUpdate = true;
		this.cursor = 0;
		this.trails.clear();

	}

	/** Break a vehicle's strips without erasing existing marks. */
	breakVehicleTrail( vehicle ) {

		if ( vehicle ) this.trails.delete( vehicle );

	}

	dispose( scene ) {

		const target = scene || this.scene;
		target.remove( this.mesh );
		this.mesh.geometry.dispose();

	}

	// ---- internals -------------------------------------------------------------

	_trailState( vehicle ) {

		let state = this.trails.get( vehicle );
		if ( ! state ) {

			state = { left: null, right: null };
			this.trails.set( vehicle, state );

		}
		return state;

	}

	_wheelContactRadius( wheelNode ) {

		let radius = this.wheelRadii.get( wheelNode );
		if ( radius === undefined ) {

			_tmpBox.setFromObject( wheelNode );
			// NOTE: must NOT reuse _tmpVecA here — the tire contact point is
			// already stored in it by _tireContactPoint (this exact aliasing bug
			// corrupted the first segment of every trail before the fix).
			const size = _tmpBox.getSize( _tmpSize );
			radius = Math.max( 0.05, size.y * 0.5 );
			this.wheelRadii.set( wheelNode, radius );

		}
		return radius;

	}

	/**
	 * World-space contact point of a rear tire. Uses the actual wheel node when
	 * the model has one (wheelBL/wheelBR); otherwise falls back to a sensible
	 * offset behind the car's center.
	 */
	_tireContactPoint( vehicle, wheelNode, sideSign, out ) {

		if ( wheelNode ) {

			wheelNode.getWorldPosition( out );
			out.y -= this._wheelContactRadius( wheelNode );

		} else {

			// Fallback: rear axle, half a car-width to the side.
			out.copy( vehicle.container.position );
			_tmpDir.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ); // forward
			_tmpSide.set( 1, 0, 0 ).applyQuaternion( vehicle.container.quaternion ); // right
			out.addScaledVector( _tmpDir, - 0.95 );
			out.addScaledVector( _tmpSide, 0.55 * sideSign );

		}
		return out;

	}

	_stampSegment( from, to ) {

		const length = _tmpDir.subVectors( to, from ).length();
		if ( length < 1e-4 ) return;
		_tmpDir.divideScalar( length );

		// Basis: X = strip width, Y = surface normal-ish, Z = travel direction.
		_tmpSide.set( 0, 1, 0 ).cross( _tmpDir );
		if ( _tmpSide.lengthSq() < 1e-6 ) _tmpSide.set( 1, 0, 0 ); // pure vertical — degenerate
		else _tmpSide.normalize();
		_tmpUp.crossVectors( _tmpDir, _tmpSide ).normalize();

		_tmpMid.addVectors( from, to ).multiplyScalar( 0.5 );
		_tmpMid.y += SEGMENT_LIFT;

		_tmpMat.makeBasis(
			_tmpSide.multiplyScalar( this.width ),
			_tmpUp,
			_tmpDir.multiplyScalar( length )
		);
		_tmpMat.setPosition( _tmpMid );

		this.mesh.setMatrixAt( this.cursor, _tmpMat );
		this.cursor = ( this.cursor + 1 ) % this.maxSegments;
		this.mesh.instanceMatrix.needsUpdate = true;

	}

	/**
	 * Real ground probe for one tire — only paid while actually drifting.
	 * No height checks: the game supplies a physics raycast against the static
	 * track, so marks can never be laid while airborne (jumps, trick pads).
	 */
	_isGrounded( vehicle, contactPoint ) {

		if ( ! this.groundTest ) return true;
		return this.groundTest( vehicle, contactPoint ) !== false;

	}

	_updateTire( previousPoint, currentPoint, drifting ) {

		if ( ! drifting ) return null; // trail broken — next drift starts fresh
		if ( ! previousPoint ) {

			return currentPoint.clone(); // trail starts — anchor, no mark yet

		}

		const jump = _tmpVecB.subVectors( currentPoint, previousPoint ).length();
		if ( jump > TELEPORT_BREAK_UNITS ) {

			// Teleport/restart snap: break the trail instead of drawing a
			// straight line all the way back to the start block.
			return currentPoint.clone();

		}
		if ( jump >= MIN_SEGMENT_LENGTH ) {

			this._stampSegment( previousPoint, currentPoint );
			return currentPoint.clone();

		}
		return previousPoint;

	}

	update( dt, vehicle ) {

		if ( ! this.enabled || ! vehicle || ! vehicle.container ) return;

		const drifting = Math.abs( vehicle.linearSpeed || 0 ) > DRIFT_MIN_SPEED
			&& ( vehicle.driftIntensity || 0 ) > DRIFT_MIN_INTENSITY;

		const state = this._trailState( vehicle );

		// Left rear tire: drift gate, then a real ground probe (if supplied) —
		// airborne tires never stamp, they break their trail until landing.
		this._tireContactPoint( vehicle, vehicle.wheelBL, - 1, _tmpVecA );
		const leftActive = drifting && this._isGrounded( vehicle, _tmpVecA );
		state.left = this._updateTire( state.left, _tmpVecA, leftActive );

		this._tireContactPoint( vehicle, vehicle.wheelBR, 1, _tmpVecA );
		const rightActive = drifting && this._isGrounded( vehicle, _tmpVecA );
		state.right = this._updateTire( state.right, _tmpVecA, rightActive );

	}

}
