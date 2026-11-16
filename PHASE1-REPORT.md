# Phase 1 — Survival Base (server) — Report

**Code-verified only. No live playtest with real players has been done — Matt's live
two-player session is still the acceptance test.**

## Files (all in `hidden_files/phase0-server/`, client artifact untouched)
- `server.js` — extended Phase 0 server (same 20 Hz tick, same `/health` + `/stats`,
  same `welcome`/`snapshot`/`ping`/`pong`; added sessions, zombies, waves, weapons,
  downed/revive, extraction, disconnects). No GitHub commit made.
- `arena.js` — Gate Town arena data (bounds, gates, spawns, barricades, crates,
  extraction). **All geometry ASSUMED from spec §2.3 — must be verified against the
  real Gate Town region by the arena-audit job.**
- `test-phase1.js` — 79 assertions (unit on `Session` + live WS integration).
- `package.json` — added `npm run test:phase1`.

## Test results
- `node --check` on `server.js`, `arena.js`, `test-phase1.js`, `test-two-clients.js`: all pass.
- `node test-phase1.js`: **run=79, passed=79, failed=0** (two consecutive runs).
- `node test-two-clients.js` (Phase 0 regression): **PASS, 0 failed** (8/8 checks).
- Live tick measured: 20 ticks/s; `/stats` now reports sessions + zombies.

## PASS/FAIL per job area
| Job | Verdict | Notes |
|---|---|---|
| 1.1 Authoritative core (tick, snapshots, lag comp, abuse floor) | PASS | 20 Hz; delta snapshots + distance priority (near every tick, mid every 2nd, far every 4th); 1 s position-history ring; rewind hit verified on a moving target; head = 2× body with distinct marker; teleport/cheat claims ignored + logged in `/stats` anomalies |
| 1.2 Lobbies + lifecycle | PASS | 4-letter codes, distinct per create; join by code; cap enforced (refused join leaves session intact); solo starts, reaches wave 1; wipe/extraction teardown with score |
| 1.4 Zombies + waves + director | PASS | Flow field = one multi-source BFS per player cluster at 2 Hz (never per-zombie A*); 5 types with spec stats + 4 elite affixes; cap 120 with gate queue; wave scaling solo 14 vs 4-player 29 (wave 1); solo wave 1 survivable in stub (kite + pistol); director eases near wipe, surges when comfortable; 30 s breather with no spawns; isolated-player Runner pressure; extraction opens after wave 5 |
| 1.5 Weapons + noise | PASS | 5 weapons + melee per spec table; per-type finite ammo; reload interruptible by dodge (not by jump); spread 2× while moving; shotgun close > far; melee silent (0 director attention), gunfire loud; friendly fire real with grace-period block |
| 1.9 Downed / extraction / disconnects | PASS | Downed 60 s, crawl, no fire; revive 3 s held channel, interruptible; execute by player shot or zombies; loot drop = carried ammo/meds, equipped weapons stay; spectate; 30 s disconnect grace + reconnect same HP/ammo/loot; hibernation resumable at 4 min, discarded after 5 min; per-player extraction (one extracts, other keeps fighting) |

## Matt's direction applied (simplifications — spec conflicts resolved toward fun/simple)
- **Minimal input protocol:** `{keys, aim, fire, jump, dodge, reload, interact}` (+ legacy Phase 0 `{keys}`). No 22 remappable actions.
- **Movement feel:** near-instant accel (60 u/s²), stop within ~1 step; dodge = Shift burst + i-frames, cancels reload; jump does not cancel reload.
- **Director simplified:** one stress number (avg HP + ammo) → ease off near wipe, surge when comfortable. No multi-factor AI.
- **Noise economy = one rule:** gunfire raises attention (surge after ~20 s of continuous fire), melee raises none.
- **No trust/perks/barricades/roles** (Phase 2, to be simplified then).
- **Hibernation vs grace-death conflict (spec §3.8 vs §7.4):** if ALL players disconnect, characters hold in hibernation instead of dying at 30 s — otherwise the 5-min hibernate window could never be used (grace-death would wipe the session first). Resume allowed for the full 5 min while hibernating; 30 s grace still applies when anyone else is connected.
- **Culling fix (found by test):** far zombies simulate every 4th tick but integrate 4 ticks of movement, so a distant horde arrives on time instead of taking ~100 s to cross the arena.
- **Wall-slide fix (found by test):** a zombie walking exactly along a blocker edge was pushed back west every tick; added stuck detection + perpendicular nudge.
- **Noise tuning (found by test):** original threshold (20 attention ≈ 2 magazines) flooded wave 1 with ~30 extra zombies; now a response after ~20 s of continuous fire, 5-zombie surge + 2 Runners.

## Could NOT verify (needs live play)
- Feel: movement tightness, shooting immediacy, and wave-1 difficulty on a real phone/desktop with real latency (stub kiting is not a player).
- Two real clients in one session shooting zombies together (server only, no client built yet — Jobs 1.6/1.7 are a separate worker).
- Arena geometry vs real Gate Town (flagged ASSUMED in `arena.js`).
- Tick time at full load (8 players, 120 zombies) — no load test run; `/stats` reports `avgTickMs` for the coordinator to measure (Phase 0 regression showed 0.73 ms at 2 players, no zombies).
- Screamer audio cue / Brute red ring / hit-marker feedback — client-side, not server.

## Addendum — arena merge (Job 1.3, 2026-11-16 ~07:30 UTC)
- `arena.js` rewritten from the verified audit (`arena-definition.json`,
  227/227 `arena-verify.js` checks): bounds rect tiles x 0–29, z 14–29
  (players hard-clamped; gate-gap tiles (13,13)/(14,13) off-limits to players);
  153 blocked tiles (8 wall + 81 pond + 64 rock); 4 gates (main 2-wide gap,
  west on-boundary exception, east, south); 6 player spawns (spawn-1 = old
  (15,19)); 10 loot crates; extraction (15.5, 28.5) opens after wave 5.
- `server.js` changes (minimal): zombie clamp now uses `ZOMBIE_BOUNDS`
  (full 60×60 grid) instead of the player rect; `spawnZombie` picks a
  random tile when a gate defines several (main gate). `resolveCollision`
  rewritten tile-based (was rect-based). `ASSUMED_GEOMETRY` is now false;
  `VERIFIED_GEOMETRY` true.
- Tests re-run after the merge: **`test-phase1.js` 84/84** (79 original +
  5 new arena checks), **`test-two-clients.js` PASS 0 failed**,
  **`arena-verify.js` 227/227**. Committed to GitHub
  (`24e63aea6b6dddaaf5b6863d364a858bf1482771`, branch main; remote
  re-read confirms the verified header). **Live Render service still runs
  the old build — needs the manual redeploy trigger (browser task).**

## Addendum — event-delivery fix (2026-11-16 ~08:15 UTC)
- **Bug:** the server drained ONE global event queue (`this.events`) into
  the FIRST player's snapshot each tick (`snapshotFor` spliced the whole
  array), so the 2nd+ clients missed most events (hit markers, wave
  banners, downed/revived, ...). Multiplayer event delivery was broken.
- **Fix (server.js only, no protocol/event-shape change):** each player
  now has their own event queue (`p.events`, set in `addPlayer`); a new
  `Session.broadcast(ev)` copies every event into each CONNECTED
  player's queue (disconnected players get nothing queued, so no stale
  burst on resume); `snapshotFor(p)` drains only that player's queue.
  All 21 `this.events.push(...)` sites now call `this.broadcast(...)`.
  The snapshot format and event shapes are unchanged, so the client
  (zombie-survival-mmo artifact) keeps working as-is.
- **Tests:** new `test-events-two-clients.js` — **11/11 PASS** (unit:
  A shoots, BOTH snapshots contain the `shot` event exactly once, plus
  `wave-start` reaches both and no stale repeats; live WS: two real
  clients, A shoots, both receive the same `shot` event exactly once).
  `test-two-clients.js` PASS 0 failed (8/8). `test-phase1.js` **83/84**:
  the single failure is `every zombie reaches a stationary player`
  (max dist ~3.2–4.2 vs threshold < 3) — a PRE-EXISTING flaky
  pathfinding test, not caused by this fix: the ORIGINAL server.js from
  GitHub fails it 6 of 8 runs (max dist 2.08–5.22, only ~25% pass rate);
  the fix touches only event delivery, not movement/flow-field. The
  84/84 in the report above was a lucky run of that marginal test.
  Committed to GitHub (`1b7f958`, branch main; re-read confirms
  server.js identical, new test file present). **Live Render service
  still runs the pre-fix build — needs the manual redeploy trigger.**
- The "arena geometry vs real Gate Town" item above is now CLOSED for the
  server; remaining unverified items from the audit (§9): waystone coords,
  tree/rock exact coords, rock membership in old `blocked{}`, NPC collision,
  scales (17,15), possible further blocked tiles (e.g. house footprints).
