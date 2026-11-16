// Phase 2 server — Survival base + social systems, roles, progression.
// EXTENDS the Phase 1 server (same protocol, same 20 Hz tick, same
// /health + /stats endpoints). Do not rebuild from scratch.
// Authoritative: server decides positions, HP, ammo, loot, zombie AI, waves,
// damage, deaths — plus squads, trust, roles, perks, barricades, traps.
//
// Phase 2 additions (spec §2.4, §2.5, §7; deep plan Jobs 2.1–2.6):
//   roles (6, pick at drop-in via {type:'role'}), signature abilities
//   ({type:'ability'}), squads (invite/accept/leave/waypoint/shared loot),
//   trust/marks/bounty (session-only), XP + level-up perk picks,
//   barricades + traps at surveyed points, weapon attachments, crate
//   weapon grants, death-pile weapon drops, medkit heal channel,
//   noise visibility (per-player noise + surge warning), end-screen score.
// Systems kept SIMPLE on purpose (fun first, no over-engineering):
//   shared-loot split is a single toggle, no distribution UI; the
//   accident-vs-deliberate trust heuristic is a simple pattern rule
//   (see addTrust/damagePlayer) and is NOT a perfect judge.
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
//  - Phase 2 adds roles/squads/trust/perks/barricades (see header) —
//    each simplified per Matt's filter (coordination notes §Simplifications).
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

// ---- Roles (Phase 2, spec §2.4) ----
// weapon = starting primary (melee is always owned as fallback).
// ability.cdMs, passive numbers live here so tests + protocol read one table.
const ROLES = {
  leader:       { name: 'Leader',       weapon: 'pistol',  ability: { name: 'rally',     cdMs: 45000, desc: 'Squadmates within 10 tiles +15% damage, +10% speed for 10s' }, auraXp: 0.05, auraLoot: 0.05, auraRange: 8 },
  heavy:        { name: 'Heavy',        weapon: 'shotgun', ability: { name: 'bulwark',   cdMs: 30000, desc: '40% less damage from the front for 4s' }, maxHpBonus: 25, speedMul: 0.9 },
  sharpshooter: { name: 'Sharpshooter', weapon: 'rifle',   ability: { name: 'longshot',  cdMs: 20000, desc: 'Next shot is a guaranteed crit (+100%)' }, critChance: 0.15, headshotBonus: 0.5 },
  scout:        { name: 'Scout',        weapon: 'smg',     ability: { name: 'skydance',  cdMs: 12000, desc: 'Long dodge-dash (1.8x speed, 2x distance) +20% speed 2s after' }, speedMul: 1.1, aggroPenalty: 2 },
  medic:        { name: 'Medic',        weapon: 'pistol',  ability: { name: 'triage',    cdMs: 30000, desc: 'Revive at 2x speed for 10s + medkit aura (+2 HP/s within 8 tiles)' }, reviveMul: 0.5, medsStart: 3, medsCap: 5 },
  engineer:     { name: 'Engineer',     weapon: 'smg',     ability: { name: 'fortify',   cdMs: 25000, desc: 'Instantly deploy a barricade at your position (free)' }, buildMul: 0.5, barricadeBonus: 2 },
};
const ROLE_NAMES = Object.keys(ROLES);

// ---- XP + perks (Phase 2, spec §2.5) ----
const XP_VALUES = { shambler: 10, runner: 12, screamer: 15, spitter: 20, brute: 50 };
const XP_PER_LEVEL = 50; // level n needs 50*n total XP (L1 at 50, L2 at 100, ...)
const PERK_LIST = ['damage', 'hp', 'reload', 'barricade', 'ammo', 'revive', 'quiet'];
const PERK_DESC = {
  damage: '+10% damage', hp: '+15 max HP (and heal 15)', reload: '20% faster reload',
  barricade: '+1 barricade capacity', ammo: '+25% ammo from pickups',
  revive: '25% faster revive', quiet: '-25% noise + smaller zombie aggro',
};

// ---- Trust (Phase 2, spec §7.5) ----
// Ranks: Trusted >=30, Neutral -9..29, Suspect -30..-10, Traitor <=-31.
const TRUST = {
  revive: 8, reviveCrossSquad: 12, share: 5, sharedKill: 2, waveSurvived: 3,
  damageStray: -1, damageDeliberate: -2, kill: -20, execute: -30, lootAfterKill: -5,
};
function trustRank(score) {
  if (score >= 30) return 'trusted';
  if (score >= -9) return 'neutral';
  if (score >= -30) return 'suspect';
  return 'traitor';
}
function bountyFor(p) { return 10 + 5 * (p.playersKilled || 0); }

// ---- Squads / barricades / traps (Phase 2, spec §7.1, §2.5) ----
const SQUAD_MAX = 4;
const SQUAD_INVITE_MS = 20000;
const BARRICADE_HP = 60, BARRICADE_COST = 2, BARRICADE_BUILD_MS = 2000, BARRICADE_CAP = 2;
const TRAP_COST = 1;
const TRAP_STATS = { spike: { radius: 1, damage: 20 }, molotov: { radius: 1.5, burnDps: 10, burnMs: 3000, burnRadius: 2 }, noise: { radius: 1.5, attention: 20, lureMs: 5000, lureRadius: 10 } };
const ATTACHMENTS = {
  scope: { weapon: 'rifle', desc: 'rifle range +10, spread x0.5' },
  'extended-mag': { weapon: 'smg', desc: 'mag +50%' }, // also valid on pistol
  grip: { weapon: null, desc: 'spread x0.7 (any gun)' },
};
function attachmentForWeapon(w) {
  if (w === 'rifle') return ['scope', 'grip'];
  if (w === 'smg' || w === 'pistol') return ['extended-mag', 'grip'];
  return ['grip']; // shotgun
}

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
    // Phase 2 state.
    this.squads = new Map(); // id -> {id, leaderId, members:[ids], lootSplit, waypoint}
    this.nextSquadNum = 1;
    this.invites = new Map(); // targetId -> {fromId, expiresAt}
    this.barricades = []; // {id, pointId|null, x, y, hp, maxHp, ownerId}
    this.nextBarricadeId = 1;
    this.traps = []; // {id, kind, x, y, ownerId}
    this.nextTrapId = 1;
    this.burnZones = []; // {x, y, until, ownerId} — molotov fire, 10 dps / 3 s
    this.deathSeq = 0; // monotonic death order (Last One Standing tie-break)
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

  // ---- Phase 2 helpers ----
  hasPerk(p, perk) { return p.perks.includes(perk); }
  squadOf(p) { return p.squadId ? this.squads.get(p.squadId) : null; }
  computeMaxHp(p) {
    return 100 + (p.role === 'heavy' ? ROLES.heavy.maxHpBonus : 0) + (this.hasPerk(p, 'hp') ? 15 : 0);
  }
  maxMedsFor(p) { return p.role === 'medic' ? ROLES.medic.medsCap : 3; }
  barricadeCapFor(p) {
    return BARRICADE_CAP + (p.role === 'engineer' ? ROLES.engineer.barricadeBonus : 0) + (this.hasPerk(p, 'barricade') ? 1 : 0);
  }
  barricadeCountFor(p) { return this.barricades.filter(b => b.ownerId === p.id).length; }
  // Move-speed multiplier from role passives + active buffs (Rally, Skydance).
  speedMulFor(p) {
    let m = 1;
    if (p.role === 'heavy') m *= ROLES.heavy.speedMul;
    if (p.role === 'scout') m *= ROLES.scout.speedMul;
    if (this.nowMs < p.rallyUntil) m *= 1.1;
    if (this.nowMs < p.skydanceUntil) m *= 1.2;
    return m;
  }
  // Effective weapon stats with the player's attachment applied.
  weaponStats(p, key) {
    const base = WEAPONS[key];
    const att = p.attachments && p.attachments[key];
    if (!att) return base;
    const s = { ...base };
    if (att === 'scope' && key === 'rifle') { s.range += 10; s.spread *= 0.5; }
    if (att === 'extended-mag') s.mag = Math.round(base.mag * 1.5);
    if (att === 'grip') s.spread *= 0.7;
    return s;
  }
  // Revive timing ladder (spec §7.4): base 3s, squadmate 2s, Medic 1.5s,
  // Medic + Triage 0.8s; revive perk is a further x0.75.
  reviveTimeFor(reviver, target) {
    let ms = REVIVE_SECONDS * 1000;
    if (reviver.squadId && target.squadId && reviver.squadId === target.squadId) ms = 2000;
    if (reviver.role === 'medic') ms = 1500;
    if (reviver.role === 'medic' && this.nowMs < reviver.triageUntil) ms = 800;
    if (this.hasPerk(reviver, 'revive')) ms = Math.round(ms * 0.75);
    return ms;
  }
  // Trust: apply a delta, fire mark / mark-cleared events on rank crossings.
  addTrust(p, delta, reason) {
    const wasMarked = p.marked;
    p.trust += delta;
    const rank = trustRank(p.trust);
    p.marked = rank === 'suspect' || rank === 'traitor';
    if (p.marked && !wasMarked) {
      this.broadcast({ type: 'player-marked', playerId: p.id, rank, bounty: rank === 'traitor' ? bountyFor(p) : 0 });
    } else if (!p.marked && wasMarked) {
      this.broadcast({ type: 'mark-cleared', playerId: p.id, rank });
    }
    return p.trust;
  }
  // XP: Leader aura gives squadmates within 8 tiles +5% XP (rounded up).
  grantXp(p, amount) {
    let amt = amount;
    const sq = this.squadOf(p);
    if (sq) {
      const leaderNear = sq.members.some(id => {
        const q = this.players.get(id);
        return q && q !== p && q.role === 'leader' && q.state === 'alive' && dist(p.x, p.y, q.x, q.y) <= ROLES.leader.auraRange;
      });
      if (leaderNear) amt = Math.ceil(amt * (1 + ROLES.leader.auraXp));
    }
    p.xp += amt;
    while (p.xp >= XP_PER_LEVEL * (p.level + 1)) {
      p.level++;
      this.offerPerks(p);
    }
    return amt;
  }
  offerPerks(p) {
    const avail = PERK_LIST.filter(pk => !p.perks.includes(pk));
    const pool = [...avail], choices = [];
    while (choices.length < 3 && pool.length) choices.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    p.perkChoices = choices;
    this.broadcast({ type: 'level-up', playerId: p.id, level: p.level, choices });
  }
  applyPerk(p, perk) {
    if (!p.perkChoices || !p.perkChoices.includes(perk)) return false;
    if (p.perks.includes(perk)) return false;
    p.perks.push(perk);
    p.perkChoices = null;
    if (perk === 'hp') { const before = p.maxHp; p.maxHp = this.computeMaxHp(p); p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - before)); }
    this.broadcast({ type: 'perk-picked', playerId: p.id, perk });
    return true;
  }
  // Grant a weapon (crate / pile / role): adds to the owned list + reserve ammo.
  grantWeapon(p, w) {
    if (!WEAPONS[w] || w === 'melee') return false;
    if (!p.weapons.includes(w)) {
      p.weapons.push(w);
      p.mag[w] = this.weaponStats(p, w).mag;
    }
    p.ammo[WEAPONS[w].ammoType] = (p.ammo[WEAPONS[w].ammoType] || 0) + WEAPONS[w].reserveStart;
    return true;
  }
  // Loot multiplier: Leader aura (+5% loot, rounded up) + ammo perk (+25%).
  lootMult(p) {
    let m = 1;
    const sq = this.squadOf(p);
    if (sq) {
      const leaderNear = sq.members.some(id => {
        const q = this.players.get(id);
        return q && q !== p && q.role === 'leader' && q.state === 'alive' && dist(p.x, p.y, q.x, q.y) <= ROLES.leader.auraRange;
      });
      if (leaderNear) m *= (1 + ROLES.leader.auraLoot);
    }
    if (this.hasPerk(p, 'ammo')) m *= 1.25;
    return m;
  }
  // Squad kill feed: slim lines for revives/downs/kills involving squad members.
  squadFeed(kind, data) {
    const involved = [data.playerId, data.by].filter(Boolean)
      .map(id => this.players.get(id)).filter(Boolean);
    if (!involved.some(p => p.squadId)) return;
    this.broadcast({ type: 'squad-feed', kind, ...data });
  }

  // Role pick at drop-in ({type:'role'}). A fresh player (default pistol+melee
  // only) gets the role's exact starting loadout; a player who already looted
  // other weapons keeps them and just gains the role weapon. Passives apply
  // from drop-in (max HP, meds). Role can be re-picked — the loadout grant
  // is additive after the first pick, never a wipe.
  setRole(p, role) {
    if (!ROLES[role]) return { error: 'unknown role' };
    if (p.role === role && p.roleSet) return { ok: true, role };
    const fresh = p.weapons.length === 2 && p.weapons.includes('pistol') && p.weapons.includes('melee');
    p.role = role;
    p.roleSet = true;
    const w = ROLES[role].weapon;
    if (fresh) p.weapons = [w, 'melee'];
    else if (!p.weapons.includes(w)) p.weapons.push(w);
    p.currentWeapon = w;
    if (p.role === 'medic' && p.carried.meds < ROLES.medic.medsStart) p.carried.meds = ROLES.medic.medsStart;
    const before = p.maxHp;
    p.maxHp = this.computeMaxHp(p);
    if (p.maxHp > before) p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - before));
    else p.hp = Math.min(p.hp, p.maxHp);
    this.broadcast({ type: 'role-set', playerId: p.id, role });
    return { ok: true, role };
  }

  // Signature ability ({type:'ability'}). Validates the cooldown, applies
  // the effect, broadcasts 'ability-used'. Returns {ok} or {error, msLeft}.
  useAbility(p) {
    if (p.state !== 'alive') return { error: 'not alive' };
    if (this.nowMs < p.abilityCdUntil) return { error: 'cooldown', msLeft: p.abilityCdUntil - this.nowMs };
    const role = ROLES[p.role];
    const ability = role.ability.name;
    // Engineer Fortify validates before the cooldown is consumed.
    if (ability === 'fortify') {
      const r = this.fortifyBarricade(p);
      if (r.error) return r;
    }
    p.abilityCdUntil = this.nowMs + role.ability.cdMs;
    switch (ability) {
      case 'rally': {
        const sq = this.squadOf(p);
        const mates = sq ? sq.members.map(id => this.players.get(id)).filter(q => q && q.state === 'alive') : [p];
        for (const q of mates) if (dist(p.x, p.y, q.x, q.y) <= 10) q.rallyUntil = this.nowMs + 10000;
        if (!sq) p.rallyUntil = this.nowMs + 10000;
        break;
      }
      case 'bulwark': p.bulwarkUntil = this.nowMs + 4000; break;
      case 'longshot': p.longshotArmed = true; break;
      case 'skydance':
        p.dodgeUntil = this.nowMs + DODGE_TIME * 2 * 1000;
        p.dodgeCdUntil = this.nowMs + DODGE_CD * 1000;
        p.skydanceUntil = this.nowMs + 2000;
        p.invulnUntil = Math.max(p.invulnUntil, this.nowMs + 250);
        if (p.reloadingWeapon) { p.reloadingWeapon = null; p.reloadingUntil = 0; }
        break;
      case 'triage': p.triageUntil = this.nowMs + 10000; break;
      case 'fortify': break; // placed above, before the cooldown was set
    }
    this.broadcast({ type: 'ability-used', playerId: p.id, role: p.role, ability });
    return { ok: true, ability };
  }
  // Fortify: free barricade at the nearest surveyed point within 3 tiles,
  // else a free-standing barricade at the Engineer's tile. Capacity applies.
  fortifyBarricade(p) {
    if (this.barricadeCountFor(p) >= this.barricadeCapFor(p)) return { error: 'barricade capacity reached' };
    let point = null;
    for (const pt of arena.BARRICADE_POINTS) {
      if (dist(p.x, p.y, pt.x, pt.y) <= 3 && !this.barricades.some(b => b.pointId === pt.id)) { point = pt; break; }
    }
    const b = {
      id: `b${this.nextBarricadeId++}`, pointId: point ? point.id : null,
      x: point ? point.x : p.x, y: point ? point.y : p.y,
      hp: BARRICADE_HP, maxHp: BARRICADE_HP, ownerId: p.id,
    };
    this.barricades.push(b);
    this.broadcast({ type: 'barricade-placed', barricade: { ...b }, by: p.id, free: true });
    return { ok: true, barricade: b };
  }
  // Barricade placement at a surveyed point (build channel started by
  // {type:'barricade'}; completed in tick()). Free = Fortify (no cost/time).
  placeBarricade(p, pointId) {
    const point = arena.BARRICADE_POINTS.find(pt => pt.id === pointId);
    if (!point) return { error: 'unknown barricade point' };
    if (this.barricades.some(b => b.pointId === pointId)) return { error: 'point already barricaded' };
    if (this.barricadeCountFor(p) >= this.barricadeCapFor(p)) return { error: 'barricade capacity reached' };
    if (p.carried.materials < BARRICADE_COST) return { error: 'need 2 materials' };
    if (dist(p.x, p.y, point.x, point.y) > 3) return { error: 'too far from barricade point' };
    const b = {
      id: `b${this.nextBarricadeId++}`, pointId: point.id,
      x: point.x, y: point.y, hp: BARRICADE_HP, maxHp: BARRICADE_HP, ownerId: p.id,
    };
    this.barricades.push(b);
    p.carried.materials -= BARRICADE_COST;
    this.broadcast({ type: 'barricade-placed', barricade: { ...b }, by: p.id });
    return { ok: true, barricade: b };
  }
  // Start a barricade build channel ({type:'barricade'}). Build takes 2 s
  // (Engineer 1 s); materials are spent when the build completes. The
  // channel is interrupted by damage or dodge (see tick/damagePlayer).
  startBarricade(p, pointId) {
    const point = arena.BARRICADE_POINTS.find(pt => pt.id === pointId);
    if (!point) return { error: 'unknown barricade point' };
    if (p.state !== 'alive') return { error: 'not alive' };
    if (this.barricades.some(b => b.pointId === pointId)) return { error: 'point already barricaded' };
    if (this.barricadeCountFor(p) >= this.barricadeCapFor(p)) return { error: 'barricade capacity reached' };
    if (p.carried.materials < BARRICADE_COST) return { error: 'need 2 materials' };
    if (dist(p.x, p.y, point.x, point.y) > 3) return { error: 'too far from barricade point' };
    const buildMs = Math.round(BARRICADE_BUILD_MS * (p.role === 'engineer' ? ROLES.engineer.buildMul : 1));
    p.building = { pointId, endsAt: this.nowMs + buildMs };
    return { ok: true, buildMs };
  }
  // Place a trap at the player's position ({type:'trap'}). Costs 1 material.
  placeTrap(p, kind) {
    if (!TRAP_STATS[kind]) return { error: 'unknown trap kind' };
    if (p.state !== 'alive') return { error: 'not alive' };
    if (p.carried.materials < TRAP_COST) return { error: 'need 1 material' };
    if (this.traps.length >= 40) return { error: 'too many traps' };
    p.carried.materials -= TRAP_COST;
    const t = { id: `t${this.nextTrapId++}`, kind, x: p.x, y: p.y, ownerId: p.id };
    this.traps.push(t);
    this.broadcast({ type: 'trap-placed', trap: { id: t.id, kind: t.kind, x: t.x, y: t.y }, by: p.id });
    return { ok: true, trap: t };
  }
  // Medkit channel ({type:'heal'}): consume 1 med, heal 40 HP over 2 s.
  // Interrupted by damage or dodge.
  startHeal(p) {
    if (p.state !== 'alive') return { error: 'not alive' };
    if (p.healing) return { error: 'already healing' };
    if (p.carried.meds < 1) return { error: 'no meds' };
    if (p.hp >= p.maxHp) return { error: 'already full HP' };
    p.carried.meds -= 1;
    p.healing = { until: this.nowMs + 2000 };
    this.broadcast({ type: 'heal-started', playerId: p.id });
    return { ok: true };
  }

  // ---- Squads (Phase 2, spec §7.1–7.2) ----
  inviteSquad(p, targetId) {
    const t = this.players.get(targetId);
    if (!t || t === p) return { error: 'unknown target' };
    if (t.disconnected) return { error: 'target disconnected' };
    const sq = this.squadOf(p);
    if (sq && sq.members.length >= SQUAD_MAX) return { error: 'squad full' };
    if (sq && sq.members.includes(t.id)) return { error: 'already squadmates' };
    const tsq = this.squadOf(t);
    if (tsq && tsq.members.length >= SQUAD_MAX) return { error: 'target squad full' };
    this.invites.set(t.id, { fromId: p.id, expiresAt: this.nowMs + SQUAD_INVITE_MS });
    t.events.push({ type: 'squad-invite', fromId: p.id, expiresMs: SQUAD_INVITE_MS });
    p.events.push({ type: 'squad-invite-sent', targetId: t.id });
    return { ok: true };
  }
  acceptSquad(p, fromId) {
    const inv = this.invites.get(p.id);
    if (!inv || inv.fromId !== fromId) return { error: 'no invite' };
    if (this.nowMs > inv.expiresAt) { this.invites.delete(p.id); return { error: 'invite expired' }; }
    this.invites.delete(p.id);
    const from = this.players.get(fromId);
    if (!from || from.disconnected) return { error: 'inviter gone' };
    let sq = this.squadOf(from);
    if (sq && sq.members.length >= SQUAD_MAX) return { error: 'squad full' };
    if (!sq) {
      sq = { id: `s${this.nextSquadNum++}`, leaderId: from.id, members: [from.id], lootSplit: false, waypoint: null };
      this.squads.set(sq.id, sq);
      from.squadId = sq.id;
    }
    if (!sq.members.includes(p.id)) sq.members.push(p.id);
    p.squadId = sq.id;
    this.broadcast({ type: 'squad-joined', squadId: sq.id, playerId: p.id, members: [...sq.members], leaderId: sq.leaderId });
    return { ok: true, squadId: sq.id };
  }
  declineSquad(p, fromId) {
    const inv = this.invites.get(p.id);
    if (!inv || inv.fromId !== fromId) return { error: 'no invite' };
    this.invites.delete(p.id);
    const from = this.players.get(fromId);
    if (from && !from.disconnected) from.events.push({ type: 'squad-decline', fromId: p.id });
    return { ok: true };
  }
  leaveSquad(p) {
    const sq = this.squadOf(p);
    if (!sq) return { error: 'not in a squad' };
    sq.members = sq.members.filter(id => id !== p.id);
    p.squadId = null;
    if (!sq.members.length) this.squads.delete(sq.id);
    else if (sq.leaderId === p.id) sq.leaderId = sq.members[0];
    this.broadcast({ type: 'squad-left', squadId: sq.id, playerId: p.id, members: [...sq.members], leaderId: sq.leaderId });
    return { ok: true };
  }
  toggleSquadLoot(p) {
    const sq = this.squadOf(p);
    if (!sq) return { error: 'not in a squad' };
    if (sq.leaderId !== p.id) return { error: 'leader only' };
    sq.lootSplit = !sq.lootSplit;
    this.broadcast({ type: 'squad-loot', squadId: sq.id, lootSplit: sq.lootSplit, by: p.id });
    return { ok: true, lootSplit: sq.lootSplit };
  }
  setWaypoint(p, x, y) {
    const sq = this.squadOf(p);
    if (!sq) return { error: 'not in a squad' };
    sq.waypoint = (x === null || x === undefined) ? null : { x, y };
    this.broadcast({ type: 'waypoint', squadId: sq.id, waypoint: sq.waypoint, by: p.id });
    return { ok: true };
  }
  // Share loot: 12 ammo of the sharer's current weapon type, or 1 med, to a
  // nearby (<=3 tiles) player. +5 trust for the sharer.
  shareLoot(p, targetId, kind) {
    const t = this.players.get(targetId);
    if (!t || t === p) return { error: 'unknown target' };
    if (t.state !== 'alive') return { error: 'target not alive' };
    if (dist(p.x, p.y, t.x, t.y) > 3) return { error: 'target too far' };
    if (kind === 'meds') {
      if (p.carried.meds < 1) return { error: 'no meds to share' };
      if (t.carried.meds >= this.maxMedsFor(t)) return { error: 'target meds full' };
      p.carried.meds -= 1; t.carried.meds += 1;
      this.addTrust(p, TRUST.share, 'share');
      this.broadcast({ type: 'shared-loot', fromId: p.id, targetId: t.id, kind: 'meds', amount: 1 });
      return { ok: true };
    }
    if (kind === 'ammo') {
      const w = WEAPONS[p.currentWeapon];
      if (!w.ammoType) return { error: 'melee has no ammo to share' };
      if ((p.ammo[w.ammoType] || 0) < 12) return { error: 'not enough ammo' };
      p.ammo[w.ammoType] -= 12;
      t.ammo[w.ammoType] = (t.ammo[w.ammoType] || 0) + 12;
      this.addTrust(p, TRUST.share, 'share');
      this.broadcast({ type: 'shared-loot', fromId: p.id, targetId: t.id, kind: 'ammo', amount: 12, ammoType: w.ammoType });
      return { ok: true };
    }
    return { error: 'unknown share kind' };
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
      reviveTarget: null, reviveProgressMs: 0, reviveNeededMs: REVIVE_SECONDS * 1000, extractingMs: 0,
      carried: { meds: 1, materials: 0 }, // carried loot: drops on death
      kills: 0, headshots: 0, revives: 0, damageDealt: 0, playersKilled: 0, timesDowned: 0,
      lootCollected: 0, deathMs: null, extractedAtMs: null,
      disconnected: false, disconnectAtMs: null, spectating: false,
      // Phase 2 fields.
      role: 'leader', // default; {type:'role'} before/at drop-in picks one of ROLES
      xp: 0, level: 0, perks: [], perkChoices: null,
      trust: 0, marked: false, hitLog: new Map(), // victimId -> {count, lastMs}
      squadId: null,
      abilityCdUntil: 0, longshotArmed: false,
      rallyUntil: 0, bulwarkUntil: 0, triageUntil: 0, skydanceUntil: 0,
      noise: 0, // 0..100, recent gunfire in the last ~5 s, decays 20/s
      attachments: {}, // weapon -> attachment name (one slot per weapon)
      building: null, // {pointId, endsAt} while a barricade builds
      healing: null, // {until} while a medkit channel runs
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
    // Surge warning: broadcast once when attention crosses 35 on the way
    // up (~3 s before the surge at 50); re-arms once attention drops < 30.
    if (this.director.attention >= 35 && !this.director.warned) {
      this.director.warned = true;
      this.broadcast({ type: 'surge-warning', attention: Math.round(this.director.attention) });
    }
    if (this.director.attention < 30) this.director.warned = false;
    if (this.director.attention >= 50 && this.zombies.size < 40) {
      this.director.attention = 0;
      this.triggerSurge('noise');
      for (let i = 0; i < 2; i++) this.spawnZombie('runner');
    }
    // Isolated-player pressure: lone looter (>10 tiles from nearest ally)
    // draws Runners. Simple check once per second. Scouts are ignored
    // unless alone (their passive is a smaller aggro radius).
    if (this.tickCount % 20 === 0 && this.phase === 'wave') {
      for (const p of alive) {
        if (p.role === 'scout' && alive.some(q => q !== p && q.role !== 'scout')) continue;
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
    p.building = null; // dodge interrupts a barricade build
    p.healing = null; // dodge interrupts a medkit channel
  }
  tryReload(p) {
    if (p.state !== 'alive' || p.reloadingWeapon) return;
    const w = this.weaponStats(p, p.currentWeapon);
    if (!w.ammoType) return;
    if (p.mag[p.currentWeapon] >= w.mag || p.ammo[w.ammoType] <= 0) return;
    p.reloadingWeapon = p.currentWeapon;
    // Reload perk: 20% faster reload.
    p.reloadingUntil = this.nowMs + w.reloadMs * (this.hasPerk(p, 'reload') ? 0.8 : 1);
  }
  finishReload(p) {
    const w = this.weaponStats(p, p.reloadingWeapon);
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
    const w = this.weaponStats(shooter, shooter.currentWeapon);
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
    if (w.ammoType) {
      // Noise economy: guns loud (quiet perk -25%); per-player noise 0..100.
      const noiseMul = this.hasPerk(shooter, 'quiet') ? 0.75 : 1;
      this.director.attention += w.noise * noiseMul;
      shooter.noise = Math.min(100, (shooter.noise || 0) + w.noise * 10 * noiseMul);
    }
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
    // Sharpshooter: +25% headshot damage (head pays 2.5x instead of 2x).
    if (isHead) dmg *= shooter.role === 'sharpshooter' ? (2 + ROLES.sharpshooter.headshotBonus) : 2;
    // Crit: Sharpshooter +15% chance; Longshot guarantees the next shot crits.
    // A crit pays +100% like a headshot. Longshot is consumed on a hit.
    let crit = false;
    if (shooter.longshotArmed) { crit = true; shooter.longshotArmed = false; }
    else if (shooter.role === 'sharpshooter' && Math.random() < ROLES.sharpshooter.critChance) crit = true;
    if (crit) dmg *= 2;
    // Melee Backstab +50% from behind (attacker behind target's facing).
    if (shooter.currentWeapon === 'melee') {
      const toTarget = Math.atan2(bestHit.pos.y - shooter.y, bestHit.pos.x - shooter.x);
      const targetFacing = Math.atan2(bestHit.ent.aim ? bestHit.ent.aim.y : 0, bestHit.ent.aim ? bestHit.ent.aim.x : 1);
      let diff = Math.abs(toTarget - targetFacing);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > Math.PI * 0.75) dmg *= 1.5;
    }
    // Rally (+15% damage while active) and the damage perk (+10%).
    if (this.nowMs < shooter.rallyUntil) dmg *= 1.15;
    if (this.hasPerk(shooter, 'damage')) dmg *= 1.1;
    dmg = Math.round(dmg);
    if (isHead) shooter.headshots++;
    // damagePlayer returns the damage actually dealt (Bulwark may reduce
    // it; a dodged shot deals 0) — the hit marker and damageDealt use that.
    let finalDmg = dmg;
    if (bestHit.kind === 'zombie') this.damageZombie(bestHit.ent, dmg, shooter);
    else {
      const dealt = this.damagePlayer(bestHit.ent, dmg, shooter);
      finalDmg = (dealt === null || dealt === undefined) ? 0 : dealt;
    }
    shooter.damageDealt += finalDmg;
    const hit = { hit: true, kind: bestHit.kind, id: bestHit.ent.id, damage: finalDmg, head: isHead, crit, dist: bestHit.dist };
    this.broadcast({ type: 'shot', playerId: shooter.id, weapon: shooter.currentWeapon, hit: true, head: isHead, crit, targetId: bestHit.ent.id, targetKind: bestHit.kind, damage: finalDmg });
    return hit;
  }

  damageZombie(z, dmg, shooter) {
    z.hp -= dmg; z.version++;
    if (z.hp <= 0) {
      this.zombies.delete(z.id);
      this.score.kills++;
      if (shooter) {
        shooter.kills++;
        if (shooter.currentWeapon === 'melee') { /* silent: no noise */ }
        // XP (elite x2) + shared-kill trust: a kill within 5 tiles of a
        // squadmate is +2 trust for the shooter.
        this.grantXp(shooter, (XP_VALUES[z.type] || 10) * (z.elite ? 2 : 1));
        const sq = this.squadOf(shooter);
        if (sq) {
          const nearMate = sq.members.some(id => {
            const q = this.players.get(id);
            return q && q !== shooter && q.state === 'alive' && dist(shooter.x, shooter.y, q.x, q.y) <= 5;
          });
          if (nearMate) this.addTrust(shooter, TRUST.sharedKill, 'shared-kill');
        }
      }
      // Elite drops better loot.
      if (z.elite) this.lootPiles.push({ id: `l${nextLootId++}`, x: z.x, y: z.y, items: { meds: 1, ammo: { rifle: 12, shells: 6 } } });
      this.broadcast({ type: 'zombie-killed', zombieId: z.id, by: shooter ? shooter.id : null, elite: z.elite || null });
      this.drainQueue();
    }
  }

  // Returns the damage actually dealt (0 if dodged; Bulwark may reduce it).
  damagePlayer(target, dmg, attacker) {
    if (target.state !== 'alive' && target.state !== 'downed') return 0;
    if (target.state === 'downed') { // executing a downed player: always deliberate
      if (attacker && attacker !== target) {
        this.addTrust(attacker, TRUST.execute, 'execute');
        this.broadcast({ type: 'player-executed', playerId: target.id, by: attacker.id });
      }
      this.killPlayer(target, attacker, 'executed');
      return dmg;
    }
    if (this.nowMs < target.invulnUntil) return 0; // dodge i-frames
    // Bulwark: 40% less damage from the front (attacker inside the target's
    // facing 180 deg). Applies to player and zombie hits alike.
    if (this.nowMs < target.bulwarkUntil && attacker) {
      const dx = attacker.x - target.x, dy = attacker.y - target.y;
      if (dx * target.aim.x + dy * target.aim.y > 0) dmg = Math.round(dmg * 0.6);
    }
    // A hit interrupts a medkit channel / barricade build.
    target.healing = null;
    target.building = null;
    // Trust loss (accident vs deliberate — SIMPLE heuristic, see header):
    // first hit on this victim in 10 s AND a zombie within 5 tiles of the
    // victim = one stray shot in a firefight (-1). Repeated shots at the
    // same player (2nd+ hit within 10 s) OR no zombie near the victim = -2.
    if (attacker && attacker !== target) {
      const zombieNear = [...this.zombies.values()].some(z => dist(z.x, z.y, target.x, target.y) < 5);
      let log = attacker.hitLog.get(target.id);
      if (!log || this.nowMs - log.lastMs > 10000) log = { count: 0, lastMs: 0 };
      log.count++;
      log.lastMs = this.nowMs;
      attacker.hitLog.set(target.id, log);
      const loss = (log.count === 1 && zombieNear) ? TRUST.damageStray : TRUST.damageDeliberate;
      this.addTrust(attacker, loss, 'friendly-fire');
    }
    target.hp -= dmg;
    if (target.hp <= 0) this.downPlayer(target, attacker);
    return dmg;
  }

  downPlayer(p, attacker) {
    p.hp = 0; p.state = 'downed'; p.downedTimerMs = DOWNED_SECONDS * 1000;
    p.timesDowned++; p.reloadingWeapon = null;
    p.building = null; p.healing = null;
    if (attacker && attacker !== p) p.lastDamager = attacker; // owns the death if they bleed out / zombies finish them
    this.broadcast({ type: 'player-downed', playerId: p.id, by: attacker ? attacker.id : null });
    this.squadFeed('down', { playerId: p.id, by: attacker ? attacker.id : null });
  }

  killPlayer(p, killer, cause) {
    p.state = 'dead'; p.spectating = true; p.hp = 0;
    p.deathMs = this.nowMs;
    p.deathSeq = ++this.deathSeq;
    // A player who downed the victim owns the death if the victim then
    // bleeds out or is finished by zombies / a Brute slam — that is a kill
    // (-20), not an execute (-30, only for shooting a downed player).
    let effKiller = killer;
    if (!effKiller && p.lastDamager && p.lastDamager !== p &&
        (cause === 'bled-out' || cause === 'zombie-execute' || cause === 'brute-slam')) effKiller = p.lastDamager;
    if (effKiller && effKiller !== p) {
      effKiller.playersKilled = (effKiller.playersKilled || 0) + 1;
      // Killing another player: -20 trust (execute is -30 instead, applied
      // by damagePlayer before this call — never both).
      if (cause !== 'executed') this.addTrust(effKiller, TRUST.kill, 'kill');
      // Bounty: killing a marked Traitor pays 10 + 5 x (victim's kills) XP.
      if (p.marked && trustRank(p.trust) === 'traitor') {
        const amount = bountyFor(p);
        this.grantXp(effKiller, amount);
        this.broadcast({ type: 'bounty-claimed', killerId: effKiller.id, victimId: p.id, amount });
      }
      this.squadFeed('kill', { playerId: p.id, by: effKiller.id });
    }
    // Loot drop: carried loot drops in a lootable pile; equipped weapons STAY.
    // Phase 2: owned weapons beyond the universal starting pistol+melee also
    // drop as takeable items — so killing a Heavy can yield their shotgun.
    // (A spare copy: the victim keeps their own list; they are dead anyway.)
    // The pile records killer + victim so looting your own kill costs trust.
    const droppedWeapons = p.weapons.filter(w => w !== 'melee' && w !== 'pistol');
    this.lootPiles.push({
      id: `l${nextLootId++}`, x: p.x, y: p.y,
      items: { ammo: { ...p.ammo }, meds: p.carried.meds, materials: p.carried.materials, weapons: droppedWeapons },
      victimId: p.id, killerId: effKiller ? effKiller.id : null, createdAtMs: this.nowMs,
    });
    p.carried = { meds: 0, materials: 0 };
    p.lastDamager = null;
    this.broadcast({ type: 'player-died', playerId: p.id, by: effKiller ? effKiller.id : null, cause });
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
    const players = [...this.players.values()];
    const titles = [];
    // Last One Standing: the last alive/extracted player, else the last to die.
    const standing = players.filter(p => p.state === 'alive' || p.state === 'extracted');
    if (standing.length === 1) titles.push({ title: 'Last One Standing', playerId: standing[0].id });
    else if (!standing.length) {
      const lastDead = players.filter(p => p.deathSeq !== undefined && p.deathSeq !== null).sort((a, b) => b.deathSeq - a.deathSeq)[0];
      if (lastDead) titles.push({ title: 'Last One Standing', playerId: lastDead.id });
    }
    const mostRevives = players.filter(p => p.revives > 0).sort((a, b) => b.revives - a.revives)[0];
    if (mostRevives) titles.push({ title: 'Most Revives', playerId: mostRevives.id });
    const mostBetrayals = players.filter(p => p.playersKilled > 0).sort((a, b) => b.playersKilled - a.playersKilled)[0];
    if (mostBetrayals) titles.push({ title: 'Most Betrayals', playerId: mostBetrayals.id });
    this.endScore = {
      waveReached: this.wave, kills: this.score.kills, titles,
      players: players.map(p => ({
        id: p.id, role: p.role, squadId: p.squadId,
        wavesSurvived: this.wave, kills: p.kills, headshots: p.headshots,
        revives: p.revives, playersKilled: p.playersKilled,
        lootCollected: p.lootCollected, damageDealt: p.damageDealt,
        timesDowned: p.timesDowned, trust: p.trust, trustRank: trustRank(p.trust),
        xp: p.xp, level: p.level, state: p.state,
      })),
    };
    this.broadcast({ type: 'session-end', reason, score: this.endScore });
  }

  // Revive: held channel, interruptible (move/damage/dodge breaks it).
  // Timing ladder (reviveTimeFor): base 3s, squadmate 2s, Medic 1.5s,
  // Medic + Triage 0.8s; revive perk x0.75 on top.
  reviveTick() {
    for (const p of this.alivePlayers()) {
      if (!p.interactHeld) { p.reviveTarget = null; p.reviveProgressMs = 0; continue; }
      const target = [...this.players.values()].find(q => q.state === 'downed' && dist(p.x, p.y, q.x, q.y) < 2.5);
      if (!target) { p.reviveTarget = null; p.reviveProgressMs = 0; continue; }
      if (p.reviveTarget !== target.id) { p.reviveTarget = target.id; p.reviveProgressMs = 0; p.reviveNeededMs = this.reviveTimeFor(p, target); }
      p.reviveProgressMs += TICK_MS;
      if (p.reviveProgressMs >= p.reviveNeededMs) {
        target.state = 'alive'; target.hp = Math.round(target.maxHp * 0.5);
        target.downedTimerMs = 0; target.lastDamager = null; p.revives++; p.reviveTarget = null; p.reviveProgressMs = 0;
        // Trust: +8 for a revive, +12 for a cross-squad revive (different
        // squads, or reviving a squad member while solo — same squad is +8).
        const cross = !(p.squadId && target.squadId && p.squadId === target.squadId);
        this.addTrust(p, cross ? TRUST.reviveCrossSquad : TRUST.revive, 'revive');
        this.broadcast({ type: 'player-revived', playerId: target.id, by: p.id });
        this.squadFeed('revive', { playerId: target.id, by: p.id });
      }
    }
    // Downed timers: unattended downed players are finished by zombies / timer.
    for (const p of this.players.values()) {
      if (p.state !== 'downed') continue;
      p.downedTimerMs -= TICK_MS;
      if (p.downedTimerMs <= 0) this.killPlayer(p, null, 'bled-out');
    }
  }

  // Loot crates: interact near a crate loots it (finite per session).
  // A crate yields ONE of: a weapon the player doesn't own (shotgun/rifle/
  // smg, weighted 35%) + its ammo, OR an attachment for an owned gun (20%),
  // OR ammo/meds/materials (45%). Shared-loot squads split ammo/meds/
  // materials evenly among squadmates in the session (round-robin remainder
  // to the picker); weapons and attachments always go to the picker only.
  rollCrateLoot(p, crate) {
    const missing = ['shotgun', 'rifle', 'smg'].filter(w => !p.weapons.includes(w));
    const r = Math.random();
    if (missing.length && r < 0.35) {
      const w = missing[Math.floor(Math.random() * missing.length)];
      this.grantWeapon(p, w);
      this.broadcast({ type: 'crate-looted', playerId: p.id, crateId: crate.id, granted: w });
      return;
    }
    if (r < 0.55) {
      const guns = p.weapons.filter(w => w !== 'melee');
      const w = guns[Math.floor(Math.random() * guns.length)];
      const opts = attachmentForWeapon(w);
      const att = opts[Math.floor(Math.random() * opts.length)];
      p.attachments[w] = att; // one slot per weapon: a new attachment replaces
      this.broadcast({ type: 'crate-looted', playerId: p.id, crateId: crate.id, attachment: { weapon: w, name: att } });
      return;
    }
    const mult = this.lootMult(p);
    p.ammo.pistol += Math.ceil(24 * mult);
    p.ammo.smg += Math.ceil(30 * mult);
    p.carried.meds = Math.min(this.maxMedsFor(p), p.carried.meds + 1);
    p.carried.materials += 2;
    this.broadcast({ type: 'crate-looted', playerId: p.id, crateId: crate.id });
  }
  // Split ammo/meds/materials evenly among squadmates in the session.
  splitLoot(picker, items) {
    const sq = this.squadOf(picker);
    if (!sq || !sq.lootSplit) return false;
    const members = sq.members.map(id => this.players.get(id)).filter(q => q && !q.disconnected);
    if (members.length < 2) return false;
    const n = members.length;
    const mult = this.lootMult(picker);
    for (const [k, v] of Object.entries(items.ammo || {})) {
      const total = Math.ceil(v * mult);
      const each = Math.floor(total / n);
      members.forEach((m, i) => { m.ammo[k] = (m.ammo[k] || 0) + each + (i === 0 ? total - each * n : 0); });
    }
    if (items.meds) {
      // Meds split one at a time, round-robin from the picker, respecting caps.
      let left = items.meds;
      let i = members.indexOf(picker);
      while (left > 0) {
        const m = members[i % n];
        if (m.carried.meds < this.maxMedsFor(m)) { m.carried.meds += 1; left--; }
        i++;
        if (i > members.indexOf(picker) + n * 2 && left > 0) break; // all caps full
      }
    }
    if (items.materials) {
      const each = Math.floor(items.materials / n);
      members.forEach((m, i) => { m.carried.materials += each + (i === 0 ? items.materials - each * n : 0); });
    }
    return true;
  }
  lootTick() {
    for (const p of this.alivePlayers()) {
      if (!p.interactHeld) continue;
      for (const c of this.crates) {
        if (!c.looted && dist(p.x, p.y, c.x, c.y) < 2) {
          c.looted = true;
          p.lootCollected++;
          this.rollCrateLoot(p, c);
        }
      }
      for (const pile of this.lootPiles) {
        if (!pile.taken && dist(p.x, p.y, pile.x, pile.y) < 2) {
          pile.taken = true;
          p.lootCollected++;
          // Looting a player you just killed (within 30 s): -5 trust.
          if (pile.victimId && pile.killerId === p.id && this.nowMs - (pile.createdAtMs || 0) < 30000) {
            this.addTrust(p, TRUST.lootAfterKill, 'loot-after-kill');
          }
          const split = this.splitLoot(p, pile.items);
          if (!split) {
            const mult = this.lootMult(p);
            if (pile.items.ammo) for (const [k, v] of Object.entries(pile.items.ammo)) p.ammo[k] = (p.ammo[k] || 0) + Math.ceil(v * mult);
            if (pile.items.meds) p.carried.meds = Math.min(this.maxMedsFor(p), p.carried.meds + pile.items.meds);
            if (pile.items.materials) p.carried.materials += pile.items.materials;
          }
          // Dropped weapons go to the picker only (never split).
          if (pile.items.weapons) for (const w of pile.items.weapons) this.grantWeapon(p, w);
          this.broadcast({ type: 'loot-taken', playerId: p.id, lootId: pile.id, split });
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
      // Barricades: a zombie within 1.5 tiles attacks the barricade instead
      // of moving (it blocks the flow-field path). Noise-trap lure: zombies
      // retarget to the trap for 5 s instead of chasing players.
      const lured = z.lureUntil && this.nowMs < z.lureUntil;
      const nearBarricade = !lured ? this.barricades.find(b => dist(z.x, z.y, b.x, b.y) <= 1.5) : null;
      if (nearBarricade) {
        if (z.state !== 'windup') { z.state = 'windup'; z.windupUntil = this.nowMs + base.windup * 1000; z.attackTarget = { kind: 'barricade', barricade: nearBarricade }; }
        else if (this.nowMs >= z.windupUntil) {
          z.state = 'chase'; z.attackTarget = null;
          nearBarricade.hp -= z.damage;
          if (nearBarricade.hp <= 0) {
            this.barricades = this.barricades.filter(b => b !== nearBarricade);
            this.broadcast({ type: 'barricade-destroyed', barricadeId: nearBarricade.id, by: z.id });
          }
        }
      } else if (lured) {
        z.state = 'chase';
        this.moveZombie(z, { x: z.lureX, y: z.lureY }, base, stepMul);
      } else if (base.ranged) {
        // Spitter: hold ~10 tiles, spit arcing acid (damage pool on landing).
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
        // Chase nearest target via flow field. Scout counts as 2 tiles
        // farther away (smaller aggro radius); the quiet perk adds 1.
        // A lone Scout is still hunted — the penalty only reorders targets.
        let tgt = null, td = Infinity, tdEff = Infinity;
        for (const p of targets) {
          const d = dist(z.x, z.y, p.x, p.y);
          let eff = d;
          if (p.role === 'scout') eff += ROLES.scout.aggroPenalty;
          if (p.perks && p.perks.includes('quiet')) eff += 1;
          if (eff < tdEff) { tdEff = eff; td = d; tgt = p; }
        }
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
      // Traps: a zombie stepping on one triggers it (consumed, one per tick).
      for (const trap of [...this.traps]) {
        const tstat = TRAP_STATS[trap.kind];
        if (!tstat || dist(z.x, z.y, trap.x, trap.y) > tstat.radius) continue;
        this.traps = this.traps.filter(t => t !== trap);
        if (trap.kind === 'spike') {
          this.damageZombie(z, tstat.damage, this.players.get(trap.ownerId) || null);
        } else if (trap.kind === 'molotov') {
          this.burnZones.push({ x: trap.x, y: trap.y, until: this.nowMs + TRAP_STATS.molotov.burnMs, ownerId: trap.ownerId });
        } else if (trap.kind === 'noise') {
          this.director.attention += TRAP_STATS.noise.attention;
          for (const oz of this.zombies.values()) {
            if (dist(oz.x, oz.y, trap.x, trap.y) <= TRAP_STATS.noise.lureRadius) {
              oz.lureUntil = this.nowMs + TRAP_STATS.noise.lureMs; oz.lureX = trap.x; oz.lureY = trap.y;
            }
          }
        }
        this.broadcast({ type: 'trap-triggered', trapId: trap.id, kind: trap.kind, zombieId: z.id });
        break;
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
        if (dist(p.x, p.y, pool.x, pool.y) < 1.5) { p.hp -= 8 * TICK; p.healing = null; if (p.hp <= 0) this.downPlayer(p, null); }
      }
    }
    // Molotov burn zones: 10 damage/s for 3 s in a 2-tile radius.
    this.burnZones = this.burnZones.filter(bz => this.nowMs < bz.until);
    for (const bz of this.burnZones) {
      for (const z of [...this.zombies.values()]) {
        if (dist(z.x, z.y, bz.x, bz.y) < TRAP_STATS.molotov.burnRadius) {
          this.damageZombie(z, TRAP_STATS.molotov.burnDps * TICK, this.players.get(bz.ownerId) || null);
        }
      }
    }
    // Brute slam ring: a player who leaves the ring before the slam lands
    // takes no slam damage (telegraph fairness).
    for (const z of this.zombies.values()) {
      if (z.type === 'brute' && z.state === 'windup' && z.attackTarget && (z.attackTarget.state === 'alive' || z.attackTarget.state === 'downed') && this.nowMs >= z.windupUntil) {
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
    // Bulwark: 40% less damage from the front (zombie inside facing 180 deg).
    let dmg = z.damage;
    if (this.nowMs < tgt.bulwarkUntil) {
      const dx = z.x - tgt.x, dy = z.y - tgt.y;
      if (dx * tgt.aim.x + dy * tgt.aim.y > 0) dmg = Math.round(dmg * 0.6);
    }
    tgt.healing = null; tgt.building = null; // a hit interrupts channels
    tgt.hp -= dmg;
    if (z.elite === 'leeching') z.hp = Math.min(z.maxHp, z.hp + dmg);
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
      const speed = p.state === 'downed' ? 1.2 : SPEED * this.speedMulFor(p); // downed crawls; role/buff speed applies when alive
      let dx = 0, dy = 0;
      if (p.keys.up) dy -= 1; if (p.keys.down) dy += 1;
      if (p.keys.left) dx -= 1; if (p.keys.right) dx += 1;
      const dodging = this.nowMs < p.dodgeUntil;
      // Skydance dodge-dash: 1.8x dodge speed while the dash runs.
      const dodgeMul = dodging ? (DODGE_SPEED / SPEED) * (this.nowMs < p.skydanceUntil ? 1.8 : 1) : 1;
      const targetVx = dx !== 0 || dy !== 0
        ? (() => { const l = Math.hypot(dx, dy); return { x: (dx / l) * speed * dodgeMul, y: (dy / l) * speed * dodgeMul }; })()
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
      // Absolute cap 30 u/s: the fastest legal move is a Scout Skydance
      // dash (12 x 1.8 x 1.1 x 1.2 = 28.5 u/s) plus its velocity decay,
      // so a role/buff-based bound would false-positive mid-dash.
      const moved = dist(oldX, oldY, p.x, p.y);
      const maxMove = 30 * TICK * MAX_SPEED_TOLERANCE + 0.05;
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
      // Medkit channel: 40 HP over 2 s (1 HP/tick); ends at full HP or timeout.
      if (p.healing) {
        p.hp = Math.min(p.maxHp, p.hp + 1);
        if (this.nowMs >= p.healing.until || p.hp >= p.maxHp) p.healing = null;
      }
      // Barricade build channel: completes at endsAt (materials re-checked).
      if (p.building && this.nowMs >= p.building.endsAt) {
        const pointId = p.building.pointId;
        p.building = null;
        this.placeBarricade(p, pointId);
      }
      // Per-player noise decays 20/s (a 5 s window).
      if (p.noise > 0) p.noise = Math.max(0, p.noise - 1);
      // Extraction: standing in the radius accumulates the 30s timer.
      if (this.extractionOpen && p.state === 'alive' && dist(p.x, p.y, arena.EXTRACTION_POINT.x, arena.EXTRACTION_POINT.y) < 2.5) {
        p.extractingMs += TICK_MS;
        if (p.extractingMs >= EXTRACTION_SECONDS * 1000) {
          p.state = 'extracted';
          p.extractedAtMs = this.nowMs;
          this.broadcast({ type: 'player-extracted', playerId: p.id });
          if (!this.alivePlayers().length && ![...this.players.values()].some(q => q.state === 'downed')) this.endSession('extraction');
        }
      } else p.extractingMs = Math.max(0, p.extractingMs - TICK_MS);
    }
    // Medic Triage aura: squadmates within 8 tiles of an active Triage
    // Medic regain +2 HP/s for the 10 s window (the Medic included).
    for (const p of this.alivePlayers()) {
      if (p.role !== 'medic' || this.nowMs >= p.triageUntil) continue;
      for (const q of this.alivePlayers()) {
        if (q.squadId && q.squadId === p.squadId && dist(p.x, p.y, q.x, q.y) <= 8 && q.hp < q.maxHp) {
          q.hp = Math.min(q.maxHp, q.hp + 0.1);
        }
      }
    }
    // Expired squad invites are dropped (accept checks expiry too).
    if (this.tickCount % 20 === 0) {
      for (const [targetId, inv] of this.invites) if (this.nowMs > inv.expiresAt) this.invites.delete(targetId);
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
        // Survive a wave together: each living player in a squad with at
        // least one other living squadmate gains +3 trust.
        for (const p of this.alivePlayers()) {
          const sq = this.squadOf(p);
          if (sq && sq.members.some(id => id !== p.id && (this.players.get(id) || {}).state === 'alive')) {
            this.addTrust(p, TRUST.waveSurvived, 'wave-survived');
          }
        }
        this.broadcast({ type: 'wave-cleared', wave: this.wave });
      }
    }
    this.zombieTick();
    this.checkWipe();
  }

  // ---- Snapshots: delta + distance priority, Phase 0 format kept ----
  snapshotFor(p) {
    const squad = this.squadOf(p);
    const players = [...this.players.values()].map(q => {
      const rank = trustRank(q.trust);
      let abilityActive = null;
      if (this.nowMs < q.rallyUntil) abilityActive = { name: 'rally', msLeft: q.rallyUntil - this.nowMs };
      else if (this.nowMs < q.bulwarkUntil) abilityActive = { name: 'bulwark', msLeft: q.bulwarkUntil - this.nowMs };
      else if (this.nowMs < q.triageUntil) abilityActive = { name: 'triage', msLeft: q.triageUntil - this.nowMs };
      return {
        id: q.id, x: +q.x.toFixed(2), y: +q.y.toFixed(2), color: q.color,
        hp: Math.max(0, Math.round(q.hp)), maxHp: q.maxHp, state: q.state,
        weapon: q.currentWeapon, mag: q.mag[q.currentWeapon], ammo: q.ammo,
        grace: Math.max(0, q.graceEndsAt - this.nowMs), downedMs: q.downedTimerMs,
        extractingMs: q.extractingMs, disconnected: q.disconnected,
        // Phase 2 fields.
        role: q.role, weapons: [...q.weapons], attachments: { ...q.attachments },
        xp: q.xp, level: q.level, perks: [...q.perks],
        trust: q.trust, trustRank: rank, marked: q.marked,
        bounty: q.marked && rank === 'traitor' ? bountyFor(q) : 0,
        noise: Math.round(q.noise || 0),
        abilityCdMs: Math.max(0, q.abilityCdUntil - this.nowMs),
        abilityActive,
        squadId: q.squadId,
        meds: q.carried.meds, materials: q.carried.materials,
        building: q.building ? { pointId: q.building.pointId, msLeft: Math.max(0, q.building.endsAt - this.nowMs) } : null,
      };
    });
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
      // Phase 2: the requester's own squad only (waypoints are members-only),
      // plus world barricades and traps (visible to everyone).
      squad: squad ? { id: squad.id, leaderId: squad.leaderId, members: [...squad.members], lootSplit: squad.lootSplit, waypoint: squad.waypoint } : null,
      barricades: this.barricades.map(b => ({ id: b.id, pointId: b.pointId, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp, ownerId: b.ownerId })),
      traps: this.traps.map(t => ({ id: t.id, kind: t.kind, x: t.x, y: t.y })),
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
  // ---- Phase 2 messages ----
  // Denials go to the sender's own event queue only (not a broadcast).
  const deny = (r) => { if (r && r.error) player.events.push({ type: 'action-denied', action: msg.type, error: r.error, msLeft: r.msLeft || 0 }); return r; };
  if (msg.type === 'role') { deny(session.setRole(player, msg.role)); return; }
  if (msg.type === 'ability') { deny(session.useAbility(player)); return; }
  if (msg.type === 'squad-invite') { deny(session.inviteSquad(player, msg.targetId)); return; }
  if (msg.type === 'squad-accept') { deny(session.acceptSquad(player, msg.fromId)); return; }
  if (msg.type === 'squad-decline') { deny(session.declineSquad(player, msg.fromId)); return; }
  if (msg.type === 'squad-leave') { deny(session.leaveSquad(player)); return; }
  if (msg.type === 'squad-loot-toggle') { deny(session.toggleSquadLoot(player)); return; }
  if (msg.type === 'waypoint') { deny(session.setWaypoint(player, msg.clear ? null : msg.x, msg.clear ? null : msg.y)); return; }
  if (msg.type === 'share') { deny(session.shareLoot(player, msg.targetId, msg.kind)); return; }
  if (msg.type === 'perk-pick') {
    if (!session.applyPerk(player, msg.perk)) player.events.push({ type: 'action-denied', action: 'perk-pick', error: 'perk not offered' });
    return;
  }
  if (msg.type === 'barricade') { deny(session.startBarricade(player, msg.pointId)); return; }
  if (msg.type === 'trap') { deny(session.placeTrap(player, msg.kind)); return; }
  if (msg.type === 'heal') { deny(session.startHeal(player)); return; }
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
  server.listen(PORT, () => console.log(`phase2 server listening on :${PORT} (tick ${1000 / TICK_MS} Hz, arena ${arena.SIZE}x${arena.SIZE}, zombie cap ${ZOMBIE_CAP})`));
}

module.exports = {
  Session, WEAPONS, ZOMBIE_TYPES, ELITES, waveDef, waveCount, computeFlowField,
  arena, ZOMBIE_CAP, TICK_MS, GRACE_SECONDS, DOWNED_SECONDS, REVIVE_SECONDS,
  BREATHER_SECONDS, EXTRACTION_SECONDS, DISCONNECT_GRACE_MS, HIBERNATE_MS,
  sessions, makeCode, logAnomaly, anomalies,
  // Phase 2 exports (roles / progression / trust / squads / traps).
  ROLES, ROLE_NAMES, XP_VALUES, XP_PER_LEVEL, PERK_LIST, PERK_DESC, TRUST,
  trustRank, bountyFor, SQUAD_MAX, BARRICADE_HP, BARRICADE_COST,
  BARRICADE_BUILD_MS, BARRICADE_CAP, TRAP_STATS, attachmentForWeapon,
};
