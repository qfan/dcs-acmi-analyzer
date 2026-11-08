import { readableToIterable } from "../../acmi/container.ts";
import { parseAcmi } from "../../acmi/parser.ts";
import { extractFileAnalytics } from "../extract.ts";
import type { AnalyticsWorkerRequest, AnalyticsWorkerResponse } from "./protocol.ts";

const ctx = self as unknown as {
  postMessage(msg: AnalyticsWorkerResponse): void;
  onmessage: ((e: MessageEvent<AnalyticsWorkerRequest>) => void) | null;
};

const PROGRESS_STEP = 1 << 20; // report roughly every 1 MB

ctx.onmessage = async (e) => {
  const req = e.data;
  if (req.kind !== "extract") return;
  const total = req.file.size;
  let lastReported = 0;
  try {
    const rec = await parseAcmi(readableToIterable(req.file.stream()), (rawBytes) => {
      if (rawBytes - lastReported >= PROGRESS_STEP || rawBytes === total) {
        lastReported = rawBytes;
        ctx.postMessage({
          kind: "progress",
          fileId: req.fileId,
          rawBytes,
          totalBytes: total,
        });
      }
    });
    const analytics = extractFileAnalytics(rec, req.fileName, total, undefined, req.fileId);
    ctx.postMessage({ kind: "done", fileId: req.fileId, analytics });
  } catch (err) {
    ctx.postMessage({
      kind: "error",
      fileId: req.fileId,
      fileName: req.fileName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
