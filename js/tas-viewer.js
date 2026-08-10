import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, TRACK_CELLS, ORIENT_DEG, CELL_RAW, GRID_SCALE } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { DeterministicPlaybackController, parseInputLines, serializeSteps, keysToAxes } from './tas-core.js';
import { FIXED_DT, SeededRandom, resetGameRng, DEFAULT_RNG_SEED } from './Determinism.js';

// ─────────────────────────────────────────────────────────────────────────────
// TAS Editor — deterministic record / playback / brute-force tool.
//
// State machine:
//   IDLE       — no track loaded yet (or loaded, waiting to record)
//   RECORDING  — user drives; per-substep inputs are captured until 2 laps done
//   REVIEW     — 2 laps recorded; ask "keep?"; Yes → fill inputs box; No → restart
//   PLAYBACK   — running the (possibly edited) inputs deterministically
//   BRUTEFORCE — headless optimization of the inputs (3 mutated frames / attempt)
//
// Determinism contract (see AGENTS.md): every sim step runs at FIXED_DT (1/120s),
// the shared gameRng is reset at the start of each run, and all gameplay timers
// use raceClockSeconds. Recording captures one input step per substep so a
// recorded run replays bit-for-bit.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_STEPS = 120 * 120;            // hard cap on a single headless evaluation
const TARGET_LAPS = 2;                  // a recording / TAS run is "complete" at 2 laps
const ENGINE_MULTS = [ 1, 1.025, 1.05, 1.075, 1.1 ];
const MODELS = [
  'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
  'track-straight', 'track-corner', 'track-bump', 'track-finish',
  'decoration-empty', 'decoration-forest', 'decoration-tents',
];
const REQUIRED_VEHICLE_KEYS = [ 'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red' ];
const CAR_STATS = {
  'vehicle-truck-yellow': { topSpeed: 1.0, accelRate: 6.0, driveForce: 100.0 },
  'vehicle-truck-green': { topSpeed: 0.92, accelRate: 7.8, driveForce: 108.0 },
  'vehicle-truck-purple': { topSpeed: 1.12, accelRate: 4.8, driveForce: 95.0 },
  'vehicle-truck-red': { topSpeed: 1.05, accelRate: 5.5, driveForce: 102.0 },
};
// Key combos sampled during brute-force mutation ("medium sized" changes).
const BF_DIRECTIONS = [
  { up: true, down: false, left: false, right: false },
  { up: true, down: false, left: true, right: false },
  { up: true, down: false, left: false, right: true },
  { up: false, down: false, left: true, right: false },
  { up: false, down: false, left: false, right: true },
  { up: false, down: true, left: false, right: false },
  { up: true, down: false, left: true, right: true },
  { up: false, down: false, left: false, right: false },
];

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

// DOM handles
const lapHud = document.getElementById('lap');
const statusEl = document.getElementById('status');
const runErrorsEl = document.getElementById('run-errors');
const inputsEl = document.getElementById('inputs');
const carSelect = document.getElementById('car-select');
const trackUrlInput = document.getElementById('track-url');
const engineTierInput = document.getElementById('engine-tier');
const stateBanner = document.getElementById('state-banner');
const reviewPrompt = document.getElementById('review-prompt');
const recordBtn = document.getElementById('record-btn');
const stopRecordBtn = document.getElementById('stop-record-btn');
const clearInputsBtn = document.getElementById('clear-inputs-btn');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const bfBtn = document.getElementById('bf-btn');
const bfRepsInput = document.getElementById('bf-reps');
const exportBtn = document.getElementById('export-btn');
const loadTrackBtn = document.getElementById('load-track-btn');

// Deterministic RNG for brute-force mutations only (never for the sim itself,
// which owns gameRng and resets it per run).
const bfRng = new SeededRandom(DEFAULT_RNG_SEED ^ 0x5a5a5a5a);

// ── Simulation state ──────────────────────────────────────────────────────────
let models = {};
let world;
let vehicle;
let cameraRig;
let trackGroup = null;
let currentCells = null;
let currentExtras = null;
let currentTrackUrl = '';
let steps = [];
const playbackController = new DeterministicPlaybackController();
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
let simAccumulator = 0;
let runtimeReady = false;
let physicsEnabled = true;
let runErrorLines = [];

// Editor state machine
let mode = 'IDLE';        // IDLE | RECORDING | REVIEW | PLAYBACK | BRUTEFORCE
let recordedSteps = [];   // raw per-substep inputs captured during RECORDING
let keyboardState = { up: false, down: false, left: false, right: false };

// ── Utilities ─────────────────────────────────────────────────────────────────
function encodeCode(data) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formatLapTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--.---';
  const mins = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const ms = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function setRunErrors(lines) {
  runErrorLines = Array.isArray(lines) ? lines.slice() : [];
  runErrorsEl.textContent = runErrorLines.join('\n');
}

function pushRunError(message) {
  runErrorLines.push(String(message || ''));
  runErrorsEl.textContent = runErrorLines.join('\n');
}

function setStatus(text) { if (statusEl) statusEl.textContent = text; }

function setBanner(main, sub) {
  if (!stateBanner) return;
  stateBanner.innerHTML = '';
  const m = document.createElement('div');
  m.textContent = main;
  stateBanner.appendChild(m);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'banner-sub';
    s.textContent = sub;
    stateBanner.appendChild(s);
  }
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
      customPads: parsed?.y && typeof parsed.y === 'object' ? parsed.y : {},
    };
  } catch {
    return 'parse-error';
  }
}

function normalizeTrackExtras(extras) {
  return {
    bumps: Array.isArray(extras?.bumps) ? extras.bumps : [],
    boosts: Array.isArray(extras?.boosts) ? extras.boosts : [],
    jumps: Array.isArray(extras?.jumps) ? extras.jumps : [],
    decorations: Array.isArray(extras?.decorations) ? extras.decorations : [],
    surfaces: Array.isArray(extras?.surfaces) ? extras.surfaces : [],
    customSurfaces: extras?.customSurfaces && typeof extras.customSurfaces === 'object' ? extras.customSurfaces : {},
    customPads: extras?.customPads && typeof extras.customPads === 'object' ? extras.customPads : {},
  };
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
  vehicle.gripMultiplier = 1;
  vehicle.accelMultiplier = 1;
  vehicle.driveMultiplier = 1;
}

// Reset the simulation to the start of a run: rewind lap timing, checkpoints,
// the vehicle, and the shared RNG so a replay is bit-identical to the recording.
function resetRun(clearErrors = true) {
  playbackController.resetFrame();
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
  // Reset the shared RNG at the start of every run so identical inputs produce
  // identical sim output (determinism contract).
  resetGameRng(DEFAULT_RNG_SEED);
  if (clearErrors) setRunErrors([]);
  updateLapHud();
}

function updateLapHud() {
  lapHud.textContent = `Lap ${lapNumber} • ${formatLapTime(lapSeconds)} • Last ${formatLapTime(lastLapSeconds)} • Best ${formatLapTime(bestLapSeconds)}`;
}

// One deterministic simulation substep. `input` is a normalized step
// ({ keys: { up, down, left, right } }). Advances physics, lap timing and
// checkpoints by exactly FIXED_DT.
function stepSimulation(input) {
  const axes = keysToAxes(input?.keys);
  raceClockSeconds += FIXED_DT;
  lapSeconds = Math.max(0, raceClockSeconds - lapStartSeconds);
  if (physicsEnabled && world) updateWorld(world, null, FIXED_DT);
  vehicle.update(FIXED_DT, axes);
  cameraRig.update(FIXED_DT, vehicle.spherePos, vehicle.container.quaternion);

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

  updateLapHud();
}

// Headless evaluation: replay `inputSteps` from a fresh reset and return the
// total time to complete TARGET_LAPS laps (999999 if it never finishes within
// MAX_STEPS). Used by brute-force to compare runs. Does not render or move the
// camera beyond what stepSimulation needs.
function evaluate(inputSteps) {
  const prevMode = mode;
  mode = 'BRUTEFORCE';
  resetRun(false);
  let completedTime = 999999;
  for (let i = 0; i < Math.min(MAX_STEPS, inputSteps.length); i++) {
    stepSimulation(inputSteps[i]);
    if (lapHistory.length >= TARGET_LAPS) {
      completedTime = raceClockSeconds;
      break;
    }
  }
  mode = prevMode;
  return completedTime;
}


// ── Track build ───────────────────────────────────────────────────────────────
// (Re)builds the track + physics + vehicle from the current track URL. Called
// on Load Track and on first init.
function rebuildTrack() {
  if (trackGroup) {
    scene.remove(trackGroup);
    trackGroup = null;
  }
  try {
    world = buildWorld();
    physicsEnabled = true;
  } catch (error) {
    physicsEnabled = false;
    world = null;
    console.warn('TAS physics init failed; running without physics colliders.', error);
  }
  currentTrackUrl = trackUrlInput.value.trim();
  const nextCells = parseTrackCellsFromUrl(currentTrackUrl);
  const parsedExtras = parseExtrasFromUrl(currentTrackUrl);
  const extrasParseFailed = parsedExtras === 'parse-error';
  const nextExtras = normalizeTrackExtras(extrasParseFailed ? null : parsedExtras);
  currentCells = nextCells;
  currentExtras = nextExtras;
  trackGroup = buildTrack(scene, models, nextCells, nextExtras);
  if (physicsEnabled && world) buildWallColliders(world, null, nextCells, nextExtras);
  if (extrasParseFailed) pushRunError('Extras parse failed; TAS used default collider data.');

  const spawn = computeSpawnPosition(currentCells);
  const hasValidSpawnPosition = Array.isArray(spawn?.position) && spawn.position.length === 3
    && spawn.position.every((v) => Number.isFinite(v));
  const spawnData = hasValidSpawnPosition
    ? { position: spawn.position, angle: Number.isFinite(spawn?.angle) ? spawn.angle : 0 }
    : null;
  const bounds = computeTrackBounds(currentCells);
  const groundSize = Math.max(bounds.halfWidth, bounds.halfDepth) * 2 + 20;
  if (physicsEnabled && world) {
    rigidBody.create(world, {
      shape: box.create({ halfExtents: [groundSize / 2, 0.5, groundSize / 2] }),
      motionType: MotionType.STATIC,
      objectLayer: world._OL_STATIC,
      position: [bounds.centerX, -0.5, bounds.centerZ],
    });
  }

  if (vehicle?.container) scene.remove(vehicle.container);
  vehicle = new Vehicle();
  if (physicsEnabled && world) {
    vehicle.physicsWorld = world;
    vehicle.rigidBody = createSphereBody(world, spawnData?.position || null);
  }
  vehicle.setSpawn(spawnData?.position || [3.5, 0.5, 5], spawnData?.angle || 0);
  const [sx, sy, sz] = spawnData?.position || [3.5, 0.5, 5];
  vehicle.spherePos.set(sx, sy, sz);
  vehicle.container.position.set(sx, sy - 0.5, sz);
  vehicle.container.rotation.y = spawnData?.angle || 0;
  vehicle.prevModelPos.copy(vehicle.container.position);
  scene.add(vehicle.init(models[carSelect.value] || models['vehicle-truck-yellow']));
  updateCarConfig();

  const activeCells = currentCells || TRACK_CELLS;
  const finishCell = activeCells.find((c) => c[2] === 'track-finish')
    || activeCells.find((c) => c[2] === 'track-start-finish')
    || activeCells[0];
  const elevatedCheckpointCells = Array.isArray(currentExtras?.elevated)
    ? currentExtras.elevated
      .filter((c) => Array.isArray(c) && c[2] === 'elevated-checkpoint')
      .map(([gx, gz, , orient = 0]) => [gx, gz, 'track-checkpoint', orient])
    : [];
  const checkpointCells = [...activeCells.filter((c) => c[2] === 'track-checkpoint'), ...elevatedCheckpointCells];
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

// ── Editor state-machine helpers ──────────────────────────────────────────────
function setMode(nextMode) {
  mode = nextMode;
  updateModeUi();
}

function updateModeUi() {
  const trackLoaded = Boolean(vehicle);
  const hasInputs = inputsEl.value.trim().length > 0;
  recordBtn.disabled = !trackLoaded || mode === 'RECORDING' || mode === 'PLAYBACK' || mode === 'BRUTEFORCE';
  stopRecordBtn.disabled = mode !== 'RECORDING';
  runBtn.disabled = !trackLoaded || !hasInputs || mode === 'RECORDING' || mode === 'BRUTEFORCE';
  stopBtn.disabled = mode !== 'PLAYBACK';
  bfBtn.disabled = !trackLoaded || !hasInputs || mode === 'RECORDING' || mode === 'PLAYBACK';
  reviewPrompt.style.display = mode === 'REVIEW' ? 'flex' : 'none';
}

// Snapshot the live keyboard state into a normalized step.
function currentKeyboardStep() {
  return { keys: { ...keyboardState } };
}

// Begin a fresh recording: clear recorded inputs, reset the run, and capture
// inputs each substep until 2 laps are complete (or the user stops).
function startRecording() {
  if (!vehicle) return;
  recordedSteps = [];
  playbackController.loadSteps([]);
  playbackController.stop();
  resetRun();
  lastFrameNow = performance.now() / 1000;
  simAccumulator = 0;
  setMode('RECORDING');
  setBanner('Recording — drive 2 laps', 'Your inputs are captured at 120 Hz. Press Stop if you give up.');
  setStatus('Recording… drive 2 laps.');
}

function stopRecording() {
  // If the user stops before 2 laps, still offer what was captured (or restart).
  if (recordedSteps.length === 0) {
    setMode('IDLE');
    setBanner('Track loaded', 'Press "Record a run" to capture inputs.');
    setStatus('Recording stopped — no inputs captured.');
    return;
  }
  enterReview();
}

// Recording reached 2 laps (or was stopped with inputs): ask the user whether
// to keep the run.
function enterReview() {
  setMode('REVIEW');
  const total = lapHistory.reduce((a, b) => a + b, 0);
  setBanner(
    'Run captured',
    `${recordedSteps.length} frames • ${lapHistory.length} lap(s) • total ${formatLapTime(total)}`,
  );
  setStatus('Keep this run? Yes loads it into the inputs box; No restarts recording.');
}

function acceptRecording() {
  steps = recordedSteps.slice();
  inputsEl.value = serializeSteps(steps);
  setMode('IDLE');
  setBanner('Inputs loaded', 'Edit them below, then "Run TAS" or "Brute force".');
  setStatus(`Loaded ${steps.length} recorded input frames into the editor.`);
}

function rejectRecording() {
  startRecording();
}

// Run the (possibly hand-edited) inputs deterministically in the viewport.
function startPlayback() {
  try {
    steps = parseInputLines(inputsEl.value);
  } catch (error) {
    pushRunError(`Run parse failed: ${error?.message || String(error)}`);
    setStatus('Could not parse inputs.');
    return;
  }
  if (steps.length === 0) {
    setStatus('No TAS steps parsed. Use "ArrowUp+ArrowLeft,30" or record a run.');
    return;
  }
  playbackController.loadSteps(steps);
  playbackController.start();
  resetRun();
  lastFrameNow = performance.now() / 1000;
  simAccumulator = 0;
  setMode('PLAYBACK');
  setBanner('Running TAS', `${steps.length} input frames • deterministic 120 Hz playback`);
  setStatus(`Running ${steps.length} deterministic input frames.`);
}

function stopPlayback() {
  playbackController.stop();
  setMode('IDLE');
  setBanner('Playback stopped', 'Edit inputs and run again, or brute-force.');
  setStatus('Playback stopped.');
}

// Brute-force optimization: each attempt mutates 3 random frames to a randomly
// chosen direction (a "medium sized" change). Keeps a mutation only if the
// 2-lap run becomes faster; otherwise reverts. Runs headlessly (evaluate()).
function runBruteForce() {
  let working = parseInputLines(inputsEl.value);
  if (working.length === 0) {
    setStatus('No inputs to optimize — record or write some first.');
    return;
  }
  const reps = Math.max(1, Math.floor(Number(bfRepsInput.value || 1)));
  setMode('BRUTEFORCE');
  setBanner('Brute forcing', `${reps} attempt(s) • 3 mutated frames each • keep if faster`);
  setStatus('Brute forcing…');

  let best = evaluate(working);
  let kept = 0;
  for (let i = 0; i < reps; i++) {
    // Pick 3 distinct frame indices to mutate.
    const indices = new Set();
    let guard = 0;
    while (indices.size < 3 && guard < 20) {
      indices.add(Math.floor(bfRng.next() * working.length));
      guard++;
    }
    const snapshot = [];
    for (const idx of indices) {
      snapshot.push({ idx, step: working[idx] });
      working[idx] = { keys: { ...BF_DIRECTIONS[Math.floor(bfRng.next() * BF_DIRECTIONS.length)] } };
    }
    const candidate = evaluate(working);
    if (candidate < best) {
      best = candidate;
      kept++;
    } else {
      for (const entry of snapshot) working[entry.idx] = entry.step;
    }
  }

  steps = working;
  inputsEl.value = serializeSteps(working);
  playbackController.loadSteps(working);
  playbackController.stop();
  resetRun();
  setMode('IDLE');
  setBanner('Brute force complete', `${kept}/${reps} improvements kept • best 2-lap ${formatLapTime(best)}`);
  setStatus(`Brute force done. ${kept}/${reps} kept. Best 2-lap time: ${best === 999999 ? 'DNF' : formatLapTime(best)}.`);
}

// ── Render / sim loop ─────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  if (!runtimeReady) {
    if (cameraRig?.camera) renderer.render(scene, cameraRig.camera);
    return;
  }
  const now = performance.now() / 1000;
  const dt = Math.min(0.25, Math.max(0, now - lastFrameNow));
  lastFrameNow = now;
  simAccumulator += dt;

  // Fixed-timestep accumulator: one sim substep per FIXED_DT, capped to avoid
  // the spiral of death. This keeps the sim deterministic regardless of the
  // display refresh rate (see AGENTS.md).
  let stepsThisFrame = 0;
  while (simAccumulator >= FIXED_DT && vehicle && stepsThisFrame < 8) {
    if (mode === 'RECORDING') {
      const step = currentKeyboardStep();
      recordedSteps.push(step);
      stepSimulation(step);
      if (lapHistory.length >= TARGET_LAPS) {
        simAccumulator = 0;
        enterReview();
        break;
      }
    } else if (mode === 'PLAYBACK') {
      const step = playbackController.nextStep();
      if (step) {
        stepSimulation(step);
      } else {
        // Reached the end of the inputs.
        playbackController.stop();
        setMode('IDLE');
        const total = lapHistory.reduce((a, b) => a + b, 0);
        setBanner(
          lapHistory.length >= TARGET_LAPS ? 'TAS run complete' : 'TAS run ended',
          `${lapHistory.length}/${TARGET_LAPS} laps • total ${formatLapTime(total)}`,
        );
        setStatus(`Playback finished. ${lapHistory.length}/${TARGET_LAPS} laps, total ${formatLapTime(total)}.`);
        break;
      }
    } else {
      // IDLE / REVIEW / BRUTEFORCE — don't advance the sim in the render loop.
      break;
    }
    simAccumulator -= FIXED_DT;
    stepsThisFrame++;
  }
  if (cameraRig?.camera) renderer.render(scene, cameraRig.camera);
}

async function initScene() {
  setStatus('Loading TAS editor…');
  registerAll();
  cameraRig = new Camera();
  cameraRig.mode = 'overview';

  const loader = new GLTFLoader();
  const loadOneModel = (name) => new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timeout = window.setTimeout(() => {
      console.warn(`Timed out loading model: ${name}`);
      done({ name, ok: false, reason: 'timeout' });
    }, 12000);
    loader.load(`models/${name}.glb`, (gltf) => {
      window.clearTimeout(timeout);
      if (name.startsWith('vehicle-')) gltf.scene.scale.setScalar(0.5);
      models[name] = gltf.scene;
      done({ name, ok: true });
    }, undefined, (error) => {
      window.clearTimeout(timeout);
      console.warn(`Failed loading model: ${name}`, error);
      done({ name, ok: false, reason: 'error' });
    });
  });
  const loadResults = await Promise.all(MODELS.map((name) => loadOneModel(name)));
  const loadedVehicles = REQUIRED_VEHICLE_KEYS.filter((key) => Boolean(models[key]));
  if (loadedVehicles.length === 0) {
    const failed = loadResults.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ');
    throw new Error(`Could not load any vehicle models. Failed: ${failed || 'unknown'}`);
  }
  const activeVehicle = models[carSelect.value] ? carSelect.value : loadedVehicles[0];
  if (carSelect.value !== activeVehicle) carSelect.value = activeVehicle;

  // Honor ?track=… / ?map=… query params so the editor can deep-link a track.
  const params = new URLSearchParams(window.location.search);
  const deepTrack = params.get('track') || params.get('mapUrl') || '';
  if (deepTrack) trackUrlInput.value = deepTrack;

  rebuildTrack();
  runtimeReady = true;
  const failedCount = loadResults.filter((entry) => !entry.ok).length;
  setMode('IDLE');
  setBanner('Track loaded', 'Press "Record a run" to drive 2 laps and capture your inputs.');
  setStatus(failedCount > 0
    ? `Loaded TAS editor with ${failedCount} missing model(s).`
    : 'TAS editor ready.');
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

// ── Keyboard capture (recording) ──────────────────────────────────────────────
// We listen directly so the editor is self-contained (no Controls.js touch UI).
const KEY_MAP = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};
window.addEventListener('keydown', (e) => {
  const k = KEY_MAP[e.code];
  if (k) { keyboardState[k] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  const k = KEY_MAP[e.code];
  if (k) { keyboardState[k] = false; e.preventDefault(); }
});
// If the window loses focus mid-recording, release all keys so the car doesn't
// drive itself forever.
window.addEventListener('blur', () => { keyboardState = { up: false, down: false, left: false, right: false }; });

// ── Wire up the side-panel controls ───────────────────────────────────────────
loadTrackBtn?.addEventListener('click', () => {
  if (!runtimeReady) { setStatus('Still loading models…'); return; }
  rebuildTrack();
  setMode('IDLE');
  setBanner('Track loaded', 'Press "Record a run" to drive 2 laps and capture your inputs.');
  setStatus('Loaded track data from URL (or default track).');
});

recordBtn?.addEventListener('click', startRecording);
stopRecordBtn?.addEventListener('click', stopRecording);
document.getElementById('review-yes')?.addEventListener('click', acceptRecording);
document.getElementById('review-no')?.addEventListener('click', rejectRecording);

clearInputsBtn?.addEventListener('click', () => {
  inputsEl.value = '';
  steps = [];
  playbackController.loadSteps([]);
  playbackController.stop();
  resetRun();
  updateModeUi();
  setStatus('Inputs cleared.');
});

runBtn?.addEventListener('click', startPlayback);
stopBtn?.addEventListener('click', stopPlayback);
bfBtn?.addEventListener('click', runBruteForce);

for (const el of [carSelect, engineTierInput]) {
  el?.addEventListener('input', () => {
    updateCarConfig();
    setStatus('Car config updated. Re-record or re-run for it to take effect.');
  });
}

inputsEl?.addEventListener('input', updateModeUi);

exportBtn?.addEventListener('click', async () => {
  const code = encodeCode({
    steps: parseInputLines(inputsEl.value),
    trackUrl: trackUrlInput.value.trim(),
    car: carSelect.value,
    engineTier: Number(engineTierInput.value || 0),
  });
  try {
    await navigator.clipboard.writeText(code);
    setStatus('Ghost code copied to clipboard.');
  } catch {
    setStatus('Could not copy; code is still valid.');
  }
});

window.addEventListener('resize', resize);
resize();
animate();

initScene().catch((error) => {
  setStatus(error.message);
  setBanner('Failed to load', error.message);
  console.error(error);
});

