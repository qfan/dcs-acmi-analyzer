import type { FileAnalytics } from "../model.ts";

export interface AnalyticsWorkerRequest {
  kind: "extract";
  fileId: string;
  fileName: string;
  file: Blob;
}

export type AnalyticsWorkerResponse =
  | { kind: "progress"; fileId: string; rawBytes: number; totalBytes: number }
  | { kind: "done"; fileId: string; analytics: FileAnalytics }
  | { kind: "error"; fileId: string; fileName: string; message: string };
