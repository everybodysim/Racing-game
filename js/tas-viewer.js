import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, TRACK_CELLS, ORIENT_DEG, CELL_RAW, GRID_SCALE } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';

const FIXED_DT = 1 / 120;
const MAX_STEPS = 120 * 120;
const ENGINE_MULTS = [ 1, 1.025, 1.05, 1.075, 1.1 ];
const MODELS = [
  'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
  'track-straight', 'track-corner', 'track-bump', 'track-finish',
  'decoration-empty', 'decoration-forest', 'decoration-tents'
];
const CAR_STATS = {
  'vehicle-truck-yellow': { topSpeed: 1.0, accelRate: 6.0, driveForce: 100.0 },
  'vehicle-truck-green': { topSpeed: 0.92, accelRate: 7.8, driveForce: 108.0 },
  'vehicle-truck-purple': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-truck-red': { topSpeed: 1.05, accelRate: 5.5, driveForce: 102.0 },
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(200, 200);
const view = document.getElementById('view');
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xadb2ba);
scene.fog = new THREE.Fog(0xadb2ba, 30, 55);

const dirLight = new THREE.DirectionalLight(0xffffff, 5);
dirLight.position.set(11.4, 15, -5.3);
scene.add(dirLight);
scene.add(new THREE.HemisphereLight(0xc8d8e8, 0x7a8a5a, 1.5));

const lapHud = document.getElementById('lap');
const statusEl = document.getElementById('status');
const inputsEl = document.getElementById('inputs');
const carSelect = document.getElementById('car-select');
const trackUrlInput = document.getElementById('track-url');
const engineTierInput = document.getElementById('engine-tier');
const garageGripInput = document.getElementById('garage-grip');
const garageAccelInput = document.getElementById('garage-accel');
const garageDriveInput = document.getElementById('garage-drive');
const rng = seededRng(0x1234abcd);

let models = {};
let world;
let vehicle;
let cameraRig;
let trackGroup = null;
let currentCells = null;
let steps = [];
let currentStep = 0;
let simulationTime = 0;
let raceClockSeconds = 0;
let lapNumber = 1;
let lapStartSeconds = 0;
let lapSeconds = 0;
let lastLapSeconds = null;
let bestLapSeconds = null;
let hasPrevFinishSample = false;
let lastLocalX = 0;
let lastLocalZ = 0;
let hasLeftStartZone = false;
let checkpointStates = [];
let finishData = null;
let lapHistory = [];
let lastFrameNow = performance.now() / 1000;
let playbackAccumulator = 0;
let currentExtras = null;
let runtimeReady = false;
let physicsEnabled = true;

const fallbackCamera = new THREE.PerspectiveCamera( 50, 1, 0.1, 100 );
fallbackCamera.position.set( 3, 2, 4 );
fallbackCamera.lookAt( 0, 0, 0 );
const fallbackMesh = new THREE.Mesh(
	new THREE.BoxGeometry( 0.8, 0.8, 0.8 ),
	new THREE.MeshStandardMaterial( { color: 0x00d4ff, emissive: 0x123355, roughness: 0.35 } )
);
fallbackMesh.position.set( 0, 1, 0 );
scene.add( fallbackMesh );

function seededRng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000); }
function encodeCode(data) { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function decodeCode(code) { return JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g, '+').replace(/_/g, '/'))))); }

function parseInputLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [inputRaw = '', fRaw = '1'] = trimmed.split(',');
    const frames = Math.max(1, Math.min(1200, Math.floor(Number(fRaw) || 1)));
    const token = String(inputRaw).trim();
    const parts = token.split('+').map((v) => v.trim()).filter(Boolean);
    const keys = {
      left: parts.includes('ArrowLeft'),
      right: parts.includes('ArrowRight'),
      up: parts.includes('ArrowUp'),
      down: parts.includes('ArrowDown'),
    };
    for (let i = 0; i < frames; i++) out.push({ keys });
  }
  return out;
}

function serializeSteps(stepArray) {
  if (!stepArray.length) return '';
  const rows = [];
  const keyLabel = ( step ) => {
    const keys = [];
    if ( step.keys?.up ) keys.push( 'ArrowUp' );
    if ( step.keys?.down ) keys.push( 'ArrowDown' );
    if ( step.keys?.left ) keys.push( 'ArrowLeft' );
    if ( step.keys?.right ) keys.push( 'ArrowRight' );
    return keys.join( '+' ) || 'None';
  };
  let prev = stepArray[0], count = 1;
  for (let i = 1; i < stepArray.length; i++) {
    const s = stepArray[i];
    const same = JSON.stringify( s.keys ) === JSON.stringify( prev.keys );
    if ( same ) count++;
    else { rows.push(`${keyLabel(prev)},${count}`); prev = s; count = 1; }
  }
  rows.push(`${keyLabel(prev)},${count}`);
  return rows.join('\n');
}

function keysToAxes( keys ) {
  if ( ! keys ) return { x: 0, z: 0 };
  const x = ( keys.right ? 1 : 0 ) - ( keys.left ? 1 : 0 );
  const z = ( keys.up ? 1 : 0 ) - ( keys.down ? 1 : 0 );
  return { x, z };
}

function buildWorld() {
  const settings = createWorldSettings();
  const BPL_MOVING = addBroadphaseLayer(settings);
  const BPL_STATIC = addBroadphaseLayer(settings);
  const OL_MOVING = addObjectLayer(settings, BPL_MOVING);
  const OL_STATIC = addObjectLayer(settings, BPL_STATIC);
  enableCollision(settings, OL_MOVING, OL_STATIC);
  enableCollision(settings, OL_MOVING, OL_MOVING);
  const nextWorld = createWorld(settings);
  nextWorld._OL_MOVING = OL_MOVING;
  nextWorld._OL_STATIC = OL_STATIC;
  return nextWorld;
}

function formatLapTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--.---';
  const mins = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const ms = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function makeGateData(cell) {
  if (!cell) return null;
  const [gx, gz, , orient] = cell;
  const centerX = (gx + 0.5) * CELL_RAW * GRID_SCALE;
  const centerZ = (gz + 0.5) * CELL_RAW * GRID_SCALE;
  const halfExtent = (CELL_RAW * GRID_SCALE) * 0.5;
  const angle = THREE.MathUtils.degToRad(ORIENT_DEG[orient] || 0);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return { centerX, centerZ, halfExtent, cosA, sinA };
}

function parseExtrasFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const target = new URL(rawUrl, window.location.href);
    const modsParam = target.searchParams.get('mods');
    if (!modsParam) return null;
    const json = decodeURIComponent(escape(atob(modsParam.replace(/-/g, '+').replace(/_/g, '/'))));
    const parsed = JSON.parse(json);
    return {
      bumps: Array.isArray(parsed.b) ? parsed.b : [],
      boosts: Array.isArray(parsed.s) ? parsed.s : [],
      jumps: Array.isArray(parsed.j) ? parsed.j : [],
      decorations: Array.isArray(parsed.d) ? parsed.d : [],
      surfaces: Array.isArray(parsed.u) ? parsed.u : [],
      customSurfaces: parsed?.c && typeof parsed.c === 'object' ? parsed.c : {},
    };
  } catch {
    return null;
  }
}

function updateCarConfig() {
  if (!vehicle) return;
  const carKey = carSelect.value;
  const tier = Math.max(0, Math.min(ENGINE_MULTS.length - 1, Number(engineTierInput.value || 0)));
  const mult = ENGINE_MULTS[tier];
  if (models[carKey]) vehicle.setModel(models[carKey]);
  const stats = CAR_STATS[carKey] || CAR_STATS['vehicle-truck-yellow'];
  vehicle.setPerformance({
    topSpeed: stats.topSpeed * mult,
    accelRate: stats.accelRate * mult,
    driveForce: stats.driveForce * mult,
  });
  vehicle.gripMultiplier = Number(garageGripInput.value || 1);
  vehicle.accelMultiplier = Number(garageAccelInput.value || 1);
  vehicle.driveMultiplier = Number(garageDriveInput.value || 1);
}

function resetRun() {
  currentStep = 0;
  simulationTime = 0;
  raceClockSeconds = 0;
  lapNumber = 1;
  lapStartSeconds = 0;
  lapSeconds = 0;
  lastLapSeconds = null;
  bestLapSeconds = null;
  hasPrevFinishSample = false;
  lastLocalX = 0;
  lastLocalZ = 0;
  hasLeftStartZone = false;
  lapHistory = [];
  for (const checkpoint of checkpointStates) {
    checkpoint.lastLocalX = 0;
    checkpoint.lastLocalZ = 0;
    checkpoint.hasPrevSample = false;
    checkpoint.passedThisLap = false;
  }
  vehicle?.resetToSpawn();
  lapHud.textContent = `Lap ${lapNumber} • ${formatLapTime(0)} • Last --:--.--- • Best --:--.---`;
}

function stepSimulation(input) {
  updateCarConfig();
  const axes = keysToAxes( input?.keys );
  raceClockSeconds += FIXED_DT;
  lapSeconds = Math.max(0, raceClockSeconds - lapStartSeconds);
  if (physicsEnabled && world) updateWorld(world, null, FIXED_DT);
  vehicle.update(FIXED_DT, axes);
  if ( ! physicsEnabled ) {
    const forward = new THREE.Vector3( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).setY( 0 ).normalize();
    vehicle.spherePos.addScaledVector( forward, vehicle.linearSpeed * 8.5 * FIXED_DT );
    vehicle.spherePos.y = 0.5;
    vehicle.container.position.set( vehicle.spherePos.x, vehicle.spherePos.y - 0.5, vehicle.spherePos.z );
  }
  cameraRig.update(FIXED_DT, vehicle.spherePos, vehicle.container.quaternion);
  simulationTime += FIXED_DT;
  if (finishData) {
    for (const checkpoint of checkpointStates) {
      const localX = (((vehicle.spherePos.x - checkpoint.centerX) * checkpoint.cosA) + ((vehicle.spherePos.z - checkpoint.centerZ) * checkpoint.sinA));
      const localZ = ((-(vehicle.spherePos.x - checkpoint.centerX) * checkpoint.sinA) + ((vehicle.spherePos.z - checkpoint.centerZ) * checkpoint.cosA));
      let crossedCheckpoint = false;
      if (checkpoint.hasPrevSample) {
        const z0 = checkpoint.lastLocalZ;
        const z1 = localZ;
        const crossedPlane = (z0 < 0 && z1 > 0) || (z0 > 0 && z1 < 0);
        if (crossedPlane) {
          const t = z0 / (z0 - z1);
          const xCross = THREE.MathUtils.lerp(checkpoint.lastLocalX, localX, t);
          crossedCheckpoint = t >= 0 && t <= 1 && Math.abs(xCross) <= checkpoint.halfExtent;
        }
      }
      if (crossedCheckpoint) checkpoint.passedThisLap = true;
      checkpoint.lastLocalX = localX;
      checkpoint.lastLocalZ = localZ;
      checkpoint.hasPrevSample = true;
    }

    const localX = (((vehicle.spherePos.x - finishData.centerX) * finishData.cosA) + ((vehicle.spherePos.z - finishData.centerZ) * finishData.sinA));
    const localZ = ((-(vehicle.spherePos.x - finishData.centerX) * finishData.sinA) + ((vehicle.spherePos.z - finishData.centerZ) * finishData.cosA));
    const inFinishCell = Math.abs(localX) < finishData.halfExtent && Math.abs(localZ) < finishData.halfExtent;
    if (!hasLeftStartZone && !inFinishCell) hasLeftStartZone = true;

    let crossedFinish = false;
    if (hasPrevFinishSample) {
      const z0 = lastLocalZ;
      const z1 = localZ;
      const crossedPlane = (z0 < 0 && z1 > 0) || (z0 > 0 && z1 < 0);
      if (crossedPlane) {
        const t = z0 / (z0 - z1);
        const xCross = THREE.MathUtils.lerp(lastLocalX, localX, t);
        crossedFinish = t >= 0 && t <= 1 && Math.abs(xCross) <= finishData.halfExtent;
      }
    }

    const allCheckpointsPassed = checkpointStates.every((checkpoint) => checkpoint.passedThisLap);
    if (hasLeftStartZone && allCheckpointsPassed && crossedFinish) {
      const completedLap = raceClockSeconds - lapStartSeconds;
      lastLapSeconds = completedLap;
      bestLapSeconds = bestLapSeconds === null ? completedLap : Math.min(bestLapSeconds, completedLap);
      lapHistory.push(completedLap);
      lapNumber += 1;
      lapStartSeconds = raceClockSeconds;
      hasLeftStartZone = false;
      for (const checkpoint of checkpointStates) checkpoint.passedThisLap = false;
    }

    lastLocalX = localX;
    lastLocalZ = localZ;
    hasPrevFinishSample = true;
  }

  lapHud.textContent = `Lap ${lapNumber} • ${formatLapTime(lapSeconds)} • Last ${formatLapTime(lastLapSeconds)} • Best ${formatLapTime(bestLapSeconds)}`;
}

function evaluate(inputSteps) {
  resetRun();
  for (let i = 0; i < Math.min(MAX_STEPS, inputSteps.length); i++) {
    stepSimulation(inputSteps[i]);
    if (lapHistory.length > 0) return lapHistory[0];
  }
  return 999999;
}

function parseTrackCellsFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const target = new URL(rawUrl, window.location.href);
    const mapParam = target.searchParams.get('map');
    return mapParam ? decodeCells(mapParam) : null;
  } catch {
    return null;
  }
}

function rebuildTrack() {
  if (trackGroup) {
    trackGroup.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry?.dispose?.();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((entry) => entry?.dispose?.());
      else material?.dispose?.();
    });
    scene.remove(trackGroup);
    trackGroup = null;
  }
  try {
    world = buildWorld();
    physicsEnabled = true;
  } catch (error) {
    physicsEnabled = false;
    world = null;
    console.warn('TAS physics init failed; using kinematic fallback.', error);
  }
  currentCells = parseTrackCellsFromUrl(trackUrlInput.value.trim());
  currentExtras = parseExtrasFromUrl(trackUrlInput.value.trim());
  trackGroup = buildTrack(scene, models, currentCells, currentExtras);
  if ( physicsEnabled && world ) buildWallColliders(world, null, currentCells, null);

  const spawn = computeSpawnPosition(currentCells);
  const bounds = computeTrackBounds(currentCells);
  const groundSize = Math.max(bounds.halfWidth, bounds.halfDepth) * 2 + 20;
  if ( physicsEnabled && world ) {
    rigidBody.create(world, {
      shape: box.create({ halfExtents: [groundSize / 2, 0.5, groundSize / 2] }),
      motionType: MotionType.STATIC,
      objectLayer: world._OL_STATIC,
      position: [bounds.centerX, -0.5, bounds.centerZ]
    });
  }

  if (vehicle?.container) scene.remove(vehicle.container);
  vehicle = new Vehicle();
  if ( physicsEnabled && world ) {
    vehicle.physicsWorld = world;
    vehicle.rigidBody = createSphereBody(world, spawn);
  }
  vehicle.setSpawn(spawn, 0);
  scene.add(vehicle.init(models[carSelect.value] || models['vehicle-truck-yellow']));
  updateCarConfig();
  const activeCells = currentCells || TRACK_CELLS;
  const finishCell = activeCells.find((c) => c[2] === 'track-finish') || activeCells[0];
  const checkpointCells = activeCells.filter((c) => c[2] === 'track-checkpoint');
  finishData = makeGateData(finishCell);
  checkpointStates = checkpointCells.map((cell) => ({
    ...makeGateData(cell),
    lastLocalX: 0,
    lastLocalZ: 0,
    hasPrevSample: false,
    passedThisLap: false,
  }));
  resetRun();
}

function animate() {
  requestAnimationFrame(animate);
  if ( ! runtimeReady ) {
    fallbackMesh.rotation.x += 0.01;
    fallbackMesh.rotation.y += 0.02;
    renderer.render( scene, fallbackCamera );
    return;
  }
  const now = performance.now() / 1000;
  const dt = Math.min(0.25, Math.max(0, now - lastFrameNow));
  lastFrameNow = now;
  playbackAccumulator += dt;

  while (playbackAccumulator >= FIXED_DT && vehicle) {
    const inputStep = currentStep < steps.length ? steps[currentStep] : null;
    stepSimulation(inputStep || { keys: { up: false, down: false, left: false, right: false } });
    if (currentStep < steps.length) currentStep += 1;
    playbackAccumulator -= FIXED_DT;
  }
  renderer.render(scene, cameraRig.camera);
}

async function initScene() {
  registerAll();
  cameraRig = new Camera();
  cameraRig.mode = 'overview';

  const loader = new GLTFLoader();
  await Promise.all(MODELS.map((name) => new Promise((resolve, reject) => {
    loader.load(`models/${name}.glb`, (gltf) => {
      if (name.startsWith('vehicle-')) gltf.scene.scale.setScalar(0.5);
      models[name] = gltf.scene;
      resolve();
    }, undefined, reject);
  })));

  rebuildTrack();
  steps = parseInputLines(inputsEl.value);
  runtimeReady = true;
  scene.remove( fallbackMesh );
  resize();
}

function resize() {
  const sidebar = document.getElementById('side');
  const width = Math.max(240, window.innerWidth - sidebar.offsetWidth);
  const height = window.innerHeight;
  renderer.setSize(width, height);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  if (cameraRig?.camera) {
    cameraRig.camera.aspect = width / height;
    cameraRig.camera.updateProjectionMatrix();
  }
}

document.getElementById('new-btn')?.addEventListener('click', () => {
  steps = [];
  inputsEl.value = '';
  resetRun();
  statusEl.textContent = 'Created new TAS.';
});

document.getElementById('run-btn')?.addEventListener('click', () => {
  steps = parseInputLines(inputsEl.value);
  resetRun();
  lastFrameNow = performance.now() / 1000;
  playbackAccumulator = 0;
  statusEl.textContent = `Running ${steps.length} deterministic input frames.`;
});

document.getElementById('load-track-btn')?.addEventListener('click', () => {
  rebuildTrack();
  statusEl.textContent = 'Loaded track data from URL (or default track).';
});

for (const el of [carSelect, engineTierInput, garageGripInput, garageAccelInput, garageDriveInput]) {
  el?.addEventListener('input', () => {
    updateCarConfig();
    statusEl.textContent = 'TAS car/performance config updated.';
  });
}

document.getElementById('export-btn')?.addEventListener('click', async () => {
  const code = encodeCode({
    steps: parseInputLines(inputsEl.value),
    trackUrl: trackUrlInput.value.trim(),
    car: carSelect.value,
    engineTier: Number(engineTierInput.value || 0),
    garageGrip: Number(garageGripInput.value || 1),
    garageAccel: Number(garageAccelInput.value || 1),
    garageDrive: Number(garageDriveInput.value || 1),
  });
  try {
    await navigator.clipboard.writeText(code);
    statusEl.textContent = 'Ghost code copied to clipboard.';
  } catch {
    statusEl.textContent = 'Could not copy; code is still valid.';
  }
});

document.getElementById('import-btn')?.addEventListener('click', () => {
  try {
    const data = decodeCode(document.getElementById('import-code').value.trim());
    if (Array.isArray(data?.steps)) {
      steps = data.steps;
      inputsEl.value = serializeSteps(steps);
    }
    if (typeof data?.trackUrl === 'string') trackUrlInput.value = data.trackUrl;
    if (typeof data?.car === 'string' && models[data.car]) carSelect.value = data.car;
    if (Number.isFinite(Number(data?.engineTier))) engineTierInput.value = String(data.engineTier);
    if (Number.isFinite(Number(data?.garageGrip))) garageGripInput.value = String(data.garageGrip);
    if (Number.isFinite(Number(data?.garageAccel))) garageAccelInput.value = String(data.garageAccel);
    if (Number.isFinite(Number(data?.garageDrive))) garageDriveInput.value = String(data.garageDrive);
    rebuildTrack();
    resetRun();
    statusEl.textContent = `Imported ${steps.length} input frames.`;
  } catch {
    statusEl.textContent = 'Invalid ghost code.';
  }
});

document.getElementById('bf-btn')?.addEventListener('click', () => {
  let working = parseInputLines(inputsEl.value);
  const count = Math.max(1, Math.floor(Number(document.getElementById('bf-count').value || 1)));
  const reps = Math.max(1, Math.floor(Number(document.getElementById('bf-reps').value || 1)));
  let best = evaluate(working);
  for (let i = 0; i < reps; i++) {
    const maxIndex = Math.max(0, Math.min(working.length - 1, count - 1));
    if (maxIndex <= 0) break;
    const idx = Math.floor(rng() * (maxIndex + 1));
    const old = working[idx] || { keys: { up: false, down: false, left: false, right: false } };
    working[idx] = {
      keys: {
        up: rng() > 0.5,
        down: rng() > 0.85,
        left: rng() > 0.5,
        right: rng() > 0.5,
      }
    };
    const next = evaluate(working);
    if (next < best) best = next;
    else working[idx] = old;
  }
  steps = working;
  inputsEl.value = serializeSteps(working);
  resetRun();
  statusEl.textContent = `Brute force done. Best time: ${best.toFixed(3)}s`;
});

window.addEventListener('resize', resize);
resize();
animate();

initScene().catch((error) => {
  statusEl.textContent = error.message;
  console.error(error);
});
