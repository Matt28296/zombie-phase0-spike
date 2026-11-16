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
## Addendum — Phase 3: Battle Royale (2026-11-16)

**Local tests pass. Live WebSocket test written, PENDING-REDEPLOY. Browser
play test is a further gate (client worker + verifier). Matt's correction
applies from Phase 3 on: "test the game AS you build it" — code review +
"Matt's playtest settles it" alone is no longer the gate.**

### Files (all in `hidden_files/phase0-server/`, unless noted)
- `server.js` — extended in place (Phase 1/2 base kept: 20 Hz tick, flow
  field, delta snapshots, per-player event queues, wave machine). +~370
  lines: mode select at creation (`create` with `mode`, never switches
  mid-game), BR drop-in (8 scattered points, pairwise ≥ 5 tiles, melee-only
  loadout, role ability + passive still apply), 12 fixed tiered ground
  spawns (10 crates + 12 = 22 loot points), risk-tiered crate rolls (BR
  only), 6-phase shrinking zone with next-circle preview + per-phase DPS,
  zone-paced director (no waves), last-standing win detection (solo +
  squad, downed-unrevivable ends the match), BR end screen (placement,
  survivalMs, zonesSurvived, winners), zone damage during disconnect
  grace. `welcome`/`created`/snapshot/`/stats` carry `mode`; snapshot
  carries `zone` + `groundLoot`.
- `test-phase3.js` — 90 assertions (unit on `Session` + live WS smoke test
  for create-with-mode on PORT 3003).
- `test-phase3-live.js` — NEW, per Matt's correction: three real WebSocket
  clients against the DEPLOYED Render server (same pattern as
  test-public.js: `ws` + https-proxy-agent, /health wake, 20 Hz inputs,
  500 ms pings). Per-job sections with PASS/FAIL/SKIP and real numbers
  (RTT, snapshot rate, positions, HP, spawn counts, end-screen fields).
  Exits 0/1. Fails fast with BUILD MISMATCH if the deployed server is not
  the Phase 3 build.
- `../phase3-protocol.md` — the client contract: `create` mode, zone
  schedule table, loot tier tables, director-by-phase table, snapshot
  additions, new events (`zone-phase`, `zone-shrink-start`,
  `ground-loot-taken`), BR end-screen fields, §13 simplifications.
- `package.json` — unchanged (no new test script added; run
  `node test-phase3.js` / `node test-phase3-live.js` directly).

### Test results (local)
- `node --check` on `server.js`, `test-phase3.js`, `test-phase3-live.js`:
  all pass.
- `node test-phase3.js`: **run=90, passed=90, failed=0** (six consecutive
  green runs after the last flake fix).
- `node test-phase1.js`: **83/84** — the single failure is the same
  pre-existing flaky `every zombie reaches a stationary player` test
  (documented as failing 6/8 on the original code; NOT a regression).
- `node test-phase2.js`: **run=126, passed=126, failed=0**.
- `node test-two-clients.js`: **PASS, 0 failed** (8/8).
- `node test-events-two-clients.js`: **PASS, run=11, passed=11**.

### Test results (live — PENDING-REDEPLOY)
- `node test-phase3-live.js` against
  `wss://zombie-phase0-spike.onrender.com`: **NOT RUN — the deployed
  server still runs the pre-Phase-3 build.** Verified the script's
  fail-fast path live: /health ok, 3 clients connected, `create` returned
  `{type:'created', code:'PXQK', id:'p11'}` with NO `mode` → BUILD
  MISMATCH, clean exit. **Phase 3 is NOT done until this script passes
  against the redeployed server** (parent arranges the Render redeploy,
  then the live-test run; fix + re-push + re-deploy + re-test until green).
- Browser play test (headless Chrome, local server via `npm start`) is
  owned by the client worker + verifier, not by this server work. Nothing
  in Phase 3 blocks it.

### PASS/FAIL per job area
| Job | Verdict | Notes |
|---|---|---|
| 3.1 Mode select + drop-in | PASS (local) | `create` mode survival/battle-royale, invalid → survival; mode in welcome/snapshot/`created`; never switches mid-game; cap 8 enforced; 8 drop points pairwise ≥ 5 (measured 5.39 min in smoke), all walkable in-bounds; melee-only (no gun, no ammo); Heavy keeps no shotgun but gets 125 HP + Bulwark; grace blocks PvP (shot hit:false, HP unchanged) but not zombie damage; Survival role weapons unchanged |
| 3.2 Loot distribution | PASS (local) | 10 crates + 12 ground = 22 points; tier audit (no low-tier rifle/shotgun/SMG; every high-tier a gun or 2+ meds); ground spawn finite (second player gets nothing); crate finite (re-loot returns nothing); crate weapon chance tiered in BR (50/35/20%) and flat 35% in Survival; death pile in BR byte-identical in structure to the Survival rule (carried drops, equipped stays) |
| 3.3 Shrinking zone | PASS (local) | 6 phases, radii 18/13/9.5/6.5/4/2.5, DPS 1/2/4/8/15/25 monotonic; 460 s to the final circle (~10–12 min match); shrink 30 s, waits 50–75 s; centres never concentric (≥ 1.5 observed, 1.6 nominal); preview == arriving circle for every transition in a full live run; shrink interpolates; DPS measured per phase (100 → 100−DPS after 1 s outside); phase 1 forgiving (100 → 80 in 10 s), final lethal (downed in 4 s); inside takes no damage; out-runnable check holds for every transition |
| 3.3 Zombies + zone | PASS (local) | Director spawns inside the current zone (30 s run, all inside); outside zombie takes zone damage + walks to centre; outside zombie dies if it stays out; no pile-up outside the circle (30 s, phase 3) |
| 3.4 Zone-paced director | PASS (local) | Interval falls monotonically (2500→700 ms); brute share never falls (0→15%), runner never falls (0→30%); measured spawn rate phase 5 > 2× phase 0 in 30 s; no waves in BR (wave 0, phase `br`, no wave-start events) |
| 3.4 Win detection | PASS (local) | Solo ending (placement 1 vs 2); squad ending (both #1, victim #3); last-two-are-squadmates ends immediately; downed-last-player ends WITHOUT waiting for bleed-out; downed WITH a living squadmate does NOT end the match; placement correct for every player (death order); a lone player never instantly wins |
| 3.4 BR end screen | PASS (local) | Every field present (placement, kills, headshots, playersKilled, revives, damageDealt, lootCollected, survivalMs, zonesSurvived, titles); fields match live player stats; Last One Standing to the winner (most zombie kills for a squad win); Most Revives / Most Betrayals omitted when nobody qualifies; Survival end screen has no BR-only fields |
| 3.4 Disconnects in BR | PASS (local) | Zone damage ticks during disconnect grace (100 → 85 in 1 s at DPS 15); disconnected character outside the zone dies on schedule (downed in 5 s at DPS 25, dead after bleed-out); Survival grace unchanged (alive at 30 s, dead at 31 s, no zone) |
| Survival regression | PASS (local) | Breather → wave 1; wave clear → breather; extraction opens after wave 5; waveCount/waveDef values unchanged; no zone, no ground loot, no BR win logic, no BR end-screen fields in Survival |

### Phase 1/2 defects found and fixed (by the Phase 3 work)
- **Co-winners got different placements:** the end-screen sort assigned
  `i + 1` by position, so squad co-winners got #1 and #2. Winners now
  share #1 (standard competition ranking: next placement is #3).
- **Next-zone centre clamp was inverted for r > 8:** the arena is 30 wide
  × 16 tall, so a circle fits fully only for r ≤ 8 — the old clamp
  (`[r, 30−r]` × `[14+r, 30−r]`) produced an empty Y range and pinned
  every large next centre to y = 23.5. The clamp now constrains the centre
  to the arena rect for radii that cannot fit, and to full containment
  only when the circle fits.
- **BR surges spawned at the gates, outside the zone:** `triggerSurge`,
  noise-surge runners, and isolated-pressure runners all used gate spawns.
  In BR every spawn (director, surge, pressure, noise) now goes through
  the zone spawn point — the horde is always in the circle with the
  players. (Found by the "no zombie pile-up" test.)
- **Next-centre minimum shift vs rounding:** sampling exactly 1.5 tiles
  could round to 1.49 after the 2-decimal snapshot rounding. The nominal
  minimum is now 1.6, so the observed shift is always ≥ 1.5.
- **Test-only flakes fixed (not server bugs):** the spawn-rate measurement
  was polluted by surge/isolated-pressure spawns (now suppressed in that
  measurement); a downed-player test was flaky because surge zombies could
  execute the downed player mid-window (now wiped per tick); a 2-player
  revive scenario is impossible by design (downing the last opponent ends
  the match) so the end-screen test uses 3 players.

### Simplifications vs spec (Matt's filter — see phase3-protocol.md §13)
- **Map scope:** BR plays on the verified Gate Town arena (x 0–30,
  y 14–30), NOT the full 60×60 map (spec §2.7). Only Gate Town south has
  verified geometry. Full-map BR is a Phase 4 job. The zone/loot/drop-in/
  win systems transfer unchanged.
- **Zone fit:** a circle fits fully only for r ≤ 8 in the 16-tall arena;
  larger next circles are centred in the arena rect instead of fully
  contained. Phase 0–1 circles extend past the arena edges — fine, they
  cover the arena.
- **Zone DPS during shrink:** the DPS of the phase being left applies
  until the shrink completes; the new DPS applies on arrival.
- **Zone damage vs downed players:** HP tick applies to alive players
  only; downed players bleed out (and the win check ends the match without
  waiting when they cannot be revived). Zone damage does not interrupt
  heal/build channels.
- **Crate tiers:** tier only changes the weapon-grant chance (50/35/20%);
  attachment window is the next 20% in both modes, so Survival odds are
  unchanged.
- **Ground loot has no attachments:** scopes / extended mags / grips come
  from crates only.
- **Placement ties:** co-winners share #1; next placement is #3.
- **A lone player never instantly wins:** the BR win check needs ≥ 2
  players to have ever joined.

### Could NOT verify (needs live play / the pending gates)
- Everything in the Phase 1/2 "could NOT verify" lists still stands, plus:
  the live WebSocket test (test-phase3-live.js) has not run against a
  deployed Phase 3 build yet; the browser play test (headless Chrome,
  local server) has not run; whether the zone timings / DPS feel right in
  a real 4–8 player match (the 460 s schedule is a tuning number — if
  matches run past ~25 min it is too slow); whether the BR opening
  scramble (melee-only, loot race) feels right with real players.
- **Live Render service still runs the pre-Phase-3 build — needs the manual
  redeploy trigger (parent triggers it; report the commit SHA).**
