
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'; 
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, TRACK_CELLS, ORIENT_DEG, CELL_RAW, GRID_SCALE } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { GameAudio } from './Audio.js';


const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType, preserveDrawingBuffer: true } );
const MAX_PIXEL_RATIO = 1.5;
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, MAX_PIXEL_RATIO ) );
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
bloomPass.strength = 0.02;
bloomPass.radius = 0.02;
bloomPass.threshold = 0.5;

renderer.setEffects( [ bloomPass ] );

document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const dirLight = new THREE.DirectionalLight( 0xffffff, 5 );
dirLight.position.set( 11.4, 15, -5.3 );
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar( 4096 );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 1.5 );
scene.add( hemiLight );


window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );

} );

const loader = new GLTFLoader();
const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'decoration-empty', 'decoration-forest', 'decoration-tents',
];

const models = {};
const CAR_STATS = {
	'vehicle-truck-yellow': { name: 'Yellow', speed: 7, accel: 7, perf: { topSpeed: 1.0, accelRate: 6.0, driveForce: 100.0 } },
	'vehicle-truck-green': { name: 'Green', speed: 6, accel: 9, perf: { topSpeed: 0.92, accelRate: 7.8, driveForce: 108.0 } },
	'vehicle-truck-purple': { name: 'Purple', speed: 9, accel: 5, perf: { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 } },
	'vehicle-truck-red': { name: 'Red', speed: 8, accel: 6, perf: { topSpeed: 1.05, accelRate: 5.5, driveForce: 102.0 } },
};
const ENGINE_MULTS = [ 1, 1.025, 1.05, 1.075, 1.1 ];
const ENGINE_UPGRADE_COST = 100;
const MAX_EFFECTIVE_TOP_SPEED = 1.8;
const BOOST_VELOCITY_DELTA = 8.2;
const BOOST_EFFECT_SECONDS = 1.0;
const BOOST_FORCE_SECONDS = 0.45;
const BOOST_ACCEL_PER_SECOND = 16.5;
const VEHICLE_SURFACE_RADIUS = 0.5;
const SURFACE_EFFECTS = {
	'surface-wood': { grip: 0.9, drag: 1.35, accel: 1.0, drive: 1.55 },
	'surface-ice': { grip: 0.4, drag: 0.58, accel: 0.45, drive: 0.8 },
	'surface-sand': { grip: 0.72, drag: 2.6, accel: 0.35, drive: 0.5 },
	'surface-grip': { grip: 1.45, drag: 1.08, accel: 1.1, drive: 1.25 },
	'surface-mud': { grip: 0.82, drag: 2.15, accel: 0.58, drive: 0.68 },
	'surface-glass': { grip: 0.25, drag: 0.74, accel: 0.5, drive: 0.62 },
	'surface-slow': { grip: 0.95, drag: 3.2, accel: 0.3, drive: 0.4 },
	'surface-turbo': { grip: 0.95, drag: 0.85, accel: 1.35, drive: 1.4 },
};
const BOUNCE_VERTICAL_DELTA = 7.2;
const POP_VERTICAL_DELTA = 4.6;
const KICK_LATERAL_DELTA = 7.4;
const LAUNCH_FORWARD_DELTA = 10.5;
const REVERSE_FORWARD_DELTA = - 8.5;
const SPIN_YAW_DELTA = 5.4;
const WEATHER_PRESETS = {
	clear: { bg: 0xadb2ba, fogNearMul: 0.4, fogFarMul: 0.8, sun: 5.0, hemi: 1.5, exposure: 1.0 },
	cloudy: { bg: 0x9aa4b2, fogNearMul: 0.32, fogFarMul: 0.64, sun: 3.8, hemi: 1.3, exposure: 0.95 },
	sunset: { bg: 0xc7987d, fogNearMul: 0.28, fogFarMul: 0.6, sun: 4.4, hemi: 1.2, exposure: 1.08 },
	night: { bg: 0x0b1220, fogNearMul: 0.24, fogFarMul: 0.5, sun: 1.7, hemi: 0.45, exposure: 0.7 },
	'dawn-mist': { bg: 0xb6c2cc, fogNearMul: 0.2, fogFarMul: 0.42, sun: 2.9, hemi: 1.1, exposure: 0.88 },
};
const WEATHER_DEFAULT = 'clear';
const PRECIP_DEFAULT = 'none';
const INTENSITY_DEFAULT = 'medium';
const WIND_DEFAULT = 'none';
const LEADERBOARD_API_BASE = 'https://racing-leaderboard-api.ga1010.workers.dev/api/leaderboard';
const ACCOUNT_API_BASE = 'https://racing-account-api.ga1010.workers.dev/api/accounts';
const PLAYER_NAME_KEY = 'racing-player-name-v1';
const MAX_PLAYER_NAME_LENGTH = 24;
const ACCOUNT_SESSION_KEY = 'racing-account-session-v1';
const MAX_LEADERBOARD_ROWS = 15;
const CAMPAIGN_STAGES = [
	{ type: 'beat-authors', goal: 1, text: 'Defeat 1 author time' },
	{ type: 'beat-authors', goal: 3, text: 'Defeat 3 author times' },
	{ type: 'beat-authors', goal: 5, text: 'Defeat 5 author times' },
	{ type: 'beat-authors', goal: 7, text: 'Defeat 7 author times' },
	{ type: 'beat-authors', goal: 9, text: 'Defeat 9 author times' },
	{ type: 'beat-authors', goal: 11, text: 'Defeat 11 author times' },
	{ type: 'beat-authors', goal: 13, text: 'Defeat 13 author times' },
	{ type: 'beat-authors', goal: 15, text: 'Defeat 15 author times' },
	{ type: 'beat-authors', goal: 17, text: 'Defeat 17 author times' },
	{ type: 'beat-authors', goal: 19, text: 'Defeat 19 author times' },
	{ type: 'beat-authors', goal: 21, text: 'Defeat 21 author times' },
	{ type: 'beat-authors', goal: 23, text: 'Defeat 23 author times' },
	{ type: 'beat-authors', goal: 25, text: 'Defeat 25 author times' },
	{ type: 'beat-authors', goal: 28, text: 'Defeat 28 author times' },
	{ type: 'beat-authors', goal: 32, text: 'Defeat 32 author times' },
	{ type: 'beat-authors', goal: 36, text: 'Defeat 36 author times' },
	{ type: 'beat-authors', goal: 40, text: 'Defeat 40 author times' },
];
const CAMPAIGN_STAGE_COUNT = CAMPAIGN_STAGES.length;
const PRECIP_TYPES = new Set( [ 'none', 'rain', 'snow' ] );
const INTENSITY_TYPES = new Set( [ 'low', 'medium', 'high' ] );
const WIND_TYPES = new Set( [ 'none', 'breezy', 'gusty' ] );

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

function decodeExtrasParam( str ) {

	if ( ! str ) return null;

	try {

		const json = decodeURIComponent( escape( atob( str.replace( /-/g, '+' ).replace( /_/g, '/' ) ) ) );
		const parsed = JSON.parse( json );
		return {
			bumps: Array.isArray( parsed.b ) ? parsed.b : [],
			boosts: Array.isArray( parsed.s ) ? parsed.s : [],
			jumps: Array.isArray( parsed.j ) ? parsed.j : [],
			decorations: Array.isArray( parsed.d ) ? parsed.d : [],
			surfaces: Array.isArray( parsed.u ) ? parsed.u : [],
			weather: normalizeWeatherDetails( parsed?.w ),
		};

	} catch ( e ) {

		console.warn( 'Invalid mods parameter, ignoring extras' );
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

	const base = `${ window.location.pathname }?map=${ mapParamValue || 'default' }&mods=${ extrasParamValue || 'none' }`;
	return btoa( base ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );

}

async function loadModels() {

	const promises = modelNames.map( ( name ) =>
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

}

async function init() {

	registerAll();
	await loadModels();

	const mapParam = new URLSearchParams( window.location.search ).get( 'map' );
	const extrasParam = new URLSearchParams( window.location.search ).get( 'mods' );
	const isSplitScreen = new URLSearchParams( window.location.search ).get( 'multiplayer' ) === '1';
	const ghostEnabled = ! isSplitScreen;
	if ( isSplitScreen ) renderer.setPixelRatio( 1 );
	let customCells = null;
	let spawn = null;
	const extras = decodeExtrasParam( extrasParam );
	const carKeys = Object.keys( CAR_STATS );
	const pickRandomCarKey = () => carKeys[ Math.floor( Math.random() * carKeys.length ) ];

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

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

	scene.background = new THREE.Color( weatherConfig.bg );
	scene.fog = new THREE.Fog( weatherConfig.bg, groundSize * weatherConfig.fogNearMul, groundSize * weatherConfig.fogFarMul );
	dirLight.intensity = weatherConfig.sun;
	hemiLight.intensity = weatherConfig.hemi;
	renderer.toneMappingExposure = weatherConfig.exposure;
	const baseWeatherLight = {
		sun: weatherConfig.sun,
		hemi: weatherConfig.hemi,
		exposure: weatherConfig.exposure,
	};

	buildTrack( scene, models, customCells, extras );


	const worldSettings = createWorldSettings();       
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

	buildWallColliders( world, null, customCells, extras );

	const roadHalf = groundSize / 2;
	rigidBody.create( world, {
		shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
		motionType: MotionType.STATIC,
		objectLayer: OL_STATIC,
		position: [ bounds.centerX, - 0.125, bounds.centerZ ],
		friction: 5.0,
		restitution: 0.0,
	} );

	const sphereBody = createSphereBody( world, spawn ? spawn.position : null );

	const player1CarKey = isSplitScreen ? pickRandomCarKey() : 'vehicle-truck-yellow';
	const player2CarKey = isSplitScreen ? pickRandomCarKey() : 'vehicle-truck-red';
	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;
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
	let ghostModel = null;
	const bestLapGhostSamples = [];
	let currentLapGhostSamples = [];
	let bestGhostDuration = 0;
	let bestGhostCarKey = 'vehicle-truck-yellow';
	let ghostRecordFrame = 0;
	const _ghostForward = new THREE.Vector3();
	const _ghostUp = new THREE.Vector3( 0, 1, 0 );

	function createGhostModel( model ) {

		if ( ! ghostEnabled ) return;
		if ( ghostModel ) scene.remove( ghostModel );
		ghostModel = null;
		if ( ! model ) return;

		ghostModel = model.clone();
		ghostModel.traverse( ( child ) => {

			if ( ! child.isMesh ) return;
			child.material = child.material.clone();
			child.material.transparent = true;
			child.material.opacity = 0.35;
			child.material.depthWrite = false;
			child.castShadow = false;
			child.receiveShadow = false;

		} );
		scene.add( ghostModel );

	}

	function resetCurrentLapGhost() {

		if ( ! ghostEnabled ) return;
		currentLapGhostSamples = [];
		ghostRecordFrame = 0;

	}

	function recordGhostSample( lapElapsed, force = false ) {

		if ( ! ghostEnabled ) return;
		ghostRecordFrame ++;
		if ( ! force && ghostRecordFrame % 3 !== 0 ) return;

		_ghostForward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
		_ghostForward.projectOnPlane( _ghostUp ).normalize();
		const yaw = Math.atan2( _ghostForward.x, _ghostForward.z );

		currentLapGhostSamples.push( {
			t: lapElapsed,
			x: vehicle.container.position.x,
			y: vehicle.container.position.y,
			z: vehicle.container.position.z,
			yaw,
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
		ghostModel.rotation.set( 0, lerpAngle( sampleA.yaw, sampleB.yaw, alpha ), 0 );

	}

	if ( ghostEnabled ) createGhostModel( models[ 'vehicle-truck-yellow' ] );

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	cam.targetPosition.copy( vehicle.spherePos );
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

	const particles = new SmokeTrails( scene );
	const particles2 = isSplitScreen ? new SmokeTrails( scene ) : null;
	const lapHud = document.getElementById( 'lap-hud' );
	const lapHud2 = document.getElementById( 'lap-hud-2' );
	const respawnBtn = document.getElementById( 'respawnBtn' );
	const modeMenuBtn = document.getElementById( 'mode-menu-btn' );
	const carSelect = document.getElementById( 'car-select' );
	const coinsLabel = document.getElementById( 'coins-label' );
	const upgradeLabel = document.getElementById( 'upgrade-label' );
	const buyUpgradeBtn = document.getElementById( 'buy-upgrade' );
	const shareTimeBtn = document.getElementById( 'share-time-btn' );
	const exportGhostBtn = document.getElementById( 'export-ghost-btn' );
	const importGhostBtn = document.getElementById( 'import-ghost-btn' );
	const economyHud = document.getElementById( 'economy-hud' );
	const modeMenu = document.getElementById( 'mode-menu' );
	const modeError = document.getElementById( 'mode-error' );
	const playerNameInput = document.getElementById( 'player-name-input' );
	const leaderboardList = document.getElementById( 'leaderboard-list' );
	const leaderboardEmpty = document.getElementById( 'leaderboard-empty' );
	const leaderboardTrackLabel = document.getElementById( 'leaderboard-track-label' );
	const leaderboardPanel = document.getElementById( 'leaderboard-panel' );
	const leaderboardToggleBtn = document.getElementById( 'leaderboard-toggle-btn' );
	const namePopup = document.getElementById( 'name-popup' );
	const namePopupInput = document.getElementById( 'name-popup-input' );
	const namePopupSave = document.getElementById( 'name-popup-save' );
	const namePopupSkip = document.getElementById( 'name-popup-skip' );
	const raceModeBtn = document.getElementById( 'mode-race-btn' );
	const stuntModeBtn = document.getElementById( 'mode-stunt-btn' );
	const campaignModeBtn = document.getElementById( 'mode-campaign-btn' );
	const campaignProgressLabel = document.getElementById( 'campaign-progress' );
	const stuntPointsHud = document.getElementById( 'stunt-points' );
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
	let pendingLeaderboardRecord = null;
	let leaderboardVisible = true;
	let accountSession = null;
	let campaignState = null;
	let campaignTargetAuthorSeconds = null;
	let campaignTrackName = '';
	const GARAGE_PACKS = {
		grip: { cost: 250, label: 'Handling Pack' },
		accel: { cost: 325, label: 'Power Pack' },
		drive: { cost: 400, label: 'Traction Pack' },
	};
	const garageStoreKey = 'racing-garage-mods-v1';
	const campaignStoreKey = 'racing-campaign-v1';
	let garageMods = { grip: 1.0, accel: 1.0, drive: 1.0 };
	let garageUnlocked = { grip: false, accel: false, drive: false };
	if ( lapHud2 ) lapHud2.style.display = isSplitScreen ? 'block' : 'none';
	if ( isSplitScreen ) {

		if ( economyHud ) economyHud.style.display = 'none';
		if ( carSelect ) carSelect.style.display = 'none';
		if ( buyUpgradeBtn ) buyUpgradeBtn.style.display = 'none';
		if ( shareTimeBtn ) shareTimeBtn.style.display = 'none';
		if ( exportGhostBtn ) exportGhostBtn.style.display = 'none';
		if ( importGhostBtn ) importGhostBtn.style.display = 'none';
	}
	if ( stuntModeBtn ) {

		stuntModeBtn.disabled = true;
		stuntModeBtn.title = 'Stunt mode is under construction';

	}
	const economyStoreKey = 'racing-economy-v1';
	let coins = 0;
	let engineTier = 0;
	let shareImageDataUrl = '';

	function getEngineMult() {

		return ENGINE_MULTS[ Math.min( engineTier, ENGINE_MULTS.length - 1 ) ];

	}

	function currentCarKey() {

		return carSelect?.value || 'vehicle-truck-yellow';

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
			topSpeed: Math.min( MAX_EFFECTIVE_TOP_SPEED, stats.perf.topSpeed * mult ),
			driveForce: stats.perf.driveForce * mult,
		};
		vehicle.setPerformance( perf );

	}

	function updateModeHudVisibility() {

		const inStunt = gameMode === 'stunt' || ( gameMode === 'campaign' && campaignState?.stageType === 'stunt-score' );
		if ( stuntPointsHud ) stuntPointsHud.style.display = inStunt ? 'block' : 'none';
		if ( lapHud ) lapHud.style.display = 'block';
		if ( lapHud2 ) lapHud2.style.display = isSplitScreen ? 'block' : 'none';
		if ( economyHud && ! isSplitScreen ) economyHud.style.display = 'block';
		if ( shareTimeBtn ) shareTimeBtn.style.display = ! isSplitScreen ? 'block' : 'none';
		if ( exportGhostBtn ) exportGhostBtn.style.display = ! isSplitScreen ? 'block' : 'none';
		if ( importGhostBtn ) importGhostBtn.style.display = ! isSplitScreen ? 'block' : 'none';

	}

	function showModeError( message ) {

		if ( modeError ) modeError.textContent = message || '';
		if ( message ) window.alert( message );

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
		if ( mode === 'stunt' ) {

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

	function setModeMenuOpen( open ) {

		modeMenuOpen = open;
		if ( modeMenu ) modeMenu.style.display = open ? 'block' : 'none';

	}

	function clampGarageValue( value, fallback = 1.0 ) {

		const parsed = Number( value );
		if ( ! Number.isFinite( parsed ) ) return fallback;
		return THREE.MathUtils.clamp( parsed, 0.85, 1.15 );

	}

	function getGarageUnlocks() {

		return { ...garageUnlocked };

	}

	function saveGarageMods() {

		localStorage.setItem( garageStoreKey, JSON.stringify( { mods: garageMods, unlocked: garageUnlocked } ) );

	}

	function loadGarageMods() {

		try {

			const raw = localStorage.getItem( garageStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			const legacy = parsed && ! parsed.mods;
			const mods = legacy ? parsed : parsed?.mods;
			const unlocked = legacy ? null : parsed?.unlocked;
			garageMods = {
				grip: clampGarageValue( mods?.grip, 1.0 ),
				accel: clampGarageValue( mods?.accel, 1.0 ),
				drive: clampGarageValue( mods?.drive, 1.0 ),
			};
			garageUnlocked = {
				grip: Boolean( unlocked?.grip ),
				accel: Boolean( unlocked?.accel ),
				drive: Boolean( unlocked?.drive ),
			};

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
			const stage = Math.max( 1, Math.min( CAMPAIGN_STAGE_COUNT, Number( parsed?.stage ) || 1 ) );
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
		const config = campaignStageConfig( campaignState.stage );
		const status = `${ campaignState.progress }/${ campaignState.goal }`;
		const target = campaignState.stageType === 'beat-authors' && Number.isFinite( campaignTargetAuthorSeconds )
			? ` • Target ${( campaignTargetAuthorSeconds ).toFixed( 2 )}s${ campaignTrackName ? ` (${ campaignTrackName })` : '' }`
			: '';
		campaignProgressLabel.textContent = `Campaign Stage ${ campaignState.stage}: ${ config.text } • ${ status }${ target }`;

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

			const response = await fetch( 'https://racing-track-board-api.ga1010.workers.dev/api/tracks' );
			if ( ! response.ok ) return [];
			const data = await response.json();
			return Array.isArray( data?.entries ) ? data.entries.filter( ( entry ) => Number.isFinite( Number( entry?.bestLapSeconds ) ) && typeof entry?.playUrl === 'string' ) : [];

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

		localStorage.setItem( economyStoreKey, JSON.stringify( { coins, engineTier } ) );

	}

	function loadEconomy() {

		try {

			const raw = localStorage.getItem( economyStoreKey );
			if ( ! raw ) return;
			const parsed = JSON.parse( raw );
			coins = Number.isFinite( parsed.coins ) ? parsed.coins : 0;
			engineTier = Number.isFinite( parsed.engineTier ) ? parsed.engineTier : 0;
			engineTier = Math.max( 0, Math.min( ENGINE_MULTS.length - 1, engineTier ) );

		} catch ( e ) {

			console.warn( 'Failed to load economy', e );

		}

	}

	function updateEconomyHud() {

		if ( coinsLabel ) coinsLabel.textContent = `Coins: ${ coins }`;
		if ( upgradeLabel ) {

			const mult = getEngineMult();
			upgradeLabel.textContent = `Engine: x${ mult.toFixed( 2 ) }`;

		}

		if ( buyUpgradeBtn ) {

			const atMax = engineTier >= ENGINE_MULTS.length - 1;
			buyUpgradeBtn.disabled = atMax || coins < ENGINE_UPGRADE_COST;
			if ( atMax ) buyUpgradeBtn.textContent = 'Max Upgrade';
			else buyUpgradeBtn.textContent = `Buy Upgrade (${ ENGINE_UPGRADE_COST })`;

		}
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
		option.textContent = `${ stats.name } (SPD ${ stats.speed } / ACC ${ stats.accel })`;

	} );

	const audio = new GameAudio();
	audio.init( cam.camera );

	const _forward = new THREE.Vector3();
	const _boostForward = new THREE.Vector3();

	const contactListener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

			_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
			audio.playImpact( impactVelocity );

		}
	};

	const timer = new THREE.Timer();
	const activeCells = customCells || TRACK_CELLS;
	const finishCell = activeCells.find( ( c ) => c[ 2 ] === 'track-finish' ) || activeCells[ 0 ];
	const checkpointCells = activeCells.filter( ( c ) => c[ 2 ] === 'track-checkpoint' );
	const lapStoreKey = `racing-lap-stats:${ mapParam || 'default' }`;
	const stuntStoreKey = `racing-stunt-stats:${ mapParam || 'default' }`;
	const currentTrackUrl = `${ window.location.origin }${ window.location.pathname }${ window.location.search }`;
	const leaderboardTrackId = getTrackId( mapParam, extrasParam );
	const leaderboardTrackName = getTrackLabel( mapParam );
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
			economy: { coins, engineTier },
			garage: { mods: garageMods, unlocked: garageUnlocked },
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
		const nextTier = Number( parsed?.economy?.engineTier );
		coins = Number.isFinite( nextCoins ) ? Math.max( 0, Math.floor( nextCoins ) ) : coins;
		engineTier = Number.isFinite( nextTier ) ? Math.max( 0, Math.min( ENGINE_MULTS.length - 1, Math.floor( nextTier ) ) ) : engineTier;
		garageMods = {
			grip: clampGarageValue( parsed?.garage?.mods?.grip, garageMods.grip ),
			accel: clampGarageValue( parsed?.garage?.mods?.accel, garageMods.accel ),
			drive: clampGarageValue( parsed?.garage?.mods?.drive, garageMods.drive ),
		};
		garageUnlocked = {
			grip: Boolean( parsed?.garage?.unlocked?.grip ),
			accel: Boolean( parsed?.garage?.unlocked?.accel ),
			drive: Boolean( parsed?.garage?.unlocked?.drive ),
		};
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
			if ( models[ parsed.carKey ] ) vehicle.setModel( models[ parsed.carKey ] );

		}
		saveEconomy();
		saveGarageMods();
		saveCampaignState();
		applyVehiclePerformance();
		updateEconomyHud();
		updateGarageUi();
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
	let hasPrevFinishSample = false;
	let lastLocalX = 0;
	let lastLocalZ = 0;
	let hasLeftStartZone = false;
	let boostActiveUntil = 0;
	let boostContactCell = null;
	const specialSurfaceContactState = new Map();
	const boostCells = Array.isArray( extras?.boosts ) ? extras.boosts : [];
	const boostCellSet = new Set( boostCells.map( ( [ gx, gz ] ) => `${ gx },${ gz }` ) );
	const surfaceCells = Array.isArray( extras?.surfaces ) ? extras.surfaces : [];
	const surfaceCellMap = new Map( surfaceCells.map( ( [ gx, gz, type ] ) => [ `${ gx },${ gz }`, type ] ) );
	let activeSurfaceType = null;
	let activeSurfaceType2 = null;
	let lapNumber2 = 1;
	let lapStartSeconds2 = 0;
	let lapSeconds2 = 0;
	let lastLapSeconds2 = null;
	let bestLapSeconds2 = null;
	let hasPrevFinishSample2 = false;
	let lastLocalX2 = 0;
	let lastLocalZ2 = 0;
	let hasLeftStartZone2 = false;
	let boostActiveUntil2 = 0;
	let boostContactCell2 = null;
	const specialSurfaceContactState2 = new Map();
	const checkpointStates2 = checkpointCells.map( ( cell ) => ( {
		...makeGateData( cell ),
		lastLocalX: 0,
		lastLocalZ: 0,
		hasPrevSample: false,
		passedThisLap: false,
	} ) );
	const INTENSITY_SCALE = { low: 0.6, medium: 1.0, high: 1.45 };
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
		const count = Math.round( ( precip === 'rain' ? 520 : 380 ) * ( INTENSITY_SCALE[ weatherSettings.intensity ] || 1 ) );
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

		if ( weatherSettings.lightning ) {

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

	function getOverlappingGridBounds( position, radius = VEHICLE_SURFACE_RADIUS ) {

		const cellSize = CELL_RAW * GRID_SCALE;
		const minX = Math.floor( ( position.x - radius ) / cellSize );
		const maxX = Math.floor( ( position.x + radius ) / cellSize );
		const minZ = Math.floor( ( position.z - radius ) / cellSize );
		const maxZ = Math.floor( ( position.z + radius ) / cellSize );
		return { minX, maxX, minZ, maxZ };

	}

	function findActiveSurfaceTypeFor( targetVehicle ) {

		const bounds = getOverlappingGridBounds( targetVehicle.spherePos );
		for ( let gx = bounds.minX; gx <= bounds.maxX; gx ++ ) {

			for ( let gz = bounds.minZ; gz <= bounds.maxZ; gz ++ ) {

				const surfaceType = surfaceCellMap.get( `${ gx },${ gz }` );
				if ( surfaceType ) return surfaceType;

			}

		}

		return null;

	}

	function findBoostSurfaceContactKeyFor( targetVehicle ) {

		const bounds = getOverlappingGridBounds( targetVehicle.spherePos );
		for ( let gx = bounds.minX; gx <= bounds.maxX; gx ++ ) {

			for ( let gz = bounds.minZ; gz <= bounds.maxZ; gz ++ ) {

				if ( surfaceCellMap.get( `${ gx },${ gz }` ) === 'surface-boost' ) return `surface:${ gx },${ gz }`;

			}

		}

		return null;

	}

	function findSurfaceContactKeyForType( targetVehicle, surfaceType ) {

		const bounds = getOverlappingGridBounds( targetVehicle.spherePos );
		for ( let gx = bounds.minX; gx <= bounds.maxX; gx ++ ) {

			for ( let gz = bounds.minZ; gz <= bounds.maxZ; gz ++ ) {

				if ( surfaceCellMap.get( `${ gx },${ gz }` ) === surfaceType ) return `surface:${ gx },${ gz }`;

			}

		}

		return null;

	}

	function applySurfaceGrip( targetVehicle, surfaceType ) {

		const effect = SURFACE_EFFECTS[ surfaceType || null ];
		const unlocks = getGarageUnlocks();
		const gripPack = unlocks.grip ? garageMods.grip : 1.0;
		const accelPack = unlocks.accel ? garageMods.accel : 1.0;
		const drivePack = unlocks.drive ? garageMods.drive : 1.0;
		targetVehicle.gripMultiplier = ( effect ? effect.grip : 1.0 ) * gripPack;
		targetVehicle.dragMultiplier = effect ? effect.drag : 1.0;
		targetVehicle.accelMultiplier = ( effect ? effect.accel : 1.0 ) * accelPack;
		targetVehicle.driveMultiplier = ( effect ? effect.drive : 1.0 ) * drivePack;

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
				bestLapSeconds,
				duration: bestGhostDuration,
				samples: bestLapGhostSamples,
			}
		};
		return encodeBase64UrlJson( payload );

	}

	function applyImportedGhostPayload( payload ) {

		if ( ! ghostEnabled ) return false;
		const samples = Array.isArray( payload?.samples ) ? payload.samples : [];
		const duration = Number( payload?.duration );
		if ( samples.length < 2 || ! Number.isFinite( duration ) || duration <= 0 ) return false;
		bestLapGhostSamples.length = 0;
		for ( const sample of samples ) {

			if ( ! Number.isFinite( sample?.t ) || ! Number.isFinite( sample?.x ) || ! Number.isFinite( sample?.y ) || ! Number.isFinite( sample?.z ) || ! Number.isFinite( sample?.yaw ) ) continue;
			bestLapGhostSamples.push( {
				t: sample.t,
				x: sample.x,
				y: sample.y,
				z: sample.z,
				yaw: sample.yaw,
			} );

		}
		if ( bestLapGhostSamples.length < 2 ) return false;
		bestGhostDuration = duration;
		if ( Number.isFinite( payload.bestLapSeconds ) ) bestLapSeconds = payload.bestLapSeconds;
		if ( payload?.car && models[ payload.car ] ) {

			bestGhostCarKey = payload.car;
			createGhostModel( models[ payload.car ] );

		}
		if ( shareTimeBtn ) shareTimeBtn.disabled = ! Number.isFinite( bestLapSeconds );
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
		if ( ! url || ! parsed?.ghost ) {

			window.alert( 'Ghost code is missing required data.' );
			return;

		}

		const ghostBlob = encodeBase64UrlJson( parsed.ghost );
		const separator = url.includes( '#' ) ? '&' : '#';
		window.open( `${ url }${ separator }ghost=${ ghostBlob }`, '_blank' );

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
		lapHud.innerHTML = `Lap ${ lapNumber } • ${ formatLapTime( lapSeconds ) }<br><small>Last: ${ formatLapTime( lastLapSeconds ) } • Best: ${ formatLapTime( bestLapSeconds ) }</small>${ checkpointLine }`;

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
			return;

		}
		leaderboardEmpty.hidden = true;
		leaderboardList.hidden = false;
		for ( const [ index, entry ] of entries.slice( 0, MAX_LEADERBOARD_ROWS ).entries() ) {

			const row = document.createElement( 'li' );
			const safeName = sanitizePlayerName( entry?.name ) || 'Anonymous';
			const timeText = formatLapTime( Number( entry?.timeSeconds ) );
			row.innerHTML = `<span class=\"lb-rank\">#${ index + 1 }</span> <span class=\"lb-name\">${ safeName }</span> — <span class=\"lb-time\">${ timeText }</span>`;
			leaderboardList.appendChild( row );

		}

	}

	async function fetchTrackLeaderboard() {

		if ( leaderboardTrackLabel ) leaderboardTrackLabel.textContent = `Track: ${ leaderboardTrackName }`;
		if ( ! leaderboardEmpty || ! leaderboardList ) return;
		leaderboardEmpty.hidden = false;
		leaderboardList.hidden = true;
		leaderboardEmpty.textContent = 'Loading leaderboard…';
		try {

			const response = await fetch( `${ LEADERBOARD_API_BASE }?trackId=${ encodeURIComponent( leaderboardTrackId ) }` );
			if ( ! response.ok ) throw new Error( `Leaderboard HTTP ${ response.status }` );
			const parsed = await response.json();
			renderLeaderboardRows( parsed?.entries || [] );

		} catch ( e ) {

			console.warn( 'Failed to fetch leaderboard', e );
			leaderboardList.hidden = true;
			leaderboardEmpty.hidden = false;
			leaderboardEmpty.textContent = 'Leaderboard unavailable (check Cloudflare setup).';

		}

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

		const chosenName = sanitizePlayerName( forcedName || playerNameInput?.value );
		if ( ! chosenName ) {

			openNamePopup( lapTimeSeconds );
			return false;

		}
		localStorage.setItem( PLAYER_NAME_KEY, chosenName );
		if ( playerNameInput ) playerNameInput.value = chosenName;
		try {

			const response = await fetch( LEADERBOARD_API_BASE, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( {
					trackId: leaderboardTrackId,
					trackName: leaderboardTrackName,
					name: chosenName,
					timeSeconds: lapTimeSeconds,
				} ),
			} );
			if ( ! response.ok ) throw new Error( `Leaderboard POST ${ response.status }` );
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
		setAccountStatus( `Logged in as ${ payload.username }.` );

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
				bestLapGhostSamples: [],
			} ) );
			return;

		}
		localStorage.setItem( lapStoreKey, JSON.stringify( {
			lapNumber,
			lastLapSeconds,
			bestLapSeconds,
			bestGhostDuration,
			bestGhostCarKey,
			bestLapGhostSamples,
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
			bestLapGhostSamples.length = 0;
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

			}
			if ( bestLapGhostSamples.length < 2 ) bestGhostDuration = 0;
			if ( ghostEnabled && bestLapGhostSamples.length >= 2 && models[ bestGhostCarKey ] ) createGhostModel( models[ bestGhostCarKey ] );

		} catch ( e ) {

			console.warn( 'Failed to load lap stats', e );

		}

	}

	function resetLapState( keepRecords = false ) {

		if ( ! keepRecords ) {

			lapNumber = 1;
			lastLapSeconds = null;
			bestLapSeconds = null;

		}

		lapStartSeconds = timer.getElapsed();
		lapSeconds = 0;
		boostActiveUntil = 0;
		boostContactCell = null;
		specialSurfaceContactState.clear();
		resetCurrentLapGhost();
		recordGhostSample( 0, true );
		updateGhostPlayback( 0 );
		hasLeftStartZone = false;
		hasPrevFinishSample = false;
		lastLocalX = 0;
		lastLocalZ = 0;
		for ( const checkpoint of checkpointStates ) {

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
		lapStartSeconds2 = timer.getElapsed();
		lapSeconds2 = 0;
		boostActiveUntil2 = 0;
		boostContactCell2 = null;
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

		vehicle.resetToSpawn();
		cam.targetPosition.copy( vehicle.spherePos );
		cam.camera.position.addVectors( cam.targetPosition, cam.offset );

		resetLapState( true );

	}

	function respawnVehicle2() {

		if ( ! vehicle2 || ! cam2 ) return;
		vehicle2.resetToSpawn();
		cam2.targetPosition.copy( vehicle2.spherePos );
		cam2.camera.position.addVectors( cam2.targetPosition, cam2.offset );
		resetLapState2( true );

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

	function applySurfacePopFor( targetVehicle ) {

		if ( ! isVehicleOnGround( targetVehicle ) ) return false;
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [ vel[ 0 ], Math.max( vel[ 1 ], 0 ) + POP_VERTICAL_DELTA, vel[ 2 ] ] );
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

	function applySurfaceForwardKickFor( targetVehicle, direction ) {

		_boostForward.set( 0, 0, 1 ).applyQuaternion( targetVehicle.container.quaternion );
		_boostForward.y = 0;
		const forwardLenSq = _boostForward.lengthSq();
		if ( forwardLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( forwardLenSq ) );
		const vel = targetVehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, targetVehicle.rigidBody, [
			vel[ 0 ] + _boostForward.x * direction,
			vel[ 1 ],
			vel[ 2 ] + _boostForward.z * direction,
		] );
		return true;

	}

	function applySurfaceSpinFor( targetVehicle, direction ) {

		applySurfaceKickFor( targetVehicle, direction );
		const angVel = targetVehicle.rigidBody.motionProperties?.angularVelocity || [ 0, 0, 0 ];
		rigidBody.setAngularVelocity( world, targetVehicle.rigidBody, [
			angVel[ 0 ],
			angVel[ 1 ] + ( SPIN_YAW_DELTA * direction ),
			angVel[ 2 ],
		] );
		return true;

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
		'surface-pop': ( targetVehicle ) => applySurfacePopFor( targetVehicle ),
		'surface-launch': ( targetVehicle ) => applySurfaceForwardKickFor( targetVehicle, LAUNCH_FORWARD_DELTA ),
		'surface-reverse': ( targetVehicle ) => applySurfaceForwardKickFor( targetVehicle, REVERSE_FORWARD_DELTA ),
		'surface-spin-l': ( targetVehicle ) => applySurfaceSpinFor( targetVehicle, - 1 ),
		'surface-spin-r': ( targetVehicle ) => applySurfaceSpinFor( targetVehicle, 1 ),
	};

	const SPECIAL_SURFACE_TYPES = Object.keys( SPECIAL_SURFACE_HANDLERS );

	function applySpecialSurfacesFor( targetVehicle, contactState ) {

		for ( const surfaceType of SPECIAL_SURFACE_TYPES ) {

			const currentKey = findSurfaceContactKeyForType( targetVehicle, surfaceType );
			const previousKey = contactState.get( surfaceType ) || null;
			if ( currentKey ) {

				if ( previousKey !== currentKey ) {

					const triggered = SPECIAL_SURFACE_HANDLERS[ surfaceType ]( targetVehicle );
					if ( triggered ) contactState.set( surfaceType, currentKey );
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

	} );
	modeMenuBtn?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		setModeMenuOpen( ! modeMenuOpen );

	} );

	carSelect?.addEventListener( 'change', () => {

		const selectedKey = carSelect.value;
		if ( models[ selectedKey ] ) vehicle.setModel( models[ selectedKey ] );
		applyVehiclePerformance();

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

	buyUpgradeBtn?.addEventListener( 'click', () => {

		if ( engineTier >= ENGINE_MULTS.length - 1 ) return;
		if ( coins < ENGINE_UPGRADE_COST ) return;
		coins -= ENGINE_UPGRADE_COST;
		engineTier ++;
		applyVehiclePerformance();
		saveEconomy();
		updateEconomyHud();

	} );

	shareTimeBtn?.addEventListener( 'click', () => {

		openShareTab();

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
	profileExportBtn?.addEventListener( 'click', async () => {

		const code = createProfileExportCode();
		try {

			await navigator.clipboard.writeText( code );
			window.alert( 'Profile code copied to clipboard.' );

		} catch ( e ) {

			window.prompt( 'Copy your profile code:', code );

		}

	} );
	profileImportBtn?.addEventListener( 'click', () => {

		const code = window.prompt( 'Paste profile code:' );
		if ( ! code ) return;
		try {

			if ( ! applyImportedProfile( code.trim() ) ) window.alert( 'Invalid profile code.' );

		} catch ( e ) {

			window.alert( 'Could not import profile code.' );

		}

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
	accountExportBtn?.addEventListener( 'click', async () => {

		const code = createAccountExportCode();
		try {

			await navigator.clipboard.writeText( code );
			window.alert( 'Account code copied to clipboard.' );

		} catch ( e ) {

			window.prompt( 'Copy your account code:', code );

		}

	} );
	accountImportBtn?.addEventListener( 'click', () => {

		const code = window.prompt( 'Paste account code:' );
		if ( ! code ) return;
		try {

			if ( ! applyImportedAccountCode( code.trim() ) ) window.alert( 'Invalid account code.' );

		} catch ( e ) {

			window.alert( 'Could not import account code.' );

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
	namePopup?.addEventListener( 'click', ( event ) => {

		if ( event.target === namePopup ) closeNamePopup();

	} );

	loadEconomy();
	loadStuntStats();
	loadGarageMods();
	loadCampaignState();
	updateGarageUi();
	applyVehiclePerformance();
	updateEconomyHud();
	updateCampaignUi();
	loadLapStats();
	if ( shareTimeBtn ) shareTimeBtn.disabled = ! Number.isFinite( bestLapSeconds );
	updateGhostShareButtons();
	updateModeHudVisibility();
	fetchTrackLeaderboard();
	setInterval( () => {

		if ( leaderboardVisible ) fetchTrackLeaderboard();

	}, 15000 );
	if ( campaignParamEnabled ) setGameMode( 'campaign' );
	resetLapState( true );
	resetLapState2( true );

	const hashParams = new URLSearchParams( window.location.hash.startsWith( '#' ) ? window.location.hash.slice( 1 ) : window.location.hash );
	const importedGhost = hashParams.get( 'ghost' );
	if ( importedGhost ) {

		try {

			const payload = decodeBase64UrlJson( importedGhost );
			if ( applyImportedGhostPayload( payload ) ) updateLapHud();

		} catch ( e ) {

			console.warn( 'Failed to import ghost from URL hash', e );

		}

	}

	window.addEventListener( 'keydown', ( e ) => {

			const target = e.target;
			const isTypingTarget = target && (
				target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable
			);
			if ( isTypingTarget ) return;

			if ( e.code === 'KeyE' ) {

				setModeMenuOpen( ! modeMenuOpen );
				return;

			}

			if ( e.code === 'KeyC' ) {

				cam.toggleMode();
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

		} );

	let hudUpdateAccumulator = 0;

	function animate() {

		requestAnimationFrame( animate );

		timer.update();
		const dt = Math.min( timer.getDelta(), 1 / 30 );
		const now = timer.getElapsed();

		const input = modeMenuOpen ? { x: 0, y: 0, z: 0 } : controls.update();
		const input2 = controls2 ? ( modeMenuOpen ? { x: 0, y: 0, z: 0 } : controls2.update() ) : null;

		updateWorld( world, contactListener, dt );

		vehicle.update( dt, input );
		if ( vehicle2 && input2 ) vehicle2.update( dt, input2 );
		activeSurfaceType = findActiveSurfaceTypeFor( vehicle );
		applySurfaceGrip( vehicle, activeSurfaceType );
		if ( vehicle2 ) {

			activeSurfaceType2 = findActiveSurfaceTypeFor( vehicle2 );
			applySurfaceGrip( vehicle2, activeSurfaceType2 );

		}
		updateActiveBoost( vehicle, boostActiveUntil, dt, now );
		if ( vehicle2 ) updateActiveBoost( vehicle2, boostActiveUntil2, dt, now );
		const boostGridX = Math.floor( vehicle.spherePos.x / ( CELL_RAW * GRID_SCALE ) - 0.5 );
		const boostGridZ = Math.floor( vehicle.spherePos.z / ( CELL_RAW * GRID_SCALE ) - 0.5 );
		const boostTileKey = `${ boostGridX },${ boostGridZ }`;
		const activeBoostContactKey = boostCellSet.has( boostTileKey ) ? `boost:${ boostTileKey }` : findBoostSurfaceContactKeyFor( vehicle );
		if ( activeBoostContactKey ) {

			if ( boostContactCell !== activeBoostContactKey ) {

				applyBoostFor( vehicle, ( value ) => {

					boostActiveUntil = value;

				}, particles, now );
				boostContactCell = activeBoostContactKey;

			}

		} else {

			boostContactCell = null;

		}

		applySpecialSurfacesFor( vehicle, specialSurfaceContactState );

		if ( vehicle2 ) {

			const boostGridX2 = Math.floor( vehicle2.spherePos.x / ( CELL_RAW * GRID_SCALE ) - 0.5 );
			const boostGridZ2 = Math.floor( vehicle2.spherePos.z / ( CELL_RAW * GRID_SCALE ) - 0.5 );
			const boostTileKey2 = `${ boostGridX2 },${ boostGridZ2 }`;
			const activeBoostContactKey2 = boostCellSet.has( boostTileKey2 ) ? `boost:${ boostTileKey2 }` : findBoostSurfaceContactKeyFor( vehicle2 );
			if ( activeBoostContactKey2 ) {

				if ( boostContactCell2 !== activeBoostContactKey2 ) {

					applyBoostFor( vehicle2, ( value ) => {

						boostActiveUntil2 = value;

					}, particles2, now );
					boostContactCell2 = activeBoostContactKey2;

				}

			} else {

				boostContactCell2 = null;

			}

			applySpecialSurfacesFor( vehicle2, specialSurfaceContactState2 );

		}

		dirLight.position.set(
			vehicle.spherePos.x + 11.4,
			15,
			vehicle.spherePos.z - 5.3
		);

		cam.update( dt, vehicle.spherePos, vehicle.container.quaternion );
		if ( cam2 && vehicle2 ) cam2.update( dt, vehicle2.spherePos, vehicle2.container.quaternion );
		particles.update( dt, vehicle );
		particles2?.update( dt, vehicle2 );
		audio.update( dt, vehicle.linearSpeed, input.z, vehicle.driftIntensity );
		updateWeatherFx( dt, now );

		for ( const checkpoint of checkpointStates ) {

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

			if ( crossedCheckpoint ) checkpoint.passedThisLap = true;
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

				if ( crossedCheckpoint ) checkpoint.passedThisLap = true;
				checkpoint.lastLocalX = localX;
				checkpoint.lastLocalZ = localZ;
				checkpoint.hasPrevSample = true;

			}

		}

		if ( finishData ) {

			const localX = ( ( vehicle.spherePos.x - finishData.centerX ) * finishData.cosA ) + ( ( vehicle.spherePos.z - finishData.centerZ ) * finishData.sinA );
			const localZ = ( - ( vehicle.spherePos.x - finishData.centerX ) * finishData.sinA ) + ( ( vehicle.spherePos.z - finishData.centerZ ) * finishData.cosA );
			const inFinishCell = Math.abs( localX ) < finishData.halfExtent && Math.abs( localZ ) < finishData.halfExtent;

			if ( ! hasLeftStartZone && ! inFinishCell ) {

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
					const previousBestLap = bestLapSeconds;
					const isNewBest = bestLapSeconds === null || completedLap < bestLapSeconds;
					lastLapSeconds = completedLap;
					bestLapSeconds = bestLapSeconds === null ? completedLap : Math.min( bestLapSeconds, completedLap );
					shareImageDataUrl = createShareSnapshot( bestLapSeconds );
					if ( shareTimeBtn ) shareTimeBtn.disabled = ! Number.isFinite( bestLapSeconds );
					if ( isNewBest && currentLapGhostSamples.length > 1 ) {

					bestLapGhostSamples.length = 0;
					const t0 = currentLapGhostSamples[ 0 ].t;
					for ( const sample of currentLapGhostSamples ) bestLapGhostSamples.push( { ...sample, t: sample.t - t0 } );
					bestGhostDuration = Math.max( 1e-4, completedLap - t0 );
					bestGhostCarKey = currentCarKey();
					updateGhostShareButtons();

				}
					if ( isNewBest && ! isSplitScreen ) submitLeaderboardTime( completedLap );
					lapNumber ++;
					lapStartSeconds = now;
					resetCurrentLapGhost();
					recordGhostSample( 0, true );
					updateGhostPlayback( 0 );
				hasLeftStartZone = false;
				for ( const checkpoint of checkpointStates ) {

					checkpoint.passedThisLap = false;

					}
					saveLapStats();
					rewardCoinsForLap( completedLap );
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
						if ( gameMode === 'campaign' && campaignState?.stageType === 'beat-authors' && Number.isFinite( campaignTargetAuthorSeconds ) && completedLap <= campaignTargetAuthorSeconds ) {

							campaignState.progress = Math.min( campaignState.goal, campaignState.progress + 1 );
							saveCampaignState();
							if ( campaignState.progress >= campaignState.goal ) completeCampaignStage();
							updateCampaignUi();

						}

				}

			lastLocalX = localX;
			lastLocalZ = localZ;
			hasPrevFinishSample = true;

		}

		if ( finishData && vehicle2 ) {

			const localX = ( ( vehicle2.spherePos.x - finishData.centerX ) * finishData.cosA ) + ( ( vehicle2.spherePos.z - finishData.centerZ ) * finishData.sinA );
			const localZ = ( - ( vehicle2.spherePos.x - finishData.centerX ) * finishData.sinA ) + ( ( vehicle2.spherePos.z - finishData.centerZ ) * finishData.cosA );
			const inFinishCell = Math.abs( localX ) < finishData.halfExtent && Math.abs( localZ ) < finishData.halfExtent;

			if ( ! hasLeftStartZone2 && ! inFinishCell ) hasLeftStartZone2 = true;

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

			}

			lastLocalX2 = localX;
			lastLocalZ2 = localZ;
			hasPrevFinishSample2 = true;

		}

		lapSeconds = now - lapStartSeconds;
		if ( vehicle2 ) lapSeconds2 = now - lapStartSeconds2;
		recordGhostSample( lapSeconds );
		updateGhostPlayback( lapSeconds );
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

		}

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

	}

	animate();

}

init();
