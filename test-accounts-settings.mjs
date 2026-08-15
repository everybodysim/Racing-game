// Test the accounts worker persists the settings slice through sanitizeProfile.
// Stubs the Cloudflare KV + Request/Response globals enough to exercise the
// real signup -> saveProfile -> getProfile path.
import { strict as assert } from 'node:assert';

class FakeResponse {
	constructor( body, init = {} ) {
		this.status = init.status || 200;
		this.body = body; // withCors re-wraps via new Response(response.body, ...)
		this._body = body;
		this.headers = new Headers( init.headers || {} );
	}
	async json() { return typeof this._body === 'string' ? JSON.parse( this._body ) : this._body; }
	get ok() { return this.status >= 200 && this.status < 300; }
}

class FakeRequest {
	constructor( url, init = {} ) {
		this.url = url;
		this.method = init.method || 'GET';
		this._body = init.body;
		this.headers = new Map();
	}
	async json() { return typeof this._body === 'string' ? JSON.parse( this._body ) : this._body; }
}

class FakeKV {
	constructor() { this.map = new Map(); }
	async get( key, type ) {
		const v = this.map.get( key );
		if ( v == null ) return null;
		return type === 'json' ? JSON.parse( v ) : v;
	}
	async put( key, value ) { this.map.set( key, value ); }
	async list() { return { keys: [], list_complete: true }; }
}

globalThis.Response = FakeResponse;
globalThis.Request = FakeRequest;

const worker = await import( './cloudflare-accounts/worker/src/index.js' );
const env = { ACCOUNTS_KV: new FakeKV() };

async function call( path, method, body ) {
	const res = await worker.default.fetch( new FakeRequest( 'https://x' + path, { method, body: body ? JSON.stringify( body ) : undefined } ), env );
	return { status: res.status, json: await res.json() };
}

// signup
const signup = await call( '/api/accounts/signup', 'POST', { username: 'speedy', password: 'hunter2', profile: { playerName: 'Speedy' } } );
assert.equal( signup.json.ok, true );
const token = signup.json.token;

// save profile WITH a settings slice
const settingsPayload = {
	graphics: { preset: 'custom', basePreset: 'high', bloomStrength: 0.08, shadows: false, maxPixelRatio: 1.5, smokeParticles: 12, antialias: false, reduceMotion: true },
	audio: { sfxVolume: 0.5, musicVolume: 0.25, musicMode: 2 },
	gameplay: { showFps: true, showBestGhost: false, recentGhostsEnabled: true, recentGhostCount: 7, cameraDistance: 12, cameraHeight: 4, cameraLag: 0.6, autoRespawn: true },
	controls: { invertSteer: true, keyboardOnly: true, steerSmoothing: 0.4 },
	accessibility: { highContrastHud: true, largeHud: true, screenShake: false, colorblindFilter: 'deutan' },
};
const save = await call( '/api/accounts/profile', 'POST', { token, profile: { settings: settingsPayload } } );
assert.equal( save.json.ok, true );
assert.equal( save.json.profile.settings.graphics.preset, 'custom' );
assert.equal( save.json.profile.settings.graphics.basePreset, 'high' );
assert.equal( save.json.profile.settings.graphics.bloomStrength, 0.08 );
assert.equal( save.json.profile.settings.audio.sfxVolume, 0.5 );
assert.equal( save.json.profile.settings.gameplay.cameraDistance, 12 );
assert.equal( save.json.profile.settings.controls.invertSteer, true );
assert.equal( save.json.profile.settings.accessibility.colorblindFilter, 'deutan' );

// getProfile round-trips settings
const get = await call( '/api/accounts/profile?token=' + encodeURIComponent( token ), 'GET' );
assert.equal( get.json.ok, true );
const s = get.json.profile.settings;
assert.equal( s.graphics.preset, 'custom' );
assert.equal( s.graphics.basePreset, 'high' );
assert.equal( s.graphics.shadows, false );
assert.equal( s.graphics.maxPixelRatio, 1.5 );
assert.equal( s.graphics.smokeParticles, 12 );
assert.equal( s.graphics.antialias, false );
assert.equal( s.graphics.reduceMotion, true );
assert.equal( s.audio.musicMode, 2 );
assert.equal( s.audio.musicVolume, 0.25 );
assert.equal( s.gameplay.showFps, true );
assert.equal( s.gameplay.showBestGhost, false );
assert.equal( s.gameplay.recentGhostCount, 7 );
assert.equal( s.gameplay.cameraLag, 0.6 );
assert.equal( s.controls.steerSmoothing, 0.4 );
assert.equal( s.controls.keyboardOnly, true );
assert.equal( s.accessibility.largeHud, true );
assert.equal( s.accessibility.screenShake, false );

// sanitization clamps bad values
const bad = await call( '/api/accounts/profile', 'POST', { token, profile: { settings: {
	graphics: { preset: 'ultra', basePreset: 'ultra', bloomStrength: 999, shadowMapSize: 5, maxPixelRatio: 50, smokeParticles: -10 },
	audio: { sfxVolume: 5, musicMode: 99 },
	gameplay: { recentGhostCount: 999, cameraLag: 0, cameraDistance: 999 },
	controls: { steerSmoothing: 5 },
	accessibility: { colorblindFilter: 'bogus' },
} } } );
const b = bad.json.profile.settings;
assert.equal( b.graphics.preset, 'high', 'bad preset falls back to high' );
assert.equal( b.graphics.basePreset, 'high', 'bad basePreset falls back to high' );
assert.equal( b.graphics.bloomStrength, 0.1, 'bloom clamped to max' );
assert.equal( b.graphics.shadowMapSize, null, 'shadow map forced null (control removed, always preset-driven)' );
assert.equal( b.graphics.maxPixelRatio, 2, 'pixel ratio clamped' );
assert.equal( b.graphics.smokeParticles, 0, 'smoke clamped to min' );
assert.equal( b.audio.sfxVolume, 1, 'sfx clamped' );
assert.equal( b.audio.musicMode, 3, 'music mode clamped' );
assert.equal( b.gameplay.recentGhostCount, 20, 'ghost count clamped' );
assert.equal( b.gameplay.cameraLag, 0.1, 'camera lag clamped' );
assert.equal( b.gameplay.cameraDistance, 30, 'camera distance clamped' );
assert.equal( b.controls.steerSmoothing, 1, 'steer smoothing clamped' );
assert.equal( b.accessibility.colorblindFilter, 'off', 'bad colorblind falls back' );

// null fields (follow-preset) round-trip as null
const nulls = await call( '/api/accounts/profile', 'POST', { token, profile: { settings: { graphics: { maxPixelRatio: null, shadows: null, bloomStrength: null } } } } );
const n = nulls.json.profile.settings;
assert.equal( n.graphics.maxPixelRatio, null );
assert.equal( n.graphics.shadows, null );
assert.equal( n.graphics.bloomStrength, null );

// missing settings entirely yields a full defaults object (not undefined)
const none = await call( '/api/accounts/profile', 'POST', { token, profile: {} } );
const ns = none.json.profile.settings;
assert.ok( ns && ns.graphics && ns.audio && ns.gameplay && ns.controls && ns.accessibility, 'missing settings yields defaults object' );
assert.equal( ns.graphics.antialias, true, 'default antialias true' );
assert.equal( ns.accessibility.screenShake, true, 'default screenShake true' );
assert.equal( ns.gameplay.showBestGhost, true, 'default showBestGhost true' );

// existing profile fields (coins/garage) are NOT clobbered when only settings sent
const coinsSave = await call( '/api/accounts/profile', 'POST', { token, profile: { economy: { coins: 1234 }, settings: { graphics: { preset: 'medium' } } } } );
assert.equal( coinsSave.json.profile.economy.coins, 1234, 'coins preserved' );
assert.equal( coinsSave.json.profile.settings.graphics.preset, 'medium', 'settings applied' );
assert.equal( coinsSave.json.profile.settings.graphics.basePreset, 'medium', 'basePreset follows preset' );

console.log( 'PASS: accounts worker settings round-trip + sanitization (', 0, 'failures )' );
