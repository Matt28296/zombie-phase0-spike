# Phase 0 — Public two-client test result

**Verdict: PASS** — run 2026-11-16 ~02:50 AST against https://zombie-phase0-spike.onrender.com

## What was tested
Two real WebSocket clients connected to the public Render server (wss://). Client A held right (D), client B held up (W), for 4 seconds. Both sent inputs at 20 Hz and pings every 500 ms. Positions each client saw for the other came from server snapshots only (no client-side guessing).

## Checks — 12/12 passed
- Both clients got distinct ids (A=p3, B=p4)
- Each client saw all players in the session (3 — a third client was already connected)
- Both received snapshots (A 89, B 88)
- Snapshot rate near 20/s (A 22.3/s, B 22.0/s — counted from connect, so slightly above the 20 Hz tick)
- A moved right 20.00 units (31.05 → 51.05); B moved up 19.75 units (39.52 → 19.77)
- A saw B move via server snapshot (B at 37.30, 18.02); B saw A move (A at 52.80, 18.05)
- Both got ping/pong RTT

## Measurements
- RTT A: 49.3 ms (min 34, max 68, n=8)
- RTT B: 52.3 ms (min 51, max 55, n=8)
- Snapshot bandwidth: A 5,399 bytes/s, B 5,376 bytes/s (3 players in snapshot)
- Server tick: avg 0.166 ms (from /stats), tick 18227, uptime 914 s
- Movement: A 20.00 units / 4 s, B 19.75 units / 4 s (expected ~20.0 at 5 u/s)
- Server bytes at test end: sent 1,635,852, received 44,777

## Notes
- The server was already awake when tested (/health returned ok on first hit, tick 1841).
- A third player was connected throughout (players=1 in /health before the test, players=3 during) — someone has the client page open. It did not affect the test.
- The VM's egress proxy blocks direct TLS, so the test clients were routed through the proxy with https-proxy-agent (test-public.js). Node's global WebSocket hangs in CONNECTING through this proxy; the `ws` package + proxy agent works. This is a VM network constraint, not a server problem — real browsers/phones connect directly.
- The client page (/) serves correctly (HTTP 200, contains the WebSocket client + canvas). The two-client check was done with `ws` protocol clients, not headless browsers; the page itself was not driven in a browser.
- Render Free caveat stands: the instance spins down after 15 min idle (~30–60 s wake). Uptime at test time was ~15 min, so it had been woken recently.

## Conclusion
Phase 0 is PROVEN against the public server: two real clients connect, move, and see each other move from server snapshots at ~20 Hz with ~50 ms RTT. Phase 1 (Survival base) can proceed.
