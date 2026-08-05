import * as THREE from 'three';

function lerpAngle( a, b, t ) {

	let d = b - a;
	while ( d > Math.PI ) d -= Math.PI * 2;
	while ( d < - Math.PI ) d += Math.PI * 2;
	return a + d * t;

}

export class Camera {

	constructor() {

		this.camera = new THREE.PerspectiveCamera( 42, window.innerWidth / window.innerHeight, 0.1, 60 );

		this.offset = new THREE.Vector3( 7.0, 7.1, 7.0 );
		this.chaseOffset = new THREE.Vector3( 0, 2.3, - 6.6 );
		this.underwaterChaseOffset = new THREE.Vector3( 0, 7.4, - 3.2 );
		this.underwaterOverviewOffset = new THREE.Vector3( 3.6, 8.6, 3.6 );
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

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	toggleMode() {

		this.mode = this.mode === 'overview' ? 'chase' : 'overview';
		if ( this.mode !== 'chase' ) this.hasChaseYaw = false;

	}

	getMode() {

		return this.mode;

	}

	update( dt, target, targetQuaternion, dynamics = {} ) {

		const speedRatio = THREE.MathUtils.clamp( Number( dynamics.speedRatio ) || 0, 0, 1.8 );
		const driftAmount = THREE.MathUtils.clamp( Number( dynamics.driftIntensity ) || 0, 0, 1 );
		const underwaterTarget = dynamics.underwaterCamera ? 1 : 0;
		this.underwaterBlend = THREE.MathUtils.lerp(
    this.underwaterBlend,
    underwaterTarget,
    Math.min(1, dt / 0.7)
);
		const underwaterLift = this.underwaterBlend;
		const targetLerp = this.mode === 'chase' ? 10 : 6;
		this.targetPosition.lerp( target, dt * targetLerp );

		if ( this.mode === 'chase' && targetQuaternion ) {

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
			this._desiredPos.copy( this.targetPosition ).add( this._rotatedOffset );
			this._forward.set( Math.sin( this.chaseYaw ), 0, Math.cos( this.chaseYaw ) );
			this._desiredLook.copy( this.targetPosition ).addScaledVector( this._forward, THREE.MathUtils.lerp( 4.8, 0.8, underwaterLift ) );
			this._desiredLook.y += THREE.MathUtils.lerp( 1.0, 0.45, underwaterLift );

			const chaseLag = THREE.MathUtils.lerp( 10, 7.2, Math.min( 1, speedRatio * 0.8 + driftAmount * 0.4 ) );
			this.camera.position.lerp( this._desiredPos, dt * chaseLag );
			this.lookTarget.lerp( this._desiredLook, dt * 8 );
			const targetFov = 42 + ( speedRatio * 6.5 ) + ( driftAmount * 1.5 );
			this.camera.fov = THREE.MathUtils.lerp( this.camera.fov, targetFov, Math.min( 1, dt * 3.5 ) );
			this.camera.updateProjectionMatrix();
			this.camera.lookAt( this.lookTarget );

		} else {

			this._rotatedOffset.copy( this.offset ).lerp( this.underwaterOverviewOffset, underwaterLift );
			this._desiredPos.copy( this.targetPosition ).add( this._rotatedOffset );
			this.camera.position.lerp( this._desiredPos, dt * 8 );
			this._desiredLook.copy( this.targetPosition );
			this.lookTarget.lerp( this._desiredLook, dt * 10 );
			this.camera.fov = THREE.MathUtils.lerp( this.camera.fov, 42, Math.min( 1, dt * 4 ) );
			this.camera.updateProjectionMatrix();
			this.camera.lookAt( this.lookTarget );

		}

	}

}
