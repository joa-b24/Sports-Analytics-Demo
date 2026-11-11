"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useState } from "react";

const fmt = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 3 });

// A setting of the match settings dialog: its name, the help under it and the control on the right, as in the settings of an
// editor. A value that is not the default is marked with a yellow bar on the left and a button that restores it (its title
// says what the default is), so there is no «por defecto» text to read.
function Row({ changed, title, help, children, onReset, defLabel }: { changed: boolean; title: string; help?: string; children: React.ReactNode; onReset: () => void; defLabel: string }) {
  return (
    <div className="relative rounded-md py-3 pr-3 pl-4 transition-colors hover:bg-bg/30" style={changed ? { background: "color-mix(in oklab, var(--color-warn) 7%, transparent)" } : undefined}>
      <i className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full transition-colors" style={{ background: changed ? "var(--color-warn)" : "transparent" }} aria-hidden />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink">{title}</div>
          {help && <p className="mt-0.5 mb-0 text-xs text-pretty text-faint">{help}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {children}
          <button
            type="button"
            className={`btn btn-ghost !p-1 ${changed ? "" : "invisible"}`}
            aria-label={`Restablecer ${title}`}
            title={`Restablecer (por defecto ${defLabel})`}
            tabIndex={changed ? 0 : -1}
            onClick={onReset}
          >
            <ArrowCounterClockwise size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// A number that can be typed ("0.3" passes through "0." without jumping): every valid value is committed, clamped.
export function TechNumber({
  label, help, unit, value, def, min, max, step, clamp, onChange,
}: {
  label: string;
  help?: string;
  unit?: string;
  value: number;
  def: number;
  min: number;
  max: number;
  step: number;
  clamp: (v: number, prev: number) => number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Row changed={value !== def} title={label} help={help} onReset={() => onChange(def)} defLabel={`${fmt(def)}${unit ? ` ${unit}` : ""}`}>
      <input
        type="number"
        inputMode="decimal"
        className="input tc w-24"
        min={min}
        max={max}
        step={step}
        value={draft ?? String(value)}
        aria-label={`${label}${unit ? ` (${unit})` : ""}`}
        onFocus={() => setDraft(String(value))}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value.trim() === "") return;
          const v = clamp(Number(e.target.value), value);
          if (v !== value) onChange(v);
        }}
      />
      {unit && <span className="w-8 text-xs text-faint">{unit}</span>}
    </Row>
  );
}

// An on / off setting: a switch at the right, with room around it.
export function TechSwitch({ label, help, checked, def, onChange, disabled }: { label: string; help?: string; checked: boolean; def: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row changed={checked !== def && !disabled} title={label} help={help} onReset={() => onChange(def)} defLabel={def ? "sí" : "no"}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-own" : "bg-line-strong"}`}
      >
        <i className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`} aria-hidden />
      </button>
    </Row>
  );
}
