import * as THREE from 'three';

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
		this.customColor = null;

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
			? BOOST_PARTICLE_COLORS[ Math.random() < 0.5 ? 0 : 1 ]
			: ( this.customColor || DEFAULT_PARTICLE_COLOR );
		p.sprite.material.color.copy( particleColor );

		const speedRatio = THREE.MathUtils.clamp( Math.abs( vehicle.linearSpeed || 0 ) / Math.max( 0.01, vehicle.topSpeed || 1 ), 0, 1.7 );

		// Godot: scale_min = 0.25, scale_max = 0.5
		p.initialScale = 0.24 + Math.random() * 0.24 + ( speedRatio * 0.08 );
		p.sprite.scale.setScalar( p.initialScale * 0.5 );

		// Godot: no gravity, damping = 1.0 — minimal velocity
		const driftPush = THREE.MathUtils.clamp( vehicle.driftIntensity || 0, 0, 1 );
		p.velocity.set(
			( Math.random() - 0.5 ) * ( 0.2 + speedRatio * 0.12 ),
			Math.random() * ( 0.1 + speedRatio * 0.05 ),
			( Math.random() - 0.5 ) * ( 0.2 + driftPush * 0.2 )
		);

		// Slightly longer at high speed for more readable trails
		p.maxLife = 0.42 + ( speedRatio * 0.12 );
		p.life = p.maxLife;

	}

}

const SPLASH_PARTICLE_COLORS = [
	new THREE.Color( 0xbfe8ff ),
	new THREE.Color( 0x8fd4f7 ),
	new THREE.Color( 0xe8f7ff ),
];

// Splash when a car dives into pool water: a burst of light-blue droplets
// thrown up and outward, pulled down by gravity, fading as they fall.
export class WaterSplashFX {

	constructor( scene, options = {} ) {

		this.scene = scene;
		this.maxParticles = Math.max( 8, Math.floor( Number( options.maxParticles ) || 48 ) );
		const map = new THREE.TextureLoader().load( 'sprites/smoke.png' );
		this.baseMaterial = new THREE.SpriteMaterial( {
			map,
			transparent: true,
			depthWrite: false,
			opacity: 0.85,
		} );
		this.particles = [];
		for ( let i = 0; i < this.maxParticles; i ++ ) {

			const sprite = new THREE.Sprite( this.baseMaterial.clone() );
			sprite.material.color.copy( SPLASH_PARTICLE_COLORS[ i % SPLASH_PARTICLE_COLORS.length ] );
			sprite.visible = false;
			this.scene.add( sprite );
			this.particles.push( { sprite, life: 0, maxLife: 0, velocity: new THREE.Vector3(), gravity: 9 } );

		}
		this.emitIndex = 0;

	}

	// intensity 0..1 — gentle wading makes a small plop, a dive makes a proper splash.
	burst( x, y, z, intensity = 1 ) {

		const count = Math.floor( 8 + intensity * 22 );
		for ( let i = 0; i < count; i ++ ) {

			const particle = this.particles[ this.emitIndex ];
			this.emitIndex = ( this.emitIndex + 1 ) % this.particles.length;
			const angle = Math.random() * Math.PI * 2;
			const horizontal = ( 0.9 + Math.random() * 1.6 ) * ( 0.55 + intensity * 0.9 );
			particle.velocity.set(
				Math.cos( angle ) * horizontal,
				( 2.2 + Math.random() * 2.6 ) * ( 0.5 + intensity ),
				Math.sin( angle ) * horizontal
			);
			particle.maxLife = 0.45 + Math.random() * 0.4;
			particle.life = particle.maxLife;
			particle.sprite.position.set( x + ( Math.random() - 0.5 ) * 0.3, y, z + ( Math.random() - 0.5 ) * 0.3 );
			particle.sprite.scale.setScalar( 0.28 + Math.random() * 0.22 + intensity * 0.2 );
			particle.sprite.material.opacity = 0.7 + intensity * 0.2;
			particle.sprite.visible = true;

		}

	}

	update( dt ) {

		for ( const particle of this.particles ) {

			if ( particle.life <= 0 ) continue;
			particle.life -= dt;
			if ( particle.life <= 0 ) {

				particle.sprite.visible = false;
				continue;

			}
			particle.velocity.y -= particle.gravity * dt;
			particle.sprite.position.addScaledVector( particle.velocity, dt );
			const t = particle.life / particle.maxLife;
			particle.sprite.material.opacity = 0.8 * t;
			particle.sprite.scale.multiplyScalar( 1 + dt * 0.9 );

		}

	}

}
