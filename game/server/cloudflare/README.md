# Cloudflare relay (planned)

A Worker plus one Durable Object per room, using the WebSocket Hibernation API. Deployed as its own
Worker with its own `wrangler.jsonc`, separate from the `acmi` static site.

Deploy it on an account on the **Workers Free plan with no payment method**. Over the free limits,
requests fail until 00:00 UTC; nothing is billed. See
[MULTIPLAYER_PLAN.md](../../../MULTIPLAYER_PLAN.md) §4.
