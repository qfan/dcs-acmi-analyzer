/**
 * Build a compact, pre-extracted BVR analytics dataset JSON bundle from a folder of .acmi files.
 *
 * Usage:
 *   node scripts/build_bvr_dataset.ts <folder> [--min-mb 1] [--min-bvr 1] [--limit 50] [--out public/bvr-dataset.json]
 *
 * You can drop the resulting .json file directly onto http://localhost:5173/analytics.html
 * for instant multi-recording analysis across hundreds of sorties without re-parsing raw ACMIs.
 */
import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseAcmi } from "../src/acmi/parser.ts";
import { deduplicateFiles } from "../src/analytics/derive.ts";
import { serializeDatasetBundle } from "../src/analytics/export.ts";
import { extractFileAnalytics } from "../src/analytics/extract.ts";
import type { FileAnalytics } from "../src/analytics/model.ts";

const args = process.argv.slice(2);
const opt = (flag: string, def: string): string => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};

const dir = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--")) ?? ".";
const minMb = Number(opt("--min-mb", "1"));
const minBvr = Number(opt("--min-bvr", "1"));
const limit = Number(opt("--limit", "40"));
const outPath = opt("--out", "public/samples/bvr-sample-pack.json");
const anonymize = !args.includes("--no-redact");

const entries = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".acmi"))
  .map((e) => {
    const full = join(dir, e.name);
    const size = statSync(full).size;
    return { full, name: e.name, size };
  })
  .filter((f) => f.size >= minMb * 1e6)
  .sort((a, b) => b.size - a.size)
  .slice(0, limit);

console.log(
  `Scanning ${entries.length} .acmi files (>= ${minMb} MB) from ${dir} (keeping files with >= ${minBvr} BVR shots)...`,
);

const extracted: FileAnalytics[] = [];
for (let i = 0; i < entries.length; i++) {
  const f = entries[i]!;
  try {
    const stream = createReadStream(f.full, { highWaterMark: 1 << 20 });
    const rec = await parseAcmi(
      (async function* () {
        for await (const c of stream) yield new Uint8Array(c as Buffer);
      })(),
    );
    const fa = extractFileAnalytics(rec, f.name, f.size, undefined, `batch:${i}:${basename(f.name)}`);
    if (fa.meta.bvrShots >= minBvr) {
      extracted.push(fa);
      console.log(
        `  [+] ${f.name} (${(f.size / 1e6).toFixed(1)} MB, DCS ${fa.meta.dcsPatch ?? "?"}): ${fa.meta.bvrShots} BVR shots, ${fa.meta.a2aMissileShots} A2A missiles`,
      );
    } else {
      console.log(`  [-] ${f.name}: skipped (${fa.meta.bvrShots} BVR shots)`);
    }
  } catch (err) {
    console.warn(`  [!] ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const { unique } = deduplicateFiles(extracted);
const json = serializeDatasetBundle(unique, { anonymize });
writeFileSync(outPath, json);
console.log(
  `\nSaved ${unique.length} unique BVR recordings (${(json.length / 1e6).toFixed(2)} MB, anonymized=${anonymize}) to ${outPath}`,
);
