import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, computePoolPresetWaterCells, TRACK_CELLS, ORIENT_DEG, CELL_RAW, GRID_SCALE } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { GameAudio } from './Audio.js';
import { DeterministicPlaybackController } from './tas-core.js';
import { AdvancementEvents, AdvancementManager, ADVANCEMENTS } from './Advancements.js';
import { HudExtras } from './HudExtras.js';
import { canJoinMap, createHostCode, readFirebaseConfig } from './FirebaseMultiplayer.js';

document.title = 'Racing';

setTimeout(() => {
	const status = document.getElementById('loading-status');
	if (status) status.textContent = 'MAINJS STARTED';
}, 0);


const MAX_PIXEL_RATIO = 1.5;
const GRAPHICS_QUALITY_KEY = 'racing-graphics-quality';
const GRAPHICS_QUALITY_PRESETS = {
	low: { label: 'Low', maxPixelRatio: 0.85, shadows: false, shadowMapSize: 1024, smokeParticles: 24, smokeEmissionStride: 3, weatherParticleScale: 0, bloomStrength: 0, bloomRadius: 0 },
	medium: { label: 'Medium', maxPixelRatio: 1.1, shadows: true, shadowMapSize: 2048, smokeParticles: 44, smokeEmissionStride: 2, weatherParticleScale: 0.55, bloomStrength: 0.01, bloomRadius: 0.01 },
	high: { label: 'High', maxPixelRatio: MAX_PIXEL_RATIO, shadows: true, shadowMapSize: 4096, smokeParticles: 64, smokeEmissionStride: 1, weatherParticleScale: 1, bloomStrength: 0.02, bloomRadius: 0.02 },
};

function isLikelyMobileDevice() {

	return Boolean( window.matchMedia?.( '(pointer: coarse)' )?.matches || window.innerWidth <= 760 || /Android|iPhone|iPad|iPod/i.test( navigator.userAgent ) );

}

function getDefaultGraphicsQuality() {

	if ( isLikelyMobileDevice() ) return ( Number( navigator.deviceMemory ) && navigator.deviceMemory <= 4 ) ? 'low' : 'medium';
	return 'high';

}

function normalizeGraphicsQuality( value ) {

	return GRAPHICS_QUALITY_PRESETS[ value ] ? value : getDefaultGraphicsQuality();

}

let graphicsQuality = normalizeGraphicsQuality( localStorage.getItem( GRAPHICS_QUALITY_KEY ) );

function getGraphicsPreset() {

	return GRAPHICS_QUALITY_PRESETS[ graphicsQuality ] || GRAPHICS_QUALITY_PRESETS[ getDefaultGraphicsQuality() ];

}

function getGraphicsParticleOptions() {

	const preset = getGraphicsPreset();
	return { maxParticles: preset.smokeParticles, emissionStride: preset.smokeEmissionStride };

}

const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType, preserveDrawingBuffer: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, getGraphicsPreset().maxPixelRatio ) );
renderer.shadowMap.enabled = getGraphicsPreset().shadows;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

let bloomPass = null;

function applyBloomPreset() {

	if ( ! bloomPass ) return;
	const preset = getGraphicsPreset();
	bloomPass.strength = preset.bloomStrength;
	bloomPass.radius = preset.bloomRadius;
	bloomPass.threshold = preset.bloomStrength > 0 ? 0.62 : 1.0;

}

async function loadBloomEffect() {

	try {

		const { UnrealBloomPass } = await import( 'three/addons/postprocessing/UnrealBloomPass.js' );
		bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
		applyBloomPreset();
		renderer.setEffects( [ bloomPass ] );

	} catch ( error ) {

		console.warn( 'Bloom effect unavailable; continuing without postprocessing.', error );

	}

}

loadBloomEffect();

document.body.appendChild( renderer.domElement );
const speedBlurVignette = document.getElementById( 'speed-blur-vignette' );

initMultiplayerPanel();

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const skyUniforms = {
	topColor: { value: new THREE.Color( '#6fb9ff' ) },
	midColor: { value: new THREE.Color( '#95ccff' ) },
	horizonColor: { value: new THREE.Color( '#ffe2aa' ) },
	groundColor: { value: new THREE.Color( '#bfd9f2' ) },
	time: { value: 0 },
	vibrance: { value: 0.15 },
};
const skyDome = new THREE.Mesh(
	new THREE.SphereGeometry( 220, 24, 16 ),
	new THREE.ShaderMaterial( {
		side: THREE.BackSide,
		depthWrite: false,
		uniforms: skyUniforms,
		vertexShader: `varying vec3 vWorldPos;
		void main() {
			vec4 wp = modelMatrix * vec4( position, 1.0 );
			vWorldPos = wp.xyz;
			gl_Position = projectionMatrix * viewMatrix * wp;
		}`,
		fragmentShader: `varying vec3 vWorldPos;
		uniform vec3 topColor;
		uniform vec3 midColor;
		uniform vec3 horizonColor;
		uniform vec3 groundColor;
		uniform float time;
		uniform float vibrance;
		void main() {
			vec3 dir = normalize( vWorldPos );
			float h = clamp( dir.y * 0.5 + 0.5, 0.0, 1.0 );
			float horizonBand = exp( -pow( abs( h - 0.48 ) * 8.0, 2.0 ) );
			float cloudWave = ( sin( dir.x * 9.0 + time * 0.03 ) * sin( dir.z * 7.0 - time * 0.02 ) );
			float cloudMask = smoothstep( 0.68, 0.86, cloudWave * 0.5 + 0.5 ) * 0.09;
			vec3 c = mix( groundColor, midColor, smoothstep( 0.03, 0.48, h ) );
			c = mix( c, topColor, smoothstep( 0.45, 0.95, h ) );
			c = mix( c, horizonColor, horizonBand * 0.88 );
			c += vec3( cloudMask ) * ( 0.24 + vibrance * 0.45 );
			c = mix( c, c * 1.15, vibrance * 0.5 );
			gl_FragColor = vec4( c, 1.0 );
		}`
	} )
);
scene.add( skyDome );

const dirLight = new THREE.DirectionalLight( 0xffffff, 5 );
dirLight.position.set( 11.4, 15, -5.3 );
dirLight.castShadow = getGraphicsPreset().shadows;
dirLight.shadow.mapSize.setScalar( getGraphicsPreset().shadowMapSize );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 1.5 );
scene.add( hemiLight );
const fillLight = new THREE.AmbientLight( 0x9cb8d9, 0.24 );
scene.add( fillLight );


function applyGraphicsPresetToRenderer() {

	const preset = getGraphicsPreset();
	const splitScreenPixelCap = new URLSearchParams( window.location.search ).get( 'multiplayer' ) === '1' ? 1 : preset.maxPixelRatio;
	renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, splitScreenPixelCap ) );
	renderer.shadowMap.enabled = preset.shadows;
	if ( renderer.shadowMap ) renderer.shadowMap.needsUpdate = true;
	dirLight.castShadow = preset.shadows;
	dirLight.shadow.mapSize.setScalar( preset.shadowMapSize );
	dirLight.shadow.needsUpdate = true;
	applyBloomPreset();

}

window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );
	applyGraphicsPresetToRenderer();

} );

const loadingManager = new THREE.LoadingManager();
loadingManager.onStart = ( url ) => appendLoadingConsole( `Fetching ${ url.split( '/' ).pop() }…` );
loadingManager.onProgress = ( url, loaded, total ) => appendLoadingConsole( `Loaded ${ url.split( '/' ).pop() } (${ loaded }/${ total })` );
loadingManager.onError = ( url ) => appendLoadingConsole( `Failed ${ url.split( '/' ).pop() }` );
const loader = new GLTFLoader( loadingManager );
const objLoader = new OBJLoader();
const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'decoration-empty', 'decoration-forest', 'decoration-tents',
];

const models = {};
const CAR_STATS = {
	'vehicle-truck-yellow': { name: 'Yellow', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-truck-green': { name: 'Green', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-truck-purple': { name: 'Purple', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-truck-red': { name: 'Red', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
};
const CAR_SELECT_STYLES = {
	'vehicle-truck-yellow': { background: '#f2c94c', border: '#ffe082', color: '#1b1606' },
	'vehicle-truck-green': { background: '#2f9e44', border: '#69db7c', color: '#f0fff4' },
	'vehicle-truck-purple': { background: '#7b2cbf', border: '#c77dff', color: '#fff3ff' },
	'vehicle-truck-red': { background: '#c92a2a', border: '#ff8787', color: '#fff5f5' },
};
const DEFAULT_ENGINE_MULT = 1.1;
const MAX_EFFECTIVE_TOP_SPEED = 1.8;
const BOOST_VELOCITY_DELTA = 8.2;
const BOOST_EFFECT_SECONDS = 1.0;
const BOOST_FORCE_SECONDS = 0.45;
const BOOST_ACCEL_PER_SECOND = 16.5;
const FX_SETTINGS_KEY = 'racing-fx-settings-v1';
const COUNTDOWN_SETTINGS_KEY = 'racing-countdown-enabled-v1';
const FPS_HUD_SETTINGS_KEY = 'racing-show-fps-v1';
const COUNTDOWN_DURATION_SECONDS = 3;
const ZERO_DRIVE_INPUT = { x: 0, z: 0 };
const VEHICLE_SURFACE_RADIUS = 0.5;
const SURFACE_EFFECTS = {
	'surface-wood': { grip: 0.9, drag: 1.35, accel: 1.0, drive: 1.55 },
	'surface-ice': { grip: 0.4, drag: 0.58, accel: 0.45, drive: 0.8 },
	'surface-sand': { grip: 0.72, drag: 2.6, accel: 0.35, drive: 0.5 },
	'surface-custom-a': { grip: 1.2, drag: 1.0, accel: 1.05, drive: 1.15 },
	'surface-custom-b': { grip: 0.55, drag: 0.9, accel: 0.72, drive: 0.85 },
	'surface-custom-c': { grip: 0.95, drag: 1.7, accel: 1.25, drive: 1.3 },
};
const PAD_RESET_TYPE = 'pad-reset';
const VEHICLE_BASE_GRAVITY_FACTOR = 1.5;
const PAD_EFFECTS = {
	'pad-low-gravity': { id: 'low-gravity', gravity: 0.45 },
	'pad-heavy-gravity': { id: 'heavy-gravity', gravity: 1.7 },
	'pad-high-grip': { id: 'high-grip', grip: 2.2, drag: 1.25 },
	'pad-high-speed': { id: 'high-speed', accel: 1.5, drive: 1.6, topSpeed: 1.25 },
	'pad-no-brakes': { id: 'no-brakes', disableBrakes: true },
	'pad-no-steering': { id: 'no-steering', disableSteering: true },
	'pad-no-acceleration': { id: 'no-acceleration', disableAcceleration: true, accel: 0.0, drive: 0.0, drag: 0.18, grip: 0.86 },
	'pad-slow-motion': { id: 'slow-motion', timeScale: 0.6 },
	'pad-fast-motion': { id: 'fast-motion', timeScale: 1.35 },
	'pad-drift': { id: 'drift', grip: 0.32, drag: 0.45, steering: 1.35 },
	'pad-size-small': { id: 'size-small', scale: 0.5 },
	'pad-size-normal': { id: 'size-normal', scale: 1.0 },
	'pad-size-mega': { id: 'size-mega', scale: 1.8 },
	'pad-trick-yaw-1': { id: 'trick-yaw-1', trick: { yaw: 1 } },
	'pad-trick-pitch-1': { id: 'trick-pitch-1', trick: { pitch: 1 } },
	'pad-trick-roll-1': { id: 'trick-roll-1', trick: { roll: 1 } },
	'pad-trick-yaw-pitch-1': { id: 'trick-yaw-pitch-1', trick: { yaw: 1, pitch: 1 } },
	'pad-trick-yaw-roll-1': { id: 'trick-yaw-roll-1', trick: { yaw: 1, roll: 1 } },
	'pad-trick-pitch-roll-1': { id: 'trick-pitch-roll-1', trick: { pitch: 1, roll: 1 } },
	'pad-trick-yaw-pitch-roll-1': { id: 'trick-yaw-pitch-roll-1', trick: { yaw: 1, pitch: 1, roll: 1 } },
	'pad-trick-yaw-roll-pitch': { id: 'trick-yaw-roll-pitch', trick: { yaw: 1, roll: 1, pitch: -1 } },
	'pad-trick-pitch-yaw-roll': { id: 'trick-pitch-yaw-roll', trick: { pitch: 1, yaw: -1, roll: 1 } },
};
const HACK_HITBOX_OPACITY = 0.34;
const HACK_WORLD_OPACITY = 0.52;
const SIZE_PAD_TYPES = new Set( [ 'pad-size-small', 'pad-size-normal', 'pad-size-mega' ] );
const CUSTOM_PAD_TYPES = [ 'pad-custom-a', 'pad-custom-b', 'pad-custom-c' ];
const BOUNCE_VERTICAL_DELTA = 7.2;
const KICK_LATERAL_DELTA = 7.4;
const MAGNET_FULL_STRENGTH_BLOCKS = 0.5;
const MAGNET_DEFAULT_MAX_DISTANCE_BLOCKS = 1.5;
const MAGNET_DEFAULT_FORCE_PER_SECOND = 26.0;
const MAGNET_MIN_MAX_DISTANCE_BLOCKS = 0.75;
const MAGNET_MAX_MAX_DISTANCE_BLOCKS = 2.5;
const MAGNET_MIN_FORCE_PER_SECOND = 8.0;
const MAGNET_MAX_FORCE_PER_SECOND = 64.0;
	const ARC_LINK_TRIGGER_RADIUS = CELL_RAW * GRID_SCALE * 0.32;
	const ARC_LINK_MIN_TIME = 0.45;
	const ARC_LINK_MAX_TIME = 1.6;
	const AIR_TRICK_DURATION_SECONDS = 0.62;
const WEATHER_PRESETS = {
	clear: { bg: 0x7fb6ff, fogNearMul: 0.4, fogFarMul: 0.8, sun: 5.0, hemi: 1.5, exposure: 1.0 },
	cloudy: { bg: 0x9aa4b2, fogNearMul: 0.32, fogFarMul: 0.64, sun: 3.8, hemi: 1.3, exposure: 0.95 },
	sunset: { bg: 0xc7987d, fogNearMul: 0.28, fogFarMul: 0.6, sun: 4.4, hemi: 1.2, exposure: 1.08 },
	night: { bg: 0x0b1220, fogNearMul: 0.24, fogFarMul: 0.5, sun: 1.7, hemi: 0.45, exposure: 0.7 },
	'dawn-mist': { bg: 0xb6c2cc, fogNearMul: 0.2, fogFarMul: 0.42, sun: 2.9, hemi: 1.1, exposure: 0.88 },
};

const WEATHER_SKY_GRADIENTS = {
	clear: { top: '#1f78ff', mid: '#4db2ff', horizon: '#9fd6ff', ground: '#cbe8ff' },
	cloudy: { top: '#4f77a8', mid: '#7ea2cf', horizon: '#d7dff0', ground: '#a8c0dd' },
	sunset: { top: '#3751d8', mid: '#d86c8d', horizon: '#ff9a5f', ground: '#ffd095' },
	night: { top: '#020611', mid: '#0f2145', horizon: '#2a4a80', ground: '#172845' },
	'dawn-mist': { top: '#5f92d0', mid: '#9fc4eb', horizon: '#ffdcb0', ground: '#c5ddf4' },
};

const WEATHER_DEFAULT = 'clear';
const PRECIP_DEFAULT = 'none';
const INTENSITY_DEFAULT = 'medium';
const WIND_DEFAULT = 'none';
const LEADERBOARD_API_BASE = 'https://racing-leaderboard-api.ga1010.workers.dev/api/leaderboard';
const ACCOUNT_API_BASE = 'https://racing-account-api.ga1010.workers.dev/api/accounts';
const TRACK_SHARE_API_ROOT = 'https://racing-track-board-api.ga1010.workers.dev';
const TRACK_SHARE_API_PREFIXES = [ '/api', '' ];
const PLAYER_NAME_KEY = 'racing-player-name-v1';
const MAX_PLAYER_NAME_LENGTH = 24;
const ACCOUNT_SESSION_KEY = 'racing-account-session-v1';
const MAX_LEADERBOARD_ROWS = 15;
const MAX_LEADERBOARD_GHOST_SAMPLES = 2500;
const CAMPAIGN_STAGES = [
	{ type: 'lap-default', goal: 1, text: 'Complete 1 lap on default track' },
	{ type: 'play-share', goal: 1, text: 'Play 1 track from Track Share Board' },
	{ type: 'podium', goal: 1, text: 'Set 1 shared-track podium' },
	{ type: 'publish-track', goal: 1, text: 'Publish your first track' },
	{ type: 'editor-play', goal: 1, text: 'Open editor and launch Play/Quick Test' },
	{ type: 'set-record', goal: 1, text: 'Set your first #1 record' },
	{ type: 'install-mod', goal: 1, text: 'Install 1 mod pack' },
	{ type: 'customize-car', goal: 1, text: 'Customize your car once' },
	{ type: 'beat-authors', goal: 3, text: 'Beat 3 author times' },
	{ type: 'beat-records', goal: 3, text: 'Beat 3 existing records' },
	{ type: 'like-tracks', goal: 3, text: 'Like 3 tracks on the board' },
	{ type: 'play-share', goal: 3, text: 'Play 3 more shared tracks' },
	{ type: 'podium', goal: 3, text: 'Earn 3 podium finishes' },
	{ type: 'set-record', goal: 3, text: 'Set 3 records' },
	{ type: 'beat-authors', goal: 5, text: 'Beat 5 more author times' },
	{ type: 'like-tracks', goal: 6, text: 'Like 6 tracks total' },
	{ type: 'beat-records', goal: 6, text: 'Beat 6 records total' },
	{ type: 'set-record', goal: 5, text: 'Set 5 records total' },
	{ type: 'play-share', goal: 8, text: 'Play 8 shared tracks total' },
	{ type: 'podium', goal: 8, text: 'Reach 8 podiums total' },
	{ type: 'beat-authors', goal: 10, text: 'Beat 10 author times total' },
	{ type: 'endurance-laps', goal: 12, text: 'Complete 12 campaign laps' },
	{ type: 'mastery', goal: 1, text: 'Campaign mastery complete' },
];
const CAMPAIGN_STAGE_COUNT = CAMPAIGN_STAGES.length;
const PRECIP_TYPES = new Set( [ 'none', 'rain', 'snow' ] );
const INTENSITY_TYPES = new Set( [ 'low', 'medium', 'high' ] );
const WIND_TYPES = new Set( [ 'none', 'breezy', 'gusty' ] );
const FIREBASE_ROOM_TIMEOUT_MS = 2200;
const LOADING_PROGRESS_BY_STAGE = {
	boot: 5,
	models: 28,
	track: 46,
	physics: 63,
	leaderboard: 82,
	ready: 100,
};

let loadingOverlayDismissed = false;
const loadingStartedAt = performance.now();

function appendLoadingConsole( message ) {

	const consoleEl = document.getElementById( 'loading-console' );
	if ( ! consoleEl ) return;
	const line = document.createElement( 'div' );
	line.textContent = `[${ ( ( performance.now() - loadingStartedAt ) / 1000 ).toFixed( 2 ) }s] ${ message }`;
	consoleEl.appendChild( line );
	while ( consoleEl.children.length > 18 ) consoleEl.removeChild( consoleEl.firstChild );
	consoleEl.scrollTop = consoleEl.scrollHeight;

}

function setLoadingStatus( message, stage = null ) {

	const statusEl = document.getElementById( 'loading-status' );
	const fillEl = document.getElementById( 'loading-progress-fill' );
	if ( statusEl ) statusEl.textContent = message || '';
	if ( fillEl && stage && Number.isFinite( LOADING_PROGRESS_BY_STAGE[ stage ] ) ) fillEl.style.width = `${ LOADING_PROGRESS_BY_STAGE[ stage ] }%`;
	if ( message ) appendLoadingConsole( message );

}

function hideLoadingOverlay() {

	if ( loadingOverlayDismissed ) return;
	const loadingScreen = document.getElementById( 'loading-screen' );
	if ( ! loadingScreen ) return;
	loadingScreen.classList.add( 'hidden' );
	loadingOverlayDismissed = true;

	// Ensure the landing page is visible on the root path after loading completes
	const landing = document.getElementById( 'home-landing' );
	if ( landing && !landing.classList.contains( 'visible' ) ) {
		const params = new URLSearchParams( location.search );
		const map = params.get( 'map' );
		const pack = params.get( 'pack' );
		const play = params.get( 'play' );
		const isIndexPath = /(?:^|\/)(?:index\.html)?$/.test( location.pathname );
		if ( isIndexPath && !map && !pack && play !== '1' ) {
			landing.classList.add( 'visible' );
		}
	}

}

function showLoadingError( error ) {

	const spinner = document.getElementById( 'loading-spinner' );
	const progress = document.getElementById( 'loading-progress' );
	const statusEl = document.getElementById( 'loading-status' );
	const errorEl = document.getElementById( 'loading-error' );
	const reloadBtn = document.getElementById( 'loading-reload-btn' );
	if ( spinner ) spinner.style.display = 'none';
	if ( progress ) progress.style.display = 'none';
	if ( statusEl ) statusEl.textContent = 'Loading failed.';
	if ( errorEl ) {
		errorEl.textContent = `Error: ${ error?.message || 'Unknown startup error.' }`;
		errorEl.style.display = 'block';
	}
	if ( reloadBtn ) {
		reloadBtn.style.display = 'inline-flex';
		reloadBtn.onclick = () => window.location.reload();
	}

}

function hasFirebaseMultiplayerConfig() {

	return Boolean( readFirebaseConfig() );

}

function updateMultiplayerStatus( text ) {

	const statusEl = document.getElementById( 'mp-status' );
	if ( ! statusEl ) return;
	statusEl.textContent = text || '';

}

const multiplayerSessionState = {
	role: 'none',
	roomCode: '',
	clientId: ( globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `p-${ Math.random().toString( 36 ).slice( 2, 10 ) }` ),
	peerId: '',
	connectedPeers: {},
	peerJoinOrder: [],
	hostPeerId: '',
};

const MULTIPLAYER_ROOM_ROTATE_MS = 120000;
const HOST_ROOM_META_SYNC_MS = 1500;
let lastHostRoomRotateAt = 0;
let lastHostRoomMetaSyncAt = 0;
let migrationSwitchInFlight = false;

function getLocalPeerId() {

	if ( ! multiplayerSessionState.peerId ) multiplayerSessionState.peerId = multiplayerSessionState.clientId;
	return multiplayerSessionState.peerId;

}

function normalizePeerList( peers ) {

	return Array.isArray( peers )
		? peers.filter( ( peerId ) => typeof peerId === 'string' && peerId.trim() )
		: [];

}

function trackConnectedPeer( peerId, meta = {} ) {

	const id = typeof peerId === 'string' ? peerId.trim() : '';
	if ( ! id || id === getLocalPeerId() ) return;
	multiplayerSessionState.connectedPeers[ id ] = { peer: id, ...meta, updatedAt: Date.now() };
	if ( ! multiplayerSessionState.peerJoinOrder.includes( id ) ) multiplayerSessionState.peerJoinOrder.push( id );

}

function untrackConnectedPeer( peerId ) {

	const id = typeof peerId === 'string' ? peerId.trim() : '';
	if ( ! id ) return;
	delete multiplayerSessionState.connectedPeers[ id ];
	multiplayerSessionState.peerJoinOrder = multiplayerSessionState.peerJoinOrder.filter( ( existingId ) => existingId !== id );

}

function syncPeerTopologyFromRoom( room ) {

	const peers = room?.peers && typeof room.peers === 'object' ? room.peers : {};
	const orderedPeers = Object.entries( peers )
		.map( ( [ peerId, meta ] ) => ( { peerId, joinedAt: Number( meta?.joinedAt ) || 0, active: meta?.active !== false } ) )
		.filter( ( peer ) => peer.active )
		.sort( ( a, b ) => a.joinedAt - b.joinedAt || a.peerId.localeCompare( b.peerId ) );
	multiplayerSessionState.peerJoinOrder = orderedPeers.map( ( peer ) => peer.peerId );
	multiplayerSessionState.hostPeerId = room?.hostPeerId || orderedPeers[ 0 ]?.peerId || '';
	multiplayerSessionState.connectedPeers = {};
	for ( const peer of orderedPeers ) trackConnectedPeer( peer.peerId, { joinedAt: peer.joinedAt } );

}

function buildPlayerLeftPacket( peerId ) {

	return { type: 'PLAYER_LEFT', peerId, senderId: peerId, updatedAt: Date.now() };

}

function buildLocalVehiclePacket( now, mapSignature, vehicleInstance ) {

	return {
		type: 'VEHICLE_STATE',
		senderId: getLocalPeerId(),
		peerId: getLocalPeerId(),
		x: Number( vehicleInstance.container.position.x.toFixed( 3 ) ),
		y: Number( vehicleInstance.container.position.y.toFixed( 3 ) ),
		z: Number( vehicleInstance.container.position.z.toFixed( 3 ) ),
		ry: Number( vehicleInstance.container.rotation.y.toFixed( 4 ) ),
		carKey: normalizeMultiplayerCarKey( currentCarKey() ),
		cosmetics: buildGhostCosmeticsSnapshot( currentCarKey() ),
		name: getLocalMultiplayerDisplayName(),
		mapSignature,
		updatedAt: now,
	};

}

function setMultiplayerLeaderboardVisible( visible ) {

	const container = document.getElementById( 'mp-lb' );
	if ( ! container ) return;
	container.style.display = visible ? 'block' : 'none';

}

function renderMultiplayerRoomLeaderboard( lapTimes ) {

	const listEl = document.getElementById( 'mp-lb-list' );
	if ( ! listEl ) return;
	const entries = lapTimes && typeof lapTimes === 'object' ? Object.entries( lapTimes ) : [];
	const rows = entries.map( ( [ id, row ] ) => {

		const time = Number( row?.time ?? row?.bestLap ?? row?.bestLapSeconds );
		const name = typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : `Player ${ String( id || '' ).slice( 0, 4 ).toUpperCase() }`;
		return { id, name, time };

	} ).filter( ( row ) => Number.isFinite( row.time ) );
	rows.sort( ( a, b ) => a.time - b.time );
	listEl.innerHTML = '';
	if ( rows.length === 0 ) {

		const li = document.createElement( 'li' );
		li.textContent = 'No room laps yet.';
		listEl.appendChild( li );
		return;

	}
	for ( const row of rows.slice( 0, 8 ) ) {

		const li = document.createElement( 'li' );
		li.textContent = `${ row.name } — ${ formatLapTime( row.time ) }`;
		listEl.appendChild( li );

	}

}

function getLocalMultiplayerDisplayName() {

	const storedName = sanitizePlayerName( localStorage.getItem( PLAYER_NAME_KEY ) || '' );
	return storedName || `Player ${ multiplayerSessionState.clientId.slice( 0, 4 ).toUpperCase() }`;

}

function normalizeMultiplayerCarKey( value ) {

	const key = typeof value === 'string' ? value.trim() : '';
	if ( CAR_STATS[ key ] && models[ key ] ) return key;
	const lower = key.toLowerCase();
	const fallbackByName = {
		yellow: 'vehicle-truck-yellow',
		green: 'vehicle-truck-green',
		purple: 'vehicle-truck-purple',
		red: 'vehicle-truck-red',
	};
	return fallbackByName[ lower ] || 'vehicle-truck-yellow';

}

async function maybeSubmitOnlinePersonalBest( lapTimes ) {

	if ( ! lapTimes || typeof lapTimes !== 'object' ) return;
	const localName = sanitizePlayerName( playerNameInput?.value || localStorage.getItem( PLAYER_NAME_KEY ) || '' );
	if ( ! localName ) return;
	const encodedClientId = encodeURIComponent( multiplayerSessionState.clientId );
	const localRow = lapTimes[ encodedClientId ] || lapTimes[ multiplayerSessionState.clientId ] || null;
	const ownTime = Number( localRow?.time ?? localRow?.bestLap ?? localRow?.bestLapSeconds );
	const matchingRows = Object.values( lapTimes ).filter( ( row ) => sanitizePlayerName( row?.name ) === localName );
	const bestByName = matchingRows.length > 0
		? Math.min( ...matchingRows.map( ( row ) => Number( row?.time ?? row?.bestLap ?? row?.bestLapSeconds ) ).filter( Number.isFinite ) )
		: Infinity;
	const bestOnlineTime = Number.isFinite( ownTime ) ? ownTime : bestByName;
	if ( ! Number.isFinite( bestOnlineTime ) ) return;
	if ( Number.isFinite( bestLapSeconds ) && bestOnlineTime >= bestLapSeconds - 1e-6 ) return;
	if ( Number.isFinite( lastSyncedOnlineBestLapSeconds ) && bestOnlineTime >= lastSyncedOnlineBestLapSeconds - 1e-6 ) return;
	bestLapSeconds = bestOnlineTime;
	shareImageDataUrl = createShareSnapshot( bestLapSeconds );
	updateLapHud();
	saveLapStats();
	if ( ! accountSession?.token ) {

		showTopMessage( 'Log in to submit your online PB to the global leaderboard.', true, 2600 );
		setModeMenuOpen( true );
		setModeTab( 'account' );

	}
	await submitLeaderboardTime( bestOnlineTime, localName );
	lastSyncedOnlineBestLapSeconds = bestOnlineTime;

}

async function publishMultiplayerBestLap( bestLap ) {

	if ( ! Number.isFinite( bestLap ) ) return;
	const roomCode = multiplayerSessionState.roomCode;
	if ( ! roomCode ) return;
	const displayName = getLocalMultiplayerDisplayName();
	try {

		await firebaseRoomsRequest( roomCode, 'PUT', {
			name: displayName,
			time: Number( bestLap ),
			bestLapSeconds: Number( bestLap ),
			updatedAt: Date.now(),
		}, `lapTimes/${ encodeURIComponent( getLocalPeerId() ) }` );

	} catch ( error ) {

		console.warn( 'Failed to publish multiplayer best lap', error );

	}

}

function getCurrentMapSignature() {

	const params = new URLSearchParams( window.location.search );
	return `${ params.get( 'map' ) || 'default' }|${ params.get( 'mods' ) || 'none' }`;

}

function parseMapSignature( mapSignature ) {

	const raw = String( mapSignature || '' );
	if ( ! raw ) return { map: 'default', mods: 'none' };
	const splitAt = raw.indexOf( '|' );
	if ( splitAt < 0 ) return { map: raw || 'default', mods: 'none' };
	return {
		map: raw.slice( 0, splitAt ) || 'default',
		mods: raw.slice( splitAt + 1 ) || 'none',
	};

}

function redirectToRoomMap( roomCode, mapSignature ) {

	const target = parseMapSignature( mapSignature );
	const params = new URLSearchParams( window.location.search );
	params.set( 'map', target.map );
	if ( target.mods === 'none' ) {

		params.delete( 'mods' );

	} else {

		params.set( 'mods', target.mods );

	}
	params.set( 'joinRoom', String( roomCode || '' ).trim().toUpperCase() );
	window.location.search = params.toString();

}


function getFirebaseRoomsBaseUrl() {

	const config = readFirebaseConfig();
	if ( ! config?.databaseURL ) return '';
	return `${ config.databaseURL.replace( /\/+$/, '' ) }/racing-rooms`;

}

async function firebaseRoomsRequest( roomCode, method = 'GET', payload = undefined, subPath = '' ) {

	const baseUrl = getFirebaseRoomsBaseUrl();
	if ( ! baseUrl ) throw new Error( 'missing-db-url' );
	const safeCode = String( roomCode || '' ).trim().toUpperCase();
	const normalizedSubPath = subPath ? `/${ subPath.replace( /^\/+/, '' ) }` : '';
	const cacheBust = method === 'GET' ? `${ normalizedSubPath ? '&' : '?' }_=${ Date.now() }` : '';
	const url = `${ baseUrl }/${ encodeURIComponent( safeCode ) }${ normalizedSubPath }.json${ cacheBust }`;
	const controller = new AbortController();
	const timeoutId = setTimeout( () => controller.abort(), FIREBASE_ROOM_TIMEOUT_MS );
	let response;
	try {

		response = await fetch( url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: payload === undefined ? undefined : JSON.stringify( payload ),
			cache: 'no-store',
			signal: controller.signal,
		} );

	} catch ( error ) {

		if ( error?.name === 'AbortError' ) throw new Error( 'room-timeout' );
		throw error;

	} finally {

		clearTimeout( timeoutId );

	}
	if ( ! response.ok ) {

		let detail = '';
		try {

			detail = await response.text();

		} catch {

			detail = '';

		}
		throw new Error( `room-http-${ response.status }${ detail ? `:${ detail }` : '' }` );

	}
	return response.json();

}

function isFirebasePermissionError( error ) {

	const msg = String( error?.message || '' ).toLowerCase();
	return msg.includes( 'room-http-401' ) || msg.includes( 'room-http-403' ) || msg.includes( 'permission denied' );

}

function initMultiplayerPanel() {

	const hostBtn = document.getElementById( 'mp-host-btn' );
	const joinBtn = document.getElementById( 'mp-join-btn' );
	const copyBtn = document.getElementById( 'mp-copy-btn' );
	const refreshBtn = document.getElementById( 'mp-refresh-btn' );
	const codeInput = document.getElementById( 'mp-code-input' );
	if ( ! hostBtn || ! joinBtn || ! copyBtn || ! codeInput ) return;

	const configReady = hasFirebaseMultiplayerConfig();
	if ( ! configReady ) {

		hostBtn.disabled = true;
		joinBtn.disabled = true;
		copyBtn.disabled = true;
		updateMultiplayerStatus( 'Multiplayer not set up yet. Ask host to add Firebase keys in js/firebase-config.js.' );
		setMultiplayerLeaderboardVisible( false );
		return;

	}

	hostBtn.addEventListener( 'click', async () => {

		const code = createHostCode();
		codeInput.value = code;
		updateMultiplayerStatus( `Creating room ${ code }...` );
		hostBtn.disabled = true;
		joinBtn.disabled = true;
		copyBtn.disabled = true;
		const now = Date.now();
		const peerId = getLocalPeerId();
		const roomPayload = {
			code,
			mapSignature: getCurrentMapSignature(),
			createdAt: now,
			updatedAt: now,
			status: 'hosting',
			hostPeerId: peerId,
			hostId: peerId,
			newHostId: peerId,
			peerJoinOrder: [ peerId ],
			peers: {
				[ peerId ]: { peerId, joinedAt: now, active: true },
			},
			packets: {},
			relayedPackets: {},
		};
		try {

			await firebaseRoomsRequest( code, 'PUT', roomPayload );
			const verify = await firebaseRoomsRequest( code, 'GET' );
			if ( ! verify || verify.code !== code ) {

				codeInput.value = '';
				updateMultiplayerStatus( 'Room was not saved. Check Firebase databaseURL and RTDB rules for /racing-rooms.' );
				return;

			}
			updateMultiplayerStatus( `Hosting room ${ code }. Share this code with your friends.` );
			multiplayerSessionState.role = 'host';
			multiplayerSessionState.roomCode = code;
			multiplayerSessionState.hostPeerId = peerId;
			multiplayerSessionState.peerJoinOrder = [ peerId ];
			multiplayerSessionState.connectedPeers = {};
			lastHostRoomRotateAt = Date.now();
			lastHostRoomMetaSyncAt = 0;
			setMultiplayerLeaderboardVisible( true );

		} catch ( error ) {

			console.warn( 'Failed to create multiplayer room', error );
			codeInput.value = '';
			if ( isFirebasePermissionError( error ) ) {

				updateMultiplayerStatus( 'Firebase denied write access. Publish RTDB rules for /racing-rooms first.' );
			} else {

				updateMultiplayerStatus( 'Failed to create room. Check Firebase Realtime Database rules and databaseURL.' );

			}
			multiplayerSessionState.role = 'none';
			multiplayerSessionState.roomCode = '';
			setMultiplayerLeaderboardVisible( false );
		} finally {

			hostBtn.disabled = false;
			joinBtn.disabled = false;
			copyBtn.disabled = false;

		}

	} );

	joinBtn.addEventListener( 'click', async () => {

		const code = codeInput.value.trim().toUpperCase();
		if ( ! /^[A-Z0-9]{6}$/.test( code ) ) {

			updateMultiplayerStatus( 'Enter a valid 6-character room code first.' );
			return;

		}

		updateMultiplayerStatus( `Trying to join room ${ code }...` );
		try {

			const room = await firebaseRoomsRequest( code, 'GET' );
			if ( ! room || typeof room !== 'object' ) {

				updateMultiplayerStatus( `Room ${ code } not found. Ask host to click Host first.` );
				return;

			}

			const joinMap = getCurrentMapSignature();
			if ( ! canJoinMap( room.mapSignature, joinMap ) ) {

				updateMultiplayerStatus( `Switching to host map for room ${ code }...` );
				redirectToRoomMap( code, room.mapSignature );
				return;

			}

			const joinedAt = Date.now();
			const peerId = getLocalPeerId();
			const peerJoinOrder = normalizePeerList( room.peerJoinOrder );
			if ( ! peerJoinOrder.includes( peerId ) ) peerJoinOrder.push( peerId );
			await firebaseRoomsRequest( code, 'PATCH', {
				updatedAt: joinedAt,
				lastJoinAt: joinedAt,
				status: 'joined',
				hostPeerId: room.hostPeerId || room.hostId || peerJoinOrder[ 0 ],
				hostId: room.hostPeerId || room.hostId || peerJoinOrder[ 0 ],
				newHostId: room.hostPeerId || room.hostId || peerJoinOrder[ 0 ],
				peerJoinOrder,
				[ `peers/${ peerId }` ]: { peerId, joinedAt, active: true },
			} );
			syncPeerTopologyFromRoom( { ...room, peerJoinOrder, hostPeerId: room.hostPeerId || room.hostId || peerJoinOrder[ 0 ], peers: { ...( room.peers || {} ), [ peerId ]: { peerId, joinedAt, active: true } } } );
			updateMultiplayerStatus( `Joined room ${ code }.` );
			multiplayerSessionState.role = 'join';
			multiplayerSessionState.roomCode = code;
			setMultiplayerLeaderboardVisible( true );

		} catch ( error ) {

			console.warn( 'Failed to join multiplayer room', error );
			if ( isFirebasePermissionError( error ) ) {

				updateMultiplayerStatus( 'Firebase denied read access. Publish RTDB rules for /racing-rooms first.' );
				multiplayerSessionState.role = 'none';
				multiplayerSessionState.roomCode = '';
				setMultiplayerLeaderboardVisible( false );
				return;

			}
			updateMultiplayerStatus( 'Join failed. Verify databaseURL/rules and that host room code is active.' );
			multiplayerSessionState.role = 'none';
			multiplayerSessionState.roomCode = '';
			setMultiplayerLeaderboardVisible( false );

		}

	} );

	copyBtn.addEventListener( 'click', async () => {

		const code = codeInput.value.trim().toUpperCase();
		if ( ! code ) {

			updateMultiplayerStatus( 'Generate or enter a room code before copying.' );
			return;

		}

		try {

			await navigator.clipboard.writeText( code );
			updateMultiplayerStatus( `Copied code ${ code } to clipboard.` );

		} catch {

			updateMultiplayerStatus( `Copy failed. Room code: ${ code }` );

		}

	} );

	refreshBtn?.addEventListener( 'click', async () => {

		if ( ! multiplayerSessionState.roomCode ) {

			updateMultiplayerStatus( 'Join or host a room first.' );
			return;

		}
		updateMultiplayerStatus( `Refreshing room ${ multiplayerSessionState.roomCode } sync...` );
		await syncMultiplayerTransforms( { force: true } );

	} );

	const joinRoomParam = String( new URLSearchParams( window.location.search ).get( 'joinRoom' ) || '' ).trim().toUpperCase();
	if ( /^[A-Z0-9]{6}$/.test( joinRoomParam ) ) {

		codeInput.value = joinRoomParam;
		const params = new URLSearchParams( window.location.search );
		params.delete( 'joinRoom' );
		const nextQuery = params.toString();
		history.replaceState( null, '', `${ window.location.pathname }${ nextQuery ? `?${ nextQuery }` : '' }${ window.location.hash }` );
		setTimeout( () => joinBtn.click(), 0 );

	}

}

async function hostRotateRoomCode( currentRoomCode, mapSignature ) {

	if ( ! currentRoomCode || multiplayerSessionState.role !== 'host' || migrationSwitchInFlight ) return currentRoomCode;
	const nextCode = createHostCode();
	if ( nextCode === currentRoomCode ) return currentRoomCode;
	migrationSwitchInFlight = true;
	try {

		const now = Date.now();
		const nextRoomPayload = {
			code: nextCode,
			mapSignature,
			createdAt: now,
			updatedAt: now,
			status: 'hosting',
		};
		await firebaseRoomsRequest( nextCode, 'PUT', nextRoomPayload );
		await firebaseRoomsRequest( currentRoomCode, 'PATCH', {
			updatedAt: now,
			migration: {
				toCode: nextCode,
				switchedAt: now,
				mapSignature,
			},
			status: 'migrating',
		} );
		multiplayerSessionState.roomCode = nextCode;
		const codeInput = document.getElementById( 'mp-code-input' );
		if ( codeInput ) codeInput.value = nextCode;
		updateMultiplayerStatus( `Switched to fresh room ${ nextCode } to keep sync smooth.` );
		lastHostRoomRotateAt = now;
		return nextCode;

	} catch ( error ) {

		console.warn( 'Failed to rotate multiplayer room code', error );
		return currentRoomCode;

	} finally {

		migrationSwitchInFlight = false;

	}

}

function getMigrationTargetCode( room ) {

	const migration = room?.migration;
	if ( ! migration || typeof migration !== 'object' ) return '';
	const toCode = String( migration.toCode || '' ).trim().toUpperCase();
	if ( ! /^[A-Z0-9]{6}$/.test( toCode ) ) return '';
	return toCode;

}


function normalizeWeatherPreset( preset ) {

	return WEATHER_PRESETS[ preset ] ? preset : WEATHER_DEFAULT;

}

function normalizeWeatherDetails( value ) {

	const next = value || {};
	return {
		preset: normalizeWeatherPreset( next.preset ),
		precipitation: PRECIP_TYPES.has( next.precipitation ) ? next.precipitation : PRECIP_DEFAULT,
		intensity: INTENSITY_TYPES.has( next.intensity ) ? next.intensity : INTENSITY_DEFAULT,
		lightning: Boolean( next.lightning ),
		wind: WIND_TYPES.has( next.wind ) ? next.wind : WIND_DEFAULT,
	};

}



function makeSkyGradientTexture( preset = WEATHER_DEFAULT ) {

	const gradient = WEATHER_SKY_GRADIENTS[ preset ] || WEATHER_SKY_GRADIENTS[ WEATHER_DEFAULT ];
	const canvas = document.createElement( 'canvas' );
	canvas.width = 32;
	canvas.height = 512;
	const ctx = canvas.getContext( '2d' );
	if ( ! ctx ) return null;
	const g = ctx.createLinearGradient( 0, 0, 0, canvas.height );
	g.addColorStop( 0.0, gradient.top );
	g.addColorStop( 0.45, gradient.mid );
	g.addColorStop( 0.78, gradient.horizon );
	g.addColorStop( 1.0, gradient.ground );
	ctx.fillStyle = g;
	ctx.fillRect( 0, 0, canvas.width, canvas.height );
	const tex = new THREE.CanvasTexture( canvas );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;

}


function applySkyPalette( preset = WEATHER_DEFAULT ) {

	const palette = WEATHER_SKY_GRADIENTS[ preset ] || WEATHER_SKY_GRADIENTS[ WEATHER_DEFAULT ];
	skyUniforms.topColor.value.set( palette.top );
	skyUniforms.midColor.value.set( palette.mid );
	skyUniforms.horizonColor.value.set( palette.horizon );
	skyUniforms.groundColor.value.set( palette.ground );

}

function createMovingObstacleState( scene, extras ) {
	const entries = Array.isArray( extras?.movingObstacles ) ? extras.movingObstacles : [];
	const state = { items: [], startTime: 0 };
	for ( const entry of entries ) {
		const [ gxRaw, gzRaw, typeRaw, orientRaw, speedRaw ] = Array.isArray( entry ) ? entry : [];
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const type = String( typeRaw || '' );
		const orient = Number( orientRaw ) || 0;
		const base = new THREE.Vector3( ( gx + 0.5 ) * CELL_RAW * GRID_SCALE, -0.5 + ( CELL_RAW * GRID_SCALE * 0.08 ), ( gz + 0.5 ) * CELL_RAW * GRID_SCALE );
		const obstacle = { type, orient, speed: THREE.MathUtils.clamp( Number( speedRaw ) || 1, 0.25, 3 ), base, mesh: new THREE.Group(), colliders: [] };
		if ( type === 'moving-slide-block' ) {
			const m = new THREE.Mesh( new THREE.BoxGeometry( 2.1, 1.2, 1.5 ), new THREE.MeshStandardMaterial( { color: 0x8ca0b8 } ) );
			obstacle.mesh.add( m );
			obstacle.colliders.push( { half: new THREE.Vector3( 1.05, 0.6, 0.75 ), offset: new THREE.Vector3() } );
		} else if ( type === 'moving-spin-wall' ) {
			const m = new THREE.Mesh( new THREE.BoxGeometry( 3.8, 0.8, 0.55 ), new THREE.MeshStandardMaterial( { color: 0xb4b8bf } ) );
			obstacle.mesh.add( m );
			obstacle.colliders.push( { half: new THREE.Vector3( 1.9, 0.4, 0.275 ), offset: new THREE.Vector3() } );
		} else if ( type === 'moving-custom' ) {
			const cfg = entry?.[5] && typeof entry[5] === 'object' ? entry[5] : {};
			obstacle.custom = cfg;
			const count = Math.max( 1, Math.min( 8, Math.round( Number( cfg.count ) || 1 ) ) );
			for ( let i = 0; i < count; i ++ ) {
				const sx = Number( cfg.sx ) || 2, sy = Number( cfg.sy ) || 0.8, sz = Number( cfg.sz ) || 0.8;
				const shape = String( cfg.shape || 'square' );
				const geom = shape === 'pole' ? new THREE.CylinderGeometry( sx * 0.18, sx * 0.18, sy, 12 ) : new THREE.BoxGeometry( sx, sy, sz );
				const mesh = new THREE.Mesh( geom, new THREE.MeshStandardMaterial( { color: cfg.color || '#ff8844' } ) );
				obstacle.mesh.add( mesh );
				obstacle.colliders.push( { half: new THREE.Vector3( shape === 'pole' ? sx * 0.18 : sx * 0.5, sy * 0.5, shape === 'pole' ? sx * 0.18 : sz * 0.5 ), offset: new THREE.Vector3(), shape } );
			}
		} else if ( type === 'moving-orbit-poles' ) {
			for ( let i = 0; i < 3; i ++ ) {
				const pole = new THREE.Mesh( new THREE.CylinderGeometry( 0.23, 0.23, 1.0, 12 ), new THREE.MeshStandardMaterial( { color: 0x979ea8 } ) );
				obstacle.mesh.add( pole );
				obstacle.colliders.push( { half: new THREE.Vector3( 0.23, 0.5, 0.23 ), offset: new THREE.Vector3() } );
			}
		} else continue;
		obstacle.mesh.position.copy( base );
		scene.add( obstacle.mesh );
		state.items.push( obstacle );
	}
	return state;
}

function resetMovingObstacles( state, now = 0 ) {
	if ( ! state ) return;
	state.startTime = now;
}

function updateMovingObstacles( state, now, vehicleList ) {
	if ( ! state ) return;
	const t = now - ( state.startTime || 0 );
	for ( const obstacle of state.items ) {
		const p = obstacle.base.clone();
		obstacle.mesh.rotation.set( 0, 0, 0 );
		if ( obstacle.type === 'moving-slide-block' ) p.x += Math.sin( t * 1.35 * obstacle.speed ) * 1.7;
		if ( obstacle.type === 'moving-spin-wall' ) obstacle.mesh.rotation.y = t * 0.9 * obstacle.speed;
		if ( obstacle.type === 'moving-custom' ) {
			const cfg = obstacle.custom || {};
			const orbitR = Number( cfg.orbit ) || 0;
			for ( let i = 0; i < obstacle.mesh.children.length; i ++ ) {
				const a = ( t * ( Number( cfg.rot ) || 1 ) * obstacle.speed ) + i * ( Math.PI * 2 / obstacle.mesh.children.length );
				const ox = Math.cos( a ) * orbitR, oz = Math.sin( a ) * orbitR;
				obstacle.mesh.children[i].position.set( ox, 0, oz );
				obstacle.mesh.children[i].rotation.y = a;
				obstacle.colliders[i].offset.set( ox, 0, oz );
			}
		} else if ( obstacle.type === 'moving-orbit-poles' ) {
			for ( let i = 0; i < obstacle.mesh.children.length; i ++ ) {
				const a = t * 1.35 * obstacle.speed + i * ( Math.PI * 2 / 3 );
				obstacle.mesh.children[ i ].position.set( Math.cos( a ) * 1.25, 0, Math.sin( a ) * 1.25 );
				obstacle.colliders[ i ].offset.set( Math.cos( a ) * 1.25, 0, Math.sin( a ) * 1.25 );
			}
		}
		obstacle.mesh.position.copy( p );
		for ( const vehicle of vehicleList ) {
			if ( ! vehicle?.rigidBody ) continue;
			const r = 0.5;
			for ( const collider of obstacle.colliders ) {
				const quat = obstacle.mesh.quaternion;
				const world = collider.offset.clone().applyQuaternion( quat ).add( obstacle.mesh.position );
				const local = vehicle.spherePos.clone().sub( world ).applyQuaternion( quat.clone().invert() );
				const clampedLocal = new THREE.Vector3(
					THREE.MathUtils.clamp( local.x, -collider.half.x, collider.half.x ),
					THREE.MathUtils.clamp( local.y, -collider.half.y, collider.half.y ),
					THREE.MathUtils.clamp( local.z, -collider.half.z, collider.half.z )
				);
				const closest = clampedLocal.clone().applyQuaternion( quat ).add( world );
				const delta = vehicle.spherePos.clone().sub( closest );
				const distSq = delta.lengthSq();
				if ( distSq >= r * r || distSq < 1e-8 ) continue;
				const dist = Math.sqrt( distSq );
				const n = delta.multiplyScalar( 1 / dist );
				const push = ( r - dist ) + 1e-3;
				vehicle.spherePos.addScaledVector( n, push );
				rigidBody.setPosition( vehicle.physicsWorld, vehicle.rigidBody, [ vehicle.spherePos.x, vehicle.spherePos.y, vehicle.spherePos.z ], false );
				const vx = vehicle.sphereVel.x, vy = vehicle.sphereVel.y, vz = vehicle.sphereVel.z;
				const dot = vx * n.x + vy * n.y + vz * n.z;
				if ( dot < 0 ) rigidBody.setLinearVelocity( vehicle.physicsWorld, vehicle.rigidBody, [ vx - dot * n.x, vy - dot * n.y, vz - dot * n.z ] );
			}
		}
	}
}

function decodeExtrasParam( str ) {

	if ( ! str ) return null;

	try {

		const json = decodeURIComponent( escape( atob( str.replace( /-/g, '+' ).replace( /_/g, '/' ) ) ) );
		const parsed = JSON.parse( json );
			return {
				bumps: Array.isArray( parsed.b ) ? parsed.b : [],
				poles: Array.isArray( parsed.p ) ? parsed.p : [],
				cubes: Array.isArray( parsed.k ) ? parsed.k : [],
				walls: Array.isArray( parsed.l ) ? parsed.l : [],
				boosts: Array.isArray( parsed.s ) ? parsed.s : [],
				elevated: Array.isArray( parsed.e ) ? parsed.e : [],
			jumps: Array.isArray( parsed.j ) ? parsed.j : [],
			decorations: Array.isArray( parsed.d ) ? parsed.d : [],
			magnets: Array.isArray( parsed.m ) ? parsed.m : [],
			arcLinks: Array.isArray( parsed.a ) ? parsed.a : [],
			surfaces: Array.isArray( parsed.u ) ? parsed.u : [],
			customSurfaces: parsed?.c && typeof parsed.c === 'object' ? parsed.c : {},
			customPads: parsed?.y && typeof parsed.y === 'object' ? parsed.y : {},
			customAssets: parsed?.x && typeof parsed.x === 'object' ? parsed.x : {},
			movingObstacles: Array.isArray( parsed.o ) ? parsed.o : [],
			worldPreset: parsed.t === 'pool-filled' ? 'pool-filled' : 'normal',
			water: Array.isArray( parsed.q ) ? parsed.q : [],
			customPool: parsed?.r && typeof parsed.r === 'object' ? parsed.r : {},
			weather: normalizeWeatherDetails( parsed?.w ),
		};

	} catch ( e ) {

		console.warn( 'Invalid mods parameter, ignoring extras' );
		return null;

	}

}

async function resolvePackedTrackParams( params ) {

	const localPackId = String( params.get( 'localPack' ) || '' ).trim();
	if ( localPackId ) {

		try {

			const raw = localStorage.getItem( `racing-local-pack:${ localPackId }` );
			if ( raw ) {

				const parsed = JSON.parse( raw );
				return {
					mapParam: typeof parsed?.map === 'string' ? parsed.map : '',
					extrasParam: typeof parsed?.mods === 'string' ? parsed.mods : '',
				};

			}

		} catch ( error ) {

			console.warn( 'Failed to load local packed track payload', error );

		}

	}

	const sharedPackId = String( params.get( 'sharedPack' ) || '' ).trim();
	if ( sharedPackId ) {

		const resolvedShared = await resolveTrackBoardSharedPack( sharedPackId );
		if ( resolvedShared ) return resolvedShared;

	}

	const packId = String( params.get( 'pack' ) || '' ).trim();
	if ( ! packId ) return { mapParam: params.get( 'map' ), extrasParam: params.get( 'mods' ) };
	try {

		let payload = null;
		let lastError = null;
		for ( const prefix of TRACK_SHARE_API_PREFIXES ) {

			const endpoint = `${ TRACK_SHARE_API_ROOT }${ prefix }/packs/${ encodeURIComponent( packId ) }`;
			try {

				const response = await fetch( endpoint, { cache: 'no-store' } );
				if ( ! response.ok ) {

					lastError = new Error( `pack-http-${ response.status }@${ endpoint }` );
					continue;

				}
				const parsed = await response.json();
				if ( ! parsed?.ok ) {

					lastError = new Error( `pack-invalid-response@${ endpoint }` );
					continue;

				}
				payload = parsed;
				break;

			} catch ( error ) {

				lastError = error;

			}

		}
		if ( ! payload?.ok ) throw ( lastError || new Error( 'pack-fetch-failed' ) );
		return {
			mapParam: typeof payload.map === 'string' ? payload.map : '',
			extrasParam: typeof payload.mods === 'string' ? payload.mods : '',
		};

	} catch ( error ) {

		console.warn( 'Failed to load packed track payload', error );
		return { mapParam: params.get( 'map' ), extrasParam: params.get( 'mods' ) };

	}

}

function decodeBase64UrlJsonLoose( value ) {

	const normalized = String( value || '' ).replace( /-/g, '+' ).replace( /_/g, '/' );
	const padded = normalized + '='.repeat( ( 4 - normalized.length % 4 ) % 4 );
	return JSON.parse( atob( padded ) );

}

async function fetchTrackBoardEntries() {

	for ( const prefix of TRACK_SHARE_API_PREFIXES ) {

		try {

			const response = await fetch( `${ TRACK_SHARE_API_ROOT }${ prefix }/tracks`, { cache: 'no-store' } );
			if ( ! response.ok ) continue;
			const data = await response.json();
			return Array.isArray( data?.entries ) ? data.entries : [];

		} catch ( error ) {

			console.warn( 'Failed to fetch track share board entries', error );

		}

	}
	return [];

}

function normalizeTrackPayloadValue( value ) {

	return String( value || '' ).trim();

}

function extractTrackPayloadFromPlayUrl( playUrl ) {

	try {

		const parsed = new URL( playUrl, window.location.href );
		return {
			map: normalizeTrackPayloadValue( parsed.searchParams.get( 'map' ) ),
			mods: normalizeTrackPayloadValue( parsed.searchParams.get( 'mods' ) ),
			pack: normalizeTrackPayloadValue( parsed.searchParams.get( 'pack' ) ),
			localPack: normalizeTrackPayloadValue( parsed.searchParams.get( 'localPack' ) ),
			sharedPack: normalizeTrackPayloadValue( parsed.searchParams.get( 'sharedPack' ) ),
		};

	} catch ( error ) {

		return { map: '', mods: '', pack: '', localPack: '', sharedPack: '' };

	}

}

function trackBoardEntryMatchesCurrentPayload( entry, searchParams, mapParam, extrasParam ) {

	if ( ! entry?.playUrl ) return false;
	const current = {
		map: normalizeTrackPayloadValue( mapParam || searchParams.get( 'map' ) ),
		mods: normalizeTrackPayloadValue( extrasParam || searchParams.get( 'mods' ) ),
		pack: normalizeTrackPayloadValue( searchParams.get( 'pack' ) ),
		localPack: normalizeTrackPayloadValue( searchParams.get( 'localPack' ) ),
		sharedPack: normalizeTrackPayloadValue( searchParams.get( 'sharedPack' ) ),
	};
	const entryPayload = extractTrackPayloadFromPlayUrl( entry.playUrl );
	if ( current.sharedPack && String( entry.id ) === current.sharedPack ) return true;
	if ( current.pack && entryPayload.pack === current.pack ) return true;
	if ( current.localPack && entryPayload.localPack === current.localPack ) return true;
	if ( current.sharedPack && entryPayload.sharedPack === current.sharedPack ) return true;
	return Boolean( current.map ) && entryPayload.map === current.map && entryPayload.mods === current.mods;

}

async function updateDocumentTitleFromTrackBoard( searchParams, mapParam, extrasParam ) {

	const hasPayload = Boolean(
		searchParams.get( 'map' ) ||
		searchParams.get( 'mods' ) ||
		searchParams.get( 'pack' ) ||
		searchParams.get( 'localPack' ) ||
		searchParams.get( 'sharedPack' ) ||
		mapParam ||
		extrasParam
	);
	if ( ! hasPayload ) return;
	try {

		const entries = await fetchTrackBoardEntries();
		const match = entries.find( ( entry ) => trackBoardEntryMatchesCurrentPayload( entry, searchParams, mapParam, extrasParam ) );
		const trackName = String( match?.name || '' ).trim();
if ( trackName ) {
    // document.title = trackName;
}
	} catch ( error ) {

		console.warn( 'Failed to update document title from track share board', error );

	}

}

async function resolveTrackBoardSharedPack( sharedPackId ) {

	if ( ! sharedPackId ) return null;
	try {

		const entries = await fetchTrackBoardEntries();
		const match = entries.find( ( entry ) => String( entry?.id ) === sharedPackId );
		if ( ! match?.playUrl ) return null;
		const parsed = new URL( match.playUrl, window.location.href );
		const hash = new URLSearchParams( parsed.hash.replace( /^#/, '' ) );
		const ghostBlob = hash.get( 'ghost' );
		if ( ! ghostBlob ) return null;
		const decoded = decodeBase64UrlJsonLoose( ghostBlob );
		const pack = decoded?.pack && typeof decoded.pack === 'object' ? decoded.pack : {};
		if ( typeof pack.map !== 'string' ) return null;
		return { mapParam: pack.map, extrasParam: typeof pack.mods === 'string' ? pack.mods : '' };

	} catch ( error ) {

		console.warn( 'Failed to resolve sharedPack from track board', error );
		return null;

	}

}

function sanitizePlayerName( value ) {

	const stripped = String( value || '' ).replace( /\s+/g, ' ' ).trim();
	return stripped.slice( 0, MAX_PLAYER_NAME_LENGTH );

}

function getTrackLabel( mapParamValue ) {

	if ( mapParamValue ) return `Custom ${ mapParamValue.slice( 0, 10 ) }`;
	return 'Default Track';

}

function getTrackId( mapParamValue, extrasParamValue ) {

	const params = new URLSearchParams();
	if ( mapParamValue ) params.set( 'map', mapParamValue );
	if ( extrasParamValue ) params.set( 'mods', extrasParamValue );
	const normalizedPath = normalizeTrackPath( window.location.pathname );
	const rawUrl = `${ normalizedPath }${ params.toString() ? `?${ params.toString() }` : '' }`;
	return `trk-${ hashTrackSeed( `v4-url|${ rawUrl }` ) }`;

}

function getLegacyTrackIds( mapParamValue, extrasParamValue ) {

	return [];

}

function normalizeTrackPath( pathValue ) {

	const raw = String( pathValue || '/' );
	if ( raw === '/index.html' ) return '/';
	if ( raw.endsWith( '/index.html' ) ) return `${ raw.slice( 0, -11 ) }/`;
	return raw;

}

function encodeBase64Url( value ) {

	return btoa( value ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );

}

function hashTrackSeed( value ) {

	const hashA = fnv64Hex( value, 0xcbf29ce484222325n, 0x100000001b3n );
	const hashB = fnv64Hex( value, 0x84222325cbf29cen, 0x100000001c3n );
	return `${ hashA }${ hashB }`;

}

function fnv64Hex( value, start, prime ) {

	let hash = start;

	for ( let i = 0; i < value.length; i ++ ) {

		hash ^= BigInt( value.charCodeAt( i ) );
		hash = ( hash * prime ) & 0xffffffffffffffffn;

	}

	return hash.toString( 16 ).padStart( 16, '0' );

}


function readInstalledRuntimeMods() {

	try {

		const parsed = JSON.parse( localStorage.getItem( 'racing-installed-mods-v1' ) || '[]' );
		const list = Array.isArray( parsed ) ? parsed : [];
		if ( ! list.some( ( mod ) => mod?.id === 'freecam' ) ) list.push( { id: 'freecam', name: 'Freecam', entry: 'mods/Freecam.js' } );
		return list;

	} catch {

		return [];

	}

}

function normalizeModEntryPath( entryPath ) {

	if ( ! entryPath || typeof entryPath !== 'string' ) return null;
	if ( entryPath.startsWith( 'data:text/javascript' ) ) return entryPath;
	if ( entryPath.startsWith( './' ) ) return `../${ entryPath.slice( 2 ) }`;
	if ( entryPath.startsWith( '/' ) ) return entryPath;
	return `../${ entryPath }`;

}


function toRuntimeMod( loadedModule, modId ) {

	const runtime = loadedModule?.default || loadedModule?.TAS_MOD || loadedModule?.mod || null;
	if ( runtime && typeof runtime.init === 'function' ) return runtime;
	if ( typeof loadedModule?.applyCustomMod === 'function' ) {

		let disposer = null;
		return {
			id: modId || 'custom',
			init( context ) {

				disposer = loadedModule.applyCustomMod( {
					game: context,
					bus: context?.world,
				} );

			},
			dispose() {

				if ( typeof disposer === 'function' ) disposer();
				disposer = null;

			}
		};

	}
	return null;

}

async function loadRuntimeMods() {

	const installed = readInstalledRuntimeMods();

	if ( installed.length === 0 ) return [];
	const runtimes = [];
	for ( const mod of installed ) {

		const entryPath = normalizeModEntryPath( mod?.entry );
		if ( ! entryPath ) continue;
		try {

			const loaded = await import( entryPath );
			const runtime = toRuntimeMod( loaded, mod?.id );
			if ( runtime ) runtimes.push( runtime );

		} catch ( error ) {

			console.warn( `Failed to load mod runtime: ${ mod?.id || 'unknown' }`, error );

		}

	}
	return runtimes;

}

function getRequiredModelNames( customCells, extras, carKeys ) {

	const required = new Set( carKeys );
	for ( const [ , , key ] of ( customCells || TRACK_CELLS ) ) {
		required.add( key === 'track-checkpoint' || key === 'track-start' || key === 'track-start-finish' ? 'track-finish' : key );
	}
	if ( extras?.worldPreset !== 'pool-filled' ) {
		required.add( 'decoration-empty' );
		required.add( 'decoration-forest' );
		// Default tracks include hand-authored tent decoration cells, so load that model too.
		if ( ! customCells ) required.add( 'decoration-tents' );
	}
	if ( Array.isArray( extras?.bumps ) && extras.bumps.length ) required.add( 'track-bump' );
	if ( Array.isArray( extras?.decorations ) ) {
		for ( const deco of extras.decorations ) if ( typeof deco?.[ 2 ] === 'string' ) required.add( deco[ 2 ] );
	}
	if ( Array.isArray( extras?.elevated ) ) {
		for ( const entry of extras.elevated ) {
			if ( entry?.[ 2 ] === 'elevated-corner' ) required.add( 'track-corner' );
			else if ( entry?.[ 2 ] === 'elevated-checkpoint' ) required.add( 'track-finish' );
			else required.add( 'track-straight' );
		}
	}
	return modelNames.filter( ( name ) => required.has( name ) );

}

async function loadModels( requiredNames = modelNames ) {

	const promises = requiredNames.map( ( name ) =>
		new Promise( ( resolve, reject ) => {

			loader.load( `models/${ name }.glb`, ( gltf ) => {

				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh ) {

						child.material.side = THREE.FrontSide;

					}

				} );

				// Godot imports vehicle models at root_scale=0.5
				if ( name.startsWith( 'vehicle-' ) ) {

					gltf.scene.scale.setScalar( 0.5 );

				}

				models[ name ] = gltf.scene;
				resolve();

			}, undefined, reject );

		} )
	);

	await Promise.all( promises );
	appendLoadingConsole( `Ready with ${ requiredNames.length } optimized models.` );

}

function normalizeImportedObjectToCell( root ) {

	const box = new THREE.Box3().setFromObject( root );
	const size = new THREE.Vector3();
	const center = new THREE.Vector3();
	box.getSize( size );
	box.getCenter( center );
	const maxDim = Math.max( size.x, size.z, 1e-4 );
	const scale = CELL_RAW / maxDim;
	root.position.sub( center );
	root.position.y -= box.min.y - center.y;
	root.scale.multiplyScalar( scale );
	root.updateMatrixWorld( true );

}

async function loadCustomTrackAssets( extras ) {

	const entries = Object.entries( extras?.customAssets || {} ).slice( 0, 32 );
	for ( const [ id, asset ] of entries ) {

		if ( ! asset?.dataUrl ) continue;
		const modelKey = `custom:${ id }`;
		try {

			let scene = null;
			if ( asset.format === 'obj' ) {

				const text = await ( await fetch( asset.dataUrl ) ).text();
				scene = objLoader.parse( text );

			} else {

				scene = await new Promise( ( resolve, reject ) => loader.load( asset.dataUrl, ( gltf ) => resolve( gltf.scene ), undefined, reject ) );

			}
			if ( ! scene ) continue;
			normalizeImportedObjectToCell( scene );
			scene.traverse( ( child ) => {

				if ( child.isMesh ) child.material.side = THREE.FrontSide;

			} );
			models[ modelKey ] = scene;

		} catch ( error ) {

			console.warn( 'Failed to load custom track asset', id, error );

		}

	}

}

async function init() {

	setLoadingStatus( 'Booting game systems…', 'boot' );

	appendLoadingConsole( 'Before registerAll' );

	registerAll();

	appendLoadingConsole( 'After registerAll' );

	setLoadingStatus( 'Resolving track data…', 'track' );

	appendLoadingConsole( 'Before loadRuntimeMods' );

	const runtimeModsPromise = loadRuntimeMods();

	appendLoadingConsole( 'After loadRuntimeMods' );

	appendLoadingConsole( 'Before URLSearchParams' );

	const searchParams = new URLSearchParams( window.location.search );

	appendLoadingConsole( 'After URLSearchParams' );

	appendLoadingConsole( 'Before resolvePackedTrackParams' );

	const { mapParam, extrasParam } = await resolvePackedTrackParams( searchParams );

	appendLoadingConsole( 'After resolvePackedTrackParams' );

	updateDocumentTitleFromTrackBoard( searchParams, mapParam, extrasParam );

	const isSplitScreen = new URLSearchParams( window.location.search ).get( 'multiplayer' ) === '1';
	const editorQuickTestEnabled = searchParams.get( 'editorQuickTest' ) === '1';
	const replayViewerMode = searchParams.get( 'replayViewer' ) === '1';
	const editorReturnParam = String( searchParams.get( 'editorReturn' ) || '' );
	const editorGhostMapHash = String( searchParams.get( 'editorGhostMap' ) || '' );
	const QUICK_TEST_GHOST_KEY = 'racing-editor-quicktest-ghost-v1';
	const QUICK_TEST_GHOST_MAP_KEY = 'racing-editor-quicktest-map-v1';
	const ghostEnabled = ! isSplitScreen;

	if ( replayViewerMode ) document.body.classList.add( 'replay-viewer-mode' );
	if ( isSplitScreen ) renderer.setPixelRatio( 1 );

	let customCells = null;
	let spawn = null;

	const extras = decodeExtrasParam( extrasParam );
	const carKeys = Object.keys( CAR_STATS );
	const deterministicCarSeed = hashTrackSeed( `${ mapParam || 'default' }|${ extrasParam || 'none' }` );

	const pickRandomCarKey = () => {

		const slice = deterministicCarSeed.slice( 0, 8 );
		const index = Number.parseInt( slice, 16 ) % carKeys.length;
		return carKeys[ index ];

	};

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}
	if ( extras?.worldPreset === 'pool-filled' ) {
		const generatedWater = computePoolPresetWaterCells( customCells || TRACK_CELLS, extras );
		const explicitWater = Array.isArray( extras.water ) ? extras.water : [];
		const waterByKey = new Map( [ ...generatedWater, ...explicitWater ].map( ( cell ) => [ `${ cell[ 0 ] },${ cell[ 1 ] }`, cell ] ) );
		extras.water = [ ...waterByKey.values() ];
	}
	const requiredModelNames = getRequiredModelNames( customCells, extras, carKeys );
	setLoadingStatus( `Loading ${ requiredModelNames.length } needed models…`, 'models' );
	await Promise.all( [ loadModels( requiredModelNames ), loadCustomTrackAssets( extras ) ] );
	setLoadingStatus( 'Loading track and mods…', 'track' );
	const runtimeMods = await runtimeModsPromise;
	const testSpawnRaw = String( searchParams.get( 'testSpawn' ) || '' ).trim();
	if ( testSpawnRaw ) {

		const [ gxRaw, gzRaw, orientRaw ] = testSpawnRaw.split( ',' );
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		const orient = Number( orientRaw );
		if ( Number.isFinite( gx ) && Number.isFinite( gz ) ) {

			const x = ( gx + 0.5 ) * CELL_RAW * GRID_SCALE;
			const z = ( gz + 0.5 ) * CELL_RAW * GRID_SCALE;
			const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
			spawn = { position: [ x, 0.5, z ], angle };

		}

	}

	// Compute track bounds and size physics/shadows to fit
	const bounds = computeTrackBounds( customCells );
	const hw = bounds.halfWidth;
	const hd = bounds.halfDepth;
	const groundSize = Math.max( hw, hd ) * 2 + 20;
	const weatherSettings = normalizeWeatherDetails( extras?.weather );
	const weatherConfig = WEATHER_PRESETS[ weatherSettings.preset ];

	const shadowExtent = Math.max( hw, hd ) + 10;
	dirLight.shadow.camera.left = - shadowExtent;
	dirLight.shadow.camera.right = shadowExtent;
	dirLight.shadow.camera.top = shadowExtent;
	dirLight.shadow.camera.bottom = - shadowExtent;
	dirLight.shadow.camera.updateProjectionMatrix();

	applySkyPalette( weatherSettings.preset );
	scene.background = new THREE.Color( weatherConfig.bg );
	const gameplayFog = new THREE.Fog( weatherConfig.bg, groundSize * weatherConfig.fogNearMul, groundSize * weatherConfig.fogFarMul );
	scene.fog = gameplayFog;
	dirLight.intensity = weatherConfig.sun;
	hemiLight.intensity = weatherConfig.hemi;
	renderer.toneMappingExposure = weatherConfig.exposure;
	fillLight.intensity = weatherConfig.hemi * 0.16;
	const baseWeatherLight = {
		sun: weatherConfig.sun,
		hemi: weatherConfig.hemi,
		exposure: weatherConfig.exposure,
	};

	buildTrack( scene, models, customCells, extras );
	const movingObstacleState = createMovingObstacleState( scene, extras );


	const worldSettings = createWorldSettings();
	setLoadingStatus( 'Setting up physics world…', 'physics' );
	worldSettings.gravity = [ 0, - 9.81, 0 ];

	const BPL_MOVING = addBroadphaseLayer( worldSettings );
	const BPL_STATIC = addBroadphaseLayer( worldSettings );
	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );

	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
	enableCollision( worldSettings, OL_MOVING, OL_MOVING );

	const world = createWorld( worldSettings );
	world._OL_MOVING = OL_MOVING;
	world._OL_STATIC = OL_STATIC;

	const hitboxDebugGroup = new THREE.Group();
	hitboxDebugGroup.visible = false;
	hitboxDebugGroup.userData.isHackHitboxDebug = true;
	scene.add( hitboxDebugGroup );
	const resettableObstacleBodies = buildWallColliders( world, hitboxDebugGroup, customCells, extras ) || [];

	const roadHalf = groundSize / 2;
	const waterCells = Array.isArray( extras?.water ) ? extras.water : [];
	const waterCellSet = new Set( waterCells.map( ( [ gx, gz ] ) => `${ gx },${ gz }` ) );
	const cellWorld = CELL_RAW * GRID_SCALE;
	const customPoolSettings = extras?.customPool && typeof extras.customPool === 'object' ? extras.customPool : {};
	const WATER_BUOYANCY = THREE.MathUtils.clamp( Number( customPoolSettings.buoyancy ) || 0.28, 0.05, 3 );
	const WATER_GRAVITY_SCALE = Math.min( WATER_BUOYANCY, 1 );
	const WATER_VELOCITY_DRAG = THREE.MathUtils.clamp( Number( customPoolSettings.drag ) || 1.8, 0.1, 6 );
	function isCameraTargetInWater( position ) {

		if ( waterCellSet.size === 0 || ! position ) return false;
		const gx = Math.floor( position.x / cellWorld );
		const gz = Math.floor( position.z / cellWorld );
		return waterCellSet.has( `${ gx },${ gz }` ) && position.y < 0;

	}
	function createWaterCameraState() {

		return { underwater: false, exitTimer: 0 };

	}
	function updateWaterCameraState( state, position, deltaSeconds ) {

		if ( ! state || ! position ) return false;
		const gx = Math.floor( position.x / cellWorld );
		const gz = Math.floor( position.z / cellWorld );
		const inWaterCell = waterCellSet.has( `${ gx },${ gz }` );
		const safeDelta = Math.max( 0, deltaSeconds );
		if ( ! state.underwater ) {

			if ( inWaterCell && position.y < 0.25 ) {

				state.underwater = true;
				state.exitTimer = 0;

			}
			return state.underwater;

		}
		const clearlyOutOfWater = ! inWaterCell || position.y > 1.1;
		state.exitTimer = clearlyOutOfWater ? state.exitTimer + safeDelta : 0;
		if ( state.exitTimer >= 0.35 ) {

			state.underwater = false;
			state.exitTimer = 0;

		}
		return state.underwater;

	}
	const waterCameraState1 = createWaterCameraState();
	const waterCameraState2 = createWaterCameraState();

	function applyWaterPhysicsDamping( targetVehicle, deltaSeconds ) {

		if ( ! isCameraTargetInWater( targetVehicle?.spherePos ) || ! targetVehicle?.rigidBody?.motionProperties ) return false;
		const safeDelta = Math.max( 0, deltaSeconds );
		const dragFactor = Math.exp( - WATER_VELOCITY_DRAG * safeDelta );
		const velocity = targetVehicle.rigidBody.motionProperties.linearVelocity || [ 0, 0, 0 ];
		const upwardFloatVelocity = Math.max( 0, WATER_BUOYANCY - 1 ) * 12 * safeDelta;
		const verticalVelocity = THREE.MathUtils.clamp( ( velocity[ 1 ] * Math.sqrt( dragFactor ) ) + upwardFloatVelocity, -18, 8 );
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			velocity[ 0 ] * dragFactor,
			verticalVelocity,
			velocity[ 2 ] * dragFactor,
		], false );
		targetVehicle.linearSpeed *= dragFactor;
		return true;

	}
	function createGroundSurfaceCollider( halfExtents, position ) {

		rigidBody.create( world, {
			shape: box.create( { halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: OL_STATIC,
			position,
			friction: 5.0,
			restitution: 0.0,
		} );

		const bevelAngle = THREE.MathUtils.degToRad( 1.6 );
		const bevelDepth = Math.min( cellWorld * 0.08, Math.max( 0.08, Math.min( halfExtents[ 0 ], halfExtents[ 2 ] ) * 0.35 ) );
		const bevelHalfHeight = 0.008;
		const bevelY = position[ 1 ] + halfExtents[ 1 ] - bevelHalfHeight;
		const edges = [
			{ x: position[ 0 ], z: position[ 2 ] - halfExtents[ 2 ], yaw: 0, pitch: - bevelAngle, half: [ halfExtents[ 0 ], bevelHalfHeight, bevelDepth ] },
			{ x: position[ 0 ], z: position[ 2 ] + halfExtents[ 2 ], yaw: 0, pitch: bevelAngle, half: [ halfExtents[ 0 ], bevelHalfHeight, bevelDepth ] },
			{ x: position[ 0 ] - halfExtents[ 0 ], z: position[ 2 ], yaw: Math.PI / 2, pitch: bevelAngle, half: [ halfExtents[ 2 ], bevelHalfHeight, bevelDepth ] },
			{ x: position[ 0 ] + halfExtents[ 0 ], z: position[ 2 ], yaw: Math.PI / 2, pitch: - bevelAngle, half: [ halfExtents[ 2 ], bevelHalfHeight, bevelDepth ] },
		];
		for ( const edge of edges ) {

			if ( edge.half[ 0 ] < 0.05 ) continue;
			const edgeQuat = new THREE.Quaternion().setFromEuler( new THREE.Euler( edge.pitch, edge.yaw, 0, 'YXZ' ) );
			rigidBody.create( world, {
				shape: box.create( { halfExtents: edge.half } ),
				motionType: MotionType.STATIC,
				objectLayer: OL_STATIC,
				position: [ edge.x, bevelY, edge.z ],
				quaternion: [ edgeQuat.x, edgeQuat.y, edgeQuat.z, edgeQuat.w ],
				friction: 5.0,
				restitution: 0.0,
			} );

		}

	}
	if ( waterCells.length > 0 ) {

		const waterSet = waterCellSet;
		const minGx = Math.floor( ( bounds.centerX - roadHalf ) / cellWorld ) - 1;
		const maxGx = Math.ceil( ( bounds.centerX + roadHalf ) / cellWorld ) + 1;
		const minGz = Math.floor( ( bounds.centerZ - roadHalf ) / cellWorld ) - 1;
		const maxGz = Math.ceil( ( bounds.centerZ + roadHalf ) / cellWorld ) + 1;
		const activeGroundRuns = new Map();
		function flushGroundRun( runStart, runEnd, startGz, endGz ) {

			const runCellsX = runEnd - runStart + 1;
			const runCellsZ = endGz - startGz + 1;
			createGroundSurfaceCollider(
				[ cellWorld * runCellsX * 0.5, 0.01, cellWorld * runCellsZ * 0.5 ],
				[ ( runStart + runCellsX * 0.5 ) * cellWorld, - 0.125, ( startGz + runCellsZ * 0.5 ) * cellWorld ]
			);

		}

		for ( let gz = minGz; gz <= maxGz; gz ++ ) {

			const currentRowRuns = new Set();
			let runStart = null;
			for ( let gx = minGx; gx <= maxGx + 1; gx ++ ) {

				const isSolidGround = gx <= maxGx && ! waterSet.has( `${ gx },${ gz }` );
				if ( isSolidGround && runStart === null ) runStart = gx;
				if ( ( ! isSolidGround || gx > maxGx ) && runStart !== null ) {

					const runEnd = gx - 1;
					const runKey = `${ runStart },${ runEnd }`;
					currentRowRuns.add( runKey );
					if ( activeGroundRuns.has( runKey ) ) activeGroundRuns.get( runKey ).endGz = gz;
					else activeGroundRuns.set( runKey, { runStart, runEnd, startGz: gz, endGz: gz } );
					runStart = null;

				}

			}

			for ( const [ runKey, run ] of [ ...activeGroundRuns.entries() ] ) {

				if ( currentRowRuns.has( runKey ) ) continue;
				flushGroundRun( run.runStart, run.runEnd, run.startGz, run.endGz );
				activeGroundRuns.delete( runKey );

			}

		}
		for ( const run of activeGroundRuns.values() ) flushGroundRun( run.runStart, run.runEnd, run.startGz, run.endGz );

	} else {

		createGroundSurfaceCollider( [ roadHalf, 0.01, roadHalf ], [ bounds.centerX, - 0.125, bounds.centerZ ] );

	}

	const sphereBody = createSphereBody( world, spawn ? spawn.position : null );
	const carHitboxMaterial = new THREE.MeshBasicMaterial( {
		color: 0x0b2f75,
		transparent: true,
		opacity: HACK_HITBOX_OPACITY,
		depthWrite: false,
	} );
	const carHitboxMesh = new THREE.Mesh( new THREE.SphereGeometry( VEHICLE_SURFACE_RADIUS, 20, 14 ), carHitboxMaterial );
	carHitboxMesh.userData.isHackHitboxDebug = true;
	carHitboxMesh.visible = false;
	scene.add( carHitboxMesh );
	const originalHackTransparencyByMaterial = new Map();
	let hackVisualsApplied = false;

	const player1CarKey = isSplitScreen ? pickRandomCarKey() : 'vehicle-truck-yellow';
	const player2CarKey = isSplitScreen ? pickRandomCarKey() : 'vehicle-truck-red';
	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;

	// ── HUD Extras: speedometer, minimap, shortcuts overlay ──
	let hudExtras = null;
	vehicle.setSpawn( spawn ? spawn.position : [ 3.5, 0.5, 5 ], spawn ? spawn.angle : 0 );
	vehicle.setPerformance( CAR_STATS[ player1CarKey ].perf );

	if ( spawn ) {

		const [ sx, sy, sz ] = spawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = spawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ player1CarKey ] );
	scene.add( vehicleGroup );
	let vehicle2 = null;
	let sphereBody2 = null;
	if ( isSplitScreen ) {

		const spawnPos2 = spawn ? [ ...spawn.position ] : [ 3.5, 0.5, 5 ];
		const spawnAngle = spawn ? spawn.angle : 0;
		spawnPos2[ 0 ] += Math.cos( spawnAngle ) * 1.3;
		spawnPos2[ 2 ] += - Math.sin( spawnAngle ) * 1.3;
		sphereBody2 = createSphereBody( world, spawnPos2 );
		vehicle2 = new Vehicle();
		vehicle2.rigidBody = sphereBody2;
		vehicle2.physicsWorld = world;
		vehicle2.setSpawn( spawnPos2, spawnAngle );
		vehicle2.setPerformance( CAR_STATS[ player2CarKey ].perf );
		const vehicleGroup2 = vehicle2.init( models[ player2CarKey ] );
		scene.add( vehicleGroup2 );

	}
	const remotePlayerVisuals = new Map();
	const REMOTE_PLAYER_STALE_MS = 4000;
	const REMOTE_SYNC_MS = 220;

	function createRemoteNameTag( displayName ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = 256;
		canvas.height = 64;
		const ctx = canvas.getContext( '2d' );
		if ( ! ctx ) return null;
		ctx.clearRect( 0, 0, canvas.width, canvas.height );
		ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
		ctx.fillRect( 12, 8, 232, 48 );
		ctx.fillStyle = '#ffffff';
		ctx.font = '700 22px sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText( ( displayName || 'Player' ).slice( 0, 20 ), 128, 32 );
		const texture = new THREE.CanvasTexture( canvas );
		texture.needsUpdate = true;
		const material = new THREE.SpriteMaterial( { map: texture, transparent: true, depthWrite: false } );
		const sprite = new THREE.Sprite( material );
		sprite.scale.set( 2.4, 0.6, 1 );
		sprite.position.set( 0, 2.38, 0 );
		return sprite;

	}

	function ensureRemotePlayerVisual( playerId, carKey ) {

		return ensureRemotePlayerVisualWithCosmetics( playerId, carKey, null );

	}

	function cosmeticsSignature( cosmetics ) {

		const normalized = normalizeGhostCosmeticsPayload( cosmetics );
		return normalized ? JSON.stringify( normalized ) : '';

	}

	function ensureRemotePlayerVisualWithCosmetics( playerId, carKey, cosmetics ) {

		const modelKey = normalizeMultiplayerCarKey( carKey );
		const signature = cosmeticsSignature( cosmetics );
		const existing = remotePlayerVisuals.get( playerId );
		if ( existing && existing.carKey === modelKey && existing.cosmeticsSignature === signature ) return existing;
		if ( existing ) removeRemotePlayerVisual( playerId );
		const model = models[ modelKey ] || models[ 'vehicle-truck-yellow' ];
		const mesh = createGhostVisualModel( model, 0.42, cosmetics ) || new THREE.Mesh(
			new THREE.BoxGeometry( 0.95, 0.5, 1.7 ),
			new THREE.MeshStandardMaterial( { color: 0x53d4ff, transparent: true, opacity: 0.38, depthWrite: false } ),
		);
		mesh.traverse?.( ( obj ) => {

			if ( ! obj?.isMesh ) return;
			if ( Array.isArray( obj.material ) ) {

				for ( const mat of obj.material ) {

					if ( ! mat ) continue;
					mat.transparent = false;
					mat.opacity = 1.0;
					mat.depthWrite = true;

				}

			} else if ( obj.material ) {

				obj.material.transparent = false;
				obj.material.opacity = 1.0;
				obj.material.depthWrite = true;

			}
			obj.castShadow = true;
			obj.receiveShadow = true;

		} );
		scene.add( mesh );
		const state = {
			mesh,
			carKey: modelKey,
			cosmeticsSignature: signature,
			displayName: 'Player',
			nameTag: null,
			targetPos: mesh.position.clone(),
			targetRotY: mesh.rotation.y,
			lastSeenAt: 0,
		};
		remotePlayerVisuals.set( playerId, state );
		return state;

	}

	function ensureRemoteNameTag( state, displayName ) {

		const safeName = sanitizePlayerName( displayName ) || 'Player';
		if ( state.displayName === safeName && state.nameTag ) return;
		if ( state.nameTag ) {

			state.mesh.remove( state.nameTag );
			state.nameTag.material?.map?.dispose?.();
			state.nameTag.material?.dispose?.();

		}
		state.displayName = safeName;
		state.nameTag = createRemoteNameTag( safeName );
		if ( state.nameTag ) state.mesh.add( state.nameTag );

	}

	function removeRemotePlayerVisual( playerId ) {

		const state = remotePlayerVisuals.get( playerId );
		if ( ! state ) return;
		const mesh = state.mesh;
		if ( state.nameTag ) {

			mesh.remove( state.nameTag );
			state.nameTag.material?.map?.dispose?.();
			state.nameTag.material?.dispose?.();

		}
		scene.remove( mesh );
		mesh.traverse?.( ( obj ) => {

			if ( obj?.isMesh ) {

				obj.geometry?.dispose?.();
				if ( Array.isArray( obj.material ) ) obj.material.forEach( ( mat ) => mat?.dispose?.() );
				else obj.material?.dispose?.();

			}

		} );
		remotePlayerVisuals.delete( playerId );

	}

	function updateRemotePlayerVisualsFrame( dt ) {

		const alpha = THREE.MathUtils.clamp( dt * 10, 0, 1 );
		for ( const state of remotePlayerVisuals.values() ) {

			state.mesh.position.lerp( state.targetPos, alpha );
			state.mesh.rotation.y = THREE.MathUtils.lerp( state.mesh.rotation.y, state.targetRotY, alpha );

		}

	}

	let multiplayerSyncInFlight = false;
	async function syncMultiplayerTransforms( options = {} ) {

		const roomCode = multiplayerSessionState.roomCode;
		if ( ! roomCode ) return;
		if ( multiplayerSyncInFlight ) return;
		const force = Boolean( options?.force );
		const now = Date.now();
		const mapSignature = getCurrentMapSignature();
		const localPayload = buildLocalVehiclePacket( now, mapSignature, vehicle );

		try {

			multiplayerSyncInFlight = true;
			await firebaseRoomsRequest( roomCode, 'PUT', localPayload, `players/${ encodeURIComponent( getLocalPeerId() ) }` );
			let room = await firebaseRoomsRequest( roomCode, 'GET' );
			syncPeerTopologyFromRoom( room );
			const activePeers = normalizePeerList( multiplayerSessionState.peerJoinOrder );
			const oldestPeerId = activePeers[ 0 ] || getLocalPeerId();
			if ( oldestPeerId === getLocalPeerId() && multiplayerSessionState.role !== 'host' ) {

				multiplayerSessionState.role = 'host';
				multiplayerSessionState.hostPeerId = getLocalPeerId();
				await firebaseRoomsRequest( roomCode, 'PATCH', {
					hostPeerId: getLocalPeerId(),
					hostId: getLocalPeerId(),
					newHostId: getLocalPeerId(),
					updatedAt: now,
					status: 'hosting',
				} );
				updateMultiplayerStatus( `Host left. You are now hosting room ${ roomCode }.` );
				room = { ...room, hostPeerId: getLocalPeerId(), hostId: getLocalPeerId(), newHostId: getLocalPeerId(), status: 'hosting' };

			}

			if ( multiplayerSessionState.role === 'host' ) {

				const shouldSyncRoomMeta = room?.mapSignature !== mapSignature || now - lastHostRoomMetaSyncAt >= HOST_ROOM_META_SYNC_MS;
				if ( shouldSyncRoomMeta ) {

					await firebaseRoomsRequest( roomCode, 'PATCH', {
						mapSignature,
						updatedAt: now,
						status: 'hosting',
					} );
					lastHostRoomMetaSyncAt = now;
					room.mapSignature = mapSignature;

				}

			}
			if ( room?.mapSignature && ! canJoinMap( room.mapSignature, mapSignature ) ) {

				updateMultiplayerStatus( `Switching to host map for room ${ roomCode }...` );
				redirectToRoomMap( roomCode, room.mapSignature );
				return;

			}
			const migrationTarget = getMigrationTargetCode( room );
			if ( migrationTarget && migrationTarget !== roomCode ) {

				const targetRoom = await firebaseRoomsRequest( migrationTarget, 'GET' );
				if ( targetRoom?.mapSignature && ! canJoinMap( targetRoom.mapSignature, mapSignature ) ) {

					updateMultiplayerStatus( `Host switched to ${ migrationTarget }. Loading host map...` );
					redirectToRoomMap( migrationTarget, targetRoom.mapSignature );
					return;

				}
				multiplayerSessionState.roomCode = migrationTarget;
				const codeInput = document.getElementById( 'mp-code-input' );
				if ( codeInput ) codeInput.value = migrationTarget;
				updateMultiplayerStatus( `Host switched room to ${ migrationTarget }. Following without reload...` );
				return;

			}
			if ( multiplayerSessionState.role === 'host' && now - lastHostRoomRotateAt >= MULTIPLAYER_ROOM_ROTATE_MS ) {

				const rotatedCode = await hostRotateRoomCode( roomCode, mapSignature );
				if ( rotatedCode !== roomCode ) return;

			}
			const players = room?.players && typeof room.players === 'object' ? room.players : {};
			if ( multiplayerSessionState.role === 'host' ) {

				const relayUpdates = {};
				for ( const [ senderId, packet ] of Object.entries( players ) ) {

					if ( senderId === getLocalPeerId() || packet?.type === 'PLAYER_LEFT' ) continue;
					trackConnectedPeer( senderId );
					const exactPacket = { ...packet, senderId: packet?.senderId || senderId };
					for ( const targetPeerId of Object.keys( multiplayerSessionState.connectedPeers ) ) {

						if ( targetPeerId === exactPacket.senderId ) continue;
						relayUpdates[ `relayedPackets/${ targetPeerId }/${ exactPacket.senderId }` ] = exactPacket;

					}

				}
				if ( Object.keys( relayUpdates ).length > 0 ) await firebaseRoomsRequest( roomCode, 'PATCH', relayUpdates );

			}

			renderMultiplayerRoomLeaderboard( room?.lapTimes );
			maybeSubmitOnlinePersonalBest( room?.lapTimes );
			const seen = new Set();
			for ( const [ playerId, playerState ] of Object.entries( players ) ) {

				const senderId = playerState?.senderId || playerId;
				if ( senderId === getLocalPeerId() ) continue;
				if ( playerState?.type === 'PLAYER_LEFT' ) {

					removeRemotePlayerVisual( playerState.peerId || senderId );
					untrackConnectedPeer( playerState.peerId || senderId );
					continue;

				}
				if ( ! canJoinMap( playerState?.mapSignature, mapSignature ) ) continue;
				const updatedAt = Number( playerState?.updatedAt ) || 0;
				if ( ! force && now - updatedAt > REMOTE_PLAYER_STALE_MS ) continue;
				const visualState = ensureRemotePlayerVisualWithCosmetics( senderId, playerState?.carKey, playerState?.cosmetics );
				ensureRemoteNameTag( visualState, playerState?.name || room?.lapTimes?.[ playerId ]?.name || 'Player' );
				visualState.targetPos.set( Number( playerState?.x ) || 0, ( Number( playerState?.y ) || 0 ) - 0.1, Number( playerState?.z ) || 0 );
				visualState.targetRotY = Math.PI - ( Number( playerState?.ry ) || 0 );
				visualState.lastSeenAt = now;
				seen.add( senderId );

			}

			for ( const existingId of [ ...remotePlayerVisuals.keys() ] ) {

				if ( seen.has( existingId ) ) continue;
				const existing = remotePlayerVisuals.get( existingId );
				if ( existing && now - ( Number( existing.lastSeenAt ) || 0 ) <= REMOTE_PLAYER_STALE_MS * 2 ) continue;
				removeRemotePlayerVisual( existingId );

			}

		} catch ( error ) {

			console.warn( 'Multiplayer transform sync failed', error );

		} finally {

			multiplayerSyncInFlight = false;

		}

	}

	setInterval( syncMultiplayerTransforms, REMOTE_SYNC_MS );
	window.addEventListener( 'beforeunload', () => {

		if ( ! multiplayerSessionState.roomCode ) return;
		const roomCode = multiplayerSessionState.roomCode;
		const peerId = getLocalPeerId();
		const playerPath = `players/${ encodeURIComponent( peerId ) }`;
		const peerPath = `peers/${ encodeURIComponent( peerId ) }`;
		firebaseRoomsRequest( roomCode, 'PUT', buildPlayerLeftPacket( peerId ), playerPath ).catch( () => {} );
		firebaseRoomsRequest( roomCode, 'PATCH', { active: false, leftAt: Date.now() }, peerPath ).catch( () => {} );

	} );
	let ghostModel = null;
	const bestLapGhostSamples = [];
	let currentLapGhostSamples = [];
	let bestLapInputFrames = [];
	let latestLapInputFrames = [];
	let currentLapInputFrames = [];
	let inputRecordFrame = 0;
	let bestGhostDuration = 0;
	let bestGhostCarKey = 'vehicle-truck-yellow';
	let bestGhostCosmetics = null;
	let ghostRecordFrame = 0;
	const _ghostForward = new THREE.Vector3();
	const _ghostUp = new THREE.Vector3( 0, 1, 0 );
	const selectedLeaderboardGhosts = new Set();
	const leaderboardGhostPlayers = new Map();
	const recentGhostHistory = [];
	const recentGhostPlayers = [];
	let bestGhostCheckpointTimes = [];

	let ghostSpreadLine = null;
	const _ghostSpreadSampleVec = new THREE.Vector3();

	function sampleGhostPositionAtTime( samples, duration, t, out = _ghostSpreadSampleVec ) {

		if ( ! Array.isArray( samples ) || samples.length < 2 || ! Number.isFinite( duration ) || duration <= 0 ) return null;
		const wrapped = ( ( t % duration ) + duration ) % duration;
		let nextIndex = samples.findIndex( ( sample ) => sample.t >= wrapped );
		if ( nextIndex <= 0 ) nextIndex = 1;
		const sampleA = samples[ nextIndex - 1 ];
		const sampleB = samples[ nextIndex ];
		const span = Math.max( 1e-4, sampleB.t - sampleA.t );
		const alpha = THREE.MathUtils.clamp( ( wrapped - sampleA.t ) / span, 0, 1 );
		out.set(
			THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
			THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
			THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
		);
		return out;

	}

	function rebuildGhostSpreadLine() {

		if ( ghostSpreadLine ) {

			scene.remove( ghostSpreadLine );
			ghostSpreadLine.geometry?.dispose?.();
			ghostSpreadLine.material?.dispose?.();
			ghostSpreadLine = null;

		}
		// Average multi-ghost path visualization intentionally disabled.

	}

	function normalizeGhostCosmeticsPayload( payload ) {

		const sourceMappings = Array.isArray( payload?.mappings ) ? payload.mappings : [];
		const mappings = [];
		for ( const entry of sourceMappings.slice( 0, 48 ) ) {

			const sourceHex = typeof entry?.sourceHex === 'string' ? entry.sourceHex.trim() : '';
			const targetHex = typeof entry?.targetHex === 'string' ? entry.targetHex.trim() : '';
			if ( ! /^#[0-9a-fA-F]{6}$/.test( sourceHex ) || ! /^#[0-9a-fA-F]{6}$/.test( targetHex ) ) continue;
			mappings.push( {
				sourceHex,
				targetHex,
				tolerance: THREE.MathUtils.clamp( Number( entry?.tolerance ) || 40, 8, 180 ),
				finish: entry?.finish === 'shiny' ? 'shiny' : 'matte',
			} );

		}
		if ( mappings.length === 0 ) return null;
		return { mappings };

	}

	function buildGhostCosmeticsSnapshot( carKey ) {

		const carData = getGarageCosmeticCar( carKey );
		const mappings = Array.isArray( carData?.mappings ) ? carData.mappings : [];
		const resolved = [];
		for ( const mapping of mappings.slice( 0, 48 ) ) {

			const sourceHex = typeof mapping?.sourceHex === 'string' ? mapping.sourceHex : '';
			const targetPaint = getPaintColorById( mapping?.targetColorId );
			if ( ! /^#[0-9a-fA-F]{6}$/.test( sourceHex ) || ! targetPaint?.hex || ! garageCosmetics?.unlockedPaints?.[ mapping?.targetColorId ] ) continue;
			resolved.push( {
				sourceHex,
				targetHex: targetPaint.hex,
				tolerance: THREE.MathUtils.clamp( Number( mapping?.tolerance ) || 40, 8, 180 ),
				finish: targetPaint.finish === 'shiny' ? 'shiny' : 'matte',
			} );

		}
		return resolved.length > 0 ? { mappings: resolved } : null;

	}

	function buildResolvedMappingsFromGhostCosmetics( cosmetics ) {

		const normalized = normalizeGhostCosmeticsPayload( cosmetics );
		if ( ! normalized ) return [];
		const resolved = [];
		for ( const mapping of normalized.mappings ) {

			const source = hexToRgbBytes( mapping.sourceHex );
			const target = hexToRgbBytes( mapping.targetHex );
			if ( ! source || ! target ) continue;
			const tolerance = THREE.MathUtils.clamp( Number( mapping.tolerance ) || 40, 8, 180 );
			resolved.push( {
				source,
				target,
				finish: mapping.finish === 'shiny' ? 'shiny' : 'matte',
				toleranceSq: tolerance * tolerance,
			} );

		}
		return resolved;

	}

	function createGhostVisualModel( model, opacity = 0.35, cosmetics = null ) {

		if ( ! ghostEnabled || ! model ) return null;
		const cloned = model.clone();
		const resolvedMappings = buildResolvedMappingsFromGhostCosmetics( cosmetics );
		cloned.traverse( ( child ) => {

			if ( ! child.isMesh || ! child.material ) return;
			const incomingMaterials = Array.isArray( child.material ) ? child.material : [ child.material ];
			const builtMaterials = incomingMaterials.map( ( baseMaterial ) => {

				let material = baseMaterial.clone();
				if ( resolvedMappings.length > 0 && material.color ) {

					const baseRgb = hexToRgbBytes( `#${ baseMaterial.color.getHexString() }` );
					const mappedSolid = baseRgb ? pickMappedColor( baseRgb, resolvedMappings ) : null;
					if ( mappedSolid ) material.color.setRGB( mappedSolid.r / 255, mappedSolid.g / 255, mappedSolid.b / 255 );
					if ( mappedSolid?.finish === 'shiny' ) applyShinyFinish( material, mappedSolid );

				}
				if ( resolvedMappings.length > 0 && material.map ) {

					const remapped = recolorTexture( material.map, resolvedMappings );
					material.map = remapped.texture;
					if ( remapped.hasShiny ) applyShinyFinish( material );

				}
				material.transparent = opacity < 1;
				material.opacity = opacity;
				material.depthWrite = opacity >= 1;
				material.needsUpdate = true;
				return material;

			} );
			child.material = Array.isArray( child.material ) ? builtMaterials : builtMaterials[ 0 ];
			child.castShadow = false;
			child.receiveShadow = false;

		} );
		return cloned;

	}

	function createGhostModel( model, cosmetics = null ) {

		if ( ! ghostEnabled ) return;
		if ( ghostModel ) scene.remove( ghostModel );
		ghostModel = null;
		if ( ! model ) return;

		ghostModel = createGhostVisualModel( model, replayViewerMode ? 1 : 0.35, cosmetics );
		if ( ! ghostModel ) return;
		scene.add( ghostModel );

	}

	function resetCurrentLapGhost() {

		if ( ! ghostEnabled ) return;
		currentLapGhostSamples = [];
		ghostRecordFrame = 0;

	}

	function resetCurrentLapInputs() {

		currentLapInputFrames = [];
		inputRecordFrame = 0;

	}

	function recordLapInput( lapElapsed, input, controlState ) {

		if ( ! ghostEnabled ) return;
		inputRecordFrame ++;
		if ( inputRecordFrame % 2 !== 0 ) return;
		const keys = controlState || {};
		currentLapInputFrames.push( {
			t: lapElapsed,
			x: Number.isFinite( input?.x ) ? input.x : 0,
			z: Number.isFinite( input?.z ) ? input.z : 0,
			keys: {
				left: Boolean( keys.KeyA || keys.ArrowLeft ),
				right: Boolean( keys.KeyD || keys.ArrowRight ),
				forward: Boolean( keys.KeyW || keys.ArrowUp ),
				back: Boolean( keys.KeyS || keys.ArrowDown ),
			},
		} );

	}

	function recordGhostSample( lapElapsed, force = false ) {

		if ( ! ghostEnabled ) return;
		ghostRecordFrame ++;
		if ( ! force && ghostRecordFrame % 3 !== 0 ) return;

		_ghostForward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
		_ghostForward.projectOnPlane( _ghostUp ).normalize();
		const yaw = Math.atan2( _ghostForward.x, _ghostForward.z );
		const euler = new THREE.Euler().setFromQuaternion( vehicle.container.quaternion, 'YXZ' );

		currentLapGhostSamples.push( {
			t: lapElapsed,
			x: vehicle.container.position.x,
			y: vehicle.container.position.y,
			z: vehicle.container.position.z,
			yaw,
			pitch: euler.x,
			roll: euler.z,
		} );

	}

	function lerpAngle( a, b, t ) {

		let delta = b - a;
		while ( delta > Math.PI ) delta -= Math.PI * 2;
		while ( delta < - Math.PI ) delta += Math.PI * 2;
		return a + delta * t;

	}

	function updateGhostPlayback( lapElapsed ) {

		if ( ! ghostEnabled ) return;
		if ( ! ghostModel ) return;
		if ( bestLapGhostSamples.length < 2 || bestGhostDuration <= 0 ) {

			ghostModel.visible = false;
			return;

		}

		ghostModel.visible = true;
		const t = ( ( lapElapsed % bestGhostDuration ) + bestGhostDuration ) % bestGhostDuration;

		let nextIndex = bestLapGhostSamples.findIndex( ( sample ) => sample.t >= t );
		if ( nextIndex <= 0 ) nextIndex = 1;

		const sampleA = bestLapGhostSamples[ nextIndex - 1 ];
		const sampleB = bestLapGhostSamples[ nextIndex ];
		const span = Math.max( 1e-4, sampleB.t - sampleA.t );
		const alpha = THREE.MathUtils.clamp( ( t - sampleA.t ) / span, 0, 1 );

		ghostModel.position.set(
			THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
			THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
			THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
		);
		const targetPitch = lerpAngle( sampleA.pitch || 0, sampleB.pitch || 0, alpha );
		const targetYaw = lerpAngle( sampleA.yaw, sampleB.yaw, alpha );
		const targetRoll = lerpAngle( sampleA.roll || 0, sampleB.roll || 0, alpha );
		ghostModel.rotation.x = lerpAngle( ghostModel.rotation.x, targetPitch, 0.18 );
		ghostModel.rotation.y = lerpAngle( ghostModel.rotation.y, targetYaw, 0.18 );
		ghostModel.rotation.z = lerpAngle( ghostModel.rotation.z, targetRoll, 0.18 );
		if ( replayViewerMode && ! freecamState.active ) {
			cam.targetPosition.copy( ghostModel.position );
			cam.update( 1 / 60, ghostModel.position, ghostModel.quaternion );
		}

	}

	function extractNormalizedGhostPayload( payload ) {

		const samples = Array.isArray( payload?.samples ) ? payload.samples : [];
		const duration = Number( payload?.duration );
		if ( samples.length < 2 || ! Number.isFinite( duration ) || duration <= 0 ) return null;
		const normalizedSamples = [];
		for ( const sample of samples ) {

			if ( ! Number.isFinite( sample?.t ) || ! Number.isFinite( sample?.x ) || ! Number.isFinite( sample?.y ) || ! Number.isFinite( sample?.z ) || ! Number.isFinite( sample?.yaw ) ) continue;
			normalizedSamples.push( {
				t: sample.t,
				x: sample.x,
				y: sample.y,
				z: sample.z,
				yaw: sample.yaw,
				pitch: Number.isFinite( sample?.pitch ) ? sample.pitch : 0,
				roll: Number.isFinite( sample?.roll ) ? sample.roll : 0,
			} );

		}
		if ( normalizedSamples.length < 2 ) return null;
		return {
			samples: normalizedSamples,
			duration,
			car: payload?.car,
			bestLapSeconds: payload?.bestLapSeconds,
			cosmetics: normalizeGhostCosmeticsPayload( payload?.cosmetics ),
		};

	}

	function removeLeaderboardGhost( playerName ) {

		const existing = leaderboardGhostPlayers.get( playerName );
		if ( existing?.model ) scene.remove( existing.model );
		leaderboardGhostPlayers.delete( playerName );
		rebuildGhostSpreadLine();

	}

	function computeCheckpointCrossTimes( samples ) {

		if ( ! Array.isArray( samples ) || samples.length < 2 || checkpointStates.length === 0 ) return [];
		const times = new Array( checkpointStates.length ).fill( null );
		const state = checkpointStates.map( () => ( { x: 0, z: 0, hasPrev: false } ) );
		for ( const sample of samples ) {

			for ( let i = 0; i < checkpointStates.length; i ++ ) {

				if ( times[ i ] !== null ) continue;
				const cp = checkpointStates[ i ];
				const localX = ( ( sample.x - cp.centerX ) * cp.cosA ) + ( ( sample.z - cp.centerZ ) * cp.sinA );
				const localZ = ( - ( sample.x - cp.centerX ) * cp.sinA ) + ( ( sample.z - cp.centerZ ) * cp.cosA );
				const prev = state[ i ];
				if ( prev.hasPrev ) {

					const crossedPlane = ( prev.z < 0 && localZ > 0 ) || ( prev.z > 0 && localZ < 0 );
					if ( crossedPlane ) {

						const t = prev.z / ( prev.z - localZ );
						const xCross = THREE.MathUtils.lerp( prev.x, localX, t );
						if ( t >= 0 && t <= 1 && Math.abs( xCross ) <= cp.halfExtent ) times[ i ] = Number( sample.t );

					}

				}
				prev.x = localX;
				prev.z = localZ;
				prev.hasPrev = true;

			}

		}
		return times;

	}

	function rebuildRecentGhostVisuals() {

		while ( recentGhostPlayers.length > 0 ) {

			const state = recentGhostPlayers.pop();
			if ( state?.model ) scene.remove( state.model );

		}
		if ( ! ghostEnabled || ! fxSettings.recentGhostsEnabled ) return;
		const targetCount = Math.max( 1, Math.min( recentGhostHistory.length, fxSettings.recentGhostCount ) );
		for ( const entry of recentGhostHistory.slice( 0, targetCount ) ) {

			const model = createGhostVisualModel( models[ entry.car || 'vehicle-truck-yellow' ] || models[ 'vehicle-truck-yellow' ], 0.22, entry.cosmetics || null );
			if ( ! model ) continue;
			scene.add( model );
			recentGhostPlayers.push( { ...entry, model } );

		}

	}

	function enableLeaderboardGhost( playerName, payload ) {

		if ( ! ghostEnabled ) return false;
		const normalized = extractNormalizedGhostPayload( payload );
		if ( ! normalized ) return false;
		const modelKey = normalized.car && models[ normalized.car ] ? normalized.car : 'vehicle-truck-yellow';
		const ghostCosmetics = normalized.car === modelKey ? normalized.cosmetics : null;
		const model = createGhostVisualModel( models[ modelKey ], 0.27, ghostCosmetics );
		if ( ! model ) return false;
		removeLeaderboardGhost( playerName );
		scene.add( model );
		leaderboardGhostPlayers.set( playerName, {
			model,
			samples: normalized.samples,
			duration: normalized.duration,
			checkpointTimes: computeCheckpointCrossTimes( normalized.samples ),
		} );
		rebuildGhostSpreadLine();
		return true;

	}

	function updateSelectedLeaderboardGhosts( rows ) {

		const byName = new Map();
		for ( const entry of rows ) {

			const name = sanitizePlayerName( entry?.name ) || 'Anonymous';
			byName.set( name, entry );

		}
		for ( const selectedName of [ ...selectedLeaderboardGhosts ] ) {

			const entry = byName.get( selectedName );
			if ( ! entry?.ghost ) {

				selectedLeaderboardGhosts.delete( selectedName );
				removeLeaderboardGhost( selectedName );
				continue;

			}
			if ( leaderboardGhostPlayers.has( selectedName ) ) continue;
			if ( ! enableLeaderboardGhost( selectedName, entry.ghost ) ) {

				selectedLeaderboardGhosts.delete( selectedName );
				removeLeaderboardGhost( selectedName );

			}

		}

	}

	function updateLeaderboardGhostPlayback( lapElapsed ) {

		if ( ! ghostEnabled || leaderboardGhostPlayers.size === 0 ) return;
		for ( const state of leaderboardGhostPlayers.values() ) {

			if ( ! state?.model || ! Array.isArray( state.samples ) || state.samples.length < 2 || ! Number.isFinite( state.duration ) || state.duration <= 0 ) {

				if ( state?.model ) state.model.visible = false;
				continue;

			}
			state.model.visible = true;
			const t = ( ( lapElapsed % state.duration ) + state.duration ) % state.duration;
			let nextIndex = state.samples.findIndex( ( sample ) => sample.t >= t );
			if ( nextIndex <= 0 ) nextIndex = 1;
			const sampleA = state.samples[ nextIndex - 1 ];
			const sampleB = state.samples[ nextIndex ];
			const span = Math.max( 1e-4, sampleB.t - sampleA.t );
			const alpha = THREE.MathUtils.clamp( ( t - sampleA.t ) / span, 0, 1 );
			state.model.position.set(
				THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
				THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
				THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
			);
			const targetPitch = lerpAngle( sampleA.pitch || 0, sampleB.pitch || 0, alpha );
			const targetYaw = lerpAngle( sampleA.yaw, sampleB.yaw, alpha );
			const targetRoll = lerpAngle( sampleA.roll || 0, sampleB.roll || 0, alpha );
			state.model.rotation.x = lerpAngle( state.model.rotation.x, targetPitch, 0.18 );
			state.model.rotation.y = lerpAngle( state.model.rotation.y, targetYaw, 0.18 );
			state.model.rotation.z = lerpAngle( state.model.rotation.z, targetRoll, 0.18 );

		}

	}

	function updateRecentGhostPlayback( lapElapsed ) {

		if ( ! ghostEnabled || recentGhostPlayers.length === 0 || ! fxSettings.recentGhostsEnabled ) return;
		for ( const state of recentGhostPlayers ) {

			if ( ! state?.model || ! Array.isArray( state.samples ) || state.samples.length < 2 || ! Number.isFinite( state.duration ) || state.duration <= 0 ) {

				if ( state?.model ) state.model.visible = false;
				continue;

			}
			state.model.visible = true;
			const t = ( ( lapElapsed % state.duration ) + state.duration ) % state.duration;
			let nextIndex = state.samples.findIndex( ( sample ) => sample.t >= t );
			if ( nextIndex <= 0 ) nextIndex = 1;
			const sampleA = state.samples[ nextIndex - 1 ];
			const sampleB = state.samples[ nextIndex ];
			const span = Math.max( 1e-4, sampleB.t - sampleA.t );
			const alpha = THREE.MathUtils.clamp( ( t - sampleA.t ) / span, 0, 1 );
			state.model.position.set(
				THREE.MathUtils.lerp( sampleA.x, sampleB.x, alpha ),
				THREE.MathUtils.lerp( sampleA.y, sampleB.y, alpha ),
				THREE.MathUtils.lerp( sampleA.z, sampleB.z, alpha )
			);
			const targetPitch = lerpAngle( sampleA.pitch || 0, sampleB.pitch || 0, alpha );
			const targetYaw = lerpAngle( sampleA.yaw, sampleB.yaw, alpha );
			const targetRoll = lerpAngle( sampleA.roll || 0, sampleB.roll || 0, alpha );
			state.model.rotation.x = lerpAngle( state.model.rotation.x, targetPitch, 0.18 );
			state.model.rotation.y = lerpAngle( state.model.rotation.y, targetYaw, 0.18 );
			state.model.rotation.z = lerpAngle( state.model.rotation.z, targetRoll, 0.18 );

		}

	}

	if ( ghostEnabled ) createGhostModel( models[ 'vehicle-truck-yellow' ] );
	if ( replayViewerMode ) vehicle.container.visible = false;

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	cam.targetPosition.copy( vehicle.spherePos );

	// ── HUD Extras: speedometer, minimap, shortcuts overlay ──
	hudExtras = new HudExtras( {
		vehicle, cells: customCells || TRACK_CELLS, camera: cam.camera
	} );
	const cam2 = isSplitScreen ? new Camera() : null;
	if ( cam2 && vehicle2 ) {

		cam2.targetPosition.copy( vehicle2.spherePos );
		cam2.toggleMode();

	}

	const controls = isSplitScreen
		? new Controls( { leftKeys: [ 'KeyA' ], rightKeys: [ 'KeyD' ], forwardKeys: [ 'KeyW' ], backKeys: [ 'KeyS' ], enableGamepad: false, enableTouch: false } )
		: new Controls();
	const controls2 = isSplitScreen
		? new Controls( { leftKeys: [ 'ArrowLeft' ], rightKeys: [ 'ArrowRight' ], forwardKeys: [ 'ArrowUp' ], backKeys: [ 'ArrowDown' ], enableGamepad: false, enableTouch: false } )
		: null;

	let customModGravityScale = 1;
	let customModTimeScale = 1;
	let customModShakeUntil = 0;
	let customModShakeIntensity = 0;
	let crashShakeTime = 0;
	let crashShakeStrength = 0;
	let customModParticleBurstSeconds = 0;
	let customModForceBrakeUntil = 0;
	let customModForceThrottleUntil = 0;
	let customModNoSteerUntil = 0;
	let customModFogStrength = 1;
	const runtimeModContext = {
		vehicle,
		world,
		scene,
		controls,
		renderer,
		camera: cam,
		playbackController: new DeterministicPlaybackController(),
		resetPlayerVehicle: () => vehicle.resetToSpawn(),
		api: {
			showMessage: ( message, event = {} ) => window.setTimeout( () => showTopMessage( String( message || '' ), false, event?.durationMs || 1600 ), 0 ),
			setSpeed: ( speed ) => {
				const value = Number( speed );
				if ( ! Number.isFinite( value ) || ! vehicle?.rigidBody ) return;
				const forward = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 );
				if ( forward.lengthSq() < 1e-6 ) return;
				forward.normalize();
				const current = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ forward.x * value, current[ 1 ], forward.z * value ] );
			},
			boost: ( amount = 1 ) => {
				if ( ! vehicle?.rigidBody ) return;
				const value = Number.isFinite( Number( amount ) ) ? Number( amount ) : 1;
				const forward = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 );
				if ( forward.lengthSq() < 1e-6 ) return;
				forward.normalize();
				const current = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ current[ 0 ] + forward.x * value, current[ 1 ], current[ 2 ] + forward.z * value ] );
				customModParticleBurstSeconds = Math.max( customModParticleBurstSeconds, Math.max( 0.25, Math.min( 2.5, Math.abs( value ) * 0.08 ) ) );
			},
			setGravity: ( gravity ) => {
				const g = Number( gravity );
				customModGravityScale = Number.isFinite( g ) && g > 0 ? THREE.MathUtils.clamp( g / 9.81, 0.05, 5 ) : 1;
			},
			spawnParticle: () => { customModParticleBurstSeconds = Math.max( customModParticleBurstSeconds, 0.45 ); },
			jump: ( power = 6 ) => {
				if ( ! vehicle?.rigidBody ) return;
				const current = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
				rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ current[ 0 ], Math.max( current[ 1 ], 0 ) + ( Number( power ) || 6 ), current[ 2 ] ] );
			},
			resetCar: () => vehicle.resetToSpawn(),
			setTimeScale: ( scale = 1 ) => { customModTimeScale = THREE.MathUtils.clamp( Number( scale ) || 1, 0.1, 4 ); },
			setAccelMultiplier: ( value = 1 ) => { vehicle.accelMultiplier = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 4 ); },
			setDriveMultiplier: ( value = 1 ) => { vehicle.driveMultiplier = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 4 ); },
			setGripMultiplier: ( value = 1 ) => { vehicle.gripMultiplier = THREE.MathUtils.clamp( Number( value ) || 1, 0.1, 4 ); },
			forceBrake: ( secs = 0.4 ) => { customModForceBrakeUntil = Math.max( customModForceBrakeUntil, raceClockSeconds + THREE.MathUtils.clamp( Number( secs ) || 0.4, 0.05, 8 ) ); },
			forceThrottle: ( secs = 0.4 ) => { customModForceThrottleUntil = Math.max( customModForceThrottleUntil, raceClockSeconds + THREE.MathUtils.clamp( Number( secs ) || 0.4, 0.05, 8 ) ); },
			disableSteering: ( secs = 0.5 ) => { customModNoSteerUntil = Math.max( customModNoSteerUntil, raceClockSeconds + THREE.MathUtils.clamp( Number( secs ) || 0.5, 0.05, 8 ) ); },
			setFogStrength: ( value = 1 ) => { customModFogStrength = THREE.MathUtils.clamp( Number( value ) || 1, 0, 2 ); },
			addCoins: ( amount = 0 ) => {
				if ( isSplitScreen ) return;
				coins = Math.max( 0, Math.floor( coins + ( Number( amount ) || 0 ) ) );
				saveEconomy();
				updateEconomyHud();
			},
			cameraShake: ( intensity = 1 ) => {
				customModShakeIntensity = Math.max( customModShakeIntensity, Math.max( 0, Number( intensity ) || 0 ) );
				customModShakeUntil = Math.max( customModShakeUntil, raceClockSeconds + 0.45 );
			},
		},
	};
	for ( const runtime of runtimeMods ) {

		try {

			runtime.init( runtimeModContext );

		} catch ( error ) {

			console.warn( `Mod init failed: ${ runtime?.id || 'unknown' }`, error );

		}

	}
	window.addEventListener( 'beforeunload', () => {

		for ( const runtime of runtimeMods ) {

			if ( typeof runtime?.dispose !== 'function' ) continue;
			try {

				runtime.dispose();

			} catch ( error ) {

				console.warn( `Mod dispose failed: ${ runtime?.id || 'unknown' }`, error );

			}

		}

	} );

	function dispatchRuntimeModEvent( hookName, payload = {} ) {
		for ( const runtime of runtimeMods ) {
			if ( typeof runtime?.[ hookName ] !== 'function' ) continue;
			try {
				runtime[ hookName ]( { ...payload, vehicle, world, controls, now: raceClockSeconds } );
			} catch ( error ) {
				console.warn( `Mod ${ hookName } failed: ${ runtime?.id || 'unknown' }`, error );
			}
		}
	}

	const particles = new SmokeTrails( scene, getGraphicsParticleOptions() );
	const particles2 = isSplitScreen ? new SmokeTrails( scene, getGraphicsParticleOptions() ) : null;
	const lapHud = document.getElementById( 'lap-hud' );
	const lapHud2 = document.getElementById( 'lap-hud-2' );
	const countdownHud = document.getElementById( 'countdown-hud' );
	const fpsHud = document.getElementById( 'fps-hud' );
	const pausePanel = document.getElementById( 'pause-panel' );
	const respawnBtn = document.getElementById( 'respawnBtn' );
	const modeMenuBtn = document.getElementById( 'mode-menu-btn' );
	const topMessage = document.getElementById( 'top-message' );
	const effectMessage = document.getElementById( 'effect-message' );
	let effectMessageTimeout = null;
	const carSelect = document.getElementById( 'car-select' );
	const coinsLabel = document.getElementById( 'coins-label' );
	const accountCoinsValue = document.getElementById( 'account-coins-value' );
	const shareTimeBtn = document.getElementById( 'share-time-btn' );
	const exportGhostBtn = document.getElementById( 'export-ghost-btn' );
	const importGhostBtn = document.getElementById( 'import-ghost-btn' );
	const hacksToggleLink = document.getElementById( 'hacks-toggle' );
	const hacksPanel = document.getElementById( 'hacks-panel' );
	const hackEnableInput = document.getElementById( 'hack-enable' );
	const hackInfiniteCoinsInput = document.getElementById( 'hack-infinite-coins' );
	const hackBoostAnywhereInput = document.getElementById( 'hack-boost-anywhere' );
	const hackNoLimitsInput = document.getElementById( 'hack-no-limits' );
	const hackAlwaysNitroInput = document.getElementById( 'hack-always-nitro' );
	const hackSuperJumpInput = document.getElementById( 'hack-super-jump' );
	const hackTeleportInput = document.getElementById( 'hack-teleport' );
	const hackLowFrictionInput = document.getElementById( 'hack-low-friction' );
	const hackInstantStopInput = document.getElementById( 'hack-instant-stop' );
	const hackCheckpointBypassInput = document.getElementById( 'hack-checkpoint-bypass' );
	const hackShowHitboxesInput = document.getElementById( 'hack-show-hitboxes' );
	const hackTimescaleInput = document.getElementById( 'hack-timescale' );
	const hackGravityInput = document.getElementById( 'hack-gravity' );
	const hackRoadGripInput = document.getElementById( 'hack-road-grip' );
	const hackResetBtn = document.getElementById( 'hack-reset-btn' );
	const economyHud = document.getElementById( 'economy-hud' );
	const boostUi = document.getElementById( 'boost-ui' );
	const boostFill = document.getElementById( 'boost-fill' );
	const boostActivateBtn = document.getElementById( 'boost-activate-btn' );
	const arcLinkUi = document.getElementById( 'arc-link-ui' );
	const modeMenu = document.getElementById( 'mode-menu' );
	const modeError = document.getElementById( 'mode-error' );
	const playerNameInput = document.getElementById( 'player-name-input' );
	const leaderboardList = document.getElementById( 'leaderboard-list' );
	const leaderboardEmpty = document.getElementById( 'leaderboard-empty' );
	const leaderboardTrackLabel = document.getElementById( 'leaderboard-track-label' );
	let leaderboardPercentileLabel = document.getElementById( 'leaderboard-percentile-label' );
	const leaderboardRefreshBtn = document.getElementById( 'leaderboard-refresh-btn' );
	const leaderboardPanel = document.getElementById( 'leaderboard-panel' );
	const leaderboardToggleBtn = document.getElementById( 'leaderboard-toggle-btn' );
	const pauseToggleBtn = document.getElementById( 'pause-toggle-btn' );
	if ( leaderboardPanel && ! leaderboardPercentileLabel ) {

		leaderboardPercentileLabel = document.createElement( 'div' );
		leaderboardPercentileLabel.id = 'leaderboard-percentile-label';
		leaderboardPercentileLabel.style.fontSize = '12px';
		leaderboardPercentileLabel.style.color = '#bde6ff';
		leaderboardPercentileLabel.style.marginBottom = '8px';
		leaderboardPanel.insertBefore( leaderboardPercentileLabel, leaderboardEmpty || leaderboardList || null );

	}
	const fxSettings = {
		recentGhostsEnabled: false,
		recentGhostPathEnabled: false,
		recentGhostCount: 3,
	};
	try {

		const parsed = JSON.parse( localStorage.getItem( FX_SETTINGS_KEY ) || '{}' );
		if ( typeof parsed?.recentGhostsEnabled === 'boolean' ) fxSettings.recentGhostsEnabled = parsed.recentGhostsEnabled;
		if ( Number.isFinite( Number( parsed?.recentGhostCount ) ) ) fxSettings.recentGhostCount = THREE.MathUtils.clamp( Math.round( Number( parsed.recentGhostCount ) ), 1, 20 );

	} catch {}

	const fxPanel = document.createElement( 'section' );
	fxPanel.id = 'gameplay-ghost-settings';
	fxPanel.style.marginTop = '10px';
	fxPanel.style.padding = '10px';
	fxPanel.style.border = '1px solid rgba(255,255,255,0.14)';
	fxPanel.style.borderRadius = '10px';
	fxPanel.style.background = 'rgba(255,255,255,0.06)';
	fxPanel.innerHTML = `<h4 style="margin:0 0 8px;font:800 12px/1.2 sans-serif;color:#bde6ff;">Ghosts</h4>
	<label style="display:block;margin-bottom:6px;"><input id="fx-recent-ghosts" type="checkbox" ${ fxSettings.recentGhostsEnabled ? 'checked' : '' }> Show recent ghosts</label>
	<label style="display:block;margin-top:4px;">Recent ghost count <input id="fx-recent-ghost-count" type="number" min="1" max="20" step="1" value="${ fxSettings.recentGhostCount }" style="width:100%;margin-top:3px;background:#0f1520;color:#e9f5ff;border:1px solid rgba(255,255,255,0.25);border-radius:6px;padding:4px 6px;"></label>`;
	const gameplayPanel = document.getElementById( 'mode-panel-gameplay' );
	const graphicsSection = document.getElementById( 'graphics-section' );
	if ( gameplayPanel ) gameplayPanel.insertBefore( fxPanel, graphicsSection || null );
	const fxRecentGhostsInput = fxPanel.querySelector( '#fx-recent-ghosts' );
	const fxRecentGhostCountSelect = fxPanel.querySelector( '#fx-recent-ghost-count' );
	if ( fxRecentGhostCountSelect ) fxRecentGhostCountSelect.value = String( fxSettings.recentGhostCount );
	const saveFxSettings = () => localStorage.setItem( FX_SETTINGS_KEY, JSON.stringify( fxSettings ) );
	fxRecentGhostsInput?.addEventListener( 'change', () => {

		fxSettings.recentGhostsEnabled = Boolean( fxRecentGhostsInput.checked );
		saveFxSettings();
		rebuildRecentGhostVisuals();
		rebuildGhostSpreadLine();

	} );
	fxRecentGhostCountSelect?.addEventListener( 'change', () => {

		const value = Number( fxRecentGhostCountSelect.value );
		if ( Number.isFinite( value ) ) fxSettings.recentGhostCount = THREE.MathUtils.clamp( Math.round( value ), 1, 20 );
		fxRecentGhostCountSelect.value = String( fxSettings.recentGhostCount );
		saveFxSettings();
		rebuildRecentGhostVisuals();
		rebuildGhostSpreadLine();

	} );
	const namePopup = document.getElementById( 'name-popup' );
	const namePopupInput = document.getElementById( 'name-popup-input' );
	const namePopupSave = document.getElementById( 'name-popup-save' );
	const namePopupSkip = document.getElementById( 'name-popup-skip' );
	const raceModeBtn = document.getElementById( 'mode-race-btn' );
	const advModeBtn = document.getElementById( 'mode-advancements-btn' );
	const advOverlay = document.getElementById( 'adv-overlay' );
	const advClose = document.getElementById( 'adv-close' );
	const advCanvas = document.getElementById( 'adv-canvas' );
	const advGraph = document.getElementById( 'adv-graph' );
	const advToast = document.getElementById( 'adv-toast' );
	const stuntModeBtn = document.getElementById( 'mode-stunt-btn' );
	const campaignModeBtn = document.getElementById( 'mode-campaign-btn' );
	const campaignInfoBtn = document.getElementById( 'campaign-info-btn' );
	const countdownToggle = document.getElementById( 'countdown-toggle' );
	const fpsToggle = document.getElementById( 'fps-toggle' );
	const graphicsQualityButtons = Array.from( document.querySelectorAll( '[data-graphics-quality]' ) );
	const graphicsQualityLabel = document.getElementById( 'graphics-quality-label' );
	const modeTabGameplayBtn = document.getElementById( 'mode-tab-gameplay' );
	const modeTabGarageBtn = document.getElementById( 'mode-tab-garage' );
	const modeTabAccountBtn = document.getElementById( 'mode-tab-account' );
	const modeTabNavBtn = document.getElementById( 'mode-tab-nav' );
	const modePanelGameplay = document.getElementById( 'mode-panel-gameplay' );
	const modePanelGarage = document.getElementById( 'mode-panel-garage' );
	const modePanelAccount = document.getElementById( 'mode-panel-account' );
	const modePanelNav = document.getElementById( 'mode-panel-nav' );
	const campaignProgressLabel = document.getElementById( 'campaign-progress' );
	const stuntPointsHud = document.getElementById( 'stunt-points' );
	const garageVehicleCards = document.getElementById( 'garage-vehicle-cards' );
	const garageCarSelect = document.getElementById( 'garage-car-select' );
	const garageGripSlider = document.getElementById( 'garage-grip' );
	const garageAccelSlider = document.getElementById( 'garage-accel' );
	const garageDriveSlider = document.getElementById( 'garage-drive' );
	const garageGripValue = document.getElementById( 'garage-grip-value' );
	const garageAccelValue = document.getElementById( 'garage-accel-value' );
	const garageDriveValue = document.getElementById( 'garage-drive-value' );
	const garageGripStatus = document.getElementById( 'garage-grip-status' );
	const garageAccelStatus = document.getElementById( 'garage-accel-status' );
	const garageDriveStatus = document.getElementById( 'garage-drive-status' );
	const garageGripUnlockBtn = document.getElementById( 'garage-grip-unlock' );
	const garageAccelUnlockBtn = document.getElementById( 'garage-accel-unlock' );
	const garageDriveUnlockBtn = document.getElementById( 'garage-drive-unlock' );
	const garageViewerCanvas = document.getElementById( 'garage-viewer' );
	const garageTargetColorInput = document.getElementById( 'garage-target-color' );
	const garageApplyPaintBtn = document.getElementById( 'garage-apply-paint-btn' );
	const garageRepaintToleranceInput = document.getElementById( 'garage-repaint-tolerance' );
	const garageRepaintToleranceValue = document.getElementById( 'garage-repaint-tolerance-value' );
	const garageSelectionChip = document.getElementById( 'garage-selection-chip' );
	const garageMappingStatus = document.getElementById( 'garage-mapping-status' );
	const garageMappingsList = document.getElementById( 'garage-mappings-list' );
	const profileExportBtn = document.getElementById( 'profile-export-btn' );
	const profileImportBtn = document.getElementById( 'profile-import-btn' );
	const accountUsernameInput = document.getElementById( 'account-username-input' );
	const accountPasswordInput = document.getElementById( 'account-password-input' );
	const accountSignupBtn = document.getElementById( 'account-signup-btn' );
	const accountLoginBtn = document.getElementById( 'account-login-btn' );
	const accountCloudSaveBtn = document.getElementById( 'account-cloud-save-btn' );
	const accountCloudLoadBtn = document.getElementById( 'account-cloud-load-btn' );
	const accountExportBtn = document.getElementById( 'account-export-btn' );
	const accountImportBtn = document.getElementById( 'account-import-btn' );
	const accountStatus = document.getElementById( 'account-status' );
	let gameMode = 'race';
	let stuntPoints = 0;
	let bestStuntPoints = 0;
	let stuntReasonText = '--';
	let stuntReasonTimer = 0;
	let stuntCombo = 1;
	let stuntComboTimer = 0;
	let stuntAirTime = 0;
	let modeMenuOpen = false;
	let topMessageTimer = 0;
	let pendingLeaderboardRecord = null;
	let leaderboardVisible = true;
	let uiHidden = false;
	let accountSession = null;

	const advancementEvents = new AdvancementEvents();
	const accountDirtyRef = { value: false };
	const advancementState = (() => {
		try { return JSON.parse( localStorage.getItem('racing-advancements-v1') || '{}' ) || {}; }
		catch { return {}; }
	})();
	const advManager = new AdvancementManager( advancementEvents, {
		state: advancementState,
		accountDirtyRef,
		onUnlock: (adv) => {
			if ( ! adv ) return;
			// Achievement notifications are hidden for now, but progress still saves.
			renderAdvGraph();
		}
	});
	function saveAdvancementsNow(){ localStorage.setItem('racing-advancements-v1', JSON.stringify(advancementState)); accountDirtyRef.value = false; }
	setTimeout(() => setInterval(() => { if (accountDirtyRef.value) saveAdvancementsNow(); }, 300000), 30000);
	window.addEventListener('beforeunload', () => { if (accountDirtyRef.value) saveAdvancementsNow(); });
	function renderAdvGraph(){
		if(!advCanvas) return;
		const catY = { beginner:120, competition:340, community:560, modding:780, secret:1000 };
		const positions = {};
		advCanvas.innerHTML='';
		ADVANCEMENTS.forEach((a,i)=>{ const x=120 + (i%5)*390; const y=catY[a.category] || 120; positions[a.id]={x,y}; const node=document.createElement('div'); const unlocked=Boolean(advancementState[a.id]?.unlocked); node.style.cssText=`position:absolute;left:${x}px;top:${y}px;width:260px;padding:10px;border-radius:10px;background:${unlocked?'rgba(40,120,80,.85)':'rgba(20,30,45,.85)'};border:1px solid rgba(150,210,255,.45);color:#dff4ff;font:600 12px sans-serif;box-shadow:${unlocked?'0 0 18px rgba(80,255,180,.35)':'0 0 8px rgba(90,150,220,.2)'};`; node.textContent=(a.hidden && !unlocked)?'Hidden Advancement':`${a.title} — ${a.description}`; advCanvas.appendChild(node); });
		for (const a of ADVANCEMENTS){
			if(!a.prerequisite||!positions[a.id]||!positions[a.prerequisite]) continue;
			const p=positions[a.prerequisite], n=positions[a.id];
			const line=document.createElement('div');
			const x1=p.x+260, y1=p.y+24, x2=n.x, y2=n.y+24, dx=x2-x1, dy=y2-y1;
			const len=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI;
			line.style.cssText=`position:absolute;left:${x1}px;top:${y1}px;width:${len}px;height:2px;background:linear-gradient(90deg, rgba(110,200,255,.8), rgba(70,145,240,.35));transform-origin:0 0;transform:rotate(${ang}deg);opacity:.85;`;
			advCanvas.appendChild(line);
		}
	}
	renderAdvGraph();
	let advPan = { x: 0, y: 0, scale: 1, down: false, sx: 0, sy: 0 };
	const applyAdvTransform = () => { if (!advCanvas) return; advCanvas.style.transform = `translate(${advPan.x}px, ${advPan.y}px) scale(${advPan.scale})`; if (advGraph) advGraph.style.backgroundPosition = `${advPan.x*0.35}px ${advPan.y*0.35}px`; };
	advGraph?.addEventListener('mousedown',(e)=>{advPan.down=true;advPan.sx=e.clientX;advPan.sy=e.clientY;});
	window.addEventListener('mouseup',()=>advPan.down=false);
	window.addEventListener('mousemove',(e)=>{ if(!advPan.down||!advCanvas) return; advPan.x += (e.clientX-advPan.sx); advPan.y += (e.clientY-advPan.sy); advPan.sx=e.clientX; advPan.sy=e.clientY; applyAdvTransform(); });
	advGraph?.addEventListener('wheel',(e)=>{ e.preventDefault(); advPan.scale = THREE.MathUtils.clamp(advPan.scale + (e.deltaY>0?-0.06:0.06), 0.45, 1.5); applyAdvTransform(); }, { passive:false });
	advGraph?.addEventListener('keydown',(e)=>{ const step= e.shiftKey ? 60 : 28; if(e.key==='ArrowLeft') advPan.x+=step; if(e.key==='ArrowRight') advPan.x-=step; if(e.key==='ArrowUp') advPan.y+=step; if(e.key==='ArrowDown') advPan.y-=step; if(e.key==='-') advPan.scale=THREE.MathUtils.clamp(advPan.scale-0.05,0.45,1.5); if(e.key==='='||e.key==='+') advPan.scale=THREE.MathUtils.clamp(advPan.scale+0.05,0.45,1.5); applyAdvTransform(); });
	advGraph?.addEventListener('scroll',(e)=>{ if(!advCanvas) return; advPan.x -= e.deltaX||0; advPan.y -= e.deltaY||0; applyAdvTransform(); }, { passive:true });
	advModeBtn?.addEventListener('click',()=>{ if(advOverlay) advOverlay.style.display='block'; setTimeout(()=>advGraph?.focus(),20); });
	advClose?.addEventListener('click',()=>{ if(advOverlay) advOverlay.style.display='none'; });

	let campaignState = null;
	let campaignTargetAuthorSeconds = null;
	let campaignTrackName = '';
	let currentTrackLeaderboardRows = [];
	const GARAGE_PACKS = {
		grip: { cost: 250, label: 'Handling Pack' },
		accel: { cost: 325, label: 'Power Pack' },
		drive: { cost: 400, label: 'Traction Pack' },
	};
	const garageStoreKey = 'racing-garage-mods-v1';
	const campaignStoreKey = 'racing-campaign-v1';
	const GARAGE_FIXED_MULTIPLIER = 1.15;
	let garageMods = { grip: GARAGE_FIXED_MULTIPLIER, accel: GARAGE_FIXED_MULTIPLIER, drive: GARAGE_FIXED_MULTIPLIER };
	let garageUnlocked = { grip: true, accel: true, drive: true };
	const GARAGE_REPAINT_COST = 300;
	const GARAGE_COLOR_PICK_TOLERANCE = 34;
	const GARAGE_COLOR_UNLOCK_COST = 90;
	const GARAGE_SHINY_UNLOCK_COST = 1000;
	const GARAGE_STANDARD_PALETTE = buildGaragePaintPalette();
	const GARAGE_SHINY_PALETTE = buildGarageShinyPalette();
	const GARAGE_PAINT_PALETTE = [ ...GARAGE_STANDARD_PALETTE, ...GARAGE_SHINY_PALETTE ];
	const SHINY_MATERIAL_TUNING = {
		metalness: 0.9,
		roughness: 0.04,
		envMapIntensity: 4.0,
		brightnessBoost: 1.45,
		emissiveBoost: 0.22,
		clearcoat: 1.0,
		clearcoatRoughness: 0.05,
		specularIntensity: 1.0,
		phongShininess: 220,
	};
	const GARAGE_DEFAULT_PAINT_UNLOCKS = new Set( [ GARAGE_STANDARD_PALETTE[ 0 ]?.id, GARAGE_STANDARD_PALETTE[ 1 ]?.id, GARAGE_STANDARD_PALETTE[ 11 ]?.id ].filter( Boolean ) );
	let selectedPaintColorId = GARAGE_PAINT_PALETTE[ 0 ]?.id || '';
	let selectedGarageSourceHex = '';
	let hoveredGarageSourceHex = '';
	let garageViewer = null;
	let garageCosmetics = normalizeGarageCosmetics( null );
	const recolorTextureSourceCache = new WeakMap();
	const garageTexturePaletteCache = new WeakMap();
	if ( lapHud2 ) lapHud2.style.display = isSplitScreen ? 'block' : 'none';
	if ( isSplitScreen ) {

		if ( economyHud ) economyHud.style.display = 'none';
		if ( carSelect ) carSelect.style.display = 'none';
		if ( exportGhostBtn ) exportGhostBtn.style.display = 'none';
		if ( importGhostBtn ) importGhostBtn.style.display = 'none';
	}
	const economyStoreKey = 'racing-economy-v1';
	let coins = 0;
	let shareImageDataUrl = '';
	const HACKS_STORE_KEY = 'racing-hacks-v1';
	const installedMods = (() => {

		try {

			const parsed = JSON.parse( localStorage.getItem( 'racing-installed-mods-v1' ) || '[]' );
			const list = Array.isArray( parsed ) ? parsed : [];
			if ( ! list.some( ( mod ) => mod?.id === 'freecam' ) ) list.push( { id: 'freecam', name: 'Freecam', entry: 'mods/Freecam.js' } );
			return list;

		} catch {

			return [];

		}

	})();
	const hacksInstalled = installedMods.some( ( mod ) => mod?.id === 'hacks' );
	const arcadeBoostInstalled = installedMods.some( ( mod ) => mod?.id === 'arcade-boost' );
	const nonFreecamModsInstalled = installedMods.some( ( mod ) => mod?.id && mod.id !== 'freecam' );
	const checkpointRespawnInstalled = installedMods.some( ( mod ) => mod?.id === 'checkpoint-respawn' );
	const practiceStartInstalled = installedMods.some( ( mod ) => mod?.id === 'practice-start' );
	const stuntModeModInstalled = installedMods.some( ( mod ) => mod?.id === 'stunt-mode' );
	const freecamInstalled = installedMods.some( ( mod ) => mod?.id === 'freecam' );
	if ( stuntModeBtn ) {

		stuntModeBtn.disabled = ! stuntModeModInstalled;
		stuntModeBtn.title = stuntModeModInstalled
			? 'Experimental stunt mode enabled via mod.'
			: 'Stunt mode is under construction (install the Stunt Mode mod to try it).';
		if ( stuntModeModInstalled ) stuntModeBtn.textContent = '🚧 Stunt Mode (Experimental)';

	}
	const hacksState = {
		enabled: false,
		infiniteCoins: false,
		boostAnywhere: false,
		noLimits: false,
		alwaysNitro: false,
		superJump: false,
		teleportForward: false,
		lowFriction: false,
		instantStop: false,
		checkpointBypass: false,
		showHitboxes: false,
		timeScale: 1,
		gravity: 1,
		roadGrip: 1,
	};
	let hackTeleportLatch = false;
	let boostMeter = 0;
	let boostPressedLatch = false;
	const BOOST_METER_MAX = 100;
	let savedCheckpointState = null;
	let savedPracticeState = null;
	const freecamState = {
		active: false,
		yaw: 0,
		pitch: 0,
		moveSpeed: 11,
		sprintMultiplier: 2.25,
		mouseSensitivity: 0.0022,
	};
	const freecamForward = new THREE.Vector3();
	const freecamRight = new THREE.Vector3();
	const freecamMove = new THREE.Vector3();

	function getEngineMult() {

		return DEFAULT_ENGINE_MULT;

	}

	function currentCarKey() {

		return carSelect?.value || 'vehicle-truck-yellow';

	}

	function updateCarSelectColor() {

		if ( ! carSelect ) return;
		const style = CAR_SELECT_STYLES[ currentCarKey() ];
		if ( ! style ) {

			carSelect.style.backgroundColor = '';
			carSelect.style.borderColor = '';
			carSelect.style.color = '';
			return;

		}
		carSelect.style.backgroundColor = style.background;
		carSelect.style.borderColor = style.border;
		carSelect.style.color = style.color;

	}

	function applyVehiclePerformance() {

		if ( isSplitScreen ) {

			vehicle.setPerformance( CAR_STATS[ player1CarKey ].perf );
			return;

		}
		const carKey = currentCarKey();
		const stats = CAR_STATS[ carKey ];
		if ( ! stats ) return;
		const mult = getEngineMult();
			const perf = {
				...stats.perf,
				topSpeed: Math.min( hacksState.enabled && hacksState.noLimits ? 99 : MAX_EFFECTIVE_TOP_SPEED, stats.perf.topSpeed * mult * ( hacksState.enabled && hacksState.noLimits ? 2.5 : 1 ) ),
				driveForce: stats.perf.driveForce * mult * ( hacksState.enabled && hacksState.noLimits ? 2.5 : 1 ),
			};
		vehicle.setPerformance( perf );

	}

	function updateModeHudVisibility() {

		const inStunt = gameMode === 'stunt' || ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' );
		if ( stuntPointsHud ) stuntPointsHud.style.display = inStunt ? 'block' : 'none';
		if ( lapHud ) lapHud.style.display = 'block';
		if ( lapHud2 ) lapHud2.style.display = isSplitScreen ? 'block' : 'none';
		if ( economyHud && ! isSplitScreen ) economyHud.style.display = 'block';
		if ( exportGhostBtn ) exportGhostBtn.style.display = ! isSplitScreen ? 'block' : 'none';
			if ( importGhostBtn ) importGhostBtn.style.display = ! isSplitScreen ? 'block' : 'none';
			if ( hacksToggleLink ) hacksToggleLink.style.display = hacksInstalled && ! isSplitScreen ? 'block' : 'none';
			if ( hacksPanel ) hacksPanel.style.display = 'none';
			updateArcadeBoostUi();

	}

	function saveHacksState() {

		localStorage.setItem( HACKS_STORE_KEY, JSON.stringify( hacksState ) );

	}

	function setHackMeshTransparencyEnabled( enabled ) {

		if ( enabled ) {

			scene.traverse( ( node ) => {

				if ( ! node?.isMesh || node?.userData?.isHackHitboxDebug ) return;
				const materials = Array.isArray( node.material ) ? node.material : [ node.material ];
				for ( const material of materials ) {

					if ( ! material ) continue;
					if ( ! originalHackTransparencyByMaterial.has( material ) ) {

						originalHackTransparencyByMaterial.set( material, {
							transparent: material.transparent,
							opacity: material.opacity,
							depthWrite: material.depthWrite,
						} );

					}
					material.transparent = true;
					material.opacity = Math.min( Number.isFinite( material.opacity ) ? material.opacity : 1, HACK_WORLD_OPACITY );
					material.depthWrite = false;
					material.needsUpdate = true;

				}

			} );
			return;

		}
		for ( const [ material, original ] of originalHackTransparencyByMaterial.entries() ) {

			material.transparent = original.transparent;
			material.opacity = original.opacity;
			material.depthWrite = original.depthWrite;
			material.needsUpdate = true;

		}
		originalHackTransparencyByMaterial.clear();

	}

	function applyHitboxHackVisuals( force = false ) {

		const shouldShow = Boolean( hacksInstalled && hacksState.enabled && hacksState.showHitboxes );
		if ( ! force && shouldShow === hackVisualsApplied ) return;
		hackVisualsApplied = shouldShow;
		hitboxDebugGroup.visible = shouldShow;
		carHitboxMesh.visible = shouldShow;
		setHackMeshTransparencyEnabled( shouldShow );

	}

	function applyHacksUi() {

		if ( ! hacksInstalled ) {

			hacksState.enabled = false;
			hacksState.showHitboxes = false;
			if ( hacksPanel ) hacksPanel.style.display = 'none';
			applyHitboxHackVisuals( true );
			return;

		}
		if ( hackEnableInput ) hackEnableInput.checked = hacksState.enabled;
		if ( hackInfiniteCoinsInput ) hackInfiniteCoinsInput.checked = hacksState.infiniteCoins;
		if ( hackBoostAnywhereInput ) hackBoostAnywhereInput.checked = hacksState.boostAnywhere;
		if ( hackNoLimitsInput ) hackNoLimitsInput.checked = hacksState.noLimits;
		if ( hackAlwaysNitroInput ) hackAlwaysNitroInput.checked = hacksState.alwaysNitro;
		if ( hackSuperJumpInput ) hackSuperJumpInput.checked = hacksState.superJump;
		if ( hackTeleportInput ) hackTeleportInput.checked = hacksState.teleportForward;
		if ( hackLowFrictionInput ) hackLowFrictionInput.checked = hacksState.lowFriction;
		if ( hackInstantStopInput ) hackInstantStopInput.checked = hacksState.instantStop;
		if ( hackCheckpointBypassInput ) hackCheckpointBypassInput.checked = hacksState.checkpointBypass;
		if ( hackShowHitboxesInput ) hackShowHitboxesInput.checked = hacksState.showHitboxes;
		if ( hackTimescaleInput ) hackTimescaleInput.value = String( hacksState.timeScale );
		if ( hackGravityInput ) hackGravityInput.value = String( hacksState.gravity );
		if ( hackRoadGripInput ) hackRoadGripInput.value = String( hacksState.roadGrip );
		applyHitboxHackVisuals();

	}

	function loadHacksState() {

		if ( ! hacksInstalled ) return;
		try {

			const parsed = JSON.parse( localStorage.getItem( HACKS_STORE_KEY ) || '{}' );
			hacksState.enabled = Boolean( parsed.enabled );
			hacksState.infiniteCoins = Boolean( parsed.infiniteCoins );
			hacksState.boostAnywhere = Boolean( parsed.boostAnywhere );
			hacksState.noLimits = Boolean( parsed.noLimits );
			hacksState.alwaysNitro = Boolean( parsed.alwaysNitro );
			hacksState.superJump = Boolean( parsed.superJump );
			hacksState.teleportForward = Boolean( parsed.teleportForward );
			hacksState.lowFriction = Boolean( parsed.lowFriction );
			hacksState.instantStop = Boolean( parsed.instantStop );
			hacksState.checkpointBypass = Boolean( parsed.checkpointBypass );
			hacksState.showHitboxes = Boolean( parsed.showHitboxes );
			hacksState.timeScale = THREE.MathUtils.clamp( Number( parsed.timeScale ) || 1, 0.15, 1 );
			hacksState.gravity = THREE.MathUtils.clamp( Number( parsed.gravity ) || 1, 0.1, 2 );
			hacksState.roadGrip = THREE.MathUtils.clamp( Number( parsed.roadGrip ) || 1, 0.5, 3 );

		} catch {}
		applyHacksUi();

	}

	function resetHacksState() {

		hacksState.enabled = false;
		hacksState.infiniteCoins = false;
		hacksState.boostAnywhere = false;
		hacksState.noLimits = false;
		hacksState.alwaysNitro = false;
		hacksState.superJump = false;
		hacksState.teleportForward = false;
		hacksState.lowFriction = false;
		hacksState.instantStop = false;
		hacksState.checkpointBypass = false;
		hacksState.showHitboxes = false;
		hacksState.timeScale = 1;
		hacksState.gravity = 1;
		hacksState.roadGrip = 1;
		saveHacksState();
		applyHacksUi();
		applyVehiclePerformance();
		showTopMessage( 'Hacks reset to default values.', false, 1300 );

	}

	function showModeError( message ) {

		if ( modeError ) modeError.textContent = message || '';
		if ( message ) window.alert( message );

	}

	function showTopMessage( message, isError = false, durationMs = 1800 ) {

		if ( ! topMessage ) return;
		topMessage.textContent = String( message || '' ).trim();
		topMessage.classList.toggle( 'error', Boolean( isError ) );
		topMessage.classList.toggle( 'show', Boolean( topMessage.textContent ) );
		window.clearTimeout( topMessageTimer );
		if ( ! topMessage.textContent ) return;
		topMessageTimer = window.setTimeout( () => {

			if ( ! topMessage ) return;
			topMessage.classList.remove( 'show' );
			topMessage.textContent = '';

		}, Math.max( 300, Number( durationMs ) || 1800 ) );

	}

	function updateStuntPointsHud() {

		if ( ! stuntPointsHud ) return;
		const visible = gameMode === 'stunt' || ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' );
		if ( ! visible ) return;
		stuntPointsHud.innerHTML = `Points: ${ Math.floor( stuntPoints ) }<small class="best-points">Best: ${ Math.floor( bestStuntPoints ) }</small><small>Combo: x${ stuntCombo.toFixed( 2 ) }</small><small>Bonus: ${ stuntReasonText }</small>`;

	}

	function saveStuntStats() {

		localStorage.setItem( stuntStoreKey, JSON.stringify( { bestStuntPoints } ) );

	}

	function loadStuntStats() {

		try {

			const raw = localStorage.getItem( stuntStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			bestStuntPoints = Number.isFinite( parsed.bestStuntPoints ) ? Math.max( 0, parsed.bestStuntPoints ) : 0;

		} catch ( e ) {

			console.warn( 'Failed to load stunt stats', e );

		}

	}

	function addStuntPoints( amount, reason, reasonDuration = 0.9 ) {

		if ( gameMode !== 'stunt' || ! Number.isFinite( amount ) || amount <= 0 ) return;
		const scaledAmount = amount * stuntCombo;
		stuntPoints += scaledAmount;
		if ( stuntPoints > bestStuntPoints ) {

			bestStuntPoints = stuntPoints;
			saveStuntStats();
			updateGarageUi();

		}
		if ( reason ) {

			stuntReasonText = reason;
			stuntReasonTimer = reasonDuration;

		}

	}

	function resetStuntChain() {

		stuntCombo = 1;
		stuntComboTimer = 0;
		stuntAirTime = 0;

	}

	function setGameMode( mode ) {

		if ( mode !== 'race' && mode !== 'stunt' && mode !== 'campaign' ) return;
		if ( mode === 'stunt' && ! stuntModeModInstalled ) {

			showModeError( 'Stunt Mode is under construction right now.' );
			return;

		}
		if ( ( mode === 'stunt' || mode === 'campaign' ) && isSplitScreen ) {

			showModeError( `${ mode === 'campaign' ? 'Campaign' : 'Stunt Mode' } is disabled in local multiplayer (2P).` );
			return;

		}
		if ( gameMode === mode ) return;
		showModeError( '' );
		gameMode = mode;
		if ( mode === 'stunt' ) {

			stuntPoints = 0;
			stuntReasonText = '--';
			stuntReasonTimer = 0;
			resetStuntChain();
			updateStuntPointsHud();

		} else {

			resetLapState( true );
			resetLapState2( true );

		}
		updateModeHudVisibility();

	}

	function setFreecamActive( active ) {

		if ( ! freecamInstalled ) return;
		const next = Boolean( active );
		if ( next === freecamState.active ) return;
		if ( next && isSplitScreen ) {

			showTopMessage( 'Freecam is unavailable in 2P split screen.', true, 1700 );
			return;

		}
		freecamState.active = next;
		if ( next ) {

			setModeMenuOpen( false );
			cam.camera.getWorldDirection( freecamForward );
			const xzLen = Math.hypot( freecamForward.x, freecamForward.z );
			freecamState.yaw = Math.atan2( freecamForward.x, freecamForward.z );
			freecamState.pitch = Math.atan2( freecamForward.y, Math.max( xzLen, 1e-4 ) );
			renderer.domElement.requestPointerLock?.();
			showTopMessage( 'Freecam enabled (WASD + mouse • Shift = fast • F to exit).', false, 2000 );

		} else {

			if ( document.pointerLockElement === renderer.domElement ) document.exitPointerLock?.();
			showTopMessage( 'Freecam disabled.', false, 900 );

		}

	}

	function updateFreecam( dt ) {

		if ( ! freecamState.active ) return;
		const keys = controls?.keys || {};
		freecamState.pitch = THREE.MathUtils.clamp( freecamState.pitch, - Math.PI * 0.49, Math.PI * 0.49 );
		const cosPitch = Math.cos( freecamState.pitch );
		freecamForward.set(
			Math.sin( freecamState.yaw ) * cosPitch,
			Math.sin( freecamState.pitch ),
			Math.cos( freecamState.yaw ) * cosPitch
		).normalize();
		freecamRight.set( Math.cos( freecamState.yaw ), 0, - Math.sin( freecamState.yaw ) ).normalize();
		freecamMove.set( 0, 0, 0 );
		if ( keys.KeyW ) freecamMove.add( freecamForward );
		if ( keys.KeyS ) freecamMove.sub( freecamForward );
		if ( keys.KeyD ) freecamMove.sub( freecamRight );
		if ( keys.KeyA ) freecamMove.add( freecamRight );
		if ( keys.Space ) freecamMove.y += 1;
		if ( keys.ControlLeft || keys.ControlRight ) freecamMove.y -= 1;
		if ( freecamMove.lengthSq() > 1e-6 ) {

			const speed = freecamState.moveSpeed * ( keys.ShiftLeft || keys.ShiftRight ? freecamState.sprintMultiplier : 1 );
			cam.camera.position.addScaledVector( freecamMove.normalize(), speed * dt );

		}
		cam.lookTarget.copy( cam.camera.position ).add( freecamForward );
		cam.camera.lookAt( cam.lookTarget );

	}

	function setModeMenuOpen( open ) {

		modeMenuOpen = open;
		if ( modeMenu ) modeMenu.style.display = open ? 'block' : 'none';
		document.body.classList.toggle( 'mode-menu-open', modeMenuOpen );

	}

	function buildGaragePaintPalette() {

		const colors = [];
		for ( let row = 0; row < 7; row ++ ) {

			for ( let col = 0; col < 11; col ++ ) {

				const hue = Math.round( ( col / 11 ) * 360 ) % 360;
				const sat = THREE.MathUtils.lerp( 0.34, 1.0, row / 6 );
				const light = THREE.MathUtils.lerp( 0.84, 0.38, row / 6 );
				const color = new THREE.Color().setHSL( hue / 360, sat, light );
				colors.push( {
					id: `p-${ row }-${ col }`,
					hex: `#${ color.getHexString() }`,
					row,
					col,
					unlockCost: GARAGE_COLOR_UNLOCK_COST,
					finish: 'matte',
				} );

			}

		}
		return colors;

	}

	function buildGarageShinyPalette() {

		const colors = [];
		const metallicHues = [ '#d7dde8', '#cfd9df', '#f9d27d', '#f7f7f7', '#b7e3ff', '#f2b6ff', '#9cf7d2', '#ffb58d', '#ffe8a6', '#bcbcff', '#ff6a45' ];
		for ( let i = 0; i < metallicHues.length; i ++ ) {

			colors.push( {
				id: `s-${ i }`,
				hex: metallicHues[ i ],
				row: 0,
				col: i,
				unlockCost: GARAGE_SHINY_UNLOCK_COST,
				finish: 'shiny',
			} );

		}
		return colors;

	}

	function normalizeGarageCosmetics( value ) {

		const next = value && typeof value === 'object' ? value : {};
		const unlockedPaints = {};
		for ( const entry of GARAGE_PAINT_PALETTE ) {

			const unlocked = Boolean( next?.unlockedPaints?.[ entry.id ] ) || GARAGE_DEFAULT_PAINT_UNLOCKS.has( entry.id );
			if ( unlocked ) unlockedPaints[ entry.id ] = true;

		}
		if ( next?.unlockedPaints && typeof next.unlockedPaints === 'object' ) {

			for ( const paintId of Object.keys( next.unlockedPaints ) ) {

				if ( /^custom-[0-9a-fA-F]{6}$/.test( paintId ) ) unlockedPaints[ paintId.toLowerCase() ] = true;

			}

		}

		const cars = {};
		if ( next?.cars && typeof next.cars === 'object' ) {

			for ( const [ carKey, carData ] of Object.entries( next.cars ) ) {

				if ( ! CAR_STATS[ carKey ] ) continue;
				const mappings = Array.isArray( carData?.mappings ) ? carData.mappings : [];
				cars[ carKey ] = {
					mappings: mappings.slice( 0, 48 ).map( ( mapping ) => ( {
						sourceHex: typeof mapping?.sourceHex === 'string' ? mapping.sourceHex : '#ff0000',
						targetColorId: typeof mapping?.targetColorId === 'string' ? mapping.targetColorId : '',
						tolerance: THREE.MathUtils.clamp( Number( mapping?.tolerance ) || 40, 8, 180 ),
					} ) ).filter( ( mapping ) => /^#[0-9a-fA-F]{6}$/.test( mapping.sourceHex ) && unlockedPaints[ mapping.targetColorId ] ),
				};

			}

		}

		return { unlockedPaints, cars };

	}

	function getGarageCosmeticCar( carKey ) {

		if ( ! garageCosmetics.cars[ carKey ] ) garageCosmetics.cars[ carKey ] = { mappings: [] };
		return garageCosmetics.cars[ carKey ];

	}

	function getSelectedGarageCarKey() {

		const candidate = garageCarSelect?.value;
		return CAR_STATS[ candidate ] ? candidate : currentCarKey();

	}

	function clampGarageValue( value, fallback = 1.0 ) {

		const parsed = Number( value );
		if ( ! Number.isFinite( parsed ) ) return fallback;
		return THREE.MathUtils.clamp( parsed, 0.85, 1.15 );

	}

	function setModeTab( tabName ) {

		const tab = tabName === 'garage' || tabName === 'account' || tabName === 'nav' ? tabName : 'gameplay';
		modeTabGameplayBtn?.classList.toggle( 'active', tab === 'gameplay' );
		modeTabGarageBtn?.classList.toggle( 'active', tab === 'garage' );
		modeTabAccountBtn?.classList.toggle( 'active', tab === 'account' );
		modeTabNavBtn?.classList.toggle( 'active', tab === 'nav' );
		modePanelGameplay?.classList.toggle( 'active', tab === 'gameplay' );
		modePanelGarage?.classList.toggle( 'active', tab === 'garage' );
		modePanelAccount?.classList.toggle( 'active', tab === 'account' );
		modePanelNav?.classList.toggle( 'active', tab === 'nav' );
		modeMenu?.classList.toggle( 'garage-fullscreen', tab === 'garage' );

	}

	function updateGraphicsQualityUi() {

		const preset = getGraphicsPreset();
		for ( const button of graphicsQualityButtons ) {

			const selected = button.dataset.graphicsQuality === graphicsQuality;
			button.classList.toggle( 'active', selected );
			button.setAttribute( 'aria-pressed', String( selected ) );

		}
		if ( graphicsQualityLabel ) graphicsQualityLabel.textContent = `${ preset.label } performance mode`;

	}

	function applyGraphicsQuality( nextQuality, save = false ) {

		graphicsQuality = normalizeGraphicsQuality( nextQuality );
		if ( save ) localStorage.setItem( GRAPHICS_QUALITY_KEY, graphicsQuality );
		applyGraphicsPresetToRenderer();
		particles.setQuality( getGraphicsParticleOptions() );
		particles2?.setQuality( getGraphicsParticleOptions() );
		setupWeatherFx( vehicle.spherePos.x, vehicle.spherePos.z );
		updateGraphicsQualityUi();

	}

	function getGarageUnlocks() {

		return { ...garageUnlocked };

	}

	function saveGarageMods() {

		localStorage.setItem( garageStoreKey, JSON.stringify( { mods: garageMods, unlocked: garageUnlocked, cosmetics: garageCosmetics } ) );

	}

	function loadGarageMods() {

		try {

			const raw = localStorage.getItem( garageStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			garageMods = { grip: GARAGE_FIXED_MULTIPLIER, accel: GARAGE_FIXED_MULTIPLIER, drive: GARAGE_FIXED_MULTIPLIER };
			garageUnlocked = { grip: true, accel: true, drive: true };
			garageCosmetics = normalizeGarageCosmetics( parsed?.cosmetics );

		} catch ( e ) {

			console.warn( 'Failed to load garage mods', e );

		}

	}

	function updateGarageUi() {

		const unlocks = getGarageUnlocks();
		if ( isSplitScreen ) {

			if ( garageGripSlider ) garageGripSlider.disabled = true;
			if ( garageAccelSlider ) garageAccelSlider.disabled = true;
			if ( garageDriveSlider ) garageDriveSlider.disabled = true;
			if ( garageGripUnlockBtn ) garageGripUnlockBtn.disabled = true;
			if ( garageAccelUnlockBtn ) garageAccelUnlockBtn.disabled = true;
			if ( garageDriveUnlockBtn ) garageDriveUnlockBtn.disabled = true;
			if ( garageGripStatus ) garageGripStatus.textContent = 'Unavailable in 2P mode';
			if ( garageAccelStatus ) garageAccelStatus.textContent = 'Unavailable in 2P mode';
			if ( garageDriveStatus ) garageDriveStatus.textContent = 'Unavailable in 2P mode';
			return;

		}
		if ( garageGripSlider ) {

			garageGripSlider.disabled = ! unlocks.grip;
			garageGripSlider.value = String( garageMods.grip );

		}
		if ( garageAccelSlider ) {

			garageAccelSlider.disabled = ! unlocks.accel;
			garageAccelSlider.value = String( garageMods.accel );

		}
		if ( garageDriveSlider ) {

			garageDriveSlider.disabled = ! unlocks.drive;
			garageDriveSlider.value = String( garageMods.drive );

		}
		if ( garageGripValue ) garageGripValue.textContent = `x${ garageMods.grip.toFixed( 2 ) }`;
		if ( garageAccelValue ) garageAccelValue.textContent = `x${ garageMods.accel.toFixed( 2 ) }`;
		if ( garageDriveValue ) garageDriveValue.textContent = `x${ garageMods.drive.toFixed( 2 ) }`;
		if ( garageGripUnlockBtn ) {

			garageGripUnlockBtn.disabled = unlocks.grip || coins < GARAGE_PACKS.grip.cost;
			garageGripUnlockBtn.textContent = unlocks.grip ? 'Unlocked' : `Unlock (${ GARAGE_PACKS.grip.cost })`;

		}
		if ( garageAccelUnlockBtn ) {

			garageAccelUnlockBtn.disabled = unlocks.accel || coins < GARAGE_PACKS.accel.cost;
			garageAccelUnlockBtn.textContent = unlocks.accel ? 'Unlocked' : `Unlock (${ GARAGE_PACKS.accel.cost })`;

		}
		if ( garageDriveUnlockBtn ) {

			garageDriveUnlockBtn.disabled = unlocks.drive || coins < GARAGE_PACKS.drive.cost;
			garageDriveUnlockBtn.textContent = unlocks.drive ? 'Unlocked' : `Unlock (${ GARAGE_PACKS.drive.cost })`;

		}
		if ( garageGripStatus ) garageGripStatus.textContent = unlocks.grip ? 'Pack active' : 'Buy to activate slider';
		if ( garageAccelStatus ) garageAccelStatus.textContent = unlocks.accel ? 'Pack active' : 'Buy to activate slider';
		if ( garageDriveStatus ) garageDriveStatus.textContent = unlocks.drive ? 'Pack active' : 'Buy to activate slider';
		if ( garageCarSelect ) garageCarSelect.value = getSelectedGarageCarKey();
		renderGarageVehicleCards();
		updateGaragePaintControls();
		updateGarageMappingsUi();
		refreshGarageViewer();

	}

	function getPaintColorById( colorId ) {

		const found = GARAGE_PAINT_PALETTE.find( ( color ) => color.id === colorId );
		if ( found ) return found;
		if ( /^custom-[0-9a-fA-F]{6}$/.test( String( colorId || '' ) ) ) {

			return { id: String( colorId ).toLowerCase(), hex: `#${ String( colorId ).slice( 7 ).toLowerCase() }`, unlockCost: 0, finish: 'matte' };

		}
		return null;

	}

	function setGarageMappingStatus( message, isError = false ) {

		if ( ! garageMappingStatus ) return;
		garageMappingStatus.textContent = message || '';
		garageMappingStatus.style.color = isError ? '#ff9ea2' : '#b9d0ea';

	}

	function getGarageRepaintTolerance() {

		return THREE.MathUtils.clamp( Number( garageRepaintToleranceInput?.value ) || GARAGE_COLOR_PICK_TOLERANCE, 4, 180 );

	}

	function updateGaragePaintControls() {

		const hasSelection = /^#[0-9a-fA-F]{6}$/.test( selectedGarageSourceHex );
		if ( garageApplyPaintBtn ) {

			garageApplyPaintBtn.disabled = ! hasSelection || coins < GARAGE_REPAINT_COST;
			garageApplyPaintBtn.textContent = hasSelection ? `Apply repaint (${ GARAGE_REPAINT_COST } coins)` : 'Select a car color first';

		}
		if ( garageRepaintToleranceValue ) garageRepaintToleranceValue.textContent = String( Math.round( getGarageRepaintTolerance() ) );
		if ( garageSelectionChip ) {

			garageSelectionChip.innerHTML = hasSelection
				? `Selected area: <strong>${ selectedGarageSourceHex }</strong><br>Matching painted parts are highlighted green. Hovered parts highlight yellow.`
				: 'No car color selected yet. Click the car in the viewer to choose a paint area.';

		}

	}

	function getGarageTexturePalette( texture ) {

		if ( ! texture ) return [];
		if ( garageTexturePaletteCache.has( texture ) ) return garageTexturePaletteCache.get( texture );
		const source = getTextureSourcePixels( texture );
		if ( ! source ) return [];
		const counts = new Map();
		for ( let i = 0; i < source.data.length; i += 4 ) {

			if ( source.data[ i + 3 ] < 16 ) continue;
			const key = `${ source.data[ i ] },${ source.data[ i + 1 ] },${ source.data[ i + 2 ] }`;
			counts.set( key, ( counts.get( key ) || 0 ) + 1 );

		}
		const palette = [ ...counts.entries() ].map( ( [ key, count ] ) => {

			const [ r, g, b ] = key.split( ',' ).map( Number );
			return { r, g, b, hex: `#${ [ r, g, b ].map( ( v ) => v.toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`, count, isBlack: r + g + b <= 24 };

		} ).sort( ( a, b ) => b.count - a.count );
		garageTexturePaletteCache.set( texture, palette );
		return palette;

	}

	function snapHexToTexturePalette( texture, hex, allowBlack = false ) {

		const rgb = hexToRgbBytes( hex );
		if ( ! rgb ) return '';
		const palette = getGarageTexturePalette( texture );
		let best = null;
		let bestScore = Number.POSITIVE_INFINITY;
		for ( const color of palette ) {

			if ( color.isBlack && ! allowBlack ) continue;
			const dr = rgb.r - color.r;
			const dg = rgb.g - color.g;
			const db = rgb.b - color.b;
			const distSq = dr * dr + dg * dg + db * db;
			const score = distSq - Math.min( color.count, 10000 ) * 0.002;
			if ( score < bestScore ) {

				best = color;
				bestScore = score;

			}

		}
		return best?.hex || '';

	}

	function sampleTextureHexAtUv( texture, uv ) {

		const source = getTextureSourcePixels( texture );
		if ( ! source || ! uv ) return null;
		const centerX = THREE.MathUtils.clamp( Math.floor( uv.x * source.width ), 0, source.width - 1 );
		const centerY = THREE.MathUtils.clamp( Math.floor( ( 1 - uv.y ) * source.height ), 0, source.height - 1 );
		const counts = new Map();
		const blackCounts = new Map();
		const radius = 6;
		for ( let py = centerY - radius; py <= centerY + radius; py ++ ) {

			if ( py < 0 || py >= source.height ) continue;
			for ( let px = centerX - radius; px <= centerX + radius; px ++ ) {

				if ( px < 0 || px >= source.width ) continue;
				const i = ( py * source.width + px ) * 4;
				if ( source.data[ i + 3 ] < 16 ) continue;
				const r = source.data[ i ];
				const g = source.data[ i + 1 ];
				const b = source.data[ i + 2 ];
				const key = `${ r },${ g },${ b }`;
				const bucket = ( r + g + b <= 24 ) ? blackCounts : counts;
				bucket.set( key, ( bucket.get( key ) || 0 ) + 1 );

			}

		}
		const choose = ( map ) => {

			let best = '';
			let bestCount = 0;
			for ( const [ key, count ] of map ) {

				if ( count > bestCount ) {

					best = key;
					bestCount = count;

				}

			}
			return best;

		};
		const best = choose( counts ) || choose( blackCounts );
		if ( ! best ) return null;
		return `#${ best.split( ',' ).map( ( v ) => Number( v ).toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`;

	}


	function makeGaragePickerClone( source ) {

		const clone = source.clone( true );
		clone.rotation.y = Math.PI;
		clone.traverse( ( child ) => {

			if ( ! child.isMesh || ! child.material ) return;
			const sourceMaterials = Array.isArray( child.material ) ? child.material : [ child.material ];
			const pickerMaterials = sourceMaterials.map( ( material ) => new THREE.MeshBasicMaterial( {
				color: material.color ? material.color.clone() : new THREE.Color( 0xffffff ),
				map: material.map || null,
				transparent: Boolean( material.transparent ),
				opacity: Number.isFinite( material.opacity ) ? material.opacity : 1,
				alphaTest: Number.isFinite( material.alphaTest ) ? material.alphaTest : 0,
				side: material.side,
			} ) );
			child.material = Array.isArray( child.material ) ? pickerMaterials : pickerMaterials[ 0 ];

		} );
		return clone;

	}

	function readGaragePickerHex( event ) {

		if ( ! garageViewer?.pickerRoot || ! garageViewer?.pickerTarget ) return '';
		const rect = garageViewerCanvas.getBoundingClientRect();
		const pixelRatio = Math.min( window.devicePixelRatio || 1, 1.5 );
		const width = Math.max( 1, Math.floor( rect.width * pixelRatio ) );
		const height = Math.max( 1, Math.floor( rect.height * pixelRatio ) );
		if ( garageViewer.pickerTarget.width !== width || garageViewer.pickerTarget.height !== height ) garageViewer.pickerTarget.setSize( width, height );
		garageViewer.pickerRoot.rotation.y = garageViewer.yaw;
		garageViewer.renderer.setRenderTarget( garageViewer.pickerTarget );
		garageViewer.renderer.render( garageViewer.pickerScene, garageViewer.camera );
		const pixel = new Uint8Array( 4 );
		const x = THREE.MathUtils.clamp( Math.floor( ( event.clientX - rect.left ) * pixelRatio ), 0, width - 1 );
		const y = THREE.MathUtils.clamp( Math.floor( height - ( event.clientY - rect.top ) * pixelRatio ), 0, height - 1 );
		garageViewer.renderer.readRenderTargetPixels( garageViewer.pickerTarget, x, y, 1, 1, pixel );
		garageViewer.renderer.setRenderTarget( null );
		return `#${ [ pixel[ 0 ], pixel[ 1 ], pixel[ 2 ] ].map( ( v ) => v.toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`;

	}


	function getGarageViewerHit( event ) {

		if ( ! garageViewer?.raycaster || ! garageViewer?.carRoot ) return null;
		const rect = garageViewerCanvas.getBoundingClientRect();
		garageViewer.pointer.set( ( ( event.clientX - rect.left ) / rect.width ) * 2 - 1, - ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1 );
		garageViewer.raycaster.setFromCamera( garageViewer.pointer, garageViewer.camera );
		return garageViewer.raycaster.intersectObjects( garageViewer.carRoot.children, true ).find( ( item ) => item.object?.isMesh ) || null;

	}

	function getGarageRemapHexFromHit( hit, renderedHex = '' ) {

		const materialIndex = hit?.face?.materialIndex || 0;
		const liveMaterial = Array.isArray( hit?.object?.material ) ? hit.object.material[ materialIndex ] : hit?.object?.material;
		const baseMaterial = Array.isArray( hit?.object?.userData?.baseMaterial ) ? hit.object.userData.baseMaterial[ materialIndex ] : null;
		const material = baseMaterial || liveMaterial;
		const sampledHex = ( sampleTextureHexAtUv( material?.map, hit?.uv ) || ( material?.color ? `#${ material.color.getHexString() }` : '' ) ).toLowerCase();
		const renderedIsUseful = /^#[0-9a-fA-F]{6}$/.test( renderedHex ) && colorDistanceSqHex( renderedHex, '#000000' ) > 24 * 24;
		if ( material?.map && ( sampledHex === '#000000' || ! /^#[0-9a-fA-F]{6}$/.test( sampledHex ) ) && renderedIsUseful ) {

			return snapHexToTexturePalette( material.map, renderedHex, false ) || sampledHex;

		}
		if ( material?.map && renderedIsUseful ) {

			const snappedRendered = snapHexToTexturePalette( material.map, renderedHex, false );
			if ( snappedRendered && colorDistanceSqHex( sampledHex, '#000000' ) <= 24 * 24 ) return snappedRendered;

		}
		return sampledHex;

	}


	function updateGarageHoverFromEvent( event ) {

		if ( ! garageViewer || garageViewer.dragging ) return;
		const hit = getGarageViewerHit( event );
		const pickerHex = hit ? readGaragePickerHex( event ) : '';
		const nextHex = hit ? getGarageRemapHexFromHit( hit, pickerHex ) : '';
		if ( nextHex === hoveredGarageSourceHex ) return;
		hoveredGarageSourceHex = /^#[0-9a-fA-F]{6}$/.test( nextHex ) ? nextHex : '';
		refreshGarageViewer();

	}

	function refreshGarageViewer() {

		if ( ! garageViewer?.carRoot ) return;
		const carKey = getSelectedGarageCarKey();
		garageViewer.carRoot.clear();
		garageViewer.pickerRoot?.clear();
		const source = models[ carKey ];
		if ( ! source ) return;
		const clone = source.clone( true );
		clone.rotation.y = Math.PI;
		garageViewer.carRoot.add( clone );
		applyCarCustomizationToObject( clone, carKey, selectedGarageSourceHex, true, hoveredGarageSourceHex, getGarageRepaintTolerance() );
		garageViewer.pickerRoot?.add( makeGaragePickerClone( source ) );

	}

	function initGarageViewer() {

		if ( garageViewer || ! garageViewerCanvas ) return;
		const renderer = new THREE.WebGLRenderer( { canvas: garageViewerCanvas, antialias: true, alpha: true } );
		renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, 1.5 ) );
		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera( 38, 1, 0.1, 100 );
		camera.position.set( 0, 1.25, 5.2 );
		scene.background = new THREE.Color( 0xf7fbff );
		scene.add( new THREE.AmbientLight( 0xffffff, 3.0 ) );
		const carRoot = new THREE.Group();
		scene.add( carRoot );
		const pickerScene = new THREE.Scene();
		pickerScene.background = new THREE.Color( 0xffffff );
		const pickerRoot = new THREE.Group();
		pickerScene.add( pickerRoot );
		const pickerTarget = new THREE.WebGLRenderTarget( 1, 1, { depthBuffer: true, stencilBuffer: false } );
		garageViewer = { renderer, scene, camera, carRoot, pickerScene, pickerRoot, pickerTarget, yaw: 0, dragging: false, moved: false, sx: 0, raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2() };
		const resize = () => {

			const rect = garageViewerCanvas.getBoundingClientRect();
			const w = Math.max( 1, Math.floor( rect.width ) );
			const h = Math.max( 1, Math.floor( rect.height ) );
			renderer.setSize( w, h, false );
			camera.aspect = w / h;
			camera.updateProjectionMatrix();

		};
		const animate = () => {

			if ( garageViewer ) {

				resize();
				carRoot.rotation.y = garageViewer.yaw;
				if ( garageViewer.pickerRoot ) garageViewer.pickerRoot.rotation.y = garageViewer.yaw;
				renderer.render( scene, camera );
				requestAnimationFrame( animate );

			}

		};
		garageViewerCanvas.addEventListener( 'pointerdown', ( event ) => { garageViewer.dragging = true; garageViewer.moved = false; garageViewer.sx = event.clientX; garageViewerCanvas.classList.add( 'dragging' ); garageViewerCanvas.setPointerCapture?.( event.pointerId ); } );
		garageViewerCanvas.addEventListener( 'pointermove', ( event ) => { if ( garageViewer.dragging ) { const dx = event.clientX - garageViewer.sx; if ( Math.abs( dx ) > 2 ) garageViewer.moved = true; garageViewer.yaw += dx * 0.01; garageViewer.sx = event.clientX; return; } updateGarageHoverFromEvent( event ); } );
		garageViewerCanvas.addEventListener( 'pointerleave', () => { if ( hoveredGarageSourceHex ) { hoveredGarageSourceHex = ''; refreshGarageViewer(); } } );
		garageViewerCanvas.addEventListener( 'pointerup', ( event ) => {

			garageViewer.dragging = false;
			garageViewerCanvas.classList.remove( 'dragging' );
			if ( garageViewer.moved ) return;
			const hit = getGarageViewerHit( event );
			if ( ! hit ) {

				selectedGarageSourceHex = '';
				hoveredGarageSourceHex = '';
				updateGaragePaintControls();
				refreshGarageViewer();
				setGarageMappingStatus( 'Selection cleared. Click directly on the car to pick a paint area.' );
				return;

			}
			const pickerHex = readGaragePickerHex( event );
			const remapHex = getGarageRemapHexFromHit( hit, pickerHex );
			const hex = /^#[0-9a-fA-F]{6}$/.test( remapHex ) ? remapHex : pickerHex;
			if ( /^#[0-9a-fA-F]{6}$/.test( hex ) ) {

				selectedGarageSourceHex = hex.toLowerCase();
				updateGaragePaintControls();
				refreshGarageViewer();
				setGarageMappingStatus( `Selected ${ selectedGarageSourceHex }. Choose a new color and apply repaint.` );

			}

		} );
		refreshGarageViewer();
		animate();

	}


	function garageUpgradeSummary() {

		const unlocks = getGarageUnlocks();
		return [
			`Handling ${ unlocks.grip ? `x${ garageMods.grip.toFixed( 2 ) }` : 'locked' }`,
			`Power ${ unlocks.accel ? `x${ garageMods.accel.toFixed( 2 ) }` : 'locked' }`,
			`Traction ${ unlocks.drive ? `x${ garageMods.drive.toFixed( 2 ) }` : 'locked' }`,
		].join( ' • ' );

	}

	function renderGarageVehicleCards() {

		if ( ! garageVehicleCards ) return;
		const selectedKey = getSelectedGarageCarKey();
		garageVehicleCards.innerHTML = '';
		for ( const carKey of modelNames.filter( ( key ) => CAR_STATS[ key ] ) ) {

			const stats = CAR_STATS[ carKey ];
			const style = CAR_SELECT_STYLES[ carKey ] || {};
			const perf = stats.perf || {};
			const mappings = getGarageCosmeticCar( carKey ).mappings.length;
			const button = document.createElement( 'button' );
			button.type = 'button';
			button.className = `garage-vehicle-card${ carKey === selectedKey ? ' active' : '' }`;
			button.style.setProperty( '--garage-accent', style.border || '#9ed8ff' );
			button.innerHTML = `
				<h5>${ stats.name } truck</h5>
				<dl>
					<dt>Speed</dt><dd>${ stats.speed } / 10</dd>
					<dt>Acceleration</dt><dd>${ stats.accel } / 10</dd>
					<dt>Handling</dt><dd>${ ( GARAGE_FIXED_MULTIPLIER * 100 ).toFixed( 0 ) }%</dd>
					<dt>Traction</dt><dd>${ ( GARAGE_FIXED_MULTIPLIER * 100 ).toFixed( 0 ) }%</dd>
					<dt>Top speed</dt><dd>${ Number( perf.topSpeed || 0 ).toFixed( 2 ) }</dd>
					<dt>Power</dt><dd>${ Number( perf.driveForce || 0 ).toFixed( 0 ) }</dd>
					<dt>Paint maps</dt><dd>${ mappings }</dd>
				</dl>
				<span class="garage-vehicle-status">${ garageUpgradeSummary() }</span>`;
			button.addEventListener( 'click', ( event ) => { event.preventDefault(); event.stopPropagation(); selectGarageCar( carKey ); } );
			garageVehicleCards.appendChild( button );

		}

	}

	function selectGarageCar( selectedKey ) {

		if ( ! CAR_STATS[ selectedKey ] ) return;
		if ( garageCarSelect ) garageCarSelect.value = selectedKey;
		if ( carSelect ) carSelect.value = selectedKey;
		updateCarSelectColor();
		if ( models[ selectedKey ] ) {

			vehicle.setModel( models[ selectedKey ] );
			applyCarCustomization( vehicle );
			applyHitboxHackVisuals( true );

		}
		updateGarageMappingsUi();
		refreshGarageViewer();
		renderGarageVehicleCards();
		setGarageMappingStatus( `Now editing mappings for ${ CAR_STATS[ selectedKey ]?.name || 'selected car' }.` );
		applyVehiclePerformance();
		saveGarageMods();

	}

	function updateGarageMappingsUi() {

		if ( ! garageMappingsList ) return;
		const carKey = getSelectedGarageCarKey();
		const mappings = getGarageCosmeticCar( carKey ).mappings;
		garageMappingsList.innerHTML = '';
		if ( mappings.length === 0 ) {

			const empty = document.createElement( 'li' );
			empty.textContent = 'No mappings yet for this car.';
			garageMappingsList.appendChild( empty );
			return;

		}
		mappings.forEach( ( mapping, index ) => {

			const destination = getPaintColorById( mapping.targetColorId );
			const item = document.createElement( 'li' );
			item.innerHTML = `<span>${ mapping.sourceHex } → ${ destination?.hex || '(locked)' } (tol ${ Math.round( mapping.tolerance ) })</span>`;
			const removeBtn = document.createElement( 'button' );
			removeBtn.type = 'button';
			removeBtn.textContent = 'Remove';
			removeBtn.style.marginLeft = '6px';
			removeBtn.addEventListener( 'click', ( event ) => {

				event.preventDefault();
				event.stopPropagation();
				mappings.splice( index, 1 );
				saveGarageMods();
				updateGarageMappingsUi();
				applyCarCustomization( vehicle );

			} );
			item.appendChild( removeBtn );
			garageMappingsList.appendChild( item );

		} );

	}

	function hexToRgbBytes( hex ) {

		const clean = String( hex || '' ).trim().replace( '#', '' );
		if ( ! /^[0-9a-fA-F]{6}$/.test( clean ) ) return null;
		return {
			r: Number.parseInt( clean.slice( 0, 2 ), 16 ),
			g: Number.parseInt( clean.slice( 2, 4 ), 16 ),
			b: Number.parseInt( clean.slice( 4, 6 ), 16 ),
		};

	}

	function buildResolvedMappings( mappings ) {

		const resolved = [];
		for ( const mapping of mappings ) {

			const source = hexToRgbBytes( mapping?.sourceHex );
			const targetPaint = getPaintColorById( mapping?.targetColorId );
			const target = hexToRgbBytes( targetPaint?.hex );
			if ( ! source || ! target || ! garageCosmetics.unlockedPaints[ mapping?.targetColorId ] ) continue;
			const tolerance = THREE.MathUtils.clamp( Number( mapping?.tolerance ) || 40, 8, 180 );
			resolved.push( {
				source,
				target,
				finish: targetPaint.finish || 'matte',
				toleranceSq: tolerance * tolerance,
			} );

		}
		return resolved;

	}

	function pickMappedColor( rgb, resolvedMappings ) {

		let best = null;
		let bestDistSq = Number.POSITIVE_INFINITY;
		for ( const mapping of resolvedMappings ) {

			const dr = rgb.r - mapping.source.r;
			const dg = rgb.g - mapping.source.g;
			const db = rgb.b - mapping.source.b;
			const distSq = dr * dr + dg * dg + db * db;
			if ( distSq <= mapping.toleranceSq && distSq < bestDistSq ) {

				best = { ...mapping.target, finish: mapping.finish };
				bestDistSq = distSq;

			}

		}
		return best;

	}

	function getTextureSourcePixels( texture ) {

		if ( ! texture?.image ) return null;
		if ( recolorTextureSourceCache.has( texture ) ) return recolorTextureSourceCache.get( texture );

		const image = texture.image;
		const width = image.width || image.videoWidth;
		const height = image.height || image.videoHeight;
		if ( ! width || ! height ) return null;

		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.drawImage( image, 0, 0, width, height );
		const source = ctx.getImageData( 0, 0, width, height );
		const cached = { width, height, data: new Uint8ClampedArray( source.data ) };
		recolorTextureSourceCache.set( texture, cached );
		return cached;

	}

	function recolorTexture( texture, resolvedMappings ) {

		if ( resolvedMappings.length === 0 || ! texture ) return { texture, hasShiny: false };
		const source = getTextureSourcePixels( texture );
		if ( ! source ) return { texture, hasShiny: false };

		const canvas = document.createElement( 'canvas' );
		canvas.width = source.width;
		canvas.height = source.height;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return { texture, hasShiny: false };

		const output = new Uint8ClampedArray( source.data );
		let hasShiny = false;
		for ( let i = 0; i < output.length; i += 4 ) {

			const mapped = pickMappedColor( {
				r: output[ i ],
				g: output[ i + 1 ],
				b: output[ i + 2 ],
			}, resolvedMappings );
			if ( mapped ) {

				output[ i ] = mapped.r;
				output[ i + 1 ] = mapped.g;
				output[ i + 2 ] = mapped.b;
				if ( mapped.finish === 'shiny' ) hasShiny = true;

			}

		}

		const imageData = new ImageData( output, source.width, source.height );
		ctx.putImageData( imageData, 0, 0 );
		const nextTexture = new THREE.CanvasTexture( canvas );
		nextTexture.colorSpace = texture.colorSpace;
		nextTexture.flipY = texture.flipY;
		nextTexture.wrapS = texture.wrapS;
		nextTexture.wrapT = texture.wrapT;
		nextTexture.repeat.copy( texture.repeat );
		nextTexture.offset.copy( texture.offset );
		nextTexture.rotation = texture.rotation;
		nextTexture.center.copy( texture.center );
		nextTexture.minFilter = texture.minFilter;
		nextTexture.magFilter = texture.magFilter;
		nextTexture.generateMipmaps = texture.generateMipmaps;
		nextTexture.anisotropy = texture.anisotropy;
		nextTexture.needsUpdate = true;
		return { texture: nextTexture, hasShiny };

	}

	function applyShinyFinish( material, mappedColor = null ) {

		if ( typeof material.metalness === 'number' ) material.metalness = SHINY_MATERIAL_TUNING.metalness;
		if ( typeof material.roughness === 'number' ) material.roughness = SHINY_MATERIAL_TUNING.roughness;
		if ( typeof material.envMapIntensity === 'number' ) material.envMapIntensity = SHINY_MATERIAL_TUNING.envMapIntensity;
		if ( typeof material.clearcoat === 'number' ) material.clearcoat = SHINY_MATERIAL_TUNING.clearcoat;
		if ( typeof material.clearcoatRoughness === 'number' ) material.clearcoatRoughness = SHINY_MATERIAL_TUNING.clearcoatRoughness;
		if ( typeof material.specularIntensity === 'number' ) material.specularIntensity = SHINY_MATERIAL_TUNING.specularIntensity;
		if ( typeof material.shininess === 'number' ) material.shininess = SHINY_MATERIAL_TUNING.phongShininess;
		if ( material.specular && typeof material.specular.setScalar === 'function' ) material.specular.setScalar( 1.0 );
		if ( material.color ) material.color.multiplyScalar( SHINY_MATERIAL_TUNING.brightnessBoost );
		if ( material.emissive ) {

			if ( mappedColor ) material.emissive.setRGB( mappedColor.r / 255, mappedColor.g / 255, mappedColor.b / 255 );
			else material.emissive.copy( material.color );
			material.emissive.multiplyScalar( SHINY_MATERIAL_TUNING.emissiveBoost );

		}

	}

	function colorDistanceSqHex( aHex, bHex ) {

		const a = hexToRgbBytes( aHex );
		const b = hexToRgbBytes( bHex );
		if ( ! a || ! b ) return Number.POSITIVE_INFINITY;
		return ( a.r - b.r ) ** 2 + ( a.g - b.g ) ** 2 + ( a.b - b.b ) ** 2;

	}

	function createHighlightedTexture( texture, selectedHex, hoverHex = '', tolerance = GARAGE_COLOR_PICK_TOLERANCE ) {

		const hasSelected = /^#[0-9a-fA-F]{6}$/.test( selectedHex || '' );
		const hasHover = /^#[0-9a-fA-F]{6}$/.test( hoverHex || '' );
		if ( ! texture || ( ! hasSelected && ! hasHover ) ) return null;
		const source = getTextureSourcePixels( texture );
		const selected = hasSelected ? hexToRgbBytes( selectedHex ) : null;
		const hover = hasHover ? hexToRgbBytes( hoverHex ) : null;
		if ( ! source || ( hasSelected && ! selected ) || ( hasHover && ! hover ) ) return null;
		const toleranceSq = tolerance * tolerance;
		const output = new Uint8ClampedArray( source.data );
		let matched = false;
		for ( let i = 0; i < output.length; i += 4 ) {

			let color = null;
			if ( selected ) {

				const dr = source.data[ i ] - selected.r;
				const dg = source.data[ i + 1 ] - selected.g;
				const db = source.data[ i + 2 ] - selected.b;
				if ( dr * dr + dg * dg + db * db <= toleranceSq ) color = { r: 80, g: 255, b: 120 };

			}
			if ( ! color && hover ) {

				const dr = source.data[ i ] - hover.r;
				const dg = source.data[ i + 1 ] - hover.g;
				const db = source.data[ i + 2 ] - hover.b;
				if ( dr * dr + dg * dg + db * db <= toleranceSq ) color = { r: 255, g: 230, b: 60 };

			}
			if ( color ) {

				output[ i ] = Math.min( 255, Math.round( output[ i ] * 0.35 + color.r * 0.65 ) );
				output[ i + 1 ] = Math.min( 255, Math.round( output[ i + 1 ] * 0.35 + color.g * 0.65 ) );
				output[ i + 2 ] = Math.min( 255, Math.round( output[ i + 2 ] * 0.35 + color.b * 0.65 ) );
				matched = true;

			}

		}
		if ( ! matched ) return null;
		const canvas = document.createElement( 'canvas' );
		canvas.width = source.width;
		canvas.height = source.height;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.putImageData( new ImageData( output, source.width, source.height ), 0, 0 );
		const nextTexture = new THREE.CanvasTexture( canvas );
		nextTexture.colorSpace = texture.colorSpace;
		nextTexture.flipY = texture.flipY;
		nextTexture.wrapS = texture.wrapS;
		nextTexture.wrapT = texture.wrapT;
		nextTexture.repeat.copy( texture.repeat );
		nextTexture.offset.copy( texture.offset );
		nextTexture.rotation = texture.rotation;
		nextTexture.center.copy( texture.center );
		nextTexture.minFilter = texture.minFilter;
		nextTexture.magFilter = texture.magFilter;
		nextTexture.generateMipmaps = texture.generateMipmaps;
		nextTexture.anisotropy = texture.anisotropy;
		nextTexture.needsUpdate = true;
		return nextTexture;

	}


	function applyCarCustomizationToObject( root, carKey, highlightHex = '', previewUnlit = false, hoverHex = '', highlightTolerance = GARAGE_COLOR_PICK_TOLERANCE ) {

		if ( ! root ) return;
		const carData = getGarageCosmeticCar( carKey );
		const mappings = Array.isArray( carData?.mappings ) ? carData.mappings : [];
		const resolvedMappings = buildResolvedMappings( mappings );
		root.traverse( ( child ) => {

			if ( ! child.isMesh || ! child.material ) return;
			const incomingMaterials = Array.isArray( child.material ) ? child.material : [ child.material ];
			if ( ! child.userData.baseMaterial ) child.userData.baseMaterial = incomingMaterials.map( ( material ) => material.clone() );

			if ( Array.isArray( child.userData.customMaterial ) ) {

				child.userData.customMaterial.forEach( ( material, index ) => {

					if ( material?.map && material.map !== child.userData.baseMaterial?.[ index ]?.map ) material.map.dispose();
					material?.dispose?.();

				} );
				child.userData.customMaterial = null;

			}

			const builtMaterials = child.userData.baseMaterial.map( ( baseMaterial ) => {

				let material = baseMaterial.clone();
				if ( material.color ) {

					const baseRgb = hexToRgbBytes( `#${ baseMaterial.color.getHexString() }` );
					const mappedSolid = baseRgb ? pickMappedColor( baseRgb, resolvedMappings ) : null;
					if ( mappedSolid ) material.color.setRGB( mappedSolid.r / 255, mappedSolid.g / 255, mappedSolid.b / 255 );
					const baseHex = `#${ baseMaterial.color.getHexString() }`;
					const selectedSolid = /^#[0-9a-fA-F]{6}$/.test( highlightHex || '' ) && colorDistanceSqHex( baseHex, highlightHex ) <= highlightTolerance * highlightTolerance;
					const hoverSolid = ! selectedSolid && /^#[0-9a-fA-F]{6}$/.test( hoverHex || '' ) && colorDistanceSqHex( baseHex, hoverHex ) <= highlightTolerance * highlightTolerance;
					if ( selectedSolid || hoverSolid ) {

						if ( previewUnlit ) material.color.set( selectedSolid ? 0x50ff78 : 0xffe63c );
						else {

							if ( material.emissive ) material.emissive.set( selectedSolid ? 0x50ff78 : 0xffe63c );
							if ( typeof material.emissiveIntensity === 'number' ) material.emissiveIntensity = Math.max( material.emissiveIntensity || 0, 0.75 );

						}

					}
					if ( mappedSolid?.finish === 'shiny' ) {

						applyShinyFinish( material, mappedSolid );

					}

				}
				if ( material.map ) {

					const remapped = recolorTexture( material.map, resolvedMappings );
					material.map = createHighlightedTexture( baseMaterial.map, highlightHex, hoverHex, highlightTolerance ) || remapped.texture;
					if ( remapped.hasShiny ) {

						applyShinyFinish( material );

					}

				}
				if ( previewUnlit ) {

					const unlit = new THREE.MeshBasicMaterial( {
						color: material.color ? material.color.clone() : new THREE.Color( 0xffffff ),
						map: material.map || null,
						transparent: Boolean( material.transparent ),
						opacity: Number.isFinite( material.opacity ) ? material.opacity : 1,
						alphaTest: Number.isFinite( material.alphaTest ) ? material.alphaTest : 0,
						side: material.side,
					} );
					material.dispose?.();
					material = unlit;

				}
				material.needsUpdate = true;
				return material;

			} );
			child.userData.customMaterial = builtMaterials;
			child.material = Array.isArray( child.material ) ? builtMaterials : builtMaterials[ 0 ];

		} );

	}

	function applyCarCustomization( targetVehicle ) {

		if ( ! targetVehicle?.container ) return;
		applyCarCustomizationToObject( targetVehicle.container, currentCarKey() );

	}

	function campaignStageConfig( stage = 1 ) {

		const normalizedStage = Math.max( 1, Math.min( CAMPAIGN_STAGE_COUNT, Number( stage ) || 1 ) );
		return CAMPAIGN_STAGES[ normalizedStage - 1 ];

	}

	function saveCampaignState() {

		if ( ! campaignState ) return;
		localStorage.setItem( campaignStoreKey, JSON.stringify( campaignState ) );

	}

	function loadCampaignState() {

		try {

			const raw = localStorage.getItem( campaignStoreKey );
			const parsed = raw ? JSON.parse( raw ) : {};
			const urlStage = Number( new URLSearchParams( window.location.search ).get( 'campaignStage' ) );
			const baseStage = Number.isFinite( urlStage ) && urlStage > 0 ? urlStage : Number( parsed?.stage ) || 1;
			const stage = Math.max( 1, Math.min( CAMPAIGN_STAGE_COUNT, baseStage ) );
			const config = campaignStageConfig( stage );
			campaignState = {
				stage,
				stageType: config.type,
				goal: Number.isFinite( parsed?.goal ) ? parsed.goal : config.goal,
				progress: Number.isFinite( parsed?.progress ) ? Math.max( 0, parsed.progress ) : 0,
				completedRoadmaps: Number.isFinite( parsed?.completedRoadmaps ) ? Math.max( 0, parsed.completedRoadmaps ) : 0,
			};

		} catch ( e ) {

			const config = campaignStageConfig( 1 );
			campaignState = { stage: 1, stageType: config.type, goal: config.goal, progress: 0, completedRoadmaps: 0 };

		}

	}

	function updateCampaignUi() {

		if ( ! campaignProgressLabel || ! campaignState ) return;
		syncCampaignCountersFromStorage();
		const config = campaignStageConfig( campaignState.stage );
		const status = `${ campaignState.progress }/${ campaignState.goal }`;
		const target = campaignState.stageType === 'beat-authors' && Number.isFinite( campaignTargetAuthorSeconds )
			? ` • Target ${( campaignTargetAuthorSeconds ).toFixed( 2 )}s${ campaignTrackName ? ` (${ campaignTrackName })` : '' }`
			: '';
		campaignProgressLabel.textContent = `Campaign Stage ${ campaignState.stage}: ${ config.text } • ${ status }${ target }`;

	}

	function incrementCampaignProgress( stageType, amount = 1 ) {
	if ( ! campaignState || campaignState.stageType !== stageType ) return;
	campaignState.progress = Math.min( campaignState.goal, campaignState.progress + Math.max( 1, amount ) );
	saveCampaignState();
	if ( campaignState.progress >= campaignState.goal ) completeCampaignStage();
	updateCampaignUi();
}


	function syncCampaignCountersFromStorage() {
		const likes = Number( localStorage.getItem( 'racing-campaign-counter:like-tracks' ) || 0 );
		const published = Number( localStorage.getItem( 'racing-campaign-counter:publish-track' ) || 0 );
		const sharedOpens = Number( localStorage.getItem( 'racing-campaign-counter:play-share-open' ) || 0 );
		const editorPlayed = localStorage.getItem( 'racing-campaign-editor-played' ) === '1' ? 1 : 0;
		const modsInstalled = Number( localStorage.getItem( 'racing-mod-install-count' ) || 0 );
		if ( campaignState?.stageType === 'like-tracks' && likes > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, likes );
		if ( campaignState?.stageType === 'publish-track' && published > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, published );
		if ( campaignState?.stageType === 'install-mod' && modsInstalled > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, modsInstalled );
		if ( campaignState?.stageType === 'play-share' && sharedOpens > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, sharedOpens );
		if ( campaignState?.stageType === 'editor-play' && editorPlayed > campaignState.progress ) campaignState.progress = Math.min( campaignState.goal, editorPlayed );
	}
function completeCampaignStage() {

		if ( ! campaignState ) return;
		campaignState.stage ++;
		const next = campaignStageConfig( campaignState.stage );
		campaignState.stageType = next.type;
		campaignState.goal = next.goal;
		campaignState.progress = 0;
		if ( campaignState.stage > CAMPAIGN_STAGE_COUNT ) {

			campaignState.completedRoadmaps ++;
			campaignState.stage = 1;
			const loop = campaignStageConfig( 1 );
			campaignState.stageType = loop.type;
			campaignState.goal = loop.goal;

		}
		saveCampaignState();
		updateCampaignUi();

	}

	async function fetchCampaignTracks() {

	try {

			for ( const prefix of TRACK_SHARE_API_PREFIXES ) {

				const response = await fetch( `${ TRACK_SHARE_API_ROOT }${ prefix }/tracks` );
				if ( ! response.ok ) continue;
				const data = await response.json();
				return Array.isArray( data?.entries ) ? data.entries.filter( ( entry ) => Number.isFinite( Number( entry?.bestLapSeconds ) ) && typeof entry?.playUrl === 'string' ) : [];

			}
			return [];

		} catch ( e ) {

			return [];

		}

	}

	function buildCampaignUrl( baseUrl, entry ) {

		const url = new URL( baseUrl, window.location.href );
		url.searchParams.set( 'campaign', '1' );
		url.searchParams.set( 'campaignGoal', 'beat-authors' );
		url.searchParams.set( 'campaignAuthor', String( Number( entry.bestLapSeconds ) ) );
		url.searchParams.set( 'campaignTrackName', String( entry.name || 'Shared Track' ) );
		return url.toString();

	}

	async function startCampaignChallenge() {

		if ( ! campaignState ) return;
		const config = campaignStageConfig( campaignState.stage );
		campaignState.stageType = config.type;
		if ( config.type === 'beat-authors' ) {

			const pool = await fetchCampaignTracks();
			if ( pool.length === 0 ) {

				showModeError( 'Campaign requires shared tracks from /api/tracks.' );
				return;

			}
			const pick = pool[ Math.floor( Math.random() * pool.length ) ];
			if ( ! pick?.playUrl ) return;
			window.location.href = buildCampaignUrl( pick.playUrl, pick );
			return;

		}
		campaignTargetAuthorSeconds = null;
		campaignTrackName = 'Current track';
		updateCampaignUi();

	}

	function saveEconomy() {

		localStorage.setItem( economyStoreKey, JSON.stringify( { coins } ) );

	}

	function loadEconomy() {

		try {

			const raw = localStorage.getItem( economyStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			coins = Number.isFinite( parsed.coins ) ? parsed.coins : 0;

		} catch ( e ) {

			console.warn( 'Failed to load economy', e );

		}

	}

	function saveRecentGhostHistory() {

		try {

			localStorage.setItem( recentGhostStoreKey, JSON.stringify( recentGhostHistory.slice( 0, 12 ) ) );

		} catch ( e ) {

			console.warn( 'Failed to save recent ghosts', e );

		}

	}

	function loadRecentGhostHistory() {

		try {

			const raw = localStorage.getItem( recentGhostStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			if ( ! Array.isArray( parsed ) ) return;
			recentGhostHistory.length = 0;
			for ( const entry of parsed.slice( 0, 12 ) ) {

				const normalized = extractNormalizedGhostPayload( entry );
				if ( ! normalized ) continue;
				recentGhostHistory.push( {
					samples: normalized.samples,
					duration: normalized.duration,
					car: normalized.car || 'vehicle-truck-yellow',
					cosmetics: normalized.cosmetics || null,
					checkpointTimes: computeCheckpointCrossTimes( normalized.samples ),
				} );

			}

		} catch ( e ) {

			console.warn( 'Failed to load recent ghosts', e );

		}

	}

	function updateEconomyHud() {

		if ( coinsLabel ) coinsLabel.textContent = `🪙 ${ Math.floor( coins ).toLocaleString() }`;
		if ( accountCoinsValue ) accountCoinsValue.textContent = Math.floor( coins ).toLocaleString();
		updateGarageUi();

	}

	function rewardCoinsForLap( lapSecondsCompleted ) {

		if ( isSplitScreen ) return;
		const reward = Math.max( 20, Math.min( 50, Math.round( 50 - lapSecondsCompleted * 0.75 ) ) );
		coins += reward;
		saveEconomy();
		updateEconomyHud();

	}

	carSelect?.querySelectorAll( 'option' ).forEach( ( option ) => {

		const stats = CAR_STATS[ option.value ];
		if ( ! stats ) return;
		option.textContent = `${ stats.name }`;

	} );


	function pickRandomOwnedCarKey() {
		const available = Object.keys( CAR_STATS ).filter( ( key ) => models[ key ] );
		if ( available.length === 0 ) return currentCarKey();
		return available[ Math.floor( Math.random() * available.length ) ];
	}

	function randomizeLapCarIfSinglePlayer() {
		if ( isSplitScreen || ! carSelect ) return;
		const nextKey = pickRandomOwnedCarKey();
		if ( ! nextKey || ! CAR_STATS[ nextKey ] ) return;
		carSelect.value = nextKey;
		updateCarSelectColor();
		if ( models[ nextKey ] ) vehicle.setModel( models[ nextKey ] );
		applyCarCustomization( vehicle );
		applyVehiclePerformance();
	}
	const audio = new GameAudio();
	audio.init( cam.camera );

	const _forward = new THREE.Vector3();
	const _up = new THREE.Vector3( 0, 1, 0 );
	const _boostForward = new THREE.Vector3();
	const _magnetDelta = new THREE.Vector3();
	const _magnetDir = new THREE.Vector3();

	const contactListener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

			_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
			advancementEvents.emit('crash_happened', { impactVelocity });
			crashShakeStrength = Math.max( crashShakeStrength, THREE.MathUtils.clamp( ( impactVelocity - 1.1 ) * 0.12, 0, 0.16 ) );
			crashShakeTime = Math.max( crashShakeTime, THREE.MathUtils.clamp( impactVelocity * 0.03, 0.05, 0.18 ) );
			audio.playImpact( impactVelocity );
			dispatchRuntimeModEvent( 'onCrash', { type: 'crash', impactVelocity } );

		}
	};

	const timer = new THREE.Timer();
	let lastFrameNowMs = performance.now();
	let raceClockSeconds = 0;
	let paused = false;
	let currentLapInvalidatedByPause = false;
	let countdownActive = false;
	let countdownEndsAt = 0;
	let countdownEnabled = localStorage.getItem( COUNTDOWN_SETTINGS_KEY ) !== '0';
	let fpsHudVisible = localStorage.getItem( FPS_HUD_SETTINGS_KEY ) === '1';
	let rollingFps = 0;
	let fpsHudAccumulator = 0;
	const activeCells = customCells || TRACK_CELLS;
	const hasSeparateStartCell = activeCells.some( ( c ) => c[ 2 ] === 'track-start' );
	const hasSeparateFinishCell = activeCells.some( ( c ) => c[ 2 ] === 'track-finish' );
	const shouldAutoRespawnAfterLap = hasSeparateStartCell && hasSeparateFinishCell;
	const startCell = activeCells.find( ( c ) => c[ 2 ] === 'track-start' ) || activeCells.find( ( c ) => c[ 2 ] === 'track-start-finish' ) || null;
	const finishCell = activeCells.find( ( c ) => c[ 2 ] === 'track-finish' ) || activeCells.find( ( c ) => c[ 2 ] === 'track-start-finish' ) || activeCells[ 0 ];
	const elevatedCheckpointCells = Array.isArray( extras?.elevated )
		? extras.elevated
			.filter( ( c ) => Array.isArray( c ) && c[ 2 ] === 'elevated-checkpoint' )
			.map( ( [ gx, gz, , orient = 0 ] ) => [ gx, gz, 'track-checkpoint', orient ] )
		: [];
	const checkpointCells = [ ...activeCells.filter( ( c ) => c[ 2 ] === 'track-checkpoint' ), ...elevatedCheckpointCells ];
	const slopeElevatedCells = Array.isArray( extras?.elevated )
		? extras.elevated.filter( ( c ) => Array.isArray( c ) && ( c[ 2 ] === 'slope-up' || c[ 2 ] === 'slope-down' ) )
		: [];
	const lapStoreKey = `racing-lap-stats:${ mapParam || 'default' }`;
	const stuntStoreKey = `racing-stunt-stats:${ mapParam || 'default' }`;
	const currentTrackUrl = `${ window.location.origin }${ window.location.pathname }${ window.location.search }`;
	const leaderboardTrackId = getTrackId( mapParam, extrasParam );
	const recentGhostStoreKey = `racing-recent-ghosts:${ leaderboardTrackId }`;
	const leaderboardLegacyTrackIds = getLegacyTrackIds( mapParam, extrasParam );
	const leaderboardTrackName = getTrackLabel( mapParam );
	const leaderboardTrackApiUrl = `${ LEADERBOARD_API_BASE }?trackId=${ encodeURIComponent( leaderboardTrackId ) }`;

	const competitionParamEnabled = new URLSearchParams( window.location.search ).get( 'competition' ) === '1';
	const competitionReturnParam = new URLSearchParams( window.location.search ).get( 'competitionReturn' ) || '';
	const competitionTierParam = Number( new URLSearchParams( window.location.search ).get( 'competitionTier' ) );
	const competitionSeedParam = String( new URLSearchParams( window.location.search ).get( 'competitionSeed' ) || '' );
	const campaignParamEnabled = new URLSearchParams( window.location.search ).get( 'campaign' ) === '1';
	const campaignAuthorParam = Number( new URLSearchParams( window.location.search ).get( 'campaignAuthor' ) );
	const campaignGoalParam = new URLSearchParams( window.location.search ).get( 'campaignGoal' ) || '';
	campaignTrackName = new URLSearchParams( window.location.search ).get( 'campaignTrackName' ) || '';
	if ( campaignParamEnabled && campaignGoalParam === 'beat-authors' && Number.isFinite( campaignAuthorParam ) ) {

		campaignTargetAuthorSeconds = campaignAuthorParam;

	}

	function encodeBase64UrlJson( value ) {

		return btoa( unescape( encodeURIComponent( JSON.stringify( value ) ) ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );

	}

	function decodeBase64UrlJson( value ) {

		const normalized = value.replace( /-/g, '+' ).replace( /_/g, '/' );
		const padLen = ( 4 - normalized.length % 4 ) % 4;
		const padded = normalized + '='.repeat( padLen );
		return JSON.parse( decodeURIComponent( escape( atob( padded ) ) ) );

	}

	function getCurrentProfileSnapshot() {

		return {
			v: 2,
			playerName: sanitizePlayerName( playerNameInput?.value || '' ),
			economy: { coins },
			garage: { mods: garageMods, unlocked: garageUnlocked, cosmetics: garageCosmetics },
			campaign: campaignState,
			carKey: currentCarKey(),
		};

	}

	function setAccountStatus( message, isError = false ) {

		if ( ! accountStatus ) return;
		accountStatus.textContent = message || '';
		accountStatus.style.color = isError ? '#ff9ea2' : '#bde6ff';

	}

	function updateAccountUi() {

		if ( accountUsernameInput && accountSession?.username ) accountUsernameInput.value = accountSession.username;
		setAccountStatus( accountSession?.token ? `Signed in as ${ accountSession.username }` : 'Not signed in' );
		if ( accountCloudSaveBtn ) accountCloudSaveBtn.disabled = ! accountSession?.token;
		if ( accountCloudLoadBtn ) accountCloudLoadBtn.disabled = ! accountSession?.token;

	}

	async function accountApiRequest( path, options = {} ) {

		const response = await fetch( `${ ACCOUNT_API_BASE }${ path }`, {
			headers: { 'Content-Type': 'application/json', ...( options.headers || {} ) },
			...options,
		} );
		const payload = await response.json().catch( () => ( {} ) );
		if ( ! response.ok || payload?.ok === false ) {

			throw new Error( payload?.error || `Account API HTTP ${ response.status }` );

		}
		return payload;

	}

	function createProfileExportCode() {

		return encodeBase64UrlJson( getCurrentProfileSnapshot() );

	}

	function applyImportedProfile( code ) {

		const parsed = decodeBase64UrlJson( code );
		if ( ! parsed || typeof parsed !== 'object' ) return false;
		if ( parsed?.playerName && playerNameInput ) {

			const importedName = sanitizePlayerName( parsed.playerName );
			playerNameInput.value = importedName;
			if ( namePopupInput ) namePopupInput.value = importedName;
			localStorage.setItem( PLAYER_NAME_KEY, importedName );

		}
		const nextCoins = Number( parsed?.economy?.coins );
		coins = Number.isFinite( nextCoins ) ? Math.max( 0, Math.floor( nextCoins ) ) : coins;
		garageMods = { grip: GARAGE_FIXED_MULTIPLIER, accel: GARAGE_FIXED_MULTIPLIER, drive: GARAGE_FIXED_MULTIPLIER };
		garageUnlocked = { grip: true, accel: true, drive: true };
		garageCosmetics = normalizeGarageCosmetics( parsed?.garage?.cosmetics );
		if ( parsed?.campaign && typeof parsed.campaign === 'object' ) {

			const stage = Math.max( 1, Number( parsed.campaign.stage ) || 1 );
			const stageCfg = campaignStageConfig( stage );
			campaignState = {
				stage,
				stageType: stageCfg.type,
				goal: Number.isFinite( parsed.campaign.goal ) ? parsed.campaign.goal : stageCfg.goal,
				progress: Number.isFinite( parsed.campaign.progress ) ? Math.max( 0, parsed.campaign.progress ) : 0,
				completedRoadmaps: Number.isFinite( parsed.campaign.completedRoadmaps ) ? Math.max( 0, parsed.campaign.completedRoadmaps ) : 0,
			};

		}
		if ( typeof parsed?.carKey === 'string' && carSelect && CAR_STATS[ parsed.carKey ] ) {

			carSelect.value = parsed.carKey;
			updateCarSelectColor();
			if ( garageCarSelect ) garageCarSelect.value = parsed.carKey;
			if ( models[ parsed.carKey ] ) {

				vehicle.setModel( models[ parsed.carKey ] );
				applyCarCustomization( vehicle );

			}

		}
		saveEconomy();
		saveGarageMods();
		saveCampaignState();
		applyVehiclePerformance();
		updateEconomyHud();
		updateGarageUi();
		applyCarCustomization( vehicle );
		updateCampaignUi();
		return true;

	}

	function createAccountExportCode() {

		return encodeBase64UrlJson( {
			v: 1,
			session: accountSession ? { username: accountSession.username, token: accountSession.token } : null,
			profile: getCurrentProfileSnapshot(),
		} );

	}

	function applyImportedAccountCode( code ) {

		const parsed = decodeBase64UrlJson( code );
		if ( ! parsed || typeof parsed !== 'object' ) return false;
		if ( parsed?.profile ) {

			applyImportedProfile( encodeBase64UrlJson( parsed.profile ) );

		}
		if ( parsed?.session?.token && parsed?.session?.username ) {

			accountSession = {
				username: String( parsed.session.username ),
				token: String( parsed.session.token ),
			};
			localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );

		}
		updateAccountUi();
		return true;

	}

	function makeGateData( cell ) {

		if ( ! cell ) return null;

		const [ gx, gz, , orient ] = cell;
		const centerX = ( gx + 0.5 ) * CELL_RAW * GRID_SCALE;
		const centerZ = ( gz + 0.5 ) * CELL_RAW * GRID_SCALE;
		const halfExtent = ( CELL_RAW * GRID_SCALE ) * 0.5;
		const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
		const cosA = Math.cos( angle );
		const sinA = Math.sin( angle );
		return { centerX, centerZ, halfExtent, angle, cosA, sinA };

	}

	const finishData = makeGateData( finishCell );
	const startGateData = makeGateData( startCell || finishCell );
	const checkpointStates = checkpointCells.map( ( cell ) => ( {
		...makeGateData( cell ),
		lastLocalX: 0,
		lastLocalZ: 0,
		hasPrevSample: false,
		passedThisLap: false,
	} ) );

	let lapNumber = 1;
	let lapStartSeconds = 0;
	let lapSeconds = 0;
	let lastLapSeconds = null;
	let bestLapSeconds = null;
	let checkpointDeltaText = '';
	let lastSyncedOnlineBestLapSeconds = null;
	let autoRespawnTimerId = null;
	let hasPrevFinishSample = false;
	let lastLocalX = 0;
	let lastLocalZ = 0;
	let hasLeftStartZone = false;
	let boostActiveUntil = 0;
	let boostContactCell = null;
	let arcLinkState = { contactKey: null, lockUntilExit: false };
	const specialSurfaceContactState = new Map();
	const boostCells = Array.isArray( extras?.boosts ) ? extras.boosts : [];
	const surfaceCells = Array.isArray( extras?.surfaces ) ? extras.surfaces : [];
	const customSurfaceConfigs = extras?.customSurfaces && typeof extras.customSurfaces === 'object' ? extras.customSurfaces : {};
	const customPadConfigs = extras?.customPads && typeof extras.customPads === 'object' ? extras.customPads : {};
	const surfaceCellMap = new Map();
	for ( const [ gx, gz, type ] of surfaceCells ) {

		const key = `${ gx },${ gz }`;
		const list = surfaceCellMap.get( key ) || [];
		list.push( type );
		surfaceCellMap.set( key, list );

	}
	const surfaceHalfExtent = CELL_RAW * GRID_SCALE * 0.39;
	const cellWorldSize = CELL_RAW * GRID_SCALE;
	const cellHalfExtent = cellWorldSize * 0.5;
	const slopeCellMap = new Map();
	const SLOPE_CONFORM_ANGLE = Math.atan2( CELL_RAW * 0.5, CELL_RAW );
	const ORIENT_180 = { 0: 10, 10: 0, 16: 22, 22: 16 };
	for ( const [ gx, gz, rawType, rawOrient = 0 ] of slopeElevatedCells ) {

		if ( ! Number.isFinite( Number( gx ) ) || ! Number.isFinite( Number( gz ) ) ) continue;
		let type = rawType;
		let orient = rawOrient;
		if ( type === 'slope-down' ) {

			type = 'slope-up';
			orient = ORIENT_180[ orient ] ?? orient;

		}
		slopeCellMap.set( `${ gx },${ gz }`, { gx, gz, type, orient } );

	}
	const legacyBoostHalfExtent = CELL_RAW * GRID_SCALE * 0.5;
	const surfaceEntries = surfaceCells.map( ( [ gx, gz, type ] ) => ( {
		gx, gz, type,
		centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
		centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
	} ) );
	const padEntries = surfaceEntries.filter( ( entry ) => entry.type === PAD_RESET_TYPE || PAD_EFFECTS[ entry.type ] || CUSTOM_PAD_TYPES.includes( entry.type ) );
	const legacyBoostEntries = boostCells.map( ( [ gx, gz ] ) => ( {
		gx, gz,
		centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
		centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
	} ) );
	const magnetCells = Array.isArray( extras?.magnets ) ? extras.magnets : [];
	const arcLinkCells = Array.isArray( extras?.arcLinks ) ? extras.arcLinks : [];
	const magnetFullStrengthDistance = CELL_RAW * GRID_SCALE * MAGNET_FULL_STRENGTH_BLOCKS;
	const magnetEntries = magnetCells
		.map( ( [ gxRaw, gzRaw, yGridRaw, variant, forceRaw, rangeRaw ] ) => {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) return null;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const kindRaw = String( variant );
			const kind = kindRaw === 'red' ? 'red' : ( kindRaw === 'grapple' ? 'grapple' : 'blue' );
			const forcePerSecond = THREE.MathUtils.clamp( Number( forceRaw ) || MAGNET_DEFAULT_FORCE_PER_SECOND, MAGNET_MIN_FORCE_PER_SECOND, MAGNET_MAX_FORCE_PER_SECOND );
			const maxDistanceBlocks = THREE.MathUtils.clamp( Number( rangeRaw ) || MAGNET_DEFAULT_MAX_DISTANCE_BLOCKS, MAGNET_MIN_MAX_DISTANCE_BLOCKS, MAGNET_MAX_MAX_DISTANCE_BLOCKS );
			const maxDistance = CELL_RAW * GRID_SCALE * maxDistanceBlocks;
			return {
				gx, gz, yGrid, kind, forcePerSecond, maxDistance,
				centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
				centerY: ( CELL_RAW * GRID_SCALE * 0.08 ) - 0.06 + yGrid * CELL_RAW * GRID_SCALE,
				centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
			};

		} )
		.filter( Boolean );

	const grappleEntries = magnetEntries.filter( ( entry ) => entry.kind === 'grapple' );
	const grappleState = {
		active: false,
		anchor: null,
		ropeLength: 0,
		line: null,
	};
	const arcLinkEntries = arcLinkCells
		.map( ( [ gxRaw, gzRaw, yGridRaw, variantRaw, idRaw ] ) => {

			const gx = Number( gxRaw );
			const gz = Number( gzRaw );
			if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) return null;
			const yGrid = THREE.MathUtils.clamp( Number( yGridRaw ) || 0, - 1, 3 );
			const variant = String( variantRaw );
			const color = variant === 'portal-purple' || variant === 'purple'
				? 'portal-purple'
				: ( variant === 'portal-yellow' || variant === 'yellow'
					? 'portal-yellow'
					: ( variant === 'orange' ? 'orange' : 'green' ) );
			const linkId = THREE.MathUtils.clamp( Math.round( Number( idRaw ) || 1 ), 1, 999 );
			return {
				gx, gz, yGrid, color, linkId,
				centerX: ( gx + 0.5 ) * CELL_RAW * GRID_SCALE,
				centerY: ( CELL_RAW * GRID_SCALE * 0.08 ) - 0.06 + yGrid * CELL_RAW * GRID_SCALE,
				centerZ: ( gz + 0.5 ) * CELL_RAW * GRID_SCALE,
			};

		} )
		.filter( Boolean );
	const arcEntriesById = new Map();
	for ( const entry of arcLinkEntries ) {

		const bucket = arcEntriesById.get( entry.linkId ) || [];
		bucket.push( entry );
		arcEntriesById.set( entry.linkId, bucket );

	}
	if ( arcLinkEntries.length > 0 ) setArcLinkHud( `Arc Link: ready (${ arcEntriesById.size } id${ arcEntriesById.size === 1 ? '' : 's' })` );
	else setArcLinkHud( null );
	let activeSurfaceType = null;
	let activeSurfaceType2 = null;
	let lastSurfaceNotifyType = null;
	let lastSurfaceNotifyType2 = null;
	let lapNumber2 = 1;
	let lapStartSeconds2 = 0;
	let lapSeconds2 = 0;
	let lastLapSeconds2 = null;
	let bestLapSeconds2 = null;
	let autoRespawnTimerId2 = null;
	let hasPrevFinishSample2 = false;
	let lastLocalX2 = 0;
	let lastLocalZ2 = 0;
	let hasLeftStartZone2 = false;
	let boostActiveUntil2 = 0;
	let boostContactCell2 = null;
	let arcLinkState2 = { contactKey: null, lockUntilExit: false };
	let lastBoostNotifyKey = null;
	let lastBoostNotifyKey2 = null;
	const specialSurfaceContactState2 = new Map();
	let activePadEffect = null;
	let activePadEffect2 = null;
	let activePadTimeScale = 1;
	let activePadTimeScale2 = 1;
	let padContactKey = null;
	let padContactKey2 = null;
	const airTrickState = { active: false, progress: 0, lastSmoothT: 0, pitchTotal: 0, yawTotal: 0, rollTotal: 0, baseYaw: 0, recovering: false, recoveryT: 0, recoveryDuration: 0.42, recoveryStartQuat: new THREE.Quaternion(), recoveryTargetQuat: new THREE.Quaternion() };
	const airTrickState2 = { active: false, progress: 0, lastSmoothT: 0, pitchTotal: 0, yawTotal: 0, rollTotal: 0, baseYaw: 0, recovering: false, recoveryT: 0, recoveryDuration: 0.42, recoveryStartQuat: new THREE.Quaternion(), recoveryTargetQuat: new THREE.Quaternion() };
	const camYawLockQuat = new THREE.Quaternion();
	const camYawLockQuat2 = new THREE.Quaternion();
	const camYawLockEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
	const camYawLockEuler2 = new THREE.Euler( 0, 0, 0, 'YXZ' );
	let camYawLockActive = false;
	let camYawLockActive2 = false;
	let camYawLockValue = 0;
	let camYawLockValue2 = 0;
	const checkpointStates2 = checkpointCells.map( ( cell ) => ( {
		...makeGateData( cell ),
		lastLocalX: 0,
		lastLocalZ: 0,
		hasPrevSample: false,
		passedThisLap: false,
	} ) );
	const INTENSITY_SCALE = { low: 0.6, medium: 1.0, high: 1.45 };
	const WEATHER_FX_DENSITY_MULTIPLIER = 3;
	const WIND_SPEED = { none: 0, breezy: 2.0, gusty: 4.5 };
	let weatherFx = null;
	let lightningCooldown = THREE.MathUtils.randFloat( 2.2, 6.2 );
	let lightningFlashTime = 0;
	let lightningFlashDuration = 0.12;
	let lightningFlashStrength = 0;

	function clearWeatherFx() {

		if ( ! weatherFx ) return;
		if ( weatherFx.points ) scene.remove( weatherFx.points );
		weatherFx = null;

	}

	function setupWeatherFx( centerX = 0, centerZ = 0 ) {

		clearWeatherFx();
		const precip = weatherSettings.precipitation;
		if ( precip === 'none' ) return;
		const particleScale = getGraphicsPreset().weatherParticleScale;
		if ( particleScale <= 0 ) return;
		const count = Math.round( ( precip === 'rain' ? 940 : 380 ) * WEATHER_FX_DENSITY_MULTIPLIER * ( INTENSITY_SCALE[ weatherSettings.intensity ] || 1 ) * particleScale );
		const positions = new Float32Array( count * 3 );
		const speeds = new Float32Array( count );
		const spread = 65;
		for ( let i = 0; i < count; i ++ ) {

			const index = i * 3;
			positions[ index ] = centerX + THREE.MathUtils.randFloatSpread( spread );
			positions[ index + 1 ] = THREE.MathUtils.randFloat( 3, 30 );
			positions[ index + 2 ] = centerZ + THREE.MathUtils.randFloatSpread( spread );
			speeds[ i ] = precip === 'rain'
				? THREE.MathUtils.randFloat( 18, 32 )
				: THREE.MathUtils.randFloat( 2.2, 5.1 );

		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		const material = new THREE.PointsMaterial( {
			color: precip === 'rain' ? 0x77b8ff : 0xffffff,
			size: precip === 'rain' ? 0.06 : 0.13,
			transparent: true,
			opacity: precip === 'rain' ? 0.5 : 0.75,
			depthWrite: false,
		} );
		weatherFx = {
			kind: precip,
			points: new THREE.Points( geometry, material ),
			positions,
			speeds,
			count,
		};
		scene.add( weatherFx.points );

	}

	function updateWeatherFx( dt, now = timer.getElapsed() ) {

		const wind = WIND_SPEED[ weatherSettings.wind ] || 0;
		const centerX = vehicle.spherePos.x;
		const centerZ = vehicle.spherePos.z;
		if ( weatherFx?.positions ) {

			const positions = weatherFx.positions;
			const sway = weatherFx.kind === 'snow' ? 0.6 : 0.15;
			for ( let i = 0; i < weatherFx.count; i ++ ) {

				const p = i * 3;
				const fallSpeed = weatherFx.speeds[ i ];
				positions[ p + 1 ] -= fallSpeed * dt;
				positions[ p ] += ( wind + Math.sin( now * 0.8 + i ) * sway ) * dt;
				if ( positions[ p + 1 ] < 0.2 ) {

					positions[ p ] = centerX + THREE.MathUtils.randFloatSpread( 65 );
					positions[ p + 1 ] = THREE.MathUtils.randFloat( 16, 34 );
					positions[ p + 2 ] = centerZ + THREE.MathUtils.randFloatSpread( 65 );

				} else if ( Math.abs( positions[ p ] - centerX ) > 55 || Math.abs( positions[ p + 2 ] - centerZ ) > 55 ) {

					positions[ p ] = centerX + THREE.MathUtils.randFloatSpread( 52 );
					positions[ p + 2 ] = centerZ + THREE.MathUtils.randFloatSpread( 52 );

				}

			}
			weatherFx.points.geometry.attributes.position.needsUpdate = true;

		}

		if ( weatherSettings.lightning && getGraphicsPreset().weatherParticleScale > 0 ) {

			if ( lightningFlashTime > 0 ) {

				lightningFlashTime = Math.max( 0, lightningFlashTime - dt );
				const pulse = lightningFlashTime / Math.max( 1e-4, lightningFlashDuration );
				dirLight.intensity = baseWeatherLight.sun + lightningFlashStrength * pulse;
				hemiLight.intensity = baseWeatherLight.hemi + lightningFlashStrength * 0.22 * pulse;
				renderer.toneMappingExposure = baseWeatherLight.exposure + lightningFlashStrength * 0.08 * pulse;

			} else {

				lightningCooldown -= dt;
				dirLight.intensity = baseWeatherLight.sun;
				hemiLight.intensity = baseWeatherLight.hemi;
				renderer.toneMappingExposure = baseWeatherLight.exposure;
				if ( lightningCooldown <= 0 ) {

					lightningFlashDuration = THREE.MathUtils.randFloat( 0.07, 0.2 );
					lightningFlashTime = lightningFlashDuration;
					lightningFlashStrength = THREE.MathUtils.randFloat( 3.6, 7.2 );
					lightningCooldown = THREE.MathUtils.randFloat( 2.6, 8.5 );

				}

			}

		} else {

			dirLight.intensity = baseWeatherLight.sun;
			hemiLight.intensity = baseWeatherLight.hemi;
			renderer.toneMappingExposure = baseWeatherLight.exposure;

		}

	}

	setupWeatherFx( vehicle.spherePos.x, vehicle.spherePos.z );
	updateGraphicsQualityUi();

	function overlapsSurfaceEntry( targetVehicle, entry, halfExtent = surfaceHalfExtent ) {

		const dx = Math.abs( targetVehicle.spherePos.x - entry.centerX );
		const dz = Math.abs( targetVehicle.spherePos.z - entry.centerZ );
		return dx <= halfExtent + VEHICLE_SURFACE_RADIUS && dz <= halfExtent + VEHICLE_SURFACE_RADIUS;

	}

	const _slopeForward = new THREE.Vector3();
	const _slopeUp = new THREE.Vector3();
	const _slopeCarForward = new THREE.Vector3();
	const _slopeLocalUp = new THREE.Vector3();
	const _slopeYawOnlyQuat = new THREE.Quaternion();
	function applySlopeConformVisual( targetVehicle ) {

		if ( ! targetVehicle?.container ) return;
		const gx = Math.floor( targetVehicle.spherePos.x / cellWorldSize );
		const gz = Math.floor( targetVehicle.spherePos.z / cellWorldSize );
		const slopeCell = slopeCellMap.get( `${ gx },${ gz }` );
		if ( ! slopeCell ) {

			targetVehicle.setSlopeVisualTilt( 0, 0 );
			return;

		}

		const centerX = ( slopeCell.gx + 0.5 ) * cellWorldSize;
		const centerZ = ( slopeCell.gz + 0.5 ) * cellWorldSize;
		if ( Math.abs( targetVehicle.spherePos.x - centerX ) > cellHalfExtent || Math.abs( targetVehicle.spherePos.z - centerZ ) > cellHalfExtent ) {

			targetVehicle.setSlopeVisualTilt( 0, 0 );
			return;

		}

		const yaw = THREE.MathUtils.degToRad( ORIENT_DEG[ slopeCell.orient ] || 0 );
		_slopeForward.set( 0, 0, 1 ).applyAxisAngle( _up, yaw ).normalize();
		_slopeUp.copy( _up ).addScaledVector( _slopeForward, - Math.tan( SLOPE_CONFORM_ANGLE ) ).normalize();
		_slopeCarForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion ).setY( 0 ).normalize();
		if ( _slopeCarForward.lengthSq() < 1e-6 ) _slopeCarForward.set( 0, 0, 1 );
		const headingYaw = Math.atan2( _slopeCarForward.x, _slopeCarForward.z );
		_slopeYawOnlyQuat.setFromAxisAngle( _up, - headingYaw );
		_slopeLocalUp.copy( _slopeUp ).applyQuaternion( _slopeYawOnlyQuat ).normalize();
		const pitch = THREE.MathUtils.clamp( Math.atan2( - _slopeLocalUp.z, _slopeLocalUp.y ), - SLOPE_CONFORM_ANGLE, SLOPE_CONFORM_ANGLE );
		const roll = THREE.MathUtils.clamp( Math.atan2( _slopeLocalUp.x, _slopeLocalUp.y ), - SLOPE_CONFORM_ANGLE, SLOPE_CONFORM_ANGLE );
		targetVehicle.setSlopeVisualTilt( pitch, roll );

	}

	function overlapsPadEntry( targetVehicle, entry ) {

		const dx = targetVehicle.spherePos.x - entry.centerX;
		const dz = targetVehicle.spherePos.z - entry.centerZ;
		const padRadius = surfaceHalfExtent;
		const radius = padRadius + VEHICLE_SURFACE_RADIUS;
		return dx * dx + dz * dz <= radius * radius;

	}

	function findActiveSurfaceTypeFor( targetVehicle ) {

		for ( let i = surfaceEntries.length - 1; i >= 0; i -- ) {

			const entry = surfaceEntries[ i ];
			if ( overlapsSurfaceEntry( targetVehicle, entry ) ) return entry.type;

		}

		return null;

	}

	function findBoostSurfaceContactKeyFor( targetVehicle ) {

		for ( let i = surfaceEntries.length - 1; i >= 0; i -- ) {

			const entry = surfaceEntries[ i ];
			if ( entry.type === 'surface-boost' && overlapsSurfaceEntry( targetVehicle, entry ) ) return `surface:${ entry.gx },${ entry.gz }`;

		}

		return null;

	}

	function findSurfaceContactKeyForType( targetVehicle, surfaceType ) {

		for ( let i = surfaceEntries.length - 1; i >= 0; i -- ) {

			const entry = surfaceEntries[ i ];
			if ( entry.type === surfaceType && overlapsSurfaceEntry( targetVehicle, entry ) ) return `surface:${ entry.gx },${ entry.gz }`;

		}

		return null;

	}

	function findLegacyBoostContactKeyFor( targetVehicle ) {

		for ( const entry of legacyBoostEntries ) {

			if ( overlapsSurfaceEntry( targetVehicle, entry, legacyBoostHalfExtent ) ) return `boost:${ entry.gx },${ entry.gz }`;

		}

		return null;

	}

	function findPadContactFor( targetVehicle ) {

		for ( let i = padEntries.length - 1; i >= 0; i -- ) {

			const entry = padEntries[ i ];
			if ( overlapsPadEntry( targetVehicle, entry ) ) {

				return {
					key: `pad:${ entry.gx },${ entry.gz },${ entry.type }`,
					type: entry.type,
				};

			}

		}
		return null;

	}

	function getPadLabel( padType ) {

		switch ( padType ) {

			case PAD_RESET_TYPE: return 'Pad Reset';
			case 'pad-low-gravity': return 'Low Gravity';
			case 'pad-heavy-gravity': return 'Heavy Gravity';
			case 'pad-high-grip': return 'High Grip';
			case 'pad-high-speed': return 'High Speed';
			case 'pad-no-brakes': return 'No Brakes';
			case 'pad-no-steering': return 'No Steering';
			case 'pad-no-acceleration': return 'No Acceleration';
			case 'pad-slow-motion': return 'Slow Motion';
			case 'pad-fast-motion': return 'Fast Motion';
			case 'pad-drift': return 'Drift Mode';
			case 'pad-size-small': return 'Mini Pad';
			case 'pad-size-normal': return 'Normal Pad';
			case 'pad-size-mega': return 'Mega Pad';
			case 'pad-trick-yaw-1': return 'Yaw Flip ×1';
			case 'pad-trick-pitch-1': return 'Pitch Flip ×1';
			case 'pad-trick-roll-1': return 'Roll Flip ×1';
			case 'pad-trick-yaw-pitch-1': return 'Yaw+Pitch ×1';
			case 'pad-trick-yaw-roll-1': return 'Yaw+Roll ×1';
			case 'pad-trick-pitch-roll-1': return 'Pitch+Roll ×1';
			case 'pad-trick-yaw-pitch-roll-1': return 'Yaw+Pitch+Roll ×1';
			case 'pad-trick-yaw-roll-pitch': return 'Yaw+Roll+Pitch';
			case 'pad-trick-pitch-yaw-roll': return 'Pitch+Yaw+Roll';
			case 'pad-custom-a': return 'Custom Pad A';
			case 'pad-custom-b': return 'Custom Pad B';
			case 'pad-custom-c': return 'Custom Pad C';
			default: return 'Pad';

		}

	}

	function showEffectPopup( text ) {

		if ( ! effectMessage ) {

			showTopMessage( text, false, 1000 );
			return;

		}
		effectMessage.textContent = String( text || '' ).trim();
		effectMessage.classList.add( 'show' );
		if ( effectMessageTimeout ) clearTimeout( effectMessageTimeout );
		effectMessageTimeout = setTimeout( () => {

			effectMessage.classList.remove( 'show' );

		}, 1000 );

	}

	function getCustomPadEffect( padType ) {

		const conf = customPadConfigs?.[ padType ];
		if ( ! conf ) return null;
		return {
			id: padType,
			gravity: Number.isFinite( Number( conf.gravity ) ) ? THREE.MathUtils.clamp( Number( conf.gravity ), 0.15, 3 ) : undefined,
			grip: Number.isFinite( Number( conf.grip ) ) ? THREE.MathUtils.clamp( Number( conf.grip ), 0.05, 5 ) : undefined,
			drag: Number.isFinite( Number( conf.drag ) ) ? THREE.MathUtils.clamp( Number( conf.drag ), 0.05, 5 ) : undefined,
			accel: Number.isFinite( Number( conf.accel ) ) ? THREE.MathUtils.clamp( Number( conf.accel ), 0, 5 ) : undefined,
			drive: Number.isFinite( Number( conf.drive ) ) ? THREE.MathUtils.clamp( Number( conf.drive ), 0, 5 ) : undefined,
			topSpeed: Number.isFinite( Number( conf.topSpeed ) ) ? THREE.MathUtils.clamp( Number( conf.topSpeed ), 0, 3 ) : undefined,
			steering: Number.isFinite( Number( conf.steering ) ) ? THREE.MathUtils.clamp( Number( conf.steering ), 0, 3 ) : undefined,
			timeScale: Number.isFinite( Number( conf.timeScale ) ) ? THREE.MathUtils.clamp( Number( conf.timeScale ), 0.15, 3 ) : undefined,
			disableBrakes: Boolean( conf.disableBrakes ),
			disableSteering: Boolean( conf.disableSteering ),
			disableAcceleration: Boolean( conf.disableAcceleration ),
		};

	}

	function getPadEffectForType( padType ) {

		return getCustomPadEffect( padType ) || PAD_EFFECTS[ padType ] || null;

	}

	function combinePadEffects( current, incoming ) {

		if ( ! current ) return incoming ? { ...incoming } : null;
		if ( ! incoming ) return { ...current };
		const combined = { ...current, ...incoming };
		const multiplicativeKeys = [ 'gravity', 'grip', 'drag', 'accel', 'drive', 'topSpeed', 'steering', 'timeScale', 'scale' ];
		for ( const key of multiplicativeKeys ) {

			const a = Number( current[ key ] );
			const b = Number( incoming[ key ] );
			if ( Number.isFinite( a ) && Number.isFinite( b ) ) combined[ key ] = a * b;
			else if ( Number.isFinite( b ) ) combined[ key ] = b;
			else if ( Number.isFinite( a ) ) combined[ key ] = a;

		}
		combined.disableBrakes = Boolean( current.disableBrakes || incoming.disableBrakes );
		combined.disableSteering = Boolean( current.disableSteering || incoming.disableSteering );
		combined.disableAcceleration = Boolean( current.disableAcceleration || incoming.disableAcceleration );
		if ( incoming.trick ) combined.trick = incoming.trick;
		return combined;

	}


	function applySizePadEffect( current, incoming ) {

		const base = current ? { ...current } : {};
		delete base.scale;
		delete base.__sizePadType;
		const next = incoming ? { ...base, ...incoming } : base;
		next.__sizePadType = incoming?.id || null;
		return Object.keys( next ).length ? next : null;

	}

	function applyPadContact( targetVehicle, lastContactKey, setEffect, getCurrentEffect = null ) {

		const contact = findPadContactFor( targetVehicle );
		if ( ! contact ) return null;
		if ( contact.key === lastContactKey ) return lastContactKey;
		if ( contact.type === PAD_RESET_TYPE ) {

			setEffect( null );
			showEffectPopup( 'Effect applied: Reset to default' );
			return contact.key;

		}
		const effect = getPadEffectForType( contact.type );
		const previous = getCurrentEffect ? ( getCurrentEffect() || null ) : null;
		if ( SIZE_PAD_TYPES.has( contact.type ) ) setEffect( applySizePadEffect( previous, effect ) );
		else setEffect( combinePadEffects( previous, effect ) );
		showEffectPopup( `Effect applied: ${ getPadLabel( contact.type ) }` );
		return contact.key;

	}


	function applyVehicleScaleFromPad( targetVehicle, effect, targetHitboxMesh = null ) {

		if ( ! targetVehicle?.container ) return;
		const nextScale = Number.isFinite( effect?.scale ) ? THREE.MathUtils.clamp( effect.scale, 0.35, 2.5 ) : 1;
		const prevScale = Number.isFinite( targetVehicle.__padScale ) ? targetVehicle.__padScale : 1;
		targetVehicle.container.scale.setScalar( nextScale );
		targetVehicle.__padScale = nextScale;
		if ( targetHitboxMesh ) targetHitboxMesh.scale.setScalar( nextScale );
		if ( nextScale > prevScale && nextScale > 1.01 && targetVehicle?.spherePos && targetVehicle?.rigidBody ) {

			const lift = 0.24 * ( nextScale - prevScale );
			targetVehicle.spherePos.y += lift;
			rigidBody.setPosition( targetVehicle.physicsWorld, targetVehicle.rigidBody, targetVehicle.spherePos.toArray(), false );

		}

	}

	function applyPadInputModifiers( baseInput, effect ) {

		if ( ! baseInput ) return baseInput;
		const input = { ...baseInput };
		if ( effect?.disableSteering ) input.x = 0;
		if ( effect?.disableBrakes && input.z < 0 ) input.z = 0;
		if ( effect?.disableAcceleration && input.z > 0 ) input.z = 0;
		if ( Number.isFinite( effect?.steering ) ) input.x *= effect.steering;
		return input;

	}

	function updateAirTrickStateFor( targetVehicle, activePadEffect, state, dt, onTrickFinished = null ) {

		if ( ! targetVehicle || ! state ) return;
		const trick = activePadEffect?.trick || null;
		const hasTrickPayload = Boolean( trick );
		const verticalVel = targetVehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] || 0;
		const airborne = targetVehicle.spherePos.y > 0.5 || Math.abs( verticalVel ) > 0.25;
		const canRun = state.active ? hasTrickPayload : ( hasTrickPayload && airborne );
		if ( ! canRun ) {

			const interrupted = state.active && state.progress > 0 && state.progress < 1;
			if ( interrupted ) {

				state.recovering = true;
				state.recoveryT = 0;
				state.recoveryStartQuat.copy( targetVehicle.container.quaternion );
				const euler = new THREE.Euler().setFromQuaternion( targetVehicle.container.quaternion, 'YXZ' );
				euler.x = 0;
				euler.z = 0;
				state.recoveryTargetQuat.setFromEuler( euler );

			}
			state.active = false;
			state.progress = 0;
			state.lastSmoothT = 0;
			if ( interrupted && onTrickFinished ) onTrickFinished();
			if ( state.recovering ) {

				state.recoveryT = Math.min( 1, state.recoveryT + dt / state.recoveryDuration );
				const t = state.recoveryT * state.recoveryT * ( 3 - 2 * state.recoveryT );
				targetVehicle.container.quaternion.copy( state.recoveryStartQuat ).slerp( state.recoveryTargetQuat, t );
				targetVehicle.container.updateMatrixWorld( true );
				if ( state.recoveryT >= 1 ) state.recovering = false;

			}
			return;

		}

		if ( ! state.active ) {
			state.active = true;
			state.recovering = false;
			state.recoveryT = 0;
			state.progress = 0;
			state.lastSmoothT = 0;
			const phase = trick || {};
			const qEuler = new THREE.Euler().setFromQuaternion( targetVehicle.container.quaternion, 'YXZ' );
			state.baseYaw = qEuler.y;
			state.pitchTotal = ( Number( phase.pitch ) || 0 ) * Math.PI * 2;
			state.yawTotal = ( Number( phase.yaw ) || 0 ) * Math.PI * 2;
			state.rollTotal = ( Number( phase.roll ) || 0 ) * Math.PI * 2;
		}

		const baseDuration = AIR_TRICK_DURATION_SECONDS;
		state.progress = Math.min( 1, state.progress + ( dt / baseDuration ) );
		const deltaT = Math.max( 0, state.progress - state.lastSmoothT );
		state.lastSmoothT = state.progress;
		if ( deltaT > 0 ) {

			const deltaEuler = new THREE.Euler(
				state.pitchTotal * deltaT,
				state.yawTotal * deltaT,
				state.rollTotal * deltaT,
				'YXZ'
			);
			const dq = new THREE.Quaternion().setFromEuler( deltaEuler );
			targetVehicle.container.quaternion.multiply( dq ).normalize();

		}
		targetVehicle.container.updateMatrixWorld( true );
			if ( state.progress >= 1 ) {

				state.active = false;
				state.progress = 0;
				state.lastSmoothT = 0;
				state.recovering = true;
				state.recoveryT = 0;
				state.recoveryStartQuat.copy( targetVehicle.container.quaternion );
				const euler = new THREE.Euler( 0, state.baseYaw, 0, 'YXZ' );
				state.recoveryTargetQuat.setFromEuler( euler );
				if ( onTrickFinished ) onTrickFinished();

			}

	}

	function isVehicleAirborne( targetVehicle ) {

		if ( ! targetVehicle ) return false;
		const verticalVel = targetVehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] || 0;
		return targetVehicle.spherePos.y > 0.62 || Math.abs( verticalVel ) > 0.35;

	}

	function getCustomSurfaceEffect( surfaceType ) {

		const conf = customSurfaceConfigs?.[ surfaceType ];
		if ( ! conf ) return null;
		const grip = THREE.MathUtils.clamp( Number( conf.grip ) || 1, 0.2, 2.5 );
		const speed = THREE.MathUtils.clamp( Number( conf.speed ) || 1, 0.2, 2.5 );
		return {
			grip,
			drag: THREE.MathUtils.clamp( 1.2 / speed, 0.4, 3.4 ),
			accel: speed,
			drive: speed,
		};

	}

	function getSurfaceEffect( surfaceType ) {

		return getCustomSurfaceEffect( surfaceType ) || SURFACE_EFFECTS[ surfaceType || null ] || null;

	}

	function applySurfaceGrip( targetVehicle, surfaceType, padEffect = null ) {

		const effect = getSurfaceEffect( surfaceType );
		const gripPack = GARAGE_FIXED_MULTIPLIER;
		const accelPack = GARAGE_FIXED_MULTIPLIER;
		const drivePack = GARAGE_FIXED_MULTIPLIER;
		const padGrip = Number.isFinite( padEffect?.grip ) ? padEffect.grip : 1.0;
		const padDrag = Number.isFinite( padEffect?.drag ) ? padEffect.drag : 1.0;
		const padAccel = Number.isFinite( padEffect?.accel ) ? padEffect.accel : 1.0;
		const padDrive = Number.isFinite( padEffect?.drive ) ? padEffect.drive : 1.0;
		targetVehicle.gripMultiplier = ( effect ? effect.grip : 1.0 ) * gripPack * padGrip;
		if ( hacksInstalled && hacksState.enabled ) targetVehicle.gripMultiplier *= hacksState.roadGrip;
		targetVehicle.dragMultiplier = ( effect ? effect.drag : 1.0 ) * padDrag;
		if ( hacksInstalled && hacksState.enabled && hacksState.lowFriction ) targetVehicle.dragMultiplier *= 0.35;
		const speedCapScale = Number.isFinite( padEffect?.topSpeed ) ? padEffect.topSpeed : 1.0;
		targetVehicle.accelMultiplier = ( effect ? effect.accel : 1.0 ) * accelPack * padAccel * speedCapScale;
		targetVehicle.driveMultiplier = ( effect ? effect.drive : 1.0 ) * drivePack * padDrive * speedCapScale;

	}

	function getFastestVisibleGhostCheckpointTime( checkpointIndex ) {

		let best = Number.isFinite( bestGhostCheckpointTimes?.[ checkpointIndex ] ) ? bestGhostCheckpointTimes[ checkpointIndex ] : Infinity;
		for ( const state of leaderboardGhostPlayers.values() ) {

			const time = Number( state?.checkpointTimes?.[ checkpointIndex ] );
			if ( Number.isFinite( time ) ) best = Math.min( best, time );

		}
		for ( const state of recentGhostPlayers ) {

			const time = Number( state?.checkpointTimes?.[ checkpointIndex ] );
			if ( Number.isFinite( time ) ) best = Math.min( best, time );

		}
		return Number.isFinite( best ) ? best : null;

	}

	function formatDeltaSigned( deltaSeconds ) {

		if ( ! Number.isFinite( deltaSeconds ) ) return '';
		const sign = deltaSeconds >= 0 ? '+' : '-';
		const abs = Math.abs( deltaSeconds );
		const minutes = Math.floor( abs / 60 );
		const seconds = Math.floor( abs % 60 );
		const millis = Math.floor( ( abs % 1 ) * 1000 );
		return `${ sign }${ String( minutes ).padStart( 2, '0' ) }.${ String( seconds ).padStart( 2, '0' ) }.${ String( millis ).padStart( 3, '0' ) }`;

	}

	function formatLapTime( totalSeconds ) {

		if ( totalSeconds === null || ! Number.isFinite( totalSeconds ) ) return '--:--.---';

		const minutes = Math.floor( totalSeconds / 60 );
		const seconds = Math.floor( totalSeconds % 60 );
		const millis = Math.floor( ( totalSeconds % 1 ) * 1000 );
		return `${ String( minutes ).padStart( 2, '0' ) }:${ String( seconds ).padStart( 2, '0' ) }.${ String( millis ).padStart( 3, '0' ) }`;

	}

	function formatShareSeconds( totalSeconds ) {

		if ( ! Number.isFinite( totalSeconds ) ) return '--.--';
		return totalSeconds.toFixed( 2 );

	}

	function createTimeCardImage( bestSeconds ) {

		const width = 1280;
		const height = 720;
		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext( '2d' );
		if ( ! ctx ) return '';

		const bg = ctx.createLinearGradient( 0, 0, width, height );
		bg.addColorStop( 0, '#29323c' );
		bg.addColorStop( 1, '#0f2027' );
		ctx.fillStyle = bg;
		ctx.fillRect( 0, 0, width, height );

		ctx.fillStyle = 'rgba(255,255,255,0.12)';
		ctx.fillRect( width * 0.1, height * 0.22, width * 0.8, height * 0.56 );

		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = '700 66px sans-serif';
		ctx.fillText( 'Beat my time!', width / 2, height * 0.4 );
		ctx.font = '700 94px sans-serif';
		ctx.fillText( `${ formatShareSeconds( bestSeconds ) }s`, width / 2, height * 0.56 );
		ctx.font = '500 38px sans-serif';
		ctx.fillText( 'Racing Game • Best Lap', width / 2, height * 0.7 );

		return canvas.toDataURL( 'image/png' );

	}

	function createShareSnapshot( bestSeconds ) {

		try {

			renderer.render( scene, cam.camera );
			const source = renderer.domElement;
			if ( ! source || source.width === 0 || source.height === 0 ) return '';

			const output = document.createElement( 'canvas' );
			output.width = source.width;
			output.height = source.height;
			const ctx = output.getContext( '2d' );
			if ( ! ctx ) return '';

			ctx.drawImage( source, 0, 0 );
			const bannerWidth = output.width * 0.72;
			const bannerHeight = output.height * 0.14;
			const bannerX = ( output.width - bannerWidth ) / 2;
			const bannerY = output.height - bannerHeight - output.height * 0.05;

			ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
			ctx.fillRect( bannerX, bannerY, bannerWidth, bannerHeight );

			const message = `Beat my time! My best time: ${ formatShareSeconds( bestSeconds ) }s`;
			const fontSize = Math.max( 20, Math.round( output.height * 0.04 ) );
			ctx.fillStyle = 'rgba(20, 20, 20, 0.92)';
			ctx.font = `700 ${ fontSize }px sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText( message, output.width / 2, bannerY + bannerHeight / 2 );

			return output.toDataURL( 'image/png' );

		} catch ( e ) {

			console.warn( 'Failed to create share snapshot', e );
			return createTimeCardImage( bestSeconds );

		}

	}

	function openShareTab() {

		if ( ! Number.isFinite( bestLapSeconds ) ) return;
		const ghostCode = createGhostExportCode();
		let playTrackUrl = '';
		if ( ghostCode ) {

			try {

				const parsed = decodeBase64UrlJson( ghostCode );
				const ghostBlob = encodeBase64UrlJson( parsed.ghost );
				const separator = parsed.url.includes( '#' ) ? '&' : '#';
				playTrackUrl = `${ parsed.url }${ separator }ghost=${ ghostBlob }`;

			} catch ( e ) {

				console.warn( 'Failed to build track ghost URL from export code', e );

			}

		}
		const sharePayload = encodeBase64UrlJson( {
			v: 1,
			bestLapSeconds,
			ghostCode,
			playTrackUrl,
		} );
		const sharePageUrl = `share.html#data=${ sharePayload }`;
		const tab = window.open( sharePageUrl, '_blank' );
		if ( ! tab ) return;

	}

	function openReplayWatcherForGhost( ghostPayload ) {

		if ( ! ghostPayload || ! Array.isArray( ghostPayload.samples ) || ghostPayload.samples.length < 2 ) {

			showTopMessage( 'This ghost payload is invalid for replay viewing.', true, 2000 );
			return;

		}
		const replayPayload = {
			v: 1,
			url: currentTrackUrl,
			ghost: ghostPayload,
		};
		const replayCode = encodeBase64UrlJson( replayPayload );
		window.open( `replay.html#code=${ replayCode }`, '_blank' );

	}

	function updateGhostShareButtons() {

		if ( ! exportGhostBtn ) return;
		if ( ! ghostEnabled ) {

			exportGhostBtn.disabled = true;
			exportGhostBtn.title = 'Ghosts are disabled in local multiplayer';
			return;

		}
		const hasGhost = bestLapGhostSamples.length >= 2 && Number.isFinite( bestLapSeconds );
		exportGhostBtn.disabled = false;
		exportGhostBtn.title = hasGhost ? 'Export current best ghost' : 'Finish a clean lap first to generate an exportable ghost';

	}

	function createGhostExportCode() {

		if ( ! ghostEnabled ) return '';
		if ( bestLapGhostSamples.length < 2 || ! Number.isFinite( bestLapSeconds ) ) return '';
		const payload = {
			v: 1,
			url: currentTrackUrl,
			ghost: {
				car: bestGhostCarKey,
				cosmetics: bestGhostCosmetics,
				bestLapSeconds,
				duration: bestGhostDuration,
				samples: bestLapGhostSamples,
				inputs: bestLapInputFrames,
			}
		};
		return encodeBase64UrlJson( payload );

	}

	function deriveInputsFromGhostSamples( samples, duration ) {

		if ( ! Array.isArray( samples ) || samples.length < 2 || ! Number.isFinite( duration ) || duration <= 0 ) return [];
		const derived = [];
		for ( let i = 1; i < samples.length; i ++ ) {

			const prev = samples[ i - 1 ];
			const next = samples[ i ];
			const dt = Math.max( 1e-4, next.t - prev.t );
			const dx = next.x - prev.x;
			const dz = next.z - prev.z;
			const speed = Math.sqrt( dx * dx + dz * dz ) / dt;
			const yawDelta = lerpAngle( prev.yaw, next.yaw, 1 ) - prev.yaw;
			derived.push( {
				t: next.t,
				x: THREE.MathUtils.clamp( yawDelta * 2.3, - 1, 1 ),
				z: speed > 0.08 ? 1 : 0,
				keys: {
					left: yawDelta > 0.08,
					right: yawDelta < - 0.08,
					forward: speed > 0.08,
					back: false,
				},
			} );

		}
		return derived;

	}

	function createLeaderboardGhostPayload() {

		if ( ! ghostEnabled ) return null;
		if ( bestLapGhostSamples.length < 2 || ! Number.isFinite( bestGhostDuration ) || bestGhostDuration <= 0 ) return null;
		return {
			car: bestGhostCarKey,
			cosmetics: bestGhostCosmetics,
			bestLapSeconds: Number.isFinite( bestLapSeconds ) ? bestLapSeconds : undefined,
			duration: bestGhostDuration,
			samples: bestLapGhostSamples.slice( 0, MAX_LEADERBOARD_GHOST_SAMPLES ),
		};

	}

	function applyImportedGhostPayload( payload, options = {} ) {

		if ( ! ghostEnabled ) return false;
		const normalized = extractNormalizedGhostPayload( payload );
		if ( ! normalized ) return false;
		bestLapGhostSamples.length = 0;
		for ( const sample of normalized.samples ) bestLapGhostSamples.push( sample );
		if ( bestLapGhostSamples.length < 2 ) return false;
		bestGhostDuration = normalized.duration;
		bestGhostCosmetics = normalized.cosmetics;
		bestGhostCheckpointTimes = computeCheckpointCrossTimes( normalized.samples );
		if ( options.applyBestLapSeconds !== false && Number.isFinite( normalized.bestLapSeconds ) ) bestLapSeconds = normalized.bestLapSeconds;
		if ( normalized.car && models[ normalized.car ] ) {

			bestGhostCarKey = normalized.car;
			createGhostModel( models[ normalized.car ], bestGhostCosmetics );

		}
			updateGhostShareButtons();
		return true;

	}

	function importGhostIntoNewTab() {

		if ( ! ghostEnabled ) return;
		const code = window.prompt( 'Paste ghost code:' );
		if ( ! code ) return;
		let parsed;
		try {

			parsed = decodeBase64UrlJson( code.trim() );

		} catch ( e ) {

			window.alert( 'Invalid ghost code.' );
			return;

		}
		const url = typeof parsed?.url === 'string' ? parsed.url : '';
		if ( ! parsed?.ghost ) {

			window.alert( 'Ghost code is missing required data.' );
			return;

		}
		const applied = applyImportedGhostPayload( parsed.ghost );
		if ( applied ) {

			const importedInputs = Array.isArray( parsed.ghost?.inputs ) ? parsed.ghost.inputs : deriveInputsFromGhostSamples( parsed.ghost?.samples, parsed.ghost?.duration );
				if ( importedInputs.length > 1 ) {

					bestLapInputFrames = importedInputs;
					latestLapInputFrames = importedInputs.slice();
					saveLapStats();

			}
			showTopMessage( 'Ghost imported for current track.', false, 1700 );
			return;

		}
		if ( url ) {

			const ghostBlob = encodeBase64UrlJson( parsed.ghost );
			const separator = url.includes( '#' ) ? '&' : '#';
			window.open( `${ url }${ separator }ghost=${ ghostBlob }`, '_blank' );
			return;

		}
		window.alert( 'Ghost code could not be applied to this track.' );

	}

	function openGhostCodeTab( code ) {

		const tab = window.open( 'about:blank', '_blank' );
		if ( ! tab ) return;
		tab.document.open();
		tab.document.write( `<!doctype html><html><head><title>Ghost code</title><style>body{margin:0;padding:16px;background:#101218;color:#e8eef8;font:14px/1.4 monospace;}h1{font:600 16px sans-serif;margin:0 0 10px;}textarea{width:100%;height:70vh;background:#0b0d12;color:#dff4ff;border:1px solid #2a3240;border-radius:8px;padding:10px;box-sizing:border-box;}</style></head><body><h1>Raw ghost code</h1><textarea readonly>${ code }</textarea></body></html>` );
		tab.document.close();

	}

	function updateLapHud() {

		if ( ! lapHud ) return;
		const totalCheckpoints = checkpointStates.length;
		const passedCheckpoints = checkpointStates.reduce( ( count, checkpoint ) => count + ( checkpoint.passedThisLap ? 1 : 0 ), 0 );
		const checkpointLine = totalCheckpoints > 0
			? `<br><small>Checkpoints: ${ passedCheckpoints } / ${ totalCheckpoints }</small>`
			: '';
		const controlsHints = [];
		if ( checkpointRespawnInstalled ) controlsHints.push( 'Checkpoint respawn: T' );
		if ( practiceStartInstalled ) controlsHints.push( 'Save/Load practice: Y / Shift+Y' );
		if ( freecamInstalled ) controlsHints.push( 'Freecam: F (WASD + mouse)' );
		const controlsLine = controlsHints.length ? `<br><small>${ controlsHints.join( ' • ' ) }</small>` : '';
		const checkpointDeltaLine = checkpointDeltaText ? `<br><small>Checkpoint Δ: ${ checkpointDeltaText }</small>` : '';
		const invalidLine = currentLapInvalidatedByPause ? '<br><small>Paused: leaderboard invalid</small>' : '';
		lapHud.innerHTML = `Lap ${ lapNumber } • ${ formatLapTime( lapSeconds ) }<br><small>Last: ${ formatLapTime( lastLapSeconds ) } • Best: ${ formatLapTime( bestLapSeconds ) }</small>${ checkpointLine }${ checkpointDeltaLine }${ invalidLine }${ controlsLine }`;

	}

	function updateLapHud2() {

		if ( ! lapHud2 || ! isSplitScreen ) return;
		const totalCheckpoints = checkpointStates2.length;
		const passedCheckpoints = checkpointStates2.reduce( ( count, checkpoint ) => count + ( checkpoint.passedThisLap ? 1 : 0 ), 0 );
		const checkpointLine = totalCheckpoints > 0
			? `<br><small>Checkpoints: ${ passedCheckpoints } / ${ totalCheckpoints }</small>`
			: '';
		lapHud2.innerHTML = `P2 • Lap ${ lapNumber2 } • ${ formatLapTime( lapSeconds2 ) }<br><small>Last: ${ formatLapTime( lastLapSeconds2 ) } • Best: ${ formatLapTime( bestLapSeconds2 ) }</small>${ checkpointLine }<br><small>Keys: Arrows • Respawn: P</small>`;

	}

	function renderLeaderboardRows( rows ) {

		if ( ! leaderboardList || ! leaderboardEmpty ) return;
		const entries = Array.isArray( rows ) ? rows : [];
		leaderboardList.innerHTML = '';
		if ( entries.length === 0 ) {

			leaderboardList.hidden = true;
			leaderboardEmpty.hidden = false;
			leaderboardEmpty.textContent = 'No records yet. Finish a lap to post one.';
			if ( leaderboardPercentileLabel ) leaderboardPercentileLabel.textContent = '';
			return;

		}
		leaderboardEmpty.hidden = true;
		leaderboardList.hidden = false;
		updateSelectedLeaderboardGhosts( entries );
		for ( const [ index, entry ] of entries.slice( 0, MAX_LEADERBOARD_ROWS ).entries() ) {

			const row = document.createElement( 'li' );
			const safeName = sanitizePlayerName( entry?.name ) || 'Anonymous';
			const timeText = formatLapTime( Number( entry?.timeSeconds ) );
			const hasGhost = Boolean( entry?.ghost );
			row.classList.toggle( 'has-ghost', hasGhost );
			const checked = hasGhost && selectedLeaderboardGhosts.has( safeName );
			row.innerHTML = `<span class=\"lb-rank\">#${ index + 1 }</span> <span class=\"lb-name\">${ safeName }</span> — <span class=\"lb-time\">${ timeText }</span>${ hasGhost ? '<label class=\"lb-ghost-toggle\"><input type=\"checkbox\" class=\"lb-ghost-check\" data-player-name=\"' + safeName.replace( /\"/g, '&quot;' ) + '\" ' + ( checked ? 'checked' : '' ) + '> show ghost</label><button type=\"button\" class=\"lb-replay-btn\">watch replay</button>' : '' }`;
			if ( hasGhost ) {

				const checkbox = row.querySelector( '.lb-ghost-check' );
				const replayBtn = row.querySelector( '.lb-replay-btn' );
				checkbox?.addEventListener( 'change', () => {

					if ( checkbox.checked ) {

						if ( ! enableLeaderboardGhost( safeName, entry.ghost ) ) {

							checkbox.checked = false;
							showTopMessage( `${ safeName } has an invalid cloud ghost entry.`, true, 1900 );
							return;

						}
						selectedLeaderboardGhosts.add( safeName );
						showTopMessage( `Enabled ${ safeName } ghost.`, false, 1500 );
					} else {

						selectedLeaderboardGhosts.delete( safeName );
						removeLeaderboardGhost( safeName );
						showTopMessage( `Disabled ${ safeName } ghost.`, false, 1500 );

					}

				} );
				replayBtn?.addEventListener( 'click', ( event ) => {

					event.stopPropagation();
					openReplayWatcherForGhost( entry.ghost );

				} );

			} else {

				row.addEventListener( 'click', () => showTopMessage( `${ safeName }'s record was set before cloud ghosts existed.`, true, 1900 ) );

			}
			leaderboardList.appendChild( row );

		}

	}

	function updateLeaderboardPercentile( rows ) {

		if ( ! leaderboardPercentileLabel ) return;
		const entries = Array.isArray( rows ) ? rows : [];
		if ( entries.length === 0 ) {

			leaderboardPercentileLabel.textContent = '';
			return;

		}
		const localName = sanitizePlayerName( playerNameInput?.value || localStorage.getItem( PLAYER_NAME_KEY ) || '' ).toLowerCase();
		let myRank = -1;
		if ( localName ) myRank = entries.findIndex( ( row ) => sanitizePlayerName( row?.name ).toLowerCase() === localName );
		if ( myRank < 0 && Number.isFinite( bestLapSeconds ) ) {

			myRank = entries.findIndex( ( row ) => Number( row?.timeSeconds ) >= bestLapSeconds - 1e-6 );

		}
		if ( myRank < 0 ) {

			leaderboardPercentileLabel.textContent = `Entries: ${ entries.length }`;
			return;

		}
		const rank = myRank + 1;
		const percentile = Math.max( 0, 100 * ( 1 - ( rank - 1 ) / Math.max( 1, entries.length ) ) );
		leaderboardPercentileLabel.textContent = `Your percentile: top ${ percentile.toFixed( 1 ) }% (#${ rank }/${ entries.length })`;

	}

	async function fetchTrackLeaderboard() {

		if ( leaderboardTrackLabel ) leaderboardTrackLabel.textContent = `Track: ${ leaderboardTrackName }`;
		if ( ! leaderboardEmpty || ! leaderboardList ) return;
		leaderboardEmpty.hidden = false;
		leaderboardList.hidden = true;
		leaderboardEmpty.textContent = 'Loading leaderboard…';
		setLoadingStatus( 'Fetching leaderboard…', 'leaderboard' );
		try {

			const trackIdsToRead = [ leaderboardTrackId, ...leaderboardLegacyTrackIds ];
			const payloads = await Promise.all( trackIdsToRead.map( async ( trackId ) => {

				const response = await fetch( `${ LEADERBOARD_API_BASE }?trackId=${ encodeURIComponent( trackId ) }` );
				if ( ! response.ok ) throw new Error( `Leaderboard HTTP ${ response.status }` );
				return response.json();

			} ) );
			const merged = dedupeAndSortLeaderboardEntries( payloads.flatMap( ( parsed ) => Array.isArray( parsed?.entries ) ? parsed.entries : [] ) );
		currentTrackLeaderboardRows = merged;
			renderLeaderboardRows( merged );
			updateLeaderboardPercentile( merged );
			setLoadingStatus( 'Ready to race!', 'ready' );

		} catch ( e ) {

			console.warn( 'Failed to fetch leaderboard', e );
			leaderboardList.hidden = true;
			leaderboardEmpty.hidden = false;
			leaderboardEmpty.textContent = 'Leaderboard unavailable (check Cloudflare setup).';
			currentTrackLeaderboardRows = [];
			if ( leaderboardPercentileLabel ) leaderboardPercentileLabel.textContent = '';

		}

	}

	function dedupeAndSortLeaderboardEntries( entries ) {

		const bestByName = new Map();
		for ( const entry of entries ) {

			const key = sanitizePlayerName( entry?.name ).toLowerCase();
			if ( ! key ) continue;
			const timeSeconds = Number( entry?.timeSeconds );
			if ( ! Number.isFinite( timeSeconds ) ) continue;
			const normalized = {
				name: sanitizePlayerName( entry.name ) || 'Anonymous',
				timeSeconds: Math.round( timeSeconds * 1000 ) / 1000,
				ghost: entry?.ghost || null,
				createdAt: Number.isFinite( Number( entry?.createdAt ) ) ? Number( entry.createdAt ) : Date.now(),
			};
			const existing = bestByName.get( key );
			if ( ! existing || normalized.timeSeconds < existing.timeSeconds || ( normalized.timeSeconds === existing.timeSeconds && normalized.createdAt < existing.createdAt ) ) {

				bestByName.set( key, normalized );

			}

		}

		return [ ...bestByName.values() ].sort( ( a, b ) => {

			if ( a.timeSeconds !== b.timeSeconds ) return a.timeSeconds - b.timeSeconds;
			return a.createdAt - b.createdAt;

		} );

	}

	function closeNamePopup() {

		if ( ! namePopup ) return;
		namePopup.style.display = 'none';

	}

	function setLeaderboardVisible( visible ) {

		leaderboardVisible = Boolean( visible );
		if ( leaderboardPanel ) leaderboardPanel.classList.toggle( 'hidden', ! leaderboardVisible );
		if ( leaderboardToggleBtn ) leaderboardToggleBtn.textContent = leaderboardVisible ? 'Hide Leaderboard' : 'Show Leaderboard';

	}

	function openNamePopup( pendingTime ) {

		pendingLeaderboardRecord = pendingTime;
		if ( ! namePopup || ! namePopupInput ) return;
		namePopup.style.display = 'flex';
		namePopupInput.value = sanitizePlayerName( playerNameInput?.value );
		namePopupInput.focus();
		namePopupInput.select();

	}

	async function submitLeaderboardTime( lapTimeSeconds, forcedName = '' ) {

		if ( currentLapInvalidatedByPause ) {

			showTopMessage( 'Leaderboard submission skipped: paused runs are invalid.', true, 2400 );
			return false;

		}

		if ( nonFreecamModsInstalled ) {

			showTopMessage( 'Leaderboard submitting is disabled when gameplay mods are installed.', true, 2200 );
			return false;

		}

		const chosenName = sanitizePlayerName( forcedName || playerNameInput?.value );
		if ( ! chosenName ) {

			openNamePopup( lapTimeSeconds );
			return false;

		}
		localStorage.setItem( PLAYER_NAME_KEY, chosenName );
		if ( playerNameInput ) playerNameInput.value = chosenName;
		const submittedGhost = createLeaderboardGhostPayload();
		const submittedRoundedTime = Math.round( Number( lapTimeSeconds ) * 1000 ) / 1000;
		try {

			const trackIdsToWrite = [ leaderboardTrackId, ...leaderboardLegacyTrackIds ];
			const response = await fetch( LEADERBOARD_API_BASE, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( {
					trackId: trackIdsToWrite[ 0 ],
					trackName: leaderboardTrackName,
					name: chosenName,
					timeSeconds: lapTimeSeconds,
					ghost: submittedGhost,
				} ),
			} );
			if ( ! response.ok ) throw new Error( `Leaderboard POST ${ response.status }` );
			let responsePayload = null;
			try {

				responsePayload = await response.json();

			} catch ( e ) {

				console.warn( 'Leaderboard POST response was not JSON', e );

			}
			if ( submittedGhost ) {

				const responseEntries = Array.isArray( responsePayload?.entries ) ? responsePayload.entries : [];
				const matchingEntry = responseEntries.find( ( entry ) => {

					if ( sanitizePlayerName( entry?.name ) !== chosenName ) return false;
					const entryTime = Math.round( Number( entry?.timeSeconds ) * 1000 ) / 1000;
					return Number.isFinite( entryTime ) && entryTime === submittedRoundedTime;

				} );
				if ( matchingEntry && ! matchingEntry.ghost ) {

					showTopMessage( 'Ghost save was ignored by Cloudflare API. Please redeploy the leaderboard worker update.', true, 2600 );

				}

			}
			await Promise.all( trackIdsToWrite.slice( 1 ).map( ( legacyId ) => fetch( LEADERBOARD_API_BASE, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( {
					trackId: legacyId,
					trackName: leaderboardTrackName,
					name: chosenName,
					timeSeconds: lapTimeSeconds,
					ghost: submittedGhost,
				} ),
			} ).catch( () => null ) ) );
			await fetchTrackLeaderboard();
			return true;

		} catch ( e ) {

			console.warn( 'Failed to submit leaderboard time', e );
			return false;

		}

	}

	async function signupAccount() {

		const username = String( accountUsernameInput?.value || '' ).trim();
		const password = String( accountPasswordInput?.value || '' );
		const payload = await accountApiRequest( '/signup', {
			method: 'POST',
			body: JSON.stringify( { username, password, profile: getCurrentProfileSnapshot() } ),
		} );
		accountSession = { username: payload.username, token: payload.token };
		localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );
		updateAccountUi();
		setAccountStatus( `Signed up and logged in as ${ payload.username }.` );

	}

	async function loginAccount() {

		const username = String( accountUsernameInput?.value || '' ).trim();
		const password = String( accountPasswordInput?.value || '' );
		const payload = await accountApiRequest( '/login', {
			method: 'POST',
			body: JSON.stringify( { username, password } ),
		} );
		accountSession = { username: payload.username, token: payload.token };
		localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );
		updateAccountUi();
		try {

			await cloudLoadProfile();
			setAccountStatus( `Logged in as ${ payload.username } and loaded cloud profile.` );

		} catch ( loadError ) {

			console.warn( 'Auto cloud profile load after login failed', loadError );
			setAccountStatus( `Logged in as ${ payload.username } (auto-load failed, use "Load profile from cloud").`, true );

		}

	}

	async function cloudSaveProfile() {

		if ( ! accountSession?.token ) throw new Error( 'Log in first.' );
		await accountApiRequest( '/profile', {
			method: 'POST',
			body: JSON.stringify( { token: accountSession.token, profile: getCurrentProfileSnapshot() } ),
		} );
		setAccountStatus( 'Cloud profile saved.' );

	}

	async function cloudLoadProfile() {

		if ( ! accountSession?.token ) throw new Error( 'Log in first.' );
		const payload = await accountApiRequest( `/profile?token=${ encodeURIComponent( accountSession.token ) }` );
		if ( payload?.profile ) applyImportedProfile( encodeBase64UrlJson( payload.profile ) );
		if ( payload?.username ) accountSession.username = payload.username;
		localStorage.setItem( ACCOUNT_SESSION_KEY, JSON.stringify( accountSession ) );
		updateAccountUi();
		setAccountStatus( 'Cloud profile loaded.' );

	}

	function saveLapStats() {

		if ( ! ghostEnabled ) {

				localStorage.setItem( lapStoreKey, JSON.stringify( {
					lapNumber,
					lastLapSeconds,
					bestLapSeconds,
					bestGhostDuration: 0,
					bestGhostCarKey: 'vehicle-truck-yellow',
					bestGhostCosmetics: null,
					bestLapGhostSamples: [],
					bestLapInputFrames: [],
					latestLapInputFrames: [],
				} ) );
			return;

		}
			localStorage.setItem( lapStoreKey, JSON.stringify( {
				lapNumber,
				lastLapSeconds,
				bestLapSeconds,
				bestGhostDuration,
				bestGhostCarKey,
				bestGhostCosmetics,
				bestLapGhostSamples,
				bestLapInputFrames,
				latestLapInputFrames,
			} ) );

	}

	function loadLapStats() {

		try {

			const raw = localStorage.getItem( lapStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			lapNumber = Math.max( 1, parsed.lapNumber || 1 );
			lastLapSeconds = Number.isFinite( parsed.lastLapSeconds ) ? parsed.lastLapSeconds : null;
			bestLapSeconds = Number.isFinite( parsed.bestLapSeconds ) ? parsed.bestLapSeconds : null;
			bestGhostDuration = Number.isFinite( parsed.bestGhostDuration ) ? parsed.bestGhostDuration : 0;
				bestGhostCarKey = typeof parsed.bestGhostCarKey === 'string' ? parsed.bestGhostCarKey : 'vehicle-truck-yellow';
				bestGhostCosmetics = normalizeGhostCosmeticsPayload( parsed.bestGhostCosmetics );
					bestLapGhostSamples.length = 0;
					bestLapInputFrames = [];
					latestLapInputFrames = [];
				if ( Array.isArray( parsed.bestLapGhostSamples ) ) {

				for ( const sample of parsed.bestLapGhostSamples ) {

					if ( ! Number.isFinite( sample?.t ) || ! Number.isFinite( sample?.x ) || ! Number.isFinite( sample?.y ) || ! Number.isFinite( sample?.z ) || ! Number.isFinite( sample?.yaw ) ) continue;
					bestLapGhostSamples.push( {
						t: sample.t,
						x: sample.x,
						y: sample.y,
						z: sample.z,
						yaw: sample.yaw,
					} );

				}
				if ( Array.isArray( parsed.bestLapInputFrames ) ) {

					bestLapInputFrames = parsed.bestLapInputFrames.filter( ( sample ) => Number.isFinite( sample?.t ) && Number.isFinite( sample?.x ) && Number.isFinite( sample?.z ) );

				}
				if ( Array.isArray( parsed.latestLapInputFrames ) ) {

					latestLapInputFrames = parsed.latestLapInputFrames.filter( ( sample ) => Number.isFinite( sample?.t ) && Number.isFinite( sample?.x ) && Number.isFinite( sample?.z ) );

				}

			}
			if ( bestLapGhostSamples.length < 2 ) bestGhostDuration = 0;
			if ( ghostEnabled && bestLapGhostSamples.length >= 2 && models[ bestGhostCarKey ] ) createGhostModel( models[ bestGhostCarKey ], bestGhostCosmetics );

		} catch ( e ) {

			console.warn( 'Failed to load lap stats', e );

		}

	}

	function updateFpsHudVisibility() {

		if ( fpsToggle ) fpsToggle.checked = fpsHudVisible;
		if ( fpsHud ) {

			fpsHud.classList.toggle( 'visible', fpsHudVisible );
			fpsHud.setAttribute( 'aria-hidden', fpsHudVisible ? 'false' : 'true' );

		}

	}

	function updateFpsHud( realFrameSeconds ) {

		if ( ! fpsHudVisible || ! fpsHud ) return;
		const instantFps = realFrameSeconds > 0 ? 1 / realFrameSeconds : 0;
		if ( ! Number.isFinite( instantFps ) || instantFps <= 0 ) return;
		rollingFps = rollingFps > 0 ? THREE.MathUtils.lerp( rollingFps, instantFps, 0.08 ) : instantFps;
		fpsHudAccumulator += realFrameSeconds;
		if ( fpsHudAccumulator < 0.18 ) return;
		fpsHudAccumulator = 0;
		fpsHud.textContent = `FPS: ${ Math.round( rollingFps ) }`;

	}

	function canPauseGameplay() {

		return ! isSplitScreen && ! multiplayerSessionState.roomCode && ! replayViewerMode;

	}

	function setUiHidden( hidden ) {

		uiHidden = Boolean( hidden );
		document.body.classList.toggle( 'ui-hidden', uiHidden );

	}

	function updatePauseUi() {

		const canPause = canPauseGameplay();
		if ( pausePanel ) {

			pausePanel.classList.toggle( 'visible', paused );
			pausePanel.setAttribute( 'aria-hidden', paused ? 'false' : 'true' );

		}
		if ( pauseToggleBtn ) {

			pauseToggleBtn.disabled = ! canPause;
			pauseToggleBtn.textContent = paused ? 'Resume' : 'Pause';
			pauseToggleBtn.title = canPause ? 'Pause or resume the race' : 'Pause is disabled in multiplayer.';

		}

	}

	function setPaused( next ) {

		const nextPaused = Boolean( next );
		if ( nextPaused && ! canPauseGameplay() ) return;
		if ( paused === nextPaused ) return;
		paused = nextPaused;
		if ( paused ) {

			currentLapInvalidatedByPause = true;
			showTopMessage( 'Paused run marked invalid for leaderboard submission.', true, 1800 );

		}
		updatePauseUi();
		updateLapHud();

	}

	function togglePaused() {

		setPaused( ! paused );

	}

	function updateCountdownHud( now = raceClockSeconds ) {

		if ( ! countdownHud ) return;
		if ( ! countdownActive ) {

			countdownHud.classList.remove( 'visible' );
			countdownHud.textContent = '';
			return;

		}
		const remaining = Math.max( 0, countdownEndsAt - now );
		countdownHud.textContent = remaining > 0.35 ? String( Math.ceil( remaining ) ) : 'GO!';
		countdownHud.classList.add( 'visible' );

	}

	function finishCountdown( now = raceClockSeconds ) {

		if ( ! countdownActive ) return;
		countdownActive = false;
		countdownEndsAt = 0;
		lapStartSeconds = now;
		lapSeconds = 0;
		if ( vehicle2 ) {

			lapStartSeconds2 = now;
			lapSeconds2 = 0;

		}
		resetCurrentLapGhost();
		resetCurrentLapInputs();
		recordGhostSample( 0, true );
		updateCountdownHud( now );
		updateLapHud();
		updateLapHud2();

	}

	function startCountdown( now = raceClockSeconds ) {

		if ( ! countdownEnabled ) {

			countdownActive = false;
			countdownEndsAt = 0;
			updateCountdownHud( now );
			return;

		}
		countdownActive = true;
		countdownEndsAt = now + COUNTDOWN_DURATION_SECONDS;
		lapSeconds = 0;
		if ( vehicle2 ) lapSeconds2 = 0;
		updateCountdownHud( now );
		updateLapHud();
		updateLapHud2();

	}

	function updateCountdownState( now = raceClockSeconds ) {

		if ( ! countdownActive ) return;
		if ( now >= countdownEndsAt ) finishCountdown( now );
		else updateCountdownHud( now );

	}

	function updateCountdownToggle() {

		if ( countdownToggle ) countdownToggle.checked = countdownEnabled;

	}

	function resetLapState( keepRecords = false ) {

		if ( ! keepRecords ) {

			lapNumber = 1;
			lastLapSeconds = null;
			bestLapSeconds = null;

		}

		lapStartSeconds = raceClockSeconds;
		lapSeconds = 0;
		currentLapInvalidatedByPause = false;
		boostActiveUntil = 0;
		boostContactCell = null;
		arcLinkState = { contactKey: null, lockUntilExit: false };
		activePadEffect = null;
		activePadTimeScale = 1;
		padContactKey = null;
		airTrickState.active = false;
		airTrickState.recovering = false;
		camYawLockActive = false;
		specialSurfaceContactState.clear();
		resetCurrentLapGhost();
		resetCurrentLapInputs();
		recordGhostSample( 0, true );
		updateGhostPlayback( 0 );
		updateLeaderboardGhostPlayback( 0 );
		updateRecentGhostPlayback( 0 );
		hasLeftStartZone = false;
		hasPrevFinishSample = false;
		lastLocalX = 0;
		lastLocalZ = 0;
		for ( let checkpointIndex = 0; checkpointIndex < checkpointStates.length; checkpointIndex ++ ) {

			const checkpoint = checkpointStates[ checkpointIndex ];

			checkpoint.lastLocalX = 0;
			checkpoint.lastLocalZ = 0;
			checkpoint.hasPrevSample = false;
			checkpoint.passedThisLap = false;

		}
		updateLapHud();

	}

	function resetLapState2( keepRecords = false ) {

		if ( ! isSplitScreen ) return;
		if ( ! keepRecords ) {

			lapNumber2 = 1;
			lastLapSeconds2 = null;
			bestLapSeconds2 = null;

		}
		lapStartSeconds2 = raceClockSeconds;
		lapSeconds2 = 0;
		boostActiveUntil2 = 0;
		boostContactCell2 = null;
		arcLinkState2 = { contactKey: null, lockUntilExit: false };
		activePadEffect2 = null;
		activePadTimeScale2 = 1;
		padContactKey2 = null;
		airTrickState2.active = false;
		airTrickState2.recovering = false;
		camYawLockActive2 = false;
		specialSurfaceContactState2.clear();
		hasLeftStartZone2 = false;
		hasPrevFinishSample2 = false;
		lastLocalX2 = 0;
		lastLocalZ2 = 0;
		for ( const checkpoint of checkpointStates2 ) {

			checkpoint.lastLocalX = 0;
			checkpoint.lastLocalZ = 0;
			checkpoint.hasPrevSample = false;
			checkpoint.passedThisLap = false;

		}
		updateLapHud2();

	}

	function respawnVehicle() {

		if ( autoRespawnTimerId ) {

			clearTimeout( autoRespawnTimerId );
			autoRespawnTimerId = null;

		}
		vehicle.resetToSpawn();
		resetMovingObstacles( movingObstacleState, raceClockSeconds );
		cam.targetPosition.copy( vehicle.spherePos );
		cam.camera.position.addVectors( cam.targetPosition, cam.offset );
		resetPhysicsObstacles();

		resetLapState( true );

	}

	function respawnVehicle2() {

		if ( ! vehicle2 || ! cam2 ) return;
		if ( autoRespawnTimerId2 ) {

			clearTimeout( autoRespawnTimerId2 );
			autoRespawnTimerId2 = null;

		}
		vehicle2.resetToSpawn();
		cam2.targetPosition.copy( vehicle2.spherePos );
		cam2.camera.position.addVectors( cam2.targetPosition, cam2.offset );
		resetPhysicsObstacles();
		resetLapState2( true );

	}

	function saveCheckpointState( checkpoint = null ) {

		if ( ! finishData ) return;
		savedCheckpointState = {
			position: vehicle.spherePos.toArray(),
			checkpointAngle: Number.isFinite( checkpoint?.angle ) ? checkpoint.angle : vehicle.container.rotation.y,
		};

	}

	function respawnToLastCheckpoint() {

		if ( ! savedCheckpointState ) {

			showTopMessage( 'No checkpoint captured yet.', true, 1400 );
			return;

		}
		rigidBody.setPosition( world, vehicle.rigidBody, savedCheckpointState.position, false );
		rigidBody.setLinearVelocity( world, vehicle.rigidBody, [ 0, 0, 0 ] );
		rigidBody.setAngularVelocity( world, vehicle.rigidBody, [ 0, 0, 0 ] );
		vehicle.spherePos.fromArray( savedCheckpointState.position );
		vehicle.container.position.set( vehicle.spherePos.x, vehicle.spherePos.y - 0.5, vehicle.spherePos.z );
		vehicle.container.rotation.y = savedCheckpointState.checkpointAngle || 0;
		vehicle.linearSpeed = 0;
		vehicle.angularSpeed = 0;
		vehicle.acceleration = 0;
		vehicle.sphereVel.set( 0, 0, 0 );
		vehicle.modelVelocity.set( 0, 0, 0 );
		cam.targetPosition.copy( vehicle.spherePos );
		resetPhysicsObstacles();

	}

	function resetPhysicsObstacles() {

		for ( const entry of resettableObstacleBodies ) {

			const body = entry?.body;
			const position = entry?.position;
			if ( ! body || ! Array.isArray( position ) ) continue;
			rigidBody.setPosition( world, body, position, false );
			rigidBody.setLinearVelocity( world, body, [ 0, 0, 0 ] );
			rigidBody.setAngularVelocity( world, body, [ 0, 0, 0 ] );

		}

	}

	function scheduleAutoRespawnVehicle() {

		if ( autoRespawnTimerId ) clearTimeout( autoRespawnTimerId );
		autoRespawnTimerId = setTimeout( () => {

			autoRespawnTimerId = null;
			respawnVehicle();

		}, 500 );

	}

	function scheduleAutoRespawnVehicle2() {

		if ( autoRespawnTimerId2 ) clearTimeout( autoRespawnTimerId2 );
		autoRespawnTimerId2 = setTimeout( () => {

			autoRespawnTimerId2 = null;
			respawnVehicle2();

		}, 500 );

	}

	function savePracticeState() {

		if ( ! practiceStartInstalled || ! vehicle?.rigidBody?.motionProperties ) return;
		savedPracticeState = {
			position: vehicle.spherePos.toArray(),
			rotationY: vehicle.container.rotation.y,
			linearVelocity: [ ...vehicle.rigidBody.motionProperties.linearVelocity ],
			angularVelocity: [ ...vehicle.rigidBody.motionProperties.angularVelocity ],
		};
		showTopMessage( 'Practice state saved (Y).', false, 1200 );

	}

	function restorePracticeState() {

		if ( ! savedPracticeState ) {

			showTopMessage( 'No practice state saved yet.', true, 1300 );
			return;

		}
		rigidBody.setPosition( world, vehicle.rigidBody, savedPracticeState.position, false );
		rigidBody.setLinearVelocity( world, vehicle.rigidBody, savedPracticeState.linearVelocity, false );
		rigidBody.setAngularVelocity( world, vehicle.rigidBody, savedPracticeState.angularVelocity, false );
		vehicle.spherePos.fromArray( savedPracticeState.position );
		vehicle.container.position.set( vehicle.spherePos.x, vehicle.spherePos.y - 0.5, vehicle.spherePos.z );
		vehicle.container.rotation.y = savedPracticeState.rotationY || 0;
		cam.targetPosition.copy( vehicle.spherePos );
		showTopMessage( 'Returned to saved practice state.', false, 1200 );

	}

	function updateArcadeBoostUi() {

		if ( ! boostUi || ! boostFill ) return;
		boostUi.style.display = arcadeBoostInstalled && ! isSplitScreen ? 'block' : 'none';
		const pct = THREE.MathUtils.clamp( boostMeter / BOOST_METER_MAX, 0, 1 );
		boostFill.style.width = `${ ( pct * 100 ).toFixed( 1 ) }%`;
		if ( boostActivateBtn ) boostActivateBtn.disabled = pct < 0.25;

	}

	function tryActivateArcadeBoost() {

		if ( ! arcadeBoostInstalled || boostMeter < 25 ) return false;
		boostMeter = Math.max( 0, boostMeter - 25 );
		applyBoostFor( vehicle, ( value ) => {

			boostActiveUntil = value;

		}, particles );
		updateArcadeBoostUi();
		return true;

	}

	function applyBoostFor( targetVehicle, setBoostActiveUntil, targetParticles = null, now = timer.getElapsed() ) {

		if ( ! targetVehicle?.rigidBody ) return;
		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		const boostLenSq = _boostForward.lengthSq();
		if ( boostLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( boostLenSq ) );
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vel[ 0 ] + _boostForward.x * BOOST_VELOCITY_DELTA,
			vel[ 1 ],
			vel[ 2 ] + _boostForward.z * BOOST_VELOCITY_DELTA,
		] );
		setBoostActiveUntil( now + BOOST_FORCE_SECONDS );
		targetParticles?.triggerBoostFx( Math.max( BOOST_EFFECT_SECONDS, BOOST_FORCE_SECONDS ) );

	}

	function updateActiveBoost( targetVehicle, boostActiveUntil, dt, now = timer.getElapsed() ) {

		if ( ! targetVehicle?.rigidBody ) return;
		if ( now >= boostActiveUntil ) return;
		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		const boostLenSq = _boostForward.lengthSq();
		if ( boostLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( boostLenSq ) );
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vel[ 0 ] + _boostForward.x * BOOST_ACCEL_PER_SECOND * dt,
			vel[ 1 ],
			vel[ 2 ] + _boostForward.z * BOOST_ACCEL_PER_SECOND * dt,
		] );

	}

	function applySurfaceBounceFor( targetVehicle ) {

		if ( ! isVehicleOnGround( targetVehicle ) ) return false;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ vel[ 0 ], Math.max( vel[ 1 ], 0 ) + BOUNCE_VERTICAL_DELTA, vel[ 2 ] ] );
		return true;

	}

	function applySurfaceKickFor( targetVehicle, direction ) {

		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		const forwardLenSq = _boostForward.lengthSq();
		if ( forwardLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( forwardLenSq ) );
		const lateralX = - _boostForward.z * direction;
		const lateralZ = _boostForward.x * direction;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vel[ 0 ] + lateralX * KICK_LATERAL_DELTA,
			vel[ 1 ],
			vel[ 2 ] + lateralZ * KICK_LATERAL_DELTA,
		] );
		return true;

	}

	function applyCustomSurfaceForceFor( targetVehicle, surfaceType ) {

		const conf = customSurfaceConfigs?.[ surfaceType ];
		if ( ! conf ) return false;
		if ( conf.noAir && ! isVehicleOnGround( targetVehicle ) ) return false;
		const amount = Math.max( 0, Number( conf.forceAmount ) || 0 );
		if ( amount <= 0 ) return false;
		const force = conf.force || {};
		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		if ( _boostForward.lengthSq() < 1e-6 ) _boostForward.set( 0, 0, 1 );
		_boostForward.normalize();
		const sideX = - _boostForward.z;
		const sideZ = _boostForward.x;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		const nextVel = [ vel[ 0 ], vel[ 1 ], vel[ 2 ] ];
		if ( force.forward ) {

			nextVel[ 0 ] += _boostForward.x * amount;
			nextVel[ 2 ] += _boostForward.z * amount;

		}
		if ( force.backward ) {

			nextVel[ 0 ] -= _boostForward.x * amount;
			nextVel[ 2 ] -= _boostForward.z * amount;

		}
		if ( force.left ) {

			nextVel[ 0 ] -= sideX * amount;
			nextVel[ 2 ] -= sideZ * amount;

		}
		if ( force.right ) {

			nextVel[ 0 ] += sideX * amount;
			nextVel[ 2 ] += sideZ * amount;

		}
		if ( force.up ) nextVel[ 1 ] += amount;
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, nextVel );
		return true;

	}

	function applyMagnetForceFor( targetVehicle, dt ) {

		if ( ! targetVehicle?.rigidBody || magnetEntries.length === 0 ) return;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		let nextVelX = vel[ 0 ];
		let nextVelY = vel[ 1 ];
		let nextVelZ = vel[ 2 ];
		let changed = false;
		for ( const magnet of magnetEntries ) {

			_magnetDelta.set( magnet.centerX - targetVehicle.spherePos.x, magnet.centerY - targetVehicle.spherePos.y, magnet.centerZ - targetVehicle.spherePos.z );
			const distance = _magnetDelta.length();
			if ( distance <= 1e-4 || distance > magnet.maxDistance ) continue;
			_magnetDir.copy( _magnetDelta ).multiplyScalar( 1 / distance );
			if ( magnet.kind === 'red' ) _magnetDir.multiplyScalar( - 1 );
			let strengthScale = 0;
			if ( distance <= magnetFullStrengthDistance ) strengthScale = 1;
			else {

				const t = THREE.MathUtils.clamp(
					( distance - magnetFullStrengthDistance ) / Math.max( 1e-6, magnet.maxDistance - magnetFullStrengthDistance ),
					0,
					1
				);
				// Curved falloff: stays stronger for longer, then fades to zero at max range.
				strengthScale = Math.pow( 1 - t, 1.6 );

			}
			const impulse = magnet.forcePerSecond * strengthScale * dt;
			nextVelX += _magnetDir.x * impulse;
			nextVelY += _magnetDir.y * impulse;
			nextVelZ += _magnetDir.z * impulse;
			changed = true;

		}
		if ( changed ) rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ nextVelX, nextVelY, nextVelZ ] );

	}


	function applyGrappleSwingFor( targetVehicle, controlKeys = {}, dt = 0 ) {

		if ( ! targetVehicle?.rigidBody ) return;
		if ( ! grappleState.line ) {

			const geo = new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3(), new THREE.Vector3() ] );
			grappleState.line = new THREE.Line( geo, new THREE.LineBasicMaterial( { color: 0xd7b6ff, transparent: true, opacity: 0.9 } ) );
			scene.add( grappleState.line );

		}
		const wantsGrapple = Boolean( controlKeys?.Space );
		if ( ! wantsGrapple ) {

			grappleState.active = false;
			grappleState.anchor = null;
			grappleState.line.visible = false;
			return;

		}
		if ( ! grappleState.active ) {

			let best = null;
			let bestDist = Infinity;
			for ( const entry of grappleEntries ) {

				const dx = entry.centerX - targetVehicle.spherePos.x;
				const dy = entry.centerY - targetVehicle.spherePos.y;
				const dz = entry.centerZ - targetVehicle.spherePos.z;
				const dist = Math.hypot( dx, dy, dz );
				if ( dist < bestDist && dist <= entry.maxDistance ) {

					best = entry;
					bestDist = dist;

				}

			}
			if ( best ) {

				grappleState.active = true;
				grappleState.anchor = best;
				grappleState.ropeLength = Math.max( 1.6, bestDist * 0.95 );

			}

		}
		if ( ! grappleState.active || ! grappleState.anchor ) {

			grappleState.line.visible = false;
			return;

		}
		const anchor = grappleState.anchor;
		const dx = anchor.centerX - targetVehicle.spherePos.x;
		const dy = anchor.centerY - targetVehicle.spherePos.y;
		const dz = anchor.centerZ - targetVehicle.spherePos.z;
		const distance = Math.hypot( dx, dy, dz );
		if ( distance > anchor.maxDistance * 1.35 ) {

			grappleState.active = false;
			grappleState.anchor = null;
			grappleState.line.visible = false;
			return;

		}
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		const dirX = dx / Math.max( 1e-5, distance );
		const dirY = dy / Math.max( 1e-5, distance );
		const dirZ = dz / Math.max( 1e-5, distance );
		if ( distance > grappleState.ropeLength ) {

			const pull = ( distance - grappleState.ropeLength ) * ( 7.5 + Math.min( 8, distance ) ) * dt;
			vel[ 0 ] += dirX * pull;
			vel[ 1 ] += dirY * pull;
			vel[ 2 ] += dirZ * pull;

		}
		targetVehicle.rigidBody.motionProperties.linearVelocity = vel;
		grappleState.line.visible = true;
		grappleState.line.geometry.setFromPoints( [
			new THREE.Vector3( targetVehicle.spherePos.x, targetVehicle.spherePos.y + 0.3, targetVehicle.spherePos.z ),
			new THREE.Vector3( anchor.centerX, anchor.centerY, anchor.centerZ ),
		] );

	}

	function setArcLinkHud( text ) {

		if ( ! arcLinkUi ) return;
		if ( ! text ) {

			arcLinkUi.style.display = 'none';
			return;

		}
		arcLinkUi.style.display = 'block';
		arcLinkUi.textContent = text;

	}

	function applyArcLinkFor( targetVehicle, state ) {

		const currentState = state && typeof state === 'object'
			? state
			: { contactKey: null, lockUntilExit: false };
		if ( ! targetVehicle?.rigidBody || arcLinkEntries.length === 0 ) return currentState;
		let nextContactKey = null;
		let triggeredEntry = null;
		for ( const entry of arcLinkEntries ) {

			if ( entry.color !== 'orange' && entry.color !== 'portal-purple' ) continue;

			const dx = entry.centerX - targetVehicle.spherePos.x;
			const dy = entry.centerY - targetVehicle.spherePos.y;
			const dz = entry.centerZ - targetVehicle.spherePos.z;
			const distSq = dx * dx + dy * dy + dz * dz;
			if ( distSq > ARC_LINK_TRIGGER_RADIUS * ARC_LINK_TRIGGER_RADIUS ) continue;
			nextContactKey = `arc:${ entry.linkId }:${ entry.color }:${ entry.gx },${ entry.gz }`;
			triggeredEntry = entry;
			break;

		}
		if ( ! nextContactKey ) return { contactKey: null, lockUntilExit: false };
		if ( currentState.lockUntilExit ) return { contactKey: nextContactKey, lockUntilExit: true };
		if ( currentState.contactKey === nextContactKey ) return { contactKey: nextContactKey, lockUntilExit: false };
		const pairCandidates = ( arcEntriesById.get( triggeredEntry.linkId ) || [] )
			.filter( ( candidate ) => candidate !== triggeredEntry );
		const pair = triggeredEntry.color === 'portal-purple'
			? pairCandidates.find( ( candidate ) => candidate.color === 'portal-yellow' )
			: pairCandidates.find( ( candidate ) => candidate.color === 'green' );
		if ( ! pair ) {

			const missingLabel = triggeredEntry.color === 'portal-purple' ? 'yellow portal endpoint' : 'green endpoint';
			setArcLinkHud( `Arc Link #${ triggeredEntry.linkId }: missing ${ missingLabel }` );
			return { contactKey: nextContactKey, lockUntilExit: false };

		}
		if ( triggeredEntry.color === 'portal-purple' ) {

			const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
			rigidBody.setPosition( world, targetVehicle.rigidBody, [ pair.centerX, pair.centerY, pair.centerZ ], false );
			rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ vel[ 0 ], vel[ 1 ], vel[ 2 ] ] );
			targetVehicle.spherePos.set( pair.centerX, pair.centerY, pair.centerZ );
			targetVehicle.container.position.set( targetVehicle.spherePos.x, targetVehicle.spherePos.y - 0.5, targetVehicle.spherePos.z );
			setArcLinkHud( `Arc Link #${ triggeredEntry.linkId }: purple portal → ${ pair.color } endpoint (velocity kept)` );
			return { contactKey: nextContactKey, lockUntilExit: true };

		}
		const tx = pair.centerX - targetVehicle.spherePos.x;
		const ty = pair.centerY - targetVehicle.spherePos.y;
		const tz = pair.centerZ - targetVehicle.spherePos.z;
		const horizontal = Math.hypot( tx, tz );
		const travelTime = THREE.MathUtils.clamp( horizontal / 12, ARC_LINK_MIN_TIME, ARC_LINK_MAX_TIME );
		const gravityFactor = Number( targetVehicle?.rigidBody?.motionProperties?.gravityFactor ) || VEHICLE_BASE_GRAVITY_FACTOR;
		const gravity = 9.81 * gravityFactor;
		const vx = tx / travelTime;
		const vz = tz / travelTime;
		const vy = ( ty + 0.5 * gravity * travelTime * travelTime ) / travelTime;
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ vx, vy, vz ] );
		setArcLinkHud( `Arc Link #${ triggeredEntry.linkId }: orange launch → green endpoint` );
		return { contactKey: nextContactKey, lockUntilExit: true };

	}

	function isVehicleOnGround( targetVehicle ) {

		const posY = targetVehicle?.spherePos?.y ?? 999;
		const verticalSpeed = Math.abs( targetVehicle?.rigidBody?.motionProperties?.linearVelocity?.[ 1 ] ?? 999 );
		return posY <= 0.62 && verticalSpeed <= 1.1;

	}

	const SPECIAL_SURFACE_HANDLERS = {
		'surface-bounce': ( targetVehicle ) => applySurfaceBounceFor( targetVehicle ),
		'surface-kick-l': ( targetVehicle ) => applySurfaceKickFor( targetVehicle, - 1 ),
		'surface-kick-r': ( targetVehicle ) => applySurfaceKickFor( targetVehicle, 1 ),
	};

	function applySpecialSurfacesFor( targetVehicle, contactState ) {

		const customTypes = Object.keys( customSurfaceConfigs || {} ).filter( ( key ) => key.startsWith( 'surface-custom-' ) );
		const specialTypes = [ ...Object.keys( SPECIAL_SURFACE_HANDLERS ), ...customTypes ];
		for ( const surfaceType of specialTypes ) {

			const currentKey = findSurfaceContactKeyForType( targetVehicle, surfaceType );
			const previousKey = contactState.get( surfaceType ) || null;
			if ( currentKey ) {

				if ( previousKey !== currentKey ) {

					const triggered = SPECIAL_SURFACE_HANDLERS[ surfaceType ]
						? SPECIAL_SURFACE_HANDLERS[ surfaceType ]( targetVehicle )
						: applyCustomSurfaceForceFor( targetVehicle, surfaceType );
					const oncePerContact = Boolean( customSurfaceConfigs?.[ surfaceType ]?.oncePerContact );
					if ( triggered ) {

						if ( oncePerContact || SPECIAL_SURFACE_HANDLERS[ surfaceType ] ) contactState.set( surfaceType, currentKey );
						else contactState.delete( surfaceType );

					} else if ( oncePerContact ) contactState.set( surfaceType, currentKey );
					else contactState.delete( surfaceType );

				}

			} else {

				contactState.delete( surfaceType );

			}

		}

	}

	respawnBtn?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		respawnVehicle();
		advancementEvents.emit('player_respawned', { source: 'respawn_button' });
		dispatchRuntimeModEvent( 'onRespawn', { type: 'respawn', source: 'respawn_button' } );

	} );
	modeMenuBtn?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		e.stopPropagation();
		setModeMenuOpen( ! modeMenuOpen );

	} );
	document.addEventListener( 'click', ( e ) => {

		if ( ! modeMenuOpen || ! modeMenu ) return;
		const target = e.target;
		if ( modeMenu.contains( target ) || modeMenuBtn?.contains( target ) || target?.closest?.( '[data-mobile-click="mode-menu-btn"]' ) ) return;
		setModeMenuOpen( false );

	} );
	pauseToggleBtn?.addEventListener( 'click', () => togglePaused() );
	hacksToggleLink?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		if ( ! hacksInstalled ) {

			window.alert( 'Install the Hacks mod from Mod Manager first.' );
			return;

		}
		if ( ! hacksPanel ) return;
		hacksPanel.style.display = hacksPanel.style.display === 'block' ? 'none' : 'block';

	} );

	function bindHackControl( node, applyFn ) {

		if ( ! node ) return;
		node.addEventListener( 'input', () => {

			applyFn();
			saveHacksState();
			applyHitboxHackVisuals();
			applyVehiclePerformance();
			updateEconomyHud();

		} );
		node.addEventListener( 'change', () => {

			applyFn();
			saveHacksState();
			applyHitboxHackVisuals();
			applyVehiclePerformance();
			updateEconomyHud();

		} );

	}

	bindHackControl( hackEnableInput, () => hacksState.enabled = Boolean( hackEnableInput?.checked ) );
	bindHackControl( hackInfiniteCoinsInput, () => hacksState.infiniteCoins = Boolean( hackInfiniteCoinsInput?.checked ) );
	bindHackControl( hackBoostAnywhereInput, () => hacksState.boostAnywhere = Boolean( hackBoostAnywhereInput?.checked ) );
	bindHackControl( hackNoLimitsInput, () => hacksState.noLimits = Boolean( hackNoLimitsInput?.checked ) );
	bindHackControl( hackAlwaysNitroInput, () => hacksState.alwaysNitro = Boolean( hackAlwaysNitroInput?.checked ) );
	bindHackControl( hackSuperJumpInput, () => hacksState.superJump = Boolean( hackSuperJumpInput?.checked ) );
	bindHackControl( hackTeleportInput, () => hacksState.teleportForward = Boolean( hackTeleportInput?.checked ) );
	bindHackControl( hackLowFrictionInput, () => hacksState.lowFriction = Boolean( hackLowFrictionInput?.checked ) );
	bindHackControl( hackInstantStopInput, () => hacksState.instantStop = Boolean( hackInstantStopInput?.checked ) );
	bindHackControl( hackCheckpointBypassInput, () => hacksState.checkpointBypass = Boolean( hackCheckpointBypassInput?.checked ) );
	bindHackControl( hackShowHitboxesInput, () => hacksState.showHitboxes = Boolean( hackShowHitboxesInput?.checked ) );
	bindHackControl( hackTimescaleInput, () => hacksState.timeScale = THREE.MathUtils.clamp( Number( hackTimescaleInput?.value ) || 1, 0.15, 1 ) );
	bindHackControl( hackGravityInput, () => hacksState.gravity = THREE.MathUtils.clamp( Number( hackGravityInput?.value ) || 1, 0.1, 2 ) );
	bindHackControl( hackRoadGripInput, () => hacksState.roadGrip = THREE.MathUtils.clamp( Number( hackRoadGripInput?.value ) || 1, 0.5, 3 ) );
	hackResetBtn?.addEventListener( 'click', () => resetHacksState() );
	boostActivateBtn?.addEventListener( 'click', () => tryActivateArcadeBoost() );

	carSelect?.addEventListener( 'change', () => {

		const selectedKey = carSelect.value;
		updateCarSelectColor();
		if ( garageCarSelect ) garageCarSelect.value = selectedKey;
		if ( models[ selectedKey ] ) {

			vehicle.setModel( models[ selectedKey ] );
			applyCarCustomization( vehicle );
			applyHitboxHackVisuals( true );

		}
		updateGarageMappingsUi();
		renderGarageVehicleCards();
		setGarageMappingStatus( `Now editing mappings for ${ CAR_STATS[ selectedKey ]?.name || 'selected car' }.` );
		applyVehiclePerformance();

	} );

	garageCarSelect?.addEventListener( 'change', () => {

		selectGarageCar( garageCarSelect.value );

	} );

	function onGarageSliderChange( key, value ) {

		const unlocks = getGarageUnlocks();
		if ( ! unlocks[ key ] ) return;
		garageMods[ key ] = clampGarageValue( value, 1.0 );
		saveGarageMods();
		updateGarageUi();

	}

	function unlockGaragePack( key ) {

		const pack = GARAGE_PACKS[ key ];
		if ( ! pack || garageUnlocked[ key ] ) return;
		if ( coins < pack.cost ) {

			window.alert( `Not enough coins for ${ pack.label }. Need ${ pack.cost }.` );
			return;

		}
		coins -= pack.cost;
		garageUnlocked[ key ] = true;
		saveEconomy();
		saveGarageMods();
		updateEconomyHud();
		updateGarageUi();

	}

	garageGripSlider?.addEventListener( 'input', () => onGarageSliderChange( 'grip', garageGripSlider.value ) );
	garageAccelSlider?.addEventListener( 'input', () => onGarageSliderChange( 'accel', garageAccelSlider.value ) );
	garageDriveSlider?.addEventListener( 'input', () => onGarageSliderChange( 'drive', garageDriveSlider.value ) );
	garageGripUnlockBtn?.addEventListener( 'click', () => unlockGaragePack( 'grip' ) );
	garageAccelUnlockBtn?.addEventListener( 'click', () => unlockGaragePack( 'accel' ) );
	garageDriveUnlockBtn?.addEventListener( 'click', () => unlockGaragePack( 'drive' ) );
	modeTabGameplayBtn?.addEventListener( 'click', () => setModeTab( 'gameplay' ) );
	modeTabGarageBtn?.addEventListener( 'click', () => setModeTab( 'garage' ) );
	modeTabAccountBtn?.addEventListener( 'click', () => setModeTab( 'account' ) );
	modeTabNavBtn?.addEventListener( 'click', () => setModeTab( 'nav' ) );
	for ( const button of graphicsQualityButtons ) {

		button.addEventListener( 'click', () => applyGraphicsQuality( button.dataset.graphicsQuality, true ) );

	}
	updateCountdownToggle();
	updateFpsHudVisibility();
	countdownToggle?.addEventListener( 'change', () => {

		countdownEnabled = Boolean( countdownToggle.checked );
		localStorage.setItem( COUNTDOWN_SETTINGS_KEY, countdownEnabled ? '1' : '0' );
		if ( ! countdownEnabled ) finishCountdown();

	} );
	fpsToggle?.addEventListener( 'change', () => {

		fpsHudVisible = Boolean( fpsToggle.checked );
		localStorage.setItem( FPS_HUD_SETTINGS_KEY, fpsHudVisible ? '1' : '0' );
		if ( fpsHudVisible ) {

			rollingFps = 0;
			fpsHudAccumulator = 0;

		}
		updateFpsHudVisibility();

	} );
	garageTargetColorInput?.addEventListener( 'input', updateGaragePaintControls );
	garageRepaintToleranceInput?.addEventListener( 'input', () => { updateGaragePaintControls(); refreshGarageViewer(); } );
	garageApplyPaintBtn?.addEventListener( 'click', () => {

		const carKey = getSelectedGarageCarKey();
		const sourceHex = selectedGarageSourceHex;
		const targetHex = String( garageTargetColorInput?.value || '#00aaff' ).toLowerCase();
		const tolerance = getGarageRepaintTolerance();
		if ( ! /^#[0-9a-fA-F]{6}$/.test( sourceHex ) ) {

			setGarageMappingStatus( 'Click a color area on the car first.', true );
			return;

		}
		if ( ! /^#[0-9a-fA-F]{6}$/.test( targetHex ) ) return;
		if ( coins < GARAGE_REPAINT_COST ) {

			setGarageMappingStatus( `Need ${ GARAGE_REPAINT_COST } coins to repaint.`, true );
			return;

		}
		const customPaintId = `custom-${ targetHex.slice( 1 ) }`;
		if ( ! GARAGE_PAINT_PALETTE.some( ( paint ) => paint.id === customPaintId ) ) {

			GARAGE_PAINT_PALETTE.push( { id: customPaintId, hex: targetHex, unlockCost: 0, finish: 'matte' } );

		}
		garageCosmetics.unlockedPaints[ customPaintId ] = true;
		const carData = getGarageCosmeticCar( carKey );
		const existing = carData.mappings.find( ( mapping ) => colorDistanceSqHex( mapping.sourceHex, sourceHex ) <= tolerance * tolerance );
		if ( existing ) {

			existing.sourceHex = sourceHex;
			existing.targetColorId = customPaintId;
			existing.tolerance = tolerance;

		} else {

			carData.mappings.push( { sourceHex, targetColorId: customPaintId, tolerance } );

		}
		if ( carData.mappings.length > 48 ) carData.mappings.shift();
		coins -= GARAGE_REPAINT_COST;
		saveEconomy();
		saveGarageMods();
		updateEconomyHud();
		selectedGarageSourceHex = '';
		hoveredGarageSourceHex = '';
		updateGarageMappingsUi();
		updateGaragePaintControls();
		applyCarCustomization( vehicle );
		refreshGarageViewer();
		setGarageMappingStatus( `Repainted ${ sourceHex } to ${ targetHex } for ${ GARAGE_REPAINT_COST } coins.` );
		if ( gameMode === 'campaign' ) incrementCampaignProgress( 'customize-car' );

	} );


	exportGhostBtn?.addEventListener( 'click', async () => {

		const code = createGhostExportCode();
		if ( ! code ) {

			window.alert( 'No ghost data yet. Finish a lap first, then export.' );
			return;

		}
		openGhostCodeTab( code );

	} );

	importGhostBtn?.addEventListener( 'click', () => {

		importGhostIntoNewTab();

	} );
	raceModeBtn?.addEventListener( 'click', () => {

		setGameMode( 'race' );
		setModeMenuOpen( false );

	} );
	stuntModeBtn?.addEventListener( 'click', () => {

		setGameMode( 'stunt' );
		setModeMenuOpen( false );

	} );
	campaignModeBtn?.addEventListener( 'click', async () => {

		setGameMode( 'campaign' );
		setModeMenuOpen( false );
		await startCampaignChallenge();

	} );
	campaignInfoBtn?.addEventListener( 'click', () => {
		window.location.href = 'campaign.html';
	} );
	accountSignupBtn?.addEventListener( 'click', async () => {

		try {

			await signupAccount();

		} catch ( e ) {

			setAccountStatus( e.message || 'Sign up failed.', true );

		}

	} );
	accountLoginBtn?.addEventListener( 'click', async () => {

		try {

			await loginAccount();

		} catch ( e ) {

			setAccountStatus( e.message || 'Login failed.', true );

		}

	} );
	accountCloudSaveBtn?.addEventListener( 'click', async () => {

		try {

			await cloudSaveProfile();

		} catch ( e ) {

			setAccountStatus( e.message || 'Cloud save failed.', true );

		}

	} );
	accountCloudLoadBtn?.addEventListener( 'click', async () => {

		try {

			await cloudLoadProfile();

		} catch ( e ) {

			setAccountStatus( e.message || 'Cloud load failed.', true );

		}

	} );

	const storedPlayerName = sanitizePlayerName( localStorage.getItem( PLAYER_NAME_KEY ) || '' );
	if ( playerNameInput ) playerNameInput.value = storedPlayerName;
	if ( namePopupInput ) namePopupInput.value = storedPlayerName;
	try {

		const rawSession = localStorage.getItem( ACCOUNT_SESSION_KEY );
		if ( rawSession ) {

			const parsedSession = JSON.parse( rawSession );
			if ( parsedSession?.token && parsedSession?.username ) {

				accountSession = {
					username: String( parsedSession.username ),
					token: String( parsedSession.token ),
				};

			}

		}

	} catch ( e ) {

		accountSession = null;

	}
	updateAccountUi();
	leaderboardToggleBtn?.addEventListener( 'click', () => {

		setLeaderboardVisible( ! leaderboardVisible );

	} );
	setLeaderboardVisible( true );
	playerNameInput?.addEventListener( 'change', () => {

		const sanitized = sanitizePlayerName( playerNameInput.value );
		playerNameInput.value = sanitized;
		localStorage.setItem( PLAYER_NAME_KEY, sanitized );

	} );
	namePopupSave?.addEventListener( 'click', async () => {

		const sanitized = sanitizePlayerName( namePopupInput?.value );
		if ( ! sanitized ) {

			window.alert( 'Please enter a name before submitting.' );
			return;

		}
		if ( playerNameInput ) playerNameInput.value = sanitized;
		localStorage.setItem( PLAYER_NAME_KEY, sanitized );
		const pendingTime = pendingLeaderboardRecord;
		closeNamePopup();
		pendingLeaderboardRecord = null;
		if ( Number.isFinite( pendingTime ) ) await submitLeaderboardTime( pendingTime, sanitized );

	} );
	namePopupSkip?.addEventListener( 'click', () => {

		pendingLeaderboardRecord = null;
		closeNamePopup();

	} );
	leaderboardRefreshBtn?.addEventListener( 'click', () => {
		fetchTrackLeaderboard();
	} );
	namePopup?.addEventListener( 'click', ( event ) => {

		if ( event.target === namePopup ) closeNamePopup();

	} );

	loadEconomy();
	loadRecentGhostHistory();
	loadHacksState();
	loadStuntStats();
	loadGarageMods();
	loadCampaignState();
	const garageParamEnabled = new URLSearchParams( window.location.search ).get( 'garage' ) === '1';
	setModeTab( garageParamEnabled ? 'garage' : 'gameplay' );
	initGarageViewer();
	if ( garageParamEnabled ) setModeMenuOpen( true );
	if ( garageCarSelect ) garageCarSelect.value = currentCarKey();
	updateCarSelectColor();
	updateGarageUi();
	applyCarCustomization( vehicle );
	applyVehiclePerformance();
	updateEconomyHud();
	updateCampaignUi();
	loadLapStats();
	updateGhostShareButtons();
	updateModeHudVisibility();
	updatePauseUi();
	fetchTrackLeaderboard();
	setInterval( () => {

		if ( leaderboardVisible ) fetchTrackLeaderboard();

	}, 480000 );
	if ( campaignParamEnabled ) setGameMode( 'campaign' );
	randomizeLapCarIfSinglePlayer();
	resetLapState( true );
	resetLapState2( true );

	const hashParams = new URLSearchParams( window.location.hash.startsWith( '#' ) ? window.location.hash.slice( 1 ) : window.location.hash );
	const importedGhost = hashParams.get( 'ghost' );
	if ( importedGhost ) {

		try {

			const payload = decodeBase64UrlJson( importedGhost );
			if ( applyImportedGhostPayload( payload ) ) {

				updateLapHud();

			}

		} catch ( e ) {

			console.warn( 'Failed to import ghost from URL hash', e );

		}

	}

	window.addEventListener( 'mousemove', ( e ) => {

		if ( ! freecamInstalled || ! freecamState.active ) return;
		const hasPointerLock = document.pointerLockElement === renderer.domElement;
		if ( ! hasPointerLock ) return;
		freecamState.yaw -= e.movementX * freecamState.mouseSensitivity;
		freecamState.pitch -= e.movementY * freecamState.mouseSensitivity;
		freecamState.pitch = THREE.MathUtils.clamp( freecamState.pitch, - Math.PI * 0.49, Math.PI * 0.49 );

	} );

	window.addEventListener( 'keydown', ( e ) => {

			const target = e.target;
			const isTypingTarget = target && (
				target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable
			);
			if ( isTypingTarget ) return;

			if ( ( e.code === 'Escape' || e.code === 'KeyP' ) && canPauseGameplay() ) {

				togglePaused();
				return;

			}

				if ( e.code === 'KeyE' ) {

					if ( hacksPanel?.style?.display === 'block' ) {

						hacksPanel.style.display = 'none';
						return;

					}

					setModeMenuOpen( ! modeMenuOpen );
					return;

			}

			if ( e.code === 'KeyH' ) {

				setUiHidden( ! uiHidden );
				return;

			}

			if ( e.code === 'Slash' && e.shiftKey ) {

				hudExtras?.toggleShortcuts();
				return;

			}

			if ( e.code === 'Escape' && hudExtras?.shortcutsOpen ) {

				hudExtras.toggleShortcuts( false );
				return;

			}

			if ( e.code === 'KeyC' ) {

				cam.toggleMode();
				return;

			}

			if ( freecamInstalled && e.code === 'KeyF' ) {

				setFreecamActive( ! freecamState.active );
				return;

			}

				if ( e.code === 'KeyR' ) {

				respawnVehicle();
				return;

			}

			if ( e.code === 'KeyP' ) {

				respawnVehicle2();
				return;

			}

			if ( checkpointRespawnInstalled && e.code === 'KeyT' ) {

				respawnToLastCheckpoint();
				return;

			}

			if ( practiceStartInstalled && e.code === 'KeyY' ) {

				if ( e.shiftKey ) restorePracticeState();
				else savePracticeState();
				return;

			}

		} );

	let hudUpdateAccumulator = 0;

	function renderFrame() {

		if ( isSplitScreen && cam2 ) {

			const width = window.innerWidth;
			const height = window.innerHeight;
			const halfH = Math.floor( height / 2 );

			renderer.setScissorTest( true );
			cam.camera.aspect = width / Math.max( 1, halfH );
			cam.camera.updateProjectionMatrix();
			renderer.setViewport( 0, halfH, width, height - halfH );
			renderer.setScissor( 0, halfH, width, height - halfH );
			renderer.render( scene, cam.camera );

			cam2.camera.aspect = width / Math.max( 1, halfH );
			cam2.camera.updateProjectionMatrix();
			renderer.setViewport( 0, 0, width, halfH );
			renderer.setScissor( 0, 0, width, halfH );
			renderer.render( scene, cam2.camera );
			renderer.setScissorTest( false );

		} else {

			renderer.render( scene, cam.camera );

		}
		hideLoadingOverlay();

	}

	function animate() {

		requestAnimationFrame( animate );

			timer.update();
			const nowMs = performance.now();
			const realFrameSeconds = Math.max( 1 / 1000, ( nowMs - lastFrameNowMs ) / 1000 );
			lastFrameNowMs = nowMs;
			const frameSeconds = timer.getDelta();
			updateFpsHud( realFrameSeconds );
			const dtBase = Math.min( frameSeconds, 1 / 15 );
			if ( paused ) {

				audio.updateMusic( realFrameSeconds, false );
				renderFrame();
				return;

			}
			const hacksActive = hacksInstalled && hacksState.enabled;
			const hackTimeScale = hacksActive ? hacksState.timeScale : 1;
			const padScale1 = Number( activePadTimeScale ) || 1;
			const padScale2 = Number( activePadTimeScale2 ) || 1;
			const padTimeScale = ( padScale1 < 1 || padScale2 < 1 )
				? Math.min( padScale1, padScale2 )
				: Math.max( padScale1, padScale2 );
			const dt = dtBase * hackTimeScale * padTimeScale * customModTimeScale;
			raceClockSeconds += dt;
			const now = raceClockSeconds;

			updateCountdownState( now );
			const controlsBlocked = modeMenuOpen || freecamState.active || replayViewerMode || countdownActive;
			const baseInput = controlsBlocked ? ZERO_DRIVE_INPUT : controls.update();
			let input = baseInput;
			for ( const runtime of runtimeMods ) {

				if ( typeof runtime?.applyFrame !== 'function' ) continue;
				try {

					const result = runtime.applyFrame( { dt, input, controls, vehicle, world, now } );
					if ( result?.input ) input = result.input;

				} catch ( error ) {

					console.warn( `Mod applyFrame failed: ${ runtime?.id || 'unknown' }`, error );

				}

			}
			if ( countdownActive ) input = ZERO_DRIVE_INPUT;
			const input2 = controls2 ? ( modeMenuOpen || replayViewerMode || countdownActive ? ZERO_DRIVE_INPUT : controls2.update() ) : null;
			let padAdjustedInput = applyPadInputModifiers( input, activePadEffect );
			if ( customModNoSteerUntil > now ) padAdjustedInput = { ...padAdjustedInput, x: 0 };
			if ( customModForceBrakeUntil > now ) padAdjustedInput = { ...padAdjustedInput, z: - 1 };
			if ( customModForceThrottleUntil > now ) padAdjustedInput = { ...padAdjustedInput, z: 1 };
			const padAdjustedInput2 = input2 ? applyPadInputModifiers( input2, activePadEffect2 ) : null;
			recordLapInput( Math.max( 0, now - lapStartSeconds ), padAdjustedInput, controls?.keys );
			if ( hacksActive && hacksState.infiniteCoins ) coins = Math.max( coins, 9999999 );
			if ( arcadeBoostInstalled ) {

				boostMeter = Math.min( BOOST_METER_MAX, boostMeter + dt * ( 7 + Math.abs( vehicle.linearSpeed ) * 14 ) );
				const boostKeyPressed = Boolean( controls?.keys?.KeyX );
				if ( boostKeyPressed && ! boostPressedLatch ) tryActivateArcadeBoost();
				boostPressedLatch = boostKeyPressed;
				updateArcadeBoostUi();

			} else boostPressedLatch = false;

		updateWorld( world, contactListener, dt );

			const wasDrifting = vehicle.driftIntensity > 0.25;
			vehicle.update( dt, padAdjustedInput );
			const isDrifting = vehicle.driftIntensity > 0.25;
			if (!wasDrifting && isDrifting) advancementEvents.emit('drift_started', {});
			if (wasDrifting && !isDrifting) advancementEvents.emit('drift_ended', {});
			const speedDisplay = Math.abs(vehicle.linearSpeed) * 150;
			if (speedDisplay > (window.__advTopSpeed || 0)) { window.__advTopSpeed = speedDisplay; advancementEvents.emit('top_speed_updated', { speed: speedDisplay }); }
			if ( vehicle2 && padAdjustedInput2 ) vehicle2.update( dt, padAdjustedInput2 );
			applySlopeConformVisual( vehicle );
			if ( vehicle2 ) applySlopeConformVisual( vehicle2 );
			if ( carHitboxMesh.visible ) carHitboxMesh.position.set( vehicle.spherePos.x, vehicle.spherePos.y, vehicle.spherePos.z );
			applyMagnetForceFor( vehicle, dt );
			if ( vehicle2 ) applyMagnetForceFor( vehicle2, dt );
			applyGrappleSwingFor( vehicle, controls?.keys, dt );
			arcLinkState = applyArcLinkFor( vehicle, arcLinkState );
			if ( vehicle2 ) arcLinkState2 = applyArcLinkFor( vehicle2, arcLinkState2 );
			updateRemotePlayerVisualsFrame( dt );
			const gravityScale1 = Number.isFinite( activePadEffect?.gravity ) ? activePadEffect.gravity : 1.0;
			const gravityScale2 = Number.isFinite( activePadEffect2?.gravity ) ? activePadEffect2.gravity : 1.0;
			if ( vehicle?.rigidBody?.motionProperties ) {

				const waterScale = isCameraTargetInWater( vehicle.spherePos ) ? WATER_GRAVITY_SCALE : 1.0;
				vehicle.rigidBody.motionProperties.gravityFactor = VEHICLE_BASE_GRAVITY_FACTOR * gravityScale1 * customModGravityScale * ( hacksActive ? hacksState.gravity : 1.0 ) * waterScale;
				applyWaterPhysicsDamping( vehicle, dt );

			}
			if ( vehicle2?.rigidBody?.motionProperties ) {

				const waterScale2 = isCameraTargetInWater( vehicle2.spherePos ) ? WATER_GRAVITY_SCALE : 1.0;
				vehicle2.rigidBody.motionProperties.gravityFactor = VEHICLE_BASE_GRAVITY_FACTOR * gravityScale2 * ( hacksActive ? hacksState.gravity : 1.0 ) * waterScale2;
				applyWaterPhysicsDamping( vehicle2, dt );

			}
			if ( hacksActive ) {

				if ( hacksState.boostAnywhere && controls?.keys?.KeyB && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					const boostDir = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
					vel[ 0 ] += boostDir.x * 0.85;
					vel[ 2 ] += boostDir.z * 0.85;
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}

				if ( hacksState.alwaysNitro && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					const boostDir = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
					vel[ 0 ] += boostDir.x * 0.22;
					vel[ 2 ] += boostDir.z * 0.22;
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}
				if ( hacksState.superJump && controls?.keys?.KeyJ && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					vel[ 1 ] = Math.max( vel[ 1 ], 4.2 );
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}
				if ( hacksState.instantStop && controls?.keys?.KeyV && vehicle?.rigidBody?.motionProperties ) {

					const vel = [ ...vehicle.rigidBody.motionProperties.linearVelocity ];
					vel[ 0 ] = 0;
					vel[ 2 ] = 0;
					rigidBody.setLinearVelocity( world, vehicle.rigidBody, vel );

				}
				if ( hacksState.teleportForward && vehicle?.rigidBody?.motionProperties ) {

					const trigger = Boolean( controls?.keys?.KeyG );
					if ( trigger && ! hackTeleportLatch ) {

						const fwd = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
						vehicle.spherePos.addScaledVector( fwd, 6.5 );
						rigidBody.setPosition( world, vehicle.rigidBody, vehicle.spherePos.toArray(), false );

					}
					hackTeleportLatch = trigger;

				}

			} else hackTeleportLatch = false;
			padContactKey = applyPadContact( vehicle, padContactKey, ( effect ) => {

				activePadEffect = effect;
				activePadTimeScale = Number.isFinite( effect?.timeScale ) ? effect.timeScale : 1;

			}, () => activePadEffect ) || null;
			activeSurfaceType = findActiveSurfaceTypeFor( vehicle );
			updateAirTrickStateFor( vehicle, activePadEffect, airTrickState, dt, () => {

				if ( ! activePadEffect?.trick ) return;
				const { trick, ...rest } = activePadEffect;
				activePadEffect = Object.keys( rest ).length ? rest : null;

			} );
			applySurfaceGrip( vehicle, activeSurfaceType, activePadEffect );
			applyVehicleScaleFromPad( vehicle, activePadEffect, carHitboxMesh );
			if ( activeSurfaceType && activeSurfaceType !== lastSurfaceNotifyType && ! activeSurfaceType.startsWith( 'pad-' ) ) showEffectPopup( `Effect applied: ${ activeSurfaceType.replace( /^surface-/, '' ).replace( /-/g, ' ' ) }` );
			lastSurfaceNotifyType = activeSurfaceType;
			if ( hacksActive && hacksState.checkpointBypass ) {

				for ( const checkpoint of checkpointStates ) checkpoint.passedThisLap = true;

			}
		if ( vehicle2 ) {

			padContactKey2 = applyPadContact( vehicle2, padContactKey2, ( effect ) => {

				activePadEffect2 = effect;
				activePadTimeScale2 = Number.isFinite( effect?.timeScale ) ? effect.timeScale : 1;

			}, () => activePadEffect2 ) || null;
			activeSurfaceType2 = findActiveSurfaceTypeFor( vehicle2 );
				updateAirTrickStateFor( vehicle2, activePadEffect2, airTrickState2, dt, () => {

					if ( ! activePadEffect2?.trick ) return;
					const { trick, ...rest } = activePadEffect2;
					activePadEffect2 = Object.keys( rest ).length ? rest : null;

				} );
			applySurfaceGrip( vehicle2, activeSurfaceType2, activePadEffect2 );
			applyVehicleScaleFromPad( vehicle2, activePadEffect2 );
			if ( activeSurfaceType2 && activeSurfaceType2 !== lastSurfaceNotifyType2 && ! activeSurfaceType2.startsWith( 'pad-' ) ) showEffectPopup( `Effect applied: ${ activeSurfaceType2.replace( /^surface-/, '' ).replace( /-/g, ' ' ) }` );
			lastSurfaceNotifyType2 = activeSurfaceType2;

		}
		updateActiveBoost( vehicle, boostActiveUntil, dt, now );
		if ( vehicle2 ) updateActiveBoost( vehicle2, boostActiveUntil2, dt, now );
		const activeBoostContactKey = findLegacyBoostContactKeyFor( vehicle ) || findBoostSurfaceContactKeyFor( vehicle );
		if ( activeBoostContactKey ) {

			if ( boostContactCell !== activeBoostContactKey ) {

				applyBoostFor( vehicle, ( value ) => {

					boostActiveUntil = value;

				}, particles, now );
				boostContactCell = activeBoostContactKey;
				if ( activeBoostContactKey !== lastBoostNotifyKey ) showEffectPopup( 'Effect applied: Boost' );
				lastBoostNotifyKey = activeBoostContactKey;

			}

		} else {

			boostContactCell = null;
			lastBoostNotifyKey = null;

		}

		applySpecialSurfacesFor( vehicle, specialSurfaceContactState );

		if ( vehicle2 ) {

			const activeBoostContactKey2 = findLegacyBoostContactKeyFor( vehicle2 ) || findBoostSurfaceContactKeyFor( vehicle2 );
			if ( activeBoostContactKey2 ) {

				if ( boostContactCell2 !== activeBoostContactKey2 ) {

					applyBoostFor( vehicle2, ( value ) => {

						boostActiveUntil2 = value;

					}, particles2, now );
					boostContactCell2 = activeBoostContactKey2;
					if ( activeBoostContactKey2 !== lastBoostNotifyKey2 ) showEffectPopup( 'Effect applied: Boost' );
					lastBoostNotifyKey2 = activeBoostContactKey2;

				}

			} else {

				boostContactCell2 = null;
				lastBoostNotifyKey2 = null;

			}

			applySpecialSurfacesFor( vehicle2, specialSurfaceContactState2 );

		}

		dirLight.position.set(
			vehicle.spherePos.x + 11.4,
			15,
			vehicle.spherePos.z - 5.3
		);

		if ( freecamState.active ) scene.fog = null;
		else if ( scene.fog !== gameplayFog ) scene.fog = gameplayFog;
		if ( freecamState.active ) updateFreecam( dt );
		else if ( ! replayViewerMode ) {

			const shouldLockYaw = airTrickState.active && isVehicleAirborne( vehicle );
			if ( shouldLockYaw ) {

				if ( ! camYawLockActive ) {

					camYawLockEuler.setFromQuaternion( vehicle.container.quaternion, 'YXZ' );
					camYawLockValue = camYawLockEuler.y;
					camYawLockActive = true;

				}
				camYawLockQuat.setFromEuler( camYawLockEuler.set( 0, camYawLockValue, 0, 'YXZ' ) );
				cam.update( dt, vehicle.spherePos, camYawLockQuat, { speedRatio: Math.abs( vehicle.linearSpeed ) / Math.max( 0.01, vehicle.topSpeed ), driftIntensity: vehicle.driftIntensity, underwaterCamera: updateWaterCameraState( waterCameraState1, vehicle.spherePos, dt ) } );

			} else {

				camYawLockActive = false;
				cam.update( dt, vehicle.spherePos, vehicle.container.quaternion, { speedRatio: Math.abs( vehicle.linearSpeed ) / Math.max( 0.01, vehicle.topSpeed ), driftIntensity: vehicle.driftIntensity, underwaterCamera: updateWaterCameraState( waterCameraState1, vehicle.spherePos, dt ) } );

			}

		}
		if ( cam2 && vehicle2 ) {

			const shouldLockYaw2 = airTrickState2.active && isVehicleAirborne( vehicle2 );
			if ( shouldLockYaw2 ) {

				if ( ! camYawLockActive2 ) {

					camYawLockEuler2.setFromQuaternion( vehicle2.container.quaternion, 'YXZ' );
					camYawLockValue2 = camYawLockEuler2.y;
					camYawLockActive2 = true;

				}
				camYawLockQuat2.setFromEuler( camYawLockEuler2.set( 0, camYawLockValue2, 0, 'YXZ' ) );
				cam2.update( dt, vehicle2.spherePos, camYawLockQuat2, { speedRatio: Math.abs( vehicle2.linearSpeed ) / Math.max( 0.01, vehicle2.topSpeed ), driftIntensity: vehicle2.driftIntensity, underwaterCamera: updateWaterCameraState( waterCameraState2, vehicle2.spherePos, dt ) } );

			} else {

				camYawLockActive2 = false;
				cam2.update( dt, vehicle2.spherePos, vehicle2.container.quaternion, { speedRatio: Math.abs( vehicle2.linearSpeed ) / Math.max( 0.01, vehicle2.topSpeed ), driftIntensity: vehicle2.driftIntensity, underwaterCamera: updateWaterCameraState( waterCameraState2, vehicle2.spherePos, dt ) } );

			}

		}
		if ( customModParticleBurstSeconds > 0 ) {
			particles?.triggerBoostFx?.( customModParticleBurstSeconds );
			customModParticleBurstSeconds = 0;
		}
		particles.update( dt, vehicle );
		particles2?.update( dt, vehicle2 );
		audio.updateMusic( dt, ! document.getElementById( 'home-landing' )?.classList.contains( 'visible' ) && ! modeMenuOpen && ! replayViewerMode );
		audio.update( dt, vehicle.linearSpeed, padAdjustedInput.z, vehicle.driftIntensity );
		const speedRatioFx = THREE.MathUtils.clamp( Math.abs( vehicle.linearSpeed ) / Math.max( 0.01, vehicle.topSpeed ), 0, 1.8 );
		const driftFx = THREE.MathUtils.clamp( vehicle.driftIntensity, 0, 1 );
		if ( bloomPass ) {
			bloomPass.strength = getGraphicsPreset().bloomStrength + ( speedRatioFx * 0.01 ) + ( driftFx * 0.005 );
			bloomPass.radius = getGraphicsPreset().bloomRadius + ( speedRatioFx * 0.01 );
		}
		renderer.toneMappingExposure = THREE.MathUtils.lerp( renderer.toneMappingExposure, baseWeatherLight.exposure + ( speedRatioFx * 0.045 ), Math.min( 1, dt * 2.8 ) );
		if ( scene.fog ) {
			const nearBase = groundSize * weatherConfig.fogNearMul;
			const farBase = groundSize * weatherConfig.fogFarMul;
			scene.fog.near = THREE.MathUtils.lerp( scene.fog.near, nearBase * customModFogStrength * ( 1 - speedRatioFx * 0.08 ), Math.min( 1, dt * 3 ) );
			scene.fog.far = THREE.MathUtils.lerp( scene.fog.far, farBase * customModFogStrength * ( 1 + speedRatioFx * 0.06 ), Math.min( 1, dt * 3 ) );
		}
		const motionBlurPx = getGraphicsPreset().label === 'High'
			? Math.max( 0, ( speedRatioFx - 0.8 ) * 1.05 )
			: Math.max( 0, ( speedRatioFx - 0.96 ) * 0.7 );
		const vibrance = 1.08 + ( driftFx * 0.04 ) + ( speedRatioFx * 0.025 );
		renderer.domElement.style.filter = `saturate(${ vibrance.toFixed( 3 ) }) contrast(1.07)`;
		if ( speedBlurVignette ) {
			const projected = vehicle.spherePos.clone().project( cam.camera );
			const px = ( projected.x * 0.5 + 0.5 ) * 100;
			const py = ( - projected.y * 0.5 + 0.5 ) * 100;
			speedBlurVignette.style.setProperty( '--car-x', `${ THREE.MathUtils.clamp( px, 8, 92 ).toFixed( 2 ) }%` );
			speedBlurVignette.style.setProperty( '--car-y', `${ THREE.MathUtils.clamp( py, 12, 88 ).toFixed( 2 ) }%` );
			speedBlurVignette.style.opacity = motionBlurPx > 0.02 ? '1' : '0';
			const blurVignette = Math.min( 0.65, motionBlurPx );
			speedBlurVignette.style.backdropFilter = `blur(${ blurVignette.toFixed( 3 ) }px)`;
			speedBlurVignette.style.webkitBackdropFilter = `blur(${ blurVignette.toFixed( 3 ) }px)`;
		}
		skyUniforms.time.value = now;
		skyUniforms.vibrance.value = THREE.MathUtils.lerp( skyUniforms.vibrance.value, 0.2 + ( speedRatioFx * 0.18 ) + ( driftFx * 0.1 ), Math.min( 1, dt * 2.4 ) );
		updateWeatherFx( dt, now );
		crashShakeTime = Math.max( 0, crashShakeTime - dt );
		if ( crashShakeTime > 0 && crashShakeStrength > 0 ) {
			const impactEnvelope = crashShakeTime / 0.18;
			const impulse = crashShakeStrength * impactEnvelope;
			cam.camera.position.x += ( Math.random() - 0.5 ) * impulse;
			cam.camera.position.y += ( Math.random() - 0.5 ) * impulse * 0.7;
			cam.camera.rotation.z += ( Math.random() - 0.5 ) * impulse * 0.08;
			crashShakeStrength = Math.max( 0, crashShakeStrength - dt * 0.6 );
		}
		if ( customModShakeUntil > now && customModShakeIntensity > 0 ) {
			const shake = Math.min( 0.28, customModShakeIntensity * 0.025 );
			cam.camera.position.x += ( Math.random() - 0.5 ) * shake;
			cam.camera.position.y += ( Math.random() - 0.5 ) * shake;
		}
		if ( customModShakeUntil <= now ) customModShakeIntensity = 0;

		for ( let checkpointIndex = 0; checkpointIndex < checkpointStates.length; checkpointIndex ++ ) {

			const checkpoint = checkpointStates[ checkpointIndex ];

			const localX = ( ( vehicle.spherePos.x - checkpoint.centerX ) * checkpoint.cosA ) + ( ( vehicle.spherePos.z - checkpoint.centerZ ) * checkpoint.sinA );
			const localZ = ( - ( vehicle.spherePos.x - checkpoint.centerX ) * checkpoint.sinA ) + ( ( vehicle.spherePos.z - checkpoint.centerZ ) * checkpoint.cosA );

			let crossedCheckpoint = false;
			if ( checkpoint.hasPrevSample ) {

				const z0 = checkpoint.lastLocalZ;
				const z1 = localZ;
				const crossedPlane = ( z0 < 0 && z1 > 0 ) || ( z0 > 0 && z1 < 0 );

				if ( crossedPlane ) {

					const t = z0 / ( z0 - z1 );
					const xCross = THREE.MathUtils.lerp( checkpoint.lastLocalX, localX, t );
					crossedCheckpoint = t >= 0 && t <= 1 && Math.abs( xCross ) <= checkpoint.halfExtent;

				}

			}

			if ( crossedCheckpoint && ! checkpoint.passedThisLap ) {

				checkpoint.passedThisLap = true;
				activePadEffect = null;
				activePadTimeScale = 1;
				padContactKey = null;
				if ( checkpointRespawnInstalled ) saveCheckpointState( checkpoint );
				dispatchRuntimeModEvent( 'onCheckpoint', { type: 'checkpoint', checkpointIndex, checkpointNumber: checkpointIndex + 1, lapTime: now - lapStartSeconds } );
				const ghostTime = getFastestVisibleGhostCheckpointTime( checkpointIndex );
				if ( Number.isFinite( ghostTime ) ) {

					const currentSplit = now - lapStartSeconds;
					checkpointDeltaText = formatDeltaSigned( currentSplit - ghostTime );
					showTopMessage( `CP ${ checkpointIndex + 1}: ${ checkpointDeltaText }`, checkpointDeltaText.startsWith( '+' ), 1200 );

				}

			}
			checkpoint.lastLocalX = localX;
			checkpoint.lastLocalZ = localZ;
			checkpoint.hasPrevSample = true;

		}

		if ( vehicle2 ) {

			for ( const checkpoint of checkpointStates2 ) {

				const localX = ( ( vehicle2.spherePos.x - checkpoint.centerX ) * checkpoint.cosA ) + ( ( vehicle2.spherePos.z - checkpoint.centerZ ) * checkpoint.sinA );
				const localZ = ( - ( vehicle2.spherePos.x - checkpoint.centerX ) * checkpoint.sinA ) + ( ( vehicle2.spherePos.z - checkpoint.centerZ ) * checkpoint.cosA );

				let crossedCheckpoint = false;
				if ( checkpoint.hasPrevSample ) {

					const z0 = checkpoint.lastLocalZ;
					const z1 = localZ;
					const crossedPlane = ( z0 < 0 && z1 > 0 ) || ( z0 > 0 && z1 < 0 );

					if ( crossedPlane ) {

						const t = z0 / ( z0 - z1 );
						const xCross = THREE.MathUtils.lerp( checkpoint.lastLocalX, localX, t );
						crossedCheckpoint = t >= 0 && t <= 1 && Math.abs( xCross ) <= checkpoint.halfExtent;

					}

				}

				if ( crossedCheckpoint ) {

					checkpoint.passedThisLap = true;
					activePadEffect2 = null;
					activePadTimeScale2 = 1;
					padContactKey2 = null;
					if ( checkpointRespawnInstalled ) saveCheckpointState( checkpoint );

				}
				checkpoint.lastLocalX = localX;
				checkpoint.lastLocalZ = localZ;
				checkpoint.hasPrevSample = true;

			}

		}

		if ( finishData ) {

			const localX = ( ( vehicle.spherePos.x - finishData.centerX ) * finishData.cosA ) + ( ( vehicle.spherePos.z - finishData.centerZ ) * finishData.sinA );
			const localZ = ( - ( vehicle.spherePos.x - finishData.centerX ) * finishData.sinA ) + ( ( vehicle.spherePos.z - finishData.centerZ ) * finishData.cosA );
			const startLocalX = ( ( vehicle.spherePos.x - startGateData.centerX ) * startGateData.cosA ) + ( ( vehicle.spherePos.z - startGateData.centerZ ) * startGateData.sinA );
			const startLocalZ = ( - ( vehicle.spherePos.x - startGateData.centerX ) * startGateData.sinA ) + ( ( vehicle.spherePos.z - startGateData.centerZ ) * startGateData.cosA );
			const inStartCell = Math.abs( startLocalX ) < startGateData.halfExtent && Math.abs( startLocalZ ) < startGateData.halfExtent;

			if ( ! hasLeftStartZone && ! inStartCell ) {

				hasLeftStartZone = true;

			}

			let crossedFinish = false;

			if ( hasPrevFinishSample ) {

				const z0 = lastLocalZ;
				const z1 = localZ;
				const crossedPlane = ( z0 < 0 && z1 > 0 ) || ( z0 > 0 && z1 < 0 );

				if ( crossedPlane ) {

					const t = z0 / ( z0 - z1 );
					const xCross = THREE.MathUtils.lerp( lastLocalX, localX, t );
					crossedFinish = t >= 0 && t <= 1 && Math.abs( xCross ) <= finishData.halfExtent;

				}

			}

			const allCheckpointsPassed = checkpointStates.every( ( checkpoint ) => checkpoint.passedThisLap );
			if ( hasLeftStartZone && allCheckpointsPassed && crossedFinish ) {

					const completedLap = now - lapStartSeconds;
					const lapInvalid = currentLapInvalidatedByPause;
					const previousBestLap = bestLapSeconds;
					const isNewBest = ! lapInvalid && ( bestLapSeconds === null || completedLap < bestLapSeconds );
					lastLapSeconds = completedLap;
					if ( ! lapInvalid ) {

						bestLapSeconds = bestLapSeconds === null ? completedLap : Math.min( bestLapSeconds, completedLap );
						if ( isNewBest ) publishMultiplayerBestLap( bestLapSeconds );
						shareImageDataUrl = createShareSnapshot( bestLapSeconds );

					} else {

						showTopMessage( 'Lap completed, but paused runs are leaderboard invalid.', true, 2400 );

					}
				if ( isNewBest && currentLapGhostSamples.length > 1 ) {

					bestLapGhostSamples.length = 0;
					const t0 = currentLapGhostSamples[ 0 ].t;
					for ( const sample of currentLapGhostSamples ) bestLapGhostSamples.push( { ...sample, t: sample.t - t0 } );
					bestGhostDuration = Math.max( 1e-4, completedLap - t0 );
					bestGhostCarKey = currentCarKey();
					bestGhostCosmetics = buildGhostCosmeticsSnapshot( bestGhostCarKey );
					bestGhostCheckpointTimes = computeCheckpointCrossTimes( bestLapGhostSamples );
					if ( models[ bestGhostCarKey ] ) createGhostModel( models[ bestGhostCarKey ], bestGhostCosmetics );
					updateGhostShareButtons();

				}
				if ( isNewBest && currentLapInputFrames.length > 1 ) {

					bestLapInputFrames = currentLapInputFrames.map( ( sample ) => ( {
						t: sample.t,
						x: sample.x,
						z: sample.z,
						keys: sample.keys || { left: false, right: false, forward: false, back: false },
					} ) );

				}
				if ( currentLapInputFrames.length > 1 ) {

					latestLapInputFrames = currentLapInputFrames.map( ( sample ) => ( {
						t: sample.t,
						x: sample.x,
						z: sample.z,
						keys: sample.keys || { left: false, right: false, forward: false, back: false },
					} ) );

				}
				dispatchRuntimeModEvent( 'onLapFinish', { type: 'lapFinish', lapTime: completedLap, bestLapSeconds, lapNumber, isNewBest, lapInvalid } );
				if ( currentLapGhostSamples.length > 1 ) {

					const t0 = currentLapGhostSamples[ 0 ].t;
					const normalized = currentLapGhostSamples.map( ( sample ) => ( { ...sample, t: sample.t - t0 } ) );
					const runDuration = Math.max( 1e-4, completedLap - t0 );
					recentGhostHistory.unshift( {
						samples: normalized,
						duration: runDuration,
						car: currentCarKey(),
						cosmetics: buildGhostCosmeticsSnapshot( currentCarKey() ),
						checkpointTimes: computeCheckpointCrossTimes( normalized ),
					} );
					if ( recentGhostHistory.length > 12 ) recentGhostHistory.length = 12;
					saveRecentGhostHistory();
					rebuildRecentGhostVisuals();
					rebuildGhostSpreadLine();

				}
				if ( isNewBest && ! isSplitScreen ) submitLeaderboardTime( completedLap );
				if ( ! lapInvalid && editorQuickTestEnabled && editorReturnParam && ! isSplitScreen && currentLapGhostSamples.length > 1 ) {

					try {

						const t0 = currentLapGhostSamples[ 0 ].t;
						const normalizedSamples = currentLapGhostSamples.map( ( sample ) => ( {
							x: sample.x,
							z: sample.z,
							t: sample.t - t0,
						} ) );
						localStorage.setItem( QUICK_TEST_GHOST_KEY, JSON.stringify( {
							samples: normalizedSamples,
							duration: completedLap,
							at: Date.now(),
						} ) );
						localStorage.setItem( QUICK_TEST_GHOST_MAP_KEY, editorGhostMapHash );

					} catch ( error ) {

						console.warn( 'Failed to persist quick-test ghost', error );

					}
					window.location.href = editorReturnParam;
					return;

				}
						lapNumber ++;
					resetMovingObstacles( movingObstacleState, now );
						lapStartSeconds = now;
						currentLapInvalidatedByPause = false;
						checkpointDeltaText = '';
						resetCurrentLapGhost();
						resetCurrentLapInputs();
						recordGhostSample( 0, true );
					updateGhostPlayback( 0 );
					updateLeaderboardGhostPlayback( 0 );
					updateRecentGhostPlayback( 0 );
				hasLeftStartZone = false;
				for ( const checkpoint of checkpointStates ) {

					checkpoint.passedThisLap = false;

				}
				resetPhysicsObstacles();
				if ( shouldAutoRespawnAfterLap ) scheduleAutoRespawnVehicle();
					saveLapStats();
					rewardCoinsForLap( completedLap );
					if ( ! lapInvalid && competitionParamEnabled && competitionReturnParam && ! isSplitScreen ) {
						const competitionResultUrl = new URL( competitionReturnParam, window.location.href );
						competitionResultUrl.searchParams.set( 'competitionResult', '1' );
						competitionResultUrl.searchParams.set( 'time', String( Number( completedLap ) ) );
						if ( Number.isFinite( competitionTierParam ) ) competitionResultUrl.searchParams.set( 'tier', String( competitionTierParam ) );
						if ( competitionSeedParam ) competitionResultUrl.searchParams.set( 'seed', competitionSeedParam );
						window.location.href = competitionResultUrl.toString();
						return;
					}
						if ( gameMode === 'stunt' ) {

						let lapBonus = Math.max( 0, Math.round( ( 65 - completedLap ) * 2 ) );
						if ( isNewBest ) lapBonus += 70;
						else if ( Number.isFinite( previousBestLap ) && completedLap <= previousBestLap * 1.03 ) lapBonus += 30;
						const lapTotalWithBonus = stuntPoints + lapBonus;
							if ( lapTotalWithBonus > bestStuntPoints ) {

								bestStuntPoints = lapTotalWithBonus;
								saveStuntStats();
								updateGarageUi();

							}
						stuntPoints = 0;
						stuntReasonText = '--';
						stuntReasonTimer = 0;
						resetStuntChain();
						if ( lapBonus > 0 ) {

							stuntReasonText = `Fast lap +${ lapBonus}`;
							stuntReasonTimer = 1.6;

						}
							updateStuntPointsHud();

						}
						if ( gameMode === 'campaign' ) {

							if ( campaignState?.stageType === 'lap-default' && !mapParam ) incrementCampaignProgress( 'lap-default' );
							if ( campaignState?.stageType === 'play-share' && mapParam ) incrementCampaignProgress( 'play-share' );
							if ( campaignState?.stageType === 'beat-authors' && Number.isFinite( campaignTargetAuthorSeconds ) && completedLap <= campaignTargetAuthorSeconds ) incrementCampaignProgress( 'beat-authors' );
							if ( campaignState?.stageType === 'beat-records' && Array.isArray( currentTrackLeaderboardRows ) && currentTrackLeaderboardRows.length > 0 && completedLap <= Number( currentTrackLeaderboardRows[ 0 ]?.timeSeconds ) ) incrementCampaignProgress( 'beat-records' );
							if ( campaignState?.stageType === 'set-record' && Array.isArray( currentTrackLeaderboardRows ) && currentTrackLeaderboardRows.length > 0 && completedLap <= Number( currentTrackLeaderboardRows[ 0 ]?.timeSeconds ) ) incrementCampaignProgress( 'set-record' );
							if ( campaignState?.stageType === 'podium' && Array.isArray( currentTrackLeaderboardRows ) && currentTrackLeaderboardRows.length >= 3 && completedLap <= Number( currentTrackLeaderboardRows[ 2 ]?.timeSeconds ) ) incrementCampaignProgress( 'podium' );
							if ( campaignState?.stageType === 'endurance-laps' ) incrementCampaignProgress( 'endurance-laps' );
							if ( campaignState?.stageType === 'mastery' ) incrementCampaignProgress( 'mastery' );

						}

				}

			lastLocalX = localX;
			lastLocalZ = localZ;
			hasPrevFinishSample = true;

		}

		if ( finishData && vehicle2 ) {

			const localX = ( ( vehicle2.spherePos.x - finishData.centerX ) * finishData.cosA ) + ( ( vehicle2.spherePos.z - finishData.centerZ ) * finishData.sinA );
			const localZ = ( - ( vehicle2.spherePos.x - finishData.centerX ) * finishData.sinA ) + ( ( vehicle2.spherePos.z - finishData.centerZ ) * finishData.cosA );
			const startLocalX = ( ( vehicle2.spherePos.x - startGateData.centerX ) * startGateData.cosA ) + ( ( vehicle2.spherePos.z - startGateData.centerZ ) * startGateData.sinA );
			const startLocalZ = ( - ( vehicle2.spherePos.x - startGateData.centerX ) * startGateData.sinA ) + ( ( vehicle2.spherePos.z - startGateData.centerZ ) * startGateData.cosA );
			const inStartCell = Math.abs( startLocalX ) < startGateData.halfExtent && Math.abs( startLocalZ ) < startGateData.halfExtent;

			if ( ! hasLeftStartZone2 && ! inStartCell ) hasLeftStartZone2 = true;

			let crossedFinish = false;
			if ( hasPrevFinishSample2 ) {

				const z0 = lastLocalZ2;
				const z1 = localZ;
				const crossedPlane = ( z0 < 0 && z1 > 0 ) || ( z0 > 0 && z1 < 0 );
				if ( crossedPlane ) {

					const t = z0 / ( z0 - z1 );
					const xCross = THREE.MathUtils.lerp( lastLocalX2, localX, t );
					crossedFinish = t >= 0 && t <= 1 && Math.abs( xCross ) <= finishData.halfExtent;

				}

			}

			const allCheckpointsPassed2 = checkpointStates2.every( ( checkpoint ) => checkpoint.passedThisLap );
			if ( hasLeftStartZone2 && allCheckpointsPassed2 && crossedFinish ) {

				const completedLap2 = now - lapStartSeconds2;
				lastLapSeconds2 = completedLap2;
				bestLapSeconds2 = bestLapSeconds2 === null ? completedLap2 : Math.min( bestLapSeconds2, completedLap2 );
				lapNumber2 ++;
				lapStartSeconds2 = now;
				hasLeftStartZone2 = false;
				for ( const checkpoint of checkpointStates2 ) checkpoint.passedThisLap = false;
				resetPhysicsObstacles();
				if ( shouldAutoRespawnAfterLap ) scheduleAutoRespawnVehicle2();

			}

			lastLocalX2 = localX;
			lastLocalZ2 = localZ;
			hasPrevFinishSample2 = true;

		}

		lapSeconds = countdownActive ? 0 : now - lapStartSeconds;
		if ( vehicle2 ) lapSeconds2 = countdownActive ? 0 : now - lapStartSeconds2;
		updateMovingObstacles( movingObstacleState, now, [ vehicle, vehicle2 ] );
		recordGhostSample( lapSeconds );
		updateGhostPlayback( lapSeconds );
		updateLeaderboardGhostPlayback( lapSeconds );
		updateRecentGhostPlayback( lapSeconds );
		const stuntScoringActive = gameMode === 'stunt' || ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' );
		if ( stuntScoringActive ) {

			const speedRatio = vehicle.topSpeed > 0 ? Math.abs( vehicle.linearSpeed ) / vehicle.topSpeed : 0;
			const overspeed = speedRatio > 1.0;
			const hasBoostSource = activeSurfaceType === 'surface-wood' || activeSurfaceType === 'surface-boost' || now < boostActiveUntil;
			const isAirborne = vehicle.spherePos.y > 0.78 || Math.abs( vehicle.sphereVel.y ) > 1.1;
			const hardTurn = Math.abs( input.x ) > 0.35 && speedRatio > 0.6;
			const drifting = vehicle.driftIntensity > 0.45;
			const activeTrick = drifting || ( overspeed && hasBoostSource ) || isAirborne || hardTurn;
			if ( drifting ) addStuntPoints( ( vehicle.driftIntensity - 0.45 ) * 46 * dt, 'Drift' );
			if ( overspeed && hasBoostSource ) addStuntPoints( 38 * dt, 'Speed burst' );
			if ( hardTurn ) addStuntPoints( 18 * dt, 'Corner carve' );
			if ( isAirborne ) {

				stuntAirTime += dt;
				addStuntPoints( 40 * dt, vehicle.spherePos.y > 1.35 ? 'Big jump' : 'Air' );

			} else if ( stuntAirTime > 0.2 ) {

				const landingBonus = 14 + Math.min( 80, stuntAirTime * 55 );
				addStuntPoints( landingBonus, 'Landing');
				stuntAirTime = 0;

			} else {

				stuntAirTime = 0;

			}

			if ( activeTrick ) {

				stuntComboTimer = Math.min( 2.4, stuntComboTimer + dt * 1.2 );
				stuntCombo = Math.min( 3.0, stuntCombo + dt * 0.35 );

			} else {

				stuntComboTimer = Math.max( 0, stuntComboTimer - dt );
				if ( stuntComboTimer === 0 ) stuntCombo = Math.max( 1, stuntCombo - dt * 0.8 );

			}

		}
		if ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' && stuntPoints >= campaignState.goal ) {

			campaignState.progress = campaignState.goal;
			saveCampaignState();
			completeCampaignStage();
			updateCampaignUi();
			stuntPoints = 0;
			stuntReasonText = '--';
			stuntReasonTimer = 0;
			resetStuntChain();

		}
		if ( stuntReasonTimer > 0 ) {

			stuntReasonTimer = Math.max( 0, stuntReasonTimer - dt );
			if ( stuntReasonTimer === 0 ) stuntReasonText = '--';

		}
		hudUpdateAccumulator += dt;
		if ( hudUpdateAccumulator >= 0.08 ) {

			hudUpdateAccumulator = 0;
			updateLapHud();
			updateLapHud2();
			updateStuntPointsHud();
			hudExtras?.update();
			hudExtras?.setVisible( gameMode === 'race' || gameMode === 'stunt' );

		}

		renderFrame();

	}

	rebuildRecentGhostVisuals();
	animate();

}

init().then( () => {

	setLoadingStatus( 'Ready to race!', 'ready' );
	window.__racingGameBooting = false;
	hideLoadingOverlay();

} ).catch( ( error ) => {

	console.error( 'Failed to initialize game', error );
	showLoadingError( error );

} );
