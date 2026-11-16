// Phase 0 test: two WebSocket clients, verify they see each other move.
// Usage: WS_URL=ws://localhost:3000 node test-two-clients.js
// Exits 0 on PASS, 1 on FAIL.
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const WS_URL = process.env.WS_URL || 'ws://localhost:3000';
const RUN_MS = 3000;
const TEST_PORT = 3000;

const failures = [];
const results = {};

function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
}

function makeClient(label, keys) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = {
      label, ws, id: null, keys,
      snapshots: [], snapBytes: 0, snapCount: 0,
      positions: new Map(), // id -> {x, y}
      rtts: [],
    };
    let inputTimer = null, pingTimer = null;
    let seq = 0;

    ws.on('open', () => {
      // send input at 20 Hz (mirrors a real client holding keys)
      inputTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', seq: ++seq, keys }));
        }
      }, 50);
      // ping every 500 ms
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }
      }, 500);
    });

    ws.on('message', (data) => {
      client.snapBytes += data.length;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'welcome') {
        client.id = msg.id;
        for (const p of msg.players) client.positions.set(p.id, { x: p.x, y: p.y });
      } else if (msg.type === 'snapshot') {
        client.snapCount++;
        client.snapshots.push(msg);
        for (const p of msg.players) client.positions.set(p.id, { x: p.x, y: p.y });
      } else if (msg.type === 'pong') {
        client.rtts.push(Date.now() - msg.t);
      }
    });

    ws.on('error', reject);

    // resolve once we've seen a welcome (id assigned)
    const waitWelcome = setInterval(() => {
      if (client.id) {
        clearInterval(waitWelcome);
        resolve(client);
      }
    }, 25);
    setTimeout(() => { clearInterval(waitWelcome); reject(new Error(`${label} never got welcome`)); }, 5000);

    client.close = () => { clearInterval(inputTimer); clearInterval(pingTimer); ws.close(); };
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  // Start a local server if WS_URL points at localhost and nothing is listening.
  let serverProc = null;
  const isLocal = WS_URL.includes('localhost') || WS_URL.includes('127.0.0.1');
  if (isLocal) {
    try {
      await fetchJson(`http://localhost:${TEST_PORT}/health`);
      console.log(`using already-running server at ${WS_URL}`);
    } catch {
      console.log('starting local server...');
      serverProc = spawn('node', [path.join(__dirname, 'server.js')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(TEST_PORT) },
      });
      serverProc.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
      serverProc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
      // wait for /health
      for (let i = 0; i < 50; i++) {
        try { await fetchJson(`http://localhost:${TEST_PORT}/health`); break; }
        catch { await new Promise(r => setTimeout(r, 100)); }
        if (i === 49) throw new Error('local server did not come up');
      }
      console.log('local server up');
    }
  }

  try {
    console.log(`connecting two clients to ${WS_URL}...`);
    const [a, b] = await Promise.all([
      makeClient('A (right)', { up: false, down: false, left: false, right: true }),
      makeClient('B (up)', { up: true, down: false, left: false, right: false }),
    ]);
    console.log(`connected: A=${a.id}, B=${b.id}`);

    const startPos = {
      A: { ...a.positions.get(a.id) }, B: { ...b.positions.get(b.id) },
    };
    // let them move for ~3 s
    await new Promise(r => setTimeout(r, RUN_MS));
    const endPos = {
      A: { ...a.positions.get(a.id) }, B: { ...b.positions.get(b.id) },
    };
    const aMoved = Math.hypot(endPos.A.x - startPos.A.x, endPos.A.y - startPos.A.y);
    const bMoved = Math.hypot(endPos.B.x - startPos.B.x, endPos.B.y - startPos.B.y);
    const secs = RUN_MS / 1000;

    const stats = await fetchJson(WS_URL.replace(/^ws/, 'http').replace(/\/$/, '') + '/stats')
      .catch(() => null);

    console.log('\n--- checks ---');
    check('both clients got distinct ids', a.id && b.id && a.id !== b.id, `A=${a.id} B=${b.id}`);
    check('client A sees both players', a.positions.size === 2, `sees ${a.positions.size}`);
    check('client B sees both players', b.positions.size === 2, `sees ${b.positions.size}`);
    check('client A received snapshots', a.snapCount > 0, `${a.snapCount} snapshots`);
    check('client B received snapshots', b.snapCount > 0, `${b.snapCount} snapshots`);
    check('player A moved right', aMoved > 1 && endPos.A.x > startPos.A.x,
      `moved ${aMoved.toFixed(2)} units (${startPos.A.x.toFixed(2)} → ${endPos.A.x.toFixed(2)})`);
    check('player B moved up', bMoved > 1 && endPos.B.y < startPos.B.y,
      `moved ${bMoved.toFixed(2)} units (${startPos.B.y.toFixed(2)} → ${endPos.B.y.toFixed(2)})`);
    check('both clients got ping/pong RTT', a.rtts.length > 0 && b.rtts.length > 0,
      `A ${a.rtts.length} pongs, B ${b.rtts.length} pongs`);

    const avg = (xs) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
    const rttA = avg(a.rtts), rttB = avg(b.rtts);
    const bytesPerSecA = a.snapBytes / secs, bytesPerSecB = b.snapBytes / secs;

    console.log('\n--- measurements ---');
    console.log(`  RTT A: ${rttA.toFixed(1)} ms (min ${Math.min(...a.rtts)} max ${Math.max(...a.rtts)}, n=${a.rtts.length})`);
    console.log(`  RTT B: ${rttB.toFixed(1)} ms (min ${Math.min(...b.rtts)} max ${Math.max(...b.rtts)}, n=${b.rtts.length})`);
    console.log(`  snapshot rate A: ${(a.snapCount / secs).toFixed(1)}/s, ${bytesPerSecA.toFixed(0)} bytes/s`);
    console.log(`  snapshot rate B: ${(b.snapCount / secs).toFixed(1)}/s, ${bytesPerSecB.toFixed(0)} bytes/s`);
    if (stats) {
      console.log(`  server /stats: players=${stats.players} tick=${stats.tick} avgTickMs=${stats.avgTickMs} uptimeSec=${stats.uptimeSec}`);
      console.log(`  server bytes: sent=${stats.bytesSent} received=${stats.bytesReceived}`);
    } else {
      console.log('  server /stats: unavailable (remote URL?)');
    }

    results.rttMs = { A: rttA, B: rttB };
    results.snapshotBytesPerSec = { A: bytesPerSecA, B: bytesPerSecB };
    results.serverStats = stats;

    a.close(); b.close();
  } finally {
    if (serverProc) {
      serverProc.kill();
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} check(s) failed${failures.length ? ': ' + failures.join(', ') : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
