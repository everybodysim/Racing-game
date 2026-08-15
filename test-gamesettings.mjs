// Test the GameSettings module: schema defaults, custom-preset behaviour,
// syncFromLegacy (in-game controls writing legacy keys), clearLocalStorage,
// and the showBestGhost toggle. Uses a stub localStorage/window/navigator so
// it runs under plain `node` (no browser).
import { strict as assert } from 'node:assert';

globalThis.window = { matchMedia: undefined, innerWidth: 1280, deviceMemory: 8 };
Object.defineProperty( globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true } );
const store = new Map();
globalThis.localStorage = {
	getItem: ( k ) => ( store.has( k ) ? store.get( k ) : null ),
	setItem: ( k, v ) => store.set( k, String( v ) ),
	removeItem: ( k ) => { store.delete( k ); },
	key: ( i ) => Array.from( store.keys() )[ i ],
	get length() { return store.size; },
};

const m = await import( './js/GameSettings.js' );
const G = m.default;
let pass = 0, fail = 0;
function eq( name, a, b ) {
	const ok = JSON.stringify( a ) === JSON.stringify( b );
	if ( ok ) { pass++; } else { fail++; console.log( 'FAIL', name, 'got', JSON.stringify( a ), 'want', JSON.stringify( b ) ); }
}

// ---- Defaults ----
const s = G.getSettings();
eq( 'default preset high on desktop', s.graphics.preset, 'high' );
eq( 'default basePreset matches preset', s.graphics.basePreset, 'high' );
eq( 'default showBestGhost true', s.gameplay.showBestGhost, true );
eq( 'no countdownEnabled field', s.gameplay.countdownEnabled, undefined );
eq( 'default shadows null (follow preset)', s.graphics.shadows, null );
eq( 'audio defaults', s.audio, { sfxVolume: 1, musicVolume: 1, musicMode: 0 } );

// ---- Custom preset behaviour ----
// Selecting Low resets overrides + sets preset/basePreset to low.
G.patchSettings( { graphics: { preset: 'low', basePreset: 'low', maxPixelRatio: null, shadows: null, shadowMapSize: null, bloomStrength: null, bloomRadius: null, smokeParticles: null } } );
eq( 'preset low after selecting low', G.getSettings().graphics.preset, 'low' );
eq( 'basePreset low after selecting low', G.getSettings().graphics.basePreset, 'low' );
eq( 'all overrides null after selecting low', G.getSettings().graphics.maxPixelRatio, null );
// Legacy key reflects the real preset.
eq( 'legacy graphics key low', store.get( 'racing-graphics-quality' ), 'low' );

// Customizing a slider flips preset to custom, keeps basePreset.
G.patchSettings( { graphics: { preset: 'custom', basePreset: 'low', bloomStrength: 0.05 } } );
eq( 'preset custom after tweak', G.getSettings().graphics.preset, 'custom' );
eq( 'basePreset preserved as low', G.getSettings().graphics.basePreset, 'low' );
eq( 'bloom override set', G.getSettings().graphics.bloomStrength, 0.05 );
// Custom maps to basePreset in the legacy key (so the game still picks a base).
eq( 'legacy graphics key reflects basePreset for custom', store.get( 'racing-graphics-quality' ), 'low' );

// Bad preset value falls back.
G.patchSettings( { graphics: { preset: 'ultra' } } );
eq( 'bad preset falls back to high', G.getSettings().graphics.preset, 'high' );

// ---- Clamping ----
// shadowMapSize is NOT user-tunable (control removed / broken) — it is always
// forced to null (follows the active preset) even when a stale value is sent.
G.patchSettings( { graphics: { bloomStrength: 999, shadowMapSize: 50, maxPixelRatio: 5 } } );
eq( 'bloom clamped', G.getSettings().graphics.bloomStrength, 0.1 );
eq( 'shadowMapSize forced null (always preset-driven)', G.getSettings().graphics.shadowMapSize, null );
eq( 'maxPixelRatio clamped', G.getSettings().graphics.maxPixelRatio, 2 );
G.patchSettings( { gameplay: { recentGhostCount: 999, cameraLag: 0 } } );
eq( 'recentGhostCount clamped', G.getSettings().gameplay.recentGhostCount, 20 );
eq( 'cameraLag clamped', G.getSettings().gameplay.cameraLag, 0.1 );

// ---- showBestGhost toggle ----
G.patchSettings( { gameplay: { showBestGhost: false } } );
eq( 'showBestGhost false after patch', G.getSettings().gameplay.showBestGhost, false );
// null falls back to true.
G.patchSettings( { gameplay: { showBestGhost: null } } );
eq( 'showBestGhost null -> true', G.getSettings().gameplay.showBestGhost, true );

// ---- syncFromLegacy: in-game controls write directly to legacy keys ----
G.resetToDefaults();
// Simulate the in-game audio slider writing sfxVolume=0.5 directly.
store.set( 'racingGameAudioSettings', JSON.stringify( { sfxVolume: 0.5, musicVolume: 0.8, musicMode: 2 } ) );
// Simulate the in-game FPS toggle.
store.set( 'racing-show-fps-v1', '1' );
// Simulate the in-game graphics button selecting medium.
store.set( 'racing-graphics-quality', 'medium' );
G.syncFromLegacy();
const synced = G.getSettings();
eq( 'syncFromLegacy pulls sfxVolume', synced.audio.sfxVolume, 0.5 );
eq( 'syncFromLegacy pulls musicVolume', synced.audio.musicVolume, 0.8 );
eq( 'syncFromLegacy pulls musicMode', synced.audio.musicMode, 2 );
eq( 'syncFromLegacy pulls showFps', synced.gameplay.showFps, true );
eq( 'syncFromLegacy pulls preset medium', synced.graphics.preset, 'medium' );
// The unified key now reflects the legacy state (cloud save would be fresh).
const unified = JSON.parse( store.get( 'racing-game-settings-v1' ) );
eq( 'unified slice fresh after sync (sfxVolume)', unified.audio.sfxVolume, 0.5 );
eq( 'unified slice fresh after sync (showFps)', unified.gameplay.showFps, true );

// ---- clearLocalStorage wipes racing-* keys ----
// Seed a handful of racing keys plus one unrelated key.
store.set( 'racing-player-name-v1', 'Speedy' );
store.set( 'racing-installed-mods-v1', '[]' );
store.set( 'unrelated-key', 'keep me' );
const removed = G.clearLocalStorage();
eq( 'clearLocalStorage removed racing-player-name', removed.indexOf( 'racing-player-name-v1' ) >= 0, true );
eq( 'clearLocalStorage removed unified key', removed.indexOf( 'racing-game-settings-v1' ) >= 0, true );
eq( 'clearLocalStorage kept unrelated key', store.get( 'unrelated-key' ), 'keep me' );
eq( 'clearLocalStorage left no racing-* keys', Array.from( store.keys() ).some( ( k ) => k.startsWith( 'racing-' ) || k.startsWith( 'racingGame' ) ), false );

// ---- resetToDefaults ----
G.resetToDefaults();
eq( 'reset preset high', G.getSettings().graphics.preset, 'high' );
eq( 'reset bloom null', G.getSettings().graphics.bloomStrength, null );
eq( 'reset showBestGhost true', G.getSettings().gameplay.showBestGhost, true );

// ---- cloud status unsigned ----
eq( 'not signed in by default', G.isSignedIn(), false );
eq( 'cloud status unsigned', G.getCloudStatus(), { signedIn: false, username: '' } );

console.log( 'PASS', pass, 'FAIL', fail );
process.exit( fail ? 1 : 0 );
