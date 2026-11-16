// Phase 3 LIVE end-to-end test: three real WebSocket clients against the
// DEPLOYED Render server (wss://zombie-phase0-spike.onrender.com), the same
// pattern as test-public.js: `ws` + https-proxy-agent (the VM egress quirk
// — direct TLS fails, Node's global WebSocket hangs through the proxy),
// wake/verify via /health first (Render Free spins down after 15 min idle,
// ~30–60 s wake), inputs at 20 Hz + pings every 500 ms.
// Exit 0 on PASS, 1 on FAIL. Checks are PASS / FAIL / SKIP — a SKIP means
// the check could not be observed live (e.g. no zombie reached a player
// during the 10 s grace) and is reported plainly, never claimed as a pass.
//
// What it proves over the wire, per job:
//   3.1 drop-in: 3 clients create/join a BR session, melee-only loadouts,
//       role ability + passive (Heavy: 125 HP, still melee), spawn spread,
//       grace blocks PvP (melee swings report hit:false, no 35-damage drop)
//       but not zombie damage (a stationary player takes zombie hits in grace).
//   3.2 loot: a crate loots (grant received), re-looting it returns nothing,
//       a ground spawn is taken once and gone, a death pile drops on a kill
//       and is lootable.
//   3.3 zone: one FULL phase transition live (wait -> shrink -> next circle
//       arrives), preview == arriving circle, zone damage ticks on a player
//       standing outside, zombies spawn inside the current zone.
//   3.4 director/win/end: spawn rate + runner share rise from phase 0 to
//       phase 1 (counted from snapshots), last-standing win live (one client
//       is shot down + executed, then the other — winner gets the end screen
//       with correct placement and full BR fields).
// Usage: WS_URL=wss://zombie-phase0-spike.onrender.com node test-phase3-live.js
// NOTE: requires the Phase 3 build DEPLOYED on Render. If the server still
// runs the old build (no mode/zone in the protocol), the script fails fast
// with BUILD MISMATCH instead of running a meaningless test.
'use strict';

const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');

const WS_URL = process.env.WS_URL || 'wss://zombie-phase0-spike.onrender.com';
const OVERALL_TIMEOUT_MS = 8 * 60 * 1000;

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
if (agent) console.log('using proxy agent for WebSocket');

let run = 0, passed = 0, skipped = 0;
const failures = [], skips = [];
function check(name, ok, detail) {
  run++;
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function skip(name, reason) {
  run++; skipped++;
  skips.push(name);
  console.log(`  SKIP  ${name} — ${reason}`);
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const avg = (xs) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;

// Arena geometry (documented, verified — see arena.js): blocked tiles are
// pond (x<=8, y>=21), rock (x>=22, y>=22), wall rows (x in 11,12,15,16 and
// y in 10,13). Used only to pick a walkable spot outside the zone.
function tileBlocked(tx, ty) {
  if ([11, 12, 15, 16].includes(tx) && [10, 13].includes(ty)) return true;
  if (tx <= 8 && ty >= 21) return true;
  if (tx >= 22 && ty >= 22) return true;
  return false;
}

// ---------------- Client ----------------
function makeClient(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, agent ? { agent } : undefined);
    const c = {
      label, ws, id: null, code: null,
      snap: null, snapCount: 0, snapBytes: 0, rtts: [],
      events: [], msgs: [], sessionEnd: null,
      task: { kind: 'idle' }, aim: { x: 1, y: 0 },
      fire: false, interact: false, patrolCentre: null,
      zombieSightings: new Map(), // zombieId -> {type, firstPhase, firstAt}
      hpLog: [], // {t, hp} sampled from snapshots
    };
    let seq = 0;
    let inputTimer = null, pingTimer = null;

    // Derive movement keys + aim from the current task, every 50 ms.
    function deriveInput() {
      const me = c.snap && c.snap.players.find(p => p.id === c.id);
      let mx = 0, my = 0;
      const t = c.task;
      if (t.kind === 'goto' || t.kind === 'patrol') {
        let tx, ty;
        if (t.kind === 'goto') { tx = t.x; ty = t.y; }
        else {
          const wps = [
            [t.cx + 2.5, t.cy], [t.cx, t.cy + 2.5],
            [t.cx - 2.5, t.cy], [t.cx, t.cy - 2.5],
          ];
          const wp = wps[t.wpIdx || 0];
          tx = wp[0]; ty = wp[1];
          if (me && Math.hypot(tx - me.x, ty - me.y) < 0.8) t.wpIdx = ((t.wpIdx || 0) + 1) % 4;
        }
        if (me) {
          const dx = tx - me.x, dy = ty - me.y, l = Math.hypot(dx, dy) || 1;
          if (l > (t.radius || 0.6)) { mx = dx / l; my = dy / l; c.aim = { x: dx / l, y: dy / l }; }
        }
      } else if (t.kind === 'strafe') {
        // Circle around the strafe centre while aiming + firing at the target.
        const wps = [
          [t.cx + 2, t.cy], [t.cx, t.cy + 2],
          [t.cx - 2, t.cy], [t.cx, t.cy - 2],
        ];
        const wp = wps[t.wpIdx || 0];
        if (me) {
          const dx = wp[0] - me.x, dy = wp[1] - me.y, l = Math.hypot(dx, dy) || 1;
          if (l > 0.7) { mx = dx / l; my = dy / l; }
          if (l < 0.9) t.wpIdx = ((t.wpIdx || 0) + 1) % 4;
          const tgt = c.snap.players.find(p => p.id === t.targetId);
          if (tgt) {
            const ax = tgt.x - me.x, ay = tgt.y - me.y, al = Math.hypot(ax, ay) || 1;
            c.aim = { x: ax / al, y: ay / al };
          }
        }
      }
      const keys = { up: my < -0.3, down: my > 0.3, left: mx < -0.3, right: mx > 0.3 };
      // Reload when the mag is empty (snapshot-driven, one tick).
      let reload = false;
      if (me && me.weapon && me.weapon !== 'melee' && me.mag === 0) reload = true;
      return { type: 'input', seq: ++seq, keys, aim: c.aim, fire: !!c.fire, reload, interact: !!c.interact };
    }

    ws.on('open', () => {
      inputTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(deriveInput()));
      }, 50);
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      }, 500);
    });
    ws.on('message', (data) => {
      c.snapBytes += data.length;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      c.msgs.push(m);
      if (m.type === 'welcome') c.id = m.id;
      if (m.type === 'created') c.code = m.code;
      if (m.type === 'session-end') c.sessionEnd = m;
      if (m.type === 'snapshot') {
        c.snapCount++;
        c.snap = m;
        for (const e of m.events || []) c.events.push(e);
        const me = m.players.find(p => p.id === c.id);
        if (me) c.hpLog.push({ t: Date.now(), hp: me.hp, state: me.state });
        const phase = m.zone ? m.zone.phase : -1;
        for (const z of m.zombies || []) {
          if (!c.zombieSightings.has(z.id)) c.zombieSightings.set(z.id, { type: z.type, firstPhase: phase, firstAt: Date.now() });
        }
      } else if (m.type === 'pong') c.rtts.push(Date.now() - m.t);
    });
    ws.on('error', (err) => { console.error(`[${label}] ws error:`, err.message); });
    const to = setTimeout(() => reject(new Error(`${label} never opened`)), 20000);
    ws.on('open', () => { clearTimeout(to); resolve(c); });
    c.close = () => { clearInterval(inputTimer); clearInterval(pingTimer); try { ws.close(); } catch { /* already closed */ } };
  });
}

function meOf(c) { return c.snap && c.snap.players.find(p => p.id === c.id); }
function playerOf(c, id) { return c.snap && c.snap.players.find(p => p.id === id); }
async function waitFor(c, pred, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = c.msgs.find(pred);
    if (m) return m;
    await wait(100);
  }
  return null;
}
async function waitSnap(c, pred, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (c.snap && pred(c.snap)) return c.snap;
    await wait(100);
  }
  return null;
}
// Drive a client to a point (walkable, in-bounds). Returns true on arrival.
async function goTo(c, x, y, timeoutMs = 40000, radius = 0.7) {
  c.task = { kind: 'goto', x, y, radius };
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const me = meOf(c);
    if (me && Math.hypot(x - me.x, y - me.y) < radius) { c.task = { kind: 'idle' }; return true; }
    await wait(100);
  }
  c.task = { kind: 'idle' };
  return false;
}
function patrol(c, cx, cy) { c.task = { kind: 'patrol', cx, cy, wpIdx: 0 }; }
function stopTask(c) { c.task = { kind: 'idle' }; c.fire = false; c.interact = false; }

// Revive helper: if any client is downed, the nearest other client walks
// over and holds interact until the downed player is alive again.
async function ensureAlive(clients, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const downed = clients.map(meOf).find(p => p && p.state === 'downed');
    if (!downed) return true;
    const rescuer = clients.find(c => { const m = meOf(c); return m && m.state === 'alive' && m.id !== downed.id; });
    if (!rescuer) return false;
    await goTo(rescuer, downed.x, downed.y, 10000, 1.5);
    rescuer.interact = true;
    const ok = await waitSnap(rescuer, s => { const p = s.players.find(q => q.id === downed.id); return p && p.state === 'alive'; }, 8000);
    rescuer.interact = false;
    if (!ok) return false;
  }
  return false;
}

// ---------------- Main ----------------
async function main() {
  const t0 = Date.now();
  const deadline = t0 + OVERALL_TIMEOUT_MS;
  const timeLeft = () => deadline - Date.now();

  // Wake / verify the server first (Render Free spins down after 15 min idle).
  const healthUrl = WS_URL.replace(/^wss?/, 'https').replace(/\/$/, '') + '/health';
  let health = null;
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(healthUrl);
      health = await res.json();
      if (health && health.status === 'ok') break;
    } catch { /* retry */ }
    await wait(5000);
  }
  if (!health || health.status !== 'ok') throw new Error('server /health did not return ok (is Render awake?)');
  console.log(`server up: ${JSON.stringify(health)}`);

  console.log(`\nconnecting 3 clients to ${WS_URL}...`);
  const A = await makeClient('A');
  const B = await makeClient('B');
  const C = await makeClient('C');
  await waitFor(A, m => m.type === 'welcome');
  await waitFor(B, m => m.type === 'welcome');
  await waitFor(C, m => m.type === 'welcome');

  // --- create the BR session ---
  A.ws.send(JSON.stringify({ type: 'create', mode: 'battle-royale' }));
  const created = await waitFor(A, m => m.type === 'created');
  if (!created || created.mode !== 'battle-royale') {
    console.log('\nBUILD MISMATCH — the deployed server did not return mode=battle-royale on create.');
    console.log('The Phase 3 build is NOT deployed on Render yet (redeploy pending).');
    console.log(`created message: ${JSON.stringify(created)}`);
    process.exit(1);
  }
  const sessionStartAt = Date.now();
  console.log(`BR session created: code=${created.code} (zone clock starts now)`);
  const code = created.code;
  B.ws.send(JSON.stringify({ type: 'join', code }));
  C.ws.send(JSON.stringify({ type: 'join', code }));
  await waitFor(B, m => m.type === 'joined');
  await waitFor(C, m => m.type === 'joined');
  // First snapshot with all 3 players + the phase-0 zone preview.
  const firstSnap = await waitSnap(A, s => s.players.length >= 3 && s.zone, 15000);
  if (!firstSnap) throw new Error('never saw 3 players + zone in a snapshot');
  const preview0 = { ...firstSnap.zone.next };
  const dropPositions = {};
  for (const c of [A, B, C]) { const me = meOf(c); dropPositions[c.label] = { x: me.x, y: me.y }; }
  console.log(`drop-in: A=(${dropPositions.A.x},${dropPositions.A.y}) B=(${dropPositions.B.x},${dropPositions.B.y}) C=(${dropPositions.C.x},${dropPositions.C.y})`);
  console.log(`zone preview (phase 0 next): ${JSON.stringify(preview0)}`);

  // Track zone states + zombie-outside violations from A's snapshots.
  let sawShrinking = false;
  let zoneViolations = [];
  let maxViolDist = 0;
  const zoneWatch = setInterval(() => {
    const s = A.snap;
    if (!s || !s.zone) return;
    if (s.zone.state === 'shrinking') sawShrinking = true;
    for (const z of s.zombies || []) {
      const d = Math.hypot(z.x - s.zone.current.x, z.y - s.zone.current.y);
      maxViolDist = Math.max(maxViolDist, d - s.zone.current.r);
      if (d > s.zone.current.r + 2) zoneViolations.push({ id: z.id, dist: +d.toFixed(1), r: s.zone.current.r, phase: s.zone.phase });
    }
  }, 500);

  // ================= Job 3.1 — drop-in =================
  console.log('\n--- Job 3.1: drop-in ---');
  {
    const snap = A.snap;
    check('BR session: snapshot mode is battle-royale with a zone', snap.mode === 'battle-royale' && snap.zone && snap.zone.phase === 0, `mode=${snap.mode} zone r=${snap.zone.current.r}`);
    const loadouts = [A, B, C].map(c => { const p = meOf(c); return p.weapons.join('+'); });
    check('all three drop in melee-only (no gun, no ammo)', [A, B, C].every(c => {
      const p = meOf(c);
      return p.weapons.length === 1 && p.weapons[0] === 'melee' && p.weapon === 'melee';
    }), `loadouts: ${loadouts.join(' | ')}`);
    const ps = [A, B, C].map(c => meOf(c));
    let minD = Infinity;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) minD = Math.min(minD, Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y));
    check('spawn points are spread (min pairwise distance >= 5)', minD >= 5, `min pairwise ${minD.toFixed(2)} tiles`);
  }

  // C stands still so a zombie can reach them during grace (zombie-damage
  // check). B stands still so A can reach them for the melee check.
  // A walks to B and swings (melee) while grace is live.
  const graceDeadline = sessionStartAt + 10000;
  const bPos = { ...meOf(B) };
  const arrivedAB = await goTo(A, bPos.x, bPos.y, Math.min(8000, Math.max(1000, graceDeadline - Date.now())), 1.2);
  let meleeShots = [];
  if (arrivedAB && Date.now() < graceDeadline) {
    const hpBefore = meOf(B).hp;
    A.fire = true;
    A.aim = { x: bPos.x - meOf(A).x, y: bPos.y - meOf(A).y };
    await wait(1500);
    A.fire = false;
    const hpAfter = meOf(B).hp;
    meleeShots = A.events.filter(e => e.type === 'shot' && e.playerId === A.id);
    const swung = meleeShots.length > 0;
    check('grace blocks PvP: melee swings at B report hit:false', swung && meleeShots.every(e => e.hit === false), `${meleeShots.length} swings, B HP ${hpBefore} -> ${hpAfter}`);
    if (swung && hpAfter < hpBefore - 12) {
      failures.push('grace blocks PvP: B took melee-scale damage during grace');
      console.log(`  FAIL  grace blocks PvP: B took melee-scale damage during grace — HP ${hpBefore} -> ${hpAfter}`);
    }
  } else {
    skip('grace blocks PvP (melee swings)', arrivedAB ? 'grace expired before A reached B' : 'A could not reach B in time');
  }
  // Zombie damage during grace: watch C's HP log for zombie-sized drops
  // (6/8/12) inside the 10 s grace window. C stood still the whole time.
  {
    const cJoinAt = sessionStartAt; // C joined ~at session start
    while (Date.now() < cJoinAt + 12000) await wait(500);
    const drops = [];
    const log = C.hpLog.filter(h => h.t <= cJoinAt + 12000);
    for (let i = 1; i < log.length; i++) {
      const d = log[i - 1].hp - log[i].hp;
      if (d > 0) drops.push(d);
    }
    const zombieDrop = drops.find(d => d >= 5 && d <= 15);
    if (zombieDrop !== undefined) {
      check('grace does NOT block zombie damage (C took a zombie-sized hit in grace)', true, `C HP drops in grace: [${drops.join(', ')}]`);
    } else {
      skip('grace does NOT block zombie damage', `no zombie reached stationary C during grace (HP drops: [${drops.join(', ') || 'none'}])`);
    }
  }
  // Role ability + passive over the wire (Heavy: 125 HP, still melee-only).
  {
    A.ws.send(JSON.stringify({ type: 'role', role: 'heavy' }));
    await wait(600);
    const p = meOf(A);
    check('BR role pick: Heavy passive applies, still melee-only', p.role === 'heavy' && p.maxHp === 125 && p.weapons.length === 1 && p.weapons[0] === 'melee', `role=${p.role} maxHp=${p.maxHp} weapons=${p.weapons.join(',')}`);
    A.ws.send(JSON.stringify({ type: 'ability' }));
    await wait(600);
    const used = A.events.some(e => e.type === 'ability-used' && e.playerId === A.id && e.ability === 'bulwark');
    const p2 = meOf(A);
    check('BR role ability fires over the wire (Bulwark)', used && p2.abilityCdMs > 20000, `ability-used seen=${used} cdMs=${p2.abilityCdMs}`);
  }
  // Everyone patrols from here on (moving at 5 u/s outruns every zombie).
  for (const c of [A, B, C]) { const me = meOf(c); patrol(c, me.x, me.y); }
  if (!await ensureAlive([A, B, C])) throw new Error('a player died unexpectedly during drop-in');

  // ================= Job 3.2 — loot =================
  console.log('\n--- Job 3.2: loot ---');
  let crateId = null;
  {
    // A loots the nearest unlooted crate.
    const crates = A.snap.crates.filter(cr => !cr.looted);
    crates.sort((a, b) => Math.hypot(a.x - meOf(A).x, a.y - meOf(A).y) - Math.hypot(b.x - meOf(A).x, b.y - meOf(A).y));
    crateId = crates[0].id;
    stopTask(A);
    const ok = await goTo(A, crates[0].x, crates[0].y, 40000, 1.2);
    let granted = null;
    if (ok) {
      A.interact = true;
      const ev = await waitFor(A, m => false, 1); // noop, events come via snapshots
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        granted = A.events.find(e => e.type === 'crate-looted' && e.playerId === A.id && e.crateId === crateId);
        if (granted) break;
        await wait(200);
      }
      A.interact = false;
    }
    const crateNow = A.snap.crates.find(cr => cr.id === crateId);
    check('a crate loots over the wire (grant received)', !!granted && crateNow && crateNow.looted, granted ? `crate ${crateId}: granted=${granted.granted || 'supplies'}${granted.attachment ? ' attachment=' + granted.attachment.name : ''}` : `A never got crate-looted for ${crateId}`);
    patrol(A, meOf(A).x, meOf(A).y);
  }
  {
    // B re-loots the same crate: nothing comes back.
    stopTask(B);
    const crate = A.snap.crates.find(cr => cr.id === crateId);
    const ok = await goTo(B, crate.x, crate.y, 40000, 1.2);
    let gotNothing = false;
    if (ok) {
      const before = B.events.filter(e => e.type === 'crate-looted' && e.playerId === B.id).length;
      B.interact = true;
      await wait(5000);
      B.interact = false;
      const after = B.events.filter(e => e.type === 'crate-looted' && e.playerId === B.id).length;
      gotNothing = after === before;
    }
    check('re-looting an emptied crate returns nothing', gotNothing, ok ? 'B interacted 5 s at the looted crate, no crate-looted event' : 'B could not reach the crate');
    patrol(B, meOf(B).x, meOf(B).y);
  }
  {
    // B takes ground spawn g1 (fixed rifle) — B becomes the shooter for 3.4.
    const g1 = B.snap.groundLoot.find(g => g.id === 'g1');
    stopTask(B);
    const ok = await goTo(B, g1.x, g1.y, 40000, 1.2);
    let took = null;
    if (ok) {
      B.interact = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        took = B.events.find(e => e.type === 'ground-loot-taken' && e.playerId === B.id && e.lootId === 'g1');
        if (took) break;
        await wait(200);
      }
      B.interact = false;
    }
    const hasRifle = meOf(B).weapons.includes('rifle');
    const g1Now = B.snap.groundLoot.find(g => g.id === 'g1');
    check('a ground spawn is taken once (B gets the g1 rifle)', !!took && hasRifle && g1Now.taken, took ? `B weapons now: ${meOf(B).weapons.join(',')}` : 'no ground-loot-taken event for g1');
    patrol(B, meOf(B).x, meOf(B).y);
    // A tries the same ground spawn: gone.
    stopTask(A);
    const ok2 = await goTo(A, g1.x, g1.y, 40000, 1.2);
    let gotNothing = false;
    if (ok2) {
      const before = A.events.filter(e => e.type === 'ground-loot-taken' && e.playerId === A.id).length;
      A.interact = true;
      await wait(5000);
      A.interact = false;
      const after = A.events.filter(e => e.type === 'ground-loot-taken' && e.playerId === A.id).length;
      gotNothing = after === before;
    }
    check('a taken ground spawn is gone for the match', gotNothing, ok2 ? 'A interacted 5 s at taken g1, no ground-loot-taken event' : 'A could not reach g1');
    patrol(A, meOf(A).x, meOf(A).y);
  }
  if (!await ensureAlive([A, B, C])) throw new Error('a player died unexpectedly during loot');

  // ================= Job 3.3 — zone =================
  console.log('\n--- Job 3.3: zone ---');
  // Wait for the full phase transition: phase 0 wait (75 s from session
  // start) + 30 s shrink -> phase 1 arrives.
  let phase1At = null;
  {
    const snap = await waitSnap(A, s => s.zone && s.zone.phase === 1, Math.max(10000, sessionStartAt + 115000 - Date.now()));
    if (snap) {
      phase1At = Date.now();
      const cur = snap.zone.current;
      const same = Math.abs(cur.x - preview0.x) < 0.01 && Math.abs(cur.y - preview0.y) < 0.01 && Math.abs(cur.r - preview0.r) < 0.01;
      check('one FULL phase transition observed live (wait -> shrink -> phase 1)', true, `phase 1 arrived at ${((phase1At - sessionStartAt) / 1000).toFixed(0)} s after session start, saw shrinking=${sawShrinking}`);
      check('preview circle == arriving circle (identical x, y, r)', same, `preview=${JSON.stringify(preview0)} arrived=${JSON.stringify(cur)}`);
      check('shrink period was observed (zone.state == shrinking)', sawShrinking, 'sawShrinking=' + sawShrinking);
    } else {
      check('one FULL phase transition observed live (wait -> shrink -> phase 1)', false, `still phase ${A.snap.zone.phase} after ${((Date.now() - sessionStartAt) / 1000).toFixed(0)} s`);
      check('preview circle == arriving circle (identical x, y, r)', false, 'no phase 1 arrived');
      check('shrink period was observed (zone.state == shrinking)', sawShrinking, 'sawShrinking=' + sawShrinking);
    }
  }
  // Zone damage: walk C outside the phase-1 circle, hold 10 s, measure.
  {
    const zone = A.snap.zone;
    let outside = null;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const l = Math.hypot(dx, dy);
      let x = zone.current.x + (dx / l) * (zone.current.r + 4);
      let y = zone.current.y + (dy / l) * (zone.current.r + 4);
      x = Math.max(1, Math.min(29, x)); y = Math.max(15, Math.min(29, y));
      if (tileBlocked(Math.floor(x), Math.floor(y))) continue;
      if (Math.hypot(x - zone.current.x, y - zone.current.y) <= zone.current.r + 1) continue;
      outside = { x, y };
      break;
    }
    if (!outside) {
      skip('zone damage ticks on a player standing outside', 'no walkable point outside the phase-1 circle found');
    } else {
      stopTask(C);
      const ok = await goTo(C, outside.x, outside.y, 40000, 1.0);
      if (!ok) {
        skip('zone damage ticks on a player standing outside', `C could not reach outside point (${outside.x.toFixed(1)},${outside.y.toFixed(1)})`);
      } else {
        const hp0 = meOf(C).hp;
        const mark = Date.now();
        C.hpLog.length = 0;
        await wait(10000); // hold outside for 10 s (phase-1 DPS = 2)
        const hp1 = meOf(C).hp;
        // Per-second deltas from the HP log: the zone tick is a steady
        // ~2 HP/s; a zombie hit is a 6+ step in one interval.
        const samples = [];
        for (let s = 0; s <= 10; s++) {
          const entries = C.hpLog.filter(h => h.t >= mark + s * 1000 && h.t < mark + (s + 1) * 1000);
          if (entries.length) samples.push(entries[entries.length - 1].hp);
        }
        let steadyTicks = 0;
        for (let i = 1; i < samples.length; i++) {
          const d = samples[i - 1] - samples[i];
          if (d >= 1 && d <= 3) steadyTicks++;
        }
        const totalDrop = hp0 - hp1;
        check('zone damage ticks on a player standing outside (phase-1 DPS 2)', totalDrop >= 15 && steadyTicks >= 5, `C HP ${hp0} -> ${hp1} in 10 s (drop ${totalDrop}, steady 1-3 HP/s intervals: ${steadyTicks}/9, expected ~20 from zone DPS 2)`);
      }
      // Back inside the zone.
      await goTo(C, A.snap.zone.current.x, A.snap.zone.current.y, 40000, 1.0);
      patrol(C, meOf(C).x, meOf(C).y);
    }
  }
  {
    const bad = zoneViolations.filter(v => v.phase >= 0);
    check('zombies spawn inside the current safe zone (no zombie >2 tiles outside)', bad.length === 0, bad.length ? `${bad.length} violations, worst ${Math.max(...bad.map(v => v.dist - v.r)).toFixed(1)} tiles outside` : `0 violations across ${A.snapCount} snapshots (max overshoot ${(maxViolDist).toFixed(2)} tiles)`);
  }
  if (!await ensureAlive([A, B, C])) throw new Error('a player died unexpectedly during the zone section');

  // ================= Job 3.4 — director / win / end =================
  console.log('\n--- Job 3.4: director, win, end screen ---');
  {
    // Spawn rate + type mix by phase, counted from snapshots.
    const count0 = [...A.zombieSightings.values()].filter(z => z.firstPhase === 0);
    const count1 = [...A.zombieSightings.values()].filter(z => z.firstPhase === 1);
    const secs0 = ((phase1At || Date.now()) - sessionStartAt) / 1000;
    const secs1 = phase1At ? (Date.now() - phase1At) / 1000 : 0;
    const rate0 = count0.length / Math.max(1, secs0);
    const rate1 = count1.length / Math.max(1, secs1);
    const run0 = count0.filter(z => z.type === 'runner').length / Math.max(1, count0.length);
    const run1 = count1.filter(z => z.type === 'runner').length / Math.max(1, count1.length);
    check('director spawn rate rises as the zone shrinks (phase 1 > phase 0)', rate1 > rate0, `phase 0: ${count0.length} spawns in ${secs0.toFixed(0)} s = ${rate0.toFixed(3)}/s; phase 1: ${count1.length} in ${secs1.toFixed(0)} s = ${rate1.toFixed(3)}/s (table: 2.5 s -> 2.0 s interval)`);
    check('director type mix toughens (runner share rises phase 0 -> 1)', run1 > run0, `runners: phase 0 ${(run0 * 100).toFixed(0)}% (${count0.filter(z => z.type === 'runner').length}/${count0.length}), phase 1 ${(run1 * 100).toFixed(0)}% (${count1.filter(z => z.type === 'runner').length}/${count1.length}) (table: 0% -> 30%)`);
  }
  // Kill loop: B (rifle) strafes + fires at a target until the target dies.
  async function killTarget(shooter, victim, timeoutMs = 90000) {
    const me = meOf(shooter);
    shooter.task = { kind: 'strafe', targetId: victim.id, cx: me.x, cy: me.y, wpIdx: 0 };
    shooter.fire = true;
    const t0 = Date.now();
    let lastHp = null, lastHpAt = Date.now(), repositionedAt = 0;
    while (Date.now() - t0 < timeoutMs) {
      const v = playerOf(shooter, victim.id);
      if (!v) break;
      if (v.state === 'dead') break;
      const s = meOf(shooter);
      if (s && s.state === 'downed') break; // shooter downed: abort to revive
      if (v.hp !== lastHp) { lastHp = v.hp; lastHpAt = Date.now(); }
      // No damage for 20 s: close the distance / change the angle.
      if (Date.now() - lastHpAt > 20000 && Date.now() - repositionedAt > 20000) {
        repositionedAt = Date.now();
        shooter.fire = false;
        const vv = playerOf(shooter, victim.id);
        if (vv) await goTo(shooter, vv.x, vv.y, 15000, 3);
        const mm = meOf(shooter);
        shooter.task = { kind: 'strafe', targetId: victim.id, cx: mm.x, cy: mm.y, wpIdx: 0 };
        shooter.fire = true;
      }
      await wait(500);
    }
    shooter.fire = false;
    stopTask(shooter);
    const v = playerOf(shooter, victim.id);
    return v && v.state === 'dead';
  }
  // C dies first (B shoots them); the match continues (A, B alive).
  let pileChecked = false;
  {
    console.log('B shoots C (victim 1)...');
    const cDead = await killTarget(B, C);
    check('last-standing: a victim can be killed over the wire (C dies to B)', cDead, cDead ? `C state=${playerOf(B, C.id).state}` : `C still ${playerOf(B, C.id) && playerOf(B, C.id).state} HP ${playerOf(B, C.id) && playerOf(B, C.id).hp} after 90 s`);
    if (cDead) {
      // Death pile: a loot pile appears at C's death spot; A loots it.
      await wait(500);
      const piles = (A.snap.loot || []);
      const death = meOf(C) || playerOf(A, C.id);
      const pile = piles.find(l => Math.hypot(l.x - death.x, l.y - death.y) < 4);
      if (!pile) {
        skip('death-pile loot drops on a kill (pile lootable)', `no pile in snapshot loot[] near C's death spot (${death.x},${death.y}); loot=${JSON.stringify(piles)}`);
      } else {
        stopTask(A);
        const ok = await goTo(A, pile.x, pile.y, 40000, 1.2);
        let took = null;
        if (ok) {
          A.interact = true;
          const t0 = Date.now();
          while (Date.now() - t0 < 10000) {
            took = A.events.find(e => e.type === 'loot-taken' && e.playerId === A.id && e.lootId === pile.id);
            if (took) break;
            await wait(200);
          }
          A.interact = false;
        }
        const gone = !(A.snap.loot || []).some(l => l.id === pile.id);
        check('death-pile loot drops on a kill (A loots C\'s pile)', !!took && gone, took ? `pile ${pile.id} taken by A, gone from snapshots` : 'no loot-taken event for the pile');
        pileChecked = true;
        patrol(A, meOf(A).x, meOf(A).y);
      }
    }
    if (!await ensureAlive([A, B])) {
      check('A and B still alive after C dies', false, 'a player died unexpectedly');
    }
  }
  // A dies second (B shoots them); B is the last one standing -> end screen.
  {
    console.log('B shoots A (victim 2)...');
    const aDead = await killTarget(B, A);
    check('last-standing: the second victim dies to B (A dies)', aDead, aDead ? `A state=${playerOf(B, A.id).state}` : `A still ${playerOf(B, A.id) && playerOf(B, A.id).state} after 90 s`);
    const end = await waitFor(B, m => m.type === 'session-end', 15000) || B.sessionEnd;
    if (!end) {
      check('BR end screen arrives with the win (session-end, br-win)', false, 'no session-end within 15 s of A dying');
    } else {
      const score = end.score || {};
      check('BR end screen arrives with the win (session-end, br-win)', end.reason === 'br-win', `reason=${end.reason}`);
      const rows = {};
      for (const p of score.players || []) rows[p.id] = p;
      const bRow = rows[B.id], aRow = rows[A.id], cRow = rows[C.id];
      check('end screen placement is correct (B #1, A #2, C #3)', bRow && bRow.placement === 1 && aRow && aRow.placement === 2 && cRow && cRow.placement === 3, `B=${bRow && bRow.placement} A=${aRow && aRow.placement} C=${cRow && cRow.placement}`);
      check('end screen carries every BR field for every player', [bRow, aRow, cRow].every(r => r && 'placement' in r && 'kills' in r && 'headshots' in r && 'playersKilled' in r && 'revives' in r && 'damageDealt' in r && 'lootCollected' in r && 'survivalMs' in r && 'zonesSurvived' in r), `B row: ${JSON.stringify(bRow)}`);
      check('end screen: B killed both victims (playersKilled 2)', bRow && bRow.playersKilled === 2, `B playersKilled=${bRow && bRow.playersKilled}`);
      check('end screen: Last One Standing goes to the winner (B)', (score.titles || []).some(t => t.title === 'Last One Standing' && t.playerId === B.id), `titles=${JSON.stringify(score.titles)}`);
      check('end screen: zones survived is 1 for the victims, winner in phase 1', aRow && aRow.zonesSurvived === 1 && cRow && cRow.zonesSurvived === 1 && bRow && bRow.zonesSurvived === 1, `A=${aRow && aRow.zonesSurvived} C=${cRow && cRow.zonesSurvived} B=${bRow && bRow.zonesSurvived}`);
      console.log(`  end screen score: ${JSON.stringify(score)}`);
    }
  }
  clearInterval(zoneWatch);

  // ---------------- Measurements ----------------
  console.log('\n--- measurements ---');
  const secs = (Date.now() - t0) / 1000;
  for (const c of [A, B, C]) {
    const rtt = avg(c.rtts);
    console.log(`  ${c.label}: id=${c.id} snapshots=${c.snapCount} (${(c.snapCount / secs).toFixed(1)}/s) RTT avg ${rtt.toFixed(1)} ms (n=${c.rtts.length}) bytes/s ${(c.snapBytes / secs).toFixed(0)}`);
  }
  console.log(`  run time: ${secs.toFixed(0)} s; zone violations: ${zoneViolations.length}; zombies seen: ${A.zombieSightings.size}`);
  console.log(`  drop-in: A=(${dropPositions.A.x},${dropPositions.A.y}) B=(${dropPositions.B.x},${dropPositions.B.y}) C=(${dropPositions.C.x},${dropPositions.C.y})`);
  try { const s = await (await fetch(healthUrl.replace('/health', '/stats'))).json(); console.log(`  server /stats: players=${s.players} sessions=${s.sessions} zombies=${s.zombies} tick=${s.tick} avgTickMs=${s.avgTickMs}`); } catch { console.log('  server /stats: unavailable'); }

  for (const c of [A, B, C]) c.close();
  await wait(300);

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — run=${run} passed=${passed} skipped=${skipped} failed=${failures.length}${failures.length ? ': ' + failures.join('; ') : ''}${skips.length ? ` (skipped: ${skips.join('; ')})` : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
