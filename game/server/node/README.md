# Node relay

The standalone multiplayer relay. It needs Node.js 24 or newer and has **no npm dependencies**: the
WebSocket server is a small built-in implementation (`websocket.ts`), so there is nothing to install
or audit beyond Node itself. The room logic is shared with the Cloudflare relay (`../shared/`).

```bash
node game/server/node/relay.ts
```

It listens on `127.0.0.1:8787` by default. `GET /healthz` returns `ok`, `busy` (room or connection cap reached) or `disabled`, readable by the allowed pages (CORS) so the game can pick a working relay; the
WebSocket endpoint is `/ws`, and everything else is a 404.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` for LAN play without a proxy. |
| `RELAY_PORT` | `8787` | Port. |
| `RELAY_ALLOWED_ORIGINS` | `https://acmi.qfan.ca`, `http://localhost:*`, `http://127.0.0.1:*` | Comma-separated pages allowed to connect; `:*` matches any port, `*` allows any page. |
| `RELAY_ALLOW_NO_ORIGIN` | `0` | `1` accepts clients that send no Origin (scripts, tests). |
| `RELAY_MAX_ROOMS` | `20` | Rooms open at once. |
| `RELAY_MAX_CONNECTIONS` | `200` | Connections at once. |
| `RELAY_MAX_PER_IP` | `8` | Connections at once from one address. |
| `RELAY_TRUST_PROXY` | `0` | `1` reads the client address from `X-Forwarded-For` (only behind your own proxy, such as Caddy). |
| `RELAY_MONTHLY_EGRESS_GB` | `200` | Monthly outgoing-data budget; when spent, the relay closes all rooms and refuses connections until the next calendar month (UTC). `0` disables it. |
| `RELAY_STATE_DIR` | `relay-state` (or systemd's `STATE_DIRECTORY`) | Where the egress counter is saved. |
| `RELAY_ENABLED` | `1` | Kill switch: `0` refuses everything. |

Per-room limits (players, message sizes, rates, timeouts) are in `../shared/protocol.ts`.

## Ways to run it

**LAN.** `RELAY_HOST=0.0.0.0 node game/server/node/relay.ts`, run the game with `pnpm dev --host`,
and add the page's LAN address to `RELAY_ALLOWED_ORIGINS`. Plain `ws://` works because the page is
`http://` too.

**Friends over the internet, from your PC: Tailscale.** Everyone joins your tailnet; run the relay on
localhost and `tailscale serve` it, which gives an `https://<machine>.<tailnet>.ts.net` address with a
valid certificate. No router ports are opened and your IP isn't shared outside the tailnet.

**Direct IP (last resort).** Forward a port to `RELAY_HOST=0.0.0.0`. The game page at
`https://acmi.qfan.ca` can only open `wss://` with a valid certificate, so this needs a DNS name and a
certificate (put Caddy in front), and it reveals your home IP to everyone you give the address to.

**Small VM (DigitalOcean, Linode, Oracle).** Recommended layout, using the files in `deploy/`:

1. Ubuntu/Debian LTS, SSH keys only (`PasswordAuthentication no`), `unattended-upgrades` on,
   firewall open for 22, 80 and 443 only (`ufw allow OpenSSH; ufw allow 80,443/tcp; ufw enable`).
2. Node.js 24+ from nodejs.org: download the Linux tarball and `SHASUMS256.txt.asc`, check the
   signature against the Node release keys and the tarball's hash, then unpack to `/usr/local`.
   (Distribution packages are usually too old.)
3. Copy `game/server/` to `/opt/bvr-relay` (owned by root, read-only to others).
4. Install Caddy from its official repository, set `deploy/Caddyfile` with your DNS name.
5. Install `deploy/bvr-relay.service`. It runs as a throwaway user, can write only its state
   directory, and the kernel only lets it talk to localhost, so even a compromised relay can't reach
   the internet or your network.
6. Set the provider's billing alert, and set `RELAY_MONTHLY_EGRESS_GB` well under the plan's
   included transfer (for example 200 GB on a 500 GB plan).

Notes: Oracle's Always Free tier reclaims instances it considers idle, which an unused relay would
be. Check `/healthz` from outside after deploying, and see `journalctl -u bvr-relay` for room
open/close lines (the relay logs no IP addresses or player names).

## Tests

`pnpm test` in the repo root runs `tests/relay.test.ts`, which starts real relays on random ports
and covers forwarding, origins, room codes, size and rate limits, oversized frames, resume, timeouts,
the room cap, the egress budget, the kill switch and the per-address limit.
