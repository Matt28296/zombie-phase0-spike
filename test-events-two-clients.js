// Event-delivery regression test — per-player event queues.
//
// THE BUG (fixed): the server drained ONE global event queue into the FIRST
// player's snapshot each tick (snapshotFor spliced the whole array), so the
// second and later clients missed most events (hit markers, wave banners,
// downed/revived, ...). The fix gives each player their own queue;
// snapshotFor drains only that player's queue.
//
// Proves TWO clients each receive the events — at the unit level (the exact
// drain) and over a live WebSocket (both real clients, end to end).
// Usage: node test-events-two-clients.js   (spawns server on PORT 3002)
// Exits 0 on PASS, 1 on FAIL.
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const { Session } = require('./server');

const PORT = 3002;
const failures = [];
let run = 0, passed = 0;
function check(name, ok, detail) {
  run++;
  if (ok) passed++;
  else failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function countEvents(list, type, playerId) {
  return list.filter(e => e.type === type && (playerId === undefined || e.playerId === playerId)).length;
}

// ---------------- Part 1: unit — the exact drain bug ----------------
function unitTests() {
  console.log('\n--- unit: two players, one shot, both snapshots get the event ---');
  const s = new Session('EVT');
  const a = s.addPlayer(null).player;
  const b = s.addPlayer(null).player;
  // A shoots at empty space: no zombies yet, B is in spawn grace, so this
  // is a miss — but a 'shot' event is still broadcast to every player.
  const shot = s.shootAt(a, { x: 1, y: 0 }, s.nowMs);
  check('A shot fires (not rate-limited / empty)', shot !== null && shot !== undefined, JSON.stringify(shot));
  // THE BUG: snapshotFor(A) used to drain the whole global queue, leaving
  // B's snapshot with events: []. Order matters — A first, then B.
  const snapA = s.snapshotFor(a);
  const snapB = s.snapshotFor(b);
  check("A's snapshot contains the shot event", countEvents(snapA.events, 'shot', a.id) === 1,
    `A got ${countEvents(snapA.events, 'shot', a.id)}`);
  check("B's snapshot ALSO contains the shot event (not stolen by A's drain)", countEvents(snapB.events, 'shot', a.id) === 1,
    `B got ${countEvents(snapB.events, 'shot', a.id)}`);
  check('no duplicate delivery to A', countEvents(snapA.events, 'shot', a.id) <= 1);
  check('no duplicate delivery to B', countEvents(snapB.events, 'shot', a.id) <= 1);

  console.log('\n--- unit: wave-start reaches both players ---');
  const s2 = new Session('EVT2');
  const a2 = s2.addPlayer(null).player;
  const b2 = s2.addPlayer(null).player;
  s2.startWave(1);
  const wA = s2.snapshotFor(a2);
  const wB = s2.snapshotFor(b2);
  check("A's snapshot contains wave-start", wA.events.some(e => e.type === 'wave-start' && e.wave === 1));
  check("B's snapshot contains wave-start", wB.events.some(e => e.type === 'wave-start' && e.wave === 1));
  // Draining is per-player: a second snapshot for the same player is empty.
  const wA2 = s2.snapshotFor(a2);
  check("A's next snapshot has no stale repeat", countEvents(wA2.events, 'wave-start') === 0);
}

// ---------------- Part 2: live WS — two real clients ----------------
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function makeClient(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const client = { label, ws, id: null, events: [], snapCount: 0 };
    ws.on('open', () => {});
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'welcome') client.id = msg.id;
      else if (msg.type === 'snapshot') {
        client.snapCount++;
        if (Array.isArray(msg.events)) client.events.push(...msg.events);
      }
    });
    ws.on('error', reject);
    const wait = setInterval(() => {
      if (client.id) { clearInterval(wait); resolve(client); }
    }, 25);
    setTimeout(() => { clearInterval(wait); reject(new Error(`${label} never got welcome`)); }, 5000);
    client.close = () => ws.close();
  });
}

async function liveTest() {
  console.log('\n--- live WS: two clients, A shoots, both receive the shot event ---');
  let serverProc = null;
  try { await fetchJson(`http://localhost:${PORT}/health`); console.log('using already-running server'); }
  catch {
    console.log('starting local server...');
    serverProc = spawn('node', [path.join(__dirname, 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT) },
    });
    serverProc.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
    serverProc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    for (let i = 0; i < 50; i++) {
      try { await fetchJson(`http://localhost:${PORT}/health`); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
      if (i === 49) throw new Error('local server did not come up');
    }
    console.log('local server up');
  }
  try {
    const [a, b] = await Promise.all([makeClient('A'), makeClient('B')]);
    console.log(`connected: A=${a.id}, B=${b.id} (same default session)`);
    // Wait until both have received at least one snapshot, so both are
    // definitely in the session before A shoots (else B would miss it
    // simply by joining late — that is not the bug under test).
    for (let i = 0; i < 40 && (a.snapCount === 0 || b.snapCount === 0); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    check('both clients are receiving snapshots before the shot', a.snapCount > 0 && b.snapCount > 0,
      `A ${a.snapCount}, B ${b.snapCount}`);
    // A shoots once (no `t`: server uses current tick, no rewind weirdness).
    a.ws.send(JSON.stringify({ type: 'shoot', aim: { x: 1, y: 0 } }));
    await new Promise(r => setTimeout(r, 800)); // several 20 Hz ticks
    const aShots = countEvents(a.events, 'shot', a.id);
    const bShots = countEvents(b.events, 'shot', a.id);
    check('client A received the shot event', aShots === 1, `A got ${aShots}`);
    check('client B received the SAME shot event', bShots === 1, `B got ${bShots}`);
    a.close(); b.close();
  } finally {
    if (serverProc) {
      serverProc.kill();
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

async function main() {
  unitTests();
  await liveTest();
  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — run=${run} passed=${passed} failed=${failures.length}${failures.length ? ': ' + failures.join(', ') : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
