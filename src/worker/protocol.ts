import type { RecordingSummary } from "../acmi/summary.ts";
import type { Analysis } from "../analysis/analyze.ts";

export type WorkerRequest = { kind: "parse"; file: Blob; name: string };

export type WorkerResponse =
  | { kind: "progress"; rawBytes: number; totalBytes: number }
  | {
      kind: "done";
      summary: RecordingSummary;
      /** Null if the analysis step failed; analysisError then says why. */
      analysis: Analysis | null;
      analysisError: string | null;
      elapsedMs: number;
    }
  | { kind: "error"; message: string };
