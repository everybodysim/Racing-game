import * as THREE from 'three';

function lerpAngle( a, b, t ) {

	let d = b - a;
	while ( d > Math.PI ) d -= Math.PI * 2;
	while ( d < - Math.PI ) d += Math.PI * 2;
	return a + d * t;

}

export class Camera {

	constructor( renderer ) {

		this.camera = new THREE.PerspectiveCamera( 42, window.innerWidth / window.innerHeight, 0.1, 60 );

		this.offset = new THREE.Vector3( 7.0, 7.1, 7.0 );
		this.chaseOffset = new THREE.Vector3( 0, 2.3, - 6.6 );
		this.targetPosition = new THREE.Vector3();
		this.lookTarget = new THREE.Vector3();
		this.mode = 'overview';
		this._desiredPos = new THREE.Vector3();
		this._desiredLook = new THREE.Vector3();
		this._forward = new THREE.Vector3();
		this._rotatedOffset = new THREE.Vector3();
		this._upAxis = new THREE.Vector3( 0, 1, 0 );
		this.chaseYaw = 0;
		this.hasChaseYaw = false;

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}
	update( dt, target ) {

	toggleMode() {

		this.mode = this.mode === 'overview' ? 'chase' : 'overview';
		if ( this.mode !== 'chase' ) this.hasChaseYaw = false;

	}

	getMode() {

		return this.mode;

	}

	update( dt, target, targetQuaternion ) {

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

			this._rotatedOffset.copy( this.chaseOffset ).applyAxisAngle( this._upAxis, this.chaseYaw );
			this._desiredPos.copy( this.targetPosition ).add( this._rotatedOffset );
			this._forward.set( Math.sin( this.chaseYaw ), 0, Math.cos( this.chaseYaw ) );
			this._desiredLook.copy( this.targetPosition ).addScaledVector( this._forward, 4.8 );
			this._desiredLook.y += 1.0;

			this.camera.position.lerp( this._desiredPos, dt * 10 );
			this.lookTarget.lerp( this._desiredLook, dt * 8 );
			this.camera.lookAt( this.lookTarget );

		} else {
		this.targetPosition.lerp( target, dt * 4 );

			this._desiredPos.copy( this.targetPosition ).add( this.offset );
			this.camera.position.lerp( this._desiredPos, dt * 8 );
			this.lookTarget.lerp( this.targetPosition, dt * 10 );
			this.camera.lookAt( this.lookTarget );

				this.camera.position.copy( this.targetPosition ).add( this.offset );
		this.camera.lookAt( this.targetPosition );
		}

	}

}
