import { fileCacheKey, getCachedAnalytics, putCachedAnalytics } from "../cache.ts";
import type { FileAnalytics } from "../model.ts";
import type { AnalyticsWorkerRequest, AnalyticsWorkerResponse } from "./protocol.ts";

export interface BatchFileJob {
  fileId: string;
  fileName: string;
  file: Blob & { lastModified?: number };
}

export interface BatchCallbacks {
  onFileProgress?: (fileId: string, fraction: number) => void;
  onFileDone?: (analytics: FileAnalytics) => void;
  onFileError?: (fileId: string, fileName: string, message: string) => void;
}

/**
 * Compute optimal worker pool size: use all logical CPU cores minus 2 reserved
 * for the main GUI thread and browser compositor (minimum 2 workers).
 */
export function defaultWorkerCount(): number {
  const cores =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 8;
  return Math.max(2, cores - 2);
}

/**
 * Parse and extract analytics from multiple ACMI files in parallel using a bounded Web Worker pool.
 * - Schedules jobs largest-file-first (Longest Processing Time first) so multi-file batches don't
 *   get bottlenecked by a single huge recording started at the tail end of the queue.
 * - Each worker parses one file at a time and releases its full Recording memory immediately after
 *   extracting the compact `FileAnalytics` summary.
 */
export function extractFilesInPool(
  jobs: BatchFileJob[],
  callbacks: BatchCallbacks,
  maxWorkers = defaultWorkerCount(),
): { promise: Promise<void>; cancel: () => void; workerCount: number } {
  if (jobs.length === 0) {
    return { promise: Promise.resolve(), cancel: () => {}, workerCount: 0 };
  }

  // Sort jobs largest-first (LPT scheduling) to maximize multi-core utilization across variable-size files
  const sortedJobs = [...jobs].sort((a, b) => (b.file.size ?? 0) - (a.file.size ?? 0));

  let nextIdx = 0;
  let cancelled = false;
  const activeWorkers = new Set<Worker>();
  const workerCount = Math.max(1, Math.min(maxWorkers, sortedJobs.length));

  const promise = new Promise<void>((resolve) => {
    let finishedWorkers = 0;

    for (let wIdx = 0; wIdx < workerCount; wIdx++) {
      const worker = new Worker(new URL("./analytics.worker.ts", import.meta.url), { type: "module" });
      activeWorkers.add(worker);

      let currentJob: BatchFileJob | null = null;

      const dispatchNext = () => {
        if (cancelled || nextIdx >= sortedJobs.length) {
          worker.terminate();
          activeWorkers.delete(worker);
          finishedWorkers++;
          if (finishedWorkers === workerCount) resolve();
          return;
        }
        const job = sortedJobs[nextIdx++]!;
        currentJob = job;
        const cKey = fileCacheKey({
          name: job.fileName,
          size: job.file.size,
          lastModified: job.file.lastModified,
        });
        void getCachedAnalytics(cKey).then((cached) => {
          if (cancelled) return;
          if (cached) {
            const hydrated: FileAnalytics =
              cached.fileId === job.fileId
                ? cached
                : {
                    ...cached,
                    fileId: job.fileId,
                    engagements: cached.engagements.map((e, i) => ({
                      ...e,
                      id: `${job.fileId}:${i}`,
                      fileId: job.fileId,
                    })),
                  };
            callbacks.onFileDone?.(hydrated);
            dispatchNext();
            return;
          }
          const req: AnalyticsWorkerRequest = {
            kind: "extract",
            fileId: job.fileId,
            fileName: job.fileName,
            file: job.file,
          };
          worker.postMessage(req);
        });
      };

      worker.onmessage = (e: MessageEvent<AnalyticsWorkerResponse>) => {
        if (cancelled) return;
        const msg = e.data;
        if (msg.kind === "progress") {
          const frac = msg.totalBytes > 0 ? msg.rawBytes / msg.totalBytes : 0;
          callbacks.onFileProgress?.(msg.fileId, frac);
        } else if (msg.kind === "done") {
          if (currentJob) {
            const cKey = fileCacheKey({
              name: currentJob.fileName,
              size: currentJob.file.size,
              lastModified: currentJob.file.lastModified,
            });
            void putCachedAnalytics(cKey, msg.analytics);
          }
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

  return { promise, cancel, workerCount };
}
