import * as THREE from 'three';

function remap( value, inMin, inMax, outMin, outMax ) {

	return outMin + ( outMax - outMin ) * ( ( value - inMin ) / ( inMax - inMin ) );

}

export class GameAudio {

	constructor() {

		this.listener = null;
		this.engineSound = null;
		this.engineTextureSound = null;
		this.skidSound = null;
		this.musicSound = null;
		this.musicElement = null;
		this.impactBuffer = null;
		this.impactPool = [];
		this.impactIndex = 0;
		this.ready = false;
		this.musicReady = false;
		this.unlocked = false;
		this.engineTime = 0;
		this.engineGear = 0;
		this.lastSpeedFactor = 0;
		this.targetMusicVolume = 0;
		this.sfxVolume = 1;
		this.musicVolume = 1;
		this.musicTrack = 'random';
		this.tracks = [ 'audio/music.mp3', 'audio/music2.mp3' ];

	}

	init( camera ) {

		this.listener = new THREE.AudioListener();
		camera.add( this.listener );

		const loader = new THREE.AudioLoader();

		this.engineSound = new THREE.Audio( this.listener );
		this.engineTextureSound = new THREE.Audio( this.listener );
		this.skidSound = new THREE.Audio( this.listener );
		const initialSrc = this.musicTrack === 'random'
			? this.tracks[ Math.floor( Math.random() * this.tracks.length ) ]
			: this.resolveMusicTrack( this.musicTrack );
		this.musicElement = new Audio( initialSrc );
		this.musicElement.loop = true;
		this.musicElement.preload = 'auto';
		this.musicElement.volume = 1;
		this.musicElement.load();
		this.musicSound = new THREE.Audio( this.listener );
		this.musicSound.setMediaElementSource( this.musicElement );
		this.musicSound.setVolume( 0 );
		this.musicReady = true;

		// Pre-start the music element immediately so it buffers while the
		// AudioContext is still suspended. No sound will come out (context is
		// suspended + volume is 0) but the element will be ready to play
		// instantly when the context resumes on first user interaction.
		this.musicElement.play().catch( () => {} );

		loader.load( 'audio/engine.ogg', ( buffer ) => {

			this.engineSound.setBuffer( buffer );
			this.engineSound.setLoop( true );
			this.engineSound.setVolume( 0 );
			this.engineTextureSound.setBuffer( buffer );
			this.engineTextureSound.setLoop( true );
			this.engineTextureSound.setVolume( 0 );
			this.engineTextureSound.setPlaybackRate( 0.72 );
			this.checkReady();

		} );

		loader.load( 'audio/skid.ogg', ( buffer ) => {

			this.skidSound.setBuffer( buffer );
			this.skidSound.setLoop( true );
			this.skidSound.setVolume( 0 );
			this.checkReady();

		} );

		loader.load( 'audio/impact.ogg', ( buffer ) => {

			this.impactBuffer = buffer;

			for ( let i = 0; i < 3; i ++ ) {

				const sound = new THREE.Audio( this.listener );
				sound.setBuffer( buffer );
				this.impactPool.push( sound );

			}

		} );

		// Centralised start — only runs once the AudioContext is actually 'running'.
		// Calling play() while the context is suspended makes elements think they're
		// playing (paused = false) but produces no sound — the root cause of music
		// not starting until a crash impact "kicked" the context awake.
		const startWhenRunning = () => {

			const ctx = this.listener.context;
			if ( ctx.state !== 'running' ) return;

			this.startSounds();
			this.startMusic();

			// Remove the statechange listener once we've started
			ctx.removeEventListener( 'statechange', startWhenRunning );

		};

		const resumeContext = () => {

			const ctx = this.listener.context;
			if ( ctx.state === 'running' ) {

				startWhenRunning();

			} else {

				ctx.resume().then( startWhenRunning ).catch( () => {} );
				ctx.addEventListener( 'statechange', startWhenRunning );

			}

		};

		const unlock = () => {

			if ( this.unlocked ) return;
			this.unlocked = true;

			resumeContext();

			window.removeEventListener( 'keydown', unlock );
			window.removeEventListener( 'click', unlock );
			window.removeEventListener( 'touchstart', unlock );
			window.removeEventListener( 'pointerdown', unlock );

		};

		window.addEventListener( 'keydown', unlock );
		window.addEventListener( 'click', unlock );
		window.addEventListener( 'touchstart', unlock );
		window.addEventListener( 'pointerdown', unlock );
		window.addEventListener( 'pagehide', () => this.stopAll() );
		window.addEventListener( 'beforeunload', () => this.stopAll() );
		document.addEventListener( 'visibilitychange', () => {

			if ( document.hidden ) {

				this.stopAll();

			} else if ( this.unlocked ) {

				resumeContext();

			}

		} );

	}

	checkReady() {

		if ( this.engineSound.buffer && this.engineTextureSound.buffer && this.skidSound.buffer ) {

			this.ready = true;

			if ( this.unlocked ) {

				const ctx = this.listener.context;

				if ( ctx.state === 'running' ) this.startSounds();
				// If context isn't running yet, startWhenRunning will call startSounds()

			}

		}

	}

	startSounds() {

		if ( ! this.ready ) return;

		if ( ! this.engineSound.isPlaying ) this.engineSound.play();
		if ( ! this.engineTextureSound.isPlaying ) this.engineTextureSound.play();
		if ( ! this.skidSound.isPlaying ) this.skidSound.play();

	}

	startMusic() {

		if ( ! this.musicReady || ! this.musicElement ) return;

		const ctx = this.listener?.context;

		// Element was pre-started on init — if it's already playing and
		// the context is now running, we're good (it was buffering while
		// the context was suspended, now it flows through).
		if ( ! this.musicElement.paused ) {

			if ( ctx && ctx.state === 'running' ) return;
			// Context not running yet — don't restart, just wait for resume
			return;

		}

		// Element was paused (e.g. after stopAll) — start fresh
		this.musicElement.play().catch( () => {} );

	}

	stopAll() {

		if ( this.engineSound?.isPlaying ) this.engineSound.stop();
		if ( this.engineTextureSound?.isPlaying ) this.engineTextureSound.stop();
		if ( this.skidSound?.isPlaying ) this.skidSound.stop();
		if ( this.musicElement ) this.musicElement.pause();

	}

	updateMusic( dt, raceActive ) {

		this.targetMusicVolume = raceActive ? 0.34 : 0;
		if ( ! this.musicReady ) return;

		// If music should be playing but element is paused (e.g. after tab switch
		// + return), restart it. The context should already be running.
		if ( this.unlocked && this.targetMusicVolume > 0 && this.musicElement?.paused ) {

			const ctx = this.listener?.context;
			if ( ctx && ctx.state === 'running' ) this.startMusic();

		}

		const currentVol = this.musicSound.getVolume();
		this.musicSound.setVolume( THREE.MathUtils.lerp( currentVol, this.targetMusicVolume * this.musicVolume, Math.min( 1, dt * 6 ) ) );

	}

	resolveMusicTrack( track ) {

		if ( track === '1' ) return 'audio/music.mp3';
		if ( track === '2' ) return 'audio/music2.mp3';
		return 'audio/music.mp3'; // random falls here; shuffle handled in init

	}

	setSfxVolume( vol ) {

		this.sfxVolume = THREE.MathUtils.clamp( vol, 0, 1 );

	}

	setMusicVolume( vol ) {

		this.musicVolume = THREE.MathUtils.clamp( vol, 0, 1 );

	}

	setMusicTrack( track ) {

		this.musicTrack = track;
		if ( ! this.musicElement ) return;
		const src = this.resolveMusicTrack( track );
		const wasPlaying = ! this.musicElement.paused;
		this.musicElement.pause();
		this.musicElement.setAttribute( 'src', src );
		this.musicElement.load();
		if ( wasPlaying && this.unlocked ) this.musicElement.play().catch( () => {} );

	}

	update( dt, speed, throttle, driftIntensity ) {

		if ( ! this.ready ) return;

		this.engineTime += dt;
		const speedFactor = THREE.MathUtils.clamp( Math.abs( speed ), 0, 1.8 );
		const normalizedSpeed = THREE.MathUtils.clamp( speedFactor / 1.8, 0, 1 );
		const throttleFactor = THREE.MathUtils.clamp( Math.abs( throttle ), 0, 1 );
		const accel = THREE.MathUtils.clamp( ( speedFactor - this.lastSpeedFactor ) / Math.max( dt, 0.001 ), - 1.2, 1.2 );
		this.lastSpeedFactor = speedFactor;

		const gearCount = 5;
		const gearPosition = normalizedSpeed * gearCount;
		const gearIndex = Math.min( gearCount - 1, Math.floor( gearPosition ) );
		const gearProgress = gearPosition - gearIndex;
		this.engineGear = THREE.MathUtils.lerp( this.engineGear, gearIndex, Math.min( 1, dt * 4 ) );

		const revSweep = 0.68 + gearProgress * 0.62;
		const speedPitch = remap( normalizedSpeed, 0, 1, 0.62, 1.68 );
		const loadPitch = throttleFactor * 0.18 + accel * 0.035;
		const topSpeedMovement = normalizedSpeed > 0.82
			? Math.sin( this.engineTime * 5.7 ) * 0.045 + Math.sin( this.engineTime * 11.3 ) * 0.022
			: 0;
		const targetPitch = THREE.MathUtils.clamp( speedPitch * revSweep + loadPitch + topSpeedMovement, 0.55, 2.45 );
		const currentPitch = this.engineSound.getPlaybackRate();
		this.engineSound.setPlaybackRate( THREE.MathUtils.lerp( currentPitch, targetPitch, Math.min( 1, dt * 5.5 ) ) );

		const texturePitch = THREE.MathUtils.clamp( targetPitch * 0.54 + 0.24 + Math.sin( this.engineTime * 2.1 ) * 0.025, 0.52, 1.48 );
		const currentTexturePitch = this.engineTextureSound.getPlaybackRate();
		this.engineTextureSound.setPlaybackRate( THREE.MathUtils.lerp( currentTexturePitch, texturePitch, Math.min( 1, dt * 3.5 ) ) );

		const load = THREE.MathUtils.clamp( speedFactor * 0.55 + throttleFactor * 0.75, 0, 1.8 );
		const pulse = 0.92 + Math.sin( this.engineTime * ( 8 + normalizedSpeed * 12 ) ) * 0.035;
		const targetVol = remap( load, 0, 1.8, 0.035, 0.46 ) * pulse;
		const currentVol = this.engineSound.getVolume();
		this.engineSound.setVolume( THREE.MathUtils.lerp( currentVol, targetVol * this.sfxVolume, Math.min( 1, dt * 7 ) ) );

		const textureVol = ( 0.025 + normalizedSpeed * 0.12 + throttleFactor * 0.045 ) * ( 1 - Math.min( 0.45, driftIntensity * 0.12 ) );
		const currentTextureVol = this.engineTextureSound.getVolume();
		this.engineTextureSound.setVolume( THREE.MathUtils.lerp( currentTextureVol, textureVol * this.sfxVolume, Math.min( 1, dt * 5 ) ) );

		const shouldSkid = Math.abs( speed ) > 0.25 && driftIntensity > 0.65;
		let skidVol = 0;

		if ( shouldSkid ) {

			skidVol = remap( THREE.MathUtils.clamp( driftIntensity, 0.65, 2.2 ), 0.65, 2.2, 0.08, 0.55 );

		}

		const curSkidVol = this.skidSound.getVolume();
		this.skidSound.setVolume( THREE.MathUtils.lerp( curSkidVol, skidVol * this.sfxVolume, dt * 10 ) );

		const skidPitch = THREE.MathUtils.clamp( Math.abs( speed ), 1, 3 );
		const curSkidPitch = this.skidSound.getPlaybackRate();
		this.skidSound.setPlaybackRate( THREE.MathUtils.lerp( curSkidPitch, skidPitch, 0.1 ) );

	}
playImpact( impactVelocity ) {

		if ( ! this.unlocked || this.impactPool.length === 0 ) return;

		const sound = this.impactPool[ this.impactIndex ];
		this.impactIndex = ( this.impactIndex + 1 ) % this.impactPool.length;

		if ( sound.isPlaying ) sound.stop();

		// Multiply by 0.25 so the max volume caps at 25% (0.25)
		const volume = THREE.MathUtils.clamp( remap( impactVelocity, 0, 6, 0.01, 1.0 ), 0.01, 1.0 ) * 0 * this.sfxVolume;
		sound.setVolume( volume );
		sound.play();

	}

}
