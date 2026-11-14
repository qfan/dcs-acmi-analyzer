import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../../settings/react.ts";
import { distanceUnitM, distanceUnitName, fmtAlt, fmtDist } from "../../settings/units.ts";
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
  ALT_RELATION_LABELS,
  type AltitudeRelation,
  ASPECT_SHORT_LABELS,
  type AspectCategory,
  DEFAULT_THRESHOLDS,
  type EngagementDomain,
  type FileAnalytics,
  QUALITY_FLAG_HELP,
  QUALITY_FLAG_LABELS,
  QUALITY_FLAG_ORDER,
  type QualityFlag,
  WEAPON_CLASS_LABELS,
  WEAPON_CLASS_ORDER,
  type WeaponClass,
} from "../model.ts";
import { type AnalyticsQuery, DEFAULT_QUERY, isUfoShot, runAnalyticsQuery } from "../query.ts";
import { ANALYTICS_SAMPLES, fetchAnalyticsSample, shouldAutoLoadSamples } from "../samples.ts";
import { type BatchFileJob, extractFilesInPool } from "../worker/client.ts";
import {
  BvrTimelineCard,
  DefeatAndDefenseCard,
  NotchAnalyzerCard,
  PatchComparisonCard,
  PilotReportCard,
} from "./BvrPanels.tsx";
import {
  AltitudeScatterPlot,
  ConditionMatrix,
  PolarAspectRangePlot,
  RangeDistributionChart,
  WeaponBreakdownCard,
} from "./Charts.tsx";
import { EngagementTable } from "./EngagementTable.tsx";

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
  const { settings } = useSettings();
  const units = settings.units;
  const distUnitName = distanceUnitName(units.distance);
  const distUnitM = distanceUnitM(units.distance);

  const [files, setFiles] = useState<FileAnalytics[]>([]);
  const [errors, setErrors] = useState<FileErrorRecord[]>([]);
  const [batch, setBatch] = useState<LoadingBatch | null>(null);
  const [dragging, setDragging] = useState(false);

  const [query, setQuery] = useState<AnalyticsQuery>(DEFAULT_QUERY);
  const [matrixMetric, setMatrixMetric] = useState<"kills" | "shots" | "pk">("kills");
  const [binStepUnits, setBinStepUnits] = useState<number>(5);
  const [showShotsOverlay, setShowShotsOverlay] = useState(true);
  const [showMissesOnScatter, setShowMissesOnScatter] = useState(false);
  const [selectedEngagementId, setSelectedEngagementId] = useState<string | null>(null);

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

  const binStepM = binStepUnits * distUnitM;
  const result = useMemo(() => runAnalyticsQuery(files, query, binStepM, 18), [files, query, binStepM]);

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

  const toggleCell = (aspect: AspectCategory, altRel: AltitudeRelation) => {
    const exactMatch =
      query.aspects.length === 1 &&
      query.aspects[0] === aspect &&
      query.altitudeRelations.length === 1 &&
      query.altitudeRelations[0] === altRel;
    if (exactMatch) {
      setQuery({ ...query, aspects: [], altitudeRelations: [] });
    } else {
      setQuery({ ...query, aspects: [aspect], altitudeRelations: [altRel] });
    }
  };

  const toggleAspect = (aspect: AspectCategory) => {
    const exists = query.aspects.includes(aspect);
    const next = exists ? query.aspects.filter((a) => a !== aspect) : [...query.aspects, aspect];
    setQuery({ ...query, aspects: next });
  };

  const toggleAltRelation = (altRel: AltitudeRelation) => {
    const exists = query.altitudeRelations.includes(altRel);
    const next = exists
      ? query.altitudeRelations.filter((r) => r !== altRel)
      : [...query.altitudeRelations, altRel];
    setQuery({ ...query, altitudeRelations: next });
  };

  const toggleWeapon = (weaponName: string) => {
    const exists = query.weaponNames.includes(weaponName);
    const next = exists
      ? query.weaponNames.filter((w) => w !== weaponName)
      : [...query.weaponNames, weaponName];
    setQuery({ ...query, weaponNames: next });
  };

  const togglePatch = (patch: string) => {
    const exists = query.dcsPatches.includes(patch);
    const next = exists ? query.dcsPatches.filter((p) => p !== patch) : [...query.dcsPatches, patch];
    setQuery({ ...query, dcsPatches: next });
  };

  const toggleBinRange = (minM: number, maxM: number) => {
    const same =
      query.minRangeM !== null &&
      query.maxRangeM !== null &&
      Math.abs(query.minRangeM - minM) < 1 &&
      Math.abs(query.maxRangeM - maxM) < 1;
    if (same) {
      setQuery({ ...query, minRangeM: null, maxRangeM: null });
    } else {
      setQuery({ ...query, minRangeM: minM, maxRangeM: maxM });
    }
  };

  const hasActiveFilters =
    query.aspects.length > 0 ||
    query.altitudeRelations.length > 0 ||
    query.dcsPatches.length > 0 ||
    query.weaponClasses.length > 0 ||
    query.weaponNames.length > 0 ||
    query.shooterSide !== "" ||
    query.shooterAircraft !== "" ||
    query.targetAircraft !== "" ||
    query.searchText.trim() !== "" ||
    query.minRangeM !== null ||
    query.maxRangeM !== null ||
    query.minFileBvrShots > 0 ||
    query.excludeQualityFlags.length > 0 ||
    query.excludeUfoShots ||
    query.includeGuns ||
    !query.excludeFriendlyFire ||
    query.confirmedTargetsOnly ||
    query.minConfidence !== "low";

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
          <a href="./" className="nav-link-btn" title="Open the single-recording ACMI Viewer">
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

              {/* 2. Interactive Query & Filter Controls */}
              <QueryFilterCard
                query={query}
                setQuery={setQuery}
                facets={result.facets}
                distUnitName={distUnitName}
                distUnitM={distUnitM}
                altitudeUnit={units.altitude}
                hasActiveFilters={hasActiveFilters}
              />

              {/* 3. KPI Summary Strip */}
              <KpiStrip kpis={result.kpis} distanceUnit={units.distance} />

              {/* 4. 2D Initial Condition Matrix (Aspect x Altitude Relation) */}
              <ConditionMatrix
                matrix={result.matrix}
                maxCellKills={result.maxCellKills}
                maxCellShots={result.maxCellShots}
                aspectBreakdown={result.aspectBreakdown}
                altitudeBreakdown={result.altitudeBreakdown}
                totalKills={result.kpis.totalKills}
                totalShots={result.kpis.shotsWithTarget}
                selectedAspects={query.aspects}
                selectedAltRelations={query.altitudeRelations}
                distanceUnit={units.distance}
                metric={matrixMetric}
                onSetMetric={setMatrixMetric}
                onToggleCell={toggleCell}
                onToggleAspect={toggleAspect}
                onToggleAltRelation={toggleAltRelation}
              />

              {/* 5. Initial Distance Distribution Histogram */}
              <RangeDistributionChart
                bins={result.rangeHistogram}
                distanceUnit={units.distance}
                binStepUnits={binStepUnits}
                onChangeBinStepUnits={setBinStepUnits}
                showShotsOverlay={showShotsOverlay}
                onToggleShotsOverlay={setShowShotsOverlay}
                activeRangeFilter={{ minM: query.minRangeM, maxM: query.maxRangeM }}
                onSelectBinRange={toggleBinRange}
              />

              {/* 6. Polar Aspect-Range Plot & Launcher-vs-Target Altitude Scatter Plot */}
              <div className="charts-two-col">
                <PolarAspectRangePlot
                  engagements={result.engagements}
                  distanceUnit={units.distance}
                  showMisses={showMissesOnScatter}
                  onToggleShowMisses={setShowMissesOnScatter}
                  selectedId={selectedEngagementId}
                  onSelectEngagement={(id) =>
                    setSelectedEngagementId(selectedEngagementId === id ? null : id)
                  }
                />
                <AltitudeScatterPlot
                  engagements={result.engagements}
                  altitudeUnit={units.altitude}
                  distanceUnit={units.distance}
                  thresholds={query.thresholds}
                  showMisses={showMissesOnScatter}
                  selectedId={selectedEngagementId}
                  onSelectEngagement={(id) =>
                    setSelectedEngagementId(selectedEngagementId === id ? null : id)
                  }
                />
              </div>

              {/* 7. DCS Patch & Cohort Comparison */}
              <PatchComparisonCard
                engagements={result.engagements}
                tacticsById={result.tacticsById}
                selectedPatches={query.dcsPatches}
                distanceUnit={units.distance}
                onTogglePatch={togglePatch}
              />

              {/* 8. Missile Defeat Modes & Target Defense Survival */}
              <DefeatAndDefenseCard
                defeatBreakdown={result.defeatBreakdown}
                defenseBreakdown={result.defenseBreakdown}
                diedUnawareCount={result.kpis.diedUnawareCount}
                totalKills={result.kpis.totalKills}
                distanceUnit={units.distance}
              />

              {/* 9. Empirical Notch Gate & Logistic Regression Seeker Analyzer */}
              <NotchAnalyzerCard
                notch={result.notchAnalysis}
                notchGateDeg={query.notchGateDeg}
                onChangeNotchGateDeg={(deg) => setQuery({ ...query, notchGateDeg: deg })}
              />

              {/* 10. Mil-Sim BVR Timeline & MAR Statistical Validator / Auto-Optimizer */}
              <BvrTimelineCard engagements={result.engagements} tacticsById={result.tacticsById} />

              {/* 11. Weapon Breakdown Table */}
              <WeaponBreakdownCard
                weapons={result.weaponBreakdown}
                selectedWeapons={query.weaponNames}
                distanceUnit={units.distance}
                onToggleWeapon={toggleWeapon}
              />

              {/* 11. Pilot BVR Report Card */}
              <PilotReportCard
                pilots={result.pilotReports}
                distanceUnit={units.distance}
                onSelectPilot={(pilot) =>
                  setQuery({
                    ...query,
                    searchText: query.searchText === pilot ? "" : pilot,
                  })
                }
              />

              {/* 12. Drill-down Matching Engagements Table */}
              <EngagementTable
                engagements={result.engagements}
                kills={result.kills}
                units={units}
                selectedId={selectedEngagementId}
                onSelectId={setSelectedEngagementId}
              />
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

function QueryFilterCard({
  query,
  setQuery,
  facets,
  distUnitName,
  distUnitM,
  altitudeUnit,
  hasActiveFilters,
}: {
  query: AnalyticsQuery;
  setQuery: (q: AnalyticsQuery) => void;
  facets: ReturnType<typeof runAnalyticsQuery>["facets"];
  distUnitName: "nm" | "km";
  distUnitM: number;
  altitudeUnit: "ft" | "m" | "ft+m" | "m+ft";
  hasActiveFilters: boolean;
}) {
  const domainKey = query.domains.length === 1 ? query.domains[0]! : "ALL";
  const setDomainKey = (v: string) => {
    if (v === "ALL") setQuery({ ...query, domains: [] });
    else setQuery({ ...query, domains: [v as EngagementDomain] });
  };

  const minRangeDisp =
    query.minRangeM !== null ? String(Math.round((query.minRangeM / distUnitM) * 10) / 10) : "";
  const maxRangeDisp =
    query.maxRangeM !== null ? String(Math.round((query.maxRangeM / distUnitM) * 10) / 10) : "";

  const applyRangePreset = (minKm: number | null, maxKm: number | null) => {
    setQuery({
      ...query,
      minRangeM: minKm !== null ? minKm * 1000 : null,
      maxRangeM: maxKm !== null ? maxKm * 1000 : null,
    });
  };

  return (
    <section className="card analytics-card query-panel" aria-label="Query filters">
      <div className="query-grid">
        <label>
          <span>Domain</span>
          <select value={domainKey} onChange={(e) => setDomainKey(e.target.value)}>
            <option value="A2A">Air-to-Air (A2A)</option>
            <option value="SAM">Surface-to-Air (SAM)</option>
            <option value="A2G">Air-to-Ground (A2G)</option>
            <option value="ALL">All Domains</option>
          </select>
        </label>

        <label>
          <span>Weapon Family</span>
          <select
            value={query.weaponClasses[0] ?? ""}
            onChange={(e) => {
              const v = e.target.value as WeaponClass | "";
              setQuery({ ...query, weaponClasses: v ? [v] : [] });
            }}
          >
            <option value="">All Weapon Families</option>
            {WEAPON_CLASS_ORDER.map((wc) => (
              <option key={wc} value={wc}>
                {WEAPON_CLASS_LABELS[wc]}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Specific Weapon</span>
          <select
            value={query.weaponNames[0] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setQuery({ ...query, weaponNames: v ? [v] : [] });
            }}
          >
            <option value="">All Weapons ({facets.weapons.length})</option>
            {facets.weapons.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Launcher Aircraft</span>
          <select
            value={query.shooterAircraft}
            onChange={(e) => setQuery({ ...query, shooterAircraft: e.target.value })}
          >
            <option value="">All Launchers ({facets.shooterAircraft.length})</option>
            {facets.shooterAircraft.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Target Aircraft</span>
          <select
            value={query.targetAircraft}
            onChange={(e) => setQuery({ ...query, targetAircraft: e.target.value })}
          >
            <option value="">All Targets ({facets.targetAircraft.length})</option>
            {facets.targetAircraft.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>DCS Patch</span>
          <select
            value={query.dcsPatches[0] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setQuery({ ...query, dcsPatches: v ? [v] : [] });
            }}
          >
            <option value="">All Patches ({facets.dcsPatches.length})</option>
            {facets.dcsPatches.map((p) => (
              <option key={p} value={p}>
                DCS {p}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Launcher Side</span>
          <select
            value={query.shooterSide}
            onChange={(e) => setQuery({ ...query, shooterSide: e.target.value })}
          >
            <option value="">All Sides</option>
            {facets.sides.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Min Range ({distUnitName})</span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="0"
            value={minRangeDisp}
            onChange={(e) => {
              const val = e.target.value.trim();
              setQuery({
                ...query,
                minRangeM: val === "" ? null : Math.max(0, Number(val) * distUnitM),
              });
            }}
          />
        </label>

        <label>
          <span>Max Range ({distUnitName})</span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="Any"
            value={maxRangeDisp}
            onChange={(e) => {
              const val = e.target.value.trim();
              setQuery({
                ...query,
                maxRangeM: val === "" ? null : Math.max(0, Number(val) * distUnitM),
              });
            }}
          />
        </label>

        <label className="grow">
          <span>Search</span>
          <input
            type="search"
            placeholder="Pilot, aircraft, weapon, mission…"
            value={query.searchText}
            onChange={(e) => setQuery({ ...query, searchText: e.target.value })}
          />
        </label>
      </div>

      {/* Range presets, Threshold controls, and toggles */}
      <div className="query-subbar">
        <div className="preset-group">
          <span className="muted small">Range presets:</span>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(null, null)}>
            All
          </button>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(0, 10)}>
            WVR (&le;{fmtDist(10000, altitudeUnit.startsWith("ft") ? "nm" : "km")})
          </button>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(10, 35)}>
            Med BVR (10–35 km)
          </button>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(35, null)}>
            Long BVR (&ge;35 km)
          </button>
        </div>

        <div className="threshold-group">
          <label className="small muted">
            Co-Alt band (±Δh):{" "}
            <select
              value={query.thresholds.coAltBandM}
              onChange={(e) =>
                setQuery({
                  ...query,
                  thresholds: { ...query.thresholds, coAltBandM: Number(e.target.value) },
                })
              }
            >
              <option value={500}>±{fmtAlt(500, altitudeUnit)}</option>
              <option value={1000}>±{fmtAlt(1000, altitudeUnit)} (default)</option>
              <option value={1500}>±{fmtAlt(1500, altitudeUnit)}</option>
              <option value={2000}>±{fmtAlt(2000, altitudeUnit)}</option>
            </select>
          </label>

          <label className="small muted">
            High-Alt floor:{" "}
            <select
              value={query.thresholds.highAltFloorM}
              onChange={(e) =>
                setQuery({
                  ...query,
                  thresholds: { ...query.thresholds, highAltFloorM: Number(e.target.value) },
                })
              }
            >
              <option value={4572}>{fmtAlt(4572, altitudeUnit)}</option>
              <option value={6096}>{fmtAlt(6096, altitudeUnit)}</option>
              <option value={7620}>{fmtAlt(7620, altitudeUnit)}</option>
              <option value={9144}>{fmtAlt(9144, altitudeUnit)} (High default)</option>
              <option value={10668}>{fmtAlt(10668, altitudeUnit)}</option>
              <option value={12192}>{fmtAlt(12192, altitudeUnit)} (Ultra-High)</option>
            </select>
          </label>
          <label
            className="small muted"
            title="Exclude pure dogfight recordings with fewer than N BVR missile shots (>10 nm)"
          >
            Min BVR/file:{" "}
            <select
              value={query.minFileBvrShots}
              onChange={(e) => setQuery({ ...query, minFileBvrShots: Number(e.target.value) })}
            >
              <option value={0}>Any (0+)</option>
              <option value={1}>&ge;1 BVR shot</option>
              <option value={3}>&ge;3 BVR shots</option>
              <option value={5}>&ge;5 BVR shots</option>
            </select>
          </label>
        </div>

        <div className="checks-inline">
          <label
            className="toggle"
            title="Automatically ignore duplicate copies of the same recording session"
          >
            <input
              type="checkbox"
              checked={query.deduplicateSessions}
              onChange={(e) => setQuery({ ...query, deduplicateSessions: e.target.checked })}
            />{" "}
            De-dup copies
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={query.includeGuns}
              onChange={(e) => setQuery({ ...query, includeGuns: e.target.checked })}
            />{" "}
            Include guns
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={query.excludeFriendlyFire}
              onChange={(e) => setQuery({ ...query, excludeFriendlyFire: e.target.checked })}
            />{" "}
            Exclude friendly fire
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={query.confirmedTargetsOnly}
              onChange={(e) => setQuery({ ...query, confirmedTargetsOnly: e.target.checked })}
            />{" "}
            Confirmed targets only
          </label>
        </div>
      </div>

      {/* Active filter chips */}
      {hasActiveFilters && (
        <div className="active-filters-bar">
          <span className="muted small">Active filters:</span>
          {query.aspects.map((a) => (
            <button
              key={a}
              type="button"
              className="filter-chip"
              onClick={() => setQuery({ ...query, aspects: query.aspects.filter((x) => x !== a) })}
            >
              Aspect: {ASPECT_SHORT_LABELS[a]} ×
            </button>
          ))}
          {query.altitudeRelations.map((r) => (
            <button
              key={r}
              type="button"
              className="filter-chip"
              onClick={() =>
                setQuery({
                  ...query,
                  altitudeRelations: query.altitudeRelations.filter((x) => x !== r),
                })
              }
            >
              Altitude: {ALT_RELATION_LABELS[r]} ×
            </button>
          ))}
          {query.weaponNames.map((w) => (
            <button
              key={w}
              type="button"
              className="filter-chip"
              onClick={() =>
                setQuery({
                  ...query,
                  weaponNames: query.weaponNames.filter((x) => x !== w),
                })
              }
            >
              Weapon: {w} ×
            </button>
          ))}
          {(query.minRangeM !== null || query.maxRangeM !== null) && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => setQuery({ ...query, minRangeM: null, maxRangeM: null })}
            >
              Range: {query.minRangeM !== null ? fmtDist(query.minRangeM, "km") : "0"} –{" "}
              {query.maxRangeM !== null ? fmtDist(query.maxRangeM, "km") : "∞"} ×
            </button>
          )}
          {query.excludeQualityFlags.map((flag) => (
            <button
              key={flag}
              type="button"
              className="filter-chip"
              onClick={() =>
                setQuery({
                  ...query,
                  excludeQualityFlags: query.excludeQualityFlags.filter((x) => x !== flag),
                })
              }
            >
              Excluding: {QUALITY_FLAG_LABELS[flag]} ×
            </button>
          ))}
          {query.excludeUfoShots && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => setQuery({ ...query, excludeUfoShots: false })}
            >
              Excluding: UFO-affected shots ×
            </button>
          )}
          <button
            type="button"
            className="secondary small-btn"
            onClick={() =>
              setQuery({
                ...DEFAULT_QUERY,
                enabledFileIds: query.enabledFileIds,
                thresholds: { ...DEFAULT_THRESHOLDS },
              })
            }
          >
            Reset all filters
          </button>
        </div>
      )}
    </section>
  );
}

function KpiStrip({
  kpis,
  distanceUnit,
}: {
  kpis: ReturnType<typeof runAnalyticsQuery>["kpis"];
  distanceUnit: "nm" | "km" | "nm+km" | "km+nm";
}) {
  return (
    <section className="kpi-grid">
      <div className="card kpi-card">
        <div className="stat-label">Matching Kills</div>
        <div className="stat-value">{kpis.totalKills.toLocaleString()}</div>
        <div className="muted small">
          {kpis.pk !== null ? `${Math.round(kpis.pk * 100)}% overall Pk` : "No shots"}
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Matching Shots</div>
        <div className="stat-value">{kpis.totalShots.toLocaleString()}</div>
        <div className="muted small">
          {kpis.totalHits.toLocaleString()} hits · {kpis.shotsWithTarget.toLocaleString()} with geometry
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Median Initial Kill Range</div>
        <div className="stat-value">{fmtDist(kpis.medianKillRangeM, distanceUnit)}</div>
        <div className="muted small">
          {kpis.p25KillRangeM !== null && kpis.p75KillRangeM !== null
            ? `IQR: ${fmtDist(kpis.p25KillRangeM, distanceUnit)} – ${fmtDist(kpis.p75KillRangeM, distanceUnit)}`
            : "–"}
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Mean Kill Range & TOF</div>
        <div className="stat-value">{fmtDist(kpis.meanKillRangeM, distanceUnit)}</div>
        <div className="muted small">
          {kpis.medianFlightTimeS !== null
            ? `Median flight time: ${kpis.medianFlightTimeS.toFixed(1)} s`
            : "–"}
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Dominant Kill Condition</div>
        <div className="stat-value kpi-cond">
          {kpis.dominantCondition
            ? `${ASPECT_SHORT_LABELS[kpis.dominantCondition.aspect]} · ${ALT_RELATION_LABELS[kpis.dominantCondition.altitudeRelation]}`
            : "–"}
        </div>
        <div className="muted small">
          {kpis.dominantCondition
            ? `${kpis.dominantCondition.kills} kills (${Math.round(kpis.dominantCondition.share * 100)}% of kills)`
            : "No kills in selection"}
        </div>
      </div>
    </section>
  );
}
