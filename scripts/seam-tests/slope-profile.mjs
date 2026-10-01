import * as c from 'crashcat';
import { buildWallColliders, createSphereBody } from '../../js/Physics.js';
import { rebuildStaticSeams } from '../../js/StaticSeams.js?v=1';
import { CELL_RAW, GRID_SCALE } from '../../js/Track.js';
c.registerAll();
const C = CELL_RAW * GRID_SCALE, HALF = C / 2;
const groundY = -0.125, groundTop = groundY + 0.01, S = GRID_SCALE;
const deckTop = groundY + CELL_RAW * 0.5 * S - 0.06 + 0.12 * S;
const poolFloorTop = groundY - C * 0.34 + 0.04 * S;
const tunnelFloorTop = groundY - C * 0.5 + 0.04 * S;
const FLIP = { 0: 10, 10: 0, 16: 22, 22: 16 };
function world() {
  const ws = c.createWorldSettings(), bm = c.addBroadphaseLayer(ws), bs = c.addBroadphaseLayer(ws);
  const om = c.addObjectLayer(ws, bm), os = c.addObjectLayer(ws, bs);
  c.enableCollision(ws, om, os); c.enableCollision(ws, om, om);
  const w = c.createWorld(ws); w._OL_STATIC = os; w._OL_MOVING = om; return w;
}
function groundBox(w, gx, gz) {
  c.rigidBody.create(w, { shape: c.box.create({ halfExtents: [HALF, 0.5, HALF] }), position: [(gx + .5) * C, groundTop - 0.5, (gz + .5) * C], motionType: c.MotionType.STATIC, objectLayer: w._OL_STATIC, friction: 5, restitution: 0 });
}
function scan(w, base, dir, lateral, tEnd) {
  const perp = [-dir[1], dir[0]];
  const settings = c.createDefaultCastRaySettings(), filter = c.filter.forWorld(w);
  filter.bodyFilter = b => b.motionType === c.MotionType.STATIC;
  const out = [];
  for (let t = -1.2 * C; t <= tEnd; t += 0.01) {
    const px = base[0] + dir[0] * t + perp[0] * lateral, pz = base[1] + dir[1] * t + perp[1] * lateral;
    const collector = c.createClosestCastRayCollector();
    c.castRay(w, collector, settings, [px, 20, pz], [0, -1, 0], 40, filter);
    if (collector.hit.status !== c.CastRayStatus.COLLIDING) throw Error('HOLE in surface at t=' + t.toFixed(2) + ' lateral=' + lateral);
    out.push([t, 20 - collector.hit.fraction * 40]);
  }
  return out;
}
function check(name, samples, lowY, highY) {
  let worst = 0, worstAt = 0;
  for (const [t, y] of samples) {
    const ideal = t < -HALF ? lowY : t > HALF ? highY : lowY + (t + HALF) / C * (highY - lowY);
    const dev = Math.abs(y - ideal);
    if (dev > worst) { worst = dev; worstAt = t; }
  }
  if (worst > 1.5e-3) throw Error(name + ' misaligned ' + (worst * 1000).toFixed(2) + 'mm at t=' + worstAt.toFixed(2));
  return worst;
}
const results = [];
const base = [0.5 * C, 0.5 * C];
for (const orient of [0, 10, 16, 22]) {
  // Elevated ramp -> flat deck (uphill direction convention from passing drive tests)
  const yaw = ({ 0: 0, 10: 180, 16: 90, 22: 270 })[orient] * Math.PI / 180;
  const ux = -Math.round(Math.sin(yaw)), uz = -Math.round(Math.cos(yaw));
  {
    const w = world();
    buildWallColliders(w, null, [], { elevated: [[0, 0, 'slope-up', orient], [ux, uz, 'elevated-straight', orient], [ux * 2, uz * 2, 'elevated-straight', orient]] });
    groundBox(w, -ux, -uz); groundBox(w, -ux * 2, -uz * 2);
    createSphereBody(w, base);
    let worst = 0;
    for (const lat of [0, 1, -1, 2, -2]) worst = Math.max(worst, check('elevated-deck o' + orient + ' lat' + lat, scan(w, base, [ux, uz], lat, 1.7 * C), groundTop, deckTop));
    results.push({ case: 'elevated-deck', orient, worstMm: +(worst * 1000).toFixed(3) });
  }
  // Elevated peak: two facing ramps
  {
    const w = world();
    buildWallColliders(w, null, [], { elevated: [[0, 0, 'slope-up', orient], [ux, uz, 'slope-up', FLIP[orient]]] });
    groundBox(w, -ux, -uz); groundBox(w, ux * 2, uz * 2);
    createSphereBody(w, base);
    const samples = scan(w, base, [ux, uz], 0, 2.2 * C);
    let worst = 0;
    for (const [t, y] of samples) {
      const ideal = t < -HALF ? groundTop : t <= HALF ? groundTop + (t + HALF) / C * (deckTop - groundTop) : t <= 1.5 * C ? deckTop + (t - HALF) / C * (groundTop - deckTop) : groundTop;
      worst = Math.max(worst, Math.abs(y - ideal));
    }
    if (worst > 1.5e-3) throw Error('elevated-peak o' + orient + ' misaligned ' + (worst * 1000).toFixed(2) + 'mm');
    results.push({ case: 'elevated-peak', orient, worstMm: +(worst * 1000).toFixed(3) });
  }
  // Pool and tunnel ramps (pit direction convention from passing drive tests)
  const px = Math.round(Math.sin(yaw)), pz = Math.round(Math.cos(yaw));
  for (const kind of ['pool', 'tunnel']) {
    const w = world();
    const floorTop = kind === 'pool' ? poolFloorTop : tunnelFloorTop;
    if (kind === 'pool') buildWallColliders(w, null, [], { water: [[0, 0], [px, pz], [px * 2, pz * 2]], poolSlopes: [[0, 0, orient]] });
    else buildWallColliders(w, null, [], { tunnels: [[0, 0, 0, orient, 'slope-up'], [px, pz, 0, orient, null], [px * 2, pz * 2, 0, orient, null]] });
    groundBox(w, -px, -pz); groundBox(w, -px * 2, -pz * 2);
    createSphereBody(w, base);
    let worst = 0;
    for (const lat of [0, 1, -1, 2, -2]) worst = Math.max(worst, check(kind + ' o' + orient + ' lat' + lat, scan(w, base, [px, pz], lat, 1.7 * C), groundTop, floorTop));
    results.push({ case: kind + '-slope', orient, worstMm: +(worst * 1000).toFixed(3) });
  }
}
console.log(JSON.stringify(results, null, 1));
