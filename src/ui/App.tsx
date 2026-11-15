import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSample, SAMPLES, sampleFromUrl } from "../samples.ts";
import { type ParseOutcome, parseInWorker } from "../worker/client.ts";
import { type CachedFile, forgetLastFile, loadLastFile, saveLastFile } from "./lastFile.ts";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SiteFooter } from "./SiteFooter.tsx";
import { Summary } from "./Summary.tsx";

type State =
  | { phase: "idle" }
  | { phase: "loading"; name: string; progress: number }
  | { phase: "done"; name: string; file: Blob; outcome: ParseOutcome; restored: CachedFile["source"] | null }
  | { phase: "error"; name: string; message: string };

export function App() {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);

  /**
   * Opens a recording. Every file opened here is also kept in this browser as "the last file", so a
   * refresh reopens it; `restored` marks one that came back from that cache (it is not saved again).
   */
  const open = useCallback(async (file: Blob, name: string, restored: CachedFile["source"] | null = null) => {
    cancelRef.current?.();
    setState({ phase: "loading", name, progress: 0 });
    const job = parseInWorker(file, name, (progress) =>
      setState((s) => (s.phase === "loading" && s.name === name ? { ...s, progress } : s)),
    );
    cancelRef.current = job.cancel;
    try {
      const outcome = await job.promise;
      setState({ phase: "done", name, file, outcome, restored });
      if (!restored) void saveLastFile(file, name, "viewer");
    } catch (err) {
      setState({ phase: "error", name, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (cancelRef.current === job.cancel) cancelRef.current = null;
    }
  }, []);

  const openSample = useCallback(
    async (id: string) => {
      const s = SAMPLES.find((x) => x.id === id);
      if (!s) return;
      try {
        open(await fetchSample(s), s.originalName);
      } catch (err) {
        setState({ phase: "error", name: s.originalName, message: String(err) });
      }
    },
    [open],
  );

  // On load: an explicit ?sample=<id> wins; otherwise reopen the last file viewed in this browser
  // (also how the BVR trainer hands over a fight); otherwise the dev-mode default sample.
  useEffect(() => {
    let cancelled = false;
    const explicit = new URLSearchParams(window.location.search).has("sample");
    void (async () => {
      const cached = explicit ? null : await loadLastFile();
      if (cancelled) return;
      if (cached) void open(cached.blob, cached.name, cached.source);
      else {
        const s = sampleFromUrl(window.location.search);
        if (s) void openSample(s.id);
      }
    })();
    return () => {
      cancelled = true;
      cancelRef.current?.();
    };
  }, [open, openSample]);

  const closeFile = useCallback(() => {
    cancelRef.current?.();
    setState({ phase: "idle" });
    void forgetLastFile();
  }, []);

  // Accept drops anywhere in the window.
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
      const f = e.dataTransfer?.files[0];
      if (f) void open(f, f.name);
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
  }, [open]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>ACMI Viewer</h1>
        <div className="actions">
          <button type="button" onClick={() => fileInput.current?.click()}>
            Open file…
          </button>
          <button type="button" className="secondary" onClick={() => void openSample("default")}>
            Load sample
          </button>
          <button
            type="button"
            className="secondary"
            aria-haspopup="dialog"
            onClick={() => settingsDialog.current?.showModal()}
          >
            Settings
          </button>
          {state.phase === "done" && (
            <button
              type="button"
              className="secondary"
              onClick={closeFile}
              title="Close this file and forget it, so a refresh does not reopen it"
            >
              Close &amp; forget
            </button>
          )}
          <a href="./game.html" className="nav-link-btn" title="Open the BVR trainer game">
            BVR Trainer
          </a>
          <a href="./analytics.html" className="nav-link-btn" title="Open the multi-recording Analytics page">
            Multi-File Analytics →
          </a>
          <input
            ref={fileInput}
            type="file"
            accept=".acmi,.zip,.txt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f, f.name);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      <main>
        {state.phase === "idle" && (
          <div className="empty">
            <p className="big">Drop a Tacview .acmi file anywhere on this page</p>
            <p className="muted">
              Zipped and plain-text recordings are both supported. The file is read in your browser and never
              uploaded.
            </p>
            <p className="muted">
              The last file you open is kept in this browser, so refreshing the page reopens it.
            </p>
          </div>
        )}
        {state.phase === "loading" && (
          <div className="loading">
            <p>
              Reading <strong>{state.name}</strong>
            </p>
            <progress max={1} value={state.progress} />
          </div>
        )}
        {state.phase === "error" && (
          <div className="error">
            <p>
              Could not read <strong>{state.name}</strong>
            </p>
            <p>{state.message}</p>
          </div>
        )}
        {state.phase === "done" && state.restored && (
          <p className="restored-note muted">
            {state.restored === "game"
              ? "Fight sent from the BVR Trainer, kept in this browser."
              : "Reopened the last file you viewed (kept in this browser)."}{" "}
            <button type="button" className="link-button" onClick={closeFile}>
              Forget it
            </button>
          </p>
        )}
        {state.phase === "done" && <Summary name={state.name} file={state.file} outcome={state.outcome} />}
      </main>

      <SiteFooter />

      <dialog ref={settingsDialog} className="settings-dialog" aria-label="View settings">
        <SettingsPanel onClose={() => settingsDialog.current?.close()} />
      </dialog>

      {dragging && (
        <div className="drop-overlay">
          <p>Drop to open</p>
        </div>
      )}
    </div>
  );
}
