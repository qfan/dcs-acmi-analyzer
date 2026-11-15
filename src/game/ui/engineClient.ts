/** The UI's handle on the engine worker: send messages, subscribe to what it posts. */
import type { FromEngine, ToEngine } from "../engine/protocol.ts";

export interface EngineClient {
  send(m: ToEngine): void;
  subscribe(fn: (m: FromEngine) => void): () => void;
  dispose(): void;
}

export function createEngineClient(): EngineClient {
  const worker = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
  const subs = new Set<(m: FromEngine) => void>();
  worker.onmessage = (e: MessageEvent<FromEngine>) => {
    for (const fn of subs) fn(e.data);
  };
  worker.onerror = (e) => console.error("engine worker error", e.message);
  return {
    send: (m) => worker.postMessage(m),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    dispose: () => worker.terminate(),
  };
}
