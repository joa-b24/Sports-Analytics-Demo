"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useState } from "react";
import { PARAM_FIELDS, clampParam, type ParamField } from "@/lib/playgroundPossession";
import { POSSESSION_DEFAULTS } from "@/lib/possession";
import { mutate } from "@/lib/store";
import { TECH_GROUPS, possessionParamsOf, resetTech, techChanged, withTechParam } from "@/lib/tech";
import type { Match } from "@/lib/types";

const fmt = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 2 });
const patchMatch = (id: string, f: (m: Match) => Match) => mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === id ? f(m) : m)) }));

// A number that can be typed ("0.3" passes through "0." without jumping): commits every valid value, clamped to its field.
function NumField({ field, value, onChange }: { field: ParamField; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const def = POSSESSION_DEFAULTS[field.key] as number;
  return (
    <label className="block text-xs text-muted" title={field.help}>
      <span className="block">{field.label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          className="input tc w-24"
          min={field.min}
          max={field.max}
          step={field.step}
          value={draft ?? String(value)}
          aria-label={`${field.label} (${field.unit})`}
          onFocus={() => setDraft(String(value))}
          onBlur={() => setDraft(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim() === "") return;
            const v = clampParam(field, Number(e.target.value), value);
            if (v !== value) onChange(v);
          }}
        />
        <span className="text-faint">{field.unit}</span>
        <span className={value !== def ? "tag tag-accent" : "text-faint"}>por defecto {fmt(def)}</span>
      </span>
      <span className="mt-0.5 block text-[11px] text-faint">{field.help}</span>
    </label>
  );
}

// Configuración del partido > Detalles técnicos: the parameters the possession is computed with, grouped, with their
// defaults in view. They are saved per match (Match.tech) and everything that reads possession uses them (report, summary,
// Playground), so changing one changes the report.
export function TechPanel({ match }: { match: Match }) {
  const params = possessionParamsOf(match);
  const changed = techChanged(match);
  const set = (f: ParamField) => (v: number) => patchMatch(match.match_id, (m) => withTechParam(m, f.key, v));
  return (
    <div className="space-y-5 text-xs text-muted">
      <p className="m-0 text-sm text-pretty text-muted">
        Son los parámetros con los que se calcula la posesión de <span className="text-ink">{match.name}</span>. Se guardan en este partido y los usan el Informe, el
        Resumen y las herramientas de evaluación: si cambias uno, cambia el informe.
      </p>
      {TECH_GROUPS.map((g) => (
        <section key={g.id} aria-label={g.title}>
          <h3 className="m-0 text-sm font-semibold text-ink">{g.title}</h3>
          <p className="m-0 mb-2 text-faint">{g.help}</p>
          <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
            {g.keys.map((k) => {
              const f = PARAM_FIELDS.find((x) => x.key === k);
              return f ? <NumField key={k} field={f} value={params[k] as number} onChange={set(f)} /> : null;
            })}
            {g.id === "control" && (
              <label className="flex items-start gap-2 text-xs text-muted" title="Entre dos tramos de juego, el balón se sigue si no se movió mucho">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={params.joinSegments}
                  onChange={(e) => patchMatch(match.match_id, (m) => withTechParam(m, "joinSegments", e.target.checked))}
                />
                <span>
                  Unir tramos de juego cortados
                  <span className="mt-0.5 block text-[11px] text-faint">Por defecto: {POSSESSION_DEFAULTS.joinSegments ? "sí" : "no"}.</span>
                </span>
              </label>
            )}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3">
        <button type="button" className="btn" disabled={changed.length === 0} onClick={() => patchMatch(match.match_id, resetTech)}>
          <ArrowCounterClockwise size={14} />
          Restablecer
        </button>
        <span className="text-faint" aria-live="polite">
          {changed.length === 0 ? "Estás con los valores por defecto." : `${changed.length} parámetro${changed.length === 1 ? "" : "s"} distinto${changed.length === 1 ? "" : "s"} del defecto.`}
        </span>
      </div>
    </div>
  );
}
