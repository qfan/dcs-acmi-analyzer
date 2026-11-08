import { readableToIterable } from "../acmi/container.ts";
import { parseAcmi } from "../acmi/parser.ts";
import { summarize } from "../acmi/summary.ts";
import { type Analysis, analyze } from "../analysis/analyze.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

// Minimal typing for the dedicated worker scope (avoids mixing the DOM and WebWorker libs).
const ctx = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

const PROGRESS_STEP = 1 << 20; // report about every 1 MB

ctx.onmessage = async (e) => {
  const req = e.data;
  if (req.kind !== "parse") return;
  const started = performance.now();
  const total = req.file.size;
  let lastReported = 0;
  try {
    const rec = await parseAcmi(readableToIterable(req.file.stream()), (rawBytes) => {
      if (rawBytes - lastReported >= PROGRESS_STEP || rawBytes === total) {
        lastReported = rawBytes;
        ctx.postMessage({ kind: "progress", rawBytes, totalBytes: total });
      }
    });
    let analysis: Analysis | null = null;
    let analysisError: string | null = null;
    try {
      analysis = analyze(rec);
    } catch (err) {
      analysisError = err instanceof Error ? err.message : String(err);
    }
    // The full Recording (with telemetry) stays in the worker; the UI gets a summary and the analysis.
    ctx.postMessage({
      kind: "done",
      summary: summarize(rec),
      analysis,
      analysisError,
      elapsedMs: performance.now() - started,
    });
  } catch (err) {
    ctx.postMessage({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
