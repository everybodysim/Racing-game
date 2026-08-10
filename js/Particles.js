import * as THREE from 'three';
import { gameRng } from './Determinism.js';

const DEFAULT_POOL_SIZE = 64;
const _worldPos = new THREE.Vector3();
const DEFAULT_PARTICLE_COLOR = new THREE.Color( 0x5E5F6B );
const BOOST_PARTICLE_COLORS = [
	new THREE.Color( 0xff4b1f ),
	new THREE.Color( 0xff9f1c ),
];

export class SmokeTrails {

	constructor( scene, options = {} ) {

		this.scene = scene;
		this.particles = [];
		this.maxParticles = Math.max( 1, Math.floor( Number( options.maxParticles ) || DEFAULT_POOL_SIZE ) );
		this.emissionStride = Math.max( 1, Math.floor( Number( options.emissionStride ) || 1 ) );
		this.emitFrame = 0;

		const map = new THREE.TextureLoader().load( 'sprites/smoke.png' );
		this.material = new THREE.SpriteMaterial( {
			map,
			transparent: true,
			depthWrite: false,
			opacity: 0,
			color: 0x5E5F6B,
		} );

		this.ensurePoolSize( this.maxParticles );

		this.emitIndex = 0;
		this.boostFxTime = 0;

	}

	createParticle() {

		const sprite = new THREE.Sprite( this.material.clone() );
		sprite.visible = false;
		sprite.scale.setScalar( 0.25 );
		this.scene.add( sprite );

		return {
			sprite,
			life: 0,
			maxLife: 0,
			velocity: new THREE.Vector3(),
			initialScale: 0,
		};

	}

	ensurePoolSize( size ) {

		while ( this.particles.length < size ) this.particles.push( this.createParticle() );

	}

	setQuality( options = {} ) {

		this.maxParticles = Math.max( 1, Math.floor( Number( options.maxParticles ) || this.maxParticles || DEFAULT_POOL_SIZE ) );
		this.emissionStride = Math.max( 1, Math.floor( Number( options.emissionStride ) || this.emissionStride || 1 ) );
		this.ensurePoolSize( this.maxParticles );
		if ( this.emitIndex >= this.maxParticles ) this.emitIndex = 0;
		for ( let i = this.maxParticles; i < this.particles.length; i ++ ) {

			this.particles[ i ].life = 0;
			this.particles[ i ].sprite.visible = false;

		}

	}

	update( dt, vehicle ) {

		this.boostFxTime = Math.max( 0, this.boostFxTime - dt );
		const boostActive = this.boostFxTime > 0;
		const speedRatio = THREE.MathUtils.clamp( Math.abs( vehicle.linearSpeed || 0 ) / Math.max( 0.01, vehicle.topSpeed || 1 ), 0, 1.7 );
		const shouldEmit = boostActive || ( speedRatio > 0.25 && vehicle.driftIntensity > 0.62 );

		// Emit new particles from back wheel positions
		if ( shouldEmit ) {

			this.emitFrame = ( this.emitFrame + 1 ) % this.emissionStride;
			if ( this.emitFrame === 0 ) {

				if ( vehicle.wheelBL ) this.emitAtWheel( vehicle.wheelBL, vehicle, boostActive );
				if ( vehicle.wheelBR ) this.emitAtWheel( vehicle.wheelBR, vehicle, boostActive );

			}

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

		const poolSize = Math.max( 1, Math.min( this.maxParticles, this.particles.length ) );
		const p = this.particles[ this.emitIndex % poolSize ];
		this.emitIndex = ( this.emitIndex + 1 ) % poolSize;

		// Get wheel world position, but use road surface Y
		wheel.getWorldPosition( _worldPos );
		_worldPos.y = vehicle.container.position.y + 0.05;

		p.sprite.position.copy( _worldPos );
		p.sprite.visible = true;
		p.sprite.material.opacity = 0;
		const particleColor = boostActive
			? BOOST_PARTICLE_COLORS[ gameRng.next() < 0.5 ? 0 : 1 ]
			: DEFAULT_PARTICLE_COLOR;
		p.sprite.material.color.copy( particleColor );

		const speedRatio = THREE.MathUtils.clamp( Math.abs( vehicle.linearSpeed || 0 ) / Math.max( 0.01, vehicle.topSpeed || 1 ), 0, 1.7 );

		// Godot: scale_min = 0.25, scale_max = 0.5
		p.initialScale = 0.24 + gameRng.next() * 0.24 + ( speedRatio * 0.08 );
		p.sprite.scale.setScalar( p.initialScale * 0.5 );

		// Godot: no gravity, damping = 1.0 — minimal velocity
		const driftPush = THREE.MathUtils.clamp( vehicle.driftIntensity || 0, 0, 1 );
		p.velocity.set(
			( gameRng.next() - 0.5 ) * ( 0.2 + speedRatio * 0.12 ),
			gameRng.next() * ( 0.1 + speedRatio * 0.05 ),
			( gameRng.next() - 0.5 ) * ( 0.2 + driftPush * 0.2 )
		);

		// Slightly longer at high speed for more readable trails
		p.maxLife = 0.42 + ( speedRatio * 0.12 );
		p.life = p.maxLife;

	}

}
