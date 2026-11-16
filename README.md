# Zombie Multiplayer — Phase 0 Network Spike

A minimal authoritative Node.js + WebSocket server that proves two real clients
can connect and see each other move. This is the GATE for the zombie
multiplayer game: no zombie, weapon, or role logic lives here — movement and
snapshots only.

## What it does

- Authoritative server ticks at 20 Hz; it is the source of truth for player positions.
- Clients send movement inputs (WASD); the server simulates and broadcasts snapshots.
- Client-side prediction for the local player, interpolation for remote players.
- `client.html` is a plain canvas 2D test page: open it in two browsers and move.

## Run it

```sh
npm install
npm start        # serves the test client at http://localhost:3000
npm test         # two-client check: both connect, both move, both see each other
```

## Deploy

`render.yaml` defines a free Render web service (`plan: free`,
`npm install` / `node server.js`). The server reads `PORT` from the environment.

## Endpoints

- `/` — the test client page
- `/health` — liveness
- `/stats` — connected clients, tick count, avg tick ms, bytes sent/received
