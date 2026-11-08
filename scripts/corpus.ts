/**
 * Corpus runner: parse every .acmi file under a folder and report crashes, warnings and format statistics.
 *
 *   node scripts/corpus.ts <folder> [--jobs 4] [--limit N] [--every K] [--out report-dir]
 *
 * --every K parses every K-th file (sorted by path) for a quick spread sample.
 * Writes <out>/results.jsonl (one line per file) and <out>/summary.json, and prints a summary.
 */
import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { parseAcmi } from "../src/acmi/parser.ts";

export interface FileResult {
  path: string;
  size: number;
  ok: boolean;
  error?: string;
  ms: number;
  textBytes?: number;
  recorder?: string;
  source?: string;
  fileVersion?: string | null;
  container?: string;
  timeEnd?: number;
  frames?: number;
  framesBackwards?: number;
  objects?: number;
  removals?: number;
  idReuses?: number;
  idReuseGaps?: Record<string, number>;
  idReusesSameIdentity?: number;
  incompleteZip?: boolean;
  objectsMixingTForms?: number;
  tComponentCounts?: Record<number, number>;
  warningCounts?: Record<string, number>;
  unknownProps?: Record<string, number>;
  eventTypes?: Record<string, number>;
  textPropsSeen?: string[];
  truncated?: boolean;
  firstWarnings?: string[];
}

const INTERESTING_TEXT = [
  "Parent",
  "Next",
  "LockedTarget",
  "FocusedTarget",
  "CallSign",
  "Registration",
  "Label",
];

async function parseOne(path: string): Promise<FileResult> {
  const size = statSync(path).size;
  const t0 = performance.now();
  try {
    const stream = createReadStream(path, { highWaterMark: 1 << 20 });
    const iter = (async function* () {
      for await (const c of stream) yield new Uint8Array(c as Buffer);
    })();
    const r = await parseAcmi(iter);
    const eventTypes: Record<string, number> = {};
    for (const e of r.events) eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
    const textPropsSeen = new Set<string>();
    for (const o of r.objects)
      for (const k of Object.keys(o.text))
        if (INTERESTING_TEXT.some((p) => k.startsWith(p))) textPropsSeen.add(k);
    return {
      path,
      size,
      ok: true,
      ms: performance.now() - t0,
      textBytes: r.stats.textBytes,
      recorder: r.globals.DataRecorder,
      source: r.globals.DataSource,
      fileVersion: r.fileVersion,
      container: r.container.kind,
      timeEnd: r.timeEnd,
      frames: r.stats.frames,
      framesBackwards: r.stats.framesBackwards,
      objects: r.objects.length,
      removals: r.stats.removals,
      idReuses: r.stats.idReuses,
      idReuseGaps: r.stats.idReuseGaps,
      idReusesSameIdentity: r.stats.idReusesSameIdentity,
      incompleteZip: r.container.incomplete ?? false,
      objectsMixingTForms: r.stats.objectsMixingTForms,
      tComponentCounts: r.stats.tComponentCounts,
      warningCounts: r.warningCounts as Record<string, number>,
      unknownProps: r.stats.unknownProps,
      eventTypes,
      textPropsSeen: [...textPropsSeen],
      truncated: r.truncated,
      firstWarnings: r.warnings.slice(0, 5).map((w) => `${w.kind} @${w.lineNo}: ${w.message}`),
    };
  } catch (err) {
    return {
      path,
      size,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: performance.now() - t0,
    };
  }
}

function listAcmi(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".acmi")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function add(into: Record<string, number>, from: Record<string, number> | undefined) {
  if (!from) return;
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/corpus.ts <folder> [--jobs N] [--limit N] [--every K] [--out dir]");
    process.exit(2);
  }
  const jobs = Number(opt("--jobs") ?? Math.max(1, Math.min(6, availableParallelism() - 2)));
  const every = Number(opt("--every") ?? 1);
  const limit = Number(opt("--limit") ?? Number.POSITIVE_INFINITY);
  const outDir = opt("--out") ?? "corpus-report";
  mkdirSync(outDir, { recursive: true });

  const files = listAcmi(dir)
    .filter((_, i) => i % every === 0)
    .slice(0, limit);
  const totalBytes = files.reduce((s, f) => s + statSync(f).size, 0);
  console.log(`${files.length} files, ${(totalBytes / 1e9).toFixed(2)} GB, ${jobs} workers`);

  const results: FileResult[] = [];
  let next = 0;
  let doneBytes = 0;
  const t0 = performance.now();
  const workers = Array.from({ length: Math.min(jobs, files.length) }, () => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { worker: true },
      resourceLimits: { maxOldGenerationSizeMb: 6144 },
    });
    return new Promise<void>((resolve) => {
      const feed = () => {
        if (next >= files.length) {
          w.terminate().then(() => resolve());
          return;
        }
        w.postMessage(files[next++]);
      };
      w.on("message", (res: FileResult) => {
        results.push(res);
        doneBytes += res.size;
        if (results.length % 100 === 0 || results.length === files.length) {
          const s = (performance.now() - t0) / 1000;
          console.log(
            `  ${results.length}/${files.length} files, ${(doneBytes / 1e6).toFixed(0)} MB, ${s.toFixed(0)} s, ${results.filter((r) => !r.ok).length} failed`,
          );
        }
        feed();
      });
      w.on("error", (err) => {
        // A worker crash (e.g. out of memory) loses the file it was on; record it and keep going.
        results.push({ path: "(worker crash)", size: 0, ok: false, error: String(err), ms: 0 });
        resolve();
      });
      feed();
    });
  });
  await Promise.all(workers);

  results.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(join(outDir, "results.jsonl"), `${results.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const errors: Record<string, number> = {};
  for (const f of failed) errors[f.error ?? "?"] = (errors[f.error ?? "?"] ?? 0) + 1;
  const sum = {
    files: results.length,
    ok: ok.length,
    failed: failed.length,
    errors,
    seconds: (performance.now() - t0) / 1000,
    rawGB: totalBytes / 1e9,
    textGB: ok.reduce((s, r) => s + (r.textBytes ?? 0), 0) / 1e9,
    truncated: ok.filter((r) => r.truncated).length,
    fileVersions: {} as Record<string, number>,
    containers: {} as Record<string, number>,
    recorders: {} as Record<string, number>,
    tComponentCounts: {} as Record<string, number>,
    warningCounts: {} as Record<string, number>,
    filesWithWarningKind: {} as Record<string, number>,
    unknownProps: {} as Record<string, number>,
    eventTypes: {} as Record<string, number>,
    filesWithTextProp: {} as Record<string, number>,
    filesWithIdReuse: ok.filter((r) => (r.idReuses ?? 0) > 0).length,
    idReusesTotal: ok.reduce((s, r) => s + (r.idReuses ?? 0), 0),
    idReusesSameIdentity: ok.reduce((s, r) => s + (r.idReusesSameIdentity ?? 0), 0),
    idReuseGaps: {} as Record<string, number>,
    incompleteZips: ok.filter((r) => r.incompleteZip).length,
    filesWithBackwardsFrames: ok.filter((r) => (r.framesBackwards ?? 0) > 0).length,
    filesMixingTForms: ok.filter((r) => (r.objectsMixingTForms ?? 0) > 0).length,
    slowest: [...ok]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((r) => ({
        path: r.path,
        MB: +(r.size / 1e6).toFixed(1),
        textMB: +((r.textBytes ?? 0) / 1e6).toFixed(0),
        ms: Math.round(r.ms),
      })),
  };
  for (const r of ok) {
    const v = r.fileVersion ?? "(none)";
    sum.fileVersions[v] = (sum.fileVersions[v] ?? 0) + 1;
    sum.containers[r.container ?? "?"] = (sum.containers[r.container ?? "?"] ?? 0) + 1;
    const rec = (r.recorder ?? "(none)").replace(/ [\d.]+$/, "");
    sum.recorders[rec] = (sum.recorders[rec] ?? 0) + 1;
    add(sum.tComponentCounts, r.tComponentCounts as Record<string, number>);
    add(sum.warningCounts, r.warningCounts);
    for (const k of Object.keys(r.warningCounts ?? {}))
      sum.filesWithWarningKind[k] = (sum.filesWithWarningKind[k] ?? 0) + 1;
    add(sum.unknownProps, r.unknownProps);
    add(sum.idReuseGaps, r.idReuseGaps);
    add(sum.eventTypes, r.eventTypes);
    for (const k of r.textPropsSeen ?? []) sum.filesWithTextProp[k] = (sum.filesWithTextProp[k] ?? 0) + 1;
  }
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(sum, null, 2));
  console.log(JSON.stringify(sum, null, 2));
}

if (isMainThread) {
  await main();
} else if (workerData?.worker) {
  parentPort?.on("message", async (path: string) => {
    parentPort?.postMessage(await parseOne(path));
  });
}
