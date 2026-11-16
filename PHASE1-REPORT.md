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


## Addendum — Phase 2: social systems, roles, progression (2026-11-16)

**Code-verified only. No live playtest with real players has been done — Matt's
live three-player session is still the acceptance test (spec §8 Phase 2).**

### Files (all in `hidden_files/phase0-server/`, unless noted)
- `server.js` — extended in place (Phase 1 base kept: 20 Hz tick, flow field,
  delta snapshots, per-player event queues). +~700 lines: roles (6) +
  signature abilities, squads, trust/marks/bounty, XP + level-up perk picks,
  barricades + traps, attachments, crate weapon grants, death-pile weapon
  drops, medkit heal channel, per-player noise + surge warning, extended
  end screen. No protocol break: Phase 1 fields unchanged; Phase 2 adds
  snapshot fields and message/event types.
- `test-phase2.js` — 126 assertions (unit on `Session` + live WS smoke test
  for the new message types).
- `../phase2-protocol.md` — the client contract: every new message type
  (exact JSON), every new snapshot field, every new event type.
- `package.json` — added `npm run test:phase2`.

### Test results
- `node --check` on `server.js`, `test-phase2.js`: all pass.
- `node test-phase2.js`: **run=126, passed=126, failed=0** (first green run).
- `node test-phase1.js`: **83/84** — the single failure is the same
  pre-existing flaky `every zombie reaches a stationary player` test (it
  passed 84/84 on one of four runs of the new code, 83/84 on the others —
  it flips run-to-run, not a regression; the Phase 1 report documents it
  failing 6/8 on the original code).
- `node test-two-clients.js`: **PASS, 0 failed** (8/8).
- `node test-events-two-clients.js`: **PASS, run=11, passed=11**.

### PASS/FAIL per job area
| Job | Verdict | Notes |
|---|---|---|
| 2.1 Squads | PASS | Invite/accept/decline/leave, cap 4 (5th refused), leader reassignment on leave, shared waypoints (member-only in snapshot), leader-only loot toggle, squad kill feed, cross-squad revive allowed |
| 2.2 Trust/marks/bounty | PASS | Gains (revive +8, cross-squad +12, share +5, shared kill +2, wave survived +3), losses (damage −1/−2 by pattern, kill −20, execute −30, loot-after-kill −5), mark thresholds (Suspect −10, Traitor −31), bounty 10+5×kills with payout + event, mark clears on rebuild |
| 2.3 Roles | PASS | All 6 loadouts + passives measured (Heavy 125 HP / ×0.9 speed, Scout ×1.1, Sharpshooter 15% crit / +25% headshot, Medic 3 meds cap 5, Engineer cap 4 barricades); all 6 abilities fire + cooldown + measured effect (Rally +15% dmg, Bulwark frontal ×0.6, Longshot guaranteed crit 90, Skydance 0.6 s dash, Triage 0.8 s revive + aura, Fortify free barricade) |
| 2.4 Perks/barricades/traps/attachments | PASS | XP values + elite ×2, level-up at 50 XP with 3 choices, all 7 perks apply (damage 28 vs 25 measured, hp 115, reload 960 ms, barricade cap 3, ammo +25%, revive ×0.75, quiet −25% noise); barricade build (2 s / Engineer 1 s), 60 HP, zombie attacks + breaks with event, capacity enforced; spike 20 dmg / molotov 10 dps / noise +20 attention + lure all trigger; scope/extended-mag/grip stats measured |
| 2.5 Revive ladder / execute / noise | PASS | Revive times measured (base 3 s, squadmate 2 s live, Medic 1.5 s, Triage 0.8 s, revive perk ×0.75); execute −30 + `player-executed`; per-player noise 0–100 + decay; `surge-warning` at attention 35; quiet pacing stays below the warning threshold where loud pacing trips it |
| 2.6 End screen | PASS | All 16 per-player fields present (waves, kills, headshots, revives, betrayals, loot, damage, times downed, trust + rank, XP, level, role, squadId); titles Last One Standing / Most Revives / Most Betrayals computed |
| Weapon-grant path (blocks roles) | PASS | Crate grants a missing weapon (35% roll, stubbed-random verified) and attachments; death pile drops owned weapons beyond pistol+melee (Heavy shotgun drops + is lootable); roles start with their weapon |

### Phase 1 defects found and fixed (by the Phase 2 work)
- **`shot` event / `hit.damage` reported pre-mitigation damage:** Bulwark
  reduced the HP lost but the shot event still reported the full 25, so the
  client would have shown a damage number the target never took.
  `damagePlayer` now returns the damage actually dealt (0 if dodged,
  Bulwark-reduced otherwise) and `shootAt` reports that in the hit object,
  the `shot` event, and `damageDealt`. No Phase 1 test depended on the old
  reporting (all Phase 1 suites still pass).
- **Movement-validation bound vs Skydance:** the `impossible-speed` check
  used a fixed 12 u/s dodge cap, but a Scout Skydance dash reaches ~28.5
  u/s (12 × 1.8 × 1.1 × 1.2) plus velocity decay — the dash would have
  tripped the check and reset the player's position mid-dash. The bound is
  now an absolute 30 u/s cap (still catches gross simulation errors; the
  server is authoritative, so clients can't set positions anyway).
- **Heal channel off-by-one:** the expiry tick swallowed the last 1 HP, so
  a medkit healed 39 HP instead of 40. The heal now applies before the
  expiry check (40 HP over 2 s, verified).
- **Last One Standing tie-break:** deaths in the same tick shared a
  `deathMs`, so the title pick was insertion order, not death order. Kills
  now carry a monotonic `deathSeq` and the title uses it.

### Simplifications vs spec (Matt's filter — see phase2-protocol.md §13)
- Shared loot: single toggle, no distribution UI; weapons/attachments
  never split (picker only). Split rule is documented exactly.
- Accident-vs-deliberate: simple 10 s pattern heuristic (first hit + zombie
  near = −1, else −2). Stated as not a perfect judge.
- Attachments auto-apply, one slot per weapon, no management UI.
- Barricades: surveyed points only; zombies attack within 1.5 tiles (no
  flow-field blocking).
- Death-pile weapons: "non-starting" = beyond the universal pistol+melee,
  so role starting weapons (Heavy shotgun, etc.) DO drop — per the task's
  parenthetical ("killing a Heavy can yield their shotgun").
- Kill (−20) attribution: a downer owns a bleed-out / zombie-finish death,
  since in this engine a player kill otherwise only ever happens via
  execute (−30).
- Cross-squad revive +12 covers any non-same-squad revive (including two
  solos); same squad is +8.
- Triage aura heals squadmates only (solo Medic gets no self-heal from it);
  Rally also buffs the Leader themself; Bulwark applies to zombie damage too.

### Could NOT verify (needs live play)
- Everything in the Phase 1 "could NOT verify" list still stands, plus:
  three real players in one session forming a squad, betraying, and claiming
  a bounty (the acceptance check); whether the trust numbers feel right in
  a real firefight (the −1/−2 heuristic will misread some accidents);
  barricade/trap feel at the surveyed points; perk-pick strip usability
  mid-fight (client-side).
- **Live Render service still runs the pre-Phase-2 build — needs the manual
  redeploy trigger (parent triggers it; report the commit SHA).**