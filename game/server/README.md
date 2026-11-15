# Multiplayer relay servers

See [MULTIPLAYER_PLAN.md](../../MULTIPLAYER_PLAN.md) for the design.

The relay connects players' browsers in rooms and forwards messages between them. It runs no game
logic: one player's browser (the host) runs the fight. The relay never makes outbound connections and
never tells players each other's IP addresses.

| Folder | What | Status |
|---|---|---|
| [`shared/`](shared/) | `protocol.ts` (message envelope and limits) and `room.ts` (room logic), used by every relay and later the game client | done |
| [`node/`](node/) | Standalone Node.js relay with no dependencies: self-host, LAN, Tailscale, or a small VM | done, tested |
| [`cloudflare/`](cloudflare/) | Cloudflare Worker, one Durable Object per room (Hibernation API); Workers Free plan | done, tested locally; not deployed |

This folder is its own pnpm workspace (`package.json`, `pnpm-workspace.yaml` with a 24-hour minimum
package age), separate from the viewer, with no dependencies. `cloudflare/` is another, whose only
dependency is `wrangler`. It is deployed separately from
the viewer site (`wrangler.jsonc` at the repo root), so the viewer stays a static site with no server
code. `pnpm typecheck` and `pnpm test` in the repo root cover it.

## Protocol summary

Text frames are JSON. Clients send `create`, `join {room}`, `resume {room, token}`, `send {to?, d}`
and `leave`. The relay sends `welcome`, `peer-joined/away/back/left`, `msg {from, d}` and `error`.
Guests' messages always go to the host; the host sends to one peer or everyone. Binary frames carry
the peer id in byte 0. Details and limits are in [`shared/protocol.ts`](shared/protocol.ts).
