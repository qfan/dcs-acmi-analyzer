# BVR Trainer (working title): viability assessment and plan

A browser mini-game for practising DCS-style beyond-visual-range (BVR) fights from a top-down view.
There is one aircraft (F/A-18C) and one missile (AIM-120C), both tuned from the measurements this
repo's analyzer already makes on real DCS recordings. It starts single-player against an NPC and may
grow into 1v1 or 2v2 multiplayer. There is no flight model beyond a point mass, no cockpit view and
no advanced graphics.

Branch: `game` (from `master` at `d60854f`). Written 2026-11-14.

---

## Status (updated 2026-11-14)

Where things stand, and decisions made since this plan was written. The sections below are the
original plan and are kept as written.

**Done**
- **Phases 0–1:** fixed-step sim, point-mass jet and AIM-120C models with every number editable
  (Parameters dialog), launch zone (Rmax/Rne count only "likely lethal" arrivals, Mach 0.9 by default),
  three scenarios, top-down page with RTS-style orders.
- **Phase 2 (parts):**
  - **RWR:** a ring on each own jet. Radar scans and active missiles only; no launch warning.
  - **Fog of war:** a toggle, off by default. Missiles never show on radar.
  - **Missile timers:** onboard TTP/TTI estimates instead of reading the missile.
  - **Radar:** 80 nm detection, 70 nm TWS lock (needed to fire and for datalink).
  - **Missile shutdown:** at 120 s, or below 200 kt true airspeed.
  - **End of fight:** waits while a missile can still kill, then calls the result after a random 5–10 s.
  - **`.acmi` export:** download, open in the viewer, or both. The viewer keeps the last file across refreshes.
- **Phase 3:**
  - **NPC (`src/game/ai/doctrine.ts`):** flies doctrine from its side's own radar picture, RWR and
    missile timers. Easy, Normal and Hard skills; difficulty judged about right (a Normal-vs-Normal
    duel splits roughly evenly; Hard beats Normal and Easy almost every time).
  - **Scenarios:** 1v1 and 2v2 against the NPC, or NPC vs NPC (watch mode).
  - **Tuning:** `node scripts/botmatch.ts` runs headless NPC-vs-NPC batches.
- **Release:** the game page carries the same about/disclaimer footer as the viewer and analytics
  (unofficial, not affiliated with Eagle Dynamics or Raia Software, simplified game values, as-is).
- **Phase 4 (altitude and energy), player side** (2026-11-15):
  - **Flight model:** 3-DOF point mass. Lift splits into a turn part and a climb/dive part inside the
    g available; an altitude-hold autopilot flies to the ordered altitude. Climb angle follows the
    turn mode: Hold Spd climbs only on the power the current turn leaves over (speed held), Normal
    up to 20°, Max up to 45°. Low-speed protection stops a zoom before the minimum speed; hard deck
    1,000 ft, ordered ceiling 50,000 ft; reaching the ground loses the jet. All editable.
  - **Missiles:** unchanged model (already density-driven); jets changing altitude now makes it
    matter. Head-on Rmax against a 25k ft target: 16.5 nm fired from 5k ft, 47.7 nm from 25k ft,
    57.7 nm from 45k ft. A target that dives into thick air makes the same shot arrive ~0.3 Mach
    slower. The radar scan is now stabilised to the horizon (climbing no longer tilts the gimbal).
  - **UI:** altitude order row (↑/↓ ±1,000 ft, Shift or PgUp/PgDn ±5,000, L level off), energy
    height and Ps readouts, climb arrows and ordered altitude on map labels, side-view inset.
  - **NPC altitude tactics: built, off by default.** Skill fields `commitAltFt` (Hold Spd climb)
    and `defendDropFt` (dive when defending), plus unload-and-dive when slow. In botmatch batches,
    climbing cost the NPC (Hard lost to Easy), and any defensive dive made almost every missile
    miss, so fights ran out the 15-minute clock. The NPC's shot ranges assume the target holds
    course and altitude; they need to allow for dives before these can be turned on.
  - **Known, not from this change:** on the commit before Phase 4, Hard already loses to Normal in
    botmatch (100% at 15k ft, 73% at 25k ft), against the Phase 3 note below. Jets in level AB keep
    accelerating past Mach 1.4 at altitude (cd0 table); DCS data tops out near Mach 1.1–1.15.

**Decisions that change the plan**
- **Time:** real time with manual pause by default. Auto-pause and turn mode are optional settings.
- **Notch and chaff:** off. The notch rule was removed and chaff's effect defaults to 0; chaff and
  flares are visual only, to be revisited.
- **Dropped:** enemy Rmax/Rne overlays (too cluttered).
- **Later:** the end-of-fight debrief (after n-vs-n); scored drills.

**Next**
- Phase 4 remainder: NPC altitude tactics and shot ranges that allow for dives; rebalance Hard vs
  Normal; supersonic drag so top speeds match the data; look-down notch ("notch low").
- Phase 5 (multiplayer).
- Later: n-vs-n beyond 2v2, then the end-of-fight debrief; revisit chaff.

---

## 1. Verdict: viable, and most of the hard parts already exist

| Question | Answer |
|---|---|
| Is the physics affordable in a browser? | Yes, easily. Point-mass jets and missiles, under 20 objects, at 20–100 Hz is microseconds per step. The sim can run **thousands of times faster than real time**. That speed is what makes live launch-zone (WEZ) readouts, look-ahead NPC AI and batch bot-vs-bot tuning cheap. |
| Is there data to make it feel like DCS? | Yes, and I measured it while writing this (§3). The analyzer already fits an AIM-120C flyout model (thrust, drag per Mach band, induced drag, lift limit, loft habit) from 214 recorded shots. The same recordings give an F/A-18C turn and energy table. |
| Can we reuse the viewer? | Largely. The 2D canvas drawing primitives (`src/map/render.ts`), the three.js scene builder (`src/scene/`), units and settings, the ISA atmosphere and the missile flyout code (`src/analytics/missileFit.ts`, `missileReach.ts`) all port over. Only the game loop, controls and HUD are new. |
| Can we check the game against DCS? | Yes. That is a strong point of this repo. If the game writes `.acmi` files, its own shots can be loaded into `analytics.html` and compared with the DCS dataset using the same tools: reach ladder, defeat modes, F-pole, reaction timing. The same files give players an after-action debrief in the viewer they already know. |
| New dependencies? | None are needed through Phase 4. React, three.js and Vite are already here. Multiplayer (Phase 5) adds hosting, not necessarily packages (§7). |

**The main risk is design, not engineering.** BVR is minutes of setup followed by a few seconds of
decisions that matter. The game works if the controls and time handling make those decision points
obvious and fair. §4 is built around that.

---

## 2. Your spec, with a few notes

| Your spec | Plan | Note |
|---|---|---|
| No full flight model or autopilot sim | 3-DOF point mass with an "energy-manoeuvrability" model: thrust and drag vs Mach and altitude, a g limit, and turn rate from g. | — |
| Rocket burn time | Boost of 7.0 s at about 146 m/s² (≈15 g along the flight path), no sustain phase, then coast with Mach-dependent drag. All of this is fitted. | Comes straight from the analyzer's fit. |
| Air density affects energy loss | ISA density everywhere: missile drag `cd(M)·ρ·v²`, induced drag `ci·L²/(ρv²)` and lift limit `liftK·ρ·v²`; jet thrust and drag scale with ρ too. | The same missile reaches 15.9 nm head-on at 5,000 ft and 41.6 nm at 35,000 ft. |
| Turning physics: g, turn rate, speed loss in turns | Turn rate = g·√(n²−1)/V. Induced drag grows with n², so a hard turn bleeds energy. The g limit is the lower of the structural/FCS limit and the lift available at the current speed and altitude. | Tuned to the measured F/A-18C table in §3.2. |
| One aircraft, one missile | F/A-18C with AIM-120C on both sides. | A symmetric matchup is good for training: only tactics differ. Adding more missiles later is mostly data, since the analyzer already fits R-27ER as "good" from the sample pack alone. |
| Datalink ("radio command") midcourse: updates only while the shooter's radar holds the target | The missile gets target updates only while the shooter's radar has the target: inside the gimbal limits, inside detection range and, once added, not notched. Without updates it flies to the extrapolated last-known position. | — |
| Goes active at "assumed 10 nm to target" | Pitbull when the missile's *own estimate* of range to target is ≤ 10 nm. The seeker then searches a cone around where it thinks the target is. If the target has moved out of that cone, the missile misses. | Kept as a parameter (default 10 nm). This is the mechanic behind "go cold and drop the lock" and "notch the pitbull", which are the core lessons. |
| Pure pursuit at launch, lead pursuit near the end | Midcourse steers at the datalinked or estimated target (pure pursuit by default, plus loft). After pitbull it switches to proportional navigation (N≈4 with gravity compensation), which is the lead-pursuit law. | **Worth checking against data:** pure pursuit in midcourse makes the missile curve, and lose energy, against a cranking target more than a lead-point midcourse would. That may overstate how well cranking works. I'd make the midcourse law a setting (pure pursuit ↔ lead toward a predicted intercept point) and keep whichever reproduces the analyzer's crank and flight-time statistics. |
| Flat altitude at first, energy trading later | Phase 1 holds jets at a fixed altitude **chosen per scenario**. Missiles fly fully in 3D (loft and dive) from day one. Phase 4 adds climb, dive and trading altitude for speed. | A fixed but selectable altitude already teaches a big lesson: launch ranges change by about 2.6× between 5k and 35k ft. |

---

## 3. What the data says (measured for this plan)

### 3.1 AIM-120C: the analyzer's fit on `public/samples/bvr-sample-pack.json`

`fitMissileModels()` on the bundled sample pack: **214 shots, 52 kills, 28,848 coast samples, quality "good".**

- Motor: boost 7.0 s at 145.8 m/s², no sustain. Peak about Mach 3.6.
- Drag per Mach band (1/m, `a = cd·ρ·v²`):
  M<0.9: 6.3e-5 · 0.9–1.2: 8.7e-5 · 1.2–1.6: 9.4e-5 · 1.6–2.2: 8.2e-5 · 2.2–3.0: 6.8e-5 · ≥3.0: 5.8e-5
- Induced drag factor `ci` = 499, lift limit `liftK` = 9.5e-4 (the sim also caps it at 40 g).
- Loft habit (median apex gain over launch altitude): 10–20 nm → 2,800 ft, 20–30 nm → 9,600 ft, 30–40 nm → 15,400 ft.
- "Still lethal" arrival speed: about Mach 0.90 (the slowest 10% of kills). Median arrival speed of kills: Mach 1.34.
- Replay check: median error 0.025 Mach at the end of the coast, but **p90 error is 0.57 Mach**. Typical flyouts are right; the unusual ones are not.

Reach ladder from the existing `reachLadder()` (shooter and target co-altitude at Mach 0.9; reach means the missile arrives at Mach 0.9 or faster):

| Altitude | Head-on, direct | Head-on, lofted | Target turns cold at launch |
|---:|---:|---:|---:|
| 5,000 ft | 15.9 nm | 20.4 nm | 5.1 nm |
| 15,000 ft | 21.6 nm | 41.4 nm | 7.2 nm |
| 25,000 ft | 29.8 nm | 54.7 nm | 11.5 nm |
| 35,000 ft | 41.6 nm | 61.9 nm | 23.8 nm |
| 45,000 ft | 58.5 nm | 67.9 nm | 33.2 nm |

These are in the range DCS players would expect, so the existing model is a good starting point. Before
tuning, refit on the full corpus (`pnpm analytics:dataset` over `T:\`) instead of the 11-file sample
pack. The 40–60 nm loft bin has only 6 shots today.

### 3.2 F/A-18C: kinematics from 49 recordings

This was a one-off extraction from the 6 sample recordings plus 43 recent (2024+) F/A-18C BFM, guns
and BVR recordings on `T:\`. It covers 131 F/A-18C objects and 47,667 half-second samples, about 6.6 h
of flight. Values are percentiles of what pilots actually flew. They are a target for tuning, not the
true edges of the envelope.

| Altitude | Max g (p99) | Best instantaneous turn (p99) | Sustained turn (rough) | Energy loss at ≥4 g (median Ps) | Level acceleration (p90 Ps) |
|---|---|---|---|---|---|
| 0–10k ft | ≈8.1 g at M0.6–1.0 | 24–28°/s at M0.4–0.5; 15°/s at M0.9 | ≈10–15°/s | −100 to −215 m/s | +110 to +140 m/s at M0.7–0.9 |
| 10–20k ft | ≈7.0–7.6 g | 20–24°/s at M0.5–0.7; 12–13°/s at M0.9–1.1 | ≈7–10°/s | −75 to −235 m/s | +90 to +135 m/s |
| 20–30k ft | ≈5–6 g (lift-limited) | 14–23°/s at M0.5–0.7 (noisy); 10°/s at M0.9+ | ≈4–8°/s | −125 to −365 m/s | +100 to +125 m/s |
| 30k+ ft | ≈4–4.7 g | 8–10°/s | ≈3°/s | −375 to −465 m/s | +110 m/s |

Top speed actually reached (p99.5): Mach 1.07–1.15 depending on altitude, which fits BVR loadouts.

Plan: in Phase 0, turn this one-off script into `scripts/fit_aircraft.ts`. Fit a small parametric model
to these bins with the same robust least squares the missile fit uses: thrust (MIL and AB) vs Mach and
density ratio, CD0(M), induced factor k, CLmax and the g limit. Commit the result as
`src/game/data/fa18c.json` next to an exported `aim120c.json`.

---

## 4. Real-time (StarCraft-style) or turn-based? Build one engine, decide by playtest

The choice doesn't have to be made now. Build a **deterministic fixed-step sim** that only advances
when told to. Then "real-time", "turn-based" and anything in between are just policies for when time
moves:

| Mode | How it plays | Good for | Weak at |
|---|---|---|---|
| Real-time with pause | Time runs at 1×, 2×, 4× or 8×. You can pause and give orders while paused. Select jets and click or drag a heading, StarCraft-style. | Pace and feel close to DCS. Simple. | Busy with 2 jets each. Decisions are easy to miss at 4×. |
| Event auto-pause (recommended default) | Same as above, but the game pauses itself at decision points: enemy launch on RWR, own missile pitbull, missile inside X nm, radar contact gained or lost, datalink lost, a timeline range crossed (e.g. MAR). | **Training.** DCS BVR decisions are triggered by exactly these events, and pausing on them names each decision. | Needs good event tuning, or it pauses too often. |
| Fixed-interval turns (WEGO) | Time stops every N seconds (and on events). Both sides give orders, then the sim runs. | Thoughtful play. The **easiest fair multiplayer**: both sides submit orders, then the server advances. | Feels less like flying. |

**Recommendation:** default to real-time with pause plus event auto-pause in single-player. Make the
event list and an optional "turn every N s" a setting. Pick the multiplayer mode after people have played
it. Simultaneous turns with event interrupts is the safe choice for 2v2.

Controls (one layout for all modes):
- Select a jet (or drag-select several). Right-click or drag sets a heading, or a point to fly to. The same RTS feel either way.
- Throttle: idle, MIL, AB. Turn effort: "normal" (≈4 g) or "max performance" (up to the g limit). This makes energy management a visible choice.
- **Named manoeuvre buttons** relative to a chosen threat: *crank L/R* (to the gimbal limit), *notch L/R* (beam), *pump / go cold*, *hot*. These teach the vocabulary, and they make flying 2 jets in 2v2 manageable.
- Fire at the selected contact. A live readout shows the current Rmax, the no-escape range (Rne) and the predicted arrival Mach. All three come from fast-forwarding the same missile model, which is cheap (§1).
- Later (Phase 4): altitude target (scroll wheel or slider on the selected jet) and a side-view panel.

Session length works out: two jets at Mach 0.9 each close at about 18 nm a minute, so from 40 nm a
fight lasts about 2–5 minutes, less with time compression.

---

## 5. Architecture (in this repo, as a third page)

```
game.html                    new Vite entry, next to index.html and analytics.html
src/game/
  sim/                       pure TS, deterministic, no DOM: runs in the browser, in Node (tests, bot batches), and in a server for multiplayer
    world.ts                 fixed step (20 Hz; missiles substep at 100 Hz or use the closest-point-of-step trick from missileReach.ts), seeded RNG, command queue, event log
    aircraft.ts              energy-manoeuvrability point mass: heading/turn effort → bank/g → turn rate, Ps = V(T−D)/W; Phase 4 adds flight path angle
    missile.ts               3D version of simulateFlyout: boost/coast, loft, datalink midcourse, pitbull, seeker cone, PN, fuze
    sensors.ts               radar (gimbal, range, later notch/clutter), datalink validity, RWR (spike, launch warning), what each side knows
    rules.ts                 every tuning constant in one visible place (same habit as FIT_RULES / SIM_RULES)
  data/fa18c.json, aim120c.json   produced by scripts from the analyzer fits, committed
  ai/                        NPC: works only from its own side's sensor picture
  ui/                        GameApp.tsx, canvas view (reuses map/render.ts drawing), HUD, controls, overlays
  acmi/writer.ts             game → .acmi for debriefs in the viewer and analytics
scripts/
  fit_aircraft.ts            F/A-18C model fit from recordings (from the §3.2 extraction)
  export_missile_model.ts    analyzer fit → aim120c.json
  botmatch.ts                headless bot-vs-bot batches for AI tuning and win rates
```

Design rules:
- **The sim is a pure function of (state, commands, dt, seed).** Replays, auto-pause, turn mode, AI look-ahead and multiplayer all depend on this.
- **Flat local metres** (east, north, altitude), like DCS's flat map. No geodesy in the sim; the ACMI writer converts to lon/lat around a reference point.
- **Sensor truth vs god view:** the UI can draw everything (learning mode) or only what your radar and RWR show (realistic mode). The NPC always uses the realistic picture.

---

## 6. Phases and effort

Effort is in **working days at this repo's pace**: one developer directing AI coding assistants, the
way the viewer and analytics were built (38 commits over 3 working days). Playtesting and tuning are
mostly *your* judgement and won't shrink much. Add roughly **30–50% calendar time** for them. Without AI
assistance, a rough guess is 3–5× the coding time.

### Phase 0: sim core and calibrated models (1.5–2.5 days)
- Fixed-step world, entities, seeded RNG, commands, event log, tests.
- `fit_aircraft.ts` plus the fitted `fa18c.json`; `aim120c.json` exported from a refit on the full corpus.
- Port the missile flyout to 3D with loft and PN.
- **Done when** headless tests reproduce the analyzer's reach ladder within about 5% and the §3.2 turn/Ps table within its noise.

### Phase 1: playable 2D prototype, flat altitude, vs a scripted target (2–4 days)
- Top-down canvas: jets, missiles, trails, range rings, scale, radar cone, datalink line, pitbull marker, missile Mach readout.
- Controls from §4 (heading, throttle, turn effort, fire, manoeuvre buttons), pause, time compression, event auto-pause.
- Radar gimbal and range, datalink, pitbull at 10 nm, seeker cone, PN, proximity fuze. Kinematic defeat (out-running the missile) falls out of the physics.
- The target is a script: fly hot, crank, turn cold, waypoints.
- **Done when** "out-run a 20 nm shot by going cold in time" and "drop the lock before pitbull" both work without special-casing. **Playtest here** before investing further, and decide the default time mode.

### Phase 2: BVR depth and the training layer (4–6 days)
- Notch against the shooter's radar and the missile seeker (doppler gate on radial speed) and chaff, as simple probabilistic rules. They are tuned against the analyzer's notch-gate fit and defeat-mode rates, since DCS internals here are opaque and change between patches.
- RWR: spike, and launch warning differences between TWS and STT shots. Fog of war (realistic vs god view).
- Overlays: live Rmax and Rne, the AR-2 timeline ranges (MAR, DR…) from `src/analytics/timeline.ts`, the remaining energy of every missile in flight.
- **ACMI export**, so one click opens the fight in the viewer and analytics (F-pole, defence type, reaction time).
- Scenario drills with scoring, e.g. "defend at 20/15/10 nm", "crank for maximum F-pole", "notch at pitbull", "70% Rmax vs Rne shot".
- **Validation loop:** fire about 500 randomized headless shots, export them, run the analyzer and compare with the DCS dataset.

### Phase 3: NPC AI (3–6 days, plus open-ended tuning)
- A state machine or behaviour tree that follows BVR doctrine: commit, shoot at a doctrine range, crank, pump at MAR, notch on launch warning or pitbull, re-commit, defend. It uses only its own sensor picture.
- Difficulty settings: reaction time, shot discipline (fraction of Rmax), notch precision, how often it makes mistakes.
- `botmatch.ts`: thousands of headless fights to tune and to catch exploits.
- Later, optional: search-based AI (simulate a few candidate manoeuvres ahead, which is cheap at this speed) or reinforcement learning by self-play. The deterministic headless sim makes both possible, but both are open-ended research.

### Phase 4: altitude and energy trading (3–5 days)
- Flight path angle and climb/dive commands, energy accounting (`Es = h + V²/2g`), thrust and drag vs altitude, ground and ceiling limits.
- Shooter speed and altitude feed directly into missile range, so "shoot high and fast" emerges by itself.
- Look-down clutter: notching works much better against a target below the horizon (the classic "notch low").
- UI: altitude control, altitude tapes, side-view panel and/or the existing three.js view.
- AI learns altitude tactics.

**Single-player trainer with AI and altitude (Phases 0–4): about 14–24 working days**, plus playtesting.

### Phase 5: multiplayer, 1v1 then 2v2 (4–8 days, plus hosting decisions)
- **Server-authoritative**, not peer-to-peer lockstep. JavaScript's `Math.sin`, `exp`, `pow` and so on are not guaranteed to be bit-identical across browser engines, so lockstep sims would drift apart. A server that owns the sim avoids this. It also hides each side's fog of war from the other, which is the main anti-cheat need.
- Natural fit: the same pure-TS sim in a Cloudflare Worker with a Durable Object per match (the site already deploys to Workers), over WebSockets. Check plan limits and cost first.
- Simultaneous turns with event interrupts are the easiest fair mode. Real-time also works with the server ticking.
- Lobby or match codes, reconnect, a 2v2 shared picture (datalinked contacts).
- Note: the README promises "no server-side code and no requests to other sites". Multiplayer should be its own deployment or entry point, so the viewer keeps that promise.

### Phase 6: optional
More aircraft or missiles (data-driven from analyzer fits), campaigns or lesson progression, advanced AI.

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Not fun: long setup, then sudden decisions | Medium | Time compression and event auto-pause. Playtest right after Phase 1. Short scenario drills rather than full sorties. |
| Missile behaviour wrong in unusual cases (p90 replay error 0.57 Mach; thin long-range loft data) | Medium | Refit on the full corpus. Keep constants in `rules.ts`. Validate in Phase 2 through the ACMI → analyzer loop. |
| Notch, chaff and seeker don't match DCS (opaque, patch-dependent) | High, by nature | Keep them simple and tunable, calibrated to the analyzer's measured defeat rates. Say in-game that it is a trainer for decisions, not a DCS replica. |
| F/A-18C table shows typical flying, not the true envelope edges | Medium | Fit a physical E-M model rather than replaying the table, and sanity-check corner speed and the g limit. |
| NPC competent but predictable | Medium | Randomness in difficulty settings, several doctrine "personalities", batch testing. |
| Multiplayer cost and operations | Low until Phase 5 | Server-authoritative design from the start (pure sim), deploy only when needed. |
| Naming and IP | Low | Don't use the DCS name or branding in the game title or UI. The numbers are our own measurements of recordings. Keep the existing disclaimer. |

---

## 8. Next step

Start Phase 0: productionize the aircraft fit, export the missile model after a full-corpus refit,
and build the 3D missile flyout with its headless checks. Phase 1's playtest is the first real go/no-go
point for the game design.
