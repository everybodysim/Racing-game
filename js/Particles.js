import * as THREE from 'three';

const POOL_SIZE = 64;
const _worldPos = new THREE.Vector3();
const DEFAULT_PARTICLE_COLOR = new THREE.Color( 0x5E5F6B );
const BOOST_PARTICLE_COLORS = [
	new THREE.Color( 0xff4b1f ),
	new THREE.Color( 0xff9f1c ),
];
const SKID_STORAGE_KEY = 'racing-skid-marks-v1';
const SKID_MAX_SEGMENTS = 400;
const SKID_EMIT_INTERVAL = 0.05;
const SKID_COLOR = new THREE.Color( 0x171717 );
const SKID_WIDTH = 0.22;
const SKID_GROUND_VEL_Y_THRESHOLD = 1.25;
const _backward = new THREE.Vector3();
const _rightVec = new THREE.Vector3();
const _trackPoint = new THREE.Vector3();
const _upAxis = new THREE.Vector3( 0, 1, 0 );

export class SmokeTrails {

	constructor( scene ) {

		this.particles = [];

		const map = new THREE.TextureLoader().load( 'sprites/smoke.png' );
		this.material = new THREE.SpriteMaterial( {
			map,
			transparent: true,
			depthWrite: false,
			opacity: 0,
			color: 0x5E5F6B,
		} );

		for ( let i = 0; i < POOL_SIZE; i ++ ) {

			const sprite = new THREE.Sprite( this.material.clone() );
			sprite.visible = false;
			sprite.scale.setScalar( 0.25 );
			scene.add( sprite );

			this.particles.push( {
				sprite,
				life: 0,
				maxLife: 0,
				velocity: new THREE.Vector3(),
				initialScale: 0,
			} );

		}

		this.emitIndex = 0;
		this.boostFxTime = 0;

	}

	update( dt, vehicle ) {

		this.boostFxTime = Math.max( 0, this.boostFxTime - dt );
		const boostActive = this.boostFxTime > 0;
		const shouldEmit = vehicle.driftIntensity > 0.25;

		// Emit new particles from back wheel positions
		if ( shouldEmit ) {

			if ( vehicle.wheelBL ) this.emitAtWheel( vehicle.wheelBL, vehicle, boostActive );
			if ( vehicle.wheelBR ) this.emitAtWheel( vehicle.wheelBR, vehicle, boostActive );

		}

		// Update existing
		for ( const p of this.particles ) {

			if ( p.life <= 0 ) continue;

			p.life -= dt;

			if ( p.life <= 0 ) {

				p.sprite.visible = false;
				continue;

			}

			const t = 1 - ( p.life / p.maxLife );

			// Apply damping to velocity (Godot damping = 1.0)
			const damping = Math.max( 0, 1 - dt );
			p.velocity.multiplyScalar( damping );

			p.sprite.position.addScaledVector( p.velocity, dt );

			// Alpha curve: 0 → 1 (at midlife) → 0 (matching Godot's alpha_curve)
			const alpha = t < 0.5 ? t * 2 : ( 1 - t ) * 2;
			p.sprite.material.opacity = alpha;

			// Scale curve: 0.5 → 1.0 (at midlife) → 0.2 (matching Godot's scale_curve)
			let scaleFactor;
			if ( t < 0.5 ) {

				scaleFactor = 0.5 + t * 1.0; // 0.5 → 1.0

			} else {

				scaleFactor = 1.0 - ( t - 0.5 ) * 1.6; // 1.0 → 0.2

			}

			p.sprite.scale.setScalar( p.initialScale * scaleFactor );

		}

	}

	triggerBoostFx( duration = 1 ) {

		this.boostFxTime = Math.max( this.boostFxTime, duration );

	}

	emitAtWheel( wheel, vehicle, boostActive = false ) {

		const p = this.particles[ this.emitIndex ];
		this.emitIndex = ( this.emitIndex + 1 ) % POOL_SIZE;

		// Get wheel world position, but use road surface Y
		wheel.getWorldPosition( _worldPos );
		_worldPos.y = vehicle.container.position.y + 0.05;

		p.sprite.position.copy( _worldPos );
		p.sprite.visible = true;
		p.sprite.material.opacity = 0;
		const particleColor = boostActive
			? BOOST_PARTICLE_COLORS[ Math.random() < 0.5 ? 0 : 1 ]
			: DEFAULT_PARTICLE_COLOR;
		p.sprite.material.color.copy( particleColor );

		// Godot: scale_min = 0.25, scale_max = 0.5
		p.initialScale = 0.25 + Math.random() * 0.25;
		p.sprite.scale.setScalar( p.initialScale * 0.5 );

		// Godot: no gravity, damping = 1.0 — minimal velocity
		p.velocity.set(
			( Math.random() - 0.5 ) * 0.2,
			Math.random() * 0.1,
			( Math.random() - 0.5 ) * 0.2
		);

		// Godot: lifetime = 0.5
		p.maxLife = 0.5;
		p.life = p.maxLife;

	}

}

export class SkidMarks {

	constructor( scene ) {

		this.scene = scene;
		this.quads = [];
		this.geometry = new THREE.BufferGeometry();
		this.material = new THREE.MeshBasicMaterial( {
			color: SKID_COLOR,
			transparent: true,
			opacity: 0.7,
			side: THREE.DoubleSide,
		} );
		this.mesh = new THREE.Mesh( this.geometry, this.material );
		this.mesh.frustumCulled = false;
		scene.add( this.mesh );

		this.emitAccumulator = 0;
		this.leftTrackPoints = [];
		this.rightTrackPoints = [];
		this.restoreFromStorage();
		this.rebuildGeometry();

	}

	update( dt, vehicle ) {

		if ( ! vehicle ) return;
		this.emitAccumulator += dt;
		if ( this.emitAccumulator < SKID_EMIT_INTERVAL ) return;
		this.emitAccumulator = 0;
		if ( vehicle.driftIntensity <= 0.25 ) return;
		if ( ! this.isOnGround( vehicle ) ) return;
		const wheelBackOffset = Math.min( 0.45, Math.max( 0.2, Math.abs( vehicle.linearSpeed ) * 0.05 ) );
		if ( vehicle.wheelBL ) this.addSmoothedQuadFromWheel( vehicle.wheelBL, vehicle, this.leftTrackPoints, wheelBackOffset );
		if ( vehicle.wheelBR ) this.addSmoothedQuadFromWheel( vehicle.wheelBR, vehicle, this.rightTrackPoints, wheelBackOffset );
		this.rebuildGeometry();
		this.saveToStorage();

	}

	isOnGround( vehicle ) {

		return Math.abs( vehicle?.sphereVel?.y || 0 ) <= SKID_GROUND_VEL_Y_THRESHOLD;

	}

	addSmoothedQuadFromWheel( wheel, vehicle, trackPoints, backOffset = 0.25 ) {

		wheel.getWorldPosition( _worldPos );
		_backward.set( 0, 0, -1 ).applyQuaternion( vehicle.container.quaternion );
		_worldPos.addScaledVector( _backward, backOffset );
		_worldPos.y = vehicle.container.position.y + 0.01;
		trackPoints.push( _worldPos.clone() );
		if ( trackPoints.length > 4 ) trackPoints.shift();
		if ( trackPoints.length < 3 ) return;

		const p0 = trackPoints[ trackPoints.length - 3 ];
		const p1 = trackPoints[ trackPoints.length - 2 ];
		const p2 = trackPoints[ trackPoints.length - 1 ];

		_trackPoint.copy( p0 ).multiplyScalar( 0.25 );
		_trackPoint.addScaledVector( p1, 0.5 );
		_trackPoint.addScaledVector( p2, 0.25 );
		const smoothStart = _trackPoint.clone();
		const smoothEnd = p2.clone();
		const tangent = smoothEnd.clone().sub( smoothStart );
		if ( tangent.lengthSq() < 0.0001 ) return;
		tangent.normalize();
		_rightVec.crossVectors( _upAxis, tangent ).normalize();
		const halfWidth = SKID_WIDTH * 0.5;
		const a = smoothStart.clone().addScaledVector( _rightVec, halfWidth );
		const b = smoothStart.clone().addScaledVector( _rightVec, -halfWidth );
		const c = smoothEnd.clone().addScaledVector( _rightVec, halfWidth );
		const d = smoothEnd.clone().addScaledVector( _rightVec, -halfWidth );

		this.quads.push( [ a.toArray(), b.toArray(), c.toArray(), d.toArray() ] );
		if ( this.quads.length > SKID_MAX_SEGMENTS ) this.quads.splice( 0, this.quads.length - SKID_MAX_SEGMENTS );

	}

	rebuildGeometry() {

		const positions = new Float32Array( this.quads.length * 6 * 3 );
		let offset = 0;
		for ( const [ a, b, c, d ] of this.quads ) {

			positions[ offset ++ ] = a[ 0 ]; positions[ offset ++ ] = a[ 1 ]; positions[ offset ++ ] = a[ 2 ];
			positions[ offset ++ ] = b[ 0 ]; positions[ offset ++ ] = b[ 1 ]; positions[ offset ++ ] = b[ 2 ];
			positions[ offset ++ ] = c[ 0 ]; positions[ offset ++ ] = c[ 1 ]; positions[ offset ++ ] = c[ 2 ];
			positions[ offset ++ ] = c[ 0 ]; positions[ offset ++ ] = c[ 1 ]; positions[ offset ++ ] = c[ 2 ];
			positions[ offset ++ ] = b[ 0 ]; positions[ offset ++ ] = b[ 1 ]; positions[ offset ++ ] = b[ 2 ];
			positions[ offset ++ ] = d[ 0 ]; positions[ offset ++ ] = d[ 1 ]; positions[ offset ++ ] = d[ 2 ];

		}
		this.geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		this.geometry.computeBoundingSphere();

	}

	saveToStorage() {

		try {

			localStorage.setItem( SKID_STORAGE_KEY, JSON.stringify( this.quads ) );

		} catch {}

	}

	restoreFromStorage() {

		try {

			const raw = localStorage.getItem( SKID_STORAGE_KEY );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			if ( ! Array.isArray( parsed ) ) return;
			this.quads = parsed
				.filter( ( quad ) => Array.isArray( quad ) && quad.length === 4 )
				.map( ( quad ) => [
					Array.isArray( quad[ 0 ] ) ? quad[ 0 ].slice( 0, 3 ).map( Number ) : [ 0, 0, 0 ],
					Array.isArray( quad[ 1 ] ) ? quad[ 1 ].slice( 0, 3 ).map( Number ) : [ 0, 0, 0 ],
					Array.isArray( quad[ 2 ] ) ? quad[ 2 ].slice( 0, 3 ).map( Number ) : [ 0, 0, 0 ],
					Array.isArray( quad[ 3 ] ) ? quad[ 3 ].slice( 0, 3 ).map( Number ) : [ 0, 0, 0 ],
				] )
				.filter( ( quad ) => quad.every( ( pt ) => pt.every( Number.isFinite ) ) )
				.slice( -SKID_MAX_SEGMENTS );

		} catch {}

	}

}
