import { useState } from "react";
import {
  cloneParams,
  DEFAULT_PARAMS,
  type GameParams,
  mergeParams,
  PARAM_FIELDS,
  type ParamField,
} from "../sim/params.ts";

const GROUP_TITLES: Record<keyof GameParams, string> = {
  missile: "Missile",
  aircraft: "Aircraft",
  radar: "Radar",
};

type Draft = Record<string, string | boolean>;

const keyOf = (f: ParamField) => `${f.group}.${f.key}`;

function toDraft(p: GameParams): Draft {
  const d: Draft = {};
  for (const f of PARAM_FIELDS) {
    const v = (p[f.group] as unknown as Record<string, unknown>)[f.key];
    if (f.kind === "bool") d[keyOf(f)] = !!v;
    else if (f.kind === "numbers") d[keyOf(f)] = (v as number[]).join(", ");
    else d[keyOf(f)] = String(v);
  }
  return d;
}

/** Turns the form back into parameters; returns the fields that do not parse. */
function fromDraft(d: Draft, base: GameParams): { params: GameParams; errors: string[] } {
  const p = cloneParams(base);
  const errors: string[] = [];
  for (const f of PARAM_FIELDS) {
    const raw = d[keyOf(f)];
    const dst = p[f.group] as unknown as Record<string, unknown>;
    if (f.kind === "bool") dst[f.key] = !!raw;
    else if (f.kind === "select") dst[f.key] = String(raw);
    else if (f.kind === "number") {
      const n = Number(raw);
      if (Number.isFinite(n) && String(raw).trim() !== "") dst[f.key] = n;
      else errors.push(f.label);
    } else {
      const arr = String(raw)
        .split(/[,\s]+/)
        .filter((s) => s !== "")
        .map(Number);
      const want = (dst[f.key] as number[]).length;
      if (arr.length === want && arr.every(Number.isFinite)) dst[f.key] = arr;
      else errors.push(`${f.label} (needs ${want} numbers)`);
    }
  }
  return { params: p, errors };
}

export function ParamEditor({
  params,
  onSave,
  onClose,
}: {
  params: GameParams;
  onSave: (p: GameParams | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(params));
  const [errors, setErrors] = useState<string[]>([]);
  const [json, setJson] = useState<string | null>(null);

  const save = () => {
    const r = fromDraft(draft, params);
    setErrors(r.errors);
    if (r.errors.length === 0) onSave(r.params);
  };

  const groups = ["missile", "aircraft", "radar"] as const;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Escape does too
    <div className="g-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="g-modal g-params" role="dialog" aria-label="Game parameters">
        <h2>Parameters</h2>
        <p className="g-muted">
          Rough estimates of the F/A-18C and AIM-120C, close to what the analyzer measures in DCS. Change
          anything; the launch zone uses the same model, so it follows. Changes apply when a scenario starts
          or restarts, and are kept in this browser.
        </p>
        <div className="g-params-grid">
          {groups.map((g) => (
            <fieldset key={g}>
              <legend>{GROUP_TITLES[g]}</legend>
              {PARAM_FIELDS.filter((f) => f.group === g).map((f) => {
                const k = keyOf(f);
                const v = draft[k];
                return (
                  // biome-ignore lint/a11y/noLabelWithoutControl: every branch below renders an input or select inside the label
                  <label key={k} className="g-field">
                    <span>
                      {f.label}
                      {"unit" in f && f.unit ? <em> ({f.unit})</em> : null}
                    </span>
                    {f.kind === "bool" ? (
                      <input
                        type="checkbox"
                        checked={!!v}
                        onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })}
                      />
                    ) : f.kind === "select" ? (
                      <select value={String(v)} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>
                        {f.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        inputMode="decimal"
                        value={String(v)}
                        className={f.kind === "numbers" ? "g-wide" : ""}
                        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                      />
                    )}
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
        {errors.length > 0 && <p className="g-error">Check: {errors.join(", ")}</p>}
        {json !== null && (
          <div className="g-json">
            <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={8} spellCheck={false} />
            <button
              type="button"
              onClick={() => {
                try {
                  setDraft(toDraft(mergeParams(JSON.parse(json))));
                  setErrors([]);
                } catch {
                  setErrors(["the JSON could not be read"]);
                }
              }}
            >
              Load this JSON into the form
            </button>
          </div>
        )}
        <div className="g-row g-end">
          <button
            type="button"
            onClick={() => setJson(JSON.stringify(fromDraft(draft, params).params, null, 2))}
          >
            Export / import JSON
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(toDraft(DEFAULT_PARAMS));
              setErrors([]);
            }}
          >
            Reset to defaults
          </button>
          <span className="g-grow" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="g-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
