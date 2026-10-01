import * as THREE from 'three';

function lerpAngle( a, b, t ) {

	let d = b - a;
	while ( d > Math.PI ) d -= Math.PI * 2;
	while ( d < - Math.PI ) d += Math.PI * 2;
	return a + d * t;

}

export class Camera {

	constructor() {

		this.camera = new THREE.PerspectiveCamera( 42, window.innerWidth / window.innerHeight, 0.1, 500 );

		this.offset = new THREE.Vector3( 7.0, 7.1, 7.0 );
		this.chaseOffset = new THREE.Vector3( 0, 2.3, - 6.6 );
		// Keep the pool framing high and dry. This is intentionally a steeper,
		// closer angle than normal chase mode, so a submerged car remains easy
		// to see without moving the camera through the water surface.
		this.underwaterChaseOffset = new THREE.Vector3( 0, 7.4, - 3.2 );
		this.underwaterOverviewOffset = new THREE.Vector3( 3.6, 8.6, 3.6 );
		// World Y of the water plane (main.js passes its WATER_SURFACE_Y in
		// the dynamics object each frame).
		this.waterSurfaceY = 0.12;
		this.targetPosition = new THREE.Vector3();
		this.lookTarget = new THREE.Vector3();
		this.mode = 'chase';
		this._desiredPos = new THREE.Vector3();
		this._desiredLook = new THREE.Vector3();
		this._forward = new THREE.Vector3();
		this._rotatedOffset = new THREE.Vector3();
		this._upAxis = new THREE.Vector3( 0, 1, 0 );
		this.chaseYaw = 0;
		this.hasChaseYaw = false;
		this.underwaterBlend = 0;
		// User-tunable camera params (set by mod api). Defaults preserve original feel.
		this.userDistance = null;
		this.userHeight = null;
		this.userPitch = 0;
		this.userLagScale = 1;
		// Hitbox clip probe: ( origin, dir, length ) => freeLength.
		// Sweeps the camera volume through static physics geometry in every
		// driving camera mode. null = off (intentional free/replay cameras).
		this.clipProbe = null;
		// Sphere-overlap verifier for the eased clip pull-in (see constrainPosition).
		this.overlapProbe = null;
		// Current eased allowed distance along the clip ray; null when unconstrained.
		this._clipAllow = null;
		// Ceiling probe (chase cam): ( origin, upLength ) => freeUpLength.
		// Supplied by main.js — a straight-up physics raycast. When a static
		// ceiling hangs right above the car (pool cross deck, low bridges),
		// the camera's height clamps under it instead of rising past the
		// block and getting covered by its top. null = off.
		this.ceilingProbe = null;
		// Straight-down probe (chase cam): ( origin, downLength ) => freeDown.
		// Reports clearance to the first surface under the car.
		this.floorProbe = null;
		// Smoothed ceiling-clamp height (see _applyCeilingClamp): null while
		// the framing sits at its natural offset height.
		this._ceilEase = null;
		this.carInWater = false;
		this._ceilingClamped = false;
		this._submergedFraming = false;
		this._clipDir = new THREE.Vector3();
		this._clipProbeTmp = new THREE.Vector3();
		this._clipAnchor = new THREE.Vector3();

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	toggleMode() {

		// chase -> locked (rigid mount) -> overview -> chase
		this.mode = this.mode === 'chase' ? 'locked' : this.mode === 'locked' ? 'overview' : 'chase';
		if ( this.mode !== 'chase' ) this.hasChaseYaw = false;

	}

	getMode() {

		return this.mode;

	}

	// Ceiling clamp (chase cam): when a static ceiling hangs right above
	// the car (pool cross deck, low bridges), pull the camera's height
	// down under it. Under water, the camera is additionally kept BELOW
	// the water surface — riding above the water/deck line puts the
	// block's top between the camera and the car and the view is covered.
	// Downward only: never raises the camera above its desired offset.
	_applyCeilingClamp( camScale, dt ) {

		this._ceilingClamped = false;
		if ( ! this.ceilingProbe || this._rotatedOffset.y <= 0 ) return;
		const wantUp = this._rotatedOffset.y + 0.45;
		const upFree = this.ceilingProbe( this.targetPosition, wantUp );
		if ( upFree >= wantUp ) {

			// No ceiling overhead: ease the framing height back UP to its
			// natural offset instead of springing a whole-units step the frame
			// the car leaves the roof - entering/leaving low roofs read as a
			// camera teleport (user report 2026-10-01).
			if ( this._ceilEase != null ) {

				const eased = this._ceilEase + ( this._rotatedOffset.y - this._ceilEase ) * Math.min( 1, ( dt || 1 / 60 ) * 7 );
				this._ceilEase = eased >= this._rotatedOffset.y - 1e-4 ? null : eased;
				this._rotatedOffset.y = this._ceilEase ?? this._rotatedOffset.y;

			}
			return;

		}
		// The ceiling is authoritative: the camera must sit BELOW it, even
		// when that puts it below the car (a bumper-height shot looking up
		// through the gap beats a camera parked inside a deck). Under
		// water the floor stays permissive so it never pushes the camera
		// back up through the slab; on dry land keep bumper height.
		let clampedY = upFree - 0.45;
		const minY = this.underwaterBlend > 0 ? - 0.9 * camScale : 0.25 * camScale;
		clampedY = Math.max( clampedY, minY );
		if ( clampedY < this._rotatedOffset.y ) {

			// Ease INTO the clamp (fast, hard-floored at clampedY) so the framing
			// descends over ~0.1s instead of teleporting the frame the car
			// crosses under a roof edge. The floor keeps the deck-sandwich
			// guarantee: the eased height never sits above the true clamp.
			const from = this._ceilEase ?? this._rotatedOffset.y;
			const eased = from + ( clampedY - from ) * Math.min( 1, ( dt || 1 / 60 ) * 24 );
			this._ceilEase = Math.max( clampedY, eased );
			this._rotatedOffset.y = this._ceilEase;
			this._ceilingClamped = true;
			if ( this.targetPosition.y + this._rotatedOffset.y < this.waterSurfaceY ) this._submergedFraming = true;

		}

	}

	// Run AFTER smoothing (and again after screen shake at render time).
	// Use the real car, not the lagging aim point: at corners that point
	// can be on the other side of the wall even when the car is inside.
	constrainPosition( position = this.camera.position, dt = 0 ) {

		if ( ! this.clipProbe ) return;
		this._clipDir.subVectors( position, this._clipAnchor );
		const length = this._clipDir.length();
		if ( length <= 1e-6 ) return;
		this._clipDir.divideScalar( length );
		const free = this.clipProbe( this._clipAnchor, this._clipDir, length );
		if ( free >= length ) {

			// Clear line of sight: release any eased pull (the chase lerp then
			// eases the camera back out smoothly).
			if ( position === this.camera.position ) this._clipAllow = null;
			return;

		}
		const clampedFree = Math.max( 0, free );
		if ( dt <= 0 || ! this.overlapProbe ) {

			// Hard safety pass. Only the LIVE camera position manages the ease
			// state (the mid-update pass constrains the desired point and must
			// not reset the pull-in progress every frame). While an eased pull
			// is in flight the camera rides at the verified eased distance -
			// only a displacement beyond it (shake, respawn) gets hard-snapped.
			const isLiveCamera = position === this.camera.position;
			if ( isLiveCamera && this._clipAllow != null && length <= this._clipAllow + 0.05 ) return;
			if ( isLiveCamera ) this._clipAllow = null;
			position.copy( this._clipAnchor ).addScaledVector( this._clipDir, clampedFree );
			return;

		}
		// Eased pull-in (runs once per update on the live camera position):
		// when a wall suddenly covers the camera, slide in over ~0.1-0.2s
		// instead of teleporting. The camera may lag BEYOND the hard limit only
		// while the lag spot is verified clear by the sphere-overlap probe - if
		// it would sit inside geometry, snap instantly (never clip).
		const CLIP_PULL_RATE = 20; // units/s max closing speed
		const prev = this._clipAllow ?? length;
		let allowed = Math.max( clampedFree, prev - CLIP_PULL_RATE * dt );
		allowed = Math.min( allowed, length );
		if ( allowed > clampedFree + 1e-4 ) {

			this._clipProbeTmp.copy( this._clipAnchor ).addScaledVector( this._clipDir, allowed );
			if ( ! this.overlapProbe( this._clipProbeTmp ) ) allowed = clampedFree;

		}
		this._clipAllow = allowed >= length - 1e-4 ? null : allowed;
		if ( allowed < length ) position.copy( this._clipAnchor ).addScaledVector( this._clipDir, allowed );

	}

	update( dt, target, targetQuaternion, dynamics = {} ) {

		this._clipAnchor.copy( target );
		// Raise the sweep origin well above low road-edge hitboxes: they never
		// block the view (the camera rides 2+ units up) but the sweep sphere
		// grazed them near the car and triggered phantom pull-ins
		// ("probe hits the edge of the road but that is not even in the way",
		// user report 2026-10-01).
		this._clipAnchor.y += 1.0;

		const speedRatio = THREE.MathUtils.clamp( Number( dynamics.speedRatio ) || 0, 0, 1.8 );
		const driftAmount = THREE.MathUtils.clamp( Number( dynamics.driftIntensity ) || 0, 0, 1 );
		const underwaterTarget = dynamics.underwaterCamera ? 1 : 0;
		// Snappy blend in BOTH directions — a slow 0.7s ease made the
		// water↔normal transition feel laggy and kept the cam bobbing at
		// the surface for seconds after the car dove.
		this.underwaterBlend = THREE.MathUtils.lerp(
			this.underwaterBlend,
			underwaterTarget,
			Math.min( 1, dt / 0.16 )
		);
		if ( Number.isFinite( Number( dynamics.waterSurfaceY ) ) ) this.waterSurfaceY = Number( dynamics.waterSurfaceY );
		this.carInWater = dynamics.carInWater === true;
		this._submergedFraming = false;
		// World-scale feel: when the car grows or shrinks (mega/mini size
		// pads, custom mods), the camera rides with it — same car framing,
		// and the WORLD reads bigger (mini) or smaller (mega) around it.
		const vehicleScale = THREE.MathUtils.clamp( Number( dynamics.vehicleScale ) || 1, 0.35, 2.5 );
		// Tiny car = MACRO lens: zoom in FURTHER than proportional so the
		// surroundings loom and the read is "toy car in a huge world" (the
		// tilt-shift overlay in main.js completes the diorama look). Mega
		// stays exactly proportional.
		const camScale = vehicleScale < 1 ? Math.pow( vehicleScale, 1.4 ) : vehicleScale;
		const underwaterLift = this.underwaterBlend;
		const targetLerp = this.mode === 'chase' ? 10 : 6;
		this.targetPosition.lerp( target, Math.min( 1, dt * targetLerp ) );

		if ( this.mode === 'locked' ) {

			// RIGID mount: the camera is welded behind the car. No lerp on
			// position, no yaw smoothing, no fov speed effects — it is
			// exactly target + fixed rotated offset, every frame.
			if ( targetQuaternion ) {

				this._forward.set( 0, 0, 1 ).applyQuaternion( targetQuaternion );
				this._forward.y = 0;
				if ( this._forward.lengthSq() < 1e-5 ) this._forward.set( 0, 0, 1 );
				this._forward.normalize();

			} else this._forward.set( 0, 0, 1 );
			const yaw = Math.atan2( this._forward.x, this._forward.z );
			this.targetPosition.copy( target );
			this._rotatedOffset.copy( this.chaseOffset ).lerp( this.underwaterChaseOffset, underwaterLift ).applyAxisAngle( this._upAxis, yaw );
			if ( camScale !== 1 ) this._rotatedOffset.multiplyScalar( camScale );
			this._applyCeilingClamp( camScale, dt );
			this._desiredPos.copy( this.targetPosition ).add( this._rotatedOffset );
			this.constrainPosition( this._desiredPos );
			this.camera.position.copy( this._desiredPos );
			this._desiredLook.copy( this.targetPosition ).addScaledVector( this._forward, THREE.MathUtils.lerp( 4.8, 0.8, underwaterLift ) * camScale );
			this._desiredLook.y += THREE.MathUtils.lerp( 1.0, 0.45, underwaterLift ) * camScale;
			this.lookTarget.copy( this._desiredLook );
			if ( this.camera.fov !== 42 ) {

				this.camera.fov = 42;
				this.camera.updateProjectionMatrix();

			}
			this.camera.lookAt( this.lookTarget );

		} else if ( this.mode === 'chase' && targetQuaternion ) {

			this._forward.set( 0, 0, 1 ).applyQuaternion( targetQuaternion );
			this._forward.y = 0;
			if ( this._forward.lengthSq() < 1e-5 ) this._forward.set( 0, 0, 1 );
			this._forward.normalize();

			const targetYaw = Math.atan2( this._forward.x, this._forward.z );
			if ( ! this.hasChaseYaw ) {

				this.chaseYaw = targetYaw;
				this.hasChaseYaw = true;

			} else {

				this.chaseYaw = lerpAngle( this.chaseYaw, targetYaw, Math.min( 1, dt * 8 ) );

			}

			this._rotatedOffset.copy( this.chaseOffset ).lerp( this.underwaterChaseOffset, underwaterLift ).applyAxisAngle( this._upAxis, this.chaseYaw );
			// Apply mod-tunable distance / height / pitch on top of the base offset.
			if ( this.userDistance != null ) { const len = this._rotatedOffset.length() || 6.6; this._rotatedOffset.multiplyScalar( Math.max( 0.2, this.userDistance ) / len ); }
			if ( this.userHeight != null ) this._rotatedOffset.y = this.userHeight;
			if ( this.userPitch ) this._rotatedOffset.applyAxisAngle( new THREE.Vector3( 1, 0, 0 ), this.userPitch );
			if ( camScale !== 1 ) this._rotatedOffset.multiplyScalar( camScale );
			this._applyCeilingClamp( camScale, dt );
			this._desiredPos.copy( this.targetPosition ).add( this._rotatedOffset );

			// Pull the desired framing forward before smoothing; the final
			// render position is constrained again at the end of update.
			this.constrainPosition( this._desiredPos );

			this._forward.set( Math.sin( this.chaseYaw ), 0, Math.cos( this.chaseYaw ) );
			// Bring the aim point in as the camera rises, giving pools the
			// requested higher-angle view of the car.
			this._desiredLook.copy( this.targetPosition ).addScaledVector( this._forward, THREE.MathUtils.lerp( 4.8, 0.8, underwaterLift ) * camScale );
			this._desiredLook.y += THREE.MathUtils.lerp( 1.0, 0.45, underwaterLift ) * camScale;

			const chaseLag = THREE.MathUtils.lerp( 10, 7.2, Math.min( 1, speedRatio * 0.8 + driftAmount * 0.4 ) ) * this.userLagScale;
			this.camera.position.lerp( this._desiredPos, Math.min( 1, dt * chaseLag ) );
			this.lookTarget.lerp( this._desiredLook, dt * 8 );
			const targetFov = 42 + ( speedRatio * 6.5 ) + ( driftAmount * 1.5 );
			this.camera.fov = THREE.MathUtils.lerp( this.camera.fov, targetFov, Math.min( 1, dt * 3.5 ) );
			this.camera.updateProjectionMatrix();
			this.camera.lookAt( this.lookTarget );

		} else {

			this._rotatedOffset.copy( this.offset ).lerp( this.underwaterOverviewOffset, underwaterLift );
			if ( camScale !== 1 ) this._rotatedOffset.multiplyScalar( camScale );
			this._applyCeilingClamp( camScale, dt );
			this._desiredPos.copy( this.targetPosition ).add( this._rotatedOffset );
			this.constrainPosition( this._desiredPos );
			this.camera.position.lerp( this._desiredPos, Math.min( 1, dt * 8 ) );
			this._desiredLook.copy( this.targetPosition );
			this.lookTarget.lerp( this._desiredLook, dt * 10 );
			this.camera.fov = THREE.MathUtils.lerp( this.camera.fov, 42, Math.min( 1, dt * 4 ) );
			this.camera.updateProjectionMatrix();
			this.camera.lookAt( this.lookTarget );

		}

		// The raised pool offsets handle normal framing. This final guard also
		// covers the first blend frame (and custom camera settings), ensuring
		// the camera can never briefly cross below the water surface.
		if ( underwaterTarget && ! this._submergedFraming ) {

			const minimumCameraY = this.waterSurfaceY + 0.35;
			if ( this.camera.position.y < minimumCameraY ) {

				this.camera.position.y = minimumCameraY;
				this.camera.lookAt( this.lookTarget );

			}

		}

		this.constrainPosition( this.camera.position, dt );
		this.camera.lookAt( this.lookTarget );

	}

}
