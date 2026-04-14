import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds } from './Track.js';
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
let lapCount = 1;
let lastCross = false;

function seededRng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000); }
function encodeCode(data) { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function decodeCode(code) { return JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g, '+').replace(/_/g, '/'))))); }

function parseInputLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [xRaw, zRaw, fRaw] = trimmed.split(',').map((v) => Number(v));
    const x = Number.isFinite(xRaw) ? THREE.MathUtils.clamp(xRaw, -1, 1) : 0;
    const z = Number.isFinite(zRaw) ? THREE.MathUtils.clamp(zRaw, -1, 1) : 0;
    const frames = Math.max(1, Math.min(1200, Math.floor(fRaw || 1)));
    for (let i = 0; i < frames; i++) out.push({ x, z });
  }
  return out;
}

function serializeSteps(stepArray) {
  if (!stepArray.length) return '';
  const rows = [];
  let prev = stepArray[0], count = 1;
  for (let i = 1; i < stepArray.length; i++) {
    const s = stepArray[i];
    if (s.x === prev.x && s.z === prev.z) count++;
    else { rows.push(`${prev.x},${prev.z},${count}`); prev = s; count = 1; }
  }
  rows.push(`${prev.x},${prev.z},${count}`);
  return rows.join('\n');
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
  lapCount = 1;
  lastCross = false;
  vehicle?.resetToSpawn();
}

function stepSimulation(input) {
  updateCarConfig();
  updateWorld(world, null, FIXED_DT);
  vehicle.update(FIXED_DT, input || { x: 0, z: 0 });
  cameraRig.update(FIXED_DT, vehicle.spherePos, vehicle.container.quaternion);
  simulationTime += FIXED_DT;

  const nowCross = vehicle.spherePos.z > 5 && Math.abs(vehicle.spherePos.x - 3.5) < 3;
  if (nowCross && !lastCross) lapCount += 1;
  lastCross = nowCross;
  lapHud.textContent = `Lap ${Math.min(lapCount, 2)}/2 • ${simulationTime.toFixed(3)}s`;
}

function evaluate(inputSteps) {
  resetRun();
  for (let i = 0; i < Math.min(MAX_STEPS, inputSteps.length); i++) {
    stepSimulation(inputSteps[i]);
    if (lapCount > 2) return simulationTime;
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
    scene.remove(trackGroup);
    trackGroup = null;
  }
  world = buildWorld();
  currentCells = parseTrackCellsFromUrl(trackUrlInput.value.trim());
  trackGroup = buildTrack(scene, models, currentCells, null);
  buildWallColliders(world, null, currentCells, null);

  const spawn = computeSpawnPosition(currentCells);
  const bounds = computeTrackBounds(currentCells);
  const groundSize = Math.max(bounds.halfWidth, bounds.halfDepth) * 2 + 20;
  rigidBody.create(world, {
    shape: box.create({ halfExtents: [groundSize / 2, 0.5, groundSize / 2] }),
    motionType: MotionType.STATIC,
    objectLayer: world._OL_STATIC,
    position: [bounds.centerX, -0.5, bounds.centerZ]
  });

  if (vehicle?.container) scene.remove(vehicle.container);
  vehicle = new Vehicle();
  vehicle.physicsWorld = world;
  vehicle.rigidBody = createSphereBody(world, spawn);
  vehicle.setSpawn(spawn, 0);
  scene.add(vehicle.init(models[carSelect.value] || models['vehicle-truck-yellow']));
  updateCarConfig();
  resetRun();
}

function animate() {
  requestAnimationFrame(animate);
  if (vehicle && currentStep < steps.length && lapCount <= 2) {
    stepSimulation(steps[currentStep]);
    currentStep += 1;
  } else if (vehicle) {
    cameraRig.update(FIXED_DT, vehicle.spherePos, vehicle.container.quaternion);
  }
  renderer.render(scene, cameraRig.camera);
}

async function initScene() {
  registerAll();
  cameraRig = new Camera();
  cameraRig.mode = 'chase';

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
  resize();
  animate();
}

function resize() {
  const sidebar = document.getElementById('side');
  const width = Math.max(240, window.innerWidth - sidebar.offsetWidth);
  const height = window.innerHeight;
  renderer.setSize(width, height);
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
    const old = working[idx] || { x: 0, z: 0 };
    working[idx] = { x: [-1, 0, 1][Math.floor(rng() * 3)], z: [-1, 0, 1][Math.floor(rng() * 3)] };
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

initScene().catch((error) => {
  statusEl.textContent = error.message;
  console.error(error);
});
