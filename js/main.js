
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
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( window.devicePixelRatio );
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
const BOOST_VELOCITY_DELTA = 2.2;
const BOOST_EFFECT_SECONDS = 1.0;
const BOOST_FORCE_SECONDS = 0.45;
const BOOST_ACCEL_PER_SECOND = 8.5;
const SURFACE_EFFECTS = {
	'surface-wood': { grip: 1.18, drag: 1.08 },
	'surface-ice': { grip: 0.55, drag: 0.82 },
};

function decodeExtrasParam( str ) {

	if ( ! str ) return null;

	try {

		const json = decodeURIComponent( escape( atob( str.replace( /-/g, '+' ).replace( /_/g, '/' ) ) ) );
		const parsed = JSON.parse( json );
		return {
			bumps: Array.isArray( parsed.b ) ? parsed.b : [],
			boosts: Array.isArray( parsed.s ) ? parsed.s : [],
			decorations: Array.isArray( parsed.d ) ? parsed.d : [],
			surfaces: Array.isArray( parsed.u ) ? parsed.u : [],
		};

	} catch ( e ) {

		console.warn( 'Invalid mods parameter, ignoring extras' );
		return null;

	}

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
	let customCells = null;
	let spawn = null;
	const extras = decodeExtrasParam( extrasParam );

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

	const shadowExtent = Math.max( hw, hd ) + 10;
	dirLight.shadow.camera.left = - shadowExtent;
	dirLight.shadow.camera.right = shadowExtent;
	dirLight.shadow.camera.top = shadowExtent;
	dirLight.shadow.camera.bottom = - shadowExtent;
	dirLight.shadow.camera.updateProjectionMatrix();

	scene.fog.near = groundSize * 0.4;
	scene.fog.far = groundSize * 0.8;

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

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;
	vehicle.setSpawn( spawn ? spawn.position : [ 3.5, 0.5, 5 ], spawn ? spawn.angle : 0 );
	vehicle.setPerformance( CAR_STATS[ 'vehicle-truck-yellow' ].perf );

	if ( spawn ) {

		const [ sx, sy, sz ] = spawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = spawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ 'vehicle-truck-yellow' ] );
	scene.add( vehicleGroup );
	let ghostModel = null;
	const bestLapGhostSamples = [];
	let currentLapGhostSamples = [];
	let bestGhostDuration = 0;
	let bestGhostCarKey = 'vehicle-truck-yellow';
	let ghostRecordFrame = 0;
	const _ghostForward = new THREE.Vector3();
	const _ghostUp = new THREE.Vector3( 0, 1, 0 );

	function createGhostModel( model ) {

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

		currentLapGhostSamples = [];
		ghostRecordFrame = 0;

	}

	function recordGhostSample( lapElapsed, force = false ) {

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

	createGhostModel( models[ 'vehicle-truck-yellow' ] );

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	cam.targetPosition.copy( vehicle.spherePos );

	const controls = new Controls();

	const particles = new SmokeTrails( scene );
	const lapHud = document.getElementById( 'lap-hud' );
	const respawnBtn = document.getElementById( 'respawnBtn' );
	const carSelect = document.getElementById( 'car-select' );
	const coinsLabel = document.getElementById( 'coins-label' );
	const upgradeLabel = document.getElementById( 'upgrade-label' );
	const buyUpgradeBtn = document.getElementById( 'buy-upgrade' );
	const shareTimeBtn = document.getElementById( 'share-time-btn' );
	const exportGhostBtn = document.getElementById( 'export-ghost-btn' );
	const importGhostBtn = document.getElementById( 'import-ghost-btn' );
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

	}

	function rewardCoinsForLap( lapSecondsCompleted ) {

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
	const currentTrackUrl = `${ window.location.origin }${ window.location.pathname }${ window.location.search }`;

	function encodeBase64UrlJson( value ) {

		return btoa( unescape( encodeURIComponent( JSON.stringify( value ) ) ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' );

	}

	function decodeBase64UrlJson( value ) {

		const normalized = value.replace( /-/g, '+' ).replace( /_/g, '/' );
		const padLen = ( 4 - normalized.length % 4 ) % 4;
		const padded = normalized + '='.repeat( padLen );
		return JSON.parse( decodeURIComponent( escape( atob( padded ) ) ) );

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
	const boostCells = Array.isArray( extras?.boosts ) ? extras.boosts : [];
	const boostCellSet = new Set( boostCells.map( ( [ gx, gz ] ) => `${ gx },${ gz }` ) );
	const surfaceCells = Array.isArray( extras?.surfaces ) ? extras.surfaces : [];
	const surfaceCellMap = new Map( surfaceCells.map( ( [ gx, gz, type ] ) => [ `${ gx },${ gz }`, type ] ) );
	let activeSurfaceType = null;

	function applySurfaceGrip( surfaceType ) {

		activeSurfaceType = surfaceType || null;
		const effect = SURFACE_EFFECTS[ activeSurfaceType ];
		vehicle.gripMultiplier = effect ? effect.grip : 1.0;
		vehicle.dragMultiplier = effect ? effect.drag : 1.0;

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
		const hasGhost = bestLapGhostSamples.length >= 2 && Number.isFinite( bestLapSeconds );
		exportGhostBtn.disabled = false;
		exportGhostBtn.title = hasGhost ? 'Export current best ghost' : 'Finish a clean lap first to generate an exportable ghost';

	}

	function createGhostExportCode() {

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

	function saveLapStats() {

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
			if ( bestLapGhostSamples.length >= 2 && models[ bestGhostCarKey ] ) createGhostModel( models[ bestGhostCarKey ] );

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

	function respawnVehicle() {

		vehicle.resetToSpawn();
		cam.targetPosition.copy( vehicle.spherePos );
		cam.camera.position.addVectors( cam.targetPosition, cam.offset );

		resetLapState( true );

	}

	function applyBoost() {

		if ( ! vehicle?.rigidBody ) return;
		const now = timer.getElapsed();
		_boostForward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
		_boostForward.y = 0;
		const boostLenSq = _boostForward.lengthSq();
		if ( boostLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( boostLenSq ) );
		const vel = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, vehicle.rigidBody, [
			vel[ 0 ] + _boostForward.x * BOOST_VELOCITY_DELTA,
			vel[ 1 ],
			vel[ 2 ] + _boostForward.z * BOOST_VELOCITY_DELTA,
		] );
		boostActiveUntil = now + BOOST_FORCE_SECONDS;
		particles.triggerBoostFx( Math.max( BOOST_EFFECT_SECONDS, BOOST_FORCE_SECONDS ) );

	}

	function updateActiveBoost( dt ) {

		if ( ! vehicle?.rigidBody ) return;
		const now = timer.getElapsed();
		if ( now >= boostActiveUntil ) return;
		_boostForward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
		_boostForward.y = 0;
		const boostLenSq = _boostForward.lengthSq();
		if ( boostLenSq < 1e-6 ) return;
		_boostForward.multiplyScalar( 1 / Math.sqrt( boostLenSq ) );
		const vel = vehicle.rigidBody.motionProperties?.linearVelocity || [ 0, 0, 0 ];
		rigidBody.setLinearVelocity( world, vehicle.rigidBody, [
			vel[ 0 ] + _boostForward.x * BOOST_ACCEL_PER_SECOND * dt,
			vel[ 1 ],
			vel[ 2 ] + _boostForward.z * BOOST_ACCEL_PER_SECOND * dt,
		] );

	}

	respawnBtn?.addEventListener( 'click', ( e ) => {

		e.preventDefault();
		respawnVehicle();

	} );

	carSelect?.addEventListener( 'change', () => {

		const selectedKey = carSelect.value;
		if ( models[ selectedKey ] ) vehicle.setModel( models[ selectedKey ] );
		if ( models[ selectedKey ] ) createGhostModel( models[ selectedKey ] );
		applyVehiclePerformance();

	} );

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

	loadEconomy();
	applyVehiclePerformance();
	updateEconomyHud();
	loadLapStats();
	if ( shareTimeBtn ) shareTimeBtn.disabled = ! Number.isFinite( bestLapSeconds );
	updateGhostShareButtons();
	resetLapState( true );

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

			if ( e.code === 'KeyC' ) {

				cam.toggleMode();
				return;

			}

			if ( e.code === 'KeyR' ) {

				respawnVehicle();
				return;

			}

		} );

	function animate() {

		requestAnimationFrame( animate );

		timer.update();
		const dt = Math.min( timer.getDelta(), 1 / 30 );

		const input = controls.update();
		const surfaceGridX = Math.floor( vehicle.spherePos.x / ( CELL_RAW * GRID_SCALE ) - 0.5 );
		const surfaceGridZ = Math.floor( vehicle.spherePos.z / ( CELL_RAW * GRID_SCALE ) - 0.5 );
		const surfaceKey = `${ surfaceGridX },${ surfaceGridZ }`;
		applySurfaceGrip( surfaceCellMap.get( surfaceKey ) || null );

		updateWorld( world, contactListener, dt );

		vehicle.update( dt, input );
		updateActiveBoost( dt );
		const boostGridX = Math.floor( vehicle.spherePos.x / ( CELL_RAW * GRID_SCALE ) - 0.5 );
		const boostGridZ = Math.floor( vehicle.spherePos.z / ( CELL_RAW * GRID_SCALE ) - 0.5 );
		const boostKey = `${ boostGridX },${ boostGridZ }`;
		if ( boostCellSet.has( boostKey ) ) {

			if ( boostContactCell !== boostKey ) {

				applyBoost();
				boostContactCell = boostKey;

			}

		} else {

			boostContactCell = null;

		}

		dirLight.position.set(
			vehicle.spherePos.x + 11.4,
			15,
			vehicle.spherePos.z - 5.3
		);

		cam.update( dt, vehicle.spherePos, vehicle.container.quaternion );
		particles.update( dt, vehicle );
		audio.update( dt, vehicle.linearSpeed, input.z, vehicle.driftIntensity );

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

					const completedLap = timer.getElapsed() - lapStartSeconds;
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
					lapNumber ++;
					lapStartSeconds = timer.getElapsed();
					resetCurrentLapGhost();
					recordGhostSample( 0, true );
					updateGhostPlayback( 0 );
				hasLeftStartZone = false;
				for ( const checkpoint of checkpointStates ) {

					checkpoint.passedThisLap = false;

				}
				saveLapStats();
				rewardCoinsForLap( completedLap );

			}

			lastLocalX = localX;
			lastLocalZ = localZ;
			hasPrevFinishSample = true;

		}

		lapSeconds = timer.getElapsed() - lapStartSeconds;
		recordGhostSample( lapSeconds );
		updateGhostPlayback( lapSeconds );
		updateLapHud();

		renderer.render( scene, cam.camera );

	}

	animate();

}

init();
