import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsPanel } from "../../ui/SettingsPanel.tsx";
import { formatDuration } from "../../ui/Summary.tsx";
import {
  anonymizeDataset,
  engagementsToCsv,
  namespaceFileIds,
  parseDatasetBundle,
  serializeDatasetBundle,
  triggerDownload,
} from "../export.ts";
import {
  type FileAnalytics,
  QUALITY_FLAG_HELP,
  QUALITY_FLAG_LABELS,
  QUALITY_FLAG_ORDER,
  type QualityFlag,
} from "../model.ts";
import { type AnalyticsQuery, isUfoShot } from "../query.ts";
import { ANALYTICS_SAMPLES, fetchAnalyticsSample, shouldAutoLoadSamples } from "../samples.ts";
import { type BatchFileJob, extractFilesInPool } from "../worker/client.ts";
import { AnalyticsPanels, useAnalyticsDashboard } from "./AnalyticsDashboard.tsx";

const RECORDING_FILE_RE = /\.(acmi|zip|txt)$/i;

interface LoadingBatch {
  totalFiles: number;
  doneFiles: number;
  workerCount: number;
  progressByFile: Record<string, number>;
}

interface FileErrorRecord {
  fileId: string;
  fileName: string;
  message: string;
}

export function AnalyticsApp() {
  const [files, setFiles] = useState<FileAnalytics[]>([]);
  const [errors, setErrors] = useState<FileErrorRecord[]>([]);
  const [batch, setBatch] = useState<LoadingBatch | null>(null);
  const [dragging, setDragging] = useState(false);

  const dash = useAnalyticsDashboard(files);
  const { query, setQuery, result, setSelectedEngagementId } = dash;

  const cancelPoolRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const settingsDialogRef = useRef<HTMLDialogElement>(null);
  const nextIdSeq = useRef(1);

  const ingestJobs = useCallback((jobs: BatchFileJob[]) => {
    if (jobs.length === 0) return;

    const progressMap: Record<string, number> = {};
    let doneCount = 0;
    let workerCount = 1;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let filesFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingCompleted: FileAnalytics[] = [];

    const flushProgress = () => {
      progressTimer = null;
      setBatch((b) =>
        b
          ? {
              totalFiles: jobs.length,
              doneFiles: doneCount,
              workerCount,
              progressByFile: { ...progressMap },
            }
          : null,
      );
    };

    const scheduleProgressFlush = () => {
      if (progressTimer === null) {
        progressTimer = setTimeout(flushProgress, 120);
      }
    };

    const flushCompletedFiles = () => {
      filesFlushTimer = null;
      if (pendingCompleted.length === 0) return;
      const batchToCommit = pendingCompleted.splice(0, pendingCompleted.length);
      const newIds = new Set(batchToCommit.map((f) => f.fileId));
      setFiles((prev) => [...prev.filter((f) => !newIds.has(f.fileId)), ...batchToCommit]);
    };

    const scheduleFilesFlush = () => {
      if (filesFlushTimer === null) {
        filesFlushTimer = setTimeout(flushCompletedFiles, 350);
      }
    };

    const run = extractFilesInPool(jobs, {
      onFileProgress: (fileId, fraction) => {
        progressMap[fileId] = fraction;
        scheduleProgressFlush();
      },
      onFileDone: (analytics) => {
        doneCount++;
        progressMap[analytics.fileId] = 1;
        pendingCompleted.push(analytics);
        scheduleProgressFlush();
        scheduleFilesFlush();
      },
      onFileError: (fileId, fileName, message) => {
        doneCount++;
        setErrors((prev) => [...prev, { fileId, fileName, message }]);
        scheduleProgressFlush();
      },
    });

    workerCount = run.workerCount;
    setBatch({
      totalFiles: jobs.length,
      doneFiles: 0,
      workerCount: run.workerCount,
      progressByFile: {},
    });

    cancelPoolRef.current = () => {
      if (progressTimer !== null) clearTimeout(progressTimer);
      if (filesFlushTimer !== null) clearTimeout(filesFlushTimer);
      run.cancel();
    };
    void run.promise.finally(() => {
      if (progressTimer !== null) clearTimeout(progressTimer);
      if (filesFlushTimer !== null) clearTimeout(filesFlushTimer);
      flushCompletedFiles();
      setBatch(null);
      if (cancelPoolRef.current) cancelPoolRef.current = null;
    });
  }, []);

  const addFileList = useCallback(
    (fileList: FileList | File[]) => {
      const arr = Array.from(fileList);
      const jsonBundles = arr.filter((f) => f.name.toLowerCase().endsWith(".json"));
      for (const jf of jsonBundles) {
        void jf
          .text()
          .then((txt) => {
            const loaded = namespaceFileIds(parseDatasetBundle(txt), `json:${jf.name}`);
            setFiles((prev) => {
              const existing = new Set(loaded.map((x) => x.fileId));
              return [...prev.filter((p) => !existing.has(p.fileId)), ...loaded];
            });
          })
          .catch((err) => {
            setErrors((prev) => [
              ...prev,
              {
                fileId: jf.name,
                fileName: jf.name,
                message: err instanceof Error ? err.message : String(err),
              },
            ]);
          });
      }

      // Recordings: .acmi (incl. .zip.acmi / .txt.acmi), bare .zip and .txt, matching the file
      // picker's `accept`; the parser detects the container from the bytes. Other files (e.g. from
      // "Add Folder…") are ignored.
      const acmiFiles = arr.filter((f) => RECORDING_FILE_RE.test(f.name));
      const jobs: BatchFileJob[] = acmiFiles.map((f) => ({
        fileId: `file-${nextIdSeq.current++}-${f.name}`,
        fileName: f.name,
        file: f,
      }));
      ingestJobs(jobs);
    },
    [ingestJobs],
  );

  const loadBuiltInSamples = useCallback(async () => {
    cancelPoolRef.current?.();
    setBatch({
      totalFiles: ANALYTICS_SAMPLES.length,
      doneFiles: 0,
      workerCount: 1,
      progressByFile: {},
    });
    try {
      const fetched: BatchFileJob[] = await Promise.all(
        ANALYTICS_SAMPLES.map(async (s) => ({
          fileId: `sample:${s.id}`,
          fileName: s.originalName,
          file: await fetchAnalyticsSample(s),
        })),
      );
      ingestJobs(fetched);
    } catch (err) {
      setBatch(null);
      setErrors((prev) => [
        ...prev,
        {
          fileId: "samples",
          fileName: "Built-in samples",
          message: err instanceof Error ? err.message : String(err),
        },
      ]);
    }
  }, [ingestJobs]);

  const loadBvrSamplePack = useCallback(async () => {
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}samples/bvr-sample-pack.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} loading BVR sample pack`);
      const text = await resp.text();
      const loaded = namespaceFileIds(parseDatasetBundle(text), "sample");
      setFiles((prev) => {
        const existing = new Set(loaded.map((x) => x.fileId));
        return [...prev.filter((p) => !existing.has(p.fileId)), ...loaded];
      });
    } catch (err) {
      setErrors((prev) => [
        ...prev,
        {
          fileId: "bvr-sample-pack",
          fileName: "BVR Sample Pack",
          message: err instanceof Error ? err.message : String(err),
        },
      ]);
    }
  }, []);

  // Auto-load the redacted 11-sortie BVR sample pack by default (or ?sample=default)
  useEffect(() => {
    if (shouldAutoLoadSamples(window.location.search)) {
      void loadBvrSamplePack();
    }
    return () => cancelPoolRef.current?.();
  }, [loadBvrSamplePack]);

  // Accept multi-file drops anywhere in the window
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const dropped = e.dataTransfer?.files;
      if (dropped && dropped.length > 0) addFileList(dropped);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [addFileList]);

  const toggleFileEnabled = (fileId: string) => {
    const allIds = files.map((f) => f.fileId);
    const current = query.enabledFileIds ?? allIds;
    const next = current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId];
    setQuery({
      ...query,
      enabledFileIds: next.length === allIds.length ? null : next,
    });
  };

  /**
   * Anonymize the loaded files in place. Redacted files get IDs unique to this redaction so they
   * cannot collide with a later-loaded bundle (e.g. the sample pack's `bvr-sortie-NN`), and the
   * current file selection is carried over to the new IDs.
   */
  const redactFiles = () => {
    const redacted = anonymizeDataset(files, { idPrefix: `redacted-${nextIdSeq.current++}:sortie-` });
    const idMap = new Map(files.map((f, i) => [f.fileId, redacted[i]?.fileId ?? f.fileId]));
    setFiles(redacted);
    if (query.enabledFileIds) {
      setQuery({
        ...query,
        enabledFileIds: query.enabledFileIds.map((id) => idMap.get(id) ?? id),
      });
    }
  };

  const removeFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.fileId !== fileId));
    if (query.enabledFileIds) {
      setQuery({
        ...query,
        enabledFileIds: query.enabledFileIds.filter((id) => id !== fileId),
      });
    }
  };

  const clearAllFiles = () => {
    cancelPoolRef.current?.();
    setFiles([]);
    setErrors([]);
    setBatch(null);
    setSelectedEngagementId(null);
  };

  const batchFraction = batch
    ? Object.values(batch.progressByFile).reduce((a, b) => a + b, 0) / Math.max(1, batch.totalFiles)
    : 0;

  return (
    <div className="app analytics-app">
      <header className="topbar">
        <div className="brand-group">
          <h1>ACMI Missile & Engagement Analytics</h1>
          <span className="badge info">Multi-File BVR & Patch Query Tool</span>
        </div>
        <div className="actions">
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            + Add ACMI files…
          </button>
          <button
            type="button"
            className="secondary"
            title="Select an entire folder of .acmi recordings"
            onClick={() => folderInputRef.current?.click()}
          >
            + Add Folder…
          </button>
          <button
            type="button"
            className="secondary"
            title="Load built-in anonymized pack of 11 multiplayer BVR sorties (497 A2A missiles across DCS 2.9.6–2.9.14)"
            onClick={() => void loadBvrSamplePack()}
          >
            Load BVR Sample Pack (11 sorties)
          </button>
          <button
            type="button"
            className="secondary"
            title="Parse 6 small built-in ACM/BVR raw .acmi files via Web Workers"
            onClick={() => void loadBuiltInSamples()}
          >
            Load Mini ACMI Pack ({ANALYTICS_SAMPLES.length})
          </button>
          {files.length > 0 && (
            <>
              <button
                type="button"
                className="secondary"
                title="Replace all player names and mission titles with anonymized tactical callsigns (Viper 1-1, Hornet 2-1, etc.)"
                onClick={redactFiles}
              >
                Redact Pilot Names
              </button>
              <button
                type="button"
                className="secondary"
                title="Export matching engagements to CSV for Excel/Python"
                onClick={() =>
                  triggerDownload(
                    `acmi-engagements-${new Date().toISOString().slice(0, 10)}.csv`,
                    engagementsToCsv(result.engagements, result.tacticsById),
                    "text/csv;charset=utf-8",
                  )
                }
              >
                Export CSV ({result.engagements.length})
              </button>
              <button
                type="button"
                className="secondary"
                title="Save pre-extracted dataset bundle (.json) for instant reload"
                onClick={() =>
                  triggerDownload(
                    `acmi-dataset-${new Date().toISOString().slice(0, 10)}.json`,
                    serializeDatasetBundle(files),
                    "application/json;charset=utf-8",
                  )
                }
              >
                Save Dataset JSON
              </button>
              <button type="button" className="secondary" onClick={clearAllFiles}>
                Clear all
              </button>
            </>
          )}
          <button
            type="button"
            className="secondary"
            aria-haspopup="dialog"
            onClick={() => settingsDialogRef.current?.showModal()}
          >
            Units & Settings
          </button>
          <a href="./index.html" className="nav-link-btn" title="Open the single-recording ACMI Viewer">
            Single-File Viewer →
          </a>
          <input
            ref={fileInputRef}
            type="file"
            accept=".acmi,.zip,.txt,.json"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                addFileList(e.target.files);
              }
              e.target.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is standard in modern browsers
            webkitdirectory=""
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                addFileList(e.target.files);
              }
              e.target.value = "";
            }}
          />
        </div>
      </header>

      <main className="analytics-main">
        {batch && (
          <section className="card batch-progress-card">
            <div className="card-head">
              <span>
                Parsing & extracting initial conditions: <strong>{batch.doneFiles}</strong> of{" "}
                <strong>{batch.totalFiles}</strong> recordings ({batch.workerCount} parallel worker
                {batch.workerCount === 1 ? "" : "s"})…
              </span>
              <span className="muted small">{Math.round(batchFraction * 100)}%</span>
            </div>
            <progress max={1} value={batchFraction} style={{ width: "100%" }} />
          </section>
        )}

        {errors.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h3>Could not read {errors.length} file(s)</h3>
              <button type="button" className="secondary small-btn" onClick={() => setErrors([])}>
                Dismiss
              </button>
            </div>
            <ul className="warnings">
              {errors.map((er, i) => (
                <li key={`${er.fileId}:${i}`}>
                  <strong>{er.fileName}</strong>: {er.message}
                </li>
              ))}
            </ul>
          </section>
        )}

        {files.length === 0 && !batch ? (
          <div className="empty">
            <p className="big">Drop one or multiple Tacview .acmi files anywhere on this page</p>
            <p className="muted">
              Analyze missile kills, launch ranges, target aspects (Head-on, Beam, Tail-on), and altitude
              relations (Co-Alt High, Co-Alt Low, High→Low, Low→High) across a set of recordings.
            </p>
            <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "center" }}>
              <button type="button" onClick={() => void loadBvrSamplePack()}>
                Load BVR Sample Pack (11 sorties · 497 missiles)
              </button>
              <button type="button" className="secondary" onClick={() => void loadBuiltInSamples()}>
                Load Mini ACMI Pack ({ANALYTICS_SAMPLES.length} recordings)
              </button>
            </div>
          </div>
        ) : (
          files.length > 0 && (
            <>
              {/* 1. Loaded Recordings Dataset Bar */}
              <DatasetCard
                files={files}
                enabledFileIds={query.enabledFileIds}
                duplicateFileIds={result.duplicateFileIds}
                qualityExcludedFileIds={result.qualityExcludedFileIds}
                ufoExcludedShots={result.ufoExcludedShots}
                query={query}
                setQuery={setQuery}
                onToggleFile={toggleFileEnabled}
                onRemoveFile={removeFile}
                onEnableAll={() => setQuery({ ...query, enabledFileIds: null })}
              />

              {/* 2. Filters, KPIs, charts, cards and drill-down table */}
              <AnalyticsPanels dash={dash} />
            </>
          )
        )}
      </main>

      <dialog ref={settingsDialogRef} className="settings-dialog" aria-label="View settings">
        <SettingsPanel onClose={() => settingsDialogRef.current?.close()} />
      </dialog>

      {dragging && (
        <div className="drop-overlay">
          <p>Drop .acmi file(s) to add to analytics</p>
        </div>
      )}
    </div>
  );
}

function DatasetCard({
  files,
  enabledFileIds,
  duplicateFileIds,
  qualityExcludedFileIds,
  ufoExcludedShots,
  query,
  setQuery,
  onToggleFile,
  onRemoveFile,
  onEnableAll,
}: {
  files: FileAnalytics[];
  enabledFileIds: string[] | null;
  duplicateFileIds: Set<string>;
  qualityExcludedFileIds: Set<string>;
  ufoExcludedShots: number;
  query: AnalyticsQuery;
  setQuery: (q: AnalyticsQuery) => void;
  onToggleFile: (id: string) => void;
  onRemoveFile: (id: string) => void;
  onEnableAll: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const enabledCount = enabledFileIds ? enabledFileIds.length : files.length;
  const totalEng = files.reduce((s, f) => s + f.engagements.length, 0);
  const totalKills = files.reduce((s, f) => s + f.engagements.filter((e) => e.isKill).length, 0);

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>
            Loaded Recordings ({enabledCount} of {files.length} active · {totalKills} total kills, {totalEng}{" "}
            weapon events
            {duplicateFileIds.size > 0 ? ` · ${duplicateFileIds.size} skipped as duplicate session` : ""}
            {qualityExcludedFileIds.size > 0
              ? ` · ${qualityExcludedFileIds.size} skipped by quality label`
              : ""}
            )
          </h3>
        </div>
        <div className="head-actions">
          {enabledFileIds !== null && (
            <button type="button" className="secondary small-btn" onClick={onEnableAll}>
              Enable all ({files.length})
            </button>
          )}
          <button type="button" className="link small" onClick={() => setExpanded(!expanded)}>
            {expanded ? "▴ Hide file list" : "▾ Show file list"}
          </button>
        </div>
      </div>

      <QualityBar files={files} query={query} setQuery={setQuery} ufoExcludedShots={ufoExcludedShots} />

      {expanded && (
        <div className="file-chips">
          {files.map((f) => {
            const checked = enabledFileIds === null || enabledFileIds.includes(f.fileId);
            const isDuplicate = duplicateFileIds.has(f.fileId);
            const isQualityExcluded = qualityExcludedFileIds.has(f.fileId);
            const a2aKills = f.engagements.filter((e) => e.isKill && !e.isGun).length;
            return (
              <div
                key={f.fileId}
                className={`file-chip${checked && !isDuplicate && !isQualityExcluded ? " active" : " muted-chip"}`}
              >
                <label
                  className="file-chip-label"
                  title={
                    isDuplicate
                      ? `${f.fileName}: skipped, another loaded file records the same session`
                      : f.fileName
                  }
                >
                  <input type="checkbox" checked={checked} onChange={() => onToggleFile(f.fileId)} />
                  <span className="file-chip-title">{f.missionTitle}</span>
                  <span className="muted small">
                    ({a2aKills} missile kill{a2aKills === 1 ? "" : "s"} · {formatDuration(f.durationS)})
                    {isDuplicate ? " · duplicate, skipped" : ""}
                  </span>
                </label>
                <QualityBadges file={f} />
                <button
                  type="button"
                  className="file-chip-remove"
                  title="Remove recording from dataset"
                  aria-label={`Remove ${f.missionTitle}`}
                  onClick={() => onRemoveFile(f.fileId)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Tooltip text for a file's quality labels, including the worst UFO aircraft. */
function qualityTitle(f: FileAnalytics): string {
  const q = f.quality;
  if (!q) return "Quality not assessed (data extracted by an older version).";
  const lines = q.flags.map((flag) => `${QUALITY_FLAG_LABELS[flag]}: ${QUALITY_FLAG_HELP[flag]}`);
  if (q.offPathSamples > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `Off-path samples: ${q.offPathSamples} · heavy UFO aircraft: ${q.heavyAircraft} of ${q.trackedAircraft}` +
        (q.massWindows > 0 ? ` · server-lag windows: ${q.massWindows}` : "") +
        ` · UFO-affected A2A shots: ${q.ufoShots}`,
    );
    for (const a of q.aircraft.slice(0, 6)) {
      lines.push(
        `  ${a.heavy ? "●" : "○"} ${a.name}${a.pilot ? ` (${a.pilot})` : ""}: ${a.offPathSamples} samples in ${a.episodes} episode${a.episodes === 1 ? "" : "s"}`,
      );
    }
  }
  return lines.join("\n");
}

function QualityBadges({ file }: { file: FileAnalytics }) {
  const q = file.quality;
  if (!q) return null;
  const minorUfo = q.ufoLevel === "minor";
  if (q.flags.length === 0 && !minorUfo) return null;
  return (
    <span className="quality-badges" title={qualityTitle(file)}>
      {QUALITY_FLAG_ORDER.filter((flag) => q.flags.includes(flag)).map((flag) => (
        <span key={flag} className={`badge${flag.startsWith("ufo") || flag === "scrambled" ? " warn" : ""}`}>
          {QUALITY_FLAG_LABELS[flag]}
        </span>
      ))}
      {minorUfo && <span className="badge">minor UFO</span>}
    </span>
  );
}

/** Label counts with one-click exclusion, plus the per-shot UFO switch. */
function QualityBar({
  files,
  query,
  setQuery,
  ufoExcludedShots,
}: {
  files: FileAnalytics[];
  query: AnalyticsQuery;
  setQuery: (q: AnalyticsQuery) => void;
  ufoExcludedShots: number;
}) {
  const counts = new Map<QualityFlag, number>();
  let ufoShots = 0;
  let unassessed = 0;
  for (const f of files) {
    if (!f.quality) unassessed++;
    for (const flag of f.quality?.flags ?? []) counts.set(flag, (counts.get(flag) ?? 0) + 1);
    for (const e of f.engagements) if (e.domain === "A2A" && !e.isGun && isUfoShot(e)) ufoShots++;
  }
  const present = QUALITY_FLAG_ORDER.filter(
    (flag) => counts.has(flag) || query.excludeQualityFlags.includes(flag),
  );
  if (present.length === 0 && ufoShots === 0 && !query.excludeUfoShots && unassessed === 0) return null;
  const toggleFlag = (flag: QualityFlag) =>
    setQuery({
      ...query,
      excludeQualityFlags: query.excludeQualityFlags.includes(flag)
        ? query.excludeQualityFlags.filter((x) => x !== flag)
        : [...query.excludeQualityFlags, flag],
    });
  return (
    <div className="quality-bar">
      {present.length > 0 && <span className="muted small">Labels (click to exclude):</span>}
      {present.map((flag) => {
        const excluded = query.excludeQualityFlags.includes(flag);
        return (
          <button
            key={flag}
            type="button"
            className={`quality-toggle${excluded ? " excluded" : ""}${flag.startsWith("ufo") ? " ufo" : ""}`}
            aria-pressed={excluded}
            title={`${QUALITY_FLAG_HELP[flag]}\n${excluded ? "Excluded: click to include again." : "Click to exclude these files."}`}
            onClick={() => toggleFlag(flag)}
          >
            {excluded ? "⊘ " : ""}
            {QUALITY_FLAG_LABELS[flag]} ({counts.get(flag) ?? 0})
          </button>
        );
      })}
      <label
        className="toggle small"
        title="Drop single shots whose shooter or target warped from 10 s before launch to 5 s after the shot, even in otherwise clean files."
      >
        <input
          type="checkbox"
          checked={query.excludeUfoShots}
          onChange={(e) => setQuery({ ...query, excludeUfoShots: e.target.checked })}
        />{" "}
        Exclude UFO-affected shots (
        {query.excludeUfoShots ? `${ufoExcludedShots} dropped` : `${ufoShots} A2A`})
      </label>
      {unassessed > 0 && (
        <span className="muted small" title="Re-extract the original .acmi files to get quality labels.">
          · {unassessed} file{unassessed === 1 ? "" : "s"} without quality data
        </span>
      )}
    </div>
  );
}
