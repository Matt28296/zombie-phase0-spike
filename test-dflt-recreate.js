// Regression test: default session (DFLT) is recreated after it ends.
// Bug: defaultSession() kept returning the ended DFLT session, so every
// plain connect got {type:'error', error:'session ended'} and no welcome.
// Fix: defaultSession() creates a FRESH DFLT session when the old one ended.
// Usage: node test-dflt-recreate.js (spawns server on PORT 3005)
// Exits 0 on PASS, 1 on FAIL.
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3005;
const WS_URL = `ws://localhost:${PORT}`;
const WIPE_TIMEOUT_MS = 300000; // up to 5 min for a lone stationary player to wipe
const failures = [];
const results = {};

function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
}

function getStats() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/stats`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function connectPlain(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = { label, ws, welcome: null, error: null, sessionEnd: false, events: [] };
    const timer = setTimeout(() => reject(new Error(`${label}: no welcome/error within 10s`)), 10000);
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'welcome' && !client.welcome) { client.welcome = msg; clearTimeout(timer); resolve(client); }
      else if (msg.type === 'error' && !client.error) { client.error = msg; clearTimeout(timer); resolve(client); }
      else if (msg.type === 'session-end') { client.sessionEnd = true; }
      client.events.push(msg.type);
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const proc = spawn('node', [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => { process.stderr.write(`[server] ${d}`); });
  const kill = () => { try { proc.kill('SIGTERM'); } catch {} };

  try {
    // Wait for the server to listen.
    let up = false;
    for (let i = 0; i < 30; i++) {
      try { await getStats(); up = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    check('server starts on test port', up);
    if (!up) { kill(); process.exit(1); }

    // 1. Plain connect A -> welcome in DFLT.
    const A = await connectPlain('A');
    check('plain connect A gets welcome (DFLT)', !!A.welcome && A.welcome.code === 'DFLT', A.welcome ? `code=${A.welcome.code} id=${A.welcome.id}` : `error=${JSON.stringify(A.error)}`);
    if (!A.welcome) { kill(); process.exit(1); }

    // 2. Wait for the lone stationary player to wipe (breather 30s, wave 1,
    // zombies hunt + down + finish). Poll /stats for DFLT phase === 'ended'.
    let ended = false;
    const deadline = Date.now() + WIPE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const st = await getStats();
      const dflt = (st.sessionsDetail || []).find((s) => s.code === 'DFLT');
      if (dflt && dflt.phase === 'ended') { ended = true; break; }
      await new Promise((r) => setTimeout(r, 5000));
    }
    check('DFLT session ends (solo wipe)', ended);
    if (!ended) { kill(); process.exit(1); }
    console.log(`  (A saw session-end event: ${A.sessionEnd})`);

    // 3. Plain connect B AFTER the wipe -> must get a welcome, not 'session ended'.
    const B = await connectPlain('B');
    check('plain connect B after wipe gets welcome (fresh DFLT)', !!B.welcome && B.welcome.code === 'DFLT', B.welcome ? `code=${B.welcome.code} id=${B.welcome.id}` : `error=${JSON.stringify(B.error)}`);
    if (B.welcome) {
      const st = await getStats();
      const dflt = (st.sessionsDetail || []).find((s) => s.code === 'DFLT');
      check('fresh DFLT session is live (not ended)', !!dflt && dflt.phase !== 'ended', dflt ? `phase=${dflt.phase} players=${dflt.players}` : 'no DFLT in stats');
      results.freshPhase = dflt ? dflt.phase : null;
    }
    A.ws.close(); B.ws.close();
  } catch (e) {
    console.log(`  FAIL  exception — ${e.message}`);
    failures.push('exception: ' + e.message);
  } finally {
    kill();
  }

  if (failures.length) {
    console.log(`\nFAIL — ${failures.length} check(s) failed: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nPASS — DFLT recreated after wipe; plain connects get a welcome');
  process.exit(0);
}

main();
