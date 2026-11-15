# Cloudflare relay

The multiplayer relay as a Cloudflare Worker with one Durable Object per room. It speaks the same
protocol as the Node relay and uses the same room rules (`../shared/`), so the game treats both
the same way. It is its own Worker (`bvr-mini-game-server-cf`), separate from the `acmi` viewer site.

| Path | What |
|---|---|
| `GET /healthz` | `ok`, `busy` (room cap reached) or `disabled`; readable by the allowed pages (CORS) |
| `GET /ws` (WebSocket) | open a new room; the Worker picks its code |
| `GET /ws?room=CODE` (WebSocket) | join a room, or resume a seat after a dropped connection |

How it works:

- **`src/worker.ts`** checks the page's Origin, then hands the connection to the room's Durable
  Object (`idFromName(code)`). Refused requests never reach a Durable Object.
- **`src/room.ts` (`RelayRoom`)** holds the room's WebSockets with the **Hibernation API**: while
  nobody sends anything (a lobby waiting for players), Cloudflare can drop the object from memory
  and keep the sockets open, and it isn't billed for that time. The room is saved to the object's
  storage when someone joins, leaves or drops, and rebuilt from that plus the open sockets on
  wake-up. Timeouts (a dropped player's 60 s, idle rooms, the 3-hour limit) run on the object's
  alarm.
- **`src/counter.ts` (`RoomCounter`)** is one object for the whole relay that counts open rooms, so
  `MAX_ROOMS` caps them. Each room registers with its latest possible end, so a room that vanishes
  stops counting by itself.

## Cost and safety

- Deploy it on an account on the **Workers Free plan with no payment method**. Past the free daily
  limits, requests simply fail until 00:00 UTC; nothing is billed.
- If the account ever moves to Workers Paid: set **both** spending limits (Workers, and Durable
  Objects) before anything else.
- Add one **WAF rate-limiting rule** (the Free plan includes one) on the relay's hostname, for
  example: path starts with `/ws` or equals `/healthz`, more than 30 requests in 10 seconds from one
  IP, block for 1 minute. Requests it blocks never reach the Worker. The Node relay's per-address
  connection cap and wrong-code lockout aren't in the Worker; this rule takes their place.
- The relay makes no outbound requests except to its own room counter, logs nothing itself, and
  never tells players each other's addresses. Cloudflare keeps its own request logs.
- Cloudflare doesn't bill outgoing data, so there is no monthly data budget here (the Node relay
  has one for VMs).

## Run it locally

```bash
cd game/server/cloudflare
pnpm install --frozen-lockfile
pnpm dev
```

That serves `ws://localhost:8788/ws` on Cloudflare's runtime (workerd). In the game, pick
**Server → Custom address…** and enter it.

## Deploy

The `qfan.ca` zone must be on the same Cloudflare account as this Worker for the custom domain
in `wrangler.jsonc` (`bvr-mini-game-server-cf.qfan.ca`) to work.

```bash
cd game/server/cloudflare
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm run check
pnpm run deploy
```

`check` bundles without uploading. The first deploy creates both Durable Object classes (migration
`v1`, SQLite-backed: the Free plan's kind). Afterwards, check from outside:

```bash
curl https://bvr-mini-game-server-cf.qfan.ca/healthz
```

**Automatic deploys** (optional): in the dashboard, create a Worker from this repository with
root directory `game/server/cloudflare`, build command `pnpm install --frozen-lockfile`, deploy
command `pnpm run deploy`, and build watch paths `game/server/**`. Add `game/server/**` to the
viewer Worker's excluded watch paths so each only rebuilds for its own changes.

**Kill switch:** set the variable `RELAY_ENABLED` to `0` (dashboard: the Worker's Settings →
Variables, or edit `wrangler.jsonc` and deploy) and every connection is refused. `pnpm exec
wrangler delete` removes the Worker entirely.

## Dependencies

Only `wrangler` (bundling, local runtime, deploy), pinned to an exact version and installed with
pnpm under this folder's `pnpm-workspace.yaml`: no package version younger than 24 hours, no
install scripts. The install scripts of `esbuild` and `workerd` are left blocked; both get their
binaries from their platform packages, and `pnpm run check` and `pnpm dev` work without them. Wrangler's
usage telemetry is off for this project (`send_metrics` in `wrangler.jsonc`).

## Tests

`pnpm test` at the repo root runs `tests/cfRelay.test.ts`: the Worker's routing and origin
checks, and the room object against a fake Durable Objects runtime, including waking up from
hibernation, resume, timeouts and the room cap.
