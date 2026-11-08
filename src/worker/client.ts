import type { RecordingSummary } from "../acmi/summary.ts";
import type { Analysis } from "../analysis/analyze.ts";
import type { MapData } from "../map/mapData.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

export interface ParseOutcome {
  summary: RecordingSummary;
  analysis: Analysis | null;
  analysisError: string | null;
  map: MapData | null;
  elapsedMs: number;
}

/** Parse a file in a fresh worker. Each file gets its own worker, terminated when finished. */
export function parseInWorker(
  file: Blob,
  name: string,
  onProgress: (fraction: number) => void,
): { promise: Promise<ParseOutcome>; cancel: () => void } {
  const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
  const promise = new Promise<ParseOutcome>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.kind === "progress") onProgress(msg.totalBytes ? msg.rawBytes / msg.totalBytes : 0);
      else if (msg.kind === "done") {
        worker.terminate();
        resolve({
          summary: msg.summary,
          analysis: msg.analysis,
          analysisError: msg.analysisError,
          map: msg.map,
          elapsedMs: msg.elapsedMs,
        });
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Worker failed"));
    };
  });
  const req: WorkerRequest = { kind: "parse", file, name };
  worker.postMessage(req);
  return { promise, cancel: () => worker.terminate() };
}
