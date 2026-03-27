import * as THREE from 'three';

export class Camera {

	constructor() {

		this.camera = new THREE.PerspectiveCamera( 42, window.innerWidth / window.innerHeight, 0.1, 60 );

		this.offset = new THREE.Vector3( 7.0, 7.1, 7.0 );
		this.chaseOffset = new THREE.Vector3( 0, 3.2, - 6.8 );
		this.targetPosition = new THREE.Vector3();
		this.lookTarget = new THREE.Vector3();
		this.mode = 'overview';
		this._desiredPos = new THREE.Vector3();
		this._desiredLook = new THREE.Vector3();
		this._forward = new THREE.Vector3();
		this._rotatedOffset = new THREE.Vector3();

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	toggleMode() {

		this.mode = this.mode === 'overview' ? 'chase' : 'overview';

	}

	getMode() {

		return this.mode;

	}

	update( dt, target, targetQuaternion ) {

		this.targetPosition.lerp( target, dt * 6 );

		if ( this.mode === 'chase' && targetQuaternion ) {

			this._rotatedOffset.copy( this.chaseOffset ).applyQuaternion( targetQuaternion );
			this._desiredPos.copy( this.targetPosition ).add( this._rotatedOffset );
			this._forward.set( 0, 0, 1 ).applyQuaternion( targetQuaternion );
			this._desiredLook.copy( this.targetPosition ).addScaledVector( this._forward, 6.0 );
			this._desiredLook.y += 1.0;

			this.camera.position.lerp( this._desiredPos, dt * 8 );
			this.lookTarget.lerp( this._desiredLook, dt * 10 );
			this.camera.lookAt( this.lookTarget );

		} else {

			this._desiredPos.copy( this.targetPosition ).add( this.offset );
			this.camera.position.lerp( this._desiredPos, dt * 8 );
			this.lookTarget.lerp( this.targetPosition, dt * 10 );
			this.camera.lookAt( this.lookTarget );

		}

	}

}
