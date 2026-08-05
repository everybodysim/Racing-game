import * as THREE from 'three';

function remap( value, inMin, inMax, outMin, outMax ) {

	return outMin + ( outMax - outMin ) * ( ( value - inMin ) / ( inMax - inMin ) );

}

function makeNoiseBuffer( context, seconds = 1.5 ) {

	const length = Math.max( 1, Math.floor( context.sampleRate * seconds ) );
	const buffer = context.createBuffer( 1, length, context.sampleRate );
	const data = buffer.getChannelData( 0 );
	let last = 0;

	for ( let i = 0; i < length; i ++ ) {

		last = last * 0.82 + ( Math.random() * 2 - 1 ) * 0.18;
		data[ i ] = last;

	}

	return buffer;

}

export class GameAudio {

	constructor() {

		this.listener = null;
		this.engineSound = null;
		this.skidSound = null;
		this.musicSound = null;
		this.engineNodes = null;
		this.impactBuffer = null;
		this.impactPool = [];
		this.impactIndex = 0;
		this.ready = false;
		this.musicReady = false;
		this.unlocked = false;
		this.enginePhase = 0;
		this.engineFlutter = 0;
		this.targetMusicVolume = 0;

	}

	init( camera ) {

		this.listener = new THREE.AudioListener();
		camera.add( this.listener );

		const loader = new THREE.AudioLoader();

		this.engineSound = new THREE.Audio( this.listener );
		this.skidSound = new THREE.Audio( this.listener );
		this.musicSound = new THREE.Audio( this.listener );
		this.createEngineSynth();

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

		loader.load( 'audio/music.mp3', ( buffer ) => {

			this.musicSound.setBuffer( buffer );
			this.musicSound.setLoop( true );
			this.musicSound.setVolume( 0 );
			this.musicReady = true;
			if ( this.unlocked ) this.startMusic();

		} );

		const unlock = () => {

			if ( this.unlocked ) return;
			this.unlocked = true;

			const ctx = this.listener.context;

			if ( ctx.state === 'suspended' ) ctx.resume();

			this.startSounds();
			this.startMusic();

			window.removeEventListener( 'keydown', unlock );
			window.removeEventListener( 'click', unlock );
			window.removeEventListener( 'touchstart', unlock );

		};

		window.addEventListener( 'keydown', unlock );
		window.addEventListener( 'click', unlock );
		window.addEventListener( 'touchstart', unlock );
		window.addEventListener( 'pagehide', () => this.stopAll() );
		window.addEventListener( 'beforeunload', () => this.stopAll() );
		document.addEventListener( 'visibilitychange', () => {

			if ( document.hidden ) this.stopAll();
			else if ( this.unlocked ) {

				this.startSounds();
				this.startMusic();

			}

		} );

	}

	createEngineSynth() {

		const ctx = this.listener.context;
		const output = ctx.createGain();
		const growl = ctx.createOscillator();
		const pulse = ctx.createOscillator();
		const raspSource = ctx.createBufferSource();
		const raspFilter = ctx.createBiquadFilter();
		const raspGain = ctx.createGain();
		const compressor = ctx.createDynamicsCompressor();

		growl.type = 'sawtooth';
		pulse.type = 'square';
		raspSource.buffer = makeNoiseBuffer( ctx );
		raspSource.loop = true;
		raspFilter.type = 'bandpass';
		raspFilter.frequency.value = 420;
		raspFilter.Q.value = 3.2;
		output.gain.value = 0;
		raspGain.gain.value = 0.08;
		compressor.threshold.value = - 24;
		compressor.ratio.value = 8;

		growl.connect( compressor );
		pulse.connect( compressor );
		raspSource.connect( raspFilter );
		raspFilter.connect( raspGain );
		raspGain.connect( compressor );
		compressor.connect( output );
		output.connect( this.listener.getInput() );

		growl.start();
		pulse.start();
		raspSource.start();

		this.engineNodes = { growl, pulse, raspFilter, raspGain, output };
		this.ready = Boolean( this.skidSound?.buffer );

	}

	checkReady() {

		if ( this.engineNodes && this.skidSound.buffer ) {

			this.ready = true;

			if ( this.unlocked ) this.startSounds();

		}

	}

	startSounds() {

		if ( ! this.ready ) return;

		if ( ! this.skidSound.isPlaying ) this.skidSound.play();

	}

	startMusic() {

		if ( this.musicReady && ! this.musicSound.isPlaying ) this.musicSound.play();

	}

	stopAll() {

		if ( this.engineNodes ) this.engineNodes.output.gain.value = 0;
		if ( this.skidSound?.isPlaying ) this.skidSound.stop();
		if ( this.musicSound?.isPlaying ) this.musicSound.stop();

	}

	updateMusic( dt, raceActive ) {

		this.targetMusicVolume = raceActive ? 0.28 : 0;
		if ( ! this.musicReady ) return;
		if ( this.unlocked && this.targetMusicVolume > 0 && ! this.musicSound.isPlaying ) this.musicSound.play();
		const currentVol = this.musicSound.getVolume();
		this.musicSound.setVolume( THREE.MathUtils.lerp( currentVol, this.targetMusicVolume, Math.min( 1, dt * 2.5 ) ) );

	}

	update( dt, speed, throttle, driftIntensity ) {

		if ( ! this.ready ) return;

		const speedFactor = THREE.MathUtils.clamp( Math.abs( speed ), 0, 1.8 );
		const throttleFactor = THREE.MathUtils.clamp( Math.abs( throttle ), 0, 1 );
		const load = THREE.MathUtils.clamp( speedFactor * 0.55 + throttleFactor * 0.65, 0, 1.6 );
		this.enginePhase += dt * ( 1.7 + speedFactor * 1.9 );
		this.engineFlutter = Math.sin( this.enginePhase * 1.73 ) * 0.045 + Math.sin( this.enginePhase * 3.91 ) * 0.025;

		if ( this.engineNodes ) {

			const ctxTime = this.listener.context.currentTime;
			const rpm = 48 + speedFactor * 92 + throttleFactor * 36 + this.engineFlutter * 42;
			const volume = remap( load, 0, 1.6, 0.035, 0.34 );
			this.engineNodes.output.gain.linearRampToValueAtTime( volume, ctxTime + 0.06 );
			this.engineNodes.growl.frequency.linearRampToValueAtTime( rpm, ctxTime + 0.08 );
			this.engineNodes.pulse.frequency.linearRampToValueAtTime( rpm * 0.51, ctxTime + 0.08 );
			this.engineNodes.raspFilter.frequency.linearRampToValueAtTime( 260 + rpm * 6.5, ctxTime + 0.08 );
			this.engineNodes.raspGain.gain.linearRampToValueAtTime( 0.035 + throttleFactor * 0.09 + speedFactor * 0.02, ctxTime + 0.08 );

		}

		const shouldSkid = driftIntensity > 0.25;
		let skidVol = 0;

		if ( shouldSkid ) {

			skidVol = remap( THREE.MathUtils.clamp( driftIntensity, 0.25, 2 ), 0.25, 2, 0.1, 0.6 );

		}

		const curSkidVol = this.skidSound.getVolume();
		this.skidSound.setVolume( THREE.MathUtils.lerp( curSkidVol, skidVol, dt * 10 ) );

		const skidPitch = THREE.MathUtils.clamp( Math.abs( speed ), 1, 3 );
		const curSkidPitch = this.skidSound.getPlaybackRate();
		this.skidSound.setPlaybackRate( THREE.MathUtils.lerp( curSkidPitch, skidPitch, 0.1 ) );

	}

	playImpact( impactVelocity ) {

		if ( ! this.unlocked || this.impactPool.length === 0 ) return;

		const sound = this.impactPool[ this.impactIndex ];
		this.impactIndex = ( this.impactIndex + 1 ) % this.impactPool.length;

		if ( sound.isPlaying ) sound.stop();

		const volume = THREE.MathUtils.clamp( remap( impactVelocity, 0, 6, 0.01, 1.0 ), 0.01, 1.0 );
		sound.setVolume( volume );
		sound.play();

	}

}
