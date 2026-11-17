// Phase 2 tests — server logic (Jobs 2.1–2.6: squads, trust/marks/bounty,
// roles + abilities, perks, barricades/traps/attachments, noise, end screen,
// weapon-grant path). Mix of direct Session unit tests (fast-forwarded ticks)
// and a live WebSocket smoke test for the new message types.
// Usage: node test-phase2.js   (spawns server on PORT 3002)
// Exits 0 on PASS, 1 on FAIL. Prints exact run/passed/failed counts.
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const {
  Session, WEAPONS, ZOMBIE_TYPES, ROLES, XP_VALUES, PERK_LIST, TRUST,
  trustRank, bountyFor, SQUAD_MAX, arena, TICK_MS,
} = require('./server');

const PORT = 3002;
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
function shootOnce(s, shooter, target) {
  shooter.lastShotMs = -9999;
  shooter.mag[shooter.currentWeapon] = 12;
  return s.shootAt(shooter, aimAt(shooter, target), s.nowMs);
}
function hasEvent(p, type) { return (p.events || []).some(e => e.type === type); }
function findEvent(p, type) { return (p.events || []).find(e => e.type === type); }

// ---------------- Unit tests (direct Session) ----------------
function unitTests() {
  console.log('\n--- unit: roles (loadouts + passives) ---');
  const roleCases = [
    ['leader', 'pistol', null], ['heavy', 'shotgun', null], ['sharpshooter', 'rifle', null],
    ['scout', 'smg', null], ['medic', 'pistol', null], ['engineer', 'smg', null],
  ];
  for (const [role, weapon] of roleCases) {
    const s = new Session('ROLE-' + role);
    const p = addFake(s);
    const r = s.setRole(p, role);
    check(`role ${role}: starts with ${weapon}+melee`, r.ok && p.weapons.includes(weapon) && p.weapons.includes('melee') && p.currentWeapon === weapon, p.weapons.join(','));
  }
  check('default role is Leader (pistol+melee) when no role message sent', (() => {
    const s = new Session('ROLE-DEF'); const p = addFake(s);
    return p.role === 'leader' && p.weapons.includes('pistol') && p.weapons.includes('melee');
  })());
  check('unknown role rejected', (() => { const s = new Session('ROLE-X'); return !!s.setRole(addFake(s), 'wizard').error; })());
  check('Heavy passive: +25 max HP (125)', (() => { const s = new Session('ROLE-H'); const p = addFake(s); s.setRole(p, 'heavy'); return p.maxHp === 125 && p.hp === 125; })());
  check('Heavy passive: move speed x0.9', (() => { const s = new Session('ROLE-H2'); const p = addFake(s); s.setRole(p, 'heavy'); return s.speedMulFor(p) === 0.9; })());
  check('Scout passive: move speed x1.1', (() => { const s = new Session('ROLE-S'); const p = addFake(s); s.setRole(p, 'scout'); return s.speedMulFor(p) === 1.1; })());
  check('Sharpshooter passive: +15% crit chance in ROLES table', ROLES.sharpshooter.critChance === 0.15);
  check('Sharpshooter passive: +25% headshot damage in ROLES table', ROLES.sharpshooter.headshotBonus === 0.5);
  check('Medic passive: starts with 3 meds, cap 5', (() => { const s = new Session('ROLE-M'); const p = addFake(s); s.setRole(p, 'medic'); return p.carried.meds === 3 && s.maxMedsFor(p) === 5; })());
  check('non-Medic med cap is 3', (() => { const s = new Session('ROLE-M2'); return s.maxMedsFor(addFake(s)) === 3; })());
  check('Engineer passive: +2 barricade capacity (cap 4)', (() => { const s = new Session('ROLE-E'); const p = addFake(s); s.setRole(p, 'engineer'); return s.barricadeCapFor(p) === 4; })());
  check('base barricade capacity is 2', (() => { const s = new Session('ROLE-E2'); return s.barricadeCapFor(addFake(s)) === 2; })());
  check('Leader aura values in ROLES table (+5% XP/loot, 8 tiles)', ROLES.leader.auraXp === 0.05 && ROLES.leader.auraLoot === 0.05 && ROLES.leader.auraRange === 8);

  console.log('\n--- unit: abilities (fire + cooldown + effect) ---');
  check('Leader Rally: squadmates in range gain rally buff, cooldown 45s', (() => {
    const s = new Session('AB-RALLY'); const l = addFake(s); const m = addFake(s);
    l.x = 15; l.y = 20; m.x = 15; m.y = 22;
    s.inviteSquad(l, m.id); s.acceptSquad(m, l.id);
    const r = s.useAbility(l);
    return r.ok && m.rallyUntil > s.nowMs && l.abilityCdUntil - s.nowMs === 45000;
  })());
  check('Leader Rally: buffed squadmate deals +15% damage (29 vs 25)', (() => {
    const s = new Session('AB-RALLY2'); const l = addFake(s); const m = addFake(s);
    l.x = 15; l.y = 20; m.x = 15; m.y = 22;
    s.inviteSquad(l, m.id); s.acceptSquad(m, l.id);
    s.useAbility(l);
    const z = zombieNear(s, 'shambler', 20, 22);
    const hit = shootOnce(s, m, z);
    return hit && hit.damage === 29;
  })());
  check('ability on cooldown is denied (second fire)', (() => {
    const s = new Session('AB-CD'); const l = addFake(s);
    s.useAbility(l);
    const r2 = s.useAbility(l);
    return r2.error === 'cooldown' && r2.msLeft > 0;
  })());
  check('ability-used event broadcast', (() => {
    const s = new Session('AB-EV'); const l = addFake(s); const m = addFake(s);
    s.useAbility(l);
    return hasEvent(m, 'ability-used') && findEvent(m, 'ability-used').ability === 'rally';
  })());
  check('Heavy Bulwark: frontal damage x0.6 (15 vs 25)', (() => {
    const s = new Session('AB-BUL'); const h = addFake(s); const a = addFake(s);
    s.setRole(h, 'heavy');
    h.x = 15; h.y = 20; h.aim = { x: 1, y: 0 }; a.x = 20; a.y = 20;
    noGrace(h, a);
    s.useAbility(h);
    const hit = shootOnce(s, a, h);
    return hit && hit.damage === 15 && h.hp === 110;
  })());
  check('Heavy Bulwark: damage from behind is full (25)', (() => {
    const s = new Session('AB-BUL2'); const h = addFake(s); const a = addFake(s);
    s.setRole(h, 'heavy');
    h.x = 15; h.y = 20; h.aim = { x: 1, y: 0 }; a.x = 10; a.y = 20;
    noGrace(h, a);
    s.useAbility(h);
    const hit = shootOnce(s, a, h);
    return hit && hit.damage === 25;
  })());
  check('Sharpshooter Longshot: next shot is a guaranteed crit (90 = 45x2)', (() => {
    const s = new Session('AB-LONG'); const sh = addFake(s);
    s.setRole(sh, 'sharpshooter');
    sh.x = 10; sh.y = 20;
    const z = zombieNear(s, 'shambler', 15, 20);
    const r = s.useAbility(sh);
    const hit = shootOnce(s, sh, z);
    return r.ok && sh.longshotArmed === false && hit && hit.damage === 90 && hit.crit === true;
  })());
  check('Scout Skydance: long dodge-dash (0.6s dodge, +20% speed 2s after)', (() => {
    const s = new Session('AB-SKY'); const sc = addFake(s);
    s.setRole(sc, 'scout');
    const r = s.useAbility(sc);
    return r.ok && sc.dodgeUntil - s.nowMs === 600 && sc.skydanceUntil - s.nowMs === 2000 && sc.abilityCdUntil - s.nowMs === 12000;
  })());
  check('Medic Triage: revive window set, cooldown 30s', (() => {
    const s = new Session('AB-TRI'); const m = addFake(s);
    s.setRole(m, 'medic');
    const r = s.useAbility(m);
    return r.ok && m.triageUntil - s.nowMs === 10000 && m.abilityCdUntil - s.nowMs === 30000;
  })());
  check('Medic Triage aura: hurt squadmate regains HP (+2/s)', (() => {
    const s = new Session('AB-TRI2'); const m = addFake(s); const q = addFake(s);
    s.setRole(m, 'medic');
    m.x = 15; m.y = 20; q.x = 15; q.y = 22; q.hp = 50;
    s.inviteSquad(m, q.id); s.acceptSquad(q, m.id);
    s.useAbility(m);
    tickN(s, 20); // 1 s of aura
    return q.hp > 50 && q.hp <= 52.1;
  })());
  check('Engineer Fortify: instant barricade at nearest point, free', (() => {
    const s = new Session('AB-FORT'); const e = addFake(s);
    s.setRole(e, 'engineer');
    e.x = 14; e.y = 15.5; e.carried.materials = 0;
    const r = s.useAbility(e);
    return r.ok && s.barricades.length === 1 && s.barricades[0].pointId === 'barricade-1' && e.carried.materials === 0;
  })());
  check('Engineer Fortify: free-standing barricade when no point is near', (() => {
    const s = new Session('AB-FORT2'); const e = addFake(s);
    s.setRole(e, 'engineer');
    e.x = 20; e.y = 25;
    const r = s.useAbility(e);
    return r.ok && s.barricades.length === 1 && s.barricades[0].pointId === null && s.barricades[0].x === 20 && s.barricades[0].y === 25;
  })());
  check('Engineer Fortify at capacity is denied and does not consume cooldown', (() => {
    const s = new Session('AB-FORT3'); const e = addFake(s);
    s.setRole(e, 'engineer'); e.carried.materials = 8;
    const pts = ['barricade-1', 'barricade-2', 'barricade-3', 'barricade-4'];
    for (const pid of pts) {
      const pt = arena.BARRICADE_POINTS.find(q => q.id === pid);
      e.x = pt.x; e.y = pt.y; s.placeBarricade(e, pid);
    }
    const r = s.useAbility(e);
    return r.error === 'barricade capacity reached' && e.abilityCdUntil === 0 && s.barricades.length === 4;
  })());

  console.log('\n--- unit: squads ---');
  check('squad invite delivered as event to target', (() => {
    const s = new Session('SQ-INV'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id);
    return hasEvent(b, 'squad-invite') && findEvent(b, 'squad-invite').fromId === a.id;
  })());
  check('squad accept forms a squad of 2, inviter is leader', (() => {
    const s = new Session('SQ-ACC'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id);
    const r = s.acceptSquad(b, a.id);
    const sq = s.squads.get(r.squadId);
    return r.ok && sq.members.length === 2 && sq.leaderId === a.id && a.squadId === b.squadId;
  })());
  check('squad cap 4: fifth invite refused', (() => {
    const s = new Session('SQ-CAP'); const ps = [addFake(s), addFake(s), addFake(s), addFake(s), addFake(s)];
    const [a, b, c, d, e] = ps;
    for (const m of [b, c, d]) { s.inviteSquad(a, m.id); s.acceptSquad(m, a.id); }
    const r = s.inviteSquad(a, e.id);
    return r.error === 'squad full' && !hasEvent(e, 'squad-invite') && s.squads.get(a.squadId).members.length === 4;
  })());
  check('squad decline notifies the inviter', (() => {
    const s = new Session('SQ-DEC'); const a = addFake(s); const f = addFake(s);
    s.inviteSquad(a, f.id);
    const r = s.declineSquad(f, a.id);
    return r.ok && hasEvent(a, 'squad-decline') && !s.invites.has(f.id);
  })());
  check('squad invite expires after 20s', (() => {
    const s = new Session('SQ-EXP'); const a = addFake(s); const g = addFake(s);
    s.inviteSquad(a, g.id);
    s.nowMs += 21000;
    return s.acceptSquad(g, a.id).error === 'invite expired';
  })());
  check('shared waypoint visible to member, invisible to non-member', (() => {
    const s = new Session('SQ-WP'); const a = addFake(s); const b = addFake(s); const solo = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.setWaypoint(a, 20, 25);
    const snapB = s.snapshotFor(b), snapSolo = s.snapshotFor(solo);
    return snapB.squad && snapB.squad.waypoint && snapB.squad.waypoint.x === 20 && snapB.squad.waypoint.y === 25 && snapSolo.squad === null;
  })());
  check('waypoint clear works', (() => {
    const s = new Session('SQ-WP2'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.setWaypoint(a, 20, 25); s.setWaypoint(a, null, null);
    return s.snapshotFor(b).squad.waypoint === null;
  })());
  check('shared-loot toggle is leader-only, then flips', (() => {
    const s = new Session('SQ-LOOT'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    const denied = s.toggleSquadLoot(b);
    const ok = s.toggleSquadLoot(a);
    return denied.error === 'leader only' && ok.ok && ok.lootSplit === true && s.snapshotFor(b).squad.lootSplit === true;
  })());
  check('squad leave removes member and announces; leader leaves -> next member leads', (() => {
    const s = new Session('SQ-LEAVE'); const a = addFake(s); const b = addFake(s); const c = addFake(s);
    for (const m of [b, c]) { s.inviteSquad(a, m.id); s.acceptSquad(m, a.id); }
    s.leaveSquad(b);
    const afterB = s.squads.get(a.squadId).members.length === 2 && b.squadId === null && hasEvent(a, 'squad-left');
    s.leaveSquad(a);
    const sq = s.squads.get(c.squadId);
    return afterB && sq.leaderId === c.id && sq.members.length === 1;
  })());
  check('squad-joined event broadcast on accept', (() => {
    const s = new Session('SQ-JOIN'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    return hasEvent(a, 'squad-joined') && findEvent(a, 'squad-joined').members.length === 2;
  })());

  console.log('\n--- unit: revive timing ladder ---');
  check('revive ladder: base 3s (solos)', (() => {
    const s = new Session('RV-BASE'); const a = addFake(s); const b = addFake(s);
    return s.reviveTimeFor(a, b) === 3000;
  })());
  check('revive ladder: squadmate 2s', (() => {
    const s = new Session('RV-SQ'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    return s.reviveTimeFor(a, b) === 2000;
  })());
  check('revive ladder: Medic 1.5s', (() => {
    const s = new Session('RV-MED'); const m = addFake(s); const b = addFake(s);
    s.setRole(m, 'medic');
    return s.reviveTimeFor(m, b) === 1500;
  })());
  check('revive ladder: Medic + Triage 0.8s', (() => {
    const s = new Session('RV-TRI'); const m = addFake(s); const b = addFake(s);
    s.setRole(m, 'medic'); m.triageUntil = s.nowMs + 10000;
    return s.reviveTimeFor(m, b) === 800;
  })());
  check('revive ladder: revive perk x0.75 (2250ms base)', (() => {
    const s = new Session('RV-PERK'); const a = addFake(s); const b = addFake(s);
    a.perkChoices = ['revive']; s.applyPerk(a, 'revive');
    return s.reviveTimeFor(a, b) === 2250;
  })());
  check('live squadmate revive completes in ~2s (still downed at 1.95s, alive at 2.05s)', (() => {
    const s = new Session('RV-LIVE'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.downPlayer(b, null);
    a.x = b.x + 1; a.y = b.y; a.interactHeld = true;
    tickN(s, 39);
    const stillDown = b.state === 'downed';
    tickN(s, 2);
    return stillDown && b.state === 'alive' && b.hp === 50;
  })());
  check('revived player returns at 50% HP (already Phase 1, still true)', (() => {
    const s = new Session('RV-HP'); const a = addFake(s); const b = addFake(s);
    s.downPlayer(b, null);
    a.x = b.x + 1; a.y = b.y; a.interactHeld = true;
    tickN(s, 70);
    return b.state === 'alive' && b.hp === 50;
  })());

  console.log('\n--- unit: trust / marks / bounty ---');
  check('trust gain: same-squad revive +8', (() => {
    const s = new Session('TR-RV'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.downPlayer(b, null);
    a.x = b.x + 1; a.y = b.y; a.interactHeld = true;
    tickN(s, 45);
    return b.state === 'alive' && a.trust === 8;
  })());
  check('trust gain: cross-squad revive +12', (() => {
    const s = new Session('TR-XRV'); const a = addFake(s); const x = addFake(s);
    const b = addFake(s); const y = addFake(s);
    s.inviteSquad(a, x.id); s.acceptSquad(x, a.id);
    s.inviteSquad(b, y.id); s.acceptSquad(y, b.id);
    s.downPlayer(b, null);
    a.x = b.x + 1; a.y = b.y; a.interactHeld = true;
    tickN(s, 65);
    return b.state === 'alive' && a.trust === 12;
  })());
  check('trust loss: one stray shot in a firefight (zombie near victim) -1', (() => {
    const s = new Session('TR-STRAY'); const a = addFake(s); const b = addFake(s);
    a.x = 10; a.y = 20; b.x = 15; b.y = 20;
    noGrace(a, b);
    zombieNear(s, 'shambler', 15, 23); // near b, off the firing line
    shootOnce(s, a, b);
    return a.trust === -1 && b.hp === 75;
  })());
  check('trust loss: repeated shot at same player -2 (total -3)', (() => {
    const s = new Session('TR-REP'); const a = addFake(s); const b = addFake(s);
    a.x = 10; a.y = 20; b.x = 15; b.y = 20;
    noGrace(a, b);
    zombieNear(s, 'shambler', 15, 23);
    shootOnce(s, a, b);
    shootOnce(s, a, b);
    return a.trust === -3 && b.hp === 50;
  })());
  check('trust loss: shot with no zombie near victim -2', (() => {
    const s = new Session('TR-NOZ'); const a = addFake(s); const c = addFake(s);
    a.x = 25; a.y = 20; c.x = 30; c.y = 20;
    noGrace(a, c);
    shootOnce(s, a, c);
    return a.trust === -2;
  })());
  check('trust loss: kill another player -20', (() => {
    const s = new Session('TR-KILL'); const a = addFake(s); const b = addFake(s); addFake(s);
    s.killPlayer(b, a, 'test');
    return a.trust === -20 && a.playersKilled === 1;
  })());
  check('trust loss: downer owns a bleed-out death (-20, lastDamager)', (() => {
    const s = new Session('TR-BLEED'); const a = addFake(s); const b = addFake(s); addFake(s);
    s.downPlayer(b, a);
    b.downedTimerMs = 50;
    tickN(s, 2);
    return b.state === 'dead' && a.playersKilled === 1 && a.trust === -20;
  })());
  check('trust loss: execute a downed player -30 (not -20 on top)', (() => {
    const s = new Session('TR-EX'); const a = addFake(s); const b = addFake(s); addFake(s);
    a.x = 10; a.y = 20; b.x = 15; b.y = 20;
    noGrace(a, b);
    for (let i = 0; i < 4; i++) shootOnce(s, a, b); // 4x25 = downed
    const downed = b.state === 'downed';
    shootOnce(s, a, b); // execute
    return downed && b.state === 'dead' && a.trust === -38 && hasEvent(a, 'player-executed');
  })());
  check('trust loss: looting a player you just killed -5 extra', (() => {
    const s = new Session('TR-LOOT'); const a = addFake(s); const b = addFake(s); addFake(s);
    s.killPlayer(b, a, 'test'); // -20
    a.x = b.x; a.y = b.y; a.interactHeld = true;
    tickN(s, 1);
    return a.trust === -25;
  })());
  check('mark: trust -10 -> Suspect, marked, player-marked event', (() => {
    const s = new Session('TR-MARK'); const m = addFake(s);
    s.addTrust(m, -10);
    return m.marked === true && trustRank(m.trust) === 'suspect' && hasEvent(m, 'player-marked');
  })());
  check('mark: trust -31 -> Traitor, bounty = 10 + 5 x kills', (() => {
    const s = new Session('TR-TRAIT'); const m = addFake(s);
    m.playersKilled = 2;
    s.addTrust(m, -31);
    return trustRank(m.trust) === 'traitor' && bountyFor(m) === 20;
  })());
  check('mark visible in snapshot (marked, rank, bounty)', (() => {
    const s = new Session('TR-SNAP'); const m = addFake(s);
    m.playersKilled = 2;
    s.addTrust(m, -31);
    const snap = s.snapshotFor(m).players.find(q => q.id === m.id);
    return snap.marked === true && snap.trustRank === 'traitor' && snap.bounty === 20 && snap.trust === -31;
  })());
  check('bounty payout: killing a Traitor pays bounty XP + bounty-claimed event', (() => {
    const s = new Session('TR-BOUNTY'); const t = addFake(s); const k = addFake(s); addFake(s);
    t.playersKilled = 2;
    s.addTrust(t, -31);
    s.killPlayer(t, k, 'test');
    const ev = findEvent(k, 'bounty-claimed');
    return k.xp === 20 && !!ev && ev.amount === 20 && ev.victimId === t.id;
  })());
  check('rebuild trust: +20 trust clears the mark (mark-cleared event)', (() => {
    const s = new Session('TR-CLEAR'); const m = addFake(s);
    s.addTrust(m, -10);
    const marked = m.marked;
    s.addTrust(m, 20);
    return marked && m.marked === false && trustRank(m.trust) === 'neutral' && hasEvent(m, 'mark-cleared');
  })());
  check('trust ranks: Trusted >=30, Neutral -9..29', trustRank(30) === 'trusted' && trustRank(29) === 'neutral' && trustRank(-9) === 'neutral' && trustRank(-10) === 'suspect' && trustRank(-31) === 'traitor');
  check('grace period: PvP blocked, zombie damage lands', (() => {
    const s = new Session('TR-GRACE'); const a = addFake(s); const b = addFake(s);
    a.x = 10; a.y = 20; b.x = 15; b.y = 20; // both inside 10s grace
    const hit = s.shootAt(a, { x: 1, y: 0 }, s.nowMs);
    const z = zombieNear(s, 'shambler', 16, 20);
    z.state = 'windup'; z.windupUntil = s.nowMs; z.attackTarget = b;
    s.zombieAttack(z, b, ZOMBIE_TYPES.shambler);
    return (!hit || hit.hit === false) && b.hp < 100;
  })());
  check('shared kill near a squadmate +2 trust', (() => {
    const s = new Session('TR-SHARE'); const a = addFake(s); const b = addFake(s);
    a.x = 15; a.y = 20; b.x = 15; b.y = 22; // off the firing line, within 5
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    const z = zombieNear(s, 'shambler', 20, 20); z.hp = 1;
    shootOnce(s, a, z);
    return a.trust === 2;
  })());
  check('share loot: 12 ammo to a nearby player, +5 trust', (() => {
    const s = new Session('TR-SHARE2'); const a = addFake(s); const b = addFake(s);
    a.x = 15; a.y = 20; b.x = 16; b.y = 20;
    const r = s.shareLoot(a, b.id, 'ammo');
    return r.ok && b.ammo.pistol === 60 && a.ammo.pistol === 36 && a.trust === 5 && hasEvent(b, 'shared-loot');
  })());
  check('share loot: 1 med to a nearby player, +5 trust', (() => {
    const s = new Session('TR-SHARE3'); const a = addFake(s); const b = addFake(s);
    a.x = 15; a.y = 20; b.x = 16; b.y = 20;
    const r = s.shareLoot(a, b.id, 'meds');
    return r.ok && b.carried.meds === 2 && a.carried.meds === 0 && a.trust === 5;
  })());
  check('share loot too far is refused', (() => {
    const s = new Session('TR-SHARE4'); const a = addFake(s); const b = addFake(s);
    a.x = 15; a.y = 20; b.x = 25; b.y = 20;
    return s.shareLoot(a, b.id, 'ammo').error === 'target too far';
  })());

  console.log('\n--- unit: XP + perks ---');
  check('XP values per zombie type (shambler 10, runner 12, screamer 15, spitter 20, brute 50)', XP_VALUES.shambler === 10 && XP_VALUES.runner === 12 && XP_VALUES.screamer === 15 && XP_VALUES.spitter === 20 && XP_VALUES.brute === 50);
  check('zombie kill grants XP (shambler 10)', (() => {
    const s = new Session('XP-KILL'); const p = addFake(s);
    p.x = 10; p.y = 20;
    const z = zombieNear(s, 'shambler', 15, 20); z.hp = 1;
    shootOnce(s, p, z);
    return p.xp === 10 && p.kills === 1;
  })());
  check('elite kill grants double XP', (() => {
    const s = new Session('XP-ELITE'); const p = addFake(s);
    p.x = 10; p.y = 20;
    const z = zombieNear(s, 'shambler', 15, 20); z.hp = 1; z.elite = 'swift';
    shootOnce(s, p, z);
    return p.xp === 20;
  })());
  check('level-up at 50 XP offers 3 distinct perk choices + level-up event', (() => {
    const s = new Session('XP-LVL'); const p = addFake(s);
    s.grantXp(p, 49);
    const before = p.level === 0;
    s.grantXp(p, 1);
    return before && p.level === 1 && p.perkChoices && p.perkChoices.length === 3 && new Set(p.perkChoices).size === 3 && hasEvent(p, 'level-up');
  })());
  check('perk pick applies: damage +10% (shot 28 vs 25)', (() => {
    const s = new Session('XP-PERK'); const p = addFake(s);
    p.x = 10; p.y = 20;
    s.grantXp(p, 50);
    p.perkChoices = ['damage', 'hp', 'reload'];
    const ok = s.applyPerk(p, 'damage');
    const z = zombieNear(s, 'shambler', 15, 20);
    const hit = shootOnce(s, p, z);
    return ok && p.perks.includes('damage') && hit && hit.damage === 28;
  })());
  check('perk pick: same perk twice rejected, unoffered perk rejected', (() => {
    const s = new Session('XP-PERK2'); const p = addFake(s);
    p.perkChoices = ['damage', 'hp', 'reload'];
    const first = s.applyPerk(p, 'damage');
    const second = s.applyPerk(p, 'damage');
    const q = addFake(s); q.perkChoices = ['hp'];
    return first && !second && !s.applyPerk(q, 'damage');
  })());
  check('perk pick: hp +15 max HP and heal 15', (() => {
    const s = new Session('XP-HP'); const p = addFake(s);
    p.perkChoices = ['hp', 'damage', 'reload'];
    const ok = s.applyPerk(p, 'hp');
    return ok && p.maxHp === 115 && p.hp === 115;
  })());
  check('perk pick: reload 20% faster (960ms vs 1200ms)', (() => {
    const s = new Session('XP-RL'); const p = addFake(s);
    p.perkChoices = ['reload', 'hp', 'damage'];
    s.applyPerk(p, 'reload');
    p.mag.pistol = 2;
    s.tryReload(p);
    return p.reloadingUntil - s.nowMs === 960;
  })());
  check('perk pick: barricade +1 capacity (cap 3)', (() => {
    const s = new Session('XP-BAR'); const p = addFake(s);
    p.perkChoices = ['barricade', 'hp', 'damage'];
    s.applyPerk(p, 'barricade');
    return s.barricadeCapFor(p) === 3;
  })());
  check('perk pick: quiet -25% noise (attention +0.75 per pistol shot)', (() => {
    const s = new Session('XP-QUIET'); const p = addFake(s);
    p.perkChoices = ['quiet', 'hp', 'damage'];
    s.applyPerk(p, 'quiet');
    p.lastShotMs = -9999; p.mag.pistol = 12;
    s.shootAt(p, { x: 1, y: 0 }, s.nowMs);
    return s.director.attention === 0.75;
  })());
  check('perk pick: ammo +25% from pickups (100 -> 125)', (() => {
    const s = new Session('XP-AMMO'); const p = addFake(s);
    p.perkChoices = ['ammo', 'hp', 'damage'];
    s.applyPerk(p, 'ammo');
    s.lootPiles.push({ id: 'lx', x: p.x, y: p.y, items: { ammo: { pistol: 100 } }, taken: false });
    p.interactHeld = true;
    tickN(s, 1);
    return p.ammo.pistol === 48 + 125;
  })());
  check('perks are session-only (fresh session, level 0, no perks)', (() => {
    const s = new Session('XP-FRESH'); const p = addFake(s);
    return p.level === 0 && p.xp === 0 && p.perks.length === 0;
  })());
  check('Leader aura: squadmate within 8 tiles gains +5% XP (rounded up)', (() => {
    const s = new Session('XP-AURA'); const l = addFake(s); const m = addFake(s);
    s.setRole(l, 'leader');
    l.x = 15; l.y = 20; m.x = 15; m.y = 22;
    s.inviteSquad(l, m.id); s.acceptSquad(m, l.id);
    const gained = s.grantXp(m, 10);
    return gained === 11 && m.xp === 11;
  })());

  console.log('\n--- unit: barricades ---');
  check('barricade build: 2s channel, 2 materials, 60 HP, snapshot-listed', (() => {
    const s = new Session('BAR-1'); const p = addFake(s);
    p.x = 12.5; p.y = 16.5; p.carried.materials = 2;
    const r = s.startBarricade(p, 'barricade-2');
    tickN(s, 45);
    const snap = s.snapshotFor(p);
    return r.ok && r.buildMs === 2000 && s.barricades.length === 1 && s.barricades[0].hp === 60 && p.carried.materials === 0 && snap.barricades.length === 1;
  })());
  check('Engineer builds 50% faster (1s)', (() => {
    const s = new Session('BAR-ENG'); const p = addFake(s);
    s.setRole(p, 'engineer');
    p.x = 18.5; p.y = 16.5; p.carried.materials = 2;
    const r = s.startBarricade(p, 'barricade-3');
    tickN(s, 25);
    return r.ok && r.buildMs === 1000 && s.barricades.length === 1;
  })());
  check('barricade build interrupted by damage', (() => {
    const s = new Session('BAR-INT'); const p = addFake(s);
    p.x = 12.5; p.y = 16.5; p.carried.materials = 2;
    s.startBarricade(p, 'barricade-2');
    s.damagePlayer(p, 5, null);
    return p.building === null && s.barricades.length === 0;
  })());
  check('barricade build needs 2 materials / proximity / free point', (() => {
    const s = new Session('BAR-VAL'); const p = addFake(s);
    p.x = 12.5; p.y = 16.5; p.carried.materials = 1;
    const noMats = s.startBarricade(p, 'barricade-2').error === 'need 2 materials';
    p.carried.materials = 2; p.x = 25; p.y = 25;
    const far = s.startBarricade(p, 'barricade-2').error === 'too far from barricade point';
    return noMats && far;
  })());
  check('zombie within 1.5 tiles attacks the barricade instead of moving', (() => {
    const s = new Session('BAR-ATK'); const p = addFake(s);
    p.x = 12.5; p.y = 16.5; p.carried.materials = 2;
    s.placeBarricade(p, 'barricade-2');
    p.x = 12.5; p.y = 19;
    zombieNear(s, 'shambler', 12.5, 17.5);
    tickN(s, 20);
    return s.barricades[0].hp < 60;
  })());
  check('barricade breaks at 0 HP with barricade-destroyed event', (() => {
    const s = new Session('BAR-BRK'); const p = addFake(s);
    p.x = 12.5; p.y = 16.5; p.carried.materials = 2;
    s.placeBarricade(p, 'barricade-2');
    s.barricades[0].hp = 1;
    p.x = 12.5; p.y = 19;
    zombieNear(s, 'shambler', 12.5, 17.5);
    tickN(s, 20);
    return s.barricades.length === 0 && hasEvent(p, 'barricade-destroyed');
  })());
  check('barricade capacity enforced (3rd refused at cap 2)', (() => {
    const s = new Session('BAR-CAP'); const p = addFake(s);
    p.carried.materials = 6;
    for (const pid of ['barricade-2', 'barricade-3']) {
      const pt = arena.BARRICADE_POINTS.find(q => q.id === pid);
      p.x = pt.x; p.y = pt.y; s.placeBarricade(p, pid);
    }
    const pt = arena.BARRICADE_POINTS.find(q => q.id === 'barricade-4');
    p.x = pt.x; p.y = pt.y;
    return s.startBarricade(p, 'barricade-4').error === 'barricade capacity reached';
  })());

  console.log('\n--- unit: traps ---');
  check('spike trap: zombie stepping within 1 tile takes 20 damage, trap consumed', (() => {
    const s = new Session('TRP-SPIKE'); const p = addFake(s);
    p.x = 15; p.y = 20; p.carried.materials = 1;
    const r = s.placeTrap(p, 'spike');
    const z = zombieNear(s, 'shambler', 15, 20.5);
    tickN(s, 5);
    return r.ok && s.traps.length === 0 && z.hp === 10 && hasEvent(p, 'trap-triggered');
  })());
  check('molotov trap: burns 10 dps for 3s in 2 tiles, then consumed', (() => {
    const s = new Session('TRP-MOL'); const p = addFake(s);
    p.x = 15; p.y = 20; p.carried.materials = 1;
    s.placeTrap(p, 'molotov');
    const z = zombieNear(s, 'shambler', 15, 20.5);
    tickN(s, 2);
    const triggered = s.traps.length === 0 && s.burnZones.length === 1;
    const hpAfterTrigger = z.hp;
    tickN(s, 20); // 1 s of burn = 10 damage
    return triggered && z.hp === hpAfterTrigger - 10;
  })());
  check('noise trap: +20 director attention and lures zombies within 10 tiles', (() => {
    const s = new Session('TRP-NOISE'); const p = addFake(s);
    p.x = 15; p.y = 20; p.carried.materials = 1;
    s.placeTrap(p, 'noise');
    zombieNear(s, 'shambler', 15, 20.5);
    const z2 = zombieNear(s, 'shambler', 15, 25);
    tickN(s, 2);
    return s.traps.length === 0 && s.director.attention > 15 && z2.lureUntil > s.nowMs;
  })());
  check('trap costs 1 material (refused at 0)', (() => {
    const s = new Session('TRP-COST'); const p = addFake(s);
    p.carried.materials = 0;
    return s.placeTrap(p, 'spike').error === 'need 1 material';
  })());
  check('unknown trap kind rejected', (() => {
    const s = new Session('TRP-X'); const p = addFake(s);
    p.carried.materials = 1;
    return !!s.placeTrap(p, 'bear').error;
  })());

  console.log('\n--- unit: attachments ---');
  check('scope: rifle range +10 (40) and spread x0.5', (() => {
    const s = new Session('ATT-SCOPE'); const p = addFake(s);
    p.attachments.rifle = 'scope';
    const st = s.weaponStats(p, 'rifle');
    return st.range === 40 && st.spread === 0.0025;
  })());
  check('extended mag: SMG mag +50% (45)', (() => {
    const s = new Session('ATT-MAG'); const p = addFake(s);
    p.attachments.smg = 'extended-mag';
    return s.weaponStats(p, 'smg').mag === 45;
  })());
  check('grip: spread x0.7', (() => {
    const s = new Session('ATT-GRIP'); const p = addFake(s);
    p.attachments.pistol = 'grip';
    return Math.abs(s.weaponStats(p, 'pistol').spread - 0.014) < 1e-9;
  })());
  check('no attachment: base weapon stats unchanged', (() => {
    const s = new Session('ATT-BASE'); const p = addFake(s);
    return s.weaponStats(p, 'rifle').range === 30 && s.weaponStats(p, 'smg').mag === 30;
  })());

  console.log('\n--- unit: weapon-grant path ---');
  check('crate can grant a weapon the player does not own (rifle — shotgun is now the breather-0 second weapon)', (() => {
    const s = new Session('WG-CRATE'); const p = addFake(s);
    const crate = s.crates[0];
    p.x = crate.x; p.y = crate.y; p.interactHeld = true;
    const realRandom = Math.random;
    Math.random = () => 0.1; // < 0.35 -> weapon branch, missing[0] = rifle (shotgun already owned from breather 0)
    try { tickN(s, 1); } finally { Math.random = realRandom; }
    const ev = findEvent(p, 'crate-looted');
    return p.weapons.includes('rifle') && !!ev && ev.granted === 'rifle';
  })());
  check('crate can grant an attachment for an owned gun', (() => {
    const s = new Session('WG-ATT'); const p = addFake(s);
    const crate = s.crates[0];
    p.x = crate.x; p.y = crate.y; p.interactHeld = true;
    const realRandom = Math.random;
    Math.random = () => 0.4; // 0.35..0.55 -> attachment branch
    try { tickN(s, 1); } finally { Math.random = realRandom; }
    const ev = findEvent(p, 'crate-looted');
    return p.attachments.pistol === 'extended-mag' && !!ev && ev.attachment && ev.attachment.name === 'extended-mag';
  })());
  check('death pile drops owned non-starting weapons; victim keeps their list', (() => {
    const s = new Session('WG-PILE'); const h = addFake(s); const q = addFake(s);
    s.setRole(h, 'heavy');
    s.killPlayer(h, null, 'test');
    const pile = s.lootPiles[0];
    return pile.items.weapons.includes('shotgun') && h.weapons.includes('shotgun') && h.weapons.includes('melee');
  })());
  check('death-pile weapon is lootable by another player', (() => {
    const s = new Session('WG-PILE2'); const h = addFake(s); const q = addFake(s);
    s.setRole(h, 'heavy');
    s.killPlayer(h, null, 'test');
    const pile = s.lootPiles[0];
    q.x = pile.x; q.y = pile.y; q.interactHeld = true;
    tickN(s, 1);
    return q.weapons.includes('shotgun');
  })());
  check('role starts with its weapon (Heavy shotgun, Sharpshooter rifle, Scout SMG)', (() => {
    const s = new Session('WG-ROLE'); const h = addFake(s); const sh = addFake(s); const sc = addFake(s);
    s.setRole(h, 'heavy'); s.setRole(sh, 'sharpshooter'); s.setRole(sc, 'scout');
    return h.weapons.includes('shotgun') && sh.weapons.includes('rifle') && sc.weapons.includes('smg');
  })());

  console.log('\n--- unit: noise economy visibility ---');
  check('per-player noise: pistol shot = 10, decays 20/s', (() => {
    const s = new Session('NOISE-1'); const p = addFake(s);
    p.lastShotMs = -9999; p.mag.pistol = 12;
    s.shootAt(p, { x: 1, y: 0 }, s.nowMs);
    const afterShot = p.noise === 10;
    tickN(s, 5);
    return afterShot && p.noise === 5;
  })());
  check('melee kills add no noise (already Phase 1, still true)', (() => {
    const s = new Session('NOISE-2'); const p = addFake(s);
    p.currentWeapon = 'melee'; p.x = 10; p.y = 20;
    const z = zombieNear(s, 'shambler', 11, 20); z.hp = 1;
    shootOnce(s, p, z);
    return p.noise === 0 && s.director.attention === 0;
  })());
  check('surge-warning event fires when attention crosses 35', (() => {
    const s = new Session('NOISE-3'); const p = addFake(s);
    for (let i = 0; i < 40; i++) { p.lastShotMs = -9999; p.mag.pistol = 12; s.shootAt(p, { x: 1, y: 0 }, s.nowMs); }
    s.directorTick();
    return hasEvent(p, 'surge-warning') && findEvent(p, 'surge-warning').attention >= 35;
  })());
  check('quiet pacing differs: 40 quiet shots stay below the warning threshold', (() => {
    const s = new Session('NOISE-4'); const p = addFake(s);
    p.perkChoices = ['quiet']; s.applyPerk(p, 'quiet');
    for (let i = 0; i < 40; i++) { p.lastShotMs = -9999; p.mag.pistol = 12; s.shootAt(p, { x: 1, y: 0 }, s.nowMs); }
    s.directorTick();
    return s.director.attention < 35 && !hasEvent(p, 'surge-warning');
  })());

  console.log('\n--- unit: heal channel ---');
  check('heal: 1 med heals 40 HP over 2s', (() => {
    const s = new Session('HEAL-1'); const p = addFake(s);
    p.hp = 50; p.carried.meds = 1;
    const r = s.startHeal(p);
    tickN(s, 40);
    return r.ok && p.carried.meds === 0 && p.hp === 90 && p.healing === null;
  })());
  check('heal interrupted by damage', (() => {
    const s = new Session('HEAL-2'); const p = addFake(s);
    p.hp = 50; p.carried.meds = 1;
    s.startHeal(p);
    s.damagePlayer(p, 5, null);
    tickN(s, 40);
    return p.healing === null && p.hp === 45;
  })());
  check('heal refused with no meds / at full HP', (() => {
    const s = new Session('HEAL-3'); const p = addFake(s); const q = addFake(s);
    p.carried.meds = 0; p.hp = 50;
    q.carried.meds = 1; q.hp = 100;
    return s.startHeal(p).error === 'no meds' && s.startHeal(q).error === 'already full HP';
  })());

  console.log('\n--- unit: end screen ---');
  check('endScore has all Phase 2 fields per player', (() => {
    const s = new Session('END-1'); const a = addFake(s); const b = addFake(s); const c = addFake(s);
    const z = zombieNear(s, 'shambler', 15, 20); z.hp = 1;
    a.x = 10; a.y = 20;
    shootOnce(s, a, z); // a: 1 kill, 10 XP
    s.killPlayer(b, a, 'test');
    s.killPlayer(a, c, 'test');
    s.killPlayer(c, null, 'test'); // wipe
    if (!s.ended) return false;
    const need = ['id', 'role', 'squadId', 'wavesSurvived', 'kills', 'headshots', 'revives', 'playersKilled', 'lootCollected', 'damageDealt', 'timesDowned', 'trust', 'trustRank', 'xp', 'level', 'state'];
    return s.endScore.players.length === 3 && s.endScore.players.every(pl => need.every(k => k in pl));
  })());
  check('endScore titles: Most Betrayals + Last One Standing (last to die)', (() => {
    const s = new Session('END-2'); const a = addFake(s); const b = addFake(s); const c = addFake(s);
    s.killPlayer(b, a, 'test'); s.nowMs += 1000;
    s.killPlayer(a, c, 'test'); s.nowMs += 1000;
    s.killPlayer(c, null, 'test');
    const titles = s.endScore.titles || [];
    const betrayals = titles.find(t => t.title === 'Most Betrayals');
    const last = titles.find(t => t.title === 'Last One Standing');
    return !!betrayals && (betrayals.playerId === a.id || betrayals.playerId === c.id) && !!last && last.playerId === c.id;
  })());
  check('endScore values are honest (kills, betrayals, XP recorded)', (() => {
    const s = new Session('END-3'); const a = addFake(s); const b = addFake(s); const c = addFake(s);
    const z = zombieNear(s, 'shambler', 15, 20); z.hp = 1;
    a.x = 10; a.y = 20;
    shootOnce(s, a, z);
    s.killPlayer(b, a, 'test');
    s.killPlayer(a, c, 'test');
    s.killPlayer(c, null, 'test');
    const pa = s.endScore.players.find(pl => pl.id === a.id);
    return pa.kills === 1 && pa.playersKilled === 1 && pa.xp === 10 && pa.trust === -20;
  })());

  console.log('\n--- unit: snapshot carries Phase 2 fields ---');
  check('snapshot player object has role/xp/trust/noise/ability/squad/weapons/attachments/meds/materials', (() => {
    const s = new Session('SN-P2'); const p = addFake(s);
    s.setRole(p, 'medic');
    const snap = s.snapshotFor(p);
    const sp = snap.players.find(q => q.id === p.id);
    const need = ['role', 'xp', 'level', 'perks', 'trust', 'trustRank', 'marked', 'bounty', 'noise', 'abilityCdMs', 'abilityActive', 'squadId', 'weapons', 'attachments', 'meds', 'materials', 'building'];
    return need.every(k => k in sp) && sp.role === 'medic' && Array.isArray(snap.barricades) && Array.isArray(snap.traps) && 'squad' in snap;
  })());

  console.log('\n--- unit: squad loot split ---');
  check('shared-loot split: crate/pile ammo split evenly among squadmates', (() => {
    const s = new Session('SPLIT-1'); const a = addFake(s); const b = addFake(s);
    // Non-leader roles + fixed positions: no Leader aura interferes, and the
    // result does not depend on the global spawn rotation.
    s.setRole(a, 'scout'); s.setRole(b, 'heavy');
    a.x = 15; a.y = 20; b.x = 16; b.y = 20;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.toggleSquadLoot(a); // leader turns split on
    s.lootPiles.push({ id: 'ls', x: a.x, y: a.y, items: { ammo: { pistol: 100 }, meds: 0 }, taken: false });
    a.interactHeld = true;
    tickN(s, 1);
    // 100 pistol split 2 ways: 50 each (picker is first member, no remainder)
    return a.ammo.pistol === 48 + 50 && b.ammo.pistol === 48 + 50;
  })());
  check('shared-loot split: remainder goes to the picker', (() => {
    const s = new Session('SPLIT-2'); const a = addFake(s); const b = addFake(s);
    s.setRole(a, 'scout'); s.setRole(b, 'heavy');
    a.x = 15; a.y = 20; b.x = 16; b.y = 20;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.toggleSquadLoot(a);
    s.lootPiles.push({ id: 'ls', x: a.x, y: a.y, items: { ammo: { pistol: 101 }, meds: 0 }, taken: false });
    a.interactHeld = true;
    tickN(s, 1);
    return a.ammo.pistol === 48 + 51 && b.ammo.pistol === 48 + 50;
  })());
  check('shared-loot off (default): picker takes all', (() => {
    const s = new Session('SPLIT-3'); const a = addFake(s); const b = addFake(s);
    s.setRole(a, 'scout'); s.setRole(b, 'heavy');
    a.x = 15; a.y = 20; b.x = 16; b.y = 20;
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    s.lootPiles.push({ id: 'ls', x: a.x, y: a.y, items: { ammo: { pistol: 100 }, meds: 0 }, taken: false });
    a.interactHeld = true;
    tickN(s, 1);
    return a.ammo.pistol === 48 + 100 && b.ammo.pistol === 48;
  })());
  check('wave-clear trust: living squadmates +3 each', (() => {
    const s = new Session('SPLIT-4'); const a = addFake(s); const b = addFake(s);
    s.inviteSquad(a, b.id); s.acceptSquad(b, a.id);
    // Force a wave clear: wave phase, nothing left to spawn or alive.
    s.phase = 'wave'; s.wave = 1; s.waveRemainingToSpawn = 0; s.spawnQueue = []; s.zombies.clear();
    tickN(s, 1);
    return s.phase === 'breather' && a.trust === 3 && b.trust === 3;
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
function allEvents(c) { return c.snaps.flatMap(s => s.events || []); }

async function wsTests() {
  console.log('\n--- live WS: Phase 2 messages over the wire ---');
  const a = await wsClient();
  await waitFor(a, m => m.type === 'welcome');
  const b = await wsClient();
  await waitFor(b, m => m.type === 'welcome');
  check('WS: two clients connected (default session)', !!a.id && !!b.id, `${a.id} + ${b.id}`);
  // Role pick over WS.
  a.ws.send(JSON.stringify({ type: 'role', role: 'heavy' }));
  await wait(400);
  const snapA = lastSnap(a);
  const entryA = snapA && snapA.players.find(p => p.id === a.id);
  check('WS: role message applies (Heavy, shotgun, 125 HP)', entryA && entryA.role === 'heavy' && entryA.weapon === 'shotgun' && entryA.maxHp === 125, JSON.stringify(entryA && { role: entryA.role, weapon: entryA.weapon, maxHp: entryA.maxHp }));
  check('WS: snapshot carries Phase 2 player fields', entryA && 'trust' in entryA && 'xp' in entryA && 'noise' in entryA && 'abilityCdMs' in entryA && Array.isArray(entryA.weapons));
  check('WS: snapshot carries squad/barricades/traps', snapA && 'squad' in snapA && Array.isArray(snapA.barricades) && Array.isArray(snapA.traps));
  // Ability over WS (Bulwark, 30 s cooldown).
  a.ws.send(JSON.stringify({ type: 'ability' }));
  await wait(400);
  check('WS: ability-used event reaches both clients', allEvents(a).some(e => e.type === 'ability-used' && e.ability === 'bulwark') && allEvents(b).some(e => e.type === 'ability-used' && e.ability === 'bulwark'));
  const snapA2 = lastSnap(a);
  const entryA2 = snapA2 && snapA2.players.find(p => p.id === a.id);
  check('WS: ability cooldown visible in snapshot', entryA2 && entryA2.abilityCdMs > 25000 && entryA2.abilityActive && entryA2.abilityActive.name === 'bulwark');
  // Squad invite/accept over WS.
  a.ws.send(JSON.stringify({ type: 'squad-invite', targetId: b.id }));
  await wait(400);
  check('WS: squad-invite event reaches the target', allEvents(b).some(e => e.type === 'squad-invite' && e.fromId === a.id));
  b.ws.send(JSON.stringify({ type: 'squad-accept', fromId: a.id }));
  await wait(400);
  const snapB = lastSnap(b);
  check('WS: squad forms over the wire (2 members, A leads)', snapB && snapB.squad && snapB.squad.members.length === 2 && snapB.squad.leaderId === a.id, JSON.stringify(snapB && snapB.squad));
  check('WS: both clients see each other\'s squadId', (() => {
    const sa = lastSnap(a), sb = lastSnap(b);
    const pa = sa && sa.players.find(p => p.id === a.id);
    const pb = sb && sb.players.find(p => p.id === b.id);
    return pa && pb && pa.squadId && pa.squadId === pb.squadId;
  })());
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
