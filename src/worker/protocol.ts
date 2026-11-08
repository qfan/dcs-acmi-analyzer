import type { RecordingSummary } from "../acmi/summary.ts";

export type WorkerRequest = { kind: "parse"; file: Blob; name: string };

export type WorkerResponse =
  | { kind: "progress"; rawBytes: number; totalBytes: number }
  | { kind: "done"; summary: RecordingSummary; elapsedMs: number }
  | { kind: "error"; message: string };
