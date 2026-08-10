import * as THREE from 'three';

const RACE_MUSIC_SOURCES = [ 'audio/music.mp3', 'audio/music2.mp3', 'audio/music3.mp3' ];
const RACE_MUSIC_LAST_KEY = 'racingGameLastRaceMusic';
const AUDIO_SETTINGS_KEY = 'racingGameAudioSettings';

// --- Persistent audio settings ---
// musicMode: 0 = random (default), 1 = track 1, 2 = track 2, 3 = track 3
// sfxVolume: 0..1  (multiplier applied to engine/skid/impact)
// musicVolume: 0..1  (multiplier applied to race music target)

function loadAudioSettings() {

	try {

		const raw = localStorage.getItem( AUDIO_SETTINGS_KEY );
		if ( raw ) {

			const parsed = JSON.parse( raw );
			return {
				musicMode: typeof parsed.musicMode === 'number' ? parsed.musicMode : 0,
				sfxVolume: typeof parsed.sfxVolume === 'number' ? parsed.sfxVolume : 1,
				musicVolume: typeof parsed.musicVolume === 'number' ? parsed.musicVolume : 1,
			};

		}

	} catch ( e ) { /* ignore */ }

	return { musicMode: 0, sfxVolume: 1, musicVolume: 1 };

}

function saveAudioSettings( settings ) {

	try {

		localStorage.setItem( AUDIO_SETTINGS_KEY, JSON.stringify( settings ) );

	} catch ( e ) { /* ignore */ }

}

function chooseRaceMusicSource( musicMode ) {

	if ( musicMode && musicMode >= 1 && musicMode <= RACE_MUSIC_SOURCES.length )
		return RACE_MUSIC_SOURCES[ musicMode - 1 ];

	if ( RACE_MUSIC_SOURCES.length === 1 ) return RACE_MUSIC_SOURCES[ 0 ];

	let previousSource = null;

	try {

		previousSource = window.sessionStorage?.getItem( RACE_MUSIC_LAST_KEY ) || null;

	} catch ( error ) {

		previousSource = null;

	}

	const choices = RACE_MUSIC_SOURCES.filter( ( source ) => source !== previousSource );
	const selectedSource = choices[ Math.floor( Math.random() * choices.length ) ] || RACE_MUSIC_SOURCES[ 0 ];

	try {

		window.sessionStorage?.setItem( RACE_MUSIC_LAST_KEY, selectedSource );

	} catch ( error ) {

		// If storage is unavailable, this reload still gets a random track.

	}

	return selectedSource;

}

function remap( value, inMin, inMax, outMin, outMax ) {

	return outMin + ( outMax - outMin ) * ( ( value - inMin ) / ( inMax - inMin ) );

}

export class GameAudio {

	constructor() {

		this.listener = null;
		this.engineSound = null;
		this.engineTextureSound = null;
		this.skidSound = null;
		this.musicElement = null;
		this.settings = loadAudioSettings();
		this.musicSource = chooseRaceMusicSource( this.settings.musicMode );
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
		this.musicVolume = 0;
		this.musicStarted = false;
		this.retryMusicFromGesture = null;

	}

	// --- Public setters for UI controls ---
	setSfxVolume( vol ) {

		this.settings.sfxVolume = THREE.MathUtils.clamp( vol, 0, 1 );
		saveAudioSettings( this.settings );

	}

	setMusicVolume( vol ) {

		this.settings.musicVolume = THREE.MathUtils.clamp( vol, 0, 1 );
		saveAudioSettings( this.settings );

	}

	setMusicMode( mode ) {

		this.settings.musicMode = Math.round( mode );
		saveAudioSettings( this.settings );
		const newSource = chooseRaceMusicSource( this.settings.musicMode );
		if ( newSource !== this.musicSource ) {

			this.musicSource = newSource;
			this._reloadMusic();

		}

	}

	_reloadMusic() {

		const wasPlaying = this.musicElement && ! this.musicElement.paused;
		if ( this.musicElement ) {

			this.musicElement.pause();
			this.musicElement.src = this.musicSource;
			this.musicElement.load();

		}
		this.musicStarted = false;
		if ( wasPlaying && this.unlocked ) this.startMusic();

	}

	init( camera ) {

		this.listener = new THREE.AudioListener();
		camera.add( this.listener );

		const loader = new THREE.AudioLoader();

		this.engineSound = new THREE.Audio( this.listener );
		this.engineTextureSound = new THREE.Audio( this.listener );
		this.skidSound = new THREE.Audio( this.listener );
		this.musicElement = new Audio( this.musicSource );
		this.musicElement.loop = true;
		this.musicElement.preload = 'auto';
		this.musicElement.volume = 0;
		this.musicElement.addEventListener( 'ended', () => {

			this.musicElement.currentTime = 0;
			if ( this.unlocked ) this.startMusic();

		} );
		this.musicElement.load();
		this.musicReady = true;

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

			if ( this.unlocked ) {

				if ( ! this.musicStarted ) this.startMusic();
				return;

			}
			this.unlocked = true;

			// Start music directly inside the user gesture. Waiting for the
			// AudioContext resume promise can lose autoplay permission in browsers.
			this.startMusic();
			resumeContext();

		};

		window.addEventListener( 'keydown', unlock );
		window.addEventListener( 'click', unlock );
		window.addEventListener( 'touchstart', unlock );
		window.addEventListener( 'pointerdown', unlock );

		this.retryMusicFromGesture = () => {

			if ( ! this.unlocked || this.musicStarted ) return;
			this.startMusic();

		};

		window.addEventListener( 'keydown', this.retryMusicFromGesture );
		window.addEventListener( 'click', this.retryMusicFromGesture );
		window.addEventListener( 'touchstart', this.retryMusicFromGesture );
		window.addEventListener( 'pointerdown', this.retryMusicFromGesture );
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

		// Keep music as a normal HTMLAudioElement instead of routing it through
		// WebAudio. The engine/skid/impact sounds use the AudioContext, but music
		// must be allowed to begin during the player's first driving gesture even
		// if the context has not finished resuming yet.
		this.musicElement.play().then( () => {

			this.musicStarted = true;

			window.removeEventListener( 'keydown', this.retryMusicFromGesture );
			window.removeEventListener( 'click', this.retryMusicFromGesture );
			window.removeEventListener( 'touchstart', this.retryMusicFromGesture );
			window.removeEventListener( 'pointerdown', this.retryMusicFromGesture );

		} ).catch( () => {

			this.musicStarted = false;

		} );

	}

	stopAll() {

		if ( this.engineSound?.isPlaying ) this.engineSound.stop();
		if ( this.engineTextureSound?.isPlaying ) this.engineTextureSound.stop();
		if ( this.skidSound?.isPlaying ) this.skidSound.stop();
		if ( this.musicElement ) {

			this.musicElement.pause();
			this.musicElement.volume = 0;

		}
		this.musicVolume = 0;
		this.musicStarted = false;

	}

	updateMusic( dt, raceActive ) {

		const baseTarget = raceActive ? 0.34 : 0;
		this.targetMusicVolume = baseTarget * this.settings.musicVolume;
		if ( ! this.musicReady ) return;

		if ( this.unlocked && this.targetMusicVolume > 0 && ( this.musicElement?.paused || ! this.musicStarted ) ) this.startMusic();

		this.musicVolume = THREE.MathUtils.lerp( this.musicVolume, this.targetMusicVolume, Math.min( 1, dt * 6 ) );
		if ( this.musicElement ) this.musicElement.volume = THREE.MathUtils.clamp( this.musicVolume, 0, 1 );

	}

	update( dt, mph, throttle, driftIntensity ) {

		if ( ! this.ready ) return;

		this.engineTime += dt;

		// mph is the real-world speed (same value the speedometer shows), so the
		// engine pitch sweeps across the full 0..MAX_MPH range instead of the
		// normalized linearSpeed, which used to plateau at top speed and sound flat.
		const MAX_MPH = 70;
		const speedFactor = THREE.MathUtils.clamp( Math.abs( mph ), 0, MAX_MPH );
		const normalizedSpeed = THREE.MathUtils.clamp( speedFactor / MAX_MPH, 0, 1 );
		const throttleFactor = THREE.MathUtils.clamp( Math.abs( throttle ), 0, 1 );
		const accel = THREE.MathUtils.clamp( ( speedFactor - this.lastSpeedFactor ) / Math.max( dt, 0.001 ), - 80, 80 );
		this.lastSpeedFactor = speedFactor;

		// Grip loss (drifting/wheelspin) decouples engine revs from ground speed:
		// the wheels are spinning faster than the car is moving, so the note rises
		// even when forward speed doesn't. This is what gives a car its character
		// when you boot it mid-corner instead of sounding nailed to one pitch.
		const grip = THREE.MathUtils.clamp( 1 - driftIntensity * 0.6, 0.25, 1 );
		const slipRev = ( 1 - grip ) * 0.45; // up to ~0.45 extra pitch at full slide

		// Gear-like stepped rev cycle: revs climb within a gear then "shift" back
		// down a step, instead of one long monotonic rise that flattens out at the top.
		const gearCount = 5;
		const gearPosition = normalizedSpeed * gearCount;
		const gearIndex = Math.min( gearCount - 1, Math.floor( gearPosition ) );
		const gearProgress = gearPosition - gearIndex;
		this.engineGear = THREE.MathUtils.lerp( this.engineGear, gearIndex, Math.min( 1, dt * 4 ) );

		const revSweep = 0.62 + gearProgress * 0.56;
		// Idle note (~0.6x) → top of top gear (~1.7x), plus grip-loss revs and load.
		const speedPitch = remap( normalizedSpeed, 0, 1, 0.6, 1.7 );
		const loadPitch = throttleFactor * 0.16 + accel * 0.0016;
		const topSpeedMovement = normalizedSpeed > 0.82
			? Math.sin( this.engineTime * 5.7 ) * 0.04 + Math.sin( this.engineTime * 11.3 ) * 0.02
			: 0;
		const targetPitch = THREE.MathUtils.clamp( speedPitch * revSweep + slipRev + loadPitch + topSpeedMovement, 0.5, 2.4 );
		const currentPitch = this.engineSound.getPlaybackRate();
		this.engineSound.setPlaybackRate( THREE.MathUtils.lerp( currentPitch, targetPitch, Math.min( 1, dt * 5.5 ) ) );

		const texturePitch = THREE.MathUtils.clamp( targetPitch * 0.54 + 0.24 + Math.sin( this.engineTime * 2.1 ) * 0.025, 0.52, 1.48 );
		const currentTexturePitch = this.engineTextureSound.getPlaybackRate();
		this.engineTextureSound.setPlaybackRate( THREE.MathUtils.lerp( currentTexturePitch, texturePitch, Math.min( 1, dt * 3.5 ) ) );

		// Volume rises with both speed and load; grip loss adds a slightly harsher,
		// louder edge (engine working harder against the sliding tires).
		const load = THREE.MathUtils.clamp( normalizedSpeed * 0.6 + throttleFactor * 0.75, 0, 1.8 );
		const pulse = 0.92 + Math.sin( this.engineTime * ( 8 + normalizedSpeed * 12 ) ) * 0.035;
		const gripVol = 1 + ( 1 - grip ) * 0.18;
		const targetVol = remap( load, 0, 1.8, 0.035, 0.46 ) * pulse * gripVol * this.settings.sfxVolume;
		const currentVol = this.engineSound.getVolume();
		this.engineSound.setVolume( THREE.MathUtils.lerp( currentVol, targetVol, Math.min( 1, dt * 7 ) ) );

		const textureVol = ( 0.025 + normalizedSpeed * 0.12 + throttleFactor * 0.045 ) * ( 1 - Math.min( 0.45, driftIntensity * 0.12 ) ) * this.settings.sfxVolume;
		const currentTextureVol = this.engineTextureSound.getVolume();
		this.engineTextureSound.setVolume( THREE.MathUtils.lerp( currentTextureVol, textureVol, Math.min( 1, dt * 5 ) ) );

		// Skid threshold scales with speed so light wheelspin at low speed doesn't
		// trigger a full tire-squeal, but a high-speed slide does.
		const shouldSkid = mph > 8 && driftIntensity > 0.65;
		let skidVol = 0;

		if ( shouldSkid ) {

			skidVol = remap( THREE.MathUtils.clamp( driftIntensity, 0.65, 2.2 ), 0.65, 2.2, 0.08, 0.55 ) * this.settings.sfxVolume;

		}

		const curSkidVol = this.skidSound.getVolume();
		this.skidSound.setVolume( THREE.MathUtils.lerp( curSkidVol, skidVol, dt * 10 ) );

		// Skid pitch tracks real speed so the squeal rises as you slide faster.
		const skidPitch = THREE.MathUtils.clamp( 1 + mph / MAX_MPH * 1.6, 1, 2.6 );
		const curSkidPitch = this.skidSound.getPlaybackRate();
		this.skidSound.setPlaybackRate( THREE.MathUtils.lerp( curSkidPitch, skidPitch, 0.1 ) );

	}

playImpact( impactVelocity ) {

		if ( ! this.unlocked || this.impactPool.length === 0 ) return;

		const sound = this.impactPool[ this.impactIndex ];
		this.impactIndex = ( this.impactIndex + 1 ) % this.impactPool.length;

		if ( sound.isPlaying ) sound.stop();

		// Calculate base volume and multiply by 0.25 to cap it at 25% max volume
		const volume = THREE.MathUtils.clamp( remap( impactVelocity, 0, 6, 0.01, 1.0 ), 0.01, 1.0 ) * 0.25 * this.settings.sfxVolume;
		const velocityTone = THREE.MathUtils.clamp( remap( impactVelocity, 0.5, 7, -0.08, 0.16 ), -0.08, 0.16 );
		const randomTone = ( Math.random() - 0.5 ) * 0.18;
		const playbackRate = THREE.MathUtils.clamp( 1 + velocityTone + randomTone, 0.82, 1.24 );
		
		sound.setVolume( volume );
		
		if ( typeof sound.setPlaybackRate === 'function' ) {

			sound.setPlaybackRate( playbackRate );

		} else if ( sound.source?.playbackRate ) {

			sound.source.playbackRate.value = playbackRate;

		}
		
		sound.play();

	}

}
