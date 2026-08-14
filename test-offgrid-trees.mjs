// Tests the off-grid tree-blocking footprint math used by buildTrack's
// blockCellForTrees helper. Run with: node test-offgrid-trees.mjs
//
// A track cell at (gx, gz) covers [gx, gx+1] x [gz, gz+1] (cell units).
// An integer decoration cell (cx, cz) covers [cx, cx+1] x [cz, cz+1].
// A tree at integer cell c is "under the road" when the footprints overlap
// with non-zero area, i.e. floor(gx) <= c <= ceil(gx) on each axis.

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const aok = JSON.stringify(actual) === JSON.stringify(expected);
  if (aok) { pass++; }
  else { fail++; console.error(`FAIL: ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// Replicate the (fixed) blockCellForTrees blocking range exactly.
function blockedCells(gx, gz) {
  const cells = [];
  const minBlockX = Math.floor(gx);
  const maxBlockX = Math.ceil(gx);
  const minBlockZ = Math.floor(gz);
  const maxBlockZ = Math.ceil(gz);
  for (let bx = minBlockX; bx <= maxBlockX; bx++) {
    for (let bz = minBlockZ; bz <= maxBlockZ; bz++) {
      cells.push([bx, bz]);
    }
  }
  return cells;
}

// Reference: ALL integer cells whose footprint [c, c+1] overlaps [gx, gx+1].
function overlapCells(gx, gz) {
  const cells = [];
  for (let cx = Math.floor(gx); cx <= Math.ceil(gx + 1); cx++) {
    for (let cz = Math.floor(gz); cz <= Math.ceil(gz + 1); cz++) {
      const overlapX = cx < gx + 1 && cx + 1 > gx;
      const overlapZ = cz < gz + 1 && cz + 1 > gz;
      if (overlapX && overlapZ) cells.push([cx, cz]);
    }
  }
  return cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// On-grid integer cells: exactly one cell (itself), both axes.
eq('on-grid (2,3)', blockedCells(2, 3), [[2, 3]]);
eq('on-grid (0,0)', blockedCells(0, 0), [[0, 0]]);
eq('on-grid (-1,-2)', blockedCells(-1, -2), [[-1, -2]]);

// Off-grid 0.25 step: piece straddles a seam → both neighbouring cells blocked.
eq('offgrid (1.25, 2.25)', blockedCells(1.25, 2.25).sort((a,b)=>a[0]-b[0]||a[1]-b[1]), [[1,2],[1,3],[2,2],[2,3]]);
eq('offgrid (1.25, 2.0) X-only', blockedCells(1.25, 2.0).sort((a,b)=>a[0]-b[0]||a[1]-b[1]), [[1,2],[2,2]]);
eq('offgrid (1.0, 2.75) Z-only', blockedCells(1.0, 2.75).sort((a,b)=>a[0]-b[0]||a[1]-b[1]), [[1,2],[1,3]]);

// Seam at N+0.5: both cells (was already handled by old code).
eq('seam (1.5, 2.5)', blockedCells(1.5, 2.5).sort((a,b)=>a[0]-b[0]||a[1]-b[1]), [[1,2],[1,3],[2,2],[2,3]]);

// Cross-check: blockedCells must match the brute-force footprint-overlap set
// for a sweep of off-grid coordinates (the real bug — old code missed the
// far-side cell, so trees poked through off-grid roads).
let mismatch = 0;
for (let gx = -2; gx <= 3; gx += 0.25) {
  for (let gz = -2; gz <= 3; gz += 0.25) {
    const got = blockedCells(gx, gz).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const want = overlapCells(gx, gz);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatch++;
      if (mismatch <= 5) console.error(`MISMATCH at (${gx},${gz}): got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
}
eq('footprint-overlap matches for full 0.25 sweep', mismatch, 0);

// Regression guard: the OLD center-based math (ceil(gx-0.5)..floor(gx+0.5))
// is what we replaced — verify it would have UNDER-blocked for off-grid cells,
// proving this is the fix (not a no-op).
function oldBlocked(gx, gz) {
  const cells = [];
  const minBlockX = Math.ceil(gx - 0.5);
  const maxBlockX = Math.floor(gx + 0.5);
  const minBlockZ = Math.ceil(gz - 0.5);
  const maxBlockZ = Math.floor(gz + 0.5);
  for (let bx = minBlockX; bx <= maxBlockX; bx++)
    for (let bz = minBlockZ; bz <= maxBlockZ; bz++)
      cells.push([bx, bz]);
  return cells;
}
// Old math blocked only 1 cell for (1.25,2.25); the road spans into cell 2.
eq('old math under-blocked X (1.25)', oldBlocked(1.25, 2.0).length, 1);
eq('new math blocks both X cells (1.25)', blockedCells(1.25, 2.0).length, 2);
eq('old math under-blocked full (1.25,2.25)', oldBlocked(1.25, 2.25).length, 1);
eq('new math blocks all 4 cells (1.25,2.25)', blockedCells(1.25, 2.25).length, 4);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
