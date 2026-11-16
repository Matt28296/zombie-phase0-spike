// arena.js — Gate Town arena data for the zombie Survival server.
// ---------------------------------------------------------------------------
// VERIFIED GEOMETRY — merged 2026-11-16 from the arena audit (Job 1.3).
// Source of truth: hidden_files/arena-definition.json (audit of the live
// Gate Town region in artifact soft-yeti-mmorpg, index.html, 23,586 lines).
// Verification: hidden_files/arena-verify.js — 227 checks, 227 passed
// (against the ORIGINAL south-half geometry; see note below).
// Coordinate system: 60x60 tile grid; 1 tile = 1 unit; continuous coords
// 0..60, tile (tx,ty) spans [tx,tx+1) x [ty,ty+1); tile centre = (tx+0.5,
// ty+0.5). (Old-game wpos(x,z) = (x-30+0.5, z-30+0.5) is a centred frame;
// the server uses tile-index space directly.)
//
// EXPANSION 2026-11-16 (map-expansion job): the playable arena is now the
// FULL Gate Town — bounds rect tiles x 0..29, z 0..29 (continuous x 0..30,
// y 0..30). The north strip (z 0..13: sand corner, farm patch) was zombie
// staging in the old geometry and is now playable; the audit DID survey
// it (no blocked tiles there except the wall rows), so the terrain data
// is still audit-sourced. The one design change vs the audit: the two
// wall rows z=10/z=13 (x=11,12,15,16) are REMOVED from the blocked set.
// They were the old north boundary; keeping them would split the town
// into two pockets joined by a single 2-wide gap, funnelling all
// north/south movement through one chokepoint and breaking the spread
// spawn/loot design. The old gate-gap barricade point stays, renamed
// "Plaza north entry" — it is now the plaza's north approach, not a seal.
// Pond (81) and rock corner (64) STAY blocked: visible terrain, water
// blocked per the old isBlocked rule, rock per the audit's direction.
// arena-verify.js still encodes the OLD south-half geometry (bounds,
// 153 blocked, wall rows) and needs a re-audit for the new geometry;
// the new geometry is instead covered by test-phase1.js (bounds,
// blocked count, gate/spawn separation, BFS connectivity from every
// gate to every spawn/crate/extraction) and the reach test.
// ---------------------------------------------------------------------------
'use strict';

const SIZE = 60; // 60x60 tile grid, coords 0..60 (continuous), tiles 0..59

// Playable bounds for PLAYERS (continuous coords). Full Gate Town:
// x 0..30, y 0..30. The old north boundary (y=14) is gone.
const BOUNDS = { minX: 0, minY: 0, maxX: 30, maxY: 30 };

// Zombies are NOT rect-bounded: they use the full 60x60 grid minus the
// blocked set and enter via the four spawn gates (some outside the rect).
const ZOMBIE_BOUNDS = { minX: 0, minY: 0, maxX: SIZE, maxY: SIZE };

// ---- Blocked tiles (145) — built from the audited regions ----
// Pond (water): x<=8 and z>=21: 9 x 9 = 81 tiles.
// Rock corner: x>=22 and z>=22: 8 x 8 = 64 tiles.
// Total 81 + 64 = 145. (Water is blocked per the old isBlocked rule;
// rock is blocked per the audit's task direction — see header note.
// The old wall rows z=10/z=13 were REMOVED in the 2026-11-16 expansion:
// they were the north boundary, and the town is now fully open.)
function buildBlockedSet() {
  const s = new Set();
  const add = (tx, ty) => s.add(`${tx},${ty}`);
  for (let tx = 0; tx <= 8; tx++) for (let ty = 21; ty <= 29; ty++) add(tx, ty);
  for (let tx = 22; tx <= 29; tx++) for (let ty = 22; ty <= 29; ty++) add(tx, ty);
  return s;
}
const BLOCKED_TILES = buildBlockedSet();
const BLOCKED_COUNT = BLOCKED_TILES.size; // 145 — asserted by test-phase1.js

// Precomputed blocked lookup: BLOCKED_GRID[ty*SIZE+tx] === 1 when blocked.
// The flow-field BFS reads blocked-ness ~29k times per recompute; the
// Set+string form (tileBlocked) allocates a template string per call and
// was the single biggest per-BFS cost on the expanded 60x60 grid.
// tileBlocked() stays the public API (collision / line-of-sight); this
// grid is the hot-path form. Built once at load — the blocked set never
// changes at runtime.
const BLOCKED_GRID = (() => {
  const g = new Uint8Array(SIZE * SIZE);
  for (const k of BLOCKED_TILES) {
    const sep = k.indexOf(',');
    g[Number(k.slice(sep + 1)) * SIZE + Number(k.slice(0, sep))] = 1;
  }
  return g;
})();

// Zombie spawn gates — all four now sit on the town's PERIMETER (the
// old main gate at y=12.5 was inside the expanded town and had to move).
// Wave 1 uses gates[0] only, wave 2 the first two, wave 3+ all four
// (server.js slices by waveDef().gates). Main gate has two spawn tiles
// (2-wide, on the north boundary). West gate sits ON the west boundary
// (x=0.5) — the stated exception to "gates sit outside the bounds";
// the main gate is the same pattern on the north edge (y=0.5), which
// keeps spawn coords on-grid: a y<0 gate would hand the flow-field
// lookup a negative tile row. East/south gates sit just outside.
// Zombie staging is gone as a place: zombies spawn AT these gates and
// walk in — the flow field (full 60x60 BFS) routes them to players
// anywhere in the town, verified by the connectivity check in
// test-phase1.js.
const GATES = [
  {
    id: 'gate-main', name: 'Main gate (north edge)',
    x: 14, y: 0.5, dir: 'south', onBoundary: true,
    tiles: [{ x: 13.5, y: 0.5 }, { x: 14.5, y: 0.5 }],
  },
  { id: 'gate-west', name: 'West gate (world edge)', x: 0.5, y: 18.5, dir: 'east', onBoundary: true },
  { id: 'gate-east', name: 'East gate (desert edge)', x: 30.5, y: 20.5, dir: 'west' },
  { id: 'gate-south', name: 'South gate (coast edge)', x: 20.5, y: 30.5, dir: 'north' },
];

// Player drop-in points (tile centres), spread across the FULL town —
// one per quadrant plus plaza and south. Min pairwise distance 7.81
// tiles (was 3.16, plaza-clustered); every spawn is >= 6 tiles from
// every gate tile (closest actual pair 6.08 — spawn-5 -> south gate).
// spawn-1 is the old-game spawn tile (15,19).
const PLAYER_SPAWNS = [
  { id: 'spawn-1', x: 15.5, y: 19.5 },
  { id: 'spawn-2', x: 7.5, y: 7.5 },
  { id: 'spawn-3', x: 24.5, y: 6.5 },
  { id: 'spawn-4', x: 6.5, y: 15.5 },
  { id: 'spawn-5', x: 21.5, y: 24.5 },
  { id: 'spawn-6', x: 12.5, y: 27.5 },
];

// Barricade chokepoints (surveyed only — placement itself is Phase 2).
// Honest finding (arena-audit.md §6): only the gate gap sealed a route
// (main-gate -> plaza 6 tiles open, 10 barricaded). The plaza-entry
// points are single tiles in open ground: delay/cover, not seals.
// barricade-1 MUST stay first in this array at (14, 13.5):
// fortifyBarricade() takes the FIRST point within 3 tiles, and
// test-phase2.js expects an Engineer at (14, 15.5) to get barricade-1.
// New in the expansion: barricade-5 guards the north-gate approach,
// barricade-6/7 guard the north half's southward lanes.
const BARRICADE_POINTS = [
  {
    id: 'barricade-1', name: 'Plaza north entry', x: 14, y: 13.5,
    tiles: [{ x: 13.5, y: 13.5 }, { x: 14.5, y: 13.5 }],
    designatedGate: 'gate-main',
  },
  { id: 'barricade-2', name: 'Plaza west entry', x: 12.5, y: 16.5, tiles: [{ x: 12.5, y: 16.5 }], designatedGate: 'gate-west' },
  { id: 'barricade-3', name: 'Plaza east entry', x: 18.5, y: 16.5, tiles: [{ x: 18.5, y: 16.5 }], designatedGate: 'gate-east' },
  { id: 'barricade-4', name: 'Plaza south entry', x: 15.5, y: 20.5, tiles: [{ x: 15.5, y: 20.5 }], designatedGate: 'gate-south' },
  { id: 'barricade-5', name: 'North gate approach', x: 14.5, y: 2.5, tiles: [{ x: 14.5, y: 2.5 }], designatedGate: 'gate-main' },
  { id: 'barricade-6', name: 'Northwest lane', x: 8.5, y: 12.5, tiles: [{ x: 8.5, y: 12.5 }], designatedGate: 'gate-west' },
  { id: 'barricade-7', name: 'Northeast lane', x: 22.5, y: 11.5, tiles: [{ x: 22.5, y: 11.5 }], designatedGate: 'gate-east' },
];

// Loot crate positions (scavenge loop) — spread so the loop pulls players
// off the plaza in every direction, now including the north half
// (crate-11..14). All on walkable in-bounds tiles.
const LOOT_CRATES = [
  { id: 'crate-1', x: 11.5, y: 17.5, zone: 'plaza-west' },
  { id: 'crate-2', x: 19.5, y: 16.5, zone: 'plaza-east' },
  { id: 'crate-3', x: 14.5, y: 22.5, zone: 'south-center' },
  { id: 'crate-4', x: 9.5, y: 19.5, zone: 'west / pond edge' },
  { id: 'crate-5', x: 21.5, y: 19.5, zone: 'east-center' },
  { id: 'crate-6', x: 12.5, y: 25.5, zone: 'southwest' },
  { id: 'crate-7', x: 19.5, y: 26.5, zone: 'southeast' },
  { id: 'crate-8', x: 24.5, y: 17.5, zone: 'far east' },
  { id: 'crate-9', x: 6.5, y: 16.5, zone: 'far west' },
  { id: 'crate-10', x: 16.5, y: 28.5, zone: 'far south' },
  { id: 'crate-11', x: 7.5, y: 5.5, zone: 'northwest' },
  { id: 'crate-12', x: 22.5, y: 8.5, zone: 'northeast' },
  { id: 'crate-13', x: 14.5, y: 4.5, zone: 'north gate approach' },
  { id: 'crate-14', x: 26.5, y: 12.5, zone: 'far east north' },
];

// Extraction point — opens after wave 5. KEPT south at the coast edge:
// it is now the far end of a full-town run (up to ~30 tiles from the
// north half), which is the point — extraction is a run, not a camp.
// Inert before wave 5 (no interaction, no lit marker).
const EXTRACTION_POINT = { x: 15.5, y: 28.5, tile: [15, 28], opensAfterWave: 5, name: 'South extraction' };

// Minimum zombie spawn distance from any player spawn (audit §4: 6 tiles
// Euclidean; closest actual pair 6.08 — main gate -> spawn-2).
const MIN_SPAWN_DISTANCE = 6;

function tileBlocked(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return true;
  return BLOCKED_TILES.has(`${tx},${ty}`);
}

// Circle-vs-blocked-tile collision: push a point (x,y,r) out of blocked
// tiles. Two passes so corners resolve. Centre exactly on a tile edge or
// corner (or inside a tile): push out along the CLOSEST edge (min
// penetration). Ties break toward the south edge first, so a zombie
// walking east along a south edge is pushed south (clear of the wall)
// instead of back west forever (the wall-slide fix from Phase 1).
function resolveCollision(x, y, r) {
  for (let pass = 0; pass < 2; pass++) {
    let pushed = false;
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!tileBlocked(tx, ty)) continue;
        const cx = Math.max(tx, Math.min(x, tx + 1));
        const cy = Math.max(ty, Math.min(y, ty + 1));
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          x = cx + (dx / d) * r; y = cy + (dy / d) * r;
        } else {
          const pl = x - tx, pr = tx + 1 - x, pt = y - ty, pb = ty + 1 - y;
          const m = Math.min(pl, pr, pt, pb);
          if (m === pb) y = ty + 1 + r;
          else if (m === pt) y = ty - r;
          else if (m === pl) x = tx - r;
          else x = tx + 1 + r;
        }
        pushed = true;
      }
    }
    if (!pushed) break;
  }
  return { x, y };
}

// Straight-line line-of-sight on the tile grid (Bresenham). No through-wall
// attacks: a zombie may not hit a player it cannot see.
function hasLineOfSight(x0, y0, x1, y1) {
  let tx0 = Math.floor(x0), ty0 = Math.floor(y0);
  const tx1 = Math.floor(x1), ty1 = Math.floor(y1);
  const dx = Math.abs(tx1 - tx0), dy = Math.abs(ty1 - ty0);
  const sx = tx0 < tx1 ? 1 : -1, sy = ty0 < ty1 ? 1 : -1;
  let err = dx - dy;
  for (let i = 0; i < 200; i++) {
    if (tileBlocked(tx0, ty0)) return false;
    if (tx0 === tx1 && ty0 === ty1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; tx0 += sx; }
    if (e2 < dx) { err += dx; ty0 += sy; }
  }
  return true;
}

module.exports = {
  SIZE, BOUNDS, ZOMBIE_BOUNDS, BLOCKED_TILES, BLOCKED_COUNT, BLOCKED_GRID,
  GATES, PLAYER_SPAWNS, BARRICADE_POINTS,
  LOOT_CRATES, EXTRACTION_POINT, MIN_SPAWN_DISTANCE,
  tileBlocked, resolveCollision, hasLineOfSight,
  ASSUMED_GEOMETRY: false,
  VERIFIED_GEOMETRY: true,
  VERIFIED_NOTE: 'Geometry verified 2026-11-16 by the arena audit (Job 1.3) against the live Gate Town region; see arena-definition.json + arena-audit.md. 227/227 arena-verify.js checks pass against the ORIGINAL south-half geometry. 2026-11-16 expansion to the full town (bounds y 0..30, wall rows removed, gates/spawns/crates extended north) is a design change on audit-surveyed terrain, validated by test-phase1.js connectivity + reach tests; arena-verify.js needs a re-audit for the new geometry.',
};
