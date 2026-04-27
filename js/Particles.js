import * as THREE from 'three';

const POOL_SIZE = 64;
const _worldPos = new THREE.Vector3();
const DEFAULT_PARTICLE_COLOR = new THREE.Color( 0x5E5F6B );
const BOOST_PARTICLE_COLORS = [
	new THREE.Color( 0xff4b1f ),
	new THREE.Color( 0xff9f1c ),
];
const TRAIL_TEXTURES = new Map();
const TRAIL_SVGS = {
	smoke: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/><stop offset="58%" stop-color="#d8dfef" stop-opacity="0.65"/><stop offset="100%" stop-color="#cad2e6" stop-opacity="0"/></radialGradient></defs><circle cx="40" cy="40" r="37" fill="url(#g)"/></svg>`,
	neonRing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><radialGradient id="c" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#aaf5ff" stop-opacity="0.06"/><stop offset="70%" stop-color="#74f4ff" stop-opacity="0.35"/><stop offset="100%" stop-color="#74f4ff" stop-opacity="0"/></radialGradient></defs><circle cx="40" cy="40" r="25" fill="none" stroke="#79f6ff" stroke-opacity="0.9" stroke-width="9"/><circle cx="40" cy="40" r="36" fill="url(#c)"/></svg>`,
	comet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="t" x1="0%" y1="50%" x2="100%" y2="50%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0"/><stop offset="45%" stop-color="#ffffff" stop-opacity="0.42"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0.95"/></linearGradient></defs><ellipse cx="47" cy="40" rx="24" ry="12" fill="#ffffff" fill-opacity="0.9"/><path d="M5 40C20 26 28 24 43 30L43 50C29 55 18 53 5 40Z" fill="url(#t)"/></svg>`,
	sparks: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><g fill="#fff"><path d="M40 6l7 20h20l-16 12 7 20-18-12-18 12 7-20-16-12h20z" fill-opacity="0.9"/><circle cx="15" cy="18" r="3" fill-opacity="0.72"/><circle cx="65" cy="62" r="2.5" fill-opacity="0.65"/><circle cx="62" cy="18" r="2.2" fill-opacity="0.6"/></g></svg>`,
};

function getTrailTexture( trailId ) {

	const key = Object.prototype.hasOwnProperty.call( TRAIL_SVGS, trailId ) ? trailId : 'smoke';
	if ( TRAIL_TEXTURES.has( key ) ) return TRAIL_TEXTURES.get( key );
	const svg = TRAIL_SVGS[ key ];
	const url = `data:image/svg+xml;utf8,${ encodeURIComponent( svg ) }`;
	const texture = new THREE.TextureLoader().load( url );
	texture.colorSpace = THREE.SRGBColorSpace;
	TRAIL_TEXTURES.set( key, texture );
	return texture;

}

export class SmokeTrails {

	constructor( scene, options = {} ) {

		this.particles = [];
		this.trailId = typeof options?.trailId === 'string' ? options.trailId : 'smoke';
		const map = getTrailTexture( this.trailId );
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

	setTrailStyle( trailId ) {

		const nextTrail = typeof trailId === 'string' ? trailId : 'smoke';
		if ( nextTrail === this.trailId ) return;
		this.trailId = nextTrail;
		const nextMap = getTrailTexture( this.trailId );
		for ( const particle of this.particles ) {

			particle.sprite.material.map = nextMap;
			particle.sprite.material.needsUpdate = true;

		}

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
