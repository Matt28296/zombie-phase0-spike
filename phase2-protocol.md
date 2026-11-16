# Phase 2 — Server Protocol (client contract)

**Server:** `hidden_files/phase0-server/server.js` (Phase 2, repo
Matt28296/zombie-phase0-spike, branch `main`). **Code-verified only — no live
playtest yet.** Phase 1 protocol is unchanged; everything below is additive,
except where noted. The client worker builds against this document.

## Transport (unchanged)
- WebSocket, JSON messages, 20 Hz server tick, one delta snapshot per tick.
- Client → server: `input` (unchanged), `shoot` (unchanged), `ping`, plus the
  Phase 2 messages below. Server → client: `welcome` (unchanged), `snapshot`
  (extended, see below), `pong`, `created`/`joined`/`resumed`/`error`
  (unchanged).

## 1. New client → server messages

| Message | Fields | Server behaviour |
|---|---|---|
| `role` | `role`: `leader` \| `heavy` \| `sharpshooter` \| `scout` \| `medic` \| `engineer` | Pick at drop-in (before or just after session start). Grants the role's starting weapon + passive. Default when never sent: `leader`. A fresh player (default pistol+melee only) gets the role's exact loadout; a player who already looted other weapons keeps them and just gains the role weapon. Re-pickable; the grant is additive, never a wipe. Unknown role → `action-denied`. Broadcasts `role-set`. |
| `ability` | — | Fires the player's role signature ability (see §3). Cooldown validated server-side; on cooldown → `action-denied` with `msLeft`. On success broadcasts `ability-used`. |
| `squad-invite` | `targetId` | Invite another player. Sender's squad must have room (max 4); target must not already be a squadmate and their squad must have room. Delivered as a `squad-invite` event to the target only; expires after 20 s. Sender gets `squad-invite-sent`. Errors → `action-denied`. |
| `squad-accept` | `fromId` | Accept a pending invite. Joins the inviter's squad, or forms a new squad of the two (inviter becomes leader) if the inviter is squadless. Expired/missing invite → `action-denied`. Broadcasts `squad-joined`. |
| `squad-decline` | `fromId` | Decline a pending invite. The inviter gets a `squad-decline` event. |
| `squad-leave` | — | Leave your squad at any time, no confirm. Broadcasts `squad-left` (announced). If the leader leaves, the next member becomes leader; an empty squad is deleted. |
| `squad-loot-toggle` | — | Leader only. Flips the squad's shared-loot mode (default free-for-all). Broadcasts `squad-loot`. Non-leader → `action-denied`. |
| `waypoint` | `x`, `y` **or** `clear: true` | Set (or clear) the squad's shared waypoint. Any member can set it; one waypoint per squad. Broadcasts `waypoint`. Not in a squad → `action-denied`. |
| `share` | `targetId`, `kind`: `ammo` \| `meds` | Give 12 ammo of your current weapon type, or 1 med, to a nearby (≤ 3 tiles) living player. +5 trust for the giver. Too far / not enough / target meds full → `action-denied`. Broadcasts `shared-loot`. |
| `perk-pick` | `perk`: `damage` \| `hp` \| `reload` \| `barricade` \| `ammo` \| `revive` \| `quiet` | Pick 1 of the 3 perks offered on level-up. Must be one of the currently offered choices and not already owned. Applies immediately. Invalid pick → `action-denied`. Broadcasts `perk-picked`. |
| `barricade` | `pointId`: `barricade-1` … `barricade-4` | Start building a barricade at a surveyed point. Costs 2 materials (spent on completion), takes 2 s (Engineer 1 s). You must be within 3 tiles of the point, the point must be free, and you must be under your barricade capacity. Interrupted by damage or dodge. On completion broadcasts `barricade-placed`. Errors → `action-denied`. |
| `trap` | `kind`: `spike` \| `molotov` \| `noise` | Place a trap at your position. Costs 1 material. Broadcasts `trap-placed`. Errors → `action-denied`. |
| `heal` | — | Consume 1 med, heal 40 HP over 2 s (channel). Interrupted by damage or dodge. No meds / already healing / full HP → `action-denied`. Broadcasts `heal-started`. |

Denials: every Phase 2 action that fails sends `{type:'action-denied',
action:<msg.type>, error:<reason>, msLeft:<n>}` to the **sender's own event
queue only** (not a broadcast).

## 2. Roles (§2.4)

| Role | Starting weapons | Signature ability (cooldown) | Passive |
|---|---|---|---|
| Leader | pistol + melee | **Rally** (45 s): squadmates within 10 tiles gain +15% damage, +10% move speed for 10 s (leader included) | Squadmates within 8 tiles gain +5% XP and +5% loot (ammo/meds amounts, rounded up) |
| Heavy | shotgun + melee | **Bulwark** (30 s): 40% less damage from the front for 4 s | +25 max HP, move speed ×0.9 |
| Sharpshooter | rifle + melee | **Longshot** (20 s): next shot is a guaranteed crit (+100% damage) | +15% crit chance, +25% headshot damage (head pays 2.5× instead of 2×) |
| Scout | SMG + melee | **Skydance** (12 s): long dodge-dash (1.8× dodge speed, 2× dodge time) + +20% move speed for 2 s after | +10% move speed, zombies treat Scout as 2 tiles farther away when choosing a target (lone Scout is still hunted); Runner spawn pressure ignores Scout unless alone |
| Medic | pistol + melee | **Triage** (30 s): revive at 2× speed for 10 s + medkit aura (+2 HP/s for 10 s to squadmates within 8 tiles) | Revives 50% faster, starts with 3 meds, med cap 5 (others start 1, cap 3) |
| Engineer | SMG + melee | **Fortify** (25 s): instantly deploy a free barricade at your position (nearest surveyed point within 3 tiles, else free-standing at your tile) | Build barricades 50% faster (1 s), +2 barricade capacity (cap 4) |

- A crit pays +100% damage, like a headshot. Crits apply to any weapon.
- Melee is always owned as a fallback. Any role can pick up any weapon.

## 3. Squads (§7.1–7.2)

- Max 4 players per squad; a session can hold two squads of 4. Squads are
  neutral to each other by default. Friendly fire stays ON inside a squad.
- Invite expires after 20 s. Accept forms/joins the squad; the inviter (or
  first member) is the leader.
- Shared waypoint: one per squad, any member can set/clear, visible to
  members only (see snapshot `squad.waypoint`).
- Revive priority: squadmate reviving a squadmate takes 2 s (see §5).
- Shared-loot toggle (leader only, default free-for-all). **Exact rule:**
  when split is ON, crate/pile ammo, meds, and materials picked up by a
  squad member are divided evenly among squadmates currently in the session
  (round-robin remainder to the picker; meds split one at a time from the
  picker, respecting med caps). Weapons and attachments always go to the
  picker only. When split is OFF (default), the picker takes everything.
- Squad kill feed: `squad-feed` events for revives/downs/kills involving
  squad members (client renders them as slim lines).
- Leave is announced (`squad-left`).

## 4. Trust / marks / bounty (§7.5)

- Trust is per player, session-only, starts at 0 (Neutral). Ranks:
  **Trusted ≥ 30, Neutral −9…29, Suspect −30…−10, Traitor ≤ −31.**
- Gains: revive a player **+8**, cross-squad revive **+12** (different
  squads — including a solo player reviving a squad member; same squad is
  +8), share loot **+5**, shared kill near a squadmate (within 5 tiles)
  **+2**, survive a wave together (each living squadmate) **+3**.
- Losses: damage another player **−1 or −2 per hit** (see below), kill
  another player **−20**, execute a downed player **−30**, loot a player
  you just killed (take from their death pile within 30 s) **−5**.
- **Accident vs deliberate (simple heuristic — state its limits):** the
  server tracks per attacker→victim hits in the last 10 s and whether a
  zombie was within 5 tiles of the victim when hit. First hit on that
  victim in 10 s **and** a zombie near the victim = one stray shot in a
  firefight (**−1**). Repeated shots at the same player (2nd+ hit within
  10 s) **or** shots with no zombie near the victim = **−2** per hit.
  Executing a downed player is always deliberate (−30). This is a pattern
  heuristic, not a perfect judge: a deliberate first shot in a real
  firefight reads as an accident, and a genuine accident with no zombie
  nearby reads as deliberate.
- **Kill attribution:** a player who downs a victim owns the death if the
  victim then bleeds out or is finished by zombies/a Brute slam (−20,
  counts as a kill for bounty/playersKilled). Shooting a downed player
  yourself is an execute (−30, never −20 on top).
- **The mark:** at Suspect (≤ −10) or Traitor (≤ −31) the player is
  marked: snapshot `marked: true`, rank shown, bounty shown (Traitor
  only). Client renders: red nameplate + red minimap dot + WANTED tag.
  `player-marked` broadcasts on crossing into Suspect/Traitor.
- **The bounty:** a Traitor carries a bounty of **10 + 5 × (players killed
  this session)** in XP. Killing a Traitor pays the bounty XP to the killer
  and broadcasts `bounty-claimed` with the amount.
- **Rebuild trust:** when a marked player's trust rises above Suspect
  (rank Neutral or better), the mark clears and `mark-cleared` broadcasts.
- **Spawn grace:** 10 s on drop-in, no PvP damage (zombies can still hurt).
  Snapshot `grace` is ms remaining (already Phase 1) — client shows the
  shield icon + countdown.

## 5. Revive timing ladder + execute (§7.4)

`reviveTimeFor(reviver, target)` — base **3 s**; squadmate reviving a
squadmate **2 s**; Medic reviving anyone **1.5 s**; Medic with Triage active
**0.8 s**; revive perk is a further ×0.75 on top. Revived player returns at
50% HP (unchanged). Execute: shooting a downed player executes them
(unchanged) — now also −30 trust and a `player-executed` event.

## 6. XP, levels, perks (§2.5)

- Zombie kills grant XP: Shambler 10, Runner 12, Screamer 15, Spitter 20,
  Brute 50; elite ×2. XP goes to the killer.
- Level thresholds: level n needs 50×n total XP (L1 at 50, L2 at 100, …).
- On level-up the server broadcasts `level-up` with 3 random distinct perk
  choices from the pool (not already owned). The client picks via
  `perk-pick`. Perks are session-only, one of each per player (no stacking).
- Perk pool: `damage` +10% damage; `hp` +15 max HP (and heal 15);
  `reload` 20% faster reload; `barricade` +1 barricade capacity; `ammo`
  +25% ammo from pickups; `revive` 25% faster revive; `quiet` −25% noise
  (gunfire attention) + smaller zombie aggro.

## 7. Barricades, traps, attachments (§2.5)

- **Barricades:** place at the 4 surveyed points (`barricade-1` Gate gap,
  `barricade-2` Plaza west, `barricade-3` Plaza east, `barricade-4` Plaza
  south). 60 HP. Zombies within 1.5 tiles attack the barricade instead of
  moving; at 0 HP it breaks (`barricade-destroyed`). Capacity: 2 per player
  (Engineer 4, +1 with the barricade perk). Build: 2 s, Engineer 1 s,
  costs 2 materials, interrupted by damage/dodge. Fortify is instant and
  free (capacity still applies).
- **Traps:** placed at the player's position, cost 1 material.
  - `spike`: a zombie stepping within 1 tile takes 20 damage once, trap consumed.
  - `molotov`: on trigger (zombie within 1.5 tiles) burns 10 damage/s for 3 s in a 2-tile radius, then consumed.
  - `noise`: on trigger (zombie within 1.5 tiles) director attention +20 and zombies within 10 tiles retarget to the trap for 5 s, then consumed.
- **Attachments:** loot from crates. One slot per weapon — a new attachment
  replaces the old one. Auto-applies on pickup (no management UI).
  - `scope` (rifle): range +10, spread ×0.5.
  - `extended-mag` (SMG/pistol): mag +50% (rounded).
  - `grip` (any gun): spread ×0.7.
- **Meds / heal:** medkits are loot for everyone (crates + piles). Medic
  starts with 3 meds, cap 5; others start 1, cap 3. `heal` consumes 1 med,
  heals 40 HP over 2 s (channel, interrupted by damage/dodge).
- **Materials:** crates now give +2 materials; death piles drop carried
  materials. Materials are spent on barricades (2) and traps (1).

## 8. Weapon-grant path (§6.2)

- **Crates** yield one of: a weapon the player doesn't own
  (shotgun/rifle/SMG, 35% while any is missing) + its reserve ammo;
  an attachment for an owned gun (20%); or ammo/meds/materials (45%).
  The first crate a player loots follows the same roll (no guaranteed
  weapon — the 35% roll is the grant path).
- **Death piles** drop the victim's owned weapons beyond the universal
  starting pistol+melee (so a Heavy's shotgun, a Sharpshooter's rifle, a
  Scout/Engineer SMG all drop as takeable items). The victim keeps their
  own weapon list (they're dead; the drop is a spare copy). A looter who
  takes a dropped weapon gains the weapon + its reserve ammo.
- **Roles** grant their starting weapon at drop-in (see §2).
- Equipped weapons stay on death (spec default, unchanged).

## 9. Noise economy visibility (§6.2)

- Snapshot `wave.director.attention` (unchanged, Phase 1).
- Snapshot player `noise` (0…100): recent gunfire in the last ~5 s, decays
  20/s. Pistol +10, rifle/SMG +20, shotgun +30 per shot (×0.75 with the
  quiet perk). Melee kills add no noise (unchanged).
- `surge-warning` broadcasts when director attention crosses 35 on the way
  up (~3 s before the noise surge at 50); re-arms once attention drops
  below 30.

## 10. Snapshot — new fields

Phase 1 fields are unchanged. Additions:

```jsonc
// per player (in snapshot.players[])
{
  "role": "heavy",                 // role id, default "leader"
  "weapons": ["shotgun", "melee"], // owned weapons
  "attachments": {"rifle": "scope"}, // weapon -> attachment (one slot)
  "xp": 40, "level": 0, "perks": ["damage"],
  "trust": -12, "trustRank": "suspect", // trusted|neutral|suspect|traitor
  "marked": true, "bounty": 0,     // bounty > 0 only for Traitors
  "noise": 30,                     // 0..100
  "abilityCdMs": 12000,            // ms until the ability is ready again
  "abilityActive": {"name": "bulwark", "msLeft": 3200}, // or null
  "squadId": "s1",                 // or null
  "meds": 2, "materials": 3,       // carried
  "building": {"pointId": "barricade-2", "msLeft": 1200} // or null
}
// top level
{
  "squad": {"id": "s1", "leaderId": "p1", "members": ["p1", "p2"],
            "lootSplit": false, "waypoint": {"x": 20, "y": 25} | null} | null,
  "barricades": [{"id": "b1", "pointId": "barricade-2", "x": 12.5, "y": 16.5,
                  "hp": 60, "maxHp": 60, "ownerId": "p1"}],
  "traps": [{"id": "t1", "kind": "spike", "x": 15, "y": 20}]
}
```

Notes: `squad` is the **requester's own squad only** (waypoints are
members-only; non-members get `null`). `abilityActive` is the currently
running timed buff (Rally / Bulwark / Triage aura), or `null`. `bounty` is
0 unless the player is a marked Traitor. Player `mag`/`ammo`/`grace`/
`downedMs`/`extractingMs` are unchanged Phase 1 fields.

## 11. New event types (all in the per-player event queue, drained into snapshots)

| Event | Fields | When |
|---|---|---|
| `role-set` | `playerId`, `role` | A player picks a role |
| `ability-used` | `playerId`, `role`, `ability` | A signature ability fires |
| `action-denied` | `action`, `error`, `msLeft` | Sender only, for any failed Phase 2 action (incl. ability on cooldown) |
| `squad-invite` | `fromId`, `expiresMs` | To the invite target only |
| `squad-invite-sent` | `targetId` | To the inviter only |
| `squad-joined` | `squadId`, `playerId`, `members`, `leaderId` | Someone joins a squad |
| `squad-decline` | `fromId` | To the inviter only |
| `squad-left` | `squadId`, `playerId`, `members`, `leaderId` | Someone leaves a squad |
| `squad-loot` | `squadId`, `lootSplit`, `by` | Leader flips shared loot |
| `waypoint` | `squadId`, `waypoint` (`{x,y}` or `null`), `by` | Squad waypoint set/cleared |
| `squad-feed` | `kind`: `down`\|`revive`\|`kill`, `playerId`, `by` | Revives/downs/kills involving squad members (slim lines) |
| `shared-loot` | `fromId`, `targetId`, `kind`, `amount`, `ammoType?` | A player shares ammo/meds |
| `player-marked` | `playerId`, `rank`, `bounty` | A player crosses into Suspect/Traitor |
| `mark-cleared` | `playerId`, `rank` | A marked player's trust rises above Suspect |
| `bounty-claimed` | `killerId`, `victimId`, `amount` | A Traitor is killed; killer gains the bounty XP |
| `player-executed` | `playerId`, `by` | A downed player is shot (execute) |
| `level-up` | `playerId`, `level`, `choices` | A player levels up (3 perk choices) |
| `perk-picked` | `playerId`, `perk` | A perk is picked |
| `barricade-placed` | `barricade`, `by`, `free?` | A barricade is placed (build or Fortify) |
| `barricade-destroyed` | `barricadeId`, `by` | A zombie destroys a barricade |
| `trap-placed` | `trap`, `by` | A trap is placed |
| `trap-triggered` | `trapId`, `kind`, `zombieId` | A trap triggers (consumed) |
| `heal-started` | `playerId` | A medkit channel starts |
| `surge-warning` | `attention` | Director attention crosses 35 (surge coming) |
| `crate-looted` | `playerId`, `crateId`, `granted?`, `attachment?` | A crate is looted; `granted` is a weapon id, `attachment` is `{weapon, name}` |
| `loot-taken` | `playerId`, `lootId`, `split` | A loot pile is taken; `split` true when shared-loot split applied |

Changed events: `shot` now carries `crit: bool` and `damage` is the damage
**actually dealt** (Bulwark-reduced, 0 if dodged). `loot-taken` gains the
`split` flag. `player-died` `by` is now the effective killer (includes the
player who downed a victim who then bled out / was finished by zombies).

## 12. End screen (`session-end` → `score`)

```jsonc
{
  "waveReached": 3, "kills": 41,
  "titles": [{"title": "Last One Standing", "playerId": "p2"},
             {"title": "Most Revives", "playerId": "p1"},
             {"title": "Most Betrayals", "playerId": "p3"}],
  "players": [{
    "id": "p1", "role": "medic", "squadId": "s1",
    "wavesSurvived": 3, "kills": 12, "headshots": 4, "revives": 3,
    "playersKilled": 0, "lootCollected": 5, "damageDealt": 1240,
    "timesDowned": 1, "trust": 24, "trustRank": "neutral",
    "xp": 180, "level": 3, "state": "extracted"
  }]
}
```

Titles are included only when someone qualifies (Most Revives / Most
Betrayals need > 0). Last One Standing is the last alive/extracted player,
else the last to die.

## 13. Simplifications vs spec (Matt's filter — see coordination notes)

- **Shared loot:** single toggle, no distribution UI. Weapons/attachments
  never split (picker only).
- **Accident vs deliberate:** simple 10 s pattern heuristic (see §4). It is
  not a perfect judge — stated in §4.
- **Attachments:** auto-apply on pickup, one slot per weapon, no
  management UI.
- **Barricades:** surveyed points only (4), one build channel, zombies
  attack a barricade only when within 1.5 tiles (no flow-field blocking).
- **Traps:** one message per kind, placed at the player's position.
- **Perk pick:** slim strip on the client (server just sends the 3
  choices); never blocks input.
- **Death-pile weapons:** "non-starting" = beyond the universal
  pistol+melee, so role starting weapons (Heavy shotgun, Sharpshooter
  rifle, Scout/Engineer SMG) DO drop — per the task's parenthetical.
- **Revive trust:** same squad +8; anything else (different squads, or a
  solo reviving a squad member) +12. Two solos reviving each other count
  as +12 (not the same squad).
- **Triage aura:** heals squadmates only (a solo Medic gets no self-heal
  from it — the aura is a squad ability).
- **Rally:** the Leader also gains their own Rally buff (simpler than
  excluding the caster).
- **Bulwark:** applies to zombie damage too (not just PvP).
- **Kill (−20) attribution:** a downer owns a bleed-out / zombie-finish
  death, since in this engine a player kill otherwise only ever happens
  via execute (−30).
