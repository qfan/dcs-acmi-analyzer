import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cloneParams,
  DEFAULT_PARAMS,
  type GameParams,
  mergeParams,
  PARAM_FIELDS,
  type ParamField,
} from "../sim/params.ts";

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
function fromDraft(d: Draft, base: GameParams, t: TFunction): { params: GameParams; errors: string[] } {
  const p = cloneParams(base);
  const errors: string[] = [];
  for (const f of PARAM_FIELDS) {
    const raw = d[keyOf(f)];
    const dst = p[f.group] as unknown as Record<string, unknown>;
    if (f.kind === "bool") dst[f.key] = !!raw;
    else if (f.kind === "select") dst[f.key] = String(raw);
    else if (f.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n) || String(raw).trim() === "") errors.push(f.label);
      else if (f.int && !Number.isInteger(n)) errors.push(`${f.label} (${t("game.params.wholeNumber")})`);
      else if (f.min !== undefined && n < f.min) errors.push(`${f.label} (≥ ${f.min})`);
      else if (f.max !== undefined && n > f.max) errors.push(`${f.label} (≤ ${f.max})`);
      else dst[f.key] = n;
    } else {
      const arr = String(raw)
        .split(/[,\s]+/)
        .filter((s) => s !== "")
        .map(Number);
      const want = (dst[f.key] as number[]).length;
      const min = f.min;
      if (arr.length !== want || !arr.every(Number.isFinite)) {
        errors.push(`${f.label} (${t("game.params.needsNumbers", { count: want })})`);
      } else if (min !== undefined && arr.some((x) => x < min)) errors.push(`${f.label} (each ≥ ${min})`);
      else dst[f.key] = arr;
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
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => toDraft(params));
  const [errors, setErrors] = useState<string[]>([]);
  const [json, setJson] = useState<string | null>(null);

  const save = () => {
    const r = fromDraft(draft, params, t);
    setErrors(r.errors);
    if (r.errors.length === 0) onSave(r.params);
  };

  const groups = ["missile", "aircraft", "radar", "countermeasures"] as const;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Escape does too
    <div className="g-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="g-modal g-params" role="dialog" aria-label={t("game.params.aria")}>
        <h2>{t("game.params.title")}</h2>
        <p className="g-muted">{t("game.params.intro")}</p>
        <div className="g-params-grid">
          {groups.map((g) => (
            <fieldset key={g}>
              <legend>{t(`game.params.groups.${g}`)}</legend>
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
        {errors.length > 0 && (
          <p className="g-error">{t("game.params.checkErrors", { errors: errors.join(", ") })}</p>
        )}
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
                  setErrors([t("game.params.jsonInvalid")]);
                }
              }}
            >
              {t("game.params.loadJsonBtn")}
            </button>
          </div>
        )}
        <div className="g-row g-end">
          <button
            type="button"
            onClick={() => setJson(JSON.stringify(fromDraft(draft, params, t).params, null, 2))}
          >
            {t("game.params.exportImportJsonBtn")}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(toDraft(DEFAULT_PARAMS));
              setErrors([]);
            }}
          >
            {t("game.params.resetDefaultsBtn")}
          </button>
          <span className="g-grow" />
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="g-primary" onClick={save}>
            {t("game.params.saveBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
