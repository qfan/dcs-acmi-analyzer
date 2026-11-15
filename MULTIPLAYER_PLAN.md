# BVR Trainer: Phase 5 (multiplayer) plan

Written 2026-11-15 on branch `game` (at `b90b91d`). Replaces the short Phase 5 sketch in
[GAME_PLAN.md](GAME_PLAN.md) §6. Server code goes under [`game/server/`](game/server/), one subfolder
per deployment target.

**In one paragraph:** the sim is already the right shape for networking: deterministic, fixed-step,
seeded, and driven by a handful of small orders rather than stick input. Worst-case bandwidth is
small: about **7 KB/s per player in 1v1, 14 KB/s in 2v2 and 42 KB/s in 6v6** while streaming state,
and under 1 KB/s if only orders are sent. The recommended setup is **one player's browser runs the
fight ("host") and a small relay forwards messages between browsers**. The relay runs no game logic,
never opens connections of its own, and never shows anyone's IP address to other players. Deploy it
on the **Cloudflare Workers Free plan** (Durable Objects, no payment method on file, so it can never
send you a bill). A Node.js version of the same relay covers self-hosting, LAN and a cheap VM.

## Status (2026-11-15)

**Built:** the Node relay (`game/server/`), and Phase 5a in the game:

- **Sim in a Web Worker** (`src/game/engine/`), for single player and the multiplayer host. The UI
  only draws snapshots on a mirror world (`src/game/ui/view.ts`). Hidden tabs no longer stall the
  host. Single player pauses itself when its tab is hidden, as it effectively did before.
- **Per-side knowledge** (`src/game/sim/knowledge.ts`). Snapshots carry both sides' pictures to
  the relay (JSON, numbers rounded, missiles trimmed; sent every 100 ms or slower when large).
- **New game dialog** with Single player and Multiplayer tabs. Lobby: room code and invite link
  (`#join=CODE`, never sent to a server), scenario (duel, 2v1, 2v2, 4v2, a new 6v6), altitude,
  loadout, fog of war, real time or turns, host-only time compression. Each seat is a player, an
  NPC of any skill, open (an NPC if nobody takes it) or closed. Ready, swap sides, start, back to
  lobby.
- **Rules in the match:** fog of war is on by default and locked for everyone; the host can turn
  it off before the start, and then each player chooses their own. Five pauses each, and anyone
  can resume. In turn mode the fight waits for every player. A dropped player gets 60 s, and the
  fight waits for them; after that an NPC flies their jet. Orders for jets you don't own are
  refused.
- **Tests:** `tests/engine.test.ts` runs a host and a guest engine through a real relay in Node.
  The browser flow (host, invite link, join, seat, ready, start, orders, pause, drop, NPC takeover,
  end match) was checked in two tabs against the local relay.

**Server selector** (`src/game/net/relays.ts`): built-in relays `wss://bvr-mini-game-server-cf.qfan.ca/ws`
(Cloudflare) and `wss://bvr-mini-game-server-or.qfan.ca/ws` (Oracle), plus this computer's relay on
localhost pages. While the Multiplayer tab is open the game reads each relay's `/healthz` (CORS, `ok`,
`busy` or `disabled`). Automatic hosts on the quickest relay that is open, falling through to the
next; a typed code is looked up on each known relay; invite links carry their relay
(`#join=CODE&r=cf`, or the full address for a custom one). The last 5 custom relays are remembered
in this browser.

**Worst-case load** (`tests/spam.test.ts`): 6v6, every jet firing all 10 missiles and dumping
every chaff bundle and flare (120 missiles and 1,000+ decoys in the air). Snapshots peak at about
39 KB (average about 21 KB), under the relay's 64 KB message limit: decoys are sent once on release
and moved by each guest; missiles, decoys and timers go as arrays; coordinates are rounded to
0.1 m. A snapshot that would still be too big is slimmed or held back without losing anything.
Guests' orders are paced (10 a second, latest heading or throttle wins, a few shots queue), held
keys don't repeat fire, chaff, flare or pause, and the host limits its replies to each guest, so
neither side can trip the relay's flood limits.

**Cloudflare relay** (`game/server/cloudflare/`): a Worker plus one Durable Object per room using the
Hibernation API, rebuilt from storage on wake-up, with a relay-wide room counter. It shares the room
rules with the Node relay. Tested with a fake Durable Objects runtime and end to end on `wrangler dev`
(two game engines, and two browser tabs). Rooms on Cloudflare are addressed as `/ws?room=CODE`; the
client sends that for joins and resumes (the Node relay ignores it).

**Not done:** the Cloudflare and Oracle relays are not deployed yet, so both show as unreachable;
on localhost the game uses `ws://localhost:8787/ws` (run `node game/server/node/relay.ts`), and Custom
address takes any other.
Binary snapshots and lockstep (5b) are not started.

---

## 1. Is the game data ready for multiplayer?

### What already fits

| Property | Where | Why it matters |
|---|---|---|
| Deterministic fixed step (50 Hz, `SIM_DT = 0.02`) | `sim/world.ts` | Every client can run or replay the same fight. |
| Seeded PRNG (Mulberry32, one 32-bit word of state) | `sim/rng.ts` | Randomness can be reproduced and shipped as 4 bytes. |
| All input goes through `Command` (steer, throttle, effort, altitude, target, fire, chaff, flare) | `sim/world.ts` | Orders are tiny (20–100 bytes) and rare (RTS-style), so they are cheap to send. |
| Sim is pure TS with no DOM | `sim/` | It runs in a browser, in Node and in a Cloudflare Worker unchanged. |
| Few objects: at most 12 jets, and missiles capped by loadout (4–10 per jet) | `sim/scenarios.ts` | State is a few KB even in the worst case. |
| NPCs are `Controller`s that emit the same `Command`s | `ai/doctrine.ts` | An NPC jet costs no extra bandwidth compared with a human one. |

### What has to change (all small)

1. **World state can't be serialized yet.** The PRNG is a closure with hidden state; `radarTrack`,
   `radarBreak`, `rwrSeen` and `egressSafeSince` are `Map`/`Set`; `controllers` holds NPC objects
   with their own memory. Needed: `makeRng` returning a readable/settable state,
   `serializeWorld()`/`loadWorld()` and a cheap `hashWorld()` for desync checks. About half a day.
2. **`GameSession` mixes three jobs:** owning the sim (stepping, time scale, pause, auto-pause, turns),
   building one side's picture (radar knowledge, missile timers, last seen), and UI selection. It also
   assumes the player is blue (`PLAYER_SIDE`). Split it into an *authority* (steps the world) and a
   *view* (one side's knowledge, built from whatever world state it is given), with a side and a set
   of owned jets per player.
3. **Commands need an envelope:** `{tick, player, cmd}`. The host checks that the player owns the jet.
   This is not anti-cheat; it only stops a player from steering the other side's jets.
4. **Multiplayer time rules.** No time compression unless everyone agrees. Pause: any player may pause
   (with a per-player limit), or use the existing turn mode (`turnEveryS`) with a "ready" button for
   each player. Auto-pause events become "notify" in real-time multiplayer.
5. **Floating-point determinism across browsers is not guaranteed.** ECMAScript doesn't require
   `Math.sin`, `cos`, `atan2`, `exp`, `log` and `pow` to give bit-identical results in Chrome, Firefox
   and Safari. `+ − × ÷` and `sqrt` are exact. So two browsers running the same fight in lockstep may
   slowly drift apart. This decides the architecture (§3).
6. **Fog of war is computed on the client from full truth.** Fine for this project: no strict
   anti-cheat is needed, and a player could only "map hack" through the dev tools.

---

## 2. Bandwidth, worst case

### Per-object sizes (binary encoding; JSON is roughly 4–5× larger)

| Object | Display snapshot | Full state (join or resync) |
|---|---:|---:|
| Jet: id, flags (alive, throttle, effort), position, heading, flight-path angle, speed, bank, g, ordered altitude, steer, stores, target | ≈ 50 B | ≈ 60 B |
| Missile: id, phase flags, position, velocity (+ for full state: estimated target position/velocity, flight time, loft, closest approach, lost/blind times) | ≈ 30 B | ≈ 80 B |
| Event (kill, launch, pitbull…) | ≈ 20 B, only when one happens | — |
| Fight setup: parameters, scenario, seed | — | ≈ 4 KB JSON, once |

Display snapshots go out at **10 Hz**; clients interpolate between them. At map scale a jet moves
about 30 m and a missile about 100 m per snapshot, which is under a pixel at normal zoom. TCP, TLS and
WebSocket framing add roughly 60–80 B per message, about 0.7 KB/s at 10 Hz.

"Worst case" means every jet alive and **every missile in the air at once** (possible in theory: a
missile lives up to 120 s). "Typical" means one missile per jet in the air.

### A. Host streams state (recommended, §3)

| Fight | Jets | Missiles, worst / typical | Per client, worst | Per client, typical | Burst (full state on join) |
|---|---:|---:|---:|---:|---:|
| 1v1 | 2 | 20 / 2 | 7 KB/s (≈ 60 kbit/s) | 2 KB/s | ≈ 6 KB |
| 2v2 | 4 | 40 / 4 | 14 KB/s (≈ 115 kbit/s) | 3 KB/s | ≈ 8 KB |
| 6v6 | 12 | 120 / 12 | 42 KB/s (≈ 340 kbit/s) | 10 KB/s | ≈ 15 KB (≈ 50 KB as JSON) |

With naive JSON, multiply by about 5: 6v6 worst case becomes about 210 KB/s (1.7 Mbit/s) per
client. Still playable, but binary is worth it for 6v6.

**Relay traffic.** The host uploads each snapshot once and the relay copies it to every other player.

| Fight (all human) | Relay out, worst | Relay out, typical | Per match-hour, typical |
|---|---:|---:|---:|
| 1v1 (1 guest) | 7 KB/s | 2 KB/s | ≈ 10 MB |
| 2v2 (3 guests) | 42 KB/s | 9 KB/s | ≈ 35 MB |
| 6v6 (11 guests) | 460 KB/s (3.7 Mbit/s) | 110 KB/s (0.9 Mbit/s) | ≈ 400 MB |

**With NPCs mixed in:** an NPC jet is still a jet, so the per-client numbers above don't change.
Fewer humans means fewer copies on the relay. 3 humans plus 9 NPCs in a 6v6 is 2 guests, so about
1/5 of the all-human relay traffic. One human against NPCs needs no network at all. NPCs cost CPU on
the host only, and that is microseconds per step.

### B. Only orders are sent (lockstep, optional later, §3)

An order is about 30 B binary (about 100 B JSON). Humans issue around 0.2 orders/s typically; the
client limits it to 5/s while dragging a heading. Add a 1 Hz world hash (8 B) for desync checks.

| Fight | Per client, worst | Per client, typical |
|---|---:|---:|
| 1v1 | 0.5 KB/s | ≈ 0.03 KB/s |
| 6v6 | 5.5 KB/s | ≈ 0.2 KB/s |

Plus an occasional full-state resync burst (≈ 15 KB) if a desync is detected.

---

## 3. Architecture

| Option | How | For | Against | Verdict |
|---|---|---|---|---|
| **Host-authoritative over a relay** | One player's browser runs the authoritative `World` (and all NPCs). Other players send orders and receive 10 Hz snapshots. Everyone connects outwards to a relay. | Correct whatever each browser's float math does. Server stays dumb. Reuses `GameSession` nearly as-is on the host. | Host has ~0 latency, guests 100–300 ms (irrelevant for orders measured in seconds). Host leaving ends the match (host migration possible later from full-state snapshots). | **Phase 5a** |
| **Lockstep over the same relay** | Everyone runs the sim; only orders are sent, each tagged with the tick to run on. A 1 Hz world hash catches drift; the host then sends a resync. | About 50× less traffic. The Cloudflare relay can hibernate between orders, so free-tier headroom grows a lot. | Needs our own deterministic `sin/cos/atan2/exp/log/pow` (port of fdlibm, a few hundred lines) and cross-browser testing; NPC state must be deterministic too. | **Phase 5b**, only if needed |
| Server runs the sim | The game loop runs inside the Durable Object or VM. | Hides fog of war; no host advantage. | CPU on the server, a 50 Hz loop keeps the object busy all match, more code exposed on the server. Anti-cheat isn't a goal. | Not planned |
| WebRTC peer-to-peer | Browsers connect directly; the relay only introduces them. | No relay bandwidth. | Shows each player's public IP to the others. About 10–20% of players (mobile, CGNAT, strict NAT) need a TURN server, which is exactly the "open tunnel" kind of service you want to avoid running. | Not planned; bandwidth isn't the constraint |
| Direct IP | One player runs a server at home; others connect to its IP. | No third party. | A browser page can't accept connections, so the host must run the Node relay and forward a port. An `https` game page may only open `wss://` with a valid certificate (mixed-content rule), so a bare home IP doesn't work without extra steps. CGNAT makes it impossible for many people. Shares a home IP. | Power-user fallback only (§4.3) |

The relay forwards opaque messages inside a room and never inspects the game payload, so **5a and 5b
use the same relay**. Switching later changes only the client.

---

## 4. Connectivity and hosting

### 4.1 The relay (same behaviour on every host)

- **Rooms:** the relay creates a 6-character room code from a secure random source. Join with the code; the first player is the host. Up to 12 players (plus a few spectators later).
- **Forwarding only:** host → everyone, guest → host. No outbound connections, no DNS lookups, no URLs from clients. It can't reach your network or the wider internet on anyone's behalf.
- **Privacy:** players only ever talk to the relay, so nobody sees another player's IP. No accounts, no stored chat or names, nothing kept after a room closes. Don't log IPs beyond the platform's own logs.
- **Limits (all in `shared/protocol.ts`):** up to 12 players per room; messages ≤ 16 KB from guests and ≤ 64 KB from the host (full-state resync); guests ≤ 20 messages/s and 16 KB/s, the host ≤ 60 messages/s and 128 KB/s (2 s bursts); a peer that breaks a limit is removed; first message within 5 s; a dropped player can resume for 60 s; a room closes after 10 minutes with nothing relayed or 3 hours in total; relay-wide caps on rooms (20), connections (200) and connections per address (8); 20 wrong room codes from one address in 10 minutes lock it out.
- **Envelope check:** messages must be JSON (or our binary format) with a known type field, or the connection is closed. This doesn't make tunnelling impossible, but makes it slow, small and awkward.
- **Origin allowlist** for the game's own site(s). It only stops other web pages from using the relay, not scripts, but costs nothing.
- **Kill switch:** an environment flag that makes the relay refuse all connections, plus the platform's own "delete deployment" command.

### 4.2 "Free tunnel" and wallet risk, per host

The worst a stranger can do with this relay: open a room, join it from two of their own machines and
pass messages at 64 KB/s between them. That gives them nothing they can't get from any chat service.
It doesn't bypass any firewall, because both ends already have to reach the relay. The real risks are
**cost** (someone pushes traffic through until you pay) and, on a VM, **the machine itself** being
broken into.

| Host | Cost | Capacity for this game | Can it bill you by surprise? | Ops work | Verdict |
|---|---|---|---|---|---|
| **Cloudflare Workers Free + Durable Objects** | $0 | Free plan: 100,000 requests/day and 13,000 GB-s of Durable Object time per day. Incoming WebSocket messages count 20:1 as requests; outgoing messages are free. Over a limit, calls fail until 00:00 UTC. Streaming at 10 Hz: about 1,800 requests and 450 GB-s per match-hour, so **≈ 28 match-hours per day** (time is the limit). Lockstep (5b) lets the object hibernate between orders: far more. | **No**, as long as the account stays on the Free plan with no payment method. Abuse can only use up the day's quota, which makes multiplayer unavailable until midnight UTC. | None: no OS, no patches, TLS included. | **Primary** |
| Cloudflare Workers Paid ($5/month) | $5 + usage | 1M requests and 400,000 GB-s per month included, then usage-billed. | Usage beyond the allowance is billed, but there are two separate account-wide **spending limits**, one for Workers and one for Durable Objects. Each blocks new usage once its threshold is reached. Set both before switching. Cloudflare says a limit "does not guarantee a maximum invoice amount" because enforcement lags a little. Add a WAF rate-limiting rule on the relay hostname too: requests blocked there never reach the Worker, so they aren't Worker requests. | None | Only if the free tier is outgrown; or keep the relay on its own free account |
| DigitalOcean droplet ($4–6/month) | $4–6 | 500 GB–1 TB/month included: about 1,300+ hours of typical 6v6. | Overage is about $0.01/GB, with alerts but no hard cap. Saturating 1 Gbit/s for a month would be tens of dollars per TB. **Mitigation in the Node relay:** a monthly egress budget that stops accepting rooms when reached, plus a global bandwidth cap. | You patch the OS, harden SSH and renew TLS. A neglected VM is the real "free tunnel" risk. | Fallback |
| Oracle Cloud Always Free | $0 | Plenty (generous egress). | Not while the account is Always Free only; upgrading to Pay As You Go removes that protection. | Same as any VM. Also, **idle Always Free instances are reclaimed** (95th-percentile CPU under ~20% over 7 days, per reports; the threshold has changed several times). An unused game relay would be reclaimed. Free-tier terms have changed before. | Not recommended |
| Self-host (home PC) + Tailscale | $0 | Small groups of friends. | No | Players install Tailscale; `tailscale serve` gives HTTPS on a `*.ts.net` name, which solves the mixed-content problem. No ports opened, no IPs shared beyond the tailnet. | Good private backup |
| Self-host + port forward (direct IP) | $0 | LAN or friends. | No | Needs a certificate (or players visiting `https://ip:port` once to accept a self-signed one). Exposes a home IP. Fails behind CGNAT. | Last resort; LAN is fine |

**Recommendation for your wallet:** deploy the relay as its **own Worker** (separate from the `acmi`
static site, so the viewer keeps its "no server code" promise) on a Cloudflare account that is on the
**Free plan with no card attached**. If your existing account has Workers Paid, use a second free
account for the relay. If nobody plays for 9 months it costs nothing, and if someone abuses it the
worst outcome is that multiplayer stops until midnight UTC.

### 4.3 Direct-IP fallback, done safely

The Node relay doubles as the self-host option: `node game/server/node/relay.ts` on the host's PC.
Over a LAN, open the game from a local `pnpm dev` and use `ws://`. Over the internet, prefer Tailscale
to port forwarding. The client keeps a "custom relay URL" field so any of these work without code
changes.

---

## 5. Server software layout

```
game/server/           its own pnpm workspace (24 h minimum package age), no dependencies
  shared/protocol.ts   message envelope, limits, input validation (relays and game client)
  shared/room.ts       room logic, transport-agnostic (Node and Cloudflare both drive it)
  node/                standalone relay: relay.ts, websocket.ts (built-in RFC 6455 server),
                       budget.ts (monthly egress cap), deploy/ (hardened systemd unit, Caddyfile)
  cloudflare/          Worker + Durable Object per room (WebSocket Hibernation API), own
                       wrangler.jsonc under a separate Worker name (planned)
```

**Status (2026-11-15):** `shared/` and `node/` are built and covered by `tests/relay.test.ts`. The
Node relay uses a small hand-written WebSocket server instead of the `ws` package, so it has nothing
to install; it accepts no extensions (no compression) and checks frame sizes before buffering.

---

## 6. Phases and effort (working days at this repo's pace)

### 5a: host-authoritative 1v1 and 2v2 (5–7 days)
1. **Sim:** readable PRNG state, `serializeWorld`/`loadWorld`/`hashWorld`, tests that a reloaded world steps identically. (0.5 day)
2. **Session split:** authority vs per-side view; player ↔ side ↔ owned jets; multiplayer time rules (no compression, pause limit, turn mode with ready). (1–2 days)
3. **Client networking:** binary snapshot encoder/decoder, 10 Hz send, interpolation, order envelope, latency display; lobby (create, join by code, choose side and jet, ready, rematch); reconnect within 60 s. (1.5–2.5 days)
4. **Relays:** ~~`shared/`, Node relay~~ (done), Cloudflare Durable Object relay, tests for every limit (size, rate, room lifetime, origin, bad envelope). (1–1.5 days)
5. **Deploy and docs:** relay README, free-plan deployment steps, kill switch. (0.5 day)
- **Done when:** a 2v2 with two humans and two NPCs plays across two networks through the Cloudflare relay, each side sees only its own fog of war, and the `.acmi` export works for both players.

### 5b (optional): lockstep (2–4 days)
Deterministic math module used by the whole sim, tick-tagged orders with a small input delay, 1 Hz
hash, resync on mismatch, cross-browser desync test (Chrome, Firefox, Safari). Do this only if the
free tier gets tight or 6v6 bandwidth matters.

### 5c: 6v6 and polish (2–3 days)
Lobby for 12 players, NPC fill for empty slots, spectators, host migration from full-state snapshots,
the datalink-shared picture between wingmen.

---

## 7. Decisions for you

1. **Hosting:** Cloudflare Free plan as primary, with the Node relay as self-host fallback (recommended), or start with the Node relay only.
2. **Account:** reuse the account that serves the viewer (only if it is on the Free plan) or open a separate free account for the relay.
3. **Multiplayer time mode to build first:** real time at 1× with limited pauses, or turn mode with a ready button (simplest and fairest).

Sources for the hosting limits (checked 2026-11-15; they change, so re-check before deploying):
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Durable Objects spending limits](https://developers.cloudflare.com/durable-objects/platform/spend-management/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm).
