// ─────────────────────────────────────────────────────────────────────────────
// CupTrackGen — shared deterministic track generator for weekly-cup.html and
// totd.html. Pure module: no imports, no DOM; pages encode the plan with
// encodeCellsV3 (js/Track.js) and build their own play URLs.
//
// Design (v2, built on the block/port grammar):
//   • Ground lap = closed loop of straight/corner cells (fixed walk — the old
//     genClosedLoop could re-enter its own start cell mid-path, which put two
//     blocks on one tile and made tracks undrivable).
//   • Elevated detours: a plain run of the loop is replaced by slope-up →
//     elevated road → slope back down. The elevated road is NOT forced to copy
//     the removed run — a best-first search finds a replacement path that may
//     cut across the map and CROSS OVER the ground loop using elevated-cross
//     (straight over straight) and elevated-cross-corner (corner over corner)
//     blocks. Crossings are only emitted where the ports JSON allows: the
//     elevated path must be perpendicular to the ground road at a straight
//     crossing, and rotated-pair-matched at a cross-corner.
//   • No 3-way/4-way cells: ramps attach in-line (a slope's ground and elevated
//     ports are always opposite), so hub cells are never needed.
//   • Bumps and surfaces (ice on corners) always land on ground cells, never
//     under elevated entries.
// ─────────────────────────────────────────────────────────────────────────────

export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rndInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function key(x, z) {
  return x + ',' + z;
}

export function sampleDeterministic(arr, rng, count) {
  if (!arr.length || count <= 0) return [];
  const n = Math.min(count, arr.length);
  const idx = arr.map((_, i) => i);
  const out = [];
  for (let k = 0; k < n; k++) {
    const pick = Math.floor(rng() * (idx.length - k)) + k;
    const tmp = idx[pick];
    idx[pick] = idx[k];
    idx[k] = tmp;
    out.push(arr[tmp]);
  }
  return out;
}

// ─── Port grammar ────────────────────────────────────────────────────────────
// Side vectors and 90°-per-orient rotation (S→E at orient 16), matching the
// block/port definition (ORIENT_DEG {0:0, 10:180, 16:90, 22:270}).
export const SIDE_VEC = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
export const OPP_SIDE = { N: 'S', S: 'N', E: 'W', W: 'E' };
const ORIENT_Q = { 0: 0, 16: 1, 10: 2, 22: 3 };
const ROT_CYCLE = ['N', 'W', 'S', 'E'];

export function rotSide(side, orient) {
  const i = ROT_CYCLE.indexOf(side);
  return i < 0 ? side : ROT_CYCLE[(i + (ORIENT_Q[orient] ?? 0)) % 4];
}

export function dirFromTo(from, to) {
  for (const side of ['N', 'E', 'S', 'W']) {
    const [dx, dz] = SIDE_VEC[side];
    if (from[0] + dx === to[0] && from[1] + dz === to[1]) return side;
  }
  return null;
}

export function orientFor(dirs, baseDirs) {
  for (const o of [0, 16, 10, 22]) {
    const rot = baseDirs.map((s) => rotSide(s, o));
    if (rot.length === dirs.length && rot.every((s) => dirs.includes(s))) return o;
  }
  return 0;
}

// Default-orientation port tables per block (mirrors the block/port definition).
export const BLOCK_PORTS = {
  'track-straight': { ground: ['N', 'S'] },
  'track-corner': { ground: ['S', 'W'] },
  'track-checkpoint': { ground: ['N', 'S'] },
  'track-finish': { ground: ['N', 'S'] },
  'elevated-straight': { elevated: ['N', 'S'] },
  'elevated-corner': { elevated: ['S', 'W'] },
  'elevated-cross': { elevated: ['N', 'S'], ground: ['E', 'W'] },
  'elevated-cross-corner': { elevated: ['S', 'W'], ground: ['N', 'E'] },
  'slope-up': { elevated: ['N'], ground: ['S'] },
};

function groundDirsOf(tile) {
  const type = tile[2];
  const o = tile[3];
  if (type === 'track-straight' || type === 'track-checkpoint' || type === 'track-finish') {
    return [rotSide('N', o), rotSide('S', o)];
  }
  if (type === 'track-corner') return [rotSide('S', o), rotSide('W', o)];
  return null;
}

// ─── Loop walk (fixed) ───────────────────────────────────────────────────────
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function genClosedLoop(rng, opts = {}) {
  const W = opts.W || 14;
  const H = opts.H || 14;
  const minLen = opts.minLen || 20;
  const maxLen = opts.maxLen || 40;
  const attempts = opts.attempts || 200;
  for (let att = 0; att < attempts; att++) {
    const sx = rndInt(rng, 2, W - 3);
    const sz = rndInt(rng, 2, H - 3);
    const seen = new Set([key(sx, sz)]);
    const path = [[sx, sz]];
    let prevDir = -1;
    while (path.length <= maxLen) {
      const [cx, cz] = path[path.length - 1];
      if (path.length >= minLen && Math.abs(cx - sx) + Math.abs(cz - sz) === 1) {
        path.push([sx, sz]);
        if (path.length - 1 >= minLen) return path;
        path.pop();
      }
      // Never step back onto the start cell mid-walk: closing the loop is
      // handled by the dedicated push above. The old walk let itself re-enter
      // the start (isStart bypassed the visited check), so a loop could
      // contain one cell twice — two blocks on one tile, broken lap.
      const candidates = [];
      for (let di = 0; di < 4; di++) {
        const [dx, dz] = DIRS[di];
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 1 || nz < 1 || nx >= W - 1 || nz >= H - 1) continue;
        if (seen.has(key(nx, nz))) continue;
        if (prevDir !== -1 && (di + 2) % 4 === prevDir) continue;
        let neighbors = 0;
        for (const [adx, adz] of DIRS) {
          if (seen.has(key(nx + adx, nz + adz))) neighbors++;
        }
        if (neighbors > 2) continue;
        let score = 1;
        if (prevDir === di) score += 1.4;
        candidates.push({ di, nx, nz, score });
      }
      if (!candidates.length) break;
      let total = 0;
      for (const c of candidates) total += c.score;
      let r = rng() * total;
      let pick = candidates[0];
      for (const c of candidates) {
        r -= c.score;
        if (r <= 0) { pick = c; break; }
      }
      path.push([pick.nx, pick.nz]);
      seen.add(key(pick.nx, pick.nz));
      prevDir = pick.di;
    }
  }
  return null;
}

export function loopToTiles(loop) {
  const unique = loop.slice(0, -1);
  const tiles = [];
  for (let i = 0; i < unique.length; i++) {
    const cur = unique[i];
    const prev = unique[(i + unique.length - 1) % unique.length];
    const next = unique[(i + 1) % unique.length];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    let type = 'track-straight';
    let orient = 0;
    if (Math.abs(dx) === 2 && dz === 0) { type = 'track-straight'; orient = 22; }
    else if (Math.abs(dz) === 2 && dx === 0) { type = 'track-straight'; orient = 0; }
    else {
      type = 'track-corner';
      const ox = (next[0] - cur[0]);
      const oz = (next[1] - cur[1]);
      const px = (cur[0] - prev[0]);
      const pz = (cur[1] - prev[1]);
      // corner with road entering from prev side and exiting toward next
      const inSide = px === 1 ? 'W' : px === -1 ? 'E' : pz === 1 ? 'N' : 'S';
      const outSide = ox === 1 ? 'E' : ox === -1 ? 'W' : oz === 1 ? 'S' : 'N';
      orient = orientFor([inSide, outSide], ['S', 'W']);
    }
    tiles.push([cur[0], cur[1], type, orient]);
  }
  let finishIdx = tiles.findIndex((t) => t[2] === 'track-straight');
  if (finishIdx < 0) finishIdx = 0;
  tiles[finishIdx][2] = 'track-finish';
  const cpCandidates = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i][2] === 'track-straight') {
      const dist = Math.min(Math.abs(i - finishIdx), tiles.length - Math.abs(i - finishIdx));
      if (dist >= 4) cpCandidates.push(i);
    }
  }
  return { tiles, cpCandidates };
}

// ─── Elevated path search ────────────────────────────────────────────────────
// The elevated road may cross OVER ground cells — but only where the port
// grammar allows:
//   straight over straight  → elevated-cross (perpendicular roads)
//   corner over corner       → elevated-cross-corner (rotated ground pair {N,E})
// Slope cells and cells with existing elevated entries are impassable; window
// interior cells count as empty (they are being removed from the ground).

function entryAt(cell, inD, outD, ctx) {
  const k = key(cell[0], cell[1]);
  if (ctx.elevKeys.has(k)) return null;
  if (ctx.slopeKeys.has(k)) return null;
  const g = ctx.groundMap.get(k);
  if (g && !ctx.windowKeys.has(k)) {
    const dirs = groundDirsOf(g.tile);
    if (!dirs) return null; // specials never crossed
    const portPair = [OPP_SIDE[inD], outD];
    if (inD === outD) {
      // elevated-cross: elevated road along one axis, ground road the other
      for (const o of [0, 16]) {
        const elev = [rotSide('N', o), rotSide('S', o)];
        const ground = [rotSide('E', o), rotSide('W', o)];
        if (portPair.every((s) => elev.includes(s)) && dirs.every((s) => ground.includes(s)) && dirs.length === 2) {
          return { type: 'elevated-cross', orient: o };
        }
      }
      return null;
    }
    for (const o of [0, 16, 10, 22]) {
      const elev = [rotSide('S', o), rotSide('W', o)];
      const ground = [rotSide('N', o), rotSide('E', o)];
      if (portPair.every((s) => elev.includes(s)) && ground.length === dirs.length && dirs.every((s) => ground.includes(s))) {
        return { type: 'elevated-cross-corner', orient: o };
      }
    }
    return null;
  }
  // empty cell: plain elevated road
  if (inD === outD) {
    return { type: 'elevated-straight', orient: (inD === 'N' || inD === 'S') ? 0 : 16 };
  }
  return { type: 'elevated-corner', orient: orientFor([OPP_SIDE[inD], outD], ['S', 'W']) };
}

function findElevatedPath(startCell, startInD, endCell, endOutD, ctx, maxLen) {
  const startKey = key(startCell[0], startCell[1]);
  const endKey = key(endCell[0], endCell[1]);
  if (startKey === endKey) return null;
  // Simple-path guarantee: the elevated road cannot stack two entries on one
  // cell, so a candidate path must never revisit a cell it already used.
  const chainHas = (node, k) => {
    let cur = node;
    while (cur) {
      if (key(cur.cell[0], cur.cell[1]) === k) return true;
      cur = cur.parent;
    }
    return false;
  };
  const best = new Map();
  const pq = [];
  const push = (cell, inD, cost, crossings, depth, parent) => pq.push({ cell, inD, cost, crossings, depth, parent });
  push(startCell, startInD, 0, 0, 0, null);
  let guard = 30000;
  while (pq.length && guard-- > 0) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].cost < pq[bi].cost || (pq[i].cost === pq[bi].cost && pq[i].crossings > pq[bi].crossings)) bi = i;
    }
    const node = pq.splice(bi, 1)[0];
    const stateKey = key(node.cell[0], node.cell[1]) + '|' + node.inD;
    const seenCost = best.get(stateKey);
    if (seenCost !== undefined && seenCost < node.cost) continue;
    best.set(stateKey, node.cost);
    if (node.depth >= maxLen) continue;
    for (const outD of ['N', 'E', 'S', 'W']) {
      if (outD === OPP_SIDE[node.inD]) continue;
      if (!entryAt(node.cell, node.inD, outD, ctx)) continue;
      const [dx, dz] = SIDE_VEC[outD];
      const nx = node.cell[0] + dx;
      const nz = node.cell[1] + dz;
      if (nx < ctx.minX || nx > ctx.maxX || nz < ctx.minZ || nz > ctx.maxZ) continue;
      const nbKey = key(nx, nz);
      if (nbKey === endKey) {
        if (chainHas(node, nbKey)) continue;
        if (!entryAt([nx, nz], outD, endOutD, ctx)) continue;
        // Reconstruct: entries are recomputed from the path geometry — each
        // was already validated during the search with the same arguments.
        const cellsR = [[nx, nz]];
        let cur = node;
        while (cur) { cellsR.unshift([cur.cell[0], cur.cell[1]]); cur = cur.parent; }
        const entries = [];
        for (let ci = 0; ci < cellsR.length; ci++) {
          const inD = ci === 0 ? startInD : dirFromTo(cellsR[ci - 1], cellsR[ci]);
          const outD2 = ci === cellsR.length - 1 ? endOutD : dirFromTo(cellsR[ci], cellsR[ci + 1]);
          const e = entryAt(cellsR[ci], inD, outD2, ctx);
          if (!e) return null; // cannot happen: every entry was validated
          entries.push([cellsR[ci][0], cellsR[ci][1], e.type, e.orient]);
        }
        return entries;
      }
      if (chainHas(node, nbKey)) continue;
      const isCross = ctx.groundMap.has(nbKey) && !ctx.windowKeys.has(nbKey);
      const stepCost = 1 + (outD !== node.inD ? 0.3 : 0) + (isCross ? -1.2 : 0);
      const nCost = node.cost + stepCost;
      const nState = nbKey + '|' + outD;
      if (best.has(nState) && best.get(nState) <= nCost) continue;
      push([nx, nz], outD, nCost, node.crossings + (isCross ? 1 : 0), node.depth + 1, node);
    }
  }
  return null;
}

// ─── Detours (elevated runs, possibly crossing the loop) ────────────────────

function genDetours(rng, tiles, specialIdx, removedIdx, elevEntries) {
  const n = tiles.length;
  const isPlain = (i) => !specialIdx.has(i) && (tiles[i][2] === 'track-straight' || tiles[i][2] === 'track-corner');
  if (!tiles.some((_, i) => isPlain(i))) return;
  const runs = [];
  let anchor = 0;
  while (anchor < n && isPlain(anchor)) anchor++;
  if (anchor >= n) {
    runs.push({ start: 0, len: n });
  } else {
    for (let k = 0; k < n; k++) {
      const idx = (anchor + k) % n;
      if (!isPlain(idx) || isPlain((idx + n - 1) % n)) continue;
      let len = 1;
      while (len < n && isPlain((idx + len) % n)) len++;
      if (len < n) runs.push({ start: idx, len });
    }
  }
  // windows must start and end on straight tiles (a slope's ports are opposite,
  // so the road must run straight through the ramp cell) and must not contain
  // cells that already carry elevated entries (crossings from earlier detours).
  const elevKeys = new Set(elevEntries.map(([gx, gz]) => key(gx, gz)));
  const windows = [];
  for (const run of runs) {
    if (run.len < 6) continue;
    const straights = [];
    let blocked = false;
    for (let k = 0; k < run.len; k++) {
      const t = tiles[(run.start + k) % n];
      if (elevKeys.has(key(t[0], t[1]))) { blocked = true; break; }
      if (t[2] === 'track-straight') straights.push(k);
    }
    if (blocked || straights.length < 2) continue;
    for (const i of straights) {
      for (const j of straights) {
        const len = j - i + 1;
        if (len < 6 || len > 18) continue;
        windows.push({ run, i, j, len });
      }
    }
  }
  if (!windows.length) return;
  windows.sort((a, b) => b.len - a.len || a.run.start - b.run.start || a.i - b.i);
  const count = rndInt(rng, 1, 2);
  const cap = Math.max(12, Math.floor(tiles.length * 0.5));
  let used = 0;
  let placed = 0;
  for (const w of windows) {
    if (placed >= count) break;
    if (used + w.len > cap) continue;
    const { run, i, j } = w;
    const L = j - i + 1;
    const idxOf = (k) => (run.start + k + n) % n;
    let overlap = false;
    for (let k = i; k <= j; k++) {
      if (removedIdx.has(idxOf(k))) { overlap = true; break; }
    }
    if (overlap) continue;
    const cells = [];
    for (let k = i; k <= j; k++) cells.push(tiles[idxOf(k)]);
    const a = tiles[idxOf(i - 1)];
    const b = tiles[idxOf(j + 1)];
    const gin = dirFromTo(cells[0], a);
    const gout = dirFromTo(cells[L - 1], b);
    if (!gin || !gout) continue;
    const startInD = OPP_SIDE[gin];
    const endOutD = gout;
    const [sdx, sdz] = SIDE_VEC[startInD];
    const firstCell = [cells[0][0] + sdx, cells[0][1] + sdz];
    const [edx, edz] = SIDE_VEC[OPP_SIDE[gout]];
    const lastCell = [cells[L - 1][0] + edx, cells[L - 1][1] + edz];
    // search context
    const xs = tiles.map((t) => t[0]);
    const zs = tiles.map((t) => t[1]);
    const ctx = {
      groundMap: new Map(),
      elevKeys: new Set(elevEntries.map(([gx, gz]) => key(gx, gz))),
      slopeKeys: new Set([key(cells[0][0], cells[0][1]), key(cells[L - 1][0], cells[L - 1][1])]),
      windowKeys: new Set(),
      minX: Math.min(...xs) - 2,
      maxX: Math.max(...xs) + 2,
      minZ: Math.min(...zs) - 2,
      maxZ: Math.max(...zs) + 2,
    };
    for (let ti = 0; ti < tiles.length; ti++) {
      if (removedIdx.has(ti) || specialIdx.has(ti)) continue;
      ctx.groundMap.set(key(tiles[ti][0], tiles[ti][1]), { tile: tiles[ti] });
    }
    for (let k = i; k <= j; k++) ctx.windowKeys.add(key(tiles[idxOf(k)][0], tiles[idxOf(k)][1]));
    let path = findElevatedPath(firstCell, startInD, lastCell, endOutD, ctx, Math.min(26, L + 8));
    if (!path) {
      // fallback: copy the removed run 1:1 (always port-valid)
      path = [];
      for (let k = 1; k < L - 1; k++) {
        const c = cells[k];
        const d1 = dirFromTo(c, cells[k - 1]);
        const d2 = dirFromTo(c, cells[k + 1]);
        if (!d1 || !d2) { path = null; break; }
        if (d1 === OPP_SIDE[d2]) path.push([c[0], c[1], 'elevated-straight', orientFor([d1, d2], ['N', 'S'])]);
        else path.push([c[0], c[1], 'elevated-corner', orientFor([d1, d2], ['S', 'W'])]);
      }
      if (path === null) continue;
    }
    elevEntries.push([cells[0][0], cells[0][1], 'slope-up', orientFor([gin], ['S'])]);
    elevEntries.push([cells[L - 1][0], cells[L - 1][1], 'slope-up', orientFor([gout], ['S'])]);
    for (const e of path) elevEntries.push(e);
    for (let k = i; k <= j; k++) removedIdx.add(idxOf(k));
    used += L;
    placed++;
  }
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export function generateTrackPlan(seedText, opts = {}) {
  const seed = hash32(seedText);
  const rng = mulberry32(seed);
  let loop = genClosedLoop(rng, {
    W: opts.W || rndInt(rng, 13, 19),
    H: opts.H || rndInt(rng, 13, 19),
    minLen: opts.minLen || rndInt(rng, 20, 30),
    maxLen: opts.maxLen || rndInt(rng, 34, 56),
    attempts: opts.attempts || 260,
  });
  if (!loop) {
    loop = [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [8, 3], [8, 4], [8, 5], [8, 6], [8, 7], [7, 7], [6, 7], [5, 7], [4, 7], [3, 7], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [2, 2]];
  }
  const { tiles, cpCandidates } = loopToTiles(loop);
  const cpCount = Math.min(cpCandidates.length, rndInt(rng, 1, 3));
  const cpIdxSet = new Set(sampleDeterministic(cpCandidates, rng, cpCount));
  for (const idx of cpIdxSet) tiles[idx][2] = 'track-checkpoint';
  const specialIdx = new Set([...cpIdxSet]);
  const finishIdx = tiles.findIndex((t) => t[2] === 'track-finish');
  if (finishIdx >= 0) specialIdx.add(finishIdx);
  const elevEntries = [];
  const removedIdx = new Set();
  genDetours(rng, tiles, specialIdx, removedIdx, elevEntries);
  const order = tiles.map((_, i) => i).filter((i) => !removedIdx.has(i));
  const groundTiles = order.map((i) => tiles[i]);
  const elevKeys = new Set(elevEntries.map(([gx, gz]) => key(gx, gz)));
  const bumpCandidates = groundTiles.filter(([gx, gz, t]) => t === 'track-straight' && !elevKeys.has(key(gx, gz)));
  const bumps = sampleDeterministic(bumpCandidates, rng, Math.min(5, Math.max(1, Math.floor(tiles.length / 11))));
  const surfCandidates = groundTiles.filter(([gx, gz, t]) => (t === 'track-straight' || t === 'track-corner') && !elevKeys.has(key(gx, gz)));
  const surfacePalette = ['surface-wood', 'surface-ice', 'surface-boost'];
  const surfaceCells = sampleDeterministic(surfCandidates, rng, Math.min(7, Math.max(2, Math.floor(tiles.length / 7))))
    .map(([x, z, t], idx) => [x, z, t === 'track-corner' ? 'surface-ice' : surfacePalette[idx % surfacePalette.length]]);
  return {
    cells: groundTiles,
    modsObj: { b: bumps, s: [], u: surfaceCells, d: [], e: elevEntries },
    rng,
  };
}
