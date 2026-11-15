/**
 * RoomCounter: one Durable Object for the whole relay that counts open rooms, so the relay can cap
 * them (and `/healthz` can say "busy"). Each room registers with its latest possible end time, so a
 * room that vanishes without saying goodbye stops counting by itself.
 */
import type { DurableObjectState, Env } from "./cf.ts";

const PREFIX = "r:";

export class RoomCounter {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
  }

  /** Rooms still open, dropping any whose time is up. */
  private async live(now: number): Promise<number> {
    const all = await this.ctx.storage.list<number>({ prefix: PREFIX });
    let n = 0;
    for (const [key, until] of all) {
      if (until <= now) await this.ctx.storage.delete(key);
      else n++;
    }
    return n;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    const code = url.searchParams.get("code") ?? "";
    switch (url.pathname) {
      case "/count":
        return Response.json({ rooms: await this.live(now) });
      case "/open": {
        const max = Number(url.searchParams.get("max") ?? "20");
        const until = Number(url.searchParams.get("until") ?? "0");
        if (!code || !(until > now)) return new Response("bad request", { status: 400 });
        if ((await this.live(now)) >= max) return Response.json({ ok: false });
        await this.ctx.storage.put(PREFIX + code, until);
        return Response.json({ ok: true });
      }
      case "/close":
        if (code) await this.ctx.storage.delete(PREFIX + code);
        return Response.json({ ok: true });
      default:
        return new Response("not found", { status: 404 });
    }
  }
}
