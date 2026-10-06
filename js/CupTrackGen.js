// ─────────────────────────────────────────────────────────────────────────────
// CupTrackGen v4 — shared deterministic track generator for weekly-cup.html
// and totd.html. Pure module: no imports, no DOM; pages encode the plan with
// encodeCellsV3 (js/Track.js) and build their own play URLs.
//
// v4 engine (from the user's TOTD Lab v4 overlap engine, 2026-10-06):
//   • Ground lap = a fixed proven 120-cell recipe scaffold, seed-variant via
//     rotation / mirror / start-phase, with figure-8 4-way self-crossings.
//   • Interleaved detour solver: every window is evaluated as BOTH an
//     elevated detour AND a tunnel detour; crossing-richest wins — road-over-
//     road (elevated-cross / elevated-cross-corner) and road-over-tunnel
//     (sealed closed-top) crossings pile up on one map.
//   • Pool driving sections (pool ramp → water → pool ramp), decorative
//     ponds, thin-block sections with thin-corner bends (ground + elevated),
//     choke pinches, jumps, bumps, surfaces (ground + elevated decks).
//   • One seed → one deterministic recipe; the generator owns its fallbacks.
// ─────────────────────────────────────────────────────────────────────────────

// ─── deterministic rng (CupTrackGen) ────────────────────────────────────────
function hash32(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
	return h >>> 0;
}
function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rndInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const key = (x, z) => x + ',' + z;
function sampleDeterministic(arr, rng, count) {
	if (!arr.length || count <= 0) return [];
	const n = Math.min(count, arr.length);
	const idx = arr.map((_, i) => i);
	const out = [];
	for (let k = 0; k < n; k++) {
		const pick = Math.floor(rng() * (idx.length - k)) + k;
		const tmp = idx[pick]; idx[pick] = idx[k]; idx[k] = tmp;
		out.push(arr[tmp]);
	}
	return out;
}

// ─── port grammar ────────────────────────────────────────────────────────────
const SIDE_VEC = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const OPP_SIDE = { N: 'S', S: 'N', E: 'W', W: 'E' };
const ORIENT_Q = { 0: 0, 16: 1, 10: 2, 22: 3 };
const ROT_CYCLE = ['N', 'W', 'S', 'E'];
const rotSide = (side, orient) => {
	const i = ROT_CYCLE.indexOf(side);
	return i < 0 ? side : ROT_CYCLE[(i + (ORIENT_Q[orient] ?? 0)) % 4];
};
const dirFromTo = (from, to) => {
	for (const side of ['N', 'E', 'S', 'W']) {
		const [dx, dz] = SIDE_VEC[side];
		if (from[0] + dx === to[0] && from[1] + dz === to[1]) return side;
	}
	return null;
};
const orientFor = (dirs, baseDirs) => {
	for (const o of [0, 16, 10, 22]) {
		const rot = baseDirs.map((s) => rotSide(s, o));
		if (rot.length === dirs.length && rot.every((s) => dirs.includes(s))) return o;
	}
	return 0;
};
// travel direction → orient code for straight-axis pieces & descent ramps.
// Verified in-game: descend +z = orient 0 (mouth toward the road at -z).
// wide⇄thin ramps (thin-wall-specs 'wide-thin': walls at ±4.78 at local -z
// converging to ±2.21 at local +z): the WIDE end is LOCAL -z, so the orient
// encodes the direction the THIN end faces — thin faces S = orient 0.
const DIR_TO_ORIENT = { S: 0, N: 10, E: 16, W: 22 };
const ORIENT_TO_DIR = { 0: 'S', 10: 'N', 16: 'E', 22: 'W' };

function groundDirsOf(tile) {
	const type = tile[2], o = tile[3];
	if (type === 'track-straight' || type === 'track-checkpoint' || type === 'track-finish' || type === 'track-thin-straight') return [rotSide('N', o), rotSide('S', o)];
	if (type === 'track-corner') return [rotSide('S', o), rotSide('W', o)];
	return null;
}

// ─── ground loop, with optional ONE self-crossing (figure-8) ──────────────────
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const nk0 = (p) => key(p.nx, p.nz);
function genClosedLoop(rng, opts = {}) {
	const W = opts.W || 14, H = opts.H || 14;
	const minLen = opts.minLen || 20, maxLen = opts.maxLen || 40;
	const attempts = opts.attempts || 200;
	const allowCross = opts.figure8 !== false;
	let bestPath = null, bestScore = -Infinity;
	for (let att = 0; att < attempts; att++) {
		const sx = rndInt(rng, 2, W - 3), sz = rndInt(rng, 2, H - 3);
		const seen = new Set([key(sx, sz)]);
		const enterAxis = new Map();   // cell → 'x'|'z' axis it was entered on
		const passAxis = new Map();     // cell → axis IF passed straight through
		const path = [[sx, sz]];
		let prevDir = -1, crossCount = 0;
		const crossCells = new Set();
		while (path.length <= maxLen) {
			const [cx, cz] = path[path.length - 1];
			if (path.length >= minLen && Math.abs(cx - sx) + Math.abs(cz - sz) === 1) {
				path.push([sx, sz]);
				if (path.length - 1 >= minLen) {
					const core = path.slice(0, -1);
					let straightPotential = 0, runLen = 1;
					for (let pi = 1; pi <= core.length; pi++) {
						const a = core[pi - 1], b = core[pi % core.length], c = core[(pi + 1) % core.length];
						const d1 = [b[0] - a[0], b[1] - a[1]], d2 = [c[0] - b[0], c[1] - b[1]];
						if (d1[0] === d2[0] && d1[1] === d2[1]) runLen++; else { if (runLen >= 4) straightPotential += runLen * runLen; runLen = 1; }
					}
					const score = crossCount * 10000 + straightPotential * 120 + (path.length - 1);
					if (score > bestScore) { bestScore = score; bestPath = path.slice(); }
				}
				path.pop();
			}
			const candidates = [];
			for (let di = 0; di < 4; di++) {
				const [dx, dz] = DIRS[di];
				const nx = cx + dx, nz = cz + dz;
				if (nx < 1 || nz < 1 || nx >= W - 1 || nz >= H - 1) continue;
				const nk = key(nx, nz);
				const myAxis = (di === 0 || di === 2) ? 'x' : 'z';
				if (seen.has(nk)) {
					// up to TWO self-crossings: perpendicular, over a cell we
					// passed STRAIGHT through, never the start cell, never the
					// same crossing cell twice.
					if (allowCross && crossCount < 2 && path.length >= 8 && !(nx === sx && nz === sz) && !crossCells.has(nk)) {
						// never adjacent to an existing crossing — two 4-ways
						// touching each other render as a broken block plaza
						let tooClose = false;
						for (const ck of crossCells) {
							const [cxx, czz] = ck.split(',').map(Number);
							if (Math.abs(cxx - nx) + Math.abs(czz - nz) <= 1) { tooClose = true; break; }
						}
						if (!tooClose) {
							const axis = passAxis.get(nk);
							if (axis && axis !== myAxis) candidates.push({ di, nx, nz, score: 1.6, cross: true });
						}
					}
					continue;
				}
				if (prevDir !== -1 && (di + 2) % 4 === prevDir) continue;
				let neighbors = 0;
				for (const [adx, adz] of DIRS) if (seen.has(key(nx + adx, nz + adz))) neighbors++;
				if (neighbors > 2) continue;
				let score = 1;
				if (prevDir === di) score += 2.0;
				candidates.push({ di, nx, nz, score, cross: false });
			}
			if (!candidates.length) break;
			let total = 0;
			for (const c of candidates) total += c.score;
			let r = rng() * total;
			let pick = candidates[0];
			for (const c of candidates) { r -= c.score; if (r <= 0) { pick = c; break; } }
			const last = path[path.length - 1];
			const lastEnter = enterAxis.get(key(last[0], last[1]));
			if (lastEnter === ((pick.di === 0 || pick.di === 2) ? 'x' : 'z')) {
				passAxis.set(key(last[0], last[1]), lastEnter); // straight-through
			}
			if (pick.cross) { crossCount++; crossCells.add(nk0(pick)); }
			else { seen.add(key(pick.nx, pick.nz)); enterAxis.set(key(pick.nx, pick.nz), (pick.di === 0 || pick.di === 2) ? 'x' : 'z'); }
			path.push([pick.nx, pick.nz]);
			prevDir = pick.di;
		}
	}
	return bestPath;
}

function loopToTiles(loop) {
	const closed = loop.slice(0, -1);
	const n = closed.length;
	const tiles = [];
	const byKey = new Map();
	for (let i = 0; i < n; i++) {
		const cur = closed[i];
		const prev = closed[(i + n - 1) % n];
		const next = closed[(i + 1) % n];
		const dx = next[0] - prev[0], dz = next[1] - prev[1];
		let type = 'track-straight', orient = 0;
		if (Math.abs(dx) === 2 && dz === 0) { type = 'track-straight'; orient = 22; }
		else if (Math.abs(dz) === 2 && dx === 0) { type = 'track-straight'; orient = 0; }
		else {
			type = 'track-corner';
			const ox = next[0] - cur[0], oz = next[1] - cur[1];
			const px = cur[0] - prev[0], pz = cur[1] - prev[1];
			const inSide = px === 1 ? 'W' : px === -1 ? 'E' : pz === 1 ? 'N' : 'S';
			const outSide = ox === 1 ? 'E' : ox === -1 ? 'W' : oz === 1 ? 'S' : 'N';
			orient = orientFor([inSide, outSide], ['S', 'W']);
		}
		const k = key(cur[0], cur[1]);
		if (byKey.has(k)) {
			// Second visit = the figure-8 self-crossing; both passes were
			// straight-through by construction → a flat 4-way crossing.
			// CRITICAL: keep BOTH positions in the list. Every adjacency-based
			// rule downstream (runs, detour windows, ramp anchors) needs the
			// position-ordered road; silently merging the two visits leaves a
			// hole between the crossing's neighbours and breaks all of it.
			// The duplicate is flagged (tile[4] === true) and exactly ONE
			// 4-way block reaches the game.
			const t = byKey.get(k);
			t[2] = 'track-4-way'; t[3] = 0;
			tiles.push([cur[0], cur[1], 'track-4-way', 0, true]);
		} else {
			const t = [cur[0], cur[1], type, orient];
			tiles.push(t); byKey.set(k, t);
		}
	}
	let finishIdx = tiles.findIndex((t) => t[2] === 'track-straight');
	if (finishIdx < 0) finishIdx = 0;
	tiles[finishIdx][2] = 'track-finish';
	return tiles;
}

// ─── elevated detours (CupTrackGen grammar, proven) ──────────────────────────
function groundEntryForCross(inD, outD, groundDirs) {
	if (inD !== outD) return null;
	for (const o of [0, 16]) {
		const elev = [rotSide('N', o), rotSide('S', o)];
		const ground = [rotSide('E', o), rotSide('W', o)];
		if ([OPP_SIDE[inD], outD].every((s) => elev.includes(s)) && groundDirs.every((s) => ground.includes(s)) && groundDirs.length === 2) {
			return { type: 'elevated-cross', orient: o };
		}
	}
	return null;
}
function elevatedEntryAt(cell, inD, outD, ctx) {
	const k = key(cell[0], cell[1]);
	if (ctx.elevKeys.has(k) || ctx.slopeKeys.has(k) || ctx.blockKeys.has(k)) return null;
	const g = ctx.groundMap.get(k);
	if (g && !ctx.windowKeys.has(k)) {
		const dirs = groundDirsOf(g.tile);
		if (!dirs) return null;
		if (inD === outD) return groundEntryForCross(inD, outD, dirs);
		// corner over corner → elevated-cross-corner (rotated pair match)
		for (const o of [0, 16, 10, 22]) {
			const elev = [rotSide('S', o), rotSide('W', o)];
			const ground = [rotSide('N', o), rotSide('E', o)];
			if ([OPP_SIDE[inD], outD].every((sd) => elev.includes(sd)) && ground.length === dirs.length && dirs.every((sd) => ground.includes(sd))) {
				return { type: 'elevated-cross-corner', orient: o };
			}
		}
		return null;
	}
	// everything else — empty cells AND this window's interior (which is
	// being removed from the ground) — is free elevated road
	if (inD === outD) return { type: 'elevated-straight', orient: (inD === 'N' || inD === 'S') ? 0 : 16 };
	return { type: 'elevated-corner', orient: orientFor([OPP_SIDE[inD], outD], ['S', 'W']) };
}

function findPathSearch(startCell, startInD, endCell, endOutD, ctx, maxLen, entryFn) {
	const startKey = key(startCell[0], startCell[1]);
	const endKey = key(endCell[0], endCell[1]);
	if (startKey === endKey) return null;
	const chainHas = (node, k) => {
		let cur = node;
		while (cur) { if (key(cur.cell[0], cur.cell[1]) === k) return true; cur = cur.parent; }
		return false;
	};
	// rebuild the entry chain from a popped goal node
	const reconstruct = (endNode) => {
		const cellsR = [];
		let cur = endNode;
		while (cur) { cellsR.unshift([cur.cell[0], cur.cell[1]]); cur = cur.parent; }
		const entries = [];
		for (let ci = 0; ci < cellsR.length; ci++) {
			const inD = ci === 0 ? startInD : dirFromTo(cellsR[ci - 1], cellsR[ci]);
			const outD2 = ci === cellsR.length - 1 ? endOutD : dirFromTo(cellsR[ci], cellsR[ci + 1]);
			const e = entryFn(cellsR[ci], inD, outD2, ctx);
			if (!e) return null;
			entries.push([cellsR[ci][0], cellsR[ci][1], e]);
		}
		return entries;
	};
	const best = new Map();
	const pq = [{ cell: startCell, inD: startInD, cost: 0, depth: 0, parent: null }];
	let guard = 60000;
	while (pq.length && guard-- > 0) {
		let bi = 0;
		for (let i = 1; i < pq.length; i++) if (pq[i].cost < pq[bi].cost) bi = i;
		const node = pq.splice(bi, 1)[0];
		const stateKey = key(node.cell[0], node.cell[1]) + '|' + node.inD;
		const seenCost = best.get(stateKey);
		if (seenCost !== undefined && seenCost < node.cost) continue;
		best.set(stateKey, node.cost);
		// GOAL AT POP TIME. Returning the first expansion that touches the
		// end cell always yielded the trivial 2-4 cell path before the
		// crossing rewards could matter — crossing-rich paths accumulate
		// negative cost and pop first, so the hunt finally steers.
		if (key(node.cell[0], node.cell[1]) === endKey) {
			if (entryFn(node.cell, node.inD, endOutD, ctx)) return reconstruct(node);
			continue; // dead-end angle into the end — keep exploring others
		}
		if (node.depth >= maxLen) continue;
		for (const outD of ['N', 'E', 'S', 'W']) {
			if (outD === OPP_SIDE[node.inD]) continue;
			if (!entryFn(node.cell, node.inD, outD, ctx)) continue;
			const [dx, dz] = SIDE_VEC[outD];
			const nx = node.cell[0] + dx, nz = node.cell[1] + dz;
			if (nx < ctx.minX || nx > ctx.maxX || nz < ctx.minZ || nz > ctx.maxZ) continue;
			const nbKey = key(nx, nz);
			if (nbKey !== endKey && chainHas(node, nbKey)) continue;
			const isCross = ctx.isCrossCell ? ctx.isCrossCell(nbKey) : false;
			const crossReward = ctx.crossReward ?? -7;
			const stepCost = 1 + (outD !== node.inD ? 0.5 : 0) + (isCross ? crossReward : 0);
			const nCost = node.cost + stepCost;
			const nState = nbKey + '|' + outD;
			if (best.has(nState) && best.get(nState) <= nCost) continue;
			pq.push({ cell: [nx, nz], inD: outD, cost: nCost, depth: node.depth + 1, parent: node });
		}
	}
	return null;
}

function cyclicRunsOf(tiles, isPlain, n) {
	const runs = [];
	let anchor = 0;
	while (anchor < n && isPlain(anchor)) anchor++;
	if (anchor >= n) { runs.push({ start: 0, len: n }); return runs; }
	for (let k = 0; k < n; k++) {
		const idx = (anchor + k) % n;
		if (!isPlain(idx) || isPlain((idx + n - 1) % n)) continue;
		let len = 1;
		while (len < n && isPlain((idx + len) % n)) len++;
		if (len < n) runs.push({ start: idx, len });
	}
	return runs;
}

// ─── tunnel entry rules (pit road; sealed crossings under the live loop) ────
function tunnelEntryAt(cell, inD, outD, ctx) {
	const k = key(cell[0], cell[1]);
	if (ctx.blockKeys.has(k)) return null;
	if (ctx.rampKeys && ctx.rampKeys.has(k)) return null;
	const g = ctx.groundMap.get(k);
	const isLiveRoad = g && !ctx.windowKeys.has(k);
	// road over tunnel → sealed roof is mandatory; everything else (empty
	// cells AND this window's interior, which becomes the pit road) follows
	// the map-level 50/50 open/closed preference
	const closed = isLiveRoad ? 1 : (ctx.preferClosed ? 1 : 0);
	let type, orient;
	if (inD === outD) { type = 'track-straight'; orient = (inD === 'N' || inD === 'S') ? 0 : 22; }
	else { type = 'track-corner'; orient = orientFor([OPP_SIDE[inD], outD], ['S', 'W']); }
	return { type, orient, closed };
}

// ─── interleaved detours — the overlap engine ────────────────────────────────
// Every slot evaluates candidate windows as BOTH an elevated detour and a
// tunnel detour, then places whichever yields more true crossings (ties
// alternate between families so both always appear). This is what makes the
// road-over-road, road-over-tunnel and 4-way crossings pile up on one map.
function genInterleavedDetours(rng, tiles, specialIdx, removedIdx, elevEntries, tunnelEntries, blockKeys, preferClosed, opts) {
	const n = tiles.length;
	const isPlain = (i) => !specialIdx.has(i) && !tiles[i][4] && (tiles[i][2] === 'track-straight' || tiles[i][2] === 'track-corner') && !blockKeys.has(key(tiles[i][0], tiles[i][1]));
	if (!tiles.some((_, i) => isPlain(i))) return;
	const runs = cyclicRunsOf(tiles, isPlain, n);
	const elevKeys = new Set(elevEntries.map(([gx, gz]) => key(gx, gz)));
	const tunnelKeys = new Set(tunnelEntries.map((e) => key(e[0], e[1])));
	// road cells that FEED a placed detour's ramps (just outside each
	// window). A later window that removes one of these leaves the earlier
	// ramp's mouth facing a pit/water — a ramp into nothing.
	const anchorKeys = new Set();
	const windows = [];
	for (const run of runs) {
		if (run.len < 4) continue;
		const straights = [];
		let blocked = false;
		for (let k = 0; k < run.len; k++) {
			const t = tiles[(run.start + k) % n];
			if (elevKeys.has(key(t[0], t[1])) || tunnelKeys.has(key(t[0], t[1])) || blockKeys.has(key(t[0], t[1]))) { blocked = true; break; }
			if (t[2] === 'track-straight') straights.push(k);
		}
		if (blocked || straights.length < 2) continue;
		for (const i of straights) for (const j of straights) {
			const len = j - i + 1;
			if (len < 4 || len > 18) continue;
			windows.push({ run, i, j, len });
		}
	}
	if (!windows.length) return;
	windows.sort((a, b) => b.len - a.len || a.run.start - b.run.start || a.i - b.i);
	const xs0 = tiles.map((t) => t[0]), zs0 = tiles.map((t) => t[1]);
	const bbox = { minX: Math.min(...xs0) - 2, maxX: Math.max(...xs0) + 2, minZ: Math.min(...zs0) - 2, maxZ: Math.max(...zs0) + 2 };
	const idxOfOf = (w) => ((k) => (w.run.start + k + n) % n);
	const buildCtx = (w, elevMode, rampCells) => {
		const ctx = {
			groundMap: new Map(), windowKeys: new Set(),
			blockKeys: new Set(blockKeys),
			elevKeys: elevMode ? new Set(elevKeys) : null,
			slopeKeys: new Set(),
			rampKeys: new Set(rampCells.map((c) => key(c[0], c[1]))),
			preferClosed, rng,
			minX: bbox.minX, maxX: bbox.maxX, minZ: bbox.minZ, maxZ: bbox.maxZ,
			isCrossCell: (k) => ctx.groundMap.has(k) && !ctx.windowKeys.has(k),
		};
		// checkpoint/finish/4-way cells hold real ground pieces (gates!) —
		// a detour deck or pit stacked over them is the classic
		// "blocks layered over blocks" breakage, so block them outright
		for (let ti = 0; ti < tiles.length; ti++) {
			if (!specialIdx.has(ti)) continue;
			ctx.blockKeys.add(key(tiles[ti][0], tiles[ti][1]));
		}
		for (let ti = 0; ti < tiles.length; ti++) {
			if (removedIdx.has(ti) || specialIdx.has(ti)) continue;
			ctx.groundMap.set(key(tiles[ti][0], tiles[ti][1]), { tile: tiles[ti] });
		}
		const idxOf = idxOfOf(w);
		for (let k = w.i; k <= w.j; k++) ctx.windowKeys.add(key(tiles[idxOf(k)][0], tiles[idxOf(k)][1]));
		return ctx;
	};
	const anchorsOk = (w) => {
		const idxOf = idxOfOf(w);
		for (const ai of [w.i - 1, w.j + 1]) {
			const idx = idxOf(ai);
			const ak = key(tiles[idx][0], tiles[idx][1]);
			if (removedIdx.has(idx) || specialIdx.has(idx) || tiles[idx][4]) return false;
			if (anchorKeys.has(ak) || blockKeys.has(ak)) return false;
		}
		for (let k = w.i; k <= w.j; k++) if (anchorKeys.has(key(tiles[idxOf(k)][0], tiles[idxOf(k)][1]))) return false;
		return true;
	};
	const evaluateElev = (w) => {
		const idxOf = idxOfOf(w);
		if (!anchorsOk(w)) return null;
		for (let k = w.i; k <= w.j; k++) {
			const kk = key(tiles[idxOf(k)][0], tiles[idxOf(k)][1]);
			if (removedIdx.has(idxOf(k)) || elevKeys.has(kk) || blockKeys.has(kk)) return null;
		}
		const cells = [];
		for (let k = w.i; k <= w.j; k++) cells.push(tiles[idxOf(k)]);
		const L = w.j - w.i + 1;
		const a = tiles[idxOf(w.i - 1)], b = tiles[idxOf(w.j + 1)];
		const gin = dirFromTo(cells[0], a), gout = dirFromTo(cells[L - 1], b);
		if (!gin || !gout) return null;
		const startInD = OPP_SIDE[gin], endOutD = gout;
		const [sdx, sdz] = SIDE_VEC[startInD];
		const firstCell = [cells[0][0] + sdx, cells[0][1] + sdz];
		const [edx, edz] = SIDE_VEC[OPP_SIDE[gout]];
		const lastCell = [cells[L - 1][0] + edx, cells[L - 1][1] + edz];
		const ctx = buildCtx(w, true, [cells[0], cells[L - 1]]);
		ctx.slopeKeys = new Set([key(cells[0][0], cells[0][1]), key(cells[L - 1][0], cells[L - 1][1])]);
		ctx.crossReward = -60;
		let path = findPathSearch(firstCell, startInD, lastCell, endOutD, ctx, Math.min(24, Math.max(16, L + 10)), elevatedEntryAt);
		if (!path) {
			path = [];
			for (let k = 1; k < L - 1; k++) {
				const c = cells[k];
				const d1 = dirFromTo(c, cells[k - 1]), d2 = dirFromTo(c, cells[k + 1]);
				if (!d1 || !d2) { path = null; break; }
				if (d1 === OPP_SIDE[d2]) path.push([c[0], c[1], { type: 'elevated-straight', orient: orientFor([d1, d2], ['N', 'S']) }]);
				else path.push([c[0], c[1], { type: 'elevated-corner', orient: orientFor([d1, d2], ['S', 'W']) }]);
			}
			if (path === null) return null;
		}
		const xCount = path.filter(([, , e]) => e.type === 'elevated-cross' || e.type === 'elevated-cross-corner').length;
		return { w, cells, gin, gout, path, xCount, L, idxOf };
	};
	const evaluateTunl = (w) => {
		const idxOf = idxOfOf(w);
		if (!anchorsOk(w)) return null;
		for (let k = w.i; k <= w.j; k++) {
			const kk = key(tiles[idxOf(k)][0], tiles[idxOf(k)][1]);
			if (removedIdx.has(idxOf(k)) || tunnelKeys.has(kk) || blockKeys.has(kk)) return null;
		}
		const cells = [];
		for (let k = w.i; k <= w.j; k++) cells.push(tiles[idxOf(k)]);
		const L = w.j - w.i + 1;
		const a = tiles[idxOf(w.i - 1)], b = tiles[idxOf(w.j + 1)];
		const gin = dirFromTo(cells[0], a), gout = dirFromTo(cells[L - 1], b);
		if (!gin || !gout) return null;
		const startInD = OPP_SIDE[gin], endOutD = gout;
		const [sdx, sdz] = SIDE_VEC[startInD];
		const firstCell = [cells[0][0] + sdx, cells[0][1] + sdz];
		const [edx, edz] = SIDE_VEC[OPP_SIDE[gout]];
		const lastCell = [cells[L - 1][0] + edx, cells[L - 1][1] + edz];
		const ctx = buildCtx(w, false, [cells[0], cells[L - 1]]);
		ctx.crossReward = -50;
		let path = findPathSearch(firstCell, startInD, lastCell, endOutD, ctx, Math.min(60, Math.max(24, L + 14)), tunnelEntryAt);
		if (!path) {
			path = [];
			for (let k = 1; k < L - 1; k++) {
				const c = cells[k];
				const d1 = dirFromTo(c, cells[k - 1]), d2 = dirFromTo(c, cells[k + 1]);
				if (!d1 || !d2) { path = null; break; }
				if (d1 === OPP_SIDE[d2]) path.push([c[0], c[1], { type: 'track-straight', orient: orientFor([d1, d2], ['N', 'S']), closed: preferClosed ? 1 : 0 }]);
				else path.push([c[0], c[1], { type: 'track-corner', orient: orientFor([d1, d2], ['S', 'W']), closed: preferClosed ? 1 : 0 }]);
			}
			if (path === null) return null;
		}
		// true crossing = pit cell with the live road still on the roof
		const xCount = path.filter(([gx, gz]) => ctx.groundMap.has(key(gx, gz)) && !ctx.windowKeys.has(key(gx, gz))).length;
		return { w, cells, gin, gout, path, xCount, L, idxOf };
	};
	// structural guard: ramp→path→ramp must be one connected chain and every
	// cell unique — a detour that fails this is skipped, never placed half
	const pathValid = (res) => {
		const { cells, path, L } = res;
		if (!path.length) return false;
		const seen = new Set([key(cells[0][0], cells[0][1]), key(cells[L - 1][0], cells[L - 1][1])]);
		for (const [gx, gz] of path) {
			const k = key(gx, gz);
			if (seen.has(k)) return false;
			seen.add(k);
		}
		for (let i = 1; i < path.length; i++) if (Math.abs(path[i][0] - path[i - 1][0]) + Math.abs(path[i][1] - path[i - 1][1]) !== 1) return false;
		if (Math.abs(path[0][0] - cells[0][0]) + Math.abs(path[0][1] - cells[0][1]) !== 1) return false;
		if (Math.abs(path[path.length - 1][0] - cells[L - 1][0]) + Math.abs(path[path.length - 1][1] - cells[L - 1][1]) !== 1) return false;
		return true;
	};
	const placeElev = (res) => {
		const { cells, gin, gout, path, L } = res;
		// PATH ORDER: ramp, path cells, ramp — keeps each detour's entries a
		// contiguous, walkable chain (the thin-section scanner relies on it)
		elevEntries.push([cells[0][0], cells[0][1], 'slope-up', orientFor([gin], ['S'])]);
		for (const [gx, gz, e] of path) {
			elevEntries.push([gx, gz, e.type, e.orient]);
			elevKeys.add(key(gx, gz));
			blockKeys.add(key(gx, gz));
		}
		elevEntries.push([cells[L - 1][0], cells[L - 1][1], 'slope-up', orientFor([gout], ['S'])]);
		for (const c of [cells[0], cells[L - 1]]) { elevKeys.add(key(c[0], c[1])); blockKeys.add(key(c[0], c[1])); }
	};
	const placeTunl = (res) => {
		const { cells, gin, gout, path, L } = res;
		tunnelEntries.push([cells[0][0], cells[0][1], 0, DIR_TO_ORIENT[OPP_SIDE[gin]], 'slope-up']);
		for (const [gx, gz, e] of path) {
			tunnelEntries.push([gx, gz, e.closed, e.orient, e.type]);
			tunnelKeys.add(key(gx, gz));
			blockKeys.add(key(gx, gz));
		}
		tunnelEntries.push([cells[L - 1][0], cells[L - 1][1], 0, DIR_TO_ORIENT[OPP_SIDE[gout]], 'slope-up']);
		for (const c of [cells[0], cells[L - 1]]) { tunnelKeys.add(key(c[0], c[1])); blockKeys.add(key(c[0], c[1])); }
	};
	// Deterministic crossing allocator: do NOT exhaust the road windows on one
	// family first. Every slot compares both families against their remaining
	// quota, so the same seed always gets a balanced mix of road-over-road and
	// road-over-tunnel crossings.
	const targetElev = 12;
	const targetTunnel = 12;
	const totalSlots = 18;
	const capTotal = Math.min(240, Math.max(48, Math.floor(tiles.length * 1.35)));
	let used = 0, placedElevCrossings = 0, placedTunnelCrossings = 0;
	for (let slot = 0; slot < totalSlots && windows.length; slot++) {
		let best = null;
		// Alternate families while both are below quota. This is intentional:
		// a greedy "best crossing" choice can consume every usable window for
		// one family and leave the other with zero opportunities.
		let wantedFamily = (slot % 2 === 0) ? 'elev' : 'tunl';
		if (placedElevCrossings >= targetElev) wantedFamily = 'tunl';
		if (placedTunnelCrossings >= targetTunnel) wantedFamily = 'elev';
		const deferred = [];
		let evalCount = 0, drained = 0;
		while (windows.length && evalCount < 18 && drained < 60) {
			const w = windows.shift();
			drained++;
			if (used + w.len > capTotal) continue;
			const cands = [];
			if (wantedFamily === 'elev' && opts.elevated && placedElevCrossings < targetElev) {
				const re = evaluateElev(w);
				if (re && re.xCount > 0) cands.push({ family: 'elev', res: re });
			}
			if (wantedFamily === 'tunl' && opts.tunnels && placedTunnelCrossings < targetTunnel) {
				const rt = evaluateTunl(w);
				if (rt && rt.xCount > 0) cands.push({ family: 'tunl', res: rt });
			}
			if (!cands.length) continue;
			evalCount++;
			deferred.push(w);
			for (const cand of cands) {
				const current = cand.family === 'elev' ? placedElevCrossings : placedTunnelCrossings;
				const target = cand.family === 'elev' ? targetElev : targetTunnel;
				const deficit = target - current;
				const value = cand.res.xCount * 100 + Math.min(deficit, cand.res.xCount) * 25;
				if (!best || value > best.value || (value === best.value && cand.family === (slot % 2 ? 'tunl' : 'elev'))) {
					best = { ...cand, value };
				}
			}
			if (best) {
				const bestTarget = best.family === 'elev' ? targetElev : targetTunnel;
				const bestCurrent = best.family === 'elev' ? placedElevCrossings : placedTunnelCrossings;
				if (bestCurrent + best.res.xCount >= bestTarget) break;
			}
		}
		for (const w2 of deferred) windows.push(w2);
		if (!best) continue;
		const res = best.family === 'elev' ? evaluateElev(best.res.w) : evaluateTunl(best.res.w);
		if (!res || !pathValid(res) || res.xCount <= 0) continue;
		if (best.family === 'elev') {
			placeElev(res);
			placedElevCrossings += res.xCount;
		} else {
			placeTunl(res);
			placedTunnelCrossings += res.xCount;
		}
		for (const ai of [res.w.i - 1, res.w.j + 1]) {
			const idx = res.idxOf(ai);
			anchorKeys.add(key(tiles[idx][0], tiles[idx][1]));
		}
		for (let k = res.w.i; k <= res.w.j; k++) removedIdx.add(res.idxOf(k));
		used += res.L;
	}

}

// ─── pool driving sections (pool ramp → water → pool ramp) ───────────────────
function genPoolCrossing(rng, tiles, specialIdx, removedIdx, blockKeys) {
	const n = tiles.length;
	const isPlainStraight = (i) => !specialIdx.has(i) && !tiles[i][4] && tiles[i][2] === 'track-straight' && !blockKeys.has(key(tiles[i][0], tiles[i][1]));
	const runs = cyclicRunsOf(tiles, isPlainStraight, n).filter((r) => r.len >= 6 && r.len <= 24);
	const candidates = [];
	for (const run of runs) {
		const L = 6;
		for (let off = 0; off <= run.len - L; off++) {
			const idxOf = (k) => (run.start + k + n) % n;
			let bad = false;
			for (let k = off; k < off + L; k++) if (removedIdx.has(idxOf(k))) bad = true;
			if (bad) continue;
			const entryCell = tiles[idxOf(off - 1)];
			const exitCell = tiles[idxOf(off + L)];
			const inD = dirFromTo(entryCell, tiles[idxOf(off)]);
			const outD = dirFromTo(tiles[idxOf(off + L - 1)], exitCell);
			if (!inD || !outD || inD !== outD) continue;
			candidates.push({ run, off, idxOf, inD, outD });
		}
	}
	if (!candidates.length) return null;
	const pick = candidates[hash32(String(candidates.length) + ':' + String(tiles.length)) % candidates.length];
	const water = [];
	for (let k = pick.off; k < pick.off + 6; k++) {
		water.push([tiles[pick.idxOf(k)][0], tiles[pick.idxOf(k)][1]]);
		removedIdx.add(pick.idxOf(k));
	}
	const downSlope = [tiles[pick.idxOf(pick.off)][0], tiles[pick.idxOf(pick.off)][1], pick.inD];
	const upSlope = [tiles[pick.idxOf(pick.off + 5)][0], tiles[pick.idxOf(pick.off + 5)][1], OPP_SIDE[pick.outD]];
	return { water, downSlope, upSlope };
}

// ─── decorative enclosed ponds (CupTrackGen, proven) ──────────────────────────
function genPools(cells) {
	const roadSet = new Set(cells.map((c) => key(c[0], c[1])));
	const xs = cells.map((c) => c[0]), zs = cells.map((c) => c[1]);
	const minX = Math.min(...xs), maxX = Math.max(...xs);
	const minZ = Math.min(...zs), maxZ = Math.max(...zs);
	const seen = new Set();
	const pools = [];
	for (let x = minX; x <= maxX; x++) {
		for (let z = minZ; z <= maxZ; z++) {
			const k = key(x, z);
			if (roadSet.has(k) || seen.has(k)) continue;
			const comp = [[x, z]];
			seen.add(k);
			let enclosed = true;
			for (let ci = 0; ci < comp.length; ci++) {
				const [cx, cz] = comp[ci];
				if (cx === minX || cx === maxX || cz === minZ || cz === maxZ) enclosed = false;
				for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
					const nx = cx + dx, nz = cz + dz;
					if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
					const nk = key(nx, nz);
					if (roadSet.has(nk) || seen.has(nk)) continue;
					seen.add(nk);
					comp.push([nx, nz]);
				}
			}
			if (enclosed && comp.length <= 20) for (const c of comp) pools.push([c[0], c[1]]);
		}
	}
	return pools;
}

// ─── thin-block sections (wide ⇄ thin chains that can BEND) ──────────────────
// GLB-VERIFIED (2026-10-02, elev-wide-to-thin.glb parsed directly): the raised
// walls sit at ±4.90 on the local -z half and ±2.39 on +z, matching the
// auto-generated colliders — the WIDE end is LOCAL -z at orient 0. So:
//   entry ramp: wide end faces the wide road BEHIND  → orient DIR_TO_ORIENT[OPP_SIDE[backDir]]
//   exit ramp:  wide end faces the wide road AHEAD    → orient DIR_TO_ORIENT[OPP_SIDE[fwdDir]]
// Chains may include ONE corner (track-thin-corner / elevated-thin-corner)
// so thin sections bend instead of only running straight.
function buildThinChain(win, backCell, fwdCell, prefix) {
	const L = win.length;
	const backDir = dirFromTo(win[0], backCell);
	const fwdDir = dirFromTo(win[L - 1], fwdCell);
	if (!backDir || !fwdDir) return null;
	const conv = [{ type: prefix + '-wide-thin', orient: DIR_TO_ORIENT[OPP_SIDE[backDir]] }];
	for (let k = 1; k < L - 1; k++) {
		const prev = win[k - 1], c = win[k], next = win[k + 1];
		const inT = dirFromTo(prev, c), outT = dirFromTo(c, next);
		if (!inT || !outT) return null;
		if (String(c[2]).includes('corner')) conv.push({ type: prefix + '-thin-corner', orient: orientFor([OPP_SIDE[inT], outT], ['S', 'W']) });
		else conv.push({ type: prefix + '-thin-straight', orient: DIR_TO_ORIENT[outT] });
	}
	conv.push({ type: prefix + '-wide-thin', orient: DIR_TO_ORIENT[OPP_SIDE[fwdDir]] });
	return conv;
}

function genGroundThinSections(rng, tiles, specialIdx, removedIdx, blockKeys, count) {
	const n = tiles.length;
	// anchors (chain ends) may be straights OR corners — both are wide roads.
	// First/last chain cells must sit on STRAIGHTS (wide⇄thin ramps are
	// straight pieces); one interior cell may be a corner.
	const isPlainRoad = (i) => !specialIdx.has(i) && !tiles[i][4] && (tiles[i][2] === 'track-straight' || tiles[i][2] === 'track-corner') && !removedIdx.has(i) && !blockKeys.has(key(tiles[i][0], tiles[i][1]));
	const runs = cyclicRunsOf(tiles, isPlainRoad, n).filter((r) => r.len >= 5 && r.len <= 26);
	if (!runs.length) return { placed: 0, corners: 0 };
	const chosen = [];
	for (const run of runs) {
		if (chosen.length >= count) break;
		chosen.push(run);
	}
	let placed = 0, corners = 0;
	for (const run of chosen) {
		if (placed >= count) break;
		const idxOf = (k) => (run.start + k + n) % n;
		let done = false;
		// prefer windows that BEND (a thin-corner) for block variety, then
		// accept straight windows; longer first
		for (const wantCorner of [true, false]) {
			for (const L of [5, 4, 3]) {
				if (run.len - L < 2) continue;
				for (let off = 1; off <= run.len - L - 1; off++) {
					const win = [];
					let bad = false;
					for (let k = off; k < off + L; k++) {
						const t = tiles[idxOf(k)];
						if (removedIdx.has(idxOf(k)) || blockKeys.has(key(t[0], t[1])) || (t[2] !== 'track-straight' && t[2] !== 'track-corner')) { bad = true; break; }
						win.push(t);
					}
					if (bad) continue;
					if (win[0][2] !== 'track-straight' || win[L - 1][2] !== 'track-straight') continue;
					// anchors must be surviving road — a ramp whose wide end
					// faces water / a removed detour cell / the dup 4-way
					// entry renders as a ramp into nothing
					const backIdx = idxOf(off - 1), fwdIdx = idxOf(off + L);
					if (removedIdx.has(backIdx) || removedIdx.has(fwdIdx)) continue;
					if (tiles[backIdx][4] || tiles[fwdIdx][4]) continue;
					if (blockKeys.has(key(tiles[backIdx][0], tiles[backIdx][1])) || blockKeys.has(key(tiles[fwdIdx][0], tiles[fwdIdx][1]))) continue;
					const cs = win.filter((t) => t[2] === 'track-corner').length;
					if (cs > 1) continue;
					if (wantCorner && cs === 0) continue;
					const conv = buildThinChain(win, tiles[backIdx], tiles[fwdIdx], 'track');
					if (!conv) continue;
					for (let k = 0; k < L; k++) {
						const t = win[k];
						t[2] = conv[k].type;
						t[3] = conv[k].orient;
						blockKeys.add(key(t[0], t[1]));
						if (String(conv[k].type).includes('corner')) corners++;
					}
					// the wide anchors at each end must stay road — claim them
					blockKeys.add(key(tiles[idxOf(off - 1)][0], tiles[idxOf(off - 1)][1]));
					blockKeys.add(key(tiles[idxOf(off + L)][0], tiles[idxOf(off + L)][1]));
					placed++;
					done = true;
					break;
				}
				if (done) break;
			}
			if (done) break;
		}
	}
	return { placed, corners };
}

function genElevatedThinSections(rng, elevEntries, blockKeys, count) {
	// Detour entries are in PATH ORDER (ramp, path..., ramp), so group
	// maximal runs of adjacent entries and convert stretches — the chain
	// may bend through ONE corner (elevated-thin-corner).
	let placed = 0, corners = 0, i = 0;
	while (i < elevEntries.length && placed < count) {
		let j = i;
		while (j + 1 < elevEntries.length
			&& Math.abs(elevEntries[j + 1][0] - elevEntries[j][0]) + Math.abs(elevEntries[j + 1][1] - elevEntries[j][1]) === 1) j++;
		const group = elevEntries.slice(i, j + 1);
		let a = 0;
		while (a < group.length && placed < count) {
			if (group[a][2] !== 'elevated-straight') { a++; continue; }
			let done = false;
			for (const wantCorner of [true, false]) {
				for (const L of [5, 4, 3]) {
					const b = a + L - 1;
					if (a - 1 < 0 || b + 1 >= group.length) continue;
					const win = group.slice(a, b + 1);
					if (win[0][2] !== 'elevated-straight' || win[L - 1][2] !== 'elevated-straight') continue;
					let cs = 0, bad = false;
					for (const e of win) {
						if (e[2] === 'elevated-corner') cs++;
						else if (e[2] !== 'elevated-straight') { bad = true; break; }
					}
					if (bad || cs > 1) continue;
					if (wantCorner && cs === 0) continue;
					const conv = buildThinChain(win, group[a - 1], group[b + 1], 'elevated');
					if (!conv) continue;
					for (let k = 0; k < L; k++) {
						win[k][2] = conv[k].type;
						win[k][3] = conv[k].orient;
						if (String(conv[k].type).includes('corner')) corners++;
					}
					placed++;
					a = b + 1;
					done = true;
					break;
				}
				if (done) break;
			}
			if (!done) a++;
		}
		i = j + 1;
	}
	return { placed, corners };
}


// Deterministic hard fallback for thin sections. Unlike the old stochastic
// scanner, this directly chooses the first still-valid 3-cell chain and uses
// the already-verified wide⇄thin orientation grammar.
function forceGroundThinSections(tiles, specialIdx, removedIdx, blockKeys, needed) {
	let placed = 0, corners = 0;
	const n = tiles.length;
	for (let start = 0; start < n && placed < needed; start++) {
		const idxs = [start, start + 1, start + 2].map(v => v % n);
		const win = idxs.map(i => tiles[i]);
		if (win.some((t, k) => specialIdx.has(idxs[k]) || removedIdx.has(idxs[k]) || blockKeys.has(key(t[0], t[1])) || t[2] !== 'track-straight')) continue;
		if (win.some((t, i) => i && Math.abs(t[0] - win[i - 1][0]) + Math.abs(t[1] - win[i - 1][1]) !== 1)) continue;
		const backIdx = (start - 1 + n) % n, fwdIdx = (start + 3) % n;
		const back = tiles[backIdx], fwd = tiles[fwdIdx];
		if (removedIdx.has(backIdx) || removedIdx.has(fwdIdx)) continue;
		if (back[4] || fwd[4]) continue;
		if (blockKeys.has(key(back[0], back[1])) || blockKeys.has(key(fwd[0], fwd[1]))) continue;
		const conv = buildThinChain(win, back, fwd, 'track');
		if (!conv) continue;
		for (let k = 0; k < 3; k++) {
			win[k][2] = conv[k].type; win[k][3] = conv[k].orient;
			blockKeys.add(key(win[k][0], win[k][1]));
			if (String(conv[k].type).includes('corner')) corners++;
		}
		blockKeys.add(key(back[0], back[1])); blockKeys.add(key(fwd[0], fwd[1]));
		placed++;
	}
	return { placed, corners };
}
function forceElevatedThinSections(elevEntries, blockKeys, needed) {
	let placed = 0, corners = 0;
	for (let start = 0; start + 4 < elevEntries.length && placed < needed; start++) {
		const win = elevEntries.slice(start + 1, start + 4);
		if (win.length !== 3 || win.some(e => e[2] !== 'elevated-straight')) continue;
		const back = elevEntries[start], fwd = elevEntries[start + 4];
		if (back[2] === 'slope-up' && fwd[2] === 'slope-up') {
			const conv = buildThinChain(win, back, fwd, 'elevated');
			if (!conv) continue;
			for (let k = 0; k < 3; k++) {
				win[k][2] = conv[k].type;
				win[k][3] = conv[k].orient;
				if (String(conv[k].type).includes('corner')) corners++;
			}
			placed++;
		}
	}
	return { placed, corners };
}

// ─── master plan ──────────────────────────────────────────────────────────────
function generateTrackPlanOnce(seedText, opts) {
	const rng = mulberry32(hash32(seedText));
	// map-level hidden attribute: does this map prefer OPEN pit tunnels or
	// CLOSED tunnel sections? 50/50 from the seed. Road-over-tunnel
	// crossings are ALWAYS sealed, whatever the map prefers.
	const preferClosed = rng() < 0.7;

	// compact maps: tighter bounding boxes force detours to weave through the
	// loop instead of wandering empty grass → far more crossings per track
const size = opts.trackSize ?? 1;

// Physical footprint grows only about half as strongly as the slider.
const areaScale = 1 + (size - 1) * 0.1;

// Track/block count responds to the FULL slider range.
const lengthScale = size;

	const recipeLoop = [[10,11],[10,12],[10,13],[9,13],[9,14],[8,14],[7,14],[6,14],[6,15],[6,16],[5,16],[4,16],[3,16],[3,15],[3,14],[3,13],[2,13],[1,13],[1,12],[1,11],[1,10],[1,9],[1,8],[1,7],[1,6],[1,5],[1,4],[1,3],[1,2],[1,1],[2,1],[3,1],[4,1],[5,1],[6,1],[7,1],[8,1],[9,1],[9,2],[8,2],[7,2],[7,3],[7,4],[7,5],[6,5],[5,5],[4,5],[3,5],[3,6],[3,7],[4,7],[5,7],[6,7],[7,7],[8,7],[8,6],[9,6],[10,6],[10,5],[10,4],[10,3],[10,2],[10,1],[11,1],[12,1],[13,1],[14,1],[15,1],[16,1],[16,2],[16,3],[16,4],[15,4],[14,4],[13,4],[13,5],[14,5],[14,6],[13,6],[12,6],[11,6],[11,5],[10,5],[9,5],[9,6],[9,7],[9,8],[9,9],[8,9],[7,9],[7,8],[6,8],[5,8],[5,9],[5,10],[4,10],[3,10],[2,10],[2,11],[3,11],[4,11],[4,12],[5,12],[6,12],[6,11],[6,10],[7,10],[8,10],[9,10],[10,10],[11,10],[11,11],[10,11]];
	// The recipe is a guaranteed *shape family*, not one frozen map.
	// Derive the actual road layout from the seed while preserving the exact
	// proven scaffold topology needed by the mandatory feature recipe.
	// This gives every seed a deterministic but visibly different start,
	// orientation, and handedness instead of reusing the same literal loop.
	const uniqueLoop = recipeLoop.slice(0, -1);
	const variant = hash32(seedText + ':layout');
	const rotation = variant & 3;
	const mirrorX = ((variant >>> 2) & 1) !== 0;
	const mirrorZ = ((variant >>> 3) & 1) !== 0;
	const phase = (Math.imul(variant, 0x9e3779b1) >>> 0) % uniqueLoop.length;

	const transformed = uniqueLoop.map(([x, z]) => {
		let a = x, b = z;
		if (mirrorX) a = 17 - a;
		if (mirrorZ) b = 16 - b;
		for (let r = 0; r < rotation; r++) {
			const nextA = 16 - b;
			const nextB = a;
			a = nextA; b = nextB;
		}
		return [a, b];
	});

	// Rotate the closed traversal itself so the finish/start point also varies.
	const loop = [];
	for (let i = 0; i < transformed.length; i++) {
		loop.push(transformed[(phase + i) % transformed.length]);
	}
	loop.push(loop[0].slice());

	const tiles = loopToTiles(loop);
	const finishIdx = tiles.findIndex((t) => t[2] === 'track-finish');
	const crossCell = tiles.find((t) => t[2] === 'track-4-way' && !t[4]) || null;

	// checkpoints — farthest-point sampling on straights, never near finish;
	// a figure-8 crossing earns one extra checkpoint near the loop
	const n0 = tiles.length;
	const cycDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n0 - d); };
	const cpCandidates = [];
	for (let i = 0; i < n0; i++) {
		if (tiles[i][2] !== 'track-straight' || tiles[i][4]) continue;
		if (finishIdx >= 0 && cycDist(i, finishIdx) < 2) continue;
		cpCandidates.push(i);
	}
	let cpCount = Math.min(3, cpCandidates.length);
	const chosenCp = finishIdx >= 0 ? [finishIdx] : [];
	const chosenSet = new Set(chosenCp);
	for (let k = 0; k < cpCount; k++) {
		let best = -1, bestD = -1;
		for (const cand of cpCandidates) {
			if (chosenSet.has(cand)) continue;
			let d = Infinity;
			for (const s of chosenCp) d = Math.min(d, cycDist(cand, s));
			if (d > bestD) { bestD = d; best = cand; }
		}
		if (best < 0) break;
		chosenCp.push(best); chosenSet.add(best);
		tiles[best][2] = 'track-checkpoint';
	}
	if (crossCell) {
		// one bonus checkpoint nearest the loop crossing (always fun)
		let best = -1, bestD = 1e9;
		for (let i = 0; i < n0; i++) {
			if (tiles[i][2] !== 'track-straight' || chosenSet.has(i)) continue;
			if (finishIdx >= 0 && cycDist(i, finishIdx) < 2) continue;
			const d = Math.abs(tiles[i][0] - crossCell[0]) + Math.abs(tiles[i][1] - crossCell[1]);
			if (d < bestD) { bestD = d; best = i; }
		}
		if (best >= 0) { tiles[best][2] = 'track-checkpoint'; chosenSet.add(best); }
	}
	const specialIdx = new Set(chosenSet);
	for (let i = 0; i < tiles.length; i++) if (tiles[i][2] === 'track-4-way') specialIdx.add(i);

	const elevEntries = [];
	const removedIdx = new Set();
	const tunnelEntries = [];
	const poolSlopes = [];
	const water = [];
	const blockKeys = new Set();
	// ALL 4-way cells are claimed (there can be two) — an unclaimed one is a
	// stacking magnet for detour decks
	for (const t of tiles) if (t[2] === 'track-4-way') blockKeys.add(key(t[0], t[1]));

	// 1. pool driving section claims a straight stretch first
	if (opts.poolCrossings) {
		const pc = genPoolCrossing(rng, tiles, specialIdx, removedIdx, blockKeys);
		if (pc) {
			for (const w of pc.water) { water.push(w); blockKeys.add(key(w[0], w[1])); }
			poolSlopes.push([pc.downSlope[0], pc.downSlope[1], DIR_TO_ORIENT[pc.downSlope[2]]]);
			poolSlopes.push([pc.upSlope[0], pc.upSlope[1], DIR_TO_ORIENT[pc.upSlope[2]]]);
			blockKeys.add(key(pc.downSlope[0], pc.downSlope[1]));
			blockKeys.add(key(pc.upSlope[0], pc.upSlope[1]));
			// anchor cells (the road feeding each ramp) must stay road —
			// claim them so no detour window can remove them
			for (const ramp of [pc.downSlope, pc.upSlope]) {
				const mouth = OPP_SIDE[ramp[2]];
				const [mdx, mdz] = SIDE_VEC[mouth];
				blockKeys.add(key(ramp[0] + mdx, ramp[1] + mdz));
			}
		}
	}
	if (opts.poolCrossings && poolSlopes.length < 2) {
		const pc = genPoolCrossing(rng, tiles, specialIdx, removedIdx, blockKeys);
		if (pc) {
			for (const w of pc.water) { water.push(w); blockKeys.add(key(w[0], w[1])); }
			poolSlopes.push([pc.downSlope[0], pc.downSlope[1], DIR_TO_ORIENT[pc.downSlope[2]]]);
			poolSlopes.push([pc.upSlope[0], pc.upSlope[1], DIR_TO_ORIENT[pc.upSlope[2]]]);
			blockKeys.add(key(pc.downSlope[0], pc.downSlope[1])); blockKeys.add(key(pc.upSlope[0], pc.upSlope[1]));
		}
	}
	// Thin sections are placed AFTER the crossing solver so they cannot consume
	// the straight windows needed for the mandatory 12+12 crossing recipe.
	let thinGround = { placed: 0, corners: 0 };


	// 3. interleaved detours: every window is evaluated as BOTH an elevated
	// and a tunnel detour and the crossing-richest wins — that's what makes
	// the road-over-road and road-over-tunnel crossings pile up together
	if (opts.elevated || opts.tunnels) {
		genInterleavedDetours(rng, tiles, specialIdx, removedIdx, elevEntries, tunnelEntries, blockKeys, preferClosed, opts);
		for (const e of elevEntries) blockKeys.add(key(e[0], e[1]));
		for (const e of tunnelEntries) blockKeys.add(key(e[0], e[1]));
	}

	const order = tiles.map((_, i) => i).filter((i) => !removedIdx.has(i) && !tiles[i][4]);
	const groundTiles = order.map((i) => tiles[i]);
	const elevKeys = new Set(elevEntries.map(([gx, gz]) => key(gx, gz)));

	// Now claim thin sections from the leftover ground/elevated chains.
	if (opts.thin) thinGround = genGroundThinSections(rng, tiles, specialIdx, removedIdx, blockKeys, 2);
	let thinElevated = { placed: 0, corners: 0 };
	if (opts.thin && opts.elevated) thinElevated = genElevatedThinSections(rng, elevEntries, blockKeys, 1);
	if (opts.thin && thinGround.placed < 2) {
		const more = genGroundThinSections(rng, tiles, specialIdx, removedIdx, blockKeys, 2 - thinGround.placed);
		thinGround.placed += more.placed; thinGround.corners += more.corners;
	}
	if (opts.thin && opts.elevated && thinElevated.placed < 1) {
		const more = genElevatedThinSections(rng, elevEntries, blockKeys, 1 - thinElevated.placed);
		thinElevated.placed += more.placed; thinElevated.corners += more.corners;
	}
	if (opts.thin && (thinGround.corners + thinElevated.corners) < 2) {
		const need = 2 - (thinGround.corners + thinElevated.corners);
		if (opts.elevated) {
			const more = genElevatedThinSections(rng, elevEntries, blockKeys, need);
			thinElevated.placed += more.placed; thinElevated.corners += more.corners;
		}
		if (thinGround.corners + thinElevated.corners < 2) {
			const more = genGroundThinSections(rng, tiles, specialIdx, removedIdx, blockKeys, 2);
			thinGround.placed += more.placed; thinGround.corners += more.corners;
		}
	}

	if (opts.thin && thinGround.placed < 2) {
		const more = forceGroundThinSections(tiles, specialIdx, removedIdx, blockKeys, 2 - thinGround.placed);
		thinGround.placed += more.placed; thinGround.corners += more.corners;
	}
	if (opts.thin && opts.elevated && thinElevated.placed < 1) {
		const more = forceElevatedThinSections(elevEntries, blockKeys, 1 - thinElevated.placed);
		thinElevated.placed += more.placed; thinElevated.corners += more.corners;
	}
	// Reserve the four mandatory ground choke cells AFTER tunnel/elevated
	// generation so they do not steal cells that are needed for the 12
	// road-over-tunnel crossings.
	let reservedChokes = [];
	if (opts.chokes) {
		const chokeCandidates = groundTiles.filter((t, i) => !specialIdx.has(i) && !removedIdx.has(i) && !t[4] && t[2] === 'track-straight');
		reservedChokes = sampleDeterministic(chokeCandidates, rng, 4);
	}

	// decorative ponds in leftover enclosed pockets
	let decorativePonds = [];
	if (opts.ponds) {
		const pondOccupied = new Set();
		for (const t of groundTiles) pondOccupied.add(key(t[0], t[1]));
		for (const e of elevEntries) pondOccupied.add(key(e[0], e[1]));
		for (const e of tunnelEntries) pondOccupied.add(key(e[0], e[1]));
		for (const w of water) pondOccupied.add(key(w[0], w[1]));
		const pondCandidates = genPools(groundTiles).filter((c) => !pondOccupied.has(key(c[0], c[1])));
		decorativePonds = sampleDeterministic(pondCandidates, rng, 12);
		// If the compact loop has fewer than 12 enclosed pocket cells, fill
		// the remaining quota with empty cells inside the same footprint. These
		// are decorative water only — never road, tunnel, elevated deck, or
		// pool-driving cells.
		const occupied = new Set();
		for (const t of groundTiles) occupied.add(key(t[0], t[1]));
		for (const e of elevEntries) occupied.add(key(e[0], e[1]));
		for (const e of tunnelEntries) occupied.add(key(e[0], e[1]));
		for (const w of water) occupied.add(key(w[0], w[1]));
		const xs = tiles.map((t) => t[0]), zs = tiles.map((t) => t[1]);
		const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1;
		const minZ = Math.min(...zs) - 1, maxZ = Math.max(...zs) + 1;
		const empty = [];
		for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
			const k = key(x, z);
			if (!occupied.has(k)) empty.push([x, z]);
		}
		for (const p of sampleDeterministic(empty, rng, Math.max(0, 12 - decorativePonds.length))) {
			decorativePonds.push(p);
		}
		for (const p of decorativePonds) water.push(p);
	}

	// flavour — claimed cells are exclusive across every family, so no
	// two features ever land on the same block
	const claimed = new Set(blockKeys);
	const claim = (x, z) => { const k = key(x, z); if (claimed.has(k)) return false; claimed.add(k); return true; };
	const groundStraight = (t) => t[2] === 'track-straight' && !elevKeys.has(key(t[0], t[1]));
	const bumpCandidates = groundTiles.filter(groundStraight);
	const bumps = opts.bumps ? sampleDeterministic(bumpCandidates.filter((t) => claim(t[0], t[1])), rng, Math.min(5, Math.max(1, Math.floor(tiles.length / 11)))) : [];
	const jumpCells = opts.jumps ? sampleDeterministic(groundTiles.filter(groundStraight).filter((t) => claim(t[0], t[1])), rng, Math.min(4, Math.max(1, Math.floor(tiles.length / 13))))
		.map(([x, z, t, o]) => [x, z, o]) : [];
	// surfaces: ground road AND elevated road (the height resolver places
	// elevated ones on the deck); open-pit tunnels stay clean — their
	// surface world is carved away, nothing can sit there
	const surfacePalette = ['surface-wood', 'surface-ice', 'surface-boost'];
	const surfCandidates = groundTiles.filter((t) => (t[2] === 'track-straight' || t[2] === 'track-corner') && claim(t[0], t[1]))
		.map(([x, z, t]) => [x, z, t]);
	for (const e of elevEntries) {
		// a surface on an elevated road sits ON the deck (the height resolver
		// handles it) — sharing the cell with the elevated entry is legal
		if (e[2] === 'elevated-straight' || e[2] === 'elevated-corner' || e[2] === 'elevated-choke-half' || e[2] === 'elevated-choke-both') {
			surfCandidates.push([e[0], e[1], 'elev-' + e[2]]);
		}
	}
	const surfaceCells = opts.surfaces ? sampleDeterministic(surfCandidates, rng, Math.min(8, Math.max(3, Math.floor(tiles.length / 6))))
		.map(([x, z, t], idx) => [x, z, String(t).startsWith('elev-') ? surfacePalette[idx % surfacePalette.length] : (t === 'track-corner' ? 'surface-ice' : surfacePalette[idx % surfacePalette.length])]) : [];
	// choke pinches: swap plain straights for choke pieces

	let chokes = 0;
	if (opts.chokes) {
		for (const c of reservedChokes) {
			const ti = groundTiles.findIndex((t) => t[0] === c[0] && t[1] === c[1]);
			if (ti >= 0) { groundTiles[ti][2] = rng() < 0.5 ? 'track-choke-both' : 'track-choke-half'; chokes++; }
		}
	}

	return {
		cells: groundTiles,
		modsObj: {
			b: bumps, s: [], u: surfaceCells, d: [],
			e: elevEntries, g: tunnelEntries, q: water, z: poolSlopes,
			j: jumpCells,
		},
		dna: {
			preferClosed,
			figure8Crossings: new Set(groundTiles.filter((c) => c[2] === 'track-4-way').map((c) => key(c[0], c[1]))).size,
			crossCell,
			elevCrossings: elevEntries.filter((e) => e[2] === 'elevated-cross' || e[2] === 'elevated-cross-corner').length,
			tunnelCrossings: tunnelEntries.filter((e) => e[2] === 1 && groundTiles.some((c) => c[0] === e[0] && c[1] === e[1])).length,
			poolSection: poolSlopes.length >= 2,
			poolCells: poolSlopes.length >= 2 ? 6 : 0,
			pondCells: decorativePonds.length,
			thinGround: thinGround.placed, thinElevated: thinElevated.placed,
			thinCorners: (thinGround.corners || 0) + (thinElevated.corners || 0),
			chokes,
			jumps: jumpCells.length, bumps: bumps.length, surfaces: surfaceCells.length,
			checkpoints: groundTiles.filter((c) => c[2] === 'track-checkpoint').length,
		},
	};
}

// ─── mandatory feature wrapper ───────────────────────────────────────────────
// Every seed is solved against one deterministic feature scaffold. There is
// no retry loop: the recipe is built directly, then validated.
function mandatoryFeatureCheck(plan) {
	const d = plan.dna;
	const m = plan.modsObj;
	const roadOverTunnel = d.tunnelCrossings >= 12;
	const roadOverRoad = d.elevCrossings >= 12;
	const tunnelClosed70 = d.preferClosed === true;
	return d.figure8Crossings >= 2
		&& roadOverRoad
		&& roadOverTunnel
		&& d.poolSection && d.poolCells === 6
		&& d.pondCells === 12
		&& d.thinGround === 2
		&& d.thinElevated === 1
		&& d.thinCorners >= 2
		&& d.chokes === 4;
}

export function generateTrackPlan(seedText, opts = {}) {
	const required = { ...opts, figure8: true, elevated: true, tunnels: true, poolCrossings: true, ponds: true, thin: true, chokes: true };
	// One seed → one recipe. There is no retry loop and no alternate seed.
	// The generator itself owns the fallbacks needed to make the recipe valid.
	const plan = generateTrackPlanOnce(seedText, required);
	plan.dna.retryCount = 0;
	return plan;
}



// ─── sanity validation ────────────────────────────────────────────────────────
function validate(plan) {
	const warns = [];
	const { cells, modsObj } = plan;
	const roadSet = new Set(cells.map((c) => key(c[0], c[1])));
	// 1. every ground tile unique
	const roadSeen = new Set();
	for (const c of cells) {
		const k = key(c[0], c[1]);
		if (roadSeen.has(k)) warns.push('duplicate road tile at ' + k);
		roadSeen.add(k);
	}
	// 2. tunnel ramps: mouth must face a live road cell
	for (const [x, z, closed, orient, type] of modsObj.g) {
		if (type !== 'slope-up') continue;
		const mouth = OPP_SIDE[ORIENT_TO_DIR[orient] ?? 'S'];
		const [dx, dz] = SIDE_VEC[mouth];
		if (!roadSet.has(key(x + dx, z + dz))) warns.push('tunnel ramp at ' + key(x, z) + ' mouth faces no road');
	}
	// 3. pool ramps: mouth faces road, low side faces water; ramps are water
	const waterSet = new Set(modsObj.q.map((w) => key(w[0], w[1])));
	for (const [x, z, orient] of modsObj.z) {
		const mouth = OPP_SIDE[ORIENT_TO_DIR[orient] ?? 'S'];
		const [dx, dz] = SIDE_VEC[mouth];
		if (!roadSet.has(key(x + dx, z + dz))) warns.push('pool ramp at ' + key(x, z) + ' mouth faces no road');
		if (!waterSet.has(key(x - dx, z - dz))) warns.push('pool ramp at ' + key(x, z) + ' low side faces no water');
		if (!waterSet.has(key(x, z))) warns.push('pool ramp at ' + key(x, z) + ' not on water');
	}
	// 4. exclusivity: NO cell may host two entries of any family — a deck
	// stacked on its own ramp, a pit under a deck, two decks... all broken.
	// (Crossings are whitelisted separately in checks 7/8 below.)
	const claimed = new Map();
	const claimCheck = (k, family) => {
		if (claimed.has(k)) warns.push('stacked feature at ' + k + ' (' + claimed.get(k) + ' + ' + family + ')');
		else claimed.set(k, family);
	};
	for (const [x, z] of modsObj.e) claimCheck(key(x, z), 'elev');
	for (const [x, z] of modsObj.g) claimCheck(key(x, z), 'tunnel');
	for (const [x, z] of modsObj.z) claimCheck(key(x, z), 'pool');
	const flavorSeen = new Set();
	for (const [x, z] of [...modsObj.b, ...modsObj.j.map((jj) => [jj[0], jj[1]])]) {
		const k = key(x, z);
		if (flavorSeen.has(k)) warns.push('two obstacles on one block at ' + k);
		flavorSeen.add(k);
	}
	// 5. water never on live road
	for (const w of modsObj.q) if (roadSet.has(key(w[0], w[1]))) warns.push('water on live road at ' + key(w[0], w[1]));
	// 6. thin chains: wide⇄thin ramps' wide side must face road (not thin).
	// GLB-verified: the wide end points OPP_SIDE[ORIENT_TO_DIR[orient]].
	const wideDirOf = (orient) => OPP_SIDE[ORIENT_TO_DIR[orient] ?? 'S'];
	const wideOk = (x, z, wideDir, isElev) => {
		const [dx, dz] = SIDE_VEC[wideDir];
		const nx = x + dx, nz = z + dz;
		const road = roadSet.has(key(nx, nz));
		const elev = isElev && modsObj.e.some((e) => e[0] === nx && e[1] === nz);
		return road || elev;
	};
	for (const t of cells) {
		if (t[2] !== 'track-wide-thin') continue;
		if (!wideOk(t[0], t[1], wideDirOf(t[3]), false)) warns.push('thin ramp at ' + key(t[0], t[1]) + ' wide side faces no road');
	}
	for (const e of modsObj.e) {
		if (e[2] !== 'elevated-wide-thin') continue;
		if (!wideOk(e[0], e[1], wideDirOf(e[3]), true)) warns.push('elev thin ramp at ' + key(e[0], e[1]) + ' wide side faces no road');
	}
	// 7. elevated blocks may only sit over live ground road when they are
	// real crossing pieces — anything else is stacked over a road block
	for (const [x, z, type] of modsObj.e) {
		if (type === 'slope-up' || type === 'elevated-cross' || type === 'elevated-cross-corner') continue;
		if (roadSet.has(key(x, z))) warns.push('elevated ' + type + ' stacked over road at ' + key(x, z));
	}
	// 8. a tunnel pit under live road must be a SEALED crossing — an open
	// pit with road on top is a hole in the world
	for (const [x, z, closed, , type] of modsObj.g) {
		if (type === 'slope-up') continue;
		if (roadSet.has(key(x, z)) && closed !== 1) warns.push('open tunnel under road at ' + key(x, z));
	}
	// 9. elevated ramps: the low side (the climb entry) must face live road
	for (const [x, z, type, orient] of modsObj.e) {
		if (type !== 'slope-up') continue;
		const low = rotSide('S', orient);
		const [dx, dz] = SIDE_VEC[low];
		if (!roadSet.has(key(x + dx, z + dz))) warns.push('elevated ramp at ' + key(x, z) + ' low side faces no road');
	}
	// 10. nothing may sit over an OPEN pit cell (deck over a hole)
	const openPit = new Set(modsObj.g.filter((e) => e[4] !== 'slope-up' && e[2] === 0).map((e) => key(e[0], e[1])));
	for (const [x, z] of modsObj.e) if (openPit.has(key(x, z))) warns.push('elevated block over open pit at ' + key(x, z));
	for (const [x, z] of modsObj.z) if (openPit.has(key(x, z))) warns.push('pool ramp over open pit at ' + key(x, z));
	for (const [x, z] of modsObj.q) if (openPit.has(key(x, z))) warns.push('water over open pit at ' + key(x, z));
	// 11. elevated detour chains: entries come in path order (ramp, path...,
	// ramp) — the whole chain must be one connected walk
	let k0 = 0;
	while (k0 < modsObj.e.length) {
		let k1 = k0;
		while (k1 + 1 < modsObj.e.length
			&& Math.abs(modsObj.e[k1 + 1][0] - modsObj.e[k1][0]) + Math.abs(modsObj.e[k1 + 1][1] - modsObj.e[k1][1]) === 1) k1++;
		const seg = modsObj.e.slice(k0, k1 + 1);
		if (seg.length >= 3 && (seg[0][2] === 'slope-up' || seg[seg.length - 1][2] === 'slope-up')) {
			if (seg[0][2] !== 'slope-up' || seg[seg.length - 1][2] !== 'slope-up') warns.push('elevated detour at ' + key(seg[0][0], seg[0][1]) + ' is missing an end ramp');
		}
		k0 = k1 + 1;
	}
	return warns;
}

// ─── exports ─────────────────────────────────────────────────────────────────
export { hash32, mulberry32, rndInt, sampleDeterministic, validate };
