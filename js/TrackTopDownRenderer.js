// Renders a single frozen, bird's-eye-view PNG/JPEG snapshot of a track,
// using the SAME block models and track builder as the game/editor — so
// share-board previews finally look like the real thing instead of flat
// colored squares.
//
// Design goals (see PR description):
//  - Reuses buildTrack/computeTrackBounds straight from Track.js (imported,
//    never modified) so the preview is always geometrically accurate.
//  - Renders ONCE per track, then the caller freezes/caches that single
//    frame (a data URL) — this module never re-renders a track it has
//    already produced a frame for in this page session (see the in-memory
//    cache below), and callers are expected to persist the result (see
//    tracks.html / author.html) so it is not re-rendered on future visits.
//  - All render calls are queued through a single WebGL context, one at a
//    time, so a board full of cards never renders "hundreds of previews at
//    once" — it renders them one-by-one, reusing one canvas/context.
//
// This file is standalone: it does not touch js/main.js or js/Track.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildTrack, computeTrackBounds, prerenderWaterRefraction } from './Track.js?v=1000240';

// Only the STATIC (non-vehicle) models a track can ever place. Deliberately
// excludes every vehicle-*.glb (no cars are drawn in a top-down preview) and
// the walk-in 'garage' scene (never placed as a track piece). ~1.6MB total,
// fetched once per page load and reused for every preview render after that.
const STATIC_MODEL_NAMES = [
	'track-straight', 'track-corner', 'track-checkpoint-corner', 'track-bump', 'track-finish',
	'track-3-way', 'track-4-way',
	'track-choke-half', 'track-choke-both',
	'elev-track-straight', 'elev-track-cross', 'elev-track-corner', 'elev-cross-corners',
	'elev-track-checkpoint', 'elev-track-slope', 'elev-track-3-way', 'elev-track-4-way',
	'elev-track-choke-half', 'elev-track-choke-both',
	'decoration-empty', 'decoration-forest', 'decoration-tents', 'empty-deco-grass',
	'building-garage', 'building-small-a', 'building-small-b', 'building-small-c', 'building-small-d',
	'barrier',
];

let modelsPromise = null;

function loadStaticModels() {

	if ( modelsPromise ) return modelsPromise;

	const loader = new GLTFLoader();
	modelsPromise = Promise.all( STATIC_MODEL_NAMES.map( ( name ) => new Promise( ( resolve ) => {

		loader.load(
			`models/${ name }.glb`,
			( gltf ) => {

				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh && ! name.startsWith( 'elev-track-' ) ) child.material.side = THREE.FrontSide;

				} );
				// Buildings are authored tiny (~1 cell), same 10x scale main.js applies.
				if ( name.startsWith( 'building-' ) ) gltf.scene.scale.setScalar( 10 );
				resolve( [ name, gltf.scene ] );

			},
			undefined,
			() => resolve( [ name, null ] ), // missing/broken model: skip it, don't fail the whole preview
		);

	} ) ) ).then( ( pairs ) => {

		const models = {};
		for ( const [ name, scene ] of pairs ) if ( scene ) models[ name ] = scene;
		return models;

	} );

	return modelsPromise;

}

// Mirrors main.js's extrasFromParsed() — the share-link mods payload's short
// keys (b/p/k/l/s/e/j/d/m/a/u/c/y/x/o/t/q/z/r) are a stable, append-only
// public format already duplicated in tracks.html/author.html's own preview
// code, so duplicating the mapping here (rather than importing an
// unexported function from main.js) matches the existing codebase pattern.
function extrasFromMods( parsed ) {

	if ( ! parsed || typeof parsed !== 'object' ) return null;
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
		poolSlopes: Array.isArray( parsed.z ) ? parsed.z : [],
		customPool: parsed?.r && typeof parsed.r === 'object' ? parsed.r : {},
	};

}

function disposeObject( obj ) {

	obj.traverse( ( child ) => {

		if ( child.geometry ) child.geometry.dispose();
		if ( child.material ) {

			const mats = Array.isArray( child.material ) ? child.material : [ child.material ];
			for ( const mat of mats ) {

				for ( const key of [ 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap' ] ) {

					if ( mat[ key ] ) mat[ key ].dispose();

				}
				mat.dispose();

			}

		}

	} );

}

let sharedRenderer = null;

function getRenderer( width, height ) {

	if ( ! sharedRenderer ) {

		sharedRenderer = new THREE.WebGLRenderer( { antialias: true, preserveDrawingBuffer: true, alpha: false } );
		sharedRenderer.setPixelRatio( 1 );

	}
	sharedRenderer.setSize( width, height, false );
	return sharedRenderer;

}

async function renderNow( cells, mods, width, height, quality = 0.87 ) {

	const safeCells = Array.isArray( cells ) ? cells : [];
	if ( ! safeCells.length ) return null;

	const models = await loadStaticModels();

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x2f8f5f );

	const dirLight = new THREE.DirectionalLight( 0xffffff, 3.3 );
	dirLight.position.set( 40, 90, 24 );
	scene.add( dirLight );
	scene.add( new THREE.HemisphereLight( 0xc9d8e8, 0x3a6a3a, 1.7 ) );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.5 ) );

	const extras = extrasFromMods( mods );
	const trackGroup = buildTrack( scene, models, safeCells, extras );

	const bounds = computeTrackBounds( safeCells );
	const pad = 4;
	// Fit the WHOLE track into the frame without distortion: pick the scale
	// where both the width and depth spans fit the canvas aspect, then build
	// the ortho frustum from it (frustum extents are camera-space and the
	// camera is centered on the track, so this covers it exactly).
	const aspect = width / height;
	const spanW = Math.max( 6, bounds.halfWidth + pad );
	const spanD = Math.max( 6, bounds.halfDepth + pad );
	const halfH = Math.max( spanD, spanW / aspect );
	const halfW = halfH * aspect;
	const camHeight = Math.max( spanW, spanD ) * 2 + 40;

	const camera = new THREE.OrthographicCamera( -halfW, halfW, halfH, -halfH, 0.1, camHeight * 2 );
	camera.position.set( bounds.centerX, camHeight, bounds.centerZ );
	camera.up.set( 0, 0, -1 ); // straight-down look needs an explicit up axis
	camera.lookAt( bounds.centerX, 0, bounds.centerZ );
	camera.updateMatrixWorld();

	const renderer = getRenderer( width, height );

	// Populate the water refraction render target once, if this track has
	// any water, so pools don't render as a flat placeholder.
	try {

		prerenderWaterRefraction( renderer, scene, camera );

	} catch ( e ) {}

	renderer.render( scene, camera );

	let dataUrl = null;
	try {

		dataUrl = renderer.domElement.toDataURL( 'image/jpeg', quality );

	} catch ( e ) {

		dataUrl = null;

	}

	scene.remove( trackGroup );
	disposeObject( trackGroup );

	return dataUrl;

}

let queue = Promise.resolve();
// In-memory cache for this page session — a track is rendered at most once
// per unique cache key even if multiple cards ask for it concurrently.
// One-time cleanup: earlier versions cached rendered previews in
// localStorage (up to 40 entries, ~25KB each). That persistence has been
// removed — renders are now in-memory only for the current page load —
// but purge any leftover entries from before so old browsers reclaim the
// space instead of carrying dead data forever.
try {
	const legacyKeys = [];
	for ( let i = 0; i < localStorage.length; i ++ ) {
		const k = localStorage.key( i );
		if ( k && k.startsWith( 'racing-preview-3d:' ) ) legacyKeys.push( k );
	}
	for ( const k of legacyKeys ) localStorage.removeItem( k );
} catch ( e ) {}

const memoryCache = new Map();
const pending = new Map();

/**
 * Renders one frozen top-down snapshot of a track and returns its data URL.
 * Safe to call for many tracks in a row — renders are queued one at a time
 * through a single shared WebGL context (never spins up hundreds of GPU
 * contexts at once), and repeat calls with the same cacheKey return the
 * already-rendered frame instead of rendering again.
 *
 * @param {Array} cells - [gx, gz, type, orient] tuples (same shape buildTrack expects)
 * @param {Object} mods - the raw share-link mods payload (short-key format)
 * @param {Object} [options]
 * @param {string} [options.cacheKey] - stable id to dedupe/cache renders across calls
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @returns {Promise<string|null>} a data URL (JPEG), or null if nothing to render
 */
export function renderTrackTopDown( cells, mods, options = {} ) {

	const { cacheKey = null, width = 640, height = 384, quality = 0.87 } = options;

	if ( cacheKey && memoryCache.has( cacheKey ) ) return Promise.resolve( memoryCache.get( cacheKey ) );
	if ( cacheKey && pending.has( cacheKey ) ) return pending.get( cacheKey );

	const job = queue.then( () => renderNow( cells, mods, width, height, quality ) );
	queue = job.catch( () => {} );

	const tracked = job.then( ( dataUrl ) => {

		if ( cacheKey ) {

			memoryCache.set( cacheKey, dataUrl );
			pending.delete( cacheKey );

		}
		return dataUrl;

	} );

	if ( cacheKey ) pending.set( cacheKey, tracked );
	return tracked;

}
