"use client";

import { Gauge } from "@phosphor-icons/react";
import { useState } from "react";

const PRESETS = [0.25, 0.5, 1, 1.5, 2, 3, 5];

type Props = {
  rate: number;
  onChange: (rate: number) => void;
  // Smallest step of the slider. YouTube only plays at multiples of 0.25.
  step?: number;
  min?: number;
  // Fastest speed offered. A local file takes up to x5; YouTube stops at x2.
  max?: number;
};

// Playback speed: a button with the current value; the slider only appears after clicking it.
export function SpeedControl({ rate, onChange, step = 0.05, min = 0.1, max = 5 }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className={`btn ${rate !== 1 ? "btn-primary" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Velocidad de reproducción"
        onClick={() => setOpen((o) => !o)}
      >
        <Gauge size={15} />
        <span className="tc">{rate.toFixed(2).replace(/0$/, "")}×</span>
      </button>
      {open && (
        <>
          <button type="button" aria-label="Cerrar velocidad" className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Velocidad de reproducción"
            className="enter absolute right-0 bottom-full z-30 mb-2 w-64 rounded-2xl bg-raised p-4 shadow-[0_0_0_1px_var(--color-line-strong),0_18px_40px_-12px_rgba(0,0,0,.7)]"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted">Velocidad</span>
              <span className="num text-3xl text-ink">{rate.toFixed(2)}×</span>
            </div>
            <input
              type="range"
              aria-label="Velocidad de reproducción"
              className="mt-3 w-full"
              min={min}
              max={max}
              step={step}
              value={rate}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <div className="mt-3 flex flex-wrap gap-1.5">
              {PRESETS.filter((r) => r >= min && r <= max).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={rate === r}
                  onClick={() => onChange(r)}
                  className={`tc rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                    rate === r ? "bg-accent/25 text-accent-100 shadow-[inset_0_0_0_1px_var(--color-accent)]" : "bg-bg/60 text-muted hover:text-ink"
                  }`}
                >
                  {r}×
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
