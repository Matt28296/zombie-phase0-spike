// Phase 0 network spike — zombie multiplayer game.
// Network-only: authoritative movement + snapshots. NO zombie/weapon/role logic.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3000);
const TICK_MS = 50;          // 20 Hz
const SPEED = 5;             // units/sec
const ARENA = 60;            // 60x60 world, coords 0..60

const startedAt = Date.now();
let tickCount = 0;
let tickDurations = [];      // rolling window of tick ms
let bytesSent = 0;
let bytesReceived = 0;

// players: Map<id, {id, x, y, color, keys, seq, ws}>
const players = new Map();
let nextPlayerNum = 1;

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#1abc9c', '#e67e22', '#fd79a8', '#00cec9', '#6c5ce7',
];

function spawnPosition(n) {
  // Spread players on a circle around the arena centre.
  const angle = ((n - 1) * 2.399963) % (Math.PI * 2); // golden angle
  const r = 12;
  return {
    x: Math.min(ARENA - 1, Math.max(1, ARENA / 2 + Math.cos(angle) * r)),
    y: Math.min(ARENA - 1, Math.max(1, ARENA / 2 + Math.sin(angle) * r)),
  };
}

function worldState() {
  return [...players.values()].map(p => ({ id: p.id, x: p.x, y: p.y, color: p.color }));
}

function avgTickMs() {
  if (!tickDurations.length) return 0;
  return tickDurations.reduce((a, b) => a + b, 0) / tickDurations.length;
}

function broadcastSnapshot() {
  const msg = JSON.stringify({
    type: 'snapshot',
    tick: tickCount,
    players: worldState(),
  });
  for (const p of players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
      bytesSent += Buffer.byteLength(msg);
    }
  }
}

function tick() {
  const t0 = performance.now();
  tickCount++;
  const dt = TICK_MS / 1000;

  for (const p of players.values()) {
    const k = p.keys;
    let dx = 0, dy = 0;
    if (k.up) dy -= 1;
    if (k.down) dy += 1;
    if (k.left) dx -= 1;
    if (k.right) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      p.x = Math.min(ARENA, Math.max(0, p.x + (dx / len) * SPEED * dt));
      p.y = Math.min(ARENA, Math.max(0, p.y + (dy / len) * SPEED * dt));
    }
  }

  broadcastSnapshot();

  const dur = performance.now() - t0;
  tickDurations.push(dur);
  if (tickDurations.length > 200) tickDurations.shift();
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = fs.readFileSync(path.join(__dirname, 'client.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(file);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', players: players.size, tick: tickCount }));
  } else if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      players: players.size,
      tick: tickCount,
      avgTickMs: Number(avgTickMs().toFixed(3)),
      bytesSent,
      bytesReceived,
      uptimeSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// ---- WebSocket server ----
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const num = nextPlayerNum++;
  const id = `p${num}`;
  const spawn = spawnPosition(num);
  const player = {
    id, x: spawn.x, y: spawn.y,
    color: COLORS[(num - 1) % COLORS.length],
    keys: { up: false, down: false, left: false, right: false },
    seq: 0,
    ws,
  };
  players.set(id, player);
  console.log(`[connect] ${id} at (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) — ${players.size} online`);

  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    x: player.x,
    y: player.y,
    color: player.color,
    players: worldState(),
  }));

  ws.on('message', (data) => {
    bytesReceived += data.length;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'input') {
      player.seq = msg.seq || 0;
      const k = msg.keys || {};
      player.keys = {
        up: !!k.up, down: !!k.down, left: !!k.left, right: !!k.right,
      };
    } else if (msg.type === 'ping') {
      const pong = JSON.stringify({ type: 'pong', t: msg.t });
      ws.send(pong);
      bytesSent += Buffer.byteLength(pong);
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log(`[disconnect] ${id} — ${players.size} online`);
    broadcastSnapshot();
  });

  ws.on('error', (err) => console.error(`[ws error] ${id}:`, err.message));
});

setInterval(tick, TICK_MS);

server.listen(PORT, () => {
  console.log(`phase0 spike listening on :${PORT} (tick ${1000 / TICK_MS} Hz, arena ${ARENA}x${ARENA})`);
});
