// Phase 3 tests — Battle Royale server logic (Jobs 3.1–3.4: mode select +
// drop-in, tiered loot, shrinking zone, zone-paced director, last-standing
// win detection, BR end screen, disconnects in BR, Survival regression).
// Mix of direct Session unit tests (fast-forwarded ticks) and a live
// WebSocket smoke test for the create-with-mode path (server on PORT 3003).
// Usage: node test-phase3.js
// Exits 0 on PASS, 1 on FAIL. Prints exact run/passed/failed counts.
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const {
  Session, WEAPONS, ZOMBIE_TYPES, ROLES, waveDef, waveCount,
  BR_ZONE_SCHEDULE, BR_ZONE_TOTAL_MS, BR_ZONE_PHASES, BR_ZONE_CENTRE,
  computeNextZone, BR_DROP_POINTS, BR_MIN_SPAWN_DIST,
  BR_GROUND_LOOT, BR_CRATE_TIER, crateWeaponChance, BR_DIRECTOR,
  arena, TICK_MS,
} = require('./server');

const PORT = 3003;
let run = 0, passed = 0;
const failures = [];
function check(name, ok, detail) {
  run++;
  if (ok) passed++;
  else failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function tickN(s, n) { for (let i = 0; i < n; i++) s.tick(); }
function addFake(s) { return s.addPlayer(null).player; }
function noGrace(...ps) { for (const p of ps) p.graceEndsAt = 0; }
// God-mode player: zombie-proof (dodge i-frames forever) with a huge HP
// pool, so zone-progression runs are not cut short by the horde. Zone
// damage still applies (it does not check invuln), so DPS tests set hp
// explicitly after calling god().
function god(p) { p.invulnUntil = Infinity; p.hp = 100000; p.maxHp = 100000; return p; }
function brSession(n = 2, godMode = true) {
  const s = new Session('BR-' + Math.random().toString(36).slice(2, 8), { mode: 'battle-royale' });
  const ps = [];
  for (let i = 0; i < n; i++) { const p = addFake(s); if (godMode) god(p); ps.push(p); }
  return { s, ps };
}
function zombieNear(s, type, x, y) {
  const z = { id: `t${Math.random()}`, type, elite: null, x, y, hp: ZOMBIE_TYPES[type].hp, maxHp: ZOMBIE_TYPES[type].hp,
    speed: ZOMBIE_TYPES[type].speed, damage: ZOMBIE_TYPES[type].damage, state: 'chase',
    windupUntil: 0, attackTarget: null, screamUntil: 0, screamed: false, spitCdUntil: 0,
    zigPhase: 0, lastHitTick: -1, history: [], cullTick: 0, version: 0, look: 0 };
  s.zombies.set(z.id, z);
  return z;
}
// Place a zombie next to a player with a clear line of sight. The BR drop
// point is shuffled, and br-7 (21.5, 22.5) has a WALL on its +x side — the
// old blind `p.x + 1` placement put the zombie inside a blocked tile, and
// zombieAttack correctly refuses a through-wall hit (LOS fails on the
// zombie's own tile). With the BR-groggy 2.1 s windup only one attack
// attempt fits in the 60-tick window, so that drop flaked ~1 run in 8.
// Returns null when no orthogonal neighbour has LOS (loud setup failure,
// never a silent pass).
function zombieNearLOS(s, type, p) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = p.x + dx, y = p.y + dy;
    if (!arena.tileBlocked(Math.floor(x), Math.floor(y)) && arena.hasLineOfSight(x, y, p.x, p.y))
      return zombieNear(s, type, x, y);
  }
  return null;
}
function aimAt(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
}
function shootOnce(s, shooter, target) {
  shooter.lastShotMs = -9999;
  shooter.mag[shooter.currentWeapon] = 12;
  return s.shootAt(shooter, aimAt(shooter, target), s.nowMs);
}
function hasEvent(p, type) { return (p.events || []).some(e => e.type === type); }
function drainEvents(p, type) {
  const evs = (p.events || []).filter(e => !type || e.type === type);
  if (type) p.events = (p.events || []).filter(e => e.type !== type);
  else p.events = [];
  return evs;
}
function dist2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// ---------------- Unit tests ----------------
function unitTests() {
  console.log('\n--- unit: mode select (Job 3.1) ---');
  check('BR session: mode is battle-royale', new Session('M1', { mode: 'battle-royale' }).mode === 'battle-royale');
  check('default session mode is survival', new Session('M2').mode === 'survival');
  check('invalid mode falls back to survival', new Session('M3', { mode: 'mega-br' }).mode === 'survival');
  check('BR mode shows in snapshot', (() => {
    const { s, ps } = brSession(1);
    const snap = s.snapshotFor(ps[0]);
    return snap.mode === 'battle-royale' && snap.zone && snap.zone.phase === 0;
  })());
  check('Survival snapshot has no zone (null)', (() => {
    const s = new Session('M4'); const p = addFake(s);
    const snap = s.snapshotFor(p);
    return snap.mode === 'survival' && snap.zone === null;
  })());
  check('mode never switches mid-game (still BR after 100 ticks + actions)', (() => {
    const { s, ps } = brSession(2);
    s.setRole(ps[0], 'scout'); s.useAbility(ps[0]);
    tickN(s, 100);
    return s.mode === 'battle-royale' && s.phase === 'br';
  })());
  check('BR player cap is 8 (9th join rejected)', (() => {
    const s = new Session('M5', { mode: 'battle-royale' });
    for (let i = 0; i < 8; i++) addFake(s);
    return s.addPlayer(null).error === 'session full';
  })());

  console.log('\n--- unit: BR drop-in (Job 3.1) ---');
  check('8 BR players spawn pairwise >= 5 tiles apart', (() => {
    const { ps } = brSession(8);
    let min = Infinity;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) min = Math.min(min, dist2(ps[i], ps[j]));
    return min >= BR_MIN_SPAWN_DIST;
  })(), `min pairwise ${(() => { const { ps } = brSession(8); let m = Infinity; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) m = Math.min(m, dist2(ps[i], ps[j])); return m.toFixed(2); })()}`);
  check('all BR drop points in-bounds (x 0..30, y 0..30)', BR_DROP_POINTS.every(p => p.x >= 0 && p.x <= 30 && p.y >= 0 && p.y <= 30));
  check('all BR drop points on walkable tiles', BR_DROP_POINTS.every(p => !arena.tileBlocked(Math.floor(p.x), Math.floor(p.y))));
  check('BR drop-in is melee-only (no gun, no ammo)', (() => {
    const { ps } = brSession(2);
    return ps.every(p => p.weapons.length === 1 && p.weapons[0] === 'melee' && p.currentWeapon === 'melee' &&
      Object.values(p.ammo).every(v => v === 0));
  })());
  check('BR role pick keeps melee-only (Heavy gets no shotgun)', (() => {
    const { s, ps } = brSession(1);
    s.setRole(ps[0], 'heavy');
    return ps[0].weapons.length === 1 && ps[0].weapons[0] === 'melee' && ps[0].currentWeapon === 'melee';
  })());
  check('BR role passive still applies (Heavy +25 max HP = 125)', (() => {
    const { s, ps } = brSession(1);
    s.setRole(ps[0], 'heavy');
    return ps[0].maxHp === 125;
  })());
  check('BR role ability still fires from drop-in (Heavy Bulwark)', (() => {
    const { s, ps } = brSession(1);
    s.setRole(ps[0], 'heavy');
    const r = s.useAbility(ps[0]);
    return r.ok && ps[0].bulwarkUntil > s.nowMs;
  })());
  check('Survival role keeps its starting weapon (Heavy shotgun — regression)', (() => {
    const s = new Session('M6'); const p = addFake(s);
    s.setRole(p, 'heavy');
    return p.weapons.includes('shotgun') && p.currentWeapon === 'shotgun';
  })());
  check('BR grace blocks PvP damage (shot during grace: no hit, HP unchanged)', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    s.grantWeapon(a, 'rifle'); a.currentWeapon = 'rifle';
    b.hp = 100;
    const hit = shootOnce(s, a, b);
    return hit && hit.hit === false && b.hp === 100;
  })());
  check('BR grace does NOT block zombie damage', (() => {
    const { s, ps } = brSession(1, false);
    const p = ps[0]; p.hp = 100;
    const z = zombieNearLOS(s, 'shambler', p);
    if (!z) return false; // no LOS neighbour — test setup failure, not a pass
    tickN(s, 60); // 3 s: BR-groggy windup 2.1 s + attack lands
    return p.hp < 100;
  })(), 'zombie hit a graced player');

  console.log('\n--- unit: BR loot (Job 3.2) ---');
  check('BR has 14 crates + 16 ground spawns = 30 loot points', (() => {
    const { s } = brSession(1);
    return s.crates.length === 14 && s.groundLoot.length === 16;
  })());
  check('ground loot tier audit: no low-tier spawn holds a rifle/shotgun/SMG', BR_GROUND_LOOT.filter(g => g.tier === 'low').every(g => !(g.items.weapons || []).some(w => ['rifle', 'shotgun', 'smg'].includes(w))));
  check('ground loot tier audit: every high-tier spawn holds a gun or 2+ meds', BR_GROUND_LOOT.filter(g => g.tier === 'high').every(g => (g.items.weapons || []).some(w => ['rifle', 'shotgun', 'smg'].includes(w)) || (g.items.meds || 0) >= 2));
  check('all ground spawns on walkable in-bounds tiles', BR_GROUND_LOOT.every(g => g.x >= 0 && g.x <= 30 && g.y >= 0 && g.y <= 30 && !arena.tileBlocked(Math.floor(g.x), Math.floor(g.y))));
  check('crate tier table covers all 14 crates', Object.keys(BR_CRATE_TIER).length === 14 && ['crate-1', 'crate-2', 'crate-3', 'crate-4', 'crate-5', 'crate-6', 'crate-7', 'crate-8', 'crate-9', 'crate-10', 'crate-11', 'crate-12', 'crate-13', 'crate-14'].every(id => BR_CRATE_TIER[id]));
  check('crate weapon chance is tiered in BR (high 0.5 / mid 0.35 / low 0.2)', crateWeaponChance('battle-royale', 'high') === 0.5 && crateWeaponChance('battle-royale', 'mid') === 0.35 && crateWeaponChance('battle-royale', 'low') === 0.2);
  check('crate weapon chance is flat 0.35 in Survival (regression)', crateWeaponChance('survival', 'high') === 0.35 && crateWeaponChance('survival', 'low') === 0.35);
  check('ground spawn is finite: taken once, second player gets nothing', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    const g = s.groundLoot[0]; // rifle + 40 rifle ammo
    a.x = g.x; a.y = g.y; a.interactHeld = true;
    tickN(s, 2);
    const tookRifle = a.weapons.includes('rifle');
    const lootA = a.lootCollected;
    a.interactHeld = false;
    b.x = g.x; b.y = g.y; b.interactHeld = true;
    tickN(s, 2);
    return tookRifle && g.taken && b.lootCollected === 0 && !b.weapons.includes('rifle') && lootA === 1;
  })());
  check('crate is finite: re-looting an emptied crate returns nothing', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    const c = s.crates[0];
    a.x = c.x; a.y = c.y; a.interactHeld = true;
    tickN(s, 2);
    const lootA = a.lootCollected;
    a.interactHeld = false;
    b.x = c.x; b.y = c.y; b.interactHeld = true;
    tickN(s, 2);
    return c.looted && lootA === 1 && b.lootCollected === 0;
  })());
  check('BR death pile matches the Survival rule (carried drops, equipped stays)', (() => {
    const mkVictim = (mode) => {
      const s = new Session('DP-' + mode, mode === 'br' ? { mode: 'battle-royale' } : {});
      const v = addFake(s); addFake(s);
      s.grantWeapon(v, 'rifle');
      v.carried = { meds: 2, materials: 3 };
      v.ammo.rifle = 40; v.ammo.pistol = 12;
      const before = [...v.weapons];
      s.killPlayer(v, null, 'bled-out');
      const pile = s.lootPiles[s.lootPiles.length - 1];
      return { pile, before, weaponsAfter: [...v.weapons] };
    };
    const br = mkVictim('br'), sv = mkVictim('sv');
    // Same rule in both modes: carried meds/materials drop, equipped stays.
    // The piles differ by design since the tuning round: the Survival victim
    // starts with the breather-0 shotgun, so its pile holds shotgun + rifle;
    // the BR victim (melee-only drop-in) holds rifle only.
    const ruleHolds = r => r.pile.items.meds === 2 && r.pile.items.materials === 3 &&
      JSON.stringify(r.before) === JSON.stringify(r.weaponsAfter);
    return ruleHolds(br) && ruleHolds(sv) &&
      JSON.stringify(br.pile.items.weapons) === JSON.stringify(['rifle']) &&
      JSON.stringify(sv.pile.items.weapons) === JSON.stringify(['shotgun', 'rifle']);
  })());
  check('Survival has no ground loot', (() => {
    const s = new Session('M7'); addFake(s);
    return s.groundLoot.length === 0 && s.snapshotFor([...s.players.values()][0]).groundLoot.length === 0;
  })());

  console.log('\n--- unit: zone schedule (Job 3.3) ---');
  check('zone has 6 phases (0..5)', BR_ZONE_PHASES === 6 && BR_ZONE_SCHEDULE.length === 6);
  check('zone radii shrink monotonically (22, 16, 12, 8, 5, 2.5)', JSON.stringify(BR_ZONE_SCHEDULE.map(z => z.radius)) === JSON.stringify([22, 16, 12, 8, 5, 2.5]));
  check('zone DPS rises monotonically per phase (1, 2, 4, 8, 15, 25)', JSON.stringify(BR_ZONE_SCHEDULE.map(z => z.dps)) === JSON.stringify([1, 2, 4, 8, 15, 25]));
  check('zone schedule to final circle is 460 s (8–10 min window)', BR_ZONE_TOTAL_MS === 460000 && BR_ZONE_TOTAL_MS >= 420000 && BR_ZONE_TOTAL_MS <= 600000, `${BR_ZONE_TOTAL_MS} ms`);
  check('every phase has a ~30 s shrink period', BR_ZONE_SCHEDULE.slice(0, 5).every(z => z.shrinkMs === 30000));
  check('every phase wait is 50–90 s', BR_ZONE_SCHEDULE.slice(0, 5).every(z => z.waitMs >= 50000 && z.waitMs <= 90000));
  check('phase 0 circle covers the whole arena (centre 15,15 r22)', (() => {
    const c = BR_ZONE_CENTRE;
    return Math.hypot(0 - c.x, 0 - c.y) <= 22 && Math.hypot(30 - c.x, 0 - c.y) <= 22
      && Math.hypot(0 - c.x, 30 - c.y) <= 22 && Math.hypot(30 - c.x, 30 - c.y) <= 22;
  })());
  check('next-zone centres are never concentric (min shift 1.5 tiles)', (() => {
    let ok = true;
    for (let i = 0; i < 50; i++) {
      const cur = { x: 15 + (Math.random() * 4 - 2), y: 15 + (Math.random() * 4 - 2), r: 16 };
      const nxt = computeNextZone(cur, 12);
      if (Math.hypot(nxt.x - cur.x, nxt.y - cur.y) < 1.5) ok = false;
    }
    return ok;
  })());
  check('next-zone circle stays inside the arena as far as it can fit', (() => {
    // The arena is a 30x30 square: a circle fits fully for r<=15.
    // Rule: centre inside the arena rect, and fully contained when r<=15.
    for (let i = 0; i < 50; i++) {
      const cur = { x: 10 + Math.random() * 10, y: 10 + Math.random() * 10, r: 16 };
      const nxt = computeNextZone(cur, 12);
      if (nxt.x < 0 || nxt.x > 30 || nxt.y < 0 || nxt.y > 30) return false;
    }
    for (let i = 0; i < 50; i++) {
      const cur = { x: 12 + Math.random() * 6, y: 12 + Math.random() * 6, r: 8 };
      const nxt = computeNextZone(cur, 5);
      if (nxt.x - nxt.r < 0 || nxt.x + nxt.r > 30 || nxt.y - nxt.r < 0 || nxt.y + nxt.r > 30) return false;
    }
    return true;
  })());
  check('out-runnable: worst-case rotate fits inside wait+shrink at 5 u/s', (() => {
    // Worst case: player at the far edge of the current circle, opposite
    // the next centre. Max travel = (rCur - rNext) + max centre shift
    // (0.7 * (rCur - rNext)); time available = wait + shrink of the phase.
    for (let i = 0; i < 5; i++) {
      const cur = BR_ZONE_SCHEDULE[i], nxt = BR_ZONE_SCHEDULE[i + 1];
      const maxTravel = (cur.radius - nxt.radius) * 1.7;
      const timeS = (cur.waitMs + cur.shrinkMs) / 1000;
      if (maxTravel > 5 * timeS) return false;
    }
    return true;
  })());
  check('shrink interpolates: mid-shrink radius is between from and to', (() => {
    const { s } = brSession(1);
    s.zone.phaseEndsAt = s.nowMs; // force the shrink to start now
    tickN(s, 1);
    if (s.zone.state !== 'shrinking') return false;
    tickN(s, 300); // 15 s into the 30 s shrink
    const r = s.zone.current.r;
    return r < 22 && r > 16;
  })());

  console.log('\n--- unit: zone damage (Job 3.3) ---');
  // Helper: a BR session with the zone pinned to one phase, one player
  // standing outside it at (29.5, 29.5) — walkable, 20.5 tiles from (15,15).
  function zoneDpsSetup(phase) {
    const { s, ps } = brSession(2, false);
    const p = ps[0];
    god(ps[1]); // the other player must not die mid-test (a BR win would freeze the tick)
    p.invulnUntil = Infinity; // isolate zone damage from zombie hits
    p.hp = 100; p.maxHp = 100;
    p.x = 29.5; p.y = 29.5;
    s.zone.current = { x: 15, y: 15, r: BR_ZONE_SCHEDULE[phase].radius };
    s.zone.phase = phase;
    s.zone.dps = BR_ZONE_SCHEDULE[phase].dps;
    s.zone.state = 'waiting';
    s.zone.phaseEndsAt = Infinity;
    s.zone.next = null;
    return { s, p, other: ps[1] };
  }
  for (const phase of [1, 2, 3, 4, 5]) {
    const dps = BR_ZONE_SCHEDULE[phase].dps;
    check(`zone DPS phase ${phase} is ${dps} HP/s (100 HP -> ${100 - dps} after 1 s outside)`, (() => {
      const { s, p } = zoneDpsSetup(phase);
      tickN(s, 20); // 1 s
      return Math.abs(p.hp - (100 - dps)) < 0.6;
    })());
  }
  check('zone DPS phase 1 is forgiving (100 HP -> 80 after 10 s outside)', (() => {
    const { s, p } = zoneDpsSetup(1);
    tickN(s, 200);
    return Math.abs(p.hp - 80) < 0.6;
  })());
  check('zone DPS final phase is lethal in seconds (downed within 5 s)', (() => {
    const { s, p } = zoneDpsSetup(5);
    tickN(s, 60); // 3 s: 25 HP left, still alive
    const aliveAt3 = p.state === 'alive' && Math.abs(p.hp - 25) < 0.6;
    tickN(s, 40); // 5 s total
    return aliveAt3 && p.state === 'downed';
  })());
  check('player inside the zone takes no zone damage', (() => {
    const { s, p } = zoneDpsSetup(4);
    p.x = 15; p.y = 15; // dead centre of the r=5 circle
    tickN(s, 100);
    return p.hp === 100;
  })());

  console.log('\n--- unit: full zone run — preview, transitions, bounds (Job 3.3) ---');
  (function fullZoneRun() {
    const { s, ps } = brSession(2);
    const previews = []; // {phase, next} seen at each zone-phase event
    const arrivals = []; // {phase, current} seen at each zone-phase event
    // Clear zombies periodically so the run stays fast (spawn counting is
    // tested separately); god players cannot die, so the match cannot end.
    for (let chunk = 0; chunk < 24; chunk++) {
      tickN(s, 500); // 25 s per chunk, 600 s total
      s.zombies.clear();
      for (const ev of drainEvents(ps[0], 'zone-phase')) {
        previews.push({ phase: ev.phase, next: ev.next });
        arrivals.push({ phase: ev.phase, current: ev.current });
      }
      if (s.zone.phase === 5) break;
    }
    const phasesSeen = arrivals.map(a => a.phase);
    check('full run reaches the final circle (phase 5)', s.zone.phase === 5, `phases seen: ${phasesSeen.join(',')}`);
    check('full run visits every phase 0..5 in order', JSON.stringify(phasesSeen) === JSON.stringify([0, 1, 2, 3, 4, 5]), phasesSeen.join(','));
    check('preview == arriving circle for every transition', (() => {
      // arrivals[i+1].current must equal previews[i].next (the circle
      // previewed at the previous phase is the one that arrives).
      for (let i = 0; i < previews.length - 1; i++) {
        const prev = previews[i].next, cur = arrivals[i + 1].current;
        if (!prev || !cur) return false;
        if (prev.x !== cur.x || prev.y !== cur.y || prev.r !== cur.r) return false;
      }
      return previews.length === 6;
    })(), `${previews.length} phase events`);
    check('successive zone centres are never concentric in the live run', (() => {
      for (let i = 1; i < arrivals.length; i++) {
        if (Math.hypot(arrivals[i].current.x - arrivals[i - 1].current.x, arrivals[i].current.y - arrivals[i - 1].current.y) < 1.5) return false;
      }
      return true;
    })());
    check('every previewed circle stays inside the arena as far as it can fit', (() => {
      // Centre inside the arena rect; fully contained when r<=15 (a bigger
      // circle cannot fit the 30x30 arena — see computeNextZone).
      return previews.every(p => !p.next ||
        (p.next.x >= 0 && p.next.x <= 30 && p.next.y >= 0 && p.next.y <= 30 &&
          (p.next.r > 15 || (p.next.x - p.next.r >= 0 && p.next.x + p.next.r <= 30 && p.next.y - p.next.r >= 0 && p.next.y + p.next.r <= 30))));
    })());
    check('final phase has no next circle (holds forever)', s.zone.next === null && s.zone.state === 'waiting');
    check('snapshot carries current + next zone with countdown', (() => {
      const snap = s.snapshotFor(ps[0]);
      return snap.zone && snap.zone.phase === 5 && snap.zone.current && snap.zone.current.r === 2.5 && snap.zone.next === null && snap.zone.msToNext === null && snap.zone.dps === 25;
    })());
  })();

  console.log('\n--- unit: zombies and the zone (Job 3.3) ---');
  check('BR director spawns zombies INSIDE the current safe zone', (() => {
    const { s } = brSession(2);
    // 45 s of spawning: the BR-opening director is 1/6 s for the first 30 s
    // (loot time), so 30 s only yields ~4 spawns and the >= 5 guard below
    // would be drop-luck flaky (it also tripped on isolated-pressure spawns).
    tickN(s, 900); // 45 s of spawning
    const z = s.zone.current;
    return s.zombies.size >= 5 && [...s.zombies.values()].every(zz => Math.hypot(zz.x - z.x, zz.y - z.y) <= z.r + 2);
  })());
  check('a zombie outside the zone takes zone damage and moves to centre', (() => {
    const { s, ps } = brSession(2, false);
    god(ps[0]); god(ps[1]);
    s.zone.current = { x: 15, y: 15, r: 4 };
    s.zone.phase = 4; s.zone.dps = 15; s.zone.state = 'waiting'; s.zone.phaseEndsAt = Infinity;
    const z = zombieNear(s, 'shambler', 25, 25); // 14.1 tiles from centre, outside r=4
    const d0 = Math.hypot(z.x - 15, z.y - 15);
    const hp0 = z.hp;
    tickN(s, 20); // 1 s: 15 zone damage, shambles toward centre
    const d1 = Math.hypot(z.x - 15, z.y - 15);
    return z.hp < hp0 && d1 < d0;
  })());
  check('a zombie left outside the zone dies if it stays out too long', (() => {
    const { s, ps } = brSession(2, false);
    god(ps[0]); god(ps[1]);
    s.zone.current = { x: 15, y: 15, r: 4 };
    s.zone.phase = 4; s.zone.dps = 15; s.zone.state = 'waiting'; s.zone.phaseEndsAt = Infinity;
    const z = zombieNear(s, 'shambler', 25, 25);
    z.hp = 5; // one second of phase-4 zone damage kills it
    // Pin it far out: it walks 1.2 u/s, needs ~8 s to reach the circle.
    tickN(s, 40); // 2 s
    return !s.zombies.has(z.id);
  })());
  check('no zombie pile-up outside the circle (30 s run, phase 3)', (() => {
    const { s } = brSession(2);
    s.zone.current = { x: 15, y: 15, r: 8 };
    s.zone.phase = 3; s.zone.dps = 8; s.zone.state = 'waiting'; s.zone.phaseEndsAt = Infinity;
    tickN(s, 600);
    const z = s.zone.current;
    return [...s.zombies.values()].every(zz => Math.hypot(zz.x - z.x, zz.y - z.y) <= z.r + 1);
  })());

  console.log('\n--- unit: zone-paced director (Job 3.4) ---');
  check('director spawn interval falls monotonically by phase', (() => {
    for (let i = 1; i < BR_DIRECTOR.length; i++) if (BR_DIRECTOR[i].intervalMs >= BR_DIRECTOR[i - 1].intervalMs) return false;
    return true;
  })(), BR_DIRECTOR.map(d => d.intervalMs).join(','));
  check('director brute share never falls by phase', (() => {
    const b = BR_DIRECTOR.map(d => d.mix.brute || 0);
    for (let i = 1; i < b.length; i++) if (b[i] < b[i - 1]) return false;
    return true;
  })(), BR_DIRECTOR.map(d => d.mix.brute || 0).join(','));
  check('director runner share never falls by phase', (() => {
    const r = BR_DIRECTOR.map(d => d.mix.runner || 0);
    for (let i = 1; i < r.length; i++) if (r[i] < r[i - 1]) return false;
    return true;
  })(), BR_DIRECTOR.map(d => d.mix.runner || 0).join(','));
  check('measured spawn rate rises: phase 5 spawns >2x phase 0 in 30 s', (() => {
    const countSpawns = (phase) => {
      const { s, ps } = brSession(2);
      s.zone.phase = phase;
      s.zone.current = { x: 15, y: 15, r: phase === 5 ? 2.5 : 22 };
      // Players together at the centre: no isolated-player pressure
      // spawns. Surges blocked: this measures the base director rate only.
      ps[0].x = 15; ps[0].y = 15; ps[1].x = 15.5; ps[1].y = 15;
      s.director.lastSurgeTick = 1e9;
      tickN(s, 600); // 30 s
      return s.zombies.size;
    };
    const n0 = countSpawns(0), n5 = countSpawns(5);
    return n5 > n0 * 2;
  })(), 'phase 0 vs phase 5 counts compared');
  check('BR has no waves (wave stays 0, phase br, no wave-start events)', (() => {
    const { s, ps } = brSession(2);
    tickN(s, 600);
    return s.wave === 0 && s.phase === 'br' && !hasEvent(ps[0], 'wave-start') && !hasEvent(ps[1], 'wave-start');
  })());

  console.log('\n--- unit: last-standing win detection (Job 3.4) ---');
  check('solo ending: last player alive wins, placement 1 vs 2', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    s.killPlayer(b, a, 'executed');
    tickN(s, 2);
    const score = s.endScore.players;
    const pa = score.find(p => p.id === a.id), pb = score.find(p => p.id === b.id);
    return s.ended && s.endReason === 'br-win' && s.brWinners.includes(a.id) &&
      pa.placement === 1 && pb.placement === 2;
  })());
  check('squad ending: last squad wins together, both placement 1', (() => {
    const { s, ps } = brSession(3, false);
    const [a, b, c] = ps;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.killPlayer(c, a, 'executed');
    tickN(s, 2);
    const score = s.endScore.players;
    return s.ended && s.endReason === 'br-win' &&
      s.brWinners.includes(a.id) && s.brWinners.includes(b.id) &&
      score.find(p => p.id === a.id).placement === 1 &&
      score.find(p => p.id === b.id).placement === 1 &&
      score.find(p => p.id === c.id).placement === 3;
  })());
  check('last two are squadmates: match ends immediately when the solo dies', (() => {
    const { s, ps } = brSession(3, false);
    const [a, b, c] = ps;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.killPlayer(c, a, 'executed');
    tickN(s, 1); // a single tick is enough
    return s.ended && s.endReason === 'br-win' && s.brWinners.length === 2;
  })());
  check('downed last player with no squadmate: match ends WITHOUT waiting for bleed-out', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    s.downPlayer(b, a); // b downed, 60 s bleed-out, nobody can revive them
    tickN(s, 1);
    return s.ended && s.endReason === 'br-win' && s.brWinners.includes(a.id) &&
      s.endScore.players.find(p => p.id === b.id).placement === 2;
  })());
  check('downed player WITH a living squadmate does NOT end the match (revivable)', (() => {
    const { s, ps } = brSession(3, false);
    const [a, b, c] = ps;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.downPlayer(b, c);
    s.spawnTimerMs = -100000; // suppress director spawns for this window
    // Wipe any surge/pressure spawns each tick: a zombie spawning next to
    // the downed player would execute them (correct in-game, wrong here —
    // this test is about the win check, not zombie finishes).
    for (let i = 0; i < 100; i++) { s.tick(); s.zombies.clear(); }
    const stillGoing = !s.ended && ps[1].state === 'downed';
    s.killPlayer(c, a, 'executed'); // now the squad is the last unit
    tickN(s, 2);
    return stillGoing && s.ended && s.brWinners.includes(a.id) && s.brWinners.includes(b.id);
  })());
  check('placement is correct for every player (death order, later death = better)', (() => {
    const { s, ps } = brSession(4, false);
    const [a, b, c, d] = ps;
    s.killPlayer(d, a, 'executed'); tickN(s, 20);
    s.killPlayer(c, a, 'executed'); tickN(s, 20);
    s.killPlayer(b, a, 'executed'); tickN(s, 2);
    const score = s.endScore.players;
    const pl = (p) => score.find(q => q.id === p.id).placement;
    return s.ended && pl(a) === 1 && pl(b) === 2 && pl(c) === 3 && pl(d) === 4;
  })());
  check('a lone player does NOT instantly win (match needs 2+ ever joined)', (() => {
    const { s } = brSession(1);
    tickN(s, 100);
    return !s.ended;
  })());
  check('REGRESSION (Round 2, 15:11 bogus br-win): lone 2-player squad does NOT end the match when a member is downed — downed player is revivable, nobody eliminated', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.spawnTimerMs = -100000; // suppress director spawns for this window
    // Wipe any surge/pressure spawns each tick: this test is about the win
    // check, not zombie finishes (same pattern as the revivable-squadmate test).
    for (let i = 0; i < 2; i++) { s.tick(); s.zombies.clear(); }
    if (s.ended) return false; // forming the squad alone must not win (15:11)
    s.downPlayer(a, null); // zombie downs A; B stands ready to revive
    for (let i = 0; i < 2; i++) { s.tick(); s.zombies.clear(); }
    return !s.ended && a.state === 'downed' && b.state === 'alive';
  })());
  check('REGRESSION (Round 2): downed squadmate revived, match continues until a real elimination, then the squad wins', (() => {
    const { s, ps } = brSession(3, false);
    const [a, b, c] = ps;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.spawnTimerMs = -100000;
    s.downPlayer(a, null);
    s.tick(); s.zombies.clear();
    if (s.ended) return false;
    b.interactHeld = true; b.x = a.x; b.y = a.y;
    for (let i = 0; i < 70; i++) { s.tick(); s.zombies.clear(); } // 3.5 s: revive channel completes
    b.interactHeld = false;
    if (a.state !== 'alive') return false;
    s.killPlayer(c, a, 'executed'); // the only real elimination: C dies
    tickN(s, 2);
    return s.ended && s.endReason === 'br-win' && s.brWinners.includes(a.id) && s.brWinners.includes(b.id);
  })());
  check('REGRESSION (Round 2): downed solo revived cross-squad, then a merge — the stale elimination must not linger, match ends only on the real elimination', (() => {
    const { s, ps } = brSession(3, false);
    const [a, b, c] = ps;
    s.spawnTimerMs = -100000;
    s.downPlayer(a, null); // A downed as a solo; C keeps the match alive
    s.tick(); s.zombies.clear();
    if (s.ended) return false;
    b.interactHeld = true; b.x = a.x; b.y = a.y;
    for (let i = 0; i < 70; i++) { s.tick(); s.zombies.clear(); } // B revives A (cross-squad) — clears the elimination
    b.interactHeld = false;
    if (a.state !== 'alive') return false;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id); // merge AFTER the revive
    for (let i = 0; i < 100; i++) { s.tick(); s.zombies.clear(); }
    if (s.ended) return false; // C still alive as a separate unit: no win
    s.killPlayer(c, a, 'executed'); // real elimination: C dies
    tickN(s, 2);
    return s.ended && s.endReason === 'br-win' && s.brWinners.length === 2;
  })());

  console.log('\n--- unit: BR end screen (Job 3.4) ---');
  check('BR end screen carries every field (placement, kills, headshots, playersKilled, revives, damage, loot, survival, zones, titles)', (() => {
    // 3 players: a revives downed b while c is still alive (in a 2-player
    // match the down ends it immediately — a downed last opponent is
    // effectively dead), then a executes b and c and wins.
    const { s, ps } = brSession(3, false);
    const [a, b, c] = ps;
    s.downPlayer(b, a);
    s.spawnTimerMs = -100000; // suppress director spawns during the revive window
    a.interactHeld = true; a.x = b.x; a.y = b.y;
    tickN(s, 70); // 3.5 s: revive channel (3 s) completes
    a.interactHeld = false;
    const revived = b.state === 'alive';
    s.killPlayer(b, a, 'executed');
    s.killPlayer(c, a, 'executed');
    tickN(s, 2);
    const row = s.endScore.players.find(p => p.id === a.id);
    const titles = s.endScore.titles.map(t => t.title);
    return s.ended && revived && row &&
      'placement' in row && 'kills' in row && 'headshots' in row && 'playersKilled' in row &&
      'revives' in row && 'damageDealt' in row && 'lootCollected' in row &&
      'survivalMs' in row && 'zonesSurvived' in row &&
      row.revives === 1 && row.playersKilled === 2 && row.placement === 1 &&
      s.endScore.mode === 'battle-royale' && 'zonePhaseReached' in s.endScore &&
      'winners' in s.endScore && s.endScore.winners.includes(a.id) &&
      titles.includes('Last One Standing') && titles.includes('Most Revives') && titles.includes('Most Betrayals');
  })());
  check('BR end-screen fields match the live player stats', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    a.kills = 7; a.headshots = 3; a.damageDealt = 1234; a.lootCollected = 5;
    s.killPlayer(b, a, 'executed');
    tickN(s, 2);
    const row = s.endScore.players.find(p => p.id === a.id);
    return row.kills === 7 && row.headshots === 3 && row.damageDealt === 1234 && row.lootCollected === 5 &&
      row.survivalMs === s.nowMs && row.zonesSurvived === s.zone.phase;
  })());
  check('Most Revives / Most Betrayals titles are omitted when nobody qualifies', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    // b dies to zombies: no revives, no player kills anywhere.
    s.killPlayer(b, null, 'bled-out');
    tickN(s, 2);
    const titles = s.endScore.titles.map(t => t.title);
    return titles.includes('Last One Standing') && !titles.includes('Most Revives') && !titles.includes('Most Betrayals');
  })());

  console.log('\n--- unit: disconnects in BR (Job 3.4) ---');
  check('zone damage keeps ticking during disconnect grace', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    god(b);
    a.hp = 100; a.maxHp = 100; a.invulnUntil = Infinity;
    a.x = 29.5; a.y = 15.5; // outside the phase-4 circle
    s.zone.current = { x: 15, y: 15, r: 4 };
    s.zone.phase = 4; s.zone.dps = 15; s.zone.state = 'waiting'; s.zone.phaseEndsAt = Infinity;
    a.disconnected = true; a.disconnectAtMs = s.nowMs;
    tickN(s, 20); // 1 s: 15 zone damage while disconnected
    return Math.abs(a.hp - 85) < 0.6;
  })());
  check('disconnected character outside the zone dies to the zone on schedule', (() => {
    const { s, ps } = brSession(2, false);
    const [a, b] = ps;
    // Both disconnected: no win check (hibernation guard), bleed-out runs.
    a.hp = 100; a.maxHp = 100; a.invulnUntil = Infinity;
    a.x = 29.5; a.y = 15.5;
    s.zone.current = { x: 15, y: 15, r: 2.5 };
    s.zone.phase = 5; s.zone.dps = 25; s.zone.state = 'waiting'; s.zone.phaseEndsAt = Infinity;
    a.disconnected = true; a.disconnectAtMs = s.nowMs;
    b.disconnected = true; b.disconnectAtMs = s.nowMs;
    god(b);
    tickN(s, 100); // 5 s: downed by the zone (25 HP/s)
    const downed = a.state === 'downed';
    tickN(s, 1200); // +60 s: bleed-out finishes
    return downed && a.state === 'dead' && a.deathMs !== null;
  })());
  check('Survival disconnect grace is unchanged (alive at 30 s, dead at 31 s, no zone)', (() => {
    const s = new Session('DC-SV');
    const a = addFake(s); const b = addFake(s);
    god(b);
    a.disconnected = true; a.disconnectAtMs = s.nowMs;
    tickN(s, 600); // exactly 30 s
    const aliveAt30 = a.state === 'alive';
    tickN(s, 20); // 31 s
    return aliveAt30 && a.state === 'dead' && s.snapshotFor(b).zone === null;
  })());

  console.log('\n--- unit: Survival regression (Phases 1–2 unchanged) ---');
  check('Survival: breather leads into wave 1', (() => {
    const s = new Session('SV1'); addFake(s);
    tickN(s, 950); // 47.5 s > 45 s first breather (v7)
    return s.phase === 'wave' && s.wave === 1 && s.waveRemainingToSpawn > 0;
  })());
  check('Survival: clearing a wave returns to breather', (() => {
    const s = new Session('SV2'); addFake(s);
    s.phase = 'wave'; s.wave = 1; s.waveRemainingToSpawn = 0; s.spawnQueue = []; s.zombies.clear();
    tickN(s, 2);
    return s.phase === 'breather' && s.breatherEndsAt > s.nowMs;
  })());
  check('Survival: extraction opens after wave 5 is cleared', (() => {
    const s = new Session('SV3'); addFake(s);
    s.phase = 'wave'; s.wave = 5; s.waveRemainingToSpawn = 0; s.spawnQueue = []; s.zombies.clear();
    tickN(s, 2);
    return s.extractionOpen === true;
  })());
  check('Survival: wave-paced director unchanged (waveCount/waveDef values)', waveCount(1, 1) === 8 && waveCount(1, 4) === 16 && waveDef(1).gates === 1 && waveDef(3).mix.spitter === 0.1 && waveDef(3).mix.screamer === 0.05 && waveDef(5).mix.brute === 0.1);
  check('Survival: no zone, no ground loot, no BR win logic', (() => {
    const s = new Session('SV4'); const p = addFake(s);
    tickN(s, 100);
    const snap = s.snapshotFor(p);
    return snap.zone === null && snap.groundLoot.length === 0 && s.brWinners === null && s.phase !== 'br';
  })());
  check('Survival end screen has no BR-only fields (placement/survivalMs/zonesSurvived)', (() => {
    const s = new Session('SV5'); const a = addFake(s); const b = addFake(s);
    s.killPlayer(a, null, 'bled-out'); s.killPlayer(b, null, 'bled-out');
    tickN(s, 2);
    const row = s.endScore.players[0];
    return s.ended && !('placement' in row) && !('survivalMs' in row) && !('zonesSurvived' in row) && !('winners' in s.endScore);
  })());
}

// ---------------- Live WS integration tests ----------------
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c = { ws, id: null, code: null, snaps: [], msgs: [] };
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      c.msgs.push(m);
      if (m.type === 'welcome') c.id = m.id;
      if (m.type === 'created') c.code = m.code;
      if (m.type === 'snapshot') c.snaps.push(m);
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(c, pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = c.msgs.find(pred);
    if (m) return m;
    await wait(50);
  }
  return null;
}
function lastSnap(c) { return c.snaps[c.snaps.length - 1]; }

async function wsTests() {
  console.log('\n--- live WS: create/join a BR session over the wire ---');
  const a = await wsClient();
  await waitFor(a, m => m.type === 'welcome');
  // A creates a Battle Royale session.
  a.ws.send(JSON.stringify({ type: 'create', mode: 'battle-royale' }));
  const created = await waitFor(a, m => m.type === 'created');
  check('WS: create with mode battle-royale returns mode', created && created.mode === 'battle-royale' && created.code, JSON.stringify(created && { code: created.code, mode: created.mode }));
  const welcome = await waitFor(a, m => m.type === 'welcome' && m.mode === 'battle-royale');
  check('WS: welcome carries mode battle-royale', !!welcome, welcome && `id=${welcome.id} mode=${welcome.mode}`);
  // B joins the BR session by code.
  const b = await wsClient();
  await waitFor(b, m => m.type === 'welcome');
  b.ws.send(JSON.stringify({ type: 'join', code: created.code }));
  const joined = await waitFor(b, m => m.type === 'joined');
  check('WS: second client joins the BR session by code', joined && joined.code === created.code, JSON.stringify(joined));
  await wait(600);
  const snapA = lastSnap(a), snapB = lastSnap(b);
  check('WS: snapshots carry mode battle-royale + a zone', snapA && snapA.mode === 'battle-royale' && snapA.zone && snapA.zone.phase === 0 && snapA.zone.current.r === 22, JSON.stringify(snapA && snapA.zone));
  check('WS: both players drop in melee-only over the wire', (() => {
    const pa = snapA && snapA.players.find(p => p.id === a.id);
    const pb = snapB && snapB.players.find(p => p.id === b.id);
    return pa && pb && pa.weapons.length === 1 && pa.weapons[0] === 'melee' && pb.weapons.length === 1 && pb.weapons[0] === 'melee';
  })());
  check('WS: BR spawn points are spread (min distance >= 5)', (() => {
    const pa = snapA && snapA.players.find(p => p.id === a.id);
    const pb = snapA && snapA.players.find(p => p.id === b.id);
    return pa && pb && Math.hypot(pa.x - pb.x, pa.y - pb.y) >= 5;
  })(), (() => {
    const pa = lastSnap(a).players.find(p => p.id === a.id);
    const pb = lastSnap(a).players.find(p => p.id === b.id);
    return `A=(${pa.x},${pa.y}) B=(${pb.x},${pb.y}) dist=${Math.hypot(pa.x - pb.x, pa.y - pb.y).toFixed(2)}`;
  })());
  check('WS: snapshot carries BR ground loot (16 spawns)', snapA && Array.isArray(snapA.groundLoot) && snapA.groundLoot.length === 16, `groundLoot=${snapA && snapA.groundLoot.length}`);
  // Role pick over the wire in BR: Heavy grants the passive, not a shotgun.
  a.ws.send(JSON.stringify({ type: 'role', role: 'heavy' }));
  await wait(400);
  const snapA2 = lastSnap(a);
  const entryA = snapA2 && snapA2.players.find(p => p.id === a.id);
  check('WS: BR role pick grants passive only (125 HP, still melee)', entryA && entryA.role === 'heavy' && entryA.maxHp === 125 && entryA.weapons.length === 1 && entryA.weapons[0] === 'melee', JSON.stringify(entryA && { role: entryA.role, maxHp: entryA.maxHp, weapons: entryA.weapons }));
  a.ws.close(); b.ws.close();
}

async function main() {
  unitTests();
  // Spawn the real server for WS tests.
  let proc = null;
  try {
    await fetchJson(`http://localhost:${PORT}/health`);
    console.log('using already-running server');
  } catch {
    proc = spawn('node', [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT) },
    });
    proc.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
    proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    for (let i = 0; i < 50; i++) {
      try { await fetchJson(`http://localhost:${PORT}/health`); break; }
      catch { await wait(100); }
      if (i === 49) throw new Error('server did not come up');
    }
  }
  try { await wsTests(); }
  finally { if (proc) { proc.kill(); await wait(300); } }
  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — run=${run} passed=${passed} failed=${failures.length}${failures.length ? ': ' + failures.join('; ') : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
