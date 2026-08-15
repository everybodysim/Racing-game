// Verifies that applyLiveGameSettings applies each subsystem independently:
// a throwing graphics section must NOT prevent camera/audio/fps/ghost from applying,
// and camera settings apply to BOTH cam and cam2 (split-screen).
//
// Run: node test-settings-apply.mjs
import assert from 'node:assert';

// ---- Stubs mirroring the engine state applyLiveGameSettings touches ----
function makeEngine() {
	const engine = {
		graphicsApplied: false,
		graphicsThrows: false,
		audio: { sfx: null, music: null, mode: null },
		cam: { userDistance: null, userHeight: null, userLagScale: 1 },
		cam2: { userDistance: null, userHeight: null, userLagScale: 1 },
		fpsHudVisible: false,
		fpsKey: null,
		showBestGhost: true,
		ghostHidden: false,
	};
	// Mirror the refactored apply* helpers from main.js, bound to `engine`.
	engine.applyGraphicsSettings = ( g ) => {
		if ( engine.graphicsThrows ) throw new Error( 'boom' );
		engine.graphicsApplied = true;
	};
	engine.applyAudioSettings = ( a ) => {
		if ( a.sfxVolume != null ) engine.audio.sfx = a.sfxVolume;
		if ( a.musicVolume != null ) engine.audio.music = a.musicVolume;
		if ( a.musicMode != null ) engine.audio.mode = a.musicMode;
	};
	engine.applyCameraSettings = ( gp ) => {
		for ( const c of [ engine.cam, engine.cam2 ] ) {
			if ( ! c ) continue;
			if ( gp.cameraDistance != null ) c.userDistance = gp.cameraDistance;
			if ( gp.cameraHeight != null ) c.userHeight = gp.cameraHeight;
			if ( gp.cameraLag != null ) c.userLagScale = gp.cameraLag;
		}
	};
	engine.applyFpsSettings = ( gp ) => {
		engine.fpsHudVisible = Boolean( gp.showFps );
		engine.fpsKey = engine.fpsHudVisible ? '1' : '0';
	};
	engine.applyGhostSettings = ( gp ) => {
		engine.showBestGhost = gp.showBestGhost != null ? Boolean( gp.showBestGhost ) : true;
		if ( ! engine.showBestGhost ) engine.ghostHidden = true;
	};
	// Mirror the refactored applyLiveGameSettings: per-section try/catch.
	engine.applyLiveGameSettings = ( settings ) => {
		if ( ! settings ) return;
		const gp = settings.gameplay || {};
		try { engine.applyGraphicsSettings( settings.graphics || {} ); } catch ( e ) {}
		try { engine.applyAudioSettings( settings.audio || {} ); } catch ( e ) {}
		try { engine.applyCameraSettings( gp ); } catch ( e ) {}
		try { engine.applyFpsSettings( gp ); } catch ( e ) {}
		try { engine.applyGhostSettings( gp ); } catch ( e ) {}
	};
	return engine;
}

let passed = 0;
function check( name, fn ) { fn(); passed++; console.log( '  ok -', name ); }

// 1. Happy path: camera settings apply to BOTH cameras.
check( 'camera settings apply to cam AND cam2', () => {
	const e = makeEngine();
	e.applyLiveGameSettings( { gameplay: { cameraLag: 0.8, cameraDistance: 10, cameraHeight: 4 } } );
	assert.equal( e.cam.userLagScale, 0.8 );
	assert.equal( e.cam.userDistance, 10 );
	assert.equal( e.cam.userHeight, 4 );
	assert.equal( e.cam2.userLagScale, 0.8, 'cam2 must also get cameraLag' );
	assert.equal( e.cam2.userDistance, 10 );
	assert.equal( e.cam2.userHeight, 4 );
} );

// 2. A throwing graphics section does NOT skip camera/audio/fps/ghost.
check( 'graphics throw does not skip camera/audio/fps/ghost', () => {
	const e = makeEngine();
	e.graphicsThrows = true;
	e.applyLiveGameSettings( {
		graphics: { preset: 'high' },
		audio: { sfxVolume: 0.5, musicVolume: 0.7, musicMode: 2 },
		gameplay: { cameraLag: 0.6, showFps: true, showBestGhost: false },
	} );
	assert.equal( e.graphicsApplied, false, 'graphics threw so it did not apply' );
	assert.equal( e.cam.userLagScale, 0.6, 'camera still applied despite graphics throw' );
	assert.equal( e.cam2.userLagScale, 0.6 );
	assert.equal( e.audio.sfx, 0.5, 'audio still applied' );
	assert.equal( e.audio.music, 0.7 );
	assert.equal( e.audio.mode, 2 );
	assert.equal( e.fpsHudVisible, true, 'fps still applied' );
	assert.equal( e.showBestGhost, false, 'ghost still applied' );
	assert.equal( e.ghostHidden, true );
} );

// 3. A throwing camera section does not skip fps/ghost.
check( 'camera throw does not skip fps/ghost', () => {
	const e = makeEngine();
	e.applyCameraSettings = () => { throw new Error( 'cam boom' ); };
	e.applyLiveGameSettings( { gameplay: { cameraLag: 0.4, showFps: true, showBestGhost: false } } );
	assert.equal( e.graphicsApplied, true );
	assert.equal( e.fpsHudVisible, true );
	assert.equal( e.showBestGhost, false );
} );

// 4. null camera values leave defaults untouched (auto/follow-preset).
check( 'null camera values leave defaults', () => {
	const e = makeEngine();
	e.applyLiveGameSettings( { gameplay: { cameraLag: null, cameraDistance: null, cameraHeight: null } } );
	assert.equal( e.cam.userLagScale, 1 );
	assert.equal( e.cam.userDistance, null );
	assert.equal( e.cam2.userLagScale, 1 );
} );

// 5. First-frame safety-net semantics: re-applying is idempotent and re-applies
//    even after a prior partial failure once the dependency is ready.
check( 're-apply after dependency becomes ready recovers camera', () => {
	const e = makeEngine();
	e.graphicsThrows = true;
	e.applyLiveGameSettings( { gameplay: { cameraLag: 0.8 } } );
	// Simulate the first-frame re-apply once graphics no longer throws.
	e.graphicsThrows = false;
	e.applyLiveGameSettings( { graphics: { preset: 'high' }, gameplay: { cameraLag: 0.8 } } );
	assert.equal( e.graphicsApplied, true, 'graphics recovered on re-apply' );
	assert.equal( e.cam.userLagScale, 0.8 );
} );

// 6. Empty/null settings is a safe no-op.
check( 'null settings is a no-op', () => {
	const e = makeEngine();
	assert.doesNotThrow( () => e.applyLiveGameSettings( null ) );
	assert.equal( e.cam.userLagScale, 1 );
} );

console.log( `\n${passed} assertions passed (test-settings-apply.mjs)` );
