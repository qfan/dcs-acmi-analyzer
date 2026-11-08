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
| 14 | Ships leave altitude empty (`T=lon\|lat\|\|…`), so it is never set. | Not covered. Geometry treats a never-set altitude as 0 m. |
| 15 | The `Pilot` of an aircraft changes mid-recording when a player jumps between seats (single player) or slots. | Allowed. Credit uses the pilot *at the time* of the event. |
| 16 | **Protected multiplayer recordings** (68 files have `PlaybackKey`/`PlaybackDelay` in the header): horizontal positions of objects are scrambled (degrees of jump per frame) while altitude/attitude stay smooth. | Not covered. We do **not** try to decode this (it would mean reverse-engineering Tacview). Scrambled objects are detected and left out of geometry, with a notice. |
| 17 | In multiplayer *client* recordings, objects appear/disappear as they enter/leave the client's view, and weapons can first appear mid-flight. Missions end with everything removed in the last frame. | Not covered. Removals need evidence to count as losses (see §3). |

## 3. Inferring kills (the core logic) — implemented in `src/analysis/`

Example from the 2v1 ACM sample:
`62.55s AIM_9X spawns next to an F-16` → `65.68s AIM_9X and MiG-29A removed in the same frame, plus Shrapnel and a PILOT_SU27_SEAT object spawn`.

Rules (constants in `RULES` in `src/analysis/analyze.ts`):
1. **Shooter:** `Parent=` if present; otherwise the nearest aircraft/vehicle/ship to the weapon when it first appears
   (≤1.5 km, same coalition preferred; launchers sit 2–70 m away in practice). Sub-munitions inherit from a nearby
   parent weapon. The pilot is the one in the seat *at launch time*.
2. **Hit:** when a weapon vanishes, its last path is extended to the moment it vanished, and the **closest approach** to
   each object is computed (targets also extended if they stopped being sampled). ≤60 m for missiles/bombs/rockets,
   ≤20 m for bullets. A weapon never "hits" its own launcher.
3. **Kill:** a victim disappears (after merging the remove/re-add glitch) and was hit within the previous 180 s; the last
   hit's shooter gets the kill, other shooters are listed as also hitting it. Friendly fire is flagged.
4. **Losses without a weapon need evidence:** collision (two aircraft vanish within 1 s and 100 m, both moving), crash
   (aircraft sinking ≥20 m/s, at ≤20 m MSL while moving, or with an ejection). Everything else that vanishes — players
   leaving, despawns, units out of a client's view, everything removed in the final second, batches of ≥10 at once — is
   **not** a loss; it is counted in a footnote.
5. **Gun bursts:** rounds from one shooter less than 1 s apart.

**Calibration against Tacview's own exported log** (`tests/fixtures/ground-truth/`, SAMs vs TALD decoys, 2024):
- Fired: 122 of 122 matched, with the same shooter and the same pilot-at-the-time.
- Hits: 40 of Tacview's 44 matched. The 4 differences are deliberate: 3 are a SAM bursting 114–133 m from its own
  launcher ship, and 1 is a near miss that Tacview's ~150 m radius counts but the decoy flew on for 5 s.
- We find 26 more hits (13 SAM/decoy interceptions at 3–19 m closest approach) that Tacview logs only as "destroyed",
  because it judges from last-sampled positions that were up to 250 m apart.

**Whole corpus (7,207 recordings):** no analysis errors; 17,426 weapon kills, 6,221 crashes, 254 collisions;
analysis adds ~10% to parse time (1.7 s on the largest 87 MB file).

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
   ✅ Done 2026-11-08: kill log, pilot scoreboard, shots table (gun bursts optional), notices for protected recordings
   and for removals that aren't losses. See §3 for rules and calibration. 44 tests.
4. **UI polish:** filters (by pilot or coalition), click a kill to see its details, export the log to CSV.
   ✅ Done 2026-11-08: filter bar (side, pilot, multi-word search; clicking a pilot in the scoreboard filters to them),
   expandable kill rows (launch range, weapon flight time, miss distance, both aircraft's altitude/speed at launch, in
   metric and imperial, confidence explained), switch between time since start and in-mission time of day.
   (A CSV export was added here and removed on 2026-11-09 as not useful; it's in git history, commit 6afd44f.)
5. **2D map + timeline.**
   ✅ Done 2026-11-08 (`src/map/`, `src/ui/MapView.tsx`). Decision: a self-drawn canvas map with **no basemap tiles**
   (no network requests, no new dependencies; a tile background can be an opt-in later). The worker projects tracks to
   flat metres around the action (equirectangular; 0.08% distance error measured), thins them to ≤4 samples/s, and
   transfers them as five typed arrays (no copy). Features: side-coloured icons by kind with heading, trails, labels with
   decluttering, kill markers, bullseyes, km grid and scale bar; pan/zoom/fit; play/pause, ±10 s, 1–64× speed, kill ticks
   on the timeline; click to select (pilot at that time, altitude, speed, heading, follow); "Show on map" from a kill.
   Scrambled tracks are left out. 87 MB recording: 8.2 s to load, redraw within one 60 fps frame.
6. **3D view** (three.js 0.187.0, zero runtime dependencies; `@types/three` dev-only).
   ✅ Done 2026-11-08 (`src/scene/frame.ts`, `src/ui/Scene3D.tsx`, shared panel in `src/ui/MapView.tsx`).
   Flat-earth scene like DCS itself (X east, Y altitude, Z south), so it's best for engagements within ~100 km; the 2D
   view stays for overviews and low-end devices (2D/3D switch, remembered; 3D disabled without WebGL 2). Symbols:
   delta + fin for jets (with real roll/pitch/yaw), rods for missiles (lighter shade), boxes/hulls/cones for ground,
   ships and parachutes; one instanced draw call per kind, constant on-screen size; trails and altitude drop lines;
   kill markers; decluttered labels; logarithmic depth buffer. Orbit/pan/zoom-to-cursor, Fit, Top, Follow, and
   "Show on map" frames the victim from 6 km. Renders on demand. three.js is a separate 144 KB (gzip) chunk loaded only
   when 3D is first opened. 87 MB recording renders within one 60 fps frame.
   Ground grid adapts to camera distance (<40 km: 1 km + 10 km; <300 km: 10 km; beyond: 50 km), stays centred under
   the camera target, and fades into distance fog so the horizon doesn't turn into a band of lines.
7. **View settings and profiles** (`src/settings/`, `src/ui/SettingsPanel.tsx`).
   ✅ Done 2026-11-09. One Settings object (units: altitude ft/m/both, speed kt/km/h/both, distance and grid nm/km/both;
   label fields; map mode, trails, ground units, playback speed; time format) behind a small store used by every view.
   Storage: one localStorage key per format version (`acmi-viewer.settings.v1`, …) holding {savedAt, settings, profiles}.
   Load = the most recently saved key the app understands, migrated forward step by step (`MIGRATIONS` in schema.ts),
   then sanitised field by field (bad or unknown values fall back to defaults). Keys from newer versions are never read
   or overwritten, so downgrade-then-upgrade loses nothing. Cross-tab sync via the storage event (reload without
   write-back). Built-in profiles (NATO / Western, Russian / Eastern, Mixed) change units only; user profiles save
   everything; JSON export/import (refuses files from a newer version).
   **To change the format:** bump SETTINGS_VERSION, add a MIGRATIONS step, update Settings/DEFAULT_SETTINGS/sanitize.
8. **Later:** optional map tiles (2D, then 3D terrain/imagery); display-name table for DCS type names.
