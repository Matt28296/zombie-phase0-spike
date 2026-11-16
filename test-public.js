// Phase 0 PUBLIC test: two real clients against the deployed Render server.
// The `ws` package connects directly by default, but this VM's egress forces
// traffic through an HTTP proxy (direct TLS fails with "wrong version number").
// So we route the WebSocket through the proxy with https-proxy-agent (CONNECT).
// (Node's global WebSocket was tried first: it hangs in CONNECTING through
// the proxy and never opens.)
// Usage: WS_URL=wss://zombie-phase0-spike.onrender.com node test-public.js
// Exits 0 on PASS, 1 on FAIL.
'use strict';

const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');

const WS_URL = process.env.WS_URL || 'wss://zombie-phase0-spike.onrender.com';
const RUN_MS = 4000;

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
if (agent) console.log('using proxy agent for WebSocket');

const failures = [];

function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
}

function makeClient(label, keys) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, agent ? { agent } : undefined);
    const client = {
      label, ws, id: null, keys,
      snapBytes: 0, snapCount: 0,
      positions: new Map(), // id -> {x, y}
      rtts: [],
    };
    let inputTimer = null, pingTimer = null;
    let seq = 0;

    ws.on('open', () => {
      inputTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', seq: ++seq, keys }));
        }
      }, 50);
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
        for (const p of msg.players) client.positions.set(p.id, { x: p.x, y: p.y });
      } else if (msg.type === 'pong') {
        client.rtts.push(Date.now() - msg.t);
      }
    });

    ws.on('error', (err) => {
      console.error(`[${label}] ws error:`, err.message);
      if (!client.id) reject(err);
    });

    ws.on('close', () => {
      if (!client.id) reject(new Error(`${label} closed before welcome`));
    });

    const waitWelcome = setInterval(() => {
      if (client.id) {
        clearInterval(waitWelcome);
        resolve(client);
      }
    }, 25);
    setTimeout(() => { clearInterval(waitWelcome); if (!client.id) reject(new Error(`${label} never got welcome`)); }, 15000);

    client.close = () => { clearInterval(inputTimer); clearInterval(pingTimer); ws.close(); };
  });
}

async function main() {
  // Wake / verify the server first
  const healthUrl = WS_URL.replace(/^wss?/, 'https').replace(/\/$/, '') + '/health';
  let health = null;
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(healthUrl);
      health = await res.json();
      if (health && health.status === 'ok') break;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!health || health.status !== 'ok') throw new Error('server /health did not return ok');
  console.log(`server up: ${JSON.stringify(health)}`);

  console.log(`connecting two clients to ${WS_URL}...`);
  const [a, b] = await Promise.all([
    makeClient('A (right)', { up: false, down: false, left: false, right: true }),
    makeClient('B (up)', { up: true, down: false, left: false, right: false }),
  ]);
  console.log(`connected: A=${a.id}, B=${b.id}`);

  // Wait until each client sees >= 2 players, then record start positions.
  const waitSeen = async (c) => {
    for (let i = 0; i < 100; i++) {
      if (c.positions.size >= 2) return;
      await new Promise(r => setTimeout(r, 50));
    }
  };
  await Promise.all([waitSeen(a), waitSeen(b)]);

  const startPos = {
    A: { ...a.positions.get(a.id) }, B: { ...b.positions.get(b.id) },
  };
  console.log(`start: A=(${startPos.A.x.toFixed(2)}, ${startPos.A.y.toFixed(2)}) B=(${startPos.B.x.toFixed(2)}, ${startPos.B.y.toFixed(2)})`);

  await new Promise(r => setTimeout(r, RUN_MS));

  const endPos = {
    A: { ...a.positions.get(a.id) }, B: { ...b.positions.get(b.id) },
  };
  const aMoved = Math.hypot(endPos.A.x - startPos.A.x, endPos.A.y - startPos.A.y);
  const bMoved = Math.hypot(endPos.B.x - startPos.B.x, endPos.B.y - startPos.B.y);
  const secs = RUN_MS / 1000;

  let stats = null;
  try {
    const res = await fetch(WS_URL.replace(/^wss?/, 'https').replace(/\/$/, '') + '/stats');
    stats = await res.json();
  } catch (e) {
    console.log('  /stats fetch failed:', e.message);
  }

  // Cross-check: what A sees for B, and what B sees for A (server authority)
  const aSeesB = a.positions.get(b.id);
  const bSeesA = b.positions.get(a.id);

  console.log('\n--- checks ---');
  check('both clients got distinct ids', a.id && b.id && a.id !== b.id, `A=${a.id} B=${b.id}`);
  check('client A sees both players', a.positions.size >= 2, `sees ${a.positions.size}`);
  check('client B sees both players', b.positions.size >= 2, `sees ${b.positions.size}`);
  check('client A received snapshots', a.snapCount > 0, `${a.snapCount} snapshots`);
  check('client B received snapshots', b.snapCount > 0, `${b.snapCount} snapshots`);
  check('snapshot rate A near 20/s', a.snapCount / secs >= 15 && a.snapCount / secs <= 25, `${(a.snapCount / secs).toFixed(1)}/s`);
  check('snapshot rate B near 20/s', b.snapCount / secs >= 15 && b.snapCount / secs <= 25, `${(b.snapCount / secs).toFixed(1)}/s`);
  check('player A moved right', aMoved > 1 && endPos.A.x > startPos.A.x,
    `moved ${aMoved.toFixed(2)} units (${startPos.A.x.toFixed(2)} → ${endPos.A.x.toFixed(2)})`);
  check('player B moved up', bMoved > 1 && endPos.B.y < startPos.B.y,
    `moved ${bMoved.toFixed(2)} units (${startPos.B.y.toFixed(2)} → ${endPos.B.y.toFixed(2)})`);
  check('A sees B move (server snapshot)', aSeesB && Math.hypot(aSeesB.x - startPos.B.x, aSeesB.y - startPos.B.y) > 1,
    aSeesB ? `A sees B at (${aSeesB.x.toFixed(2)}, ${aSeesB.y.toFixed(2)})` : 'A never saw B');
  check('B sees A move (server snapshot)', bSeesA && Math.hypot(bSeesA.x - startPos.A.x, bSeesA.y - startPos.A.y) > 1,
    bSeesA ? `B sees A at (${bSeesA.x.toFixed(2)}, ${bSeesA.y.toFixed(2)})` : 'B never saw A');
  check('both clients got ping/pong RTT', a.rtts.length > 0 && b.rtts.length > 0,
    `A ${a.rtts.length} pongs, B ${b.rtts.length} pongs`);

  const avg = (xs) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
  const rttA = avg(a.rtts), rttB = avg(b.rtts);

  console.log('\n--- measurements ---');
  console.log(`  RTT A: ${rttA.toFixed(1)} ms (min ${Math.min(...a.rtts)} max ${Math.max(...a.rtts)}, n=${a.rtts.length})`);
  console.log(`  RTT B: ${rttB.toFixed(1)} ms (min ${Math.min(...b.rtts)} max ${Math.max(...b.rtts)}, n=${b.rtts.length})`);
  console.log(`  snapshot rate A: ${(a.snapCount / secs).toFixed(1)}/s, ${(a.snapBytes / secs).toFixed(0)} bytes/s`);
  console.log(`  snapshot rate B: ${(b.snapCount / secs).toFixed(1)}/s, ${(b.snapBytes / secs).toFixed(0)} bytes/s`);
  console.log(`  movement A: ${aMoved.toFixed(2)} units in ${secs}s (expected ~${(5 * secs).toFixed(1)} at 5 u/s)`);
  console.log(`  movement B: ${bMoved.toFixed(2)} units in ${secs}s (expected ~${(5 * secs).toFixed(1)} at 5 u/s)`);
  if (stats) {
    console.log(`  server /stats: players=${stats.players} tick=${stats.tick} avgTickMs=${stats.avgTickMs} uptimeSec=${stats.uptimeSec}`);
    console.log(`  server bytes: sent=${stats.bytesSent} received=${stats.bytesReceived}`);
  } else {
    console.log('  server /stats: unavailable');
  }

  a.close(); b.close();
  await new Promise(r => setTimeout(r, 300));

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} check(s) failed${failures.length ? ': ' + failures.join(', ') : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
