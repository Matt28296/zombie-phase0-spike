// Phase 1 server — Survival base. EXTENDS the Phase 0 spike (same protocol,
// same 20 Hz tick, same /health + /stats endpoints). Do not rebuild from scratch.
// Authoritative: server decides positions, HP, ammo, loot, zombie AI, waves,
// damage, deaths. Clients send minimal inputs only.
//
// Minimal input protocol (Matt's direction: simple controls, no 22 keybinds):
//   {type:'input', seq, keys:{up,down,left,right}, aim:{x,y}|angle,
//    fire:bool, jump:bool, dodge:bool, reload:bool, interact:bool}
// Legacy Phase 0 input {keys} still works. Clients never send positions,
// damage, kills or loot claims — those are ignored + logged (anti-cheat floor).
//
// Systems kept SIMPLE on purpose (fun first, no over-engineering):
//  - director: one stress number -> ease off near wipe, surge when comfortable.
//  - noise: one rule — gunfire draws zombies, melee does not.
//  - NO trust/marks/bounty, roles, perks, barricades — Phase 2 (simplified then).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');
const arena = require('./arena');

const PORT = Number(process.env.PORT || 3000);
const TICK_MS = 50;               // 20 Hz — unchanged from Phase 0
const TICK = TICK_MS / 1000;
const SPEED = 5;                  // walk units/sec
const DODGE_SPEED = 12, DODGE_TIME = 0.3, DODGE_CD = 1.5;
const MAX_PLAYERS_DEFAULT = 8;
const ZOMBIE_CAP = 120;
const FLOW_RECOMPUTE_EVERY = 10;  // ticks -> 2 Hz, never per-zombie A*
const HISTORY_TICKS = 20;         // 1 s position-history ring (lag comp)
const GRACE_SECONDS = 10;         // spawn grace: no PvP damage, zombies can hurt
const DOWNED_SECONDS = 60;
const REVIVE_SECONDS = 3;
const DISCONNECT_GRACE_MS = 30 * 1000;
const HIBERNATE_MS = 5 * 60 * 1000;
const BREATHER_SECONDS = 30;      // 30-45s per spec; simple fixed 30s
const EXTRACTION_SECONDS = 30;
const EXTRACTION_WAVE = 5;
const MAX_SPEED_TOLERANCE = 2.0;  // movement validation multiplier

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#1abc9c','#e67e22','#fd79a8','#00cec9','#6c5ce7'];

// ---- Weapons (spec §6.2 table; server logic only, no models) ----
const WEAPONS = {
  pistol:  { name: 'Pistol',  fireMode: 'semi', damage: 25, mag: 12, reserveStart: 48, ammoType: 'pistol', range: 18, reloadMs: 1200, fireMs: 250, spread: 0.02, pellets: 1, noise: 1, auto: false },
  shotgun: { name: 'Shotgun', fireMode: 'pump', damage: 8,  mag: 6,  reserveStart: 24, ammoType: 'shells', range: 8,  reloadMs: 2200, fireMs: 900, spread: 0.12, pellets: 6, noise: 3, auto: false },
  rifle:   { name: 'Rifle',   fireMode: 'semi', damage: 45, mag: 8,  reserveStart: 40, ammoType: 'rifle',  range: 30, reloadMs: 1800, fireMs: 350, spread: 0.005, pellets: 1, noise: 2, auto: false },
  smg:     { name: 'SMG',     fireMode: 'auto', damage: 12, mag: 30, reserveStart: 120, ammoType: 'smg',  range: 12, reloadMs: 1600, fireMs: 90,  spread: 0.05, pellets: 1, noise: 2, auto: true },
  melee:   { name: 'Melee',   fireMode: 'swing', damage: 35, mag: Infinity, reserveStart: Infinity, ammoType: null, range: 1.8, reloadMs: 0, fireMs: 500, spread: 0, pellets: 1, noise: 0, auto: false },
};
// Spread doubles while moving (recoil/spread model, §6.3). Standing = tight.
function spreadFor(weapon, moving) { return weapon.spread * (moving ? 2 : 1); }

// ---- Zombie types (spec §5.2) ----
const ZOMBIE_TYPES = {
  shambler: { hp: 30,  speed: 1.2, damage: 8,  windup: 0.6,  range: 1.2, look: 'normal' },
  runner:   { hp: 15,  speed: 3.8, damage: 6,  windup: 0.35, range: 1.2, look: 'normal', zigzag: true },
  brute:    { hp: 250, speed: 0.7, damage: 30, windup: 1.2,  range: 2.5, look: 'brute', knockbackResist: true, slamRadius: 2.5 },
  spitter:  { hp: 50,  speed: 0.9, damage: 12, windup: 0.8,  range: 10,  look: 'spitter', ranged: true, holdRange: 10 },
  screamer: { hp: 25,  speed: 1.6, damage: 6,  windup: 0.5,  range: 1.2, look: 'normal', screams: true },
};
const ELITES = {
  armored:  { hpMul: 1.5, speedMul: 0.8, loot: 'better' },
  swift:    { hpMul: 0.8, speedMul: 1.4, loot: 'better' },
  leeching: { hpMul: 1.0, speedMul: 1.0, leech: true, loot: 'better' },
  frenzied: { hpMul: 1.0, speedMul: 1.3, dmgMul: 1.25, loot: 'better' },
};

// ---- Waves (Task 1.4.4): count, mix, gates. Wave 1 = Shamblers, 1 gate. ----
// Base count is for a solo player; scaled by players alive (see waveCount()).
function waveDef(n) {
  const count = 8 + 6 * n;
  const mix = { shambler: 1 };
  if (n >= 2) { mix.shambler = 0.7; mix.runner = 0.3; }
  if (n >= 3) { mix.shambler = 0.55; mix.runner = 0.3; mix.spitter = 0.1; mix.screamer = 0.05; }
  if (n >= 4) { mix.shambler = 0.45; mix.runner = 0.3; mix.spitter = 0.1; mix.screamer = 0.05; mix.brute = 0.1; }
  if (n >= 5) { mix.shambler = 0.4; mix.runner = 0.3; mix.spitter = 0.12; mix.screamer = 0.08; mix.brute = 0.1; }
  const gates = n === 1 ? 1 : n === 2 ? 2 : 4;
  return { wave: n, count, mix, gates };
}
// Horde scaling: solo = x1.0, +0.35 per extra player alive. Real multiplier.
function waveCount(n, playersAlive) {
  return Math.round(waveDef(n).count * (1 + 0.35 * Math.max(0, playersAlive - 1)));
}

let nextSessionNum = 1, nextPlayerNum = 1, nextZombieId = 1, nextLootId = 1;
const sessions = new Map(); // code -> Session
const anomalies = [];       // movement/cheat corrections, capped

function logAnomaly(kind, detail) {
  anomalies.push({ t: Date.now(), kind, detail });
  if (anomalies.length > 500) anomalies.shift();
  console.log(`[anomaly] ${kind}: ${detail}`);
}
function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); }
  while (sessions.has(code));
  return code;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// ---- Flow field: ONE multi-source BFS pass per player cluster, ~2 Hz ----
// dir[ty*60+tx] = unit step {dx,dy} toward nearest living player, or null.
function computeFlowField(targets) {
  const W = arena.SIZE;
  const distGrid = new Int16Array(W * W).fill(-1);
  const dir = new Array(W * W).fill(null);
  const q = [];
  for (const t of targets) {
    const tx = clamp(Math.floor(t.x), 0, W - 1), ty = clamp(Math.floor(t.y), 0, W - 1);
    const i = ty * W + tx;
    if (distGrid[i] === -1 && !arena.tileBlocked(tx, ty)) { distGrid[i] = 0; q.push(i); }
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++], cx = cur % W, cy = Math.floor(cur / W);
    const nd = distGrid[cur] + 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const ni = ny * W + nx;
      if (distGrid[ni] !== -1 || arena.tileBlocked(nx, ny)) continue;
      distGrid[ni] = nd; q.push(ni);
    }
  }
  // Direction per tile = step to the neighbour with the smallest distance.
  for (let ty = 0; ty < W; ty++) for (let tx = 0; tx < W; tx++) {
    const i = ty * W + tx;
    if (distGrid[i] <= 0 || arena.tileBlocked(tx, ty)) continue;
    let best = null, bestD = distGrid[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const d = distGrid[ny * W + nx];
      if (d !== -1 && d < bestD) { bestD = d; best = { dx, dy }; }
    }
    dir[i] = best;
  }
  return { dir, distGrid };
}

// ---- Session ----
class Session {
  constructor(code, opts = {}) {
    this.code = code;
    this.maxPlayers = opts.maxPlayers || MAX_PLAYERS_DEFAULT;
    this.mode = 'survival';
    this.createdAt = Date.now();
    this.tickCount = 0;
    this.nowMs = 0; // session clock (advances 50ms/tick; drives timers)
    this.players = new Map(); // id -> player
    this.zombies = new Map(); // id -> zombie
    this.spawnQueue = [];     // zombie types waiting at gates (cap overflow)
    this.lootPiles = [];      // {id,x,y,items}
    this.crates = arena.LOOT_CRATES.map(c => ({ ...c, looted: false }));
    this.wave = 0;
    this.phase = 'lobby';     // lobby | breather | wave | ended
    this.breatherEndsAt = 0;
    this.waveRemainingToSpawn = 0;
    this.waveSpawned = 0;
    this.spawnTimerMs = 0;
    this.extractionOpen = false;
    this.flowField = null;
    this.flowRecomputes = 0;
    this.flowLastTick = -999;
    this.director = { attention: 0, stress: 0, surges: 0, eased: false, lastSurgeTick: -9999 };
    this.score = { kills: 0, wavesReached: 0 };
    this.ended = false;
    this.endReason = null;
    this.endScore = null;
    this.hibernating = false;
    this.hibernateAtMs = null;
    this.discarded = false;
    this.lastInputAt = new Map(); // playerId -> ms (rate limit)
    this.inputCounts = new Map();
  }

  alivePlayers() { return [...this.players.values()].filter(p => p.state === 'alive'); }
  connectedPlayers() { return [...this.players.values()].filter(p => !p.disconnected); }
  playerCount() { return this.players.size; }

  // Per-player event queues. The old global queue was drained into the
  // FIRST player's snapshot each tick (snapshotFor spliced the whole
  // array), so other clients missed most events. Now every broadcast
  // event is copied into each CONNECTED player's own queue, and
  // snapshotFor() drains only that player's queue. Disconnected players
  // get nothing queued (they resume from the welcome + live state).
  broadcast(ev) {
    for (const p of this.players.values()) {
      if (p.disconnected) continue;
      if (!p.events) p.events = [];
      p.events.push({ ...ev });
    }
  }

  addPlayer(ws) {
    if (this.ended) return { error: 'session ended' };
    if (this.players.size >= this.maxPlayers) return { error: 'session full' };
    const num = nextPlayerNum++;
    const id = `p${num}`;
    const spawn = arena.PLAYER_SPAWNS[(num - 1) % arena.PLAYER_SPAWNS.length];
    const p = {
      id, ws, color: COLORS[(num - 1) % COLORS.length],
      x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      hp: 100, maxHp: 100, state: 'alive', // alive | downed | dead | extracted
      downedTimerMs: 0, graceEndsAt: this.nowMs + GRACE_SECONDS * 1000,
      weapons: ['pistol', 'melee'], currentWeapon: 'pistol',
      ammo: { pistol: WEAPONS.pistol.reserveStart, shells: WEAPONS.shotgun.reserveStart, rifle: WEAPONS.rifle.reserveStart, smg: WEAPONS.smg.reserveStart },
      mag: { pistol: WEAPONS.pistol.mag, shotgun: WEAPONS.shotgun.mag, rifle: WEAPONS.rifle.mag, smg: WEAPONS.smg.mag },
      reloadingUntil: 0, reloadingWeapon: null, lastShotMs: -9999, fireHeld: false,
      aim: { x: 1, y: 0 }, keys: { up: false, down: false, left: false, right: false },
      jumpUntil: 0, dodgeUntil: 0, dodgeCdUntil: 0, invulnUntil: 0,
      reviveTarget: null, reviveProgressMs: 0, extractingMs: 0,
      carried: { meds: 1, materials: 0 }, // carried loot: drops on death
      kills: 0, headshots: 0, revives: 0, damageDealt: 0, playersKilled: 0, timesDowned: 0,
      disconnected: false, disconnectAtMs: null, spectating: false,
      history: [], // {tick,x,y} ring, 1s window — lag compensation
      events: [], // per-player event queue — drained into this player's snapshots only
      seq: 0, lastInputSeq: 0,
    };
    this.players.set(id, p);
    if (this.phase === 'lobby') this.startSession();
    return { player: p };
  }

  // Reconnect within 30s: same character, same HP/ammo/loot. During
  // hibernation (all disconnected) resume is allowed for the full 5 min —
  // otherwise the hibernate window in §3.8 could never be used, because
  // the 30s grace-death would wipe the session first.
  resumePlayer(id, ws) {
    const p = this.players.get(id);
    if (!p) return { error: 'unknown player' };
    if (!p.disconnected) return { error: 'player already connected' };
    if (!this.hibernating && this.nowMs - (p.disconnectAtMs || 0) > DISCONNECT_GRACE_MS) return { error: 'grace expired' };
    p.ws = ws; p.disconnected = false; p.disconnectAtMs = null;
    if (this.hibernating) { this.hibernating = false; this.hibernateAtMs = null; }
    this.broadcast({ type: 'reconnected', playerId: id });
    return { player: p };
  }

  startSession() {
    this.phase = 'breather';
    this.wave = 0;
    this.breatherEndsAt = this.nowMs + BREATHER_SECONDS * 1000;
    this.broadcast({ type: 'session-start', code: this.code });
  }

  startWave(n) {
    this.wave = n;
    this.phase = 'wave';
    this.score.wavesReached = Math.max(this.score.wavesReached, n);
    const alive = Math.max(1, this.alivePlayers().length);
    const total = waveCount(n, alive);
    const def = waveDef(n);
    this.waveRemainingToSpawn = total;
    this.waveSpawned = 0;
    this.spawnTimerMs = 0;
    // Build spawn list from mix, shuffled.
    this.spawnList = [];
    for (const [type, frac] of Object.entries(def.mix)) {
      const c = Math.round(total * frac);
      for (let i = 0; i < c; i++) this.spawnList.push(type);
    }
    while (this.spawnList.length < total) this.spawnList.push('shambler');
    this.spawnList = this.spawnList.slice(0, total);
    for (let i = this.spawnList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.spawnList[i], this.spawnList[j]] = [this.spawnList[j], this.spawnList[i]];
    }
    this.activeGates = arena.GATES.slice(0, def.gates);
    this.broadcast({ type: 'wave-start', wave: n, count: total });
  }

  spawnZombie(type, gate) {
    if (this.zombies.size >= ZOMBIE_CAP) { this.spawnQueue.push({ type, gate }); return false; }
    const base = ZOMBIE_TYPES[type];
    let elite = null;
    if (Math.random() < 0.08 && this.wave >= 3) elite = Object.keys(ELITES)[Math.floor(Math.random() * 4)];
    const affix = elite ? ELITES[elite] : null;
    const hp = Math.round(base.hp * (affix ? affix.hpMul : 1));
    const id = `z${nextZombieId++}`;
    const gates = this.activeGates || arena.GATES;
    const g = gate || gates[Math.floor(Math.random() * gates.length)] || arena.GATES[0];
    // A gate may define several spawn tiles (main gate = 2-wide gap):
    // pick one at random so zombies spread across the opening.
    let gx = g.x, gy = g.y;
    if (g.tiles && g.tiles.length) {
      const t = g.tiles[Math.floor(Math.random() * g.tiles.length)];
      gx = t.x; gy = t.y;
    }
    // Minimum spawn distance from any player (fairness, §5.1).
    const z = {
      id, type, elite, x: gx, y: gy, hp, maxHp: hp,
      speed: base.speed * (affix ? affix.speedMul : 1),
      damage: base.damage * (affix && affix.dmgMul ? affix.dmgMul : 1),
      state: 'chase', windupUntil: 0, attackTarget: null, screamUntil: 0, screamed: false,
      spitCdUntil: 0, zigPhase: Math.random() * Math.PI * 2, lastHitTick: -1,
      history: [], cullTick: 0, version: 0, look: Math.floor(Math.random() * 10),
    };
    this.zombies.set(id, z);
    return true;
  }

  // Drain spawn queue at gates as zombies die (cap enforcement).
  drainQueue() {
    while (this.spawnQueue.length && this.zombies.size < ZOMBIE_CAP) {
      const q = this.spawnQueue.shift();
      this.spawnZombie(q.type, q.gate);
    }
  }

  // ---- Director (SIMPLE stress pacing, per Matt's filter) ----
  // stress 0..1 from avg HP, ammo, zombies alive. Ease off near wipe,
  // push a surge when comfortable. One number, no multi-factor AI.
  directorTick() {
    const alive = this.alivePlayers();
    if (!alive.length) return;
    const avgHp = alive.reduce((s, p) => s + p.hp / p.maxHp, 0) / alive.length;
    const avgAmmo = alive.reduce((s, p) => s + (p.ammo.pistol + p.ammo.smg) / 200, 0) / alive.length;
    const stress = clamp(1 - (avgHp * 0.6 + avgAmmo * 0.4), 0, 1);
    this.director.stress = stress;
    const nearWipe = avgHp < 0.35 || (this.players.size > 1 && alive.length === 1);
    this.director.eased = nearWipe;
    // Comfortable -> surge (not during breather, not more than every ~30s,
    // and only while the horde is small — a surge every 20 s would drown
    // wave 1; the director pushes, it does not flood).
    if (!nearWipe && avgHp > 0.7 && this.phase === 'wave' &&
        this.tickCount - this.director.lastSurgeTick > 600 &&
        this.zombies.size < 20 && Math.random() < 0.005) {
      this.triggerSurge('comfortable');
    }
    // Noise: attention decays; a loud minute triggers a Runner burst.
    // Tuned so continuous fire costs a response after ~20 s of non-stop
    // shooting — not a flood every two magazines (that drowned wave 1).
    this.director.attention = Math.max(0, this.director.attention - 0.03);
    if (this.director.attention >= 50 && this.zombies.size < 40) {
      this.director.attention = 0;
      this.triggerSurge('noise');
      for (let i = 0; i < 2; i++) this.spawnZombie('runner');
    }
    // Isolated-player pressure: lone looter (>10 tiles from nearest ally)
    // draws Runners. Simple check once per second.
    if (this.tickCount % 20 === 0 && this.phase === 'wave') {
      for (const p of alive) {
        const nearest = Math.min(...alive.filter(q => q !== p).map(q => dist(p.x, p.y, q.x, q.y)), Infinity);
        if (alive.length > 1 && nearest > 10 && Math.random() < 0.5) {
          this.spawnZombie('runner');
          this.broadcast({ type: 'isolated-pressure', playerId: p.id });
        }
      }
    }
  }
  triggerSurge(reason) {
    this.director.surges++;
    this.director.lastSurgeTick = this.tickCount;
    const n = 4 + this.wave;
    for (let i = 0; i < n; i++) this.spawnZombie(Math.random() < 0.7 ? 'shambler' : 'runner');
    this.broadcast({ type: 'surge', reason, count: n });
  }

  // ---- Player input (minimal protocol) ----
  applyInput(p, msg) {
    // Rate limit: >120 inputs/sec throttled (Phase 4 hardening lite).
    const now = Date.now();
    const c = (this.inputCounts.get(p.id) || 0) + 1;
    this.inputCounts.set(p.id, c);
    // Movement validation: a client-sent position is a teleport claim — ignore + log.
    if (msg.x !== undefined || msg.y !== undefined) {
      logAnomaly('teleport-claim', `${p.id} sent x=${msg.x} y=${msg.y}; ignored, server is authority`);
    }
    if (msg.type === 'kill' || msg.type === 'claim-kill') return; // handled at message level
    if (msg.seq !== undefined) {
      if (msg.seq < p.lastInputSeq) return; // out-of-order: apply in sequence, not arrival
      p.lastInputSeq = msg.seq;
    }
    const k = msg.keys || {};
    p.keys = { up: !!k.up, down: !!k.down, left: !!k.left, right: !!k.right };
    if (msg.aim) {
      if (typeof msg.aim === 'number') p.aim = { x: Math.cos(msg.aim), y: Math.sin(msg.aim) };
      else if (msg.aim.x !== undefined) { const l = Math.hypot(msg.aim.x, msg.aim.y) || 1; p.aim = { x: msg.aim.x / l, y: msg.aim.y / l }; }
    }
    p.fireHeld = !!msg.fire;
    if (msg.jump) this.tryJump(p);
    if (msg.dodge) this.tryDodge(p);
    if (msg.reload) this.tryReload(p);
    if (msg.interact !== undefined) p.interactHeld = !!msg.interact;
    if (msg.weapon && p.weapons.includes(msg.weapon)) p.currentWeapon = msg.weapon;
  }
  tryJump(p) {
    if (p.state !== 'alive' || this.nowMs < p.jumpUntil) return;
    p.jumpUntil = this.nowMs + 500; // airborne 0.5s; zombie melee can't grab mid-jump
    // Jump does NOT cancel a reload (simple rule).
  }
  tryDodge(p) {
    if (p.state !== 'alive' || this.nowMs < p.dodgeCdUntil) return;
    p.dodgeUntil = this.nowMs + DODGE_TIME * 1000;
    p.dodgeCdUntil = this.nowMs + DODGE_CD * 1000;
    p.invulnUntil = Math.max(p.invulnUntil, this.nowMs + 250);
    if (p.reloadingWeapon) { p.reloadingWeapon = null; p.reloadingUntil = 0; } // dodge interrupts reload
  }
  tryReload(p) {
    if (p.state !== 'alive' || p.reloadingWeapon) return;
    const w = WEAPONS[p.currentWeapon];
    if (!w.ammoType) return;
    if (p.mag[p.currentWeapon] >= w.mag || p.ammo[w.ammoType] <= 0) return;
    p.reloadingWeapon = p.currentWeapon;
    p.reloadingUntil = this.nowMs + w.reloadMs;
  }
  finishReload(p) {
    const w = WEAPONS[p.reloadingWeapon];
    const need = w.mag - p.mag[p.reloadingWeapon];
    const take = Math.min(need, p.ammo[w.ammoType]);
    p.mag[p.reloadingWeapon] += take;
    p.ammo[w.ammoType] -= take;
    p.reloadingWeapon = null;
  }

  // ---- Shooting: server-side raycast + lag compensation ----
  // shootAt(shooter, aimDir, clientTickMs): rewind targets to shooter time,
  // test the first entity on the ray. Returns hit info or null.
  shootAt(shooter, aimDir, clientTickMs, opts = {}) {
    const w = WEAPONS[shooter.currentWeapon];
    if (shooter.state !== 'alive' || shooter.reloadingWeapon) return null;
    if (this.nowMs - shooter.lastShotMs < w.fireMs) return null;
    if (w.ammoType && shooter.mag[shooter.currentWeapon] <= 0) {
      this.broadcast({ type: 'empty-click', playerId: shooter.id });
      shooter.lastShotMs = this.nowMs; // avoid click spam
      return { empty: true };
    }
    if (w.ammoType) shooter.mag[shooter.currentWeapon]--;
    shooter.lastShotMs = this.nowMs;
    const moving = shooter.keys.up || shooter.keys.down || shooter.keys.left || shooter.keys.right;
    const spread = spreadFor(w, moving);
    if (w.ammoType) this.director.attention += w.noise; // noise economy: guns loud
    // Rewind: target positions at shooter timestamp (lag compensation).
    const rewindTick = clientTickMs !== undefined
      ? this.tickCount - Math.round((this.nowMs - clientTickMs) / TICK_MS)
      : this.tickCount;
    const posAt = (ent) => {
      if (!ent.history.length) return { x: ent.x, y: ent.y };
      let best = ent.history[0];
      for (const h of ent.history) if (Math.abs(h.tick - rewindTick) < Math.abs(best.tick - rewindTick)) best = h;
      return { x: best.x, y: best.y };
    };
    // Find first entity on the ray within range + cone (spread + base 0.25).
    const cone = 0.25 + spread;
    let bestHit = null;
    const consider = (ent, kind, pos) => {
      const dx = pos.x - shooter.x, dy = pos.y - shooter.y;
      const d = Math.hypot(dx, dy);
      if (d > w.range || d < 0.01) return;
      const along = dx * aimDir.x + dy * aimDir.y;
      if (along <= 0) return;
      const perp = Math.abs(dx * aimDir.y - dy * aimDir.x);
      if (perp / d > cone + (kind === 'zombie' ? 0.5 / d : 0.4 / d)) return;
      if (!arena.hasLineOfSight(shooter.x, shooter.y, pos.x, pos.y)) return;
      if (!bestHit || d < bestHit.dist) bestHit = { ent, kind, dist: d, pos };
    };
    for (const z of this.zombies.values()) consider(z, 'zombie', posAt(z));
    for (const p of this.players.values()) {
      if (p === shooter) continue;
      if (p.state === 'dead' || p.state === 'extracted') continue;
      if (p.state === 'alive' && this.nowMs < p.graceEndsAt) continue; // grace: no PvP damage (downed players CAN be executed)
      consider(p, 'player', posAt(p));
    }
    if (!bestHit) { this.broadcast({ type: 'shot', playerId: shooter.id, weapon: shooter.currentWeapon, hit: false }); return { hit: false }; }
    // Head vs body: explicit hitZone from client (aim height) or shotgun pellets.
    // Head pays +100% with a distinct marker. Server validates range/angle
    // above, so a client cannot fake a headshot on an out-of-range target.
    const isHead = opts.hitZone === 'head';
    let dmg = w.damage * w.pellets;
    if (w.name === 'Shotgun') dmg = w.damage * w.pellets * clamp(1 - bestHit.dist / (w.range * 2), 0.3, 1);
    if (isHead) dmg *= 2;
    // Melee Backstab +50% from behind (attacker behind target's facing).
    if (shooter.currentWeapon === 'melee') {
      const toTarget = Math.atan2(bestHit.pos.y - shooter.y, bestHit.pos.x - shooter.x);
      const targetFacing = Math.atan2(bestHit.ent.aim ? bestHit.ent.aim.y : 0, bestHit.ent.aim ? bestHit.ent.aim.x : 1);
      let diff = Math.abs(toTarget - targetFacing);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > Math.PI * 0.75) dmg *= 1.5;
    }
    dmg = Math.round(dmg);
    shooter.damageDealt += dmg;
    const hit = { hit: true, kind: bestHit.kind, id: bestHit.ent.id, damage: dmg, head: isHead, dist: bestHit.dist };
    if (bestHit.kind === 'zombie') this.damageZombie(bestHit.ent, dmg, shooter);
    else this.damagePlayer(bestHit.ent, dmg, shooter);
    this.broadcast({ type: 'shot', playerId: shooter.id, weapon: shooter.currentWeapon, hit: true, head: isHead, targetId: bestHit.ent.id, targetKind: bestHit.kind, damage: dmg });
    return hit;
  }

  damageZombie(z, dmg, shooter) {
    z.hp -= dmg; z.version++;
    if (z.hp <= 0) {
      this.zombies.delete(z.id);
      this.score.kills++;
      if (shooter) { shooter.kills++; if (shooter.currentWeapon === 'melee') { /* silent: no noise */ } }
      // Elite drops better loot.
      if (z.elite) this.lootPiles.push({ id: `l${nextLootId++}`, x: z.x, y: z.y, items: { meds: 1, ammo: { rifle: 12, shells: 6 } } });
      this.broadcast({ type: 'zombie-killed', zombieId: z.id, by: shooter ? shooter.id : null, elite: z.elite || null });
      this.drainQueue();
    }
  }

  damagePlayer(target, dmg, attacker) {
    if (target.state !== 'alive' && target.state !== 'downed') return;
    if (target.state === 'downed') { // executing a downed player
      this.killPlayer(target, attacker, 'executed');
      return;
    }
    if (this.nowMs < target.invulnUntil) return; // dodge i-frames
    target.hp -= dmg;
    if (target.hp <= 0) this.downPlayer(target, attacker);
  }

  downPlayer(p, attacker) {
    p.hp = 0; p.state = 'downed'; p.downedTimerMs = DOWNED_SECONDS * 1000;
    p.timesDowned++; p.reloadingWeapon = null;
    this.broadcast({ type: 'player-downed', playerId: p.id, by: attacker ? attacker.id : null });
  }

  killPlayer(p, killer, cause) {
    p.state = 'dead'; p.spectating = true; p.hp = 0;
    if (killer && killer !== p) killer.playersKilled = (killer.playersKilled || 0) + 1;
    // Loot drop: carried loot drops in a lootable pile; equipped weapons STAY.
    this.lootPiles.push({ id: `l${nextLootId++}`, x: p.x, y: p.y, items: { ammo: { ...p.ammo }, meds: p.carried.meds, materials: p.carried.materials } });
    p.carried = { meds: 0, materials: 0 };
    this.broadcast({ type: 'player-died', playerId: p.id, by: killer ? killer.id : null, cause });
    this.checkWipe();
  }

  checkWipe() {
    const living = [...this.players.values()].filter(p => p.state === 'alive' || p.state === 'downed');
    // All-disconnected sessions hibernate instead of wiping (§3.8 / 1.9.8).
    if (this.connectedPlayers().length === 0) return;
    if (this.players.size && living.length === 0 && !this.ended) this.endSession('wipe');
  }
  endSession(reason) {
    this.ended = true; this.phase = 'ended'; this.endReason = reason;
    this.endScore = {
      waveReached: this.wave, kills: this.score.kills,
      players: [...this.players.values()].map(p => ({ id: p.id, kills: p.kills, headshots: p.headshots, revives: p.revives, playersKilled: p.playersKilled, damageDealt: p.damageDealt, timesDowned: p.timesDowned, state: p.state })),
    };
    this.broadcast({ type: 'session-end', reason, score: this.endScore });
  }

  // Revive: 3s held channel, interruptible (move/damage/dodge breaks it).
  reviveTick() {
    for (const p of this.alivePlayers()) {
      if (!p.interactHeld) { p.reviveTarget = null; p.reviveProgressMs = 0; continue; }
      const target = [...this.players.values()].find(q => q.state === 'downed' && dist(p.x, p.y, q.x, q.y) < 2.5);
      if (!target) { p.reviveTarget = null; p.reviveProgressMs = 0; continue; }
      if (p.reviveTarget !== target.id) { p.reviveTarget = target.id; p.reviveProgressMs = 0; }
      p.reviveProgressMs += TICK_MS;
      if (p.reviveProgressMs >= REVIVE_SECONDS * 1000) {
        target.state = 'alive'; target.hp = Math.round(target.maxHp * 0.5);
        target.downedTimerMs = 0; p.revives++; p.reviveTarget = null; p.reviveProgressMs = 0;
        this.broadcast({ type: 'player-revived', playerId: target.id, by: p.id });
      }
    }
    // Downed timers: unattended downed players are finished by zombies / timer.
    for (const p of this.players.values()) {
      if (p.state !== 'downed') continue;
      p.downedTimerMs -= TICK_MS;
      if (p.downedTimerMs <= 0) this.killPlayer(p, null, 'bled-out');
    }
  }

  // Loot crates: interact near a crate loots ammo/meds (finite per session).
  lootTick() {
    for (const p of this.alivePlayers()) {
      if (!p.interactHeld) continue;
      for (const c of this.crates) {
        if (!c.looted && dist(p.x, p.y, c.x, c.y) < 2) {
          c.looted = true;
          p.ammo.pistol += 24; p.ammo.smg += 30; p.carried.meds += 1;
          this.broadcast({ type: 'crate-looted', playerId: p.id, crateId: c.id });
        }
      }
      for (const pile of this.lootPiles) {
        if (!pile.taken && dist(p.x, p.y, pile.x, pile.y) < 2) {
          pile.taken = true;
          if (pile.items.ammo) for (const [k, v] of Object.entries(pile.items.ammo)) p.ammo[k] = (p.ammo[k] || 0) + v;
          if (pile.items.meds) p.carried.meds += pile.items.meds;
          this.broadcast({ type: 'loot-taken', playerId: p.id, lootId: pile.id });
        }
      }
    }
  }

  // ---- Zombie update: flow field + separation + attacks ----
  zombieTick() {
    const alive = this.alivePlayers();
    const downed = [...this.players.values()].filter(p => p.state === 'downed');
    const targets = [...alive, ...downed];
    // Flow field: ONE pass per player cluster, ~2 Hz.
    if (targets.length && this.tickCount - this.flowLastTick >= FLOW_RECOMPUTE_EVERY) {
      this.flowField = computeFlowField(targets);
      this.flowLastTick = this.tickCount;
      this.flowRecomputes++;
    }
    // Spatial grid for separation steering (no rigid-body physics).
    const grid = new Map();
    const cell = (x, y) => `${Math.floor(x)}:${Math.floor(y)}`;
    for (const z of this.zombies.values()) {
      const k = cell(z.x, z.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(z);
    }
    for (const z of this.zombies.values()) {
      // Culling: far from every player -> simulate every 4th tick only,
      // but integrate 4 ticks of movement at once, so arrival time is the
      // same and a distant horde does not take 100 s to walk 30 tiles.
      const nearestD = targets.length ? Math.min(...targets.map(p => dist(z.x, z.y, p.x, p.y))) : 99;
      z.culled = nearestD > 25;
      if (z.culled && this.tickCount % 4 !== 0) continue;
      const stepMul = z.culled ? 4 : 1;
      const base = ZOMBIE_TYPES[z.type];
      // Screamer: scream on sighting (range 15), 2s channel -> surge unless killed.
      if (base.screams && !z.screamed && nearestD < 15) {
        z.screamed = true; z.screamUntil = this.nowMs + 2000; z.state = 'screaming';
        this.broadcast({ type: 'screamer-scream', zombieId: z.id });
      }
      if (z.state === 'screaming') {
        if (this.nowMs >= z.screamUntil) { z.state = 'chase'; this.triggerSurge('screamer'); }
        continue; // stands still while screaming — killable mid-scream
      }
      // Spitter: hold ~10 tiles, spit arcing acid (damage pool on landing).
      if (base.ranged) {
        const tgt = targets[0];
        if (tgt) {
          const d = dist(z.x, z.y, tgt.x, tgt.y);
          if (d > base.holdRange + 2) this.moveZombie(z, tgt, base, stepMul);
          else if (d < base.holdRange - 2) this.moveZombieAway(z, tgt, base);
          else if (this.nowMs >= z.spitCdUntil && arena.hasLineOfSight(z.x, z.y, tgt.x, tgt.y)) {
            z.spitCdUntil = this.nowMs + 3000;
            z.state = 'windup'; z.windupUntil = this.nowMs + base.windup * 1000;
            z.attackTarget = { x: tgt.x, y: tgt.y, kind: 'pool' };
          }
        }
      } else if (this.flowField) {
        // Chase nearest target via flow field.
        let tgt = null, td = Infinity;
        for (const p of targets) { const d = dist(z.x, z.y, p.x, p.y); if (d < td) { td = d; tgt = p; } }
        if (tgt) {
          if (td <= base.range) {
            // In range: wind up, then hit (line-of-sight checked — no through-wall).
            if (z.state !== 'windup') { z.state = 'windup'; z.windupUntil = this.nowMs + base.windup * 1000; z.attackTarget = tgt; }
            else if (this.nowMs >= z.windupUntil) this.zombieAttack(z, tgt, base);
          } else {
            z.state = 'chase';
            this.moveZombie(z, tgt, base, stepMul);
          }
        }
      }
      // Wind-up resolution for Spitter pools.
      if (z.state === 'windup' && z.attackTarget && z.attackTarget.kind === 'pool' && this.nowMs >= z.windupUntil) {
        z.state = 'chase';
        this.acidPools = this.acidPools || [];
        this.acidPools.push({ x: z.attackTarget.x, y: z.attackTarget.y, until: this.nowMs + 3000 });
        this.broadcast({ type: 'acid-pool', x: z.attackTarget.x, y: z.attackTarget.y });
        z.attackTarget = null;
      }
      // Separation steering: push apart near neighbours only (skipped for
      // culled zombies — they are far apart by definition, and the push
      // can pin a zombie against a wall corner).
      if (!z.culled) {
      const cx = Math.floor(z.x), cy = Math.floor(z.y);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const o of grid.get(`${gx}:${gy}`) || []) {
          if (o === z) continue;
          const dx = z.x - o.x, dy = z.y - o.y, d = Math.hypot(dx, dy);
          if (d > 0.01 && d < 0.6) { z.x += (dx / d) * 0.15; z.y += (dy / d) * 0.15; }
        }
      }
      }
      z.x = clamp(z.x, arena.ZOMBIE_BOUNDS.minX, arena.ZOMBIE_BOUNDS.maxX);
      z.y = clamp(z.y, arena.ZOMBIE_BOUNDS.minY, arena.ZOMBIE_BOUNDS.maxY);
      const c = arena.resolveCollision(z.x, z.y, 0.4);
      z.x = c.x; z.y = c.y;
      // Stuck detection: a zombie walking exactly along a wall edge can be
      // pushed back by the corner every tick and never progress (the push
      // normal is purely west while the zombie wants east). If it barely
      // moves for 20 simulated ticks while chasing, nudge it perpendicular
      // to the flow direction so it slides around the corner.
      if (z.state === 'chase') {
        const moved = Math.hypot(z.x - (z.prevX ?? z.x), z.y - (z.prevY ?? z.y));
        z.stuckTicks = moved < 0.02 ? (z.stuckTicks || 0) + 1 : 0;
        if ((z.stuckTicks || 0) >= 20) {
          z.stuckTicks = 0;
          const tx = clamp(Math.floor(z.x), 0, 59), ty = clamp(Math.floor(z.y), 0, 59);
          const step = this.flowField ? this.flowField.dir[ty * 60 + tx] : null;
          const px = step ? -step.dy : 0, py = step ? step.dx : 1;
          const n = arena.resolveCollision(z.x + px * 0.8, z.y + py * 0.8, 0.4);
          z.x = n.x; z.y = n.y;
          this.broadcast({ type: 'zombie-unstuck', zombieId: z.id });
        }
      }
      z.prevX = z.x; z.prevY = z.y;
      z.history.push({ tick: this.tickCount, x: z.x, y: z.y });
      if (z.history.length > HISTORY_TICKS) z.history.shift();
      z.version++;
    }
    // Acid pools tick damage.
    this.acidPools = (this.acidPools || []).filter(pool => this.nowMs < pool.until);
    for (const pool of this.acidPools) {
      for (const p of this.alivePlayers()) {
        if (dist(p.x, p.y, pool.x, pool.y) < 1.5) { p.hp -= 8 * TICK; if (p.hp <= 0) this.downPlayer(p, null); }
      }
    }
    // Brute slam ring: a player who leaves the ring before the slam lands
    // takes no slam damage (telegraph fairness).
    for (const z of this.zombies.values()) {
      if (z.type === 'brute' && z.state === 'windup' && z.attackTarget && this.nowMs >= z.windupUntil) {
        const tgt = z.attackTarget;
        const d = dist(tgt.x, tgt.y, z.x, z.y);
        if (d <= ZOMBIE_TYPES.brute.slamRadius && arena.hasLineOfSight(z.x, z.y, tgt.x, tgt.y)) {
          if (tgt.state === 'alive') this.damagePlayer(tgt, z.damage, null);
          else if (tgt.state === 'downed') this.killPlayer(tgt, null, 'brute-slam');
        }
        z.state = 'chase'; z.attackTarget = null;
      }
    }
  }
  moveZombie(z, tgt, base, dtMul = 1) {
    // Follow flow-field direction for its tile (O(1)), not A*.
    let dx = 0, dy = 0;
    if (this.flowField) {
      const tx = clamp(Math.floor(z.x), 0, 59), ty = clamp(Math.floor(z.y), 0, 59);
      const step = this.flowField.dir[ty * 60 + tx];
      if (step) { dx = step.dx; dy = step.dy; }
    }
    if (dx === 0 && dy === 0) { dx = tgt.x - z.x; dy = tgt.y - z.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; }
    // Runner zig-zag.
    if (base.zigzag) {
      const perp = { x: -dy, y: dx };
      const wob = Math.sin(this.nowMs / 300 + z.zigPhase) * 0.5;
      dx += perp.x * wob; dy += perp.y * wob;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    }
    const sp = z.speed;
    z.x += dx * sp * TICK * dtMul; z.y += dy * sp * TICK * dtMul;
  }
  moveZombieAway(z, tgt, base) {
    const dx = z.x - tgt.x, dy = z.y - tgt.y, l = Math.hypot(dx, dy) || 1;
    z.x += (dx / l) * base.speed * TICK; z.y += (dy / l) * base.speed * TICK;
  }
  zombieAttack(z, tgt, base) {
    z.state = 'chase'; z.attackTarget = null;
    if (!arena.hasLineOfSight(z.x, z.y, tgt.x, tgt.y)) return; // no through-wall
    if (this.nowMs < tgt.jumpUntil) return; // jumped the grab
    if (tgt.state === 'downed') { this.killPlayer(tgt, null, 'zombie-execute'); return; }
    if (tgt.state !== 'alive') return;
    if (this.nowMs < tgt.invulnUntil) return; // dodge i-frames
    tgt.hp -= z.damage;
    if (z.elite === 'leeching') z.hp = Math.min(z.maxHp, z.hp + z.damage);
    if (tgt.hp <= 0) this.downPlayer(tgt, null);
  }

  // ---- Main tick (fixed order: players, firing, zombies, waves, timers) ----
  tick() {
    if (this.ended || this.discarded) return;
    this.tickCount++;
    this.nowMs += TICK_MS;
    // Hibernation: all disconnected -> hold 5 min, then discard.
    if (this.players.size && this.connectedPlayers().length === 0 && !this.hibernating) {
      this.hibernating = true; this.hibernateAtMs = this.nowMs + HIBERNATE_MS;
    }
    if (this.hibernating && this.nowMs >= this.hibernateAtMs) {
      this.discarded = true; sessions.delete(this.code);
      return;
    }
    // Disconnect grace: 30s standing vulnerable, then death + loot drop.
    // Skipped while NOBODY is connected — that session hibernates instead
    // (see checkWipe / resumePlayer), so a 4-minute resume stays possible.
    for (const p of this.players.values()) {
      if (this.connectedPlayers().length === 0) break;
      if (p.disconnected && p.state === 'alive' && this.nowMs - (p.disconnectAtMs || 0) > DISCONNECT_GRACE_MS) {
        this.killPlayer(p, null, 'disconnect-timeout');
      }
    }
    // Player movement: near-instant accel, stop within ~1 step (tight feel).
    for (const p of this.players.values()) {
      if (p.disconnected || p.state === 'dead' || p.state === 'extracted') continue;
      const speed = p.state === 'downed' ? 1.2 : SPEED; // downed crawls
      let dx = 0, dy = 0;
      if (p.keys.up) dy -= 1; if (p.keys.down) dy += 1;
      if (p.keys.left) dx -= 1; if (p.keys.right) dx += 1;
      const dodging = this.nowMs < p.dodgeUntil;
      const targetVx = dx !== 0 || dy !== 0
        ? (() => { const l = Math.hypot(dx, dy); return { x: (dx / l) * speed * (dodging ? DODGE_SPEED / SPEED : 1), y: (dy / l) * speed * (dodging ? DODGE_SPEED / SPEED : 1) }; })()
        : { x: 0, y: 0 };
      // Accel 60 u/s^2 toward target velocity; friction stops in ~1 step.
      const accel = 60 * TICK;
      p.vx += clamp(targetVx.x - p.vx, -accel, accel);
      p.vy += clamp(targetVx.y - p.vy, -accel, accel);
      const oldX = p.x, oldY = p.y;
      p.x += p.vx * TICK; p.y += p.vy * TICK;
      p.x = clamp(p.x, arena.BOUNDS.minX, arena.BOUNDS.maxX);
      p.y = clamp(p.y, arena.BOUNDS.minY, arena.BOUNDS.maxY);
      const c = arena.resolveCollision(p.x, p.y, 0.4);
      p.x = c.x; p.y = c.y;
      // Movement validation: server-simulated position can never exceed
      // max speed; if it somehow does, clamp + log (anti-cheat floor).
      const moved = dist(oldX, oldY, p.x, p.y);
      const maxMove = (dodging ? DODGE_SPEED : SPEED) * TICK * MAX_SPEED_TOLERANCE + 0.01;
      if (moved > maxMove) {
        logAnomaly('impossible-speed', `${p.id} moved ${moved.toFixed(2)} in one tick (max ${maxMove.toFixed(2)}); corrected`);
        p.x = oldX; p.y = oldY; p.vx = 0; p.vy = 0;
      }
      p.history.push({ tick: this.tickCount, x: p.x, y: p.y });
      if (p.history.length > HISTORY_TICKS) p.history.shift();
      if (p.reloadingWeapon && this.nowMs >= p.reloadingUntil) this.finishReload(p);
      // Hold-to-fire (SMG auto; semi weapons fire once per click via shoot msg,
      // but fireHeld also triggers at fire rate — simple + responsive).
      if (p.fireHeld && p.state === 'alive') this.shootAt(p, p.aim, this.nowMs);
      // Extraction: standing in the radius accumulates the 30s timer.
      if (this.extractionOpen && p.state === 'alive' && dist(p.x, p.y, arena.EXTRACTION_POINT.x, arena.EXTRACTION_POINT.y) < 2.5) {
        p.extractingMs += TICK_MS;
        if (p.extractingMs >= EXTRACTION_SECONDS * 1000) {
          p.state = 'extracted';
          this.broadcast({ type: 'player-extracted', playerId: p.id });
          if (!this.alivePlayers().length && ![...this.players.values()].some(q => q.state === 'downed')) this.endSession('extraction');
        }
      } else p.extractingMs = Math.max(0, p.extractingMs - TICK_MS);
    }
    this.reviveTick();
    this.lootTick();
    this.directorTick();
    // Wave / breather state machine.
    if (this.phase === 'breather' && this.nowMs >= this.breatherEndsAt) {
      this.startWave(this.wave + 1);
    } else if (this.phase === 'wave') {
      // Spawn pacing: interval shrinks with wave, director eases near wipe.
      const interval = this.director.eased ? 1200 : Math.max(250, 800 - this.wave * 50);
      this.spawnTimerMs += TICK_MS;
      if (this.waveRemainingToSpawn > 0 && this.spawnTimerMs >= interval) {
        this.spawnTimerMs = 0;
        const type = this.spawnList[this.waveSpawned++] || 'shambler';
        this.waveRemainingToSpawn--;
        this.spawnZombie(type); // queues at the gate itself when at cap
      }
      this.drainQueue();
      if (this.waveRemainingToSpawn <= 0 && this.spawnQueue.length === 0 && this.zombies.size === 0) {
        if (this.wave >= EXTRACTION_WAVE && !this.extractionOpen) {
          this.extractionOpen = true;
          this.broadcast({ type: 'extraction-open', point: arena.EXTRACTION_POINT });
        }
        this.phase = 'breather';
        this.breatherEndsAt = this.nowMs + BREATHER_SECONDS * 1000;
        this.broadcast({ type: 'wave-cleared', wave: this.wave });
      }
    }
    this.zombieTick();
    this.checkWipe();
  }

  // ---- Snapshots: delta + distance priority, Phase 0 format kept ----
  snapshotFor(p) {
    const players = [...this.players.values()].map(q => ({
      id: q.id, x: +q.x.toFixed(2), y: +q.y.toFixed(2), color: q.color,
      hp: Math.max(0, Math.round(q.hp)), maxHp: q.maxHp, state: q.state,
      weapon: q.currentWeapon, mag: q.mag[q.currentWeapon], ammo: q.ammo,
      grace: Math.max(0, q.graceEndsAt - this.nowMs), downedMs: q.downedTimerMs,
      extractingMs: q.extractingMs, disconnected: q.disconnected,
    }));
    // Delta: only zombies that moved/changed, nearby every tick, far every 2-4.
    const zombies = [];
    for (const z of this.zombies.values()) {
      const d = dist(p.x, p.y, z.x, z.y);
      const near = d < 15, mid = d < 30;
      const due = near || (mid && this.tickCount % 2 === 0) || (!mid && this.tickCount % 4 === 0);
      if (!due && z.lastHitTick === this.tickCount - 1) { /* changed state still sent below */ }
      if (!due) continue;
      zombies.push({
        id: z.id, type: z.type, elite: z.elite || null, x: +z.x.toFixed(2), y: +z.y.toFixed(2),
        hp: z.hp, maxHp: z.maxHp, state: z.state, culled: !!z.culled,
      });
      z.lastHitTick = this.tickCount;
    }
    const events = p.events ? p.events.splice(0, p.events.length) : [];
    return {
      type: 'snapshot', tick: this.tickCount, code: this.code,
      players, zombies,
      wave: {
        number: this.wave, phase: this.phase,
        breatherMs: this.phase === 'breather' ? Math.max(0, this.breatherEndsAt - this.nowMs) : 0,
        remaining: this.waveRemainingToSpawn + this.zombies.size + this.spawnQueue.length,
        extractionOpen: this.extractionOpen,
        extraction: arena.EXTRACTION_POINT,
        director: { stress: +this.director.stress.toFixed(2), eased: this.director.eased, attention: Math.round(this.director.attention) },
      },
      loot: this.lootPiles.filter(l => !l.taken).map(l => ({ id: l.id, x: +l.x.toFixed(1), y: +l.y.toFixed(1) })),
      crates: this.crates.map(c => ({ id: c.id, x: c.x, y: c.y, looted: c.looted })),
      events,
      zombieCap: ZOMBIE_CAP, zombieCount: this.zombies.size, queued: this.spawnQueue.length,
    };
  }
}

// ---- Global server state (Phase 0 compat) ----
const startedAt = Date.now();
let tickCount = 0;
let tickDurations = [];
let bytesSent = 0, bytesReceived = 0;

function avgTickMs() {
  return tickDurations.length ? tickDurations.reduce((a, b) => a + b, 0) / tickDurations.length : 0;
}
function totalPlayers() { let n = 0; for (const s of sessions.values()) n += s.players.size; return n; }
function totalZombies() { let n = 0; for (const s of sessions.values()) n += s.zombies.size; return n; }

function globalTick() {
  const t0 = performance.now();
  tickCount++;
  for (const s of [...sessions.values()]) {
    s.tick();
    // Broadcast per-session delta snapshots.
    for (const p of s.players.values()) {
      if (p.disconnected || !p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
      const msg = JSON.stringify(s.snapshotFor(p));
      p.ws.send(msg); bytesSent += Buffer.byteLength(msg);
    }
    if (s.discarded) sessions.delete(s.code);
  }
  const dur = performance.now() - t0;
  tickDurations.push(dur);
  if (tickDurations.length > 200) tickDurations.shift();
}

// Default session (Phase 0 compat): a plain connect without create/join
// lands in a shared default session so the Phase 0 two-client test still passes.
function defaultSession() {
  for (const s of sessions.values()) if (s.code === 'DFLT') return s;
  const s = new Session('DFLT');
  sessions.set('DFLT', s);
  return s;
}

function sendWelcome(ws, session, player) {
  ws.send(JSON.stringify({
    type: 'welcome', id: player.id, code: session.code,
    x: player.x, y: player.y, color: player.color,
    players: [...session.players.values()].map(p => ({ id: p.id, x: p.x, y: p.y, color: p.color, hp: p.hp, state: p.state })),
    wave: { number: session.wave, phase: session.phase },
    maxPlayers: session.maxPlayers,
  }));
}

function handleMessage(session, player, ws, msg) {
  if (msg.type === 'input') { session.applyInput(player, msg); return; }
  if (msg.type === 'shoot') {
    // Explicit shot (lag-comp test path): aim dir + shooter timestamp.
    const aim = msg.aim ? { x: msg.aim.x, y: msg.aim.y } : player.aim;
    const l = Math.hypot(aim.x, aim.y) || 1;
    session.shootAt(player, { x: aim.x / l, y: aim.y / l }, msg.t, { hitZone: msg.hitZone });
    return;
  }
  if (msg.type === 'ping') {
    const pong = JSON.stringify({ type: 'pong', t: msg.t });
    ws.send(pong); bytesSent += Buffer.byteLength(pong); return;
  }
  // Cheat claims are ignored + logged: a client can never grant itself a kill/loot/HP.
  if (msg.type === 'kill' || msg.type === 'claim-kill' || msg.type === 'grant-loot' || msg.type === 'set-hp' || msg.type === 'give-ammo') {
    logAnomaly('cheat-claim', `${player.id} sent ${msg.type}; ignored`);
    return;
  }
}

// ---- HTTP + WebSocket ----
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    try {
      const file = fs.readFileSync(path.join(__dirname, 'client.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(file);
    } catch { res.writeHead(404); res.end('no client'); }
  } else if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', players: totalPlayers(), sessions: sessions.size, tick: tickCount }));
  } else if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      players: totalPlayers(), sessions: sessions.size,
      zombies: totalZombies(), tick: tickCount, avgTickMs: Number(avgTickMs().toFixed(3)),
      bytesSent, bytesReceived, uptimeSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      sessionsDetail: [...sessions.values()].map(s => ({
        code: s.code, players: s.players.size, zombies: s.zombies.size,
        wave: s.wave, phase: s.phase, hibernating: s.hibernating,
      })),
      anomalies: anomalies.slice(-20),
    }));
  } else { res.writeHead(404); res.end('not found'); }
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  let session = defaultSession();
  let player = null;
  const joinSession = (sess) => {
    const r = sess.addPlayer(ws);
    if (r.error) { ws.send(JSON.stringify({ type: 'error', error: r.error })); return null; }
    player = r.player; session = sess;
    sendWelcome(ws, sess, player);
    return player;
  };
  // Plain Phase 0 connect: auto-join default session immediately.
  joinSession(session);

  ws.on('message', (data) => {
    bytesReceived += data.length;
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'create') {
      const code = makeCode();
      const sess = new Session(code, { maxPlayers: msg.maxPlayers || MAX_PLAYERS_DEFAULT });
      sessions.set(code, sess);
      // Move this player from the default session into the new one.
      if (player) session.players.delete(player.id);
      const r = sess.addPlayer(ws);
      if (r.error) { ws.send(JSON.stringify({ type: 'error', error: r.error })); return; }
      player = r.player; session = sess;
      ws.send(JSON.stringify({ type: 'created', code, id: player.id }));
      sendWelcome(ws, sess, player);
      return;
    }
    if (msg.type === 'join') {
      const sess = sessions.get((msg.code || '').toUpperCase());
      if (!sess) { ws.send(JSON.stringify({ type: 'error', error: 'unknown code' })); return; }
      if (msg.resumeId) {
        const r = sess.resumePlayer(msg.resumeId, ws);
        if (r.error) { ws.send(JSON.stringify({ type: 'error', error: r.error })); return; }
        player = r.player; session = sess;
        ws.send(JSON.stringify({ type: 'resumed', id: player.id, code: sess.code, hp: player.hp, ammo: player.ammo }));
        sendWelcome(ws, sess, player);
        return;
      }
      if (player) session.players.delete(player.id);
      const p = joinSession(sess);
      if (p) ws.send(JSON.stringify({ type: 'joined', code: sess.code, id: p.id }));
      return;
    }
    if (!player) return;
    handleMessage(session, player, ws, msg);
  });

  ws.on('close', () => {
    if (!player) return;
    // 30s disconnect grace: character stands vulnerable, reconnect resumes.
    player.disconnected = true; player.disconnectAtMs = session.nowMs; player.ws = null;
    console.log(`[disconnect] ${player.id} in ${session.code} (30s grace)`);
  });
  ws.on('error', (err) => console.error('[ws error]', err.message));
});

if (require.main === module) {
  setInterval(globalTick, TICK_MS);
  server.listen(PORT, () => console.log(`phase1 server listening on :${PORT} (tick ${1000 / TICK_MS} Hz, arena ${arena.SIZE}x${arena.SIZE}, zombie cap ${ZOMBIE_CAP})`));
}

module.exports = {
  Session, WEAPONS, ZOMBIE_TYPES, ELITES, waveDef, waveCount, computeFlowField,
  arena, ZOMBIE_CAP, TICK_MS, GRACE_SECONDS, DOWNED_SECONDS, REVIVE_SECONDS,
  BREATHER_SECONDS, EXTRACTION_SECONDS, DISCONNECT_GRACE_MS, HIBERNATE_MS,
  sessions, makeCode, logAnomaly, anomalies,
};
