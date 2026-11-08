import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSample, SAMPLES, sampleFromUrl } from "../samples.ts";
import { type ParseOutcome, parseInWorker } from "../worker/client.ts";
import { Summary } from "./Summary.tsx";

type State =
  | { phase: "idle" }
  | { phase: "loading"; name: string; progress: number }
  | { phase: "done"; name: string; outcome: ParseOutcome }
  | { phase: "error"; name: string; message: string };

export function App() {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const open = useCallback(async (file: Blob, name: string) => {
    cancelRef.current?.();
    setState({ phase: "loading", name, progress: 0 });
    const job = parseInWorker(file, name, (progress) =>
      setState((s) => (s.phase === "loading" && s.name === name ? { ...s, progress } : s)),
    );
    cancelRef.current = job.cancel;
    try {
      const outcome = await job.promise;
      setState({ phase: "done", name, outcome });
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

  // Auto-load the built-in sample (dev mode, or ?sample=<id>).
  useEffect(() => {
    const s = sampleFromUrl(window.location.search);
    if (s) void openSample(s.id);
    return () => cancelRef.current?.();
  }, [openSample]);

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
        {state.phase === "done" && <Summary name={state.name} outcome={state.outcome} />}
      </main>

      {dragging && (
        <div className="drop-overlay">
          <p>Drop to open</p>
        </div>
      )}
    </div>
  );
}
