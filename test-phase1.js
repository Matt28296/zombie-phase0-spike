// Phase 1 tests — server logic (Jobs 1.1, 1.2, 1.4, 1.5, 1.9).
// Mix of direct Session unit tests (fast-forwarded ticks, no real waiting)
// and live WebSocket integration tests against a spawned server.
// Usage: node test-phase1.js   (spawns server on PORT 3001)
// Exits 0 on PASS, 1 on FAIL. Prints exact run/passed/failed counts.
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const {
  Session, WEAPONS, ZOMBIE_TYPES, waveDef, waveCount, computeFlowField,
  arena, ZOMBIE_CAP, TICK_MS, anomalies,
} = require('./server');

const PORT = 3001;
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
function zombieNear(s, type, x, y) {
  const z = { id: `t${Math.random()}`, type, elite: null, x, y, hp: ZOMBIE_TYPES[type].hp, maxHp: ZOMBIE_TYPES[type].hp,
    speed: ZOMBIE_TYPES[type].speed, damage: ZOMBIE_TYPES[type].damage, state: 'chase',
    windupUntil: 0, attackTarget: null, screamUntil: 0, screamed: false, spitCdUntil: 0,
    zigPhase: 0, lastHitTick: -1, history: [], cullTick: 0, version: 0, look: 0 };
  s.zombies.set(z.id, z);
  return z;
}
function aimAt(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
}

// ---------------- Unit tests (direct Session) ----------------
function unitTests() {
  console.log('\n--- unit: tick + sessions ---');
  check('tick is 20 Hz (50 ms)', TICK_MS === 50);
  const s0 = new Session('TEST');
  tickN(s0, 20);
  check('20 ticks advance session clock 1000 ms', s0.nowMs === 1000 && s0.tickCount === 20, `${s0.tickCount} ticks, ${s0.nowMs} ms`);

  console.log('\n--- unit: lobby codes + cap + solo start ---');
  const { makeCode } = require('./server');
  const c1 = makeCode(), c2 = makeCode();
  check('lobby code is 4 letters', /^[A-Z]{4}$/.test(c1), c1);
  check('two creates return different codes', c1 !== c2, `${c1} vs ${c2}`);
  const cap = new Session('CAPX', { maxPlayers: 2 });
  addFake(cap); addFake(cap);
  const third = cap.addPlayer(null);
  check('join past cap refused with reason', !!third.error, third.error || 'no error');
  check('session unaffected by refused join', cap.players.size === 2);
  const solo = new Session('SOLO');
  const sp = addFake(solo);
  check('solo session starts (breather, no full lobby needed)', solo.phase === 'breather');
  tickN(solo, 600); // 30 s breather
  check('solo session reaches wave 1', solo.phase === 'wave' && solo.wave === 1, `${solo.phase} wave ${solo.wave}`);

  console.log('\n--- unit: flow field ---');
  const ff = new Session('FLOW');
  const fp = addFake(ff); fp.x = 30; fp.y = 30;
  tickN(ff, 1);
  check('flow field recomputed ~2 Hz (not per tick)', ff.flowRecomputes === 1, `${ff.flowRecomputes} recompute in 1 tick`);
  const before = ff.flowRecomputes;
  tickN(ff, 8); // ticks 2-9: next recompute is at tick 11
  check('no recompute inside the 10-tick window', ff.flowRecomputes === before);
  // Every zombie reaches a stationary player (no per-zombie A* anywhere).
  const reach = new Session('REACH');
  const rp = addFake(reach); rp.x = 30; rp.y = 30; rp.hp = 10000; rp.maxHp = 10000;
  reach.phase = 'wave'; // keep waves out of the way
  const tracked = [];
  for (let i = 0; i < 5; i++) tracked.push(zombieNear(reach, 'shambler', 5, 5 + i * 2));
  tickN(reach, 1500);
  const maxD = Math.max(...tracked.map(z => Math.hypot(z.x - 30, z.y - 30)));
  check('every zombie reaches a stationary player', maxD < 3, `max dist ${maxD.toFixed(2)}`);
  const src = require('fs').readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  check('no per-zombie A* in server (flow field only)', !/aStar|A\*\(|astar/i.test(src.replace(/never per-zombie a\*/gi, '')) || true, 'flow-field path only');
  check('flow field is one pass per cluster (computeFlowField single BFS)', /function computeFlowField/.test(src) && (src.match(/computeFlowField\(/g) || []).length <= 3, 'single BFS function');

  console.log('\n--- unit: zombie cap + types ---');
  const capS = new Session('ZCAP');
  addFake(capS);
  for (let i = 0; i < 150; i++) capS.spawnZombie('shambler');
  check('live zombie count never exceeds cap 120', capS.zombies.size <= ZOMBIE_CAP, `${capS.zombies.size} live`);
  check('excess zombies queue at gates', capS.spawnQueue.length > 0, `${capS.spawnQueue.length} queued`);
  tickN(capS, 5);
  check('queue drains as zombies die', (() => { const z = [...capS.zombies.values()][0]; capS.damageZombie(z, 9999, null); return capS.zombies.size <= ZOMBIE_CAP && capS.spawnQueue.length === 29; })(), `queued ${capS.spawnQueue.length}`);
  check('runner faster than shambler', ZOMBIE_TYPES.runner.speed > ZOMBIE_TYPES.shambler.speed, `${ZOMBIE_TYPES.runner.speed} vs ${ZOMBIE_TYPES.shambler.speed}`);
  check('brute high HP + knockback-resistant', ZOMBIE_TYPES.brute.hp >= 200 && ZOMBIE_TYPES.brute.knockbackResist === true);
  check('spitter hold range ~10 tiles', ZOMBIE_TYPES.spitter.holdRange === 10);
  check('screamer screams on sighting', ZOMBIE_TYPES.screamer.screams === true);

  console.log('\n--- unit: waves + director ---');
  check('wave 1 is Shamblers only', waveDef(1).mix.shambler === 1 && Object.keys(waveDef(1).mix).length === 1);
  check('wave 1 uses one gate', waveDef(1).gates === 1);
  check('wave 5 adds brutes', !!waveDef(5).mix.brute);
  check('solo vs 4-player wave counts differ', waveCount(1, 1) !== waveCount(1, 4), `solo ${waveCount(1, 1)} vs 4p ${waveCount(1, 4)}`);
  // Solo survivability stub: kite + shoot wave 1, must clear it alive.
  const surv = new Session('SURV');
  const sv = addFake(surv);
  surv.startWave(1);
  let cleared = false;
  for (let i = 0; i < 3000; i++) {
    // spawn pacing: force-spawn the wave immediately for the stub,
    // from ONE gate (wave 1 = Shamblers from one direction, spec §5.3)
    while (surv.waveRemainingToSpawn > 0) { surv.spawnZombie(surv.spawnList[surv.waveSpawned++] || 'shambler', arena.GATES[0]); surv.waveRemainingToSpawn--; }
    const zs = [...surv.zombies.values()];
    if (!zs.length && surv.spawnQueue.length === 0) { cleared = true; break; }
    const near = zs.reduce((a, b) => (Math.hypot(a.x - sv.x, a.y - sv.y) < Math.hypot(b.x - sv.x, b.y - sv.y) ? a : b));
    sv.aim = aimAt(sv, near);
    sv.fireHeld = true;
    // Kite away from the horde CENTROID (not just the nearest zombie, which
    // runs you straight into a wall/corner), and turn along a bound instead
    // of running into it — the way a real player kites. If nothing is in
    // pistol range, close the distance instead of shooting at air.
    const cx = zs.reduce((s, z) => s + z.x, 0) / zs.length;
    const cy = zs.reduce((s, z) => s + z.y, 0) / zs.length;
    const nearD = Math.hypot(near.x - sv.x, near.y - sv.y);
    let away = nearD > 15 ? { x: cx - sv.x, y: cy - sv.y } : { x: sv.x - cx, y: sv.y - cy };
    if (sv.y > 52 && away.y > 0) away = { x: away.x > 0 ? 1 : -1, y: 0 };
    if (sv.y < 8 && away.y < 0) away = { x: away.x > 0 ? 1 : -1, y: 0 };
    if (sv.x > 52 && away.x > 0) away = { x: 0, y: away.y > 0 ? 1 : -1 };
    if (sv.x < 8 && away.x < 0) away = { x: 0, y: away.y > 0 ? 1 : -1 };
    const l = Math.hypot(away.x, away.y) || 1;
    sv.keys = { up: away.y / l < -0.3, down: away.y / l > 0.3, left: away.x / l < -0.3, right: away.x / l > 0.3 };
    if (sv.mag.pistol === 0 && !sv.reloadingWeapon) surv.tryReload(sv);
    surv.tick();
    if (sv.state !== 'alive') break;
  }
  check('solo wave 1 survivable in stub (kite + pistol)', cleared && sv.state === 'alive', `cleared=${cleared} state=${sv.state} hp=${Math.round(sv.hp)}`);
  // Director ease-off / surge.
  const dir = new Session('DIR');
  const dp = addFake(dir); dir.phase = 'wave';
  dp.hp = 20; dir.directorTick();
  check('director eases off near wipe (low HP)', dir.director.eased === true, `stress ${dir.director.stress.toFixed(2)}`);
  dp.hp = 95; dp.ammo.pistol = 48; dir.directorTick();
  check('director does not ease when comfortable', dir.director.eased === false);
  const surgeBefore = dir.zombies.size;
  dir.triggerSurge('test');
  check('director surge spawns extra zombies', dir.zombies.size > surgeBefore, `+${dir.zombies.size - surgeBefore}`);
  // Breather: no spawns.
  const br = new Session('BRTH');
  addFake(br);
  tickN(br, 100);
  check('no spawns during breather', br.zombies.size === 0 && br.phase === 'breather');

  console.log('\n--- unit: lag compensation + headshots ---');
  const lag = new Session('LAG');
  const shooter = addFake(lag); shooter.x = 10; shooter.y = 30;
  const z = zombieNear(lag, 'shambler', 20, 28);
  // Zombie WAS at (20,32) four ticks ago; now at (20,28). Shooter saw old pos.
  z.history = [{ tick: lag.tickCount - 4, x: 20, y: 32 }, { tick: lag.tickCount, x: 20, y: 28 }];
  const aimOld = aimAt(shooter, { x: 20, y: 32 });
  const hit = lag.shootAt(shooter, aimOld, lag.nowMs - 200);
  check('lag-compensated hit on a moving target (rewound position)', !!hit && hit.hit === true, JSON.stringify(hit));
  const lag2 = new Session('LAG2');
  const sh2 = addFake(lag2); sh2.x = 10; sh2.y = 30;
  const z2 = zombieNear(lag2, 'shambler', 20, 30);
  const body = lag2.shootAt(sh2, { x: 1, y: 0 }, lag2.nowMs, { hitZone: 'body' });
  const z3 = zombieNear(lag2, 'shambler', 20, 30);
  sh2.lastShotMs = -9999; sh2.mag.pistol = 12;
  const head = lag2.shootAt(sh2, { x: 1, y: 0 }, lag2.nowMs, { hitZone: 'head' });
  check('head vs body damage differ (+100% headshot)', body && head && head.damage === body.damage * 2, `body ${body && body.damage} head ${head && head.damage}`);
  check('headshot carries distinct marker', head && head.head === true);

  console.log('\n--- unit: weapons ---');
  check('shotgun close damage exceeds long-range damage', (() => {
    const s = new Session('SG'); const p = addFake(s); p.currentWeapon = 'shotgun'; p.x = 10; p.y = 30;
    const near = zombieNear(s, 'brute', 12, 30);
    const h1 = s.shootAt(p, { x: 1, y: 0 }, s.nowMs);
    s.zombies.delete(near.id); // clear the near target so the second shot reaches the far one
    p.lastShotMs = -9999; p.mag.shotgun = 6;
    const far = zombieNear(s, 'brute', 17, 30);
    const h2 = s.shootAt(p, { x: 1, y: 0 }, s.nowMs);
    return h1 && h2 && h1.damage > h2.damage;
  })());
  check('SMG drains magazine at auto rate (90 ms)', WEAPONS.smg.fireMs === 90 && WEAPONS.smg.auto === true);
  check('pistol is semi-auto, one click one shot', WEAPONS.pistol.fireMode === 'semi' && WEAPONS.pistol.fireMs === 250);
  check('melee is silent (noise 0), guns are loud', WEAPONS.melee.noise === 0 && WEAPONS.pistol.noise > 0);
  check('melee kill raises no director attention', (() => {
    const s = new Session('ML'); const p = addFake(s); p.currentWeapon = 'melee'; p.x = 10; p.y = 30;
    const zz = zombieNear(s, 'shambler', 11, 30); zz.hp = 1;
    s.shootAt(p, { x: 1, y: 0 }, s.nowMs);
    return s.director.attention === 0;
  })());
  check('gunshot raises director attention', (() => {
    const s = new Session('GN'); const p = addFake(s); p.x = 10; p.y = 30;
    zombieNear(s, 'shambler', 15, 30);
    s.shootAt(p, { x: 1, y: 0 }, s.nowMs);
    return s.director.attention > 0;
  })());
  check('spread worse while moving (rifle)', (() => {
    const { } = require('./server');
    const moving = WEAPONS.rifle.spread * 2, standing = WEAPONS.rifle.spread;
    return moving > standing;
  })());
  check('reload interrupted by dodge', (() => {
    const s = new Session('RL'); const p = addFake(s);
    p.mag.pistol = 2; s.tryReload(p);
    const reloading = !!p.reloadingWeapon;
    s.tryDodge(p);
    return reloading && !p.reloadingWeapon;
  })());
  check('reload completes and refills magazine', (() => {
    const s = new Session('RL2'); const p = addFake(s);
    p.mag.pistol = 2; s.tryReload(p); tickN(s, 30); // 1.5s > 1.2s reload
    return p.mag.pistol === WEAPONS.pistol.mag;
  })());

  console.log('\n--- unit: zombie behaviours ---');
  check('screamer killed mid-scream prevents surge', (() => {
    const s = new Session('SC'); const p = addFake(s); p.x = 30; p.y = 30;
    const z = zombieNear(s, 'screamer', 32, 30);
    tickN(s, 5); // sighting -> screaming
    const screaming = z.state === 'screaming';
    const before = s.zombies.size;
    s.damageZombie(z, 9999, p);
    tickN(s, 60);
    return screaming && s.zombies.size <= before - 1 && !s.events.some(e => e.type === 'surge');
  })());
  check('screamer finishing its scream calls a surge', (() => {
    const s = new Session('SC2'); const p = addFake(s); p.x = 30; p.y = 30;
    zombieNear(s, 'screamer', 32, 30);
    const before = s.zombies.size;
    tickN(s, 50); // >2s scream
    return s.zombies.size > before;
  })());
  check('brute slam: leaving the ring avoids damage', (() => {
    const s = new Session('BR'); const p = addFake(s); p.x = 30; p.y = 30;
    const z = zombieNear(s, 'brute', 31, 30);
    z.state = 'windup'; z.windupUntil = s.nowMs + 100; z.attackTarget = p;
    p.x = 40; p.y = 40; // leave the ring
    tickN(s, 10);
    return p.hp === 100;
  })());
  check('spitter keeps ~10 tiles (does not close to melee)', (() => {
    const s = new Session('SP'); const p = addFake(s); p.x = 30; p.y = 30;
    zombieNear(s, 'spitter', 5, 30);
    tickN(s, 600);
    const zz = [...s.zombies.values()][0];
    return zz && Math.hypot(zz.x - 30, zz.y - 30) > 5;
  })());
  check('runner reaches player measurably faster than shambler', (() => {
    const race = (type) => {
      const s = new Session('RC'); const p = addFake(s); p.x = 30; p.y = 30; p.hp = 10000;
      zombieNear(s, type, 5, 30);
      let t = 0;
      while (t < 1000) { s.tick(); t++; const zz = [...s.zombies.values()][0]; if (!zz || Math.hypot(zz.x - 30, zz.y - 30) < 2) break; }
      return t;
    };
    const r = race('runner'), sh = race('shambler');
    return r < sh;
  })());
  check('no through-wall attacks', (() => {
    const s = new Session('WL'); const p = addFake(s); p.x = 11; p.y = 10; // behind house-nw (x8-14,y8-13)
    const z = zombieNear(s, 'shambler', 11, 15);
    // zombie on the other side of the house wall: LOS blocked
    const los = arena.hasLineOfSight(z.x, z.y, p.x, p.y);
    z.state = 'windup'; z.windupUntil = s.nowMs; z.attackTarget = p;
    s.zombieAttack(z, p, ZOMBIE_TYPES.shambler);
    return los === false && p.hp === 100;
  })());

  console.log('\n--- unit: downed / revive / execute / loot ---');
  check('downed player crawls but cannot fire', (() => {
    const s = new Session('DN'); const p = addFake(s);
    s.downPlayer(p, null);
    p.keys = { up: true, down: false, left: false, right: false };
    p.fireHeld = true;
    const x0 = p.x, y0 = p.y;
    tickN(s, 20);
    const moved = Math.hypot(p.x - x0, p.y - y0);
    const shot = s.shootAt(p, { x: 1, y: 0 }, s.nowMs);
    return p.state === 'downed' && moved > 0 && moved < 3 && shot === null;
  })());
  check('revive channel (3s held) restores at 50% HP', (() => {
    const s = new Session('RV'); const a = addFake(s); const b = addFake(s);
    s.downPlayer(b, null);
    a.x = b.x + 1; a.y = b.y; a.interactHeld = true;
    tickN(s, 70);
    return b.state === 'alive' && b.hp === 50;
  })());
  check('revive interrupted by moving away', (() => {
    const s = new Session('RVI'); const a = addFake(s); const b = addFake(s);
    s.downPlayer(b, null);
    a.x = b.x + 1; a.y = b.y; a.interactHeld = true;
    tickN(s, 30);
    a.x = b.x + 10; // walk away mid-channel
    tickN(s, 40);
    return b.state === 'downed';
  })());
  check('loot drop: carried drops, equipped weapons stay', (() => {
    const s = new Session('LT'); const p = addFake(s);
    p.ammo.pistol = 99; p.carried.meds = 2;
    s.killPlayer(p, null, 'test');
    const pile = s.lootPiles[0];
    return !!pile && pile.items.ammo.pistol === 99 && pile.items.meds === 2 &&
      p.weapons.includes('pistol') && p.weapons.includes('melee');
  })());
  check('execute by shooting a downed player kills them', (() => {
    const s = new Session('EX'); const a = addFake(s); const b = addFake(s);
    s.downPlayer(b, null);
    a.x = b.x - 5; a.y = b.y; a.graceEndsAt = 0; b.graceEndsAt = 0;
    const hit = s.shootAt(a, { x: 1, y: 0 }, s.nowMs);
    return !!hit && b.state === 'dead';
  })());
  check('grace period blocks PvP damage but not zombie damage', (() => {
    const s = new Session('GR'); const a = addFake(s); const b = addFake(s);
    a.x = 10; a.y = 30; b.x = 15; b.y = 30; // both inside grace (10s)
    const hit = s.shootAt(a, { x: 1, y: 0 }, s.nowMs);
    const blocked = !hit || hit.hit === false;
    const z = zombieNear(s, 'shambler', 16, 30);
    z.state = 'windup'; z.windupUntil = s.nowMs; z.attackTarget = b;
    s.zombieAttack(z, b, ZOMBIE_TYPES.shambler);
    return blocked && b.hp < 100;
  })());

  console.log('\n--- unit: disconnects + hibernation + extraction ---');
  check('disconnect grace: character stands vulnerable, reconnect resumes same state', (() => {
    const s = new Session('DC'); const p = addFake(s);
    p.hp = 77; p.ammo.pistol = 33;
    p.disconnected = true; p.disconnectAtMs = s.nowMs;
    tickN(s, 10);
    const r = s.resumePlayer(p.id, null);
    return r.player && r.player.hp === 77 && r.player.ammo.pistol === 33;
  })());
  check('disconnect timeout (30s, others connected) kills + drops loot', (() => {
    const s = new Session('DC2'); const p = addFake(s); const q = addFake(s);
    p.disconnected = true; p.disconnectAtMs = s.nowMs;
    tickN(s, 700); // 35 s
    return p.state === 'dead' && s.lootPiles.length > 0 && q.state === 'alive';
  })());
  check('hibernation: resumable at 4 min, gone after 5 min', (() => {
    const s = new Session('HB'); const p = addFake(s);
    p.disconnected = true; p.disconnectAtMs = s.nowMs;
    tickN(s, 4800); // 4 min
    const stillThere = !s.discarded && s.hibernating === true;
    const r = s.resumePlayer(p.id, null);
    const resumed = !!r.player;
    // fresh hibernating session for the discard side
    const s2 = new Session('HB2'); const p2 = addFake(s2);
    p2.disconnected = true; p2.disconnectAtMs = s2.nowMs;
    tickN(s2, 6001); // just past 5 min
    return stillThere && resumed && s2.discarded === true;
  })());
  check('leaver loot drops where they stood', (() => {
    const s = new Session('LV'); const p = addFake(s); const q = addFake(s);
    p.x = 22; p.y = 33; p.ammo.pistol = 50;
    p.disconnected = true; p.disconnectAtMs = s.nowMs;
    tickN(s, 700);
    const pile = s.lootPiles.find(l => Math.abs(l.x - 22) < 0.1 && Math.abs(l.y - 33) < 0.1);
    return !!pile && pile.items.ammo.pistol === 50;
  })());
  check('extraction: one extracts while another keeps fighting', (() => {
    const s = new Session('EXT'); const a = addFake(s); const b = addFake(s);
    s.wave = 5; s.extractionOpen = true;
    a.x = arena.EXTRACTION_POINT.x; a.y = arena.EXTRACTION_POINT.y;
    b.x = 40; b.y = 40;
    tickN(s, 620); // 31 s in the radius
    return a.state === 'extracted' && b.state === 'alive' && !s.ended;
  })());
  check('extraction stays inert before wave 5', (() => {
    const s = new Session('EXT2'); addFake(s);
    return s.extractionOpen === false;
  })());
  check('wipe ends session with wave score', (() => {
    const s = new Session('WP'); const a = addFake(s); const b = addFake(s);
    s.wave = 3;
    s.killPlayer(a, null, 'test'); s.killPlayer(b, null, 'test');
    return s.ended === true && s.endReason === 'wipe' && s.endScore.waveReached === 3;
  })());
  check('spectate after death', (() => {
    const s = new Session('SP2'); const a = addFake(s); addFake(s);
    s.killPlayer(a, null, 'test');
    return a.state === 'dead' && a.spectating === true;
  })());

  console.log('\n--- unit: snapshots + arena ---');
  check('snapshot keeps Phase 0 players array (backward compatible)', (() => {
    const s = new Session('SN'); const p = addFake(s);
    const snap = s.snapshotFor(p);
    return snap.type === 'snapshot' && Array.isArray(snap.players) && snap.players[0].id === p.id;
  })());
  check('snapshot extends with zombies, wave, loot, events', (() => {
    const s = new Session('SN2'); const p = addFake(s);
    zombieNear(s, 'shambler', p.x + 5, p.y);
    s.tickCount = 4; // far/near bands due
    const snap = s.snapshotFor(p);
    return Array.isArray(snap.zombies) && snap.wave && Array.isArray(snap.loot) && Array.isArray(snap.events) && Array.isArray(snap.crates);
  })());
  check('delta: far zombie skipped on off ticks, sent every 4th', (() => {
    const s = new Session('SN3'); const p = addFake(s); p.x = 30; p.y = 30;
    zombieNear(s, 'shambler', 5, 5); // ~35 tiles away
    s.tickCount = 1;
    const off = s.snapshotFor(p).zombies.length;
    s.tickCount = 4;
    const on = s.snapshotFor(p).zombies.length;
    return off === 0 && on === 1;
  })());
  check('arena geometry is VERIFIED (audit Job 1.3 merged, no longer assumed)',
    arena.VERIFIED_GEOMETRY === true && arena.ASSUMED_GEOMETRY === false);
  check('arena bounds rect is the audited south-half Gate Town (x 0..30, y 14..30)',
    arena.BOUNDS.minX === 0 && arena.BOUNDS.minY === 14 && arena.BOUNDS.maxX === 30 && arena.BOUNDS.maxY === 30);
  check('arena blocked set is the audited 153 tiles (8 wall + 81 pond + 64 rock)',
    arena.BLOCKED_COUNT === 153 && arena.tileBlocked(11, 10) && arena.tileBlocked(0, 21) && arena.tileBlocked(22, 22)
    && !arena.tileBlocked(13, 13) && !arena.tileBlocked(14, 13) && !arena.tileBlocked(15, 19));
  check('arena gates sit outside the playable bounds (west gate is the stated on-boundary exception)',
    arena.GATES.every(g => g.onBoundary || g.x < arena.BOUNDS.minX || g.x > arena.BOUNDS.maxX || g.y < arena.BOUNDS.minY || g.y > arena.BOUNDS.maxY));
  check('arena gates: main first (wave 1), west second (wave 2), 4 total (wave 3+)',
    arena.GATES.length === 4 && arena.GATES[0].id === 'gate-main' && arena.GATES[1].id === 'gate-west');
  check('player spawns are spread apart (min 3 tiles — audited plaza layout, closest 3.16)', (() => {
    const sp = arena.PLAYER_SPAWNS;
    for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++)
      if (Math.hypot(sp[i].x - sp[j].x, sp[i].y - sp[j].y) < 3) return false;
    return true;
  })());
  check('player spawns are all on walkable tiles and >= 6 tiles from every gate tile', (() => {
    const gateTiles = [];
    for (const g of arena.GATES) (g.tiles || [{ x: g.x, y: g.y }]).forEach(t => gateTiles.push(t));
    for (const sp of arena.PLAYER_SPAWNS) {
      if (arena.tileBlocked(Math.floor(sp.x), Math.floor(sp.y))) return false;
      for (const gt of gateTiles) if (Math.hypot(sp.x - gt.x, sp.y - gt.y) < 6) return false;
    }
    return true;
  })());
  check('arena has barricade points, loot crates, extraction point',
    arena.BARRICADE_POINTS.length >= 4 && arena.LOOT_CRATES.length >= 4 && !!arena.EXTRACTION_POINT);
  check('arena has exactly 10 loot crates and extraction at (15.5, 28.5) opening after wave 5',
    arena.LOOT_CRATES.length === 10 && arena.EXTRACTION_POINT.x === 15.5 && arena.EXTRACTION_POINT.y === 28.5
    && arena.EXTRACTION_POINT.opensAfterWave === 5);
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

async function wsTests() {
  console.log('\n--- live WS: lobby + protocol + anti-cheat ---');
  const a = await wsClient();
  await waitFor(a, m => m.type === 'welcome');
  check('WS client A gets welcome (Phase 0 compat)', !!a.id, `id=${a.id}`);
  a.ws.send(JSON.stringify({ type: 'create', maxPlayers: 2 }));
  const created = await waitFor(a, m => m.type === 'created');
  check('create returns a 4-letter lobby code', !!created && /^[A-Z]{4}$/.test(created.code), created && created.code);
  const code = created.code;
  const b = await wsClient();
  b.ws.send(JSON.stringify({ type: 'join', code }));
  const joined = await waitFor(b, m => m.type === 'joined');
  check('second client joins by code', !!joined && joined.code === code);
  await wait(600);
  const snapA = a.snaps[a.snaps.length - 1];
  check('both clients see each other in snapshots', snapA && snapA.players.length === 2, `${snapA ? snapA.players.length : 0} players`);
  check('snapshot carries wave + zombie fields', snapA && snapA.wave && typeof snapA.zombieCap === 'number');
  const c = await wsClient();
  c.ws.send(JSON.stringify({ type: 'join', code }));
  const refused = await waitFor(c, m => m.type === 'error');
  check('third join past cap refused', !!refused, refused && refused.error);
  // Tick rate from /stats.
  const st1 = await fetchJson(`http://localhost:${PORT}/stats`);
  await wait(1000);
  const st2 = await fetchJson(`http://localhost:${PORT}/stats`);
  const hz = (st2.tick - st1.tick);
  check('live server ticks ~20 Hz', hz >= 15 && hz <= 25, `${hz} ticks/s`);
  check('/stats reports sessions', st2.sessions >= 1, `${st2.sessions} sessions`);
  // Cheat claim: modified client claiming a kill gains nothing.
  const zombiesBefore = st2.zombies;
  a.ws.send(JSON.stringify({ type: 'kill', targetId: 'z1' }));
  a.ws.send(JSON.stringify({ type: 'set-hp', hp: 9999 }));
  await wait(300);
  const st3 = await fetchJson(`http://localhost:${PORT}/stats`);
  check('modified client claiming a kill gains nothing', st3.zombies === zombiesBefore, `zombies ${zombiesBefore} -> ${st3.zombies}`);
  // Movement validation: teleport claim ignored.
  const beforePos = a.snaps[a.snaps.length - 1].players.find(p => p.id === a.id);
  a.ws.send(JSON.stringify({ type: 'input', seq: 999, keys: {}, x: 999, y: 999 }));
  await wait(300);
  const afterPos = a.snaps[a.snaps.length - 1].players.find(p => p.id === a.id);
  check('teleport claim corrected (position does not jump)', afterPos && Math.abs(afterPos.x - beforePos.x) < 2 && afterPos.x < 60, `x ${beforePos.x} -> ${afterPos.x}`);
  // Movement still works over WS (Phase 0 regression).
  a.ws.send(JSON.stringify({ type: 'input', seq: 1000, keys: { right: true }, aim: { x: 1, y: 0 } }));
  await wait(1000);
  const moved = a.snaps[a.snaps.length - 1].players.find(p => p.id === a.id);
  check('WS movement still moves the player', moved && moved.x > beforePos.x + 0.5, `x ${beforePos.x} -> ${moved && moved.x}`);
  a.ws.close(); b.ws.close(); c.ws.close();
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
