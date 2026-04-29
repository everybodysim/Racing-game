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
		this.segments = [];
		this.geometry = new THREE.BufferGeometry();
		this.material = new THREE.LineBasicMaterial( {
			color: SKID_COLOR,
			transparent: true,
			opacity: 0.7,
		} );
		this.lines = new THREE.LineSegments( this.geometry, this.material );
		this.lines.frustumCulled = false;
		scene.add( this.lines );

		this.emitAccumulator = 0;
		this.restoreFromStorage();
		this.rebuildGeometry();

	}

	update( dt, vehicle ) {

		if ( ! vehicle ) return;
		this.emitAccumulator += dt;
		if ( this.emitAccumulator < SKID_EMIT_INTERVAL ) return;
		this.emitAccumulator = 0;
		if ( vehicle.driftIntensity <= 0.25 ) return;
		const wheelBackOffset = Math.min( 0.45, Math.max( 0.2, Math.abs( vehicle.linearSpeed ) * 0.05 ) );
		if ( vehicle.wheelBL ) this.addSegmentFromWheel( vehicle.wheelBL, vehicle, wheelBackOffset );
		if ( vehicle.wheelBR ) this.addSegmentFromWheel( vehicle.wheelBR, vehicle, wheelBackOffset );
		this.rebuildGeometry();
		this.saveToStorage();

	}

	addSegmentFromWheel( wheel, vehicle, backOffset = 0.25 ) {

		wheel.getWorldPosition( _worldPos );
		const backward = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( vehicle.container.quaternion );
		_worldPos.addScaledVector( backward, backOffset );
		_worldPos.y = vehicle.container.position.y + 0.01;
		const halfWidth = 0.08;
		const right = new THREE.Vector3( 1, 0, 0 ).applyQuaternion( vehicle.container.quaternion );
		const start = _worldPos.clone().addScaledVector( right, -halfWidth );
		const end = _worldPos.clone().addScaledVector( right, halfWidth );

		this.segments.push( [ start.toArray(), end.toArray() ] );
		if ( this.segments.length > SKID_MAX_SEGMENTS ) this.segments.splice( 0, this.segments.length - SKID_MAX_SEGMENTS );

	}

	rebuildGeometry() {

		const positions = new Float32Array( this.segments.length * 2 * 3 );
		let offset = 0;
		for ( const [ a, b ] of this.segments ) {

			positions[ offset ++ ] = a[ 0 ];
			positions[ offset ++ ] = a[ 1 ];
			positions[ offset ++ ] = a[ 2 ];
			positions[ offset ++ ] = b[ 0 ];
			positions[ offset ++ ] = b[ 1 ];
			positions[ offset ++ ] = b[ 2 ];

		}
		this.geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		this.geometry.computeBoundingSphere();

	}

	saveToStorage() {

		try {

			localStorage.setItem( SKID_STORAGE_KEY, JSON.stringify( this.segments ) );

		} catch {}

	}

	restoreFromStorage() {

		try {

			const raw = localStorage.getItem( SKID_STORAGE_KEY );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			if ( ! Array.isArray( parsed ) ) return;
			this.segments = parsed
				.filter( ( pair ) => Array.isArray( pair ) && pair.length === 2 )
				.map( ( pair ) => [
					Array.isArray( pair[ 0 ] ) ? pair[ 0 ].slice( 0, 3 ).map( Number ) : [ 0, 0, 0 ],
					Array.isArray( pair[ 1 ] ) ? pair[ 1 ].slice( 0, 3 ).map( Number ) : [ 0, 0, 0 ],
				] )
				.filter( ( pair ) => pair[ 0 ].every( Number.isFinite ) && pair[ 1 ].every( Number.isFinite ) )
				.slice( -SKID_MAX_SEGMENTS );

		} catch {}

	}

}
