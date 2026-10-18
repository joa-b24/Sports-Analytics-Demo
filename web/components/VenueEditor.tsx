"use client";

import { Check, Minus, Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { SatelliteFit } from "@/components/SatelliteFit";
import { btn, btnPrimary, input } from "@/components/Shell";
import type { VenueSpec } from "@/lib/types";
import { DEFAULT_HASH_M, buildVenue, type Venue } from "@/lib/venue";

const PAINTS: [string, string][] = [
  ["Blanco", "#f8fafc"],
  ["Amarillo", "#facc15"],
  ["Azul", "#60a5fa"],
  ["Rojo", "#f87171"],
];

// Top view of a venue model, with its own paint colours.
export function VenueDiagram({ venue, className = "" }: { venue: Venue; className?: string }) {
  const b = venue.bounds;
  return (
    <svg viewBox={`${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`} className={`w-full rounded-2xl bg-pitch ${className}`}>
      {venue.lines.map((l, n) => (
        <polyline
          key={n}
          // Rounded to the millimetre: the server and the browser can differ in the last digit of a cosine.
          points={l.pts.map((p) => p.map((v) => v.toFixed(3)).join(",")).join(" ")}
          fill="none"
          stroke={l.group === "football" ? venue.colors.football : venue.colors.soccer}
          strokeWidth={l.group === "football" ? 0.22 : 0.32}
          opacity={l.group === "football" ? 0.7 : 1}
        />
      ))}
    </svg>
  );
}

// A number with − / + buttons for fine adjustment (one step each; with Shift, ten).
function Num({ label, value, onChange, step = 0.1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const by = (e: React.MouseEvent, sign: number) => onChange(Number((value + sign * step * (e.shiftKey ? 10 : 1)).toFixed(digits)));
  return (
    <label className="flex flex-col gap-1 text-[11px] text-faint">
      {label}
      <span className="flex items-center gap-1">
        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label={`${label}: −${step}`} title={`−${step} (con Mayús, −${step * 10})`} onClick={(e) => by(e, -1)}>
          <Minus size={12} />
        </button>
        <input
          className={`${input} tc w-24`}
          type="number"
          step={step}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
        />
        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label={`${label}: +${step}`} title={`+${step} (con Mayús, +${step * 10})`} onClick={(e) => by(e, 1)}>
          <Plus size={12} />
        </button>
      </span>
    </label>
  );
}

function Paint({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1 text-[11px] text-faint">
      {label}
      <div className="flex items-center gap-1.5">
        {PAINTS.map(([name, hex]) => (
          <button
            key={hex}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={value === hex}
            onClick={() => onChange(hex)}
            className={`h-7 w-7 rounded-full transition-shadow ${value === hex ? "shadow-[0_0_0_2px_var(--color-bg),0_0_0_4px_var(--color-accent)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}
            style={{ background: hex }}
          />
        ))}
        <input type="color" aria-label={`${label}: otro color`} className="h-7 w-9 cursor-pointer rounded-lg bg-transparent" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

type Props = { initial: VenueSpec; isNew: boolean; onSave: (spec: VenueSpec) => void; onCancel: () => void };

export function VenueEditor({ initial, isNew, onSave, onCancel }: Props) {
  const [spec, setSpec] = useState<VenueSpec>(initial);
  const set = (p: Partial<VenueSpec>) => setSpec((s) => ({ ...s, ...p }));
  const overlay = spec.kind === "football_overlay";
  const valid = spec.name.trim() !== "" && spec.length_m >= 40 && spec.length_m <= 130 && spec.width_m >= 30 && spec.width_m <= 100;

  return (
    <div className="space-y-5">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <div className="space-y-5">
          <label className="flex flex-col gap-1 text-[11px] text-faint">
            Nombre de la sede
            <input className={`${input} w-full max-w-md`} value={spec.name} onChange={(e) => set({ name: e.target.value })} />
          </label>

          <div className="flex flex-col gap-1 text-[11px] text-faint">
            Qué hay pintado
            <div className="seg self-start">
              <button type="button" className="seg-opt" aria-pressed={!overlay} onClick={() => set({ kind: "soccer" })}>
                Solo fútbol
              </button>
              <button type="button" className="seg-opt" aria-pressed={overlay} onClick={() => set({ kind: "football_overlay" })}>
                Fútbol sobre campo de americano
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <Num label="Largo de la cancha (m)" value={spec.length_m} step={0.05} onChange={(v) => set({ length_m: v })} />
            <Num label="Ancho de la cancha (m)" value={spec.width_m} step={0.05} onChange={(v) => set({ width_m: v })} />
          </div>

          {overlay && (
            <div className="space-y-3 rounded-2xl bg-bg/50 p-4">
              <p className="text-xs text-pretty text-muted">
                Rejilla de americano: las líneas de yarda y las bandas son reglamentarias y no se editan. Sí cambian de una sede a otra dónde
                quedan las marcas interiores y si la cancha de fútbol está centrada sobre el campo.
              </p>
              <div className="flex flex-wrap gap-4">
                <Num label="Marcas lejanas: m desde su banda" value={spec.hash_far_m ?? DEFAULT_HASH_M} step={0.05} onChange={(v) => set({ hash_far_m: v })} />
                <Num label="Marcas cercanas: m desde su banda" value={spec.hash_near_m ?? DEFAULT_HASH_M} step={0.05} onChange={(v) => set({ hash_near_m: v })} />
              </div>
              <div className="flex flex-wrap gap-4">
                <Num label="Rejilla desplazada a lo largo (m)" value={spec.grid_dx_m ?? 0} step={0.05} onChange={(v) => set({ grid_dx_m: v })} />
                <Num label="Rejilla desplazada a lo ancho (m)" value={spec.grid_dy_m ?? 0} step={0.05} onChange={(v) => set({ grid_dy_m: v })} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-6">
            <Paint label="Color de las líneas de fútbol" value={spec.soccer_color} onChange={(v) => set({ soccer_color: v })} />
            {overlay && <Paint label="Color de la rejilla de americano" value={spec.grid_color} onChange={(v) => set({ grid_color: v })} />}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] text-faint">Vista previa del modelo · banda cercana abajo</div>
          <VenueDiagram venue={buildVenue(spec)} />
          <p className="mt-2 text-xs text-pretty text-faint">
            Áreas, círculo y punto penal usan las medidas reglamentarias. Los puntos de referencia para calibrar salen de este modelo.
          </p>
        </div>
      </div>

      <SatelliteFit spec={spec} onUse={(length_m, width_m) => set({ length_m, width_m })} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} disabled={!valid} onClick={() => onSave({ ...spec, name: spec.name.trim() })}>
          <Check size={15} />
          {isNew ? "Guardar sede" : "Guardar cambios"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Cancelar
        </button>
        {!valid && <span className="text-xs text-warn">Falta el nombre, o las medidas no son las de una cancha (largo 40–130 m, ancho 30–100 m).</span>}
      </div>
    </div>
  );
}
