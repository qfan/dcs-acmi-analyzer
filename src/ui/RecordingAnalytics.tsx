import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { FileAnalytics, MissileEngagement } from "../analytics/model.ts";
import { AnalyticsPanels, useAnalyticsDashboard } from "../analytics/ui/AnalyticsDashboard.tsx";
import { extractFilesInPool } from "../analytics/worker/client.ts";
import "../analytics/ui/analytics.css";
import { type AnalyticsQuery, DEFAULT_QUERY } from "../analytics/query.ts";

const SINGLE_FILE_QUERY: AnalyticsQuery = { ...DEFAULT_QUERY, includeBvrTrainer: true };

const ENABLED_KEY = "acmi-viewer.analytics-enabled";

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked (private window etc.): the toggle just won't be remembered.
  }
}

type ExtractState =
  | { phase: "loading"; progress: number }
  | { phase: "done"; analytics: FileAnalytics }
  | { phase: "error"; message: string };

/**
 * "Enable analytics" for the single-file viewer: runs the Analytics page's extraction on the open
 * recording (in a worker, reusing its IndexedDB cache) and shows the panels that make sense for one
 * file. Off by default; the choice is remembered in this browser.
 */
export function RecordingAnalytics({
  file,
  name,
  onShowOnMap,
}: {
  file: Blob;
  name: string;
  onShowOnMap?: (e: MissileEngagement) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(readEnabled);
  const [state, setState] = useState<ExtractState | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    setState({ phase: "loading", progress: 0 });
    const run = extractFilesInPool(
      [{ fileId: "viewer", fileName: name, file }],
      {
        onFileProgress: (_id, progress) =>
          setState((s) => (s?.phase === "loading" ? { phase: "loading", progress } : s)),
        onFileDone: (analytics) => setState({ phase: "done", analytics }),
        onFileError: (_id, _name, message) => setState({ phase: "error", message }),
      },
      1,
    );
    return run.cancel;
  }, [enabled, file, name]);

  const toggle = (on: boolean) => {
    setEnabled(on);
    writeEnabled(on);
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <h3>{t("viewer.recordingAnalytics.title")}</h3>
            <p className="muted small">
              <Trans
                i18nKey="viewer.recordingAnalytics.desc"
                components={[
                  <a key="0" href="./analytics.html">
                    Analytics
                  </a>,
                ]}
              />
            </p>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />{" "}
            {t("viewer.recordingAnalytics.enable")}
          </label>
        </div>
        {state?.phase === "loading" && (
          <div>
            <p className="muted small">
              {t("viewer.recordingAnalytics.extracting", { pct: Math.round(state.progress * 100) })}
            </p>
            <progress max={1} value={state.progress} style={{ width: "100%" }} />
          </div>
        )}
        {state?.phase === "error" && (
          <p className="notice">{t("viewer.recordingAnalytics.failed", { error: state.message })}</p>
        )}
      </section>
      {state?.phase === "done" && (
        <SingleFileDashboard analytics={state.analytics} onShowOnMap={onShowOnMap} />
      )}
    </>
  );
}

function SingleFileDashboard({
  analytics,
  onShowOnMap,
}: {
  analytics: FileAnalytics;
  onShowOnMap?: (e: MissileEngagement) => void;
}) {
  const { t } = useTranslation();
  const files = useMemo(() => [analytics], [analytics]);
  // One recording on its own: nothing to pollute, so a BVR Trainer fight shows its own shots.
  const dash = useAnalyticsDashboard(files, SINGLE_FILE_QUERY);
  if (analytics.engagements.length === 0) {
    return (
      <section className="card">
        <p className="muted">{t("viewer.recordingAnalytics.noLaunches")}</p>
      </section>
    );
  }
  return (
    <div className="viewer-analytics">
      <AnalyticsPanels dash={dash} singleFile onShowOnMap={onShowOnMap} />
    </div>
  );
}
