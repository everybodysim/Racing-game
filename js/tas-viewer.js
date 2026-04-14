import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { buildTrack, computeSpawnPosition } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';

const FIXED_DT = 1 / 120;
const MAX_STEPS = 120 * 120;
const MODELS = [ 'vehicle-truck-yellow', 'track-straight', 'track-corner', 'track-bump', 'track-finish', 'decoration-empty', 'decoration-forest', 'decoration-tents' ];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth - 320, window.innerHeight);
document.getElementById('view').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xadb2ba);
scene.fog = new THREE.Fog(0xadb2ba, 30, 55);
scene.add(new THREE.DirectionalLight(0xffffff, 3));
scene.add(new THREE.HemisphereLight(0xc8d8e8, 0x7a8a5a, 1.2));

const lapHud = document.getElementById('lap');
const statusEl = document.getElementById('status');
const inputsEl = document.getElementById('inputs');
const rng = seededRng(0x1234abcd);

let world, vehicle, cameraRig;
let steps = [];
let currentStep = 0;
let simulationTime = 0;
let lapCount = 1;
let lastCross = false;

function seededRng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function encodeCode(data) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decodeCode(code) {
  const raw = code.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(raw))));
}

function parseInputLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [xRaw, zRaw, fRaw] = trimmed.split(',').map((v) => Number(v));
    const x = Number.isFinite(xRaw) ? Math.max(-1, Math.min(1, xRaw)) : 0;
    const z = Number.isFinite(zRaw) ? Math.max(-1, Math.min(1, zRaw)) : 0;
    const frames = Math.max(1, Math.min(600, Math.floor(fRaw || 1)));
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

function resetRun() {
  currentStep = 0;
  simulationTime = 0;
  lapCount = 1;
  lastCross = false;
  vehicle.resetToSpawn();
}

function finishEval(seconds) {
  return Number.isFinite(seconds) ? seconds : 999999;
}

function evaluate(inputSteps) {
  resetRun();
  for (let i = 0; i < Math.min(MAX_STEPS, inputSteps.length); i++) {
    stepSimulation(inputSteps[i]);
    if (lapCount > 2) return finishEval(simulationTime);
  }
  return finishEval(null);
}

function stepSimulation(input) {
  updateWorld(world, null, FIXED_DT);
  vehicle.update(FIXED_DT, input || { x: 0, z: 0 });
  cameraRig.update(FIXED_DT, vehicle.spherePos, vehicle.container.quaternion);
  simulationTime += FIXED_DT;

  const nowCross = vehicle.spherePos.z > 5 && Math.abs(vehicle.spherePos.x - 3.5) < 3;
  if (nowCross && !lastCross) lapCount += 1;
  lastCross = nowCross;
  lapHud.textContent = `Lap ${Math.min(lapCount, 2)}/2 • ${(simulationTime).toFixed(3)}s`;
}

async function initScene() {
  registerAll();
  const settings = createWorldSettings();
  addBroadphaseLayer(settings, 'BP_STATIC');
  addBroadphaseLayer(settings, 'BP_MOVING');
  addObjectLayer(settings, 'OL_STATIC', 'BP_STATIC');
  addObjectLayer(settings, 'OL_MOVING', 'BP_MOVING');
  enableCollision(settings, 'OL_MOVING', 'OL_STATIC');
  enableCollision(settings, 'OL_MOVING', 'OL_MOVING');
  world = createWorld(settings);

  const models = {};
  const loader = new GLTFLoader();
  await Promise.all(MODELS.map((name) => new Promise((resolve, reject) => {
    loader.load(`models/${name}.glb`, (gltf) => {
      if (name.startsWith('vehicle-')) gltf.scene.scale.setScalar(0.5);
      models[name] = gltf.scene;
      resolve();
    }, undefined, reject);
  })));

  buildTrack(scene, models, null, null);
  const spawn = computeSpawnPosition(null);
  buildWallColliders(world, null, null, null);
  rigidBody.create(world, { shape: box.create({ halfExtents: [45, 0.5, 45] }), motionType: MotionType.STATIC, objectLayer: world._OL_STATIC, position: [0, -0.5, 0] });

  vehicle = new Vehicle();
  vehicle.physicsWorld = world;
  vehicle.rigidBody = createSphereBody(world, spawn);
  vehicle.setSpawn(spawn, 0);
  scene.add(vehicle.init(models['vehicle-truck-yellow']));

  cameraRig = new Camera();
  cameraRig.mode = 'chase';

  steps = parseInputLines(inputsEl.value);
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  if (currentStep < steps.length && lapCount <= 2) {
    stepSimulation(steps[currentStep]);
    currentStep += 1;
  }
  renderer.render(scene, cameraRig.camera);
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

document.getElementById('export-btn')?.addEventListener('click', async () => {
  const code = encodeCode({ steps: parseInputLines(inputsEl.value) });
  await navigator.clipboard.writeText(code);
  statusEl.textContent = 'Ghost code copied to clipboard.';
});

document.getElementById('import-btn')?.addEventListener('click', () => {
  try {
    const data = decodeCode(document.getElementById('import-code').value.trim());
    steps = Array.isArray(data?.steps) ? data.steps : [];
    inputsEl.value = serializeSteps(steps);
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
    const candidate = { x: [ -1, 0, 1 ][Math.floor(rng() * 3)], z: [ -1, 0, 1 ][Math.floor(rng() * 3)] };
    working[idx] = candidate;
    const next = evaluate(working);
    if (next < best) best = next;
    else working[idx] = old;
  }
  steps = working;
  inputsEl.value = serializeSteps(working);
  resetRun();
  statusEl.textContent = `Brute force done. Best time: ${best.toFixed(3)}s`;
});

window.addEventListener('resize', () => {
  const width = window.innerWidth - 320;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  if (cameraRig?.camera) {
    cameraRig.camera.aspect = width / height;
    cameraRig.camera.updateProjectionMatrix();
  }
});

initScene().catch((error) => {
  statusEl.textContent = error.message;
  console.error(error);
});
