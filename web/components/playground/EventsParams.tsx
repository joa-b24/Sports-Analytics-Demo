"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Card } from "@/components/Shell";
import { EVENT_DEFAULTS, ruleVersion, type DetectedType, type EventParams } from "@/lib/eventDetect";
import { TYPE_HELP, TYPE_LABEL, changedKeys, clampEventParam, fieldsOfType, type EventParamField } from "@/lib/eventReview";

const fmt = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 2 });

// A number that can be typed ("0.3" passes through "0." without jumping): commits every valid value, clamped to its field.
function NumField({ field, value, onChange }: { field: EventParamField; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const def = EVENT_DEFAULTS[field.key] as number;
  return (
    <label className="block text-[11px] text-muted" title={field.help}>
      <span className="block truncate">{field.label}</span>
      <span className="mt-0.5 flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          className="input tc w-20 !py-1 text-xs"
          min={field.min}
          max={field.max}
          step={field.step}
          value={draft ?? String(value)}
          aria-label={`${field.label}${field.unit ? ` (${field.unit})` : ""}`}
          onFocus={() => setDraft(String(value))}
          onBlur={() => setDraft(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim() === "") return;
            const v = clampEventParam(field, Number(e.target.value), value);
            if (v !== value) onChange(v);
          }}
        />
        <span className="text-faint">{field.unit}</span>
        {value !== def && <span className="tag tag-accent">defecto {fmt(def)}</span>}
      </span>
    </label>
  );
}

// Parameters of the rule of one type: the detections are recalculated at once when one changes. A rule that changes gets a
// new version, and the reviews given to the old one stop counting.
export function EventsParamsCard({ type, params, onChange, busy }: { type: DetectedType; params: EventParams; onChange: (p: EventParams) => void; busy: boolean }) {
  const [all, setAll] = useState(false);
  const fields = fieldsOfType(type);
  const main = fields.filter((f) => f.main);
  const rest = fields.filter((f) => !f.main);
  const changed = changedKeys(params, type);
  const set = (f: EventParamField) => (v: number) => onChange({ ...params, [f.key]: v });
  const reset = () => onChange({ ...params, ...Object.fromEntries(fields.map((f) => [f.key, EVENT_DEFAULTS[f.key]])) });
  const grid = (list: EventParamField[]) => (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 xl:grid-cols-3">
      {list.map((f) => (
        <NumField key={f.key} field={f} value={params[f.key] as number} onChange={set(f)} />
      ))}
    </div>
  );
  return (
    <Card title={`Regla: ${TYPE_LABEL[type]}`} note={busy ? "Recalculando…" : `versión ${ruleVersion(type, params)}`} className="flex h-full flex-col !p-3">
      <p className="mb-2 text-[11px] text-pretty text-muted">{TYPE_HELP[type]}</p>
      {grid(main)}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {rest.length > 0 && (
          <button type="button" className="btn btn-ghost !px-2 !py-1 text-[11px]" onClick={() => setAll(true)}>
            Más parámetros ({rest.length})
          </button>
        )}
        <button type="button" className="btn !px-2 !py-1 text-[11px]" disabled={changed.length === 0} onClick={reset}>
          <ArrowCounterClockwise size={13} />
          Restablecer
        </button>
        <span className="text-[11px] text-faint">{changed.length ? `${changed.length} distinto${changed.length > 1 ? "s" : ""} del defecto.` : "Valores por defecto."}</span>
      </div>
      {all && (
        <Modal title={`Todos los parámetros: ${TYPE_LABEL[type]}`} wide onClose={() => setAll(false)}>
          <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {fields.map((f) => (
              <NumField key={f.key} field={f} value={params[f.key] as number} onChange={set(f)} />
            ))}
          </div>
          <button type="button" className="btn" disabled={changed.length === 0} onClick={reset}>
            <ArrowCounterClockwise size={14} />
            Restablecer
          </button>
        </Modal>
      )}
    </Card>
  );
}
