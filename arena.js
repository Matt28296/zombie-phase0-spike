// arena.js — Gate Town arena data for the zombie Survival server.
// ---------------------------------------------------------------------------
// ASSUMED GEOMETRY — MUST BE VERIFIED AGAINST THE REAL GATE TOWN REGION.
// Everything below is derived from the design spec §2.3 (plaza, houses, market
// stall, gatehouse, walls) and the 60x60 world grid — NOT from a measured
// read of the live Gate Town tiles. A separate arena-audit job must verify /
// refine: the exact wall line, house footprints, gate positions, spawn points
// and the extraction point against the real region before live play.
// Until that audit lands, treat every coordinate here as a placeholder that
// is internally consistent (bounds hold, gates sit outside the boundary,
// spawns are spread apart) but not as ground truth about Gate Town.
// ---------------------------------------------------------------------------
'use strict';

const SIZE = 60; // 60x60 tile grid, coords 0..60 (continuous), tiles 0..59

// Playable bounds (continuous coords). Players and zombies are clamped here;
// zombie spawn gates sit OUTSIDE this rectangle.
const BOUNDS = { minX: 2, minY: 2, maxX: 58, maxY: 58 };

// Blocked rectangles (houses / stalls / gatehouse walls) in tile coords.
// Format: {x, y, w, h, name}. Flow field treats these tiles as impassable;
// movement collision clamps players/zombies out of them (circle-vs-rect).
// ASSUMED — verify against real Gate Town geometry.
const BLOCKERS = [
  { x: 8,  y: 8,  w: 6, h: 5, name: 'house-nw' },
  { x: 46, y: 8,  w: 6, h: 5, name: 'house-ne' },
  { x: 8,  y: 47, w: 6, h: 5, name: 'house-sw' },
  { x: 46, y: 47, w: 6, h: 5, name: 'house-se' },
  { x: 14, y: 26, w: 5, h: 4, name: 'market-stall' },
  { x: 41, y: 26, w: 5, h: 4, name: 'market-stall-2' },
  { x: 27, y: 4,  w: 6, h: 3, name: 'gatehouse' },
  { x: 27, y: 53, w: 6, h: 3, name: 'south-wall-house' },
];

// Zombie spawn gates — outside the playable boundary, one per side.
// ASSUMED positions; audit must confirm real gate openings in the wall line.
const GATES = [
  { id: 'gate-north', x: 30, y: 0.5, dir: 'south' },
  { id: 'gate-south', x: 30, y: 59.5, dir: 'north' },
  { id: 'gate-west',  x: 0.5, y: 30, dir: 'east' },
  { id: 'gate-east',  x: 59.5, y: 30, dir: 'west' },
];

// Player drop-in points, spread apart around the central plaza.
// ASSUMED — audit must confirm they are not inside a house or wall.
const PLAYER_SPAWNS = [
  { x: 30, y: 30 }, { x: 24, y: 30 }, { x: 36, y: 30 }, { x: 30, y: 24 },
  { x: 30, y: 36 }, { x: 24, y: 24 }, { x: 36, y: 36 }, { x: 24, y: 36 },
];

// Barricade chokepoints (surveyed only — placement itself is Phase 2).
// Each sits on a real route into the plaza. ASSUMED — verify reachability.
const BARRICADE_POINTS = [
  { id: 'bp-north', x: 30, y: 10 },
  { id: 'bp-south', x: 30, y: 50 },
  { id: 'bp-west',  x: 10, y: 30 },
  { id: 'bp-east',  x: 50, y: 30 },
  { id: 'bp-plaza-nw', x: 20, y: 20 },
  { id: 'bp-plaza-se', x: 40, y: 40 },
];

// Loot crate positions (scavenge loop). ASSUMED — verify against real props.
const LOOT_CRATES = [
  { id: 'crate-1', x: 20, y: 20 }, { id: 'crate-2', x: 40, y: 20 },
  { id: 'crate-3', x: 20, y: 40 }, { id: 'crate-4', x: 40, y: 40 },
  { id: 'crate-5', x: 30, y: 14 }, { id: 'crate-6', x: 14, y: 30 },
];

// Extraction point — opens after wave 5. At the gatehouse (north).
// ASSUMED — audit must confirm the gatehouse is a sensible extraction site.
const EXTRACTION_POINT = { x: 30, y: 9 }; // just south of the gatehouse (not inside it)

const MIN_SPAWN_DISTANCE = 12; // zombies never spawn within this of a player

function tileBlocked(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return true;
  for (const b of BLOCKERS) {
    if (tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) return true;
  }
  return false;
}

// Circle-vs-blocker collision: push a point (x,y,r) out of blocked rects.
function resolveCollision(x, y, r) {
  for (const b of BLOCKERS) {
    const cx = Math.max(b.x, Math.min(x, b.x + b.w));
    const cy = Math.max(b.y, Math.min(y, b.y + b.h));
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) {
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r; y = cy + (dy / d) * r;
      } else {
        // Centre exactly on an edge/corner: push out along the CLOSEST
        // edge (min penetration). Ties break toward the south/north edges
        // first, so a zombie walking east along a south edge is pushed
        // south (clear of the wall) instead of back west forever.
        const pl = x - b.x, pr = b.x + b.w - x, pt = y - b.y, pb = b.y + b.h - y;
        const m = Math.min(pl, pr, pt, pb);
        if (m === pb) y = b.y + b.h + r;
        else if (m === pt) y = b.y - r;
        else if (m === pl) x = b.x - r;
        else x = b.x + b.w + r;
      }
    }
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
  SIZE, BOUNDS, BLOCKERS, GATES, PLAYER_SPAWNS, BARRICADE_POINTS,
  LOOT_CRATES, EXTRACTION_POINT, MIN_SPAWN_DISTANCE,
  tileBlocked, resolveCollision, hasLineOfSight,
  ASSUMED_GEOMETRY: true,
  ASSUMED_NOTE: 'All geometry in this module is ASSUMED from design spec §2.3 and must be verified against the real Gate Town region by the arena-audit job.',
};
