# Tacview ACMI Web Viewer — Plan

A browser-only viewer for Tacview `.acmi` recordings. You drag a file onto the page, and it is
parsed and analysed locally, with nothing uploaded. Version 1 focuses on *analysis*: mission info,
participants, shots, and a kill log ("who killed whom, with what, when"). A map or 3D view comes later.

This is a clean-room implementation built from the public ACMI 2.2 spec and from inspecting real
recordings. The Tacview executable is not reverse-engineered.

---

## 1. What the sample data shows (survey of `T:\`, 2026-11-08)

- **7,231 `.acmi` files**: 7,160 DCS, 52 X-Plane, 8 MSFS, 5 FSX, plus a few others. Sizes range from 3 KB to 87 MB (zipped).
- **7,204 are `*.zip.acmi`** (a zip holding a single `*.txt.acmi` entry). 14 are `*.txt.acmi` (plain text). 24 are empty (0 bytes).
- A random sample of 111 files across every year and simulator showed:
  - Every file is `FileVersion=2.2`.
  - Recorders: `DCS2ACMI 1.8.0 … 1.9.4`, `XPL2ACMI`, `FSX2ACMI`, `Tacview 1.8.8`.
  - **No file contains `Event=`, `Parent=` or `LockedTarget=`.** The spec defines all three, but these recorders never write them.
- The plain `.txt.acmi` files are sizes like 16384 or 65536 bytes and **end mid-line**. They are unfinished
  recordings left behind when the game exited. The parser must accept a cut-off final line.
- **Ground truth is available:** `T:\old\Tacview-20240409-235741-DCS-prep-for-2024-04-part3.zip.acmi`
  comes with a `.csv`/`.xml`/`.xlsx` event log exported by Tacview itself (122 HasFired, 44 HasBeenHitBy,
  78 HasBeenDestroyed). We can score our kill inference against it automatically.
  More of these can be exported from Tacview.exe for other recordings to widen the test set.

## 2. Format notes: official spec vs. real files

Reference: https://raia-software-inc.gitbook.io/tacview/technical-documentation/acmi-telemetry-file-format

These points are in the spec and the real files follow them:
UTF-8 with BOM; the `FileType`/`FileVersion` header; `#<seconds>` frames relative to `ReferenceTime`;
object IDs are **64-bit hexadecimal** (`3000a01`, `40000001`), so store them as strings or BigInt, never as JS numbers;
`-<id>` removes an object; properties persist until changed; `\,` escapes a comma; `T=` has 3, 5, 6 or 9 components,
and an empty component means "unchanged"; longitude and latitude are offsets from `ReferenceLongitude`/`ReferenceLatitude`;
`Type` is a `+`-joined tag list.

Places where the files go beyond the spec or contradict it. The parser must handle all of these:

| # | Observation | Spec says |
|---|---|---|
| 1 | Text values continue onto the next line when a line ends with `\`. Seen in multi-paragraph `Comments=`. | Not mentioned |
| 2 | DCS2ACMI **mixes `T=` forms on the same object**: a 9-component aircraft sometimes gets 5-component updates (`lon\|lat\|alt\|u\|v`), and its rotation must be kept. | "Keep the same notation for an object's lifetime" |
| 3 | `0,AuthenticationKey=…` appears several times mid-file. `PlaybackKey`, `PlaybackDelay`, `AOAUnits` also appear. | Not listed. Store unknown properties as raw values. |
| 4 | `Name=` holds DCS internal type names (`FA-18C_hornet`, `AIM_120C`, `weapons.shells.M61_20_PGU28`). | "ICAO/NATO designator". Display names need our own mapping table later. |
| 5 | No `Event`/`Parent`/`LockedTarget`, so shooters and kills must be **inferred**. | Defines them. Still support them for recorders that do write them. |
| 6 | Truncated files end mid-line. | Not covered |
| 7 | The spec allows **7z** containers too. None found in the sample. | Allowed. Detect it and show a clear "not yet supported" message in v1. |
| 8 | The spec does not say how a literal backslash is escaped, or whether frames can go backwards. | Handle defensively; the spec says data may be out of order. |
| 9 | Non-ASCII text (Chinese mission names and titles) is common. | UTF-8. Decode with a streaming `TextDecoder`. |
| 10 | **Unfinished zips** (14 files): the local header says size 0, the central directory is missing, but the deflate data is there. Zip entry names are UTF-8 without the UTF-8 flag. | Not covered. Our zip reader inflates the first entry directly and flags it `incomplete`. |
| 11 | **Remove-and-re-add glitch**: DCS2ACMI removes an aircraft and re-adds it under the same ID 0.02–1 s later, at the same spot with the same name and pilot (82 cases across the corpus). | Not covered. The parser links the two (`previousUid`, `reappearGap`); kill analysis must not count these. |
| 12 | IDs are recycled for unrelated new objects after longer gaps (88,603 cases, nearly all bullets and debris in large server recordings). | Not covered. These are separate objects. |
| 13 | `LockedTarget` **is** written in 167 DCS files (my first 111-file sample missed it). `Registration` appears in 65. | Defined. Useful extra evidence for kill attribution. |

## 3. Inferring kills (the core logic)

Example from the 2v1 ACM sample:
`62.55s AIM_9X spawns next to an F-16` → `65.68s AIM_9X and MiG-29A removed in the same frame, plus Shrapnel and a PILOT_SU27_SEAT object spawn`.

Planned rules, each with a confidence level:
1. **Shooter of a weapon:** the nearest Air/Sea/Ground object (not a weapon) to the weapon at its first sample.
   Prefer the same coalition. Use `Parent=` when present.
2. **Missile/bomb kill:** weapon removed within *R* metres of a target **and** the target is removed, `Destroyed`
   or `Disabled` within *Δt*. Shrapnel spawning near the target strengthens the match.
3. **Gun kill:** shells from shooter X pass within *R* of the target in the few seconds before its removal.
4. **Other outcomes:** ejection (Parachutist or `*SEAT` objects), crash (removed near the ground with no weapon nearby),
   left area, or a mission end where the object was still alive.
5. Thresholds (*R*, *Δt*) are tuned against the Tacview CSV ground truth, then checked across the whole corpus.

## 4. Tool choices

| Need | Choice | Why |
|---|---|---|
| Package manager | **pnpm 12** (installed) | As you asked. `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` (24 h). Dependency install scripts stay blocked except an explicit allow-list. `packageManager` is pinned in `package.json`. |
| Runtime / scripts | **Node 26** (installed) | Runs `.ts` scripts directly (type stripping), so no `tsx`/`ts-node` dependency. |
| Build / dev server | **Vite** | Fast dev reload, built-in Web Worker bundling, outputs static files that can be hosted anywhere or opened locally. |
| Language | **TypeScript (strict)** | The parser carries many subtle invariants; types catch mistakes early. |
| UI | **React** | Mainstream and well understood, and good for tables and filters. A light framework would also work, but React keeps future 3D/map options open (react-three-fiber, map components). |
| Unzip | **fflate** | Zero dependencies, small, streams in a worker, handles zip data descriptors. (Native `DecompressionStream('deflate-raw')` plus a small zip reader would be the zero-dependency fallback.) |
| Parsing off the UI thread | **Web Worker** | 60–90 MB zips expand to hundreds of MB of text. Stream it: unzip → `TextDecoder` → line splitter → parser, with a progress bar. |
| Tests | **Vitest** | Unit tests for tokenizer and `T=` edge cases, golden snapshots for fixtures, ground-truth scoring against the Tacview CSV, and an opt-in **corpus run** over all of `T:\` (crashes, warnings, timings). |
| Lint / format | **Biome** | One tool instead of ESLint + Prettier plus their plugins, so far fewer packages in the supply chain. |
| Later: 2D map | MapLibre GL or Leaflet | Tracks on a map with a time slider. |
| Later: 3D | CesiumJS (geospatial globe with terrain) or three.js | Decide after v1. Cesium fits lat/lon/terrain data naturally; three.js is lighter. |

Missing locally: **git** is not installed. Installing Git for Windows is recommended before coding starts, for version control.
Python is not needed.

## 5. Project layout

```
src/
  acmi/        pure TS, no DOM: container detection (zip / plain / 7z), streaming decode,
               tokenizer (escapes, continuation lines, truncation), parser → Recording model
  analysis/    shooter attribution, hit/kill inference, per-pilot stats
  worker/      Web Worker entry: file → progress messages → result
  ui/          drop zone, mission summary, participants, kill log, shots table, warnings panel
samples/       built-in fixtures (small, committed)
scripts/       corpus runner (node), ground-truth comparison
tests/
```

The `Recording` model holds header/global properties, objects (id, type tags, names, coalition,
spawn and removal times), per-object time-series of transforms and numeric properties, events,
and parser warnings with line numbers.

## 6. Fixtures

- **Built-in self-test sample** (auto-loads in dev at `/?sample=default`, so no drag-and-drop is needed):
  `Tacview-20210912-013539-DCS-F-16C - Caucasus - 2v1 ACM.zip.acmi` (327 KB). It has 2 missile kills, gun bursts,
  ejections, and a multi-line `Comments=` value with escaped commas.
- **Ground-truth fixture:** `…20240409-235741-DCS-prep-for-2024-04-part3.zip.acmi` plus its Tacview CSV (2.4 MB).
- **Edge cases:** `…20191227-025306-DCS-qfan_test_handler.zip.acmi` (3 KB, oldest recorder 1.8.1),
  a truncated `.txt.acmi` (16 KB), one X-Plane file, one file with a Chinese title.
- **Not committed, corpus only:** the 60–87 MB files, for performance testing.

## 7. Milestones

1. **Scaffold:** pnpm config with 24 h minimum age (checked by confirming that a package published <24 h ago is refused),
   Vite + React + TS, Biome, Vitest, drop zone, built-in sample auto-load.
   ✅ Done 2026-11-08. The age guard was verified: `typescript@7.1.0-dev.20261108.1` (1 minute old) was refused with
   `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, and a 2-day-old nightly installed normally. Also built: container
   detection, streaming line splitter (continuation lines, truncation, CRLF, BOM), and a quick-scan summary in a Web Worker.
   14 tests pass. Commands: `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm build`.
2. **Parser:** streaming, spec-correct plus the deviations in §2, with a warnings list. Unit tests and a corpus run with
   zero crashes over all 7,231 files.
   ✅ Built 2026-11-08 in `src/acmi/parser.ts`, `model.ts` and `tracks.ts`. Design decisions:
   - IDs are normalised hex strings. An ID that reappears after its `-id` removal becomes a new object (`life` 1, 2, …).
   - `T=` is kept as full state per sample (empty = unchanged). Lon/lat are float64 relative to the reference point;
     alt/angles/u/v/heading are float32. Two updates in the same frame keep the last one.
   - Text properties are stored only when they change. Known numeric properties go in float32 tracks. Unknown
     properties are numeric if they parse, otherwise text, so nothing is dropped.
   - `Event=` is parsed per the spec (ids, `Key:Value` params, text). `Destroyed` sets `destroyedAt`.
   - Out-of-order frames are sorted at the end. Lines before the first `#` count as time 0.
   - Corpus runner: `pnpm corpus T:\ [--every K] [--jobs N] [--out dir]`.
   - **Corpus result:** all 7,207 non-empty files parse (the 24 failures are 0-byte files, rejected with a clear
     message). That's 24 GB of text in 2.5 minutes with 6 workers; the largest file (87 MB zip, 249 MB text) takes 14 s.
     All files are FileVersion 2.2. Warnings: 23 truncated, 14 unfinished zips (recovered), reused IDs as in §2.
     There are no `Event=` lines anywhere and no unknown properties.
3. **Analysis v1:** mission summary, participants/pilots, shots fired, kill log with confidence levels.
   Scored against the Tacview CSV.
4. **UI polish:** filters (by pilot or coalition), click a kill to see its details, export the log to CSV.
5. **Later:** 2D map + timeline, then 3D.
