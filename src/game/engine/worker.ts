/// <reference lib="webworker" />
/** Engine worker entry: the fight and the relay connection run here, off the UI thread. */
import { Engine } from "./engine.ts";
import type { FromEngine, ToEngine } from "./protocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const engine = new Engine((m: FromEngine) => scope.postMessage(m));
scope.onmessage = (e: MessageEvent<ToEngine>) => engine.handle(e.data);
