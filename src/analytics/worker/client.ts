import type { FileAnalytics } from "../model.ts";
import type { AnalyticsWorkerRequest, AnalyticsWorkerResponse } from "./protocol.ts";

export interface BatchFileJob {
  fileId: string;
  fileName: string;
  file: Blob;
}

export interface BatchCallbacks {
  onFileProgress?: (fileId: string, fraction: number) => void;
  onFileDone?: (analytics: FileAnalytics) => void;
  onFileError?: (fileId: string, fileName: string, message: string) => void;
}

/**
 * Parse and extract analytics from multiple ACMI files in parallel using a bounded Web Worker pool.
 * Each worker parses one file at a time and releases its full Recording memory immediately after
 * extracting the compact `FileAnalytics` summary.
 */
export function extractFilesInPool(
  jobs: BatchFileJob[],
  callbacks: BatchCallbacks,
  maxWorkers = Math.min(4, typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4),
): { promise: Promise<void>; cancel: () => void } {
  if (jobs.length === 0) {
    return { promise: Promise.resolve(), cancel: () => {} };
  }

  let nextIdx = 0;
  let cancelled = false;
  const activeWorkers = new Set<Worker>();

  const promise = new Promise<void>((resolve) => {
    const workerCount = Math.max(1, Math.min(maxWorkers, jobs.length));
    let finishedWorkers = 0;

    for (let wIdx = 0; wIdx < workerCount; wIdx++) {
      const worker = new Worker(new URL("./analytics.worker.ts", import.meta.url), { type: "module" });
      activeWorkers.add(worker);

      const dispatchNext = () => {
        if (cancelled || nextIdx >= jobs.length) {
          worker.terminate();
          activeWorkers.delete(worker);
          finishedWorkers++;
          if (finishedWorkers === workerCount) resolve();
          return;
        }
        const job = jobs[nextIdx++]!;
        const req: AnalyticsWorkerRequest = {
          kind: "extract",
          fileId: job.fileId,
          fileName: job.fileName,
          file: job.file,
        };
        worker.postMessage(req);
      };

      worker.onmessage = (e: MessageEvent<AnalyticsWorkerResponse>) => {
        if (cancelled) return;
        const msg = e.data;
        if (msg.kind === "progress") {
          const frac = msg.totalBytes > 0 ? msg.rawBytes / msg.totalBytes : 0;
          callbacks.onFileProgress?.(msg.fileId, frac);
        } else if (msg.kind === "done") {
          callbacks.onFileDone?.(msg.analytics);
          dispatchNext();
        } else if (msg.kind === "error") {
          callbacks.onFileError?.(msg.fileId, msg.fileName, msg.message);
          dispatchNext();
        }
      };

      worker.onerror = (e) => {
        if (cancelled) return;
        callbacks.onFileError?.("unknown", "Worker", e.message || "Worker failed");
        dispatchNext();
      };

      dispatchNext();
    }
  });

  const cancel = () => {
    cancelled = true;
    for (const w of activeWorkers) w.terminate();
    activeWorkers.clear();
  };

  return { promise, cancel };
}
