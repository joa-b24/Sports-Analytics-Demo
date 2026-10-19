"use client";

import { BracketsSquare, Minus, Plus } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { fmtT } from "@/lib/format";

// Start and end of a play or a clip, each editable: typed (m:ss, m:ss.s or seconds), nudged with − / + (half a second;
// with Shift, a tenth) or set to the moment on screen.

const MIN_S = 0.5;

// "1:05.5", "65.5" or "1:05" -> seconds; null when it is not a time.
export function parseTime(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3 || parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
// The time with its tenth: 0:04:05.3.
const fmt = (v: number) => `${fmtT(v)}.${Math.floor(Math.round(v * 10) % 10)}`;

function Edge({ label, value, now, min, max, onChange, here }: { label: string; value: number; now: number; min: number; max: number; onChange: (v: number) => void; here: "start" | "end" }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc leaves the field without applying what was typed.
  const cancelled = useRef(false);
  const clamp = (v: number) => r1(Math.min(max, Math.max(min, v)));
  const commit = () => {
    if (draft === null || cancelled.current) {
      cancelled.current = false;
      return setDraft(null);
    }
    const v = parseTime(draft);
    if (v !== null) onChange(clamp(v));
    setDraft(null);
  };
  const nudge = (e: React.MouseEvent, sign: number) => onChange(clamp(value + sign * (e.shiftKey ? 0.1 : 0.5)));
  const btn = "grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink";
  return (
    <span className="flex items-center gap-0.5 rounded-lg bg-bg/50 py-0.5 pr-0.5 pl-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <span className="mr-1 text-[11px] text-faint">{label}</span>
      <button type="button" className={btn} aria-label={`${label}: medio segundo antes`} title="Medio segundo antes (con Mayús, una décima)" onClick={(e) => nudge(e, -1)}>
        <Minus size={11} />
      </button>
      <input
        className="tc w-[5.25rem] rounded bg-transparent px-1 text-center text-xs text-ink outline-none focus:bg-raised"
        aria-label={label}
        value={draft ?? fmt(value)}
        onFocus={(e) => {
          setDraft(fmt(value));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
      />
      <button type="button" className={btn} aria-label={`${label}: medio segundo después`} title="Medio segundo después (con Mayús, una décima)" onClick={(e) => nudge(e, 1)}>
        <Plus size={11} />
      </button>
      <button type="button" className={btn} aria-label={`${label} en el momento del video`} title={`${label} en el momento del video (${fmt(now)})`} onClick={() => onChange(clamp(now))}>
        <BracketsSquare size={13} className={here === "start" ? "-scale-x-100" : ""} />
      </button>
    </span>
  );
}

export function TimeRange({ start, end, now, onChange, className = "" }: { start: number; end: number; now: number; onChange: (p: { t_start?: number; t_end?: number }) => void; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <Edge label="Inicio" here="start" value={start} now={now} min={0} max={end - MIN_S} onChange={(v) => onChange({ t_start: v })} />
      <Edge label="Fin" here="end" value={end} now={now} min={start + MIN_S} max={Number.MAX_SAFE_INTEGER} onChange={(v) => onChange({ t_end: v })} />
      <span className="tc text-xs text-faint">{r1(end - start)} s</span>
    </div>
  );
}
