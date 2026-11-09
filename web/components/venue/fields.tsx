"use client";

import { Minus, Plus } from "@phosphor-icons/react";

// Small form pieces shared by the venue editor: a titled panel, numbers with − / + and paint swatches.

export function Panel({ title, aside, children, className = "" }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-[10px] bg-surface p-3 ${className}`}>
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h3 className="tc text-[11px] tracking-[0.08em] text-faint uppercase">{title}</h3>
        {aside && <span className="text-[11px] text-faint">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

type NumProps = {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
  unit?: string;
  // Allows an empty field (a value not measured yet); otherwise empty keeps the last number.
  optional?: boolean;
  placeholder?: string;
  // While the field is being edited (to show which points of the model it moves).
  onFocus?: () => void;
};

// A number with − / + for fine adjustment (one step each; with Shift, ten).
export function Num({ label, value, onChange, step = 0.1, unit = "m", optional = false, placeholder = "—", onFocus }: NumProps) {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const by = (e: React.MouseEvent, sign: number) => {
    if (value === undefined) return;
    onChange(Number((value + sign * step * (e.shiftKey ? 10 : 1)).toFixed(digits)));
  };
  const stepBtn = "grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-30";
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] text-faint" onFocus={onFocus} onMouseEnter={onFocus}>
      <span className="truncate">{label}</span>
      <span className="flex items-center rounded-[7px] border border-line-strong bg-bg/40 transition-colors focus-within:border-accent">
        <button type="button" className={stepBtn} disabled={value === undefined} aria-label={`${label}: −${step}`} title={`−${step} (con Mayús, −${step * 10})`} onClick={(e) => by(e, -1)}>
          <Minus size={11} />
        </button>
        <input
          className="tc min-w-0 flex-1 bg-transparent py-1 text-center text-[15px] text-ink outline-none placeholder:text-faint"
          type="number"
          step={step}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => {
            if (e.target.value === "") return optional ? onChange(undefined) : undefined;
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
        />
        <span className="pr-0.5 text-[10px] text-faint">{unit}</span>
        <button type="button" className={stepBtn} disabled={value === undefined} aria-label={`${label}: +${step}`} title={`+${step} (con Mayús, +${step * 10})`} onClick={(e) => by(e, 1)}>
          <Plus size={11} />
        </button>
      </span>
    </label>
  );
}

export const PAINTS: [string, string][] = [
  ["Blanco", "#f8fafc"],
  ["Amarillo", "#facc15"],
  ["Azul", "#60a5fa"],
  ["Rojo", "#f87171"],
];

export function Paint({ label, value, onChange, paints = PAINTS }: { label: string; value: string; onChange: (v: string) => void; paints?: [string, string][] }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] text-faint">
      <span className="min-w-0 truncate">{label}</span>
      <div className="flex items-center gap-1.5">
        {paints.map(([name, hex]) => (
          <button
            key={hex}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={value === hex}
            onClick={() => onChange(hex)}
            className={`h-5 w-5 rounded-full transition-shadow ${value === hex ? "shadow-[0_0_0_2px_var(--color-surface),0_0_0_3.5px_var(--color-accent)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}
            style={{ background: hex }}
          />
        ))}
        <input type="color" aria-label={`${label}: otro color`} title="Otro color" className="h-5 w-6 cursor-pointer rounded bg-transparent" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}
