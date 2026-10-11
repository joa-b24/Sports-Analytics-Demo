"use client";

import { Check, ImageSquare, Ruler } from "@phosphor-icons/react";
import { useState } from "react";
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
          points={l.pts.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke={l.group === "football" ? venue.colors.football : venue.colors.soccer}
          strokeWidth={l.group === "football" ? 0.22 : 0.32}
          opacity={l.group === "football" ? 0.7 : 1}
        />
      ))}
    </svg>
  );
}

type Seg = [[number, number], [number, number]];
type Mode = "scale" | "length" | "width";
const MODES: { id: Mode; label: string; color: string }[] = [
  { id: "scale", label: "Escala", color: "#fde047" },
  { id: "length", label: "Largo", color: "#22d3ee" },
  { id: "width", label: "Ancho", color: "#f0abfc" },
];
const dist = (s: Seg) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);

// Measures the pitch on a satellite image: two clicks on the scale bar, two along the length, two across the width.
// The image stays in this browser tab; only the resulting meters are kept.
function SatelliteMeasure({ onUse }: { onUse: (length_m: number, width_m: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<Mode>("scale");
  const [segs, setSegs] = useState<Partial<Record<Mode, Seg>>>({});
  const [pending, setPending] = useState<[number, number] | null>(null);
  const [scaleM, setScaleM] = useState(20);

  const pxPerM = segs.scale && scaleM > 0 ? dist(segs.scale) / scaleM : null;
  const length = pxPerM && segs.length ? dist(segs.length) / pxPerM : null;
  const width = pxPerM && segs.width ? dist(segs.width) / pxPerM : null;
  const r = size ? size.w / 220 : 4;

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!size) return;
    const box = e.currentTarget.getBoundingClientRect();
    const p: [number, number] = [((e.clientX - box.left) / box.width) * size.w, ((e.clientY - box.top) / box.height) * size.h];
    if (!pending) return setPending(p);
    setSegs((s) => ({ ...s, [mode]: [pending, p] }));
    setPending(null);
    // Move on to the next measurement that is still missing.
    const next = MODES.find((m) => m.id !== mode && !segs[m.id]);
    if (next) setMode(next.id);
  };

  return (
    <div className="rounded-2xl bg-bg/50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Ruler size={16} className="text-accent-300" />
        <span className="text-sm text-ink-2">Medir sobre una imagen satelital</span>
        <label className={`${btn} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
          <ImageSquare size={15} />
          {url ? "Cambiar imagen" : "Elegir imagen"}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (url) URL.revokeObjectURL(url);
              setUrl(URL.createObjectURL(f));
              setSize(null);
              setSegs({});
              setPending(null);
              setMode("scale");
            }}
          />
        </label>
      </div>
      {!url ? (
        <p className="mt-2 text-xs text-pretty text-faint">
          Una captura de un mapa satelital que incluya la barra de escala. La imagen no se guarda ni se sube: solo se usan las medidas.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="seg">
              {MODES.map((m) => (
                <button key={m.id} type="button" aria-pressed={mode === m.id} className="seg-opt inline-flex items-center gap-1.5" onClick={() => { setMode(m.id); setPending(null); }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                  {m.label}
                  {segs[m.id] && <Check size={12} />}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              La barra de escala mide
              <input className={`${input} tc w-20`} type="number" min={0} step="any" value={scaleM} onChange={(e) => setScaleM(Number(e.target.value))} />m
            </label>
          </div>
          <p className="mt-2 text-xs text-faint">
            {pending
              ? "Ahora el segundo extremo."
              : mode === "scale"
                ? "Haz clic en los dos extremos de la barra de escala."
                : mode === "length"
                  ? "Haz clic en las dos líneas de meta, a lo largo de una banda."
                  : "Haz clic en las dos bandas, a lo largo de una línea de meta."}
          </p>
          <div className="relative mt-2 overflow-hidden rounded-xl">
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, nothing to optimise */}
            <img src={url} alt="Imagen satelital de la sede" className="block w-full" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
            {size && (
              <svg viewBox={`0 0 ${size.w} ${size.h}`} className="absolute inset-0 h-full w-full cursor-crosshair" onClick={onClick}>
                {MODES.map((m) => {
                  const s = segs[m.id];
                  return s ? (
                    <g key={m.id} stroke={m.color} fill={m.color}>
                      <line x1={s[0][0]} y1={s[0][1]} x2={s[1][0]} y2={s[1][1]} strokeWidth={r / 2} />
                      <circle cx={s[0][0]} cy={s[0][1]} r={r} />
                      <circle cx={s[1][0]} cy={s[1][1]} r={r} />
                    </g>
                  ) : null;
                })}
                {pending && <circle cx={pending[0]} cy={pending[1]} r={r} fill="none" stroke="#ffffff" strokeWidth={r / 2} />}
              </svg>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="num text-3xl text-ink-2">{pxPerM ? pxPerM.toFixed(2) : "–"}</div>
              <div className="mt-1 text-[11px] text-muted">px por metro</div>
            </div>
            <div>
              <div className="num text-3xl text-ink">{length ? length.toFixed(1) : "–"}</div>
              <div className="mt-1 text-[11px] text-muted">largo (m)</div>
            </div>
            <div>
              <div className="num text-3xl text-ink">{width ? width.toFixed(1) : "–"}</div>
              <div className="mt-1 text-[11px] text-muted">ancho (m)</div>
            </div>
            <button type="button" className={btnPrimary} disabled={!length || !width} onClick={() => length && width && onUse(Math.round(length * 10) / 10, Math.round(width * 10) / 10)}>
              Usar estas medidas
            </button>
          </div>
          <p className="mt-2 text-xs text-pretty text-faint">
            Medir sobre una captura tiene un error de alrededor del 2 %. Las medidas se confirman después con cuadros calibrados.
          </p>
        </>
      )}
    </div>
  );
}

function Num({ label, value, onChange, step = 0.1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-faint">
      {label}
      <input
        className={`${input} tc w-28`}
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
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
            <Num label="Largo de la cancha (m)" value={spec.length_m} onChange={(v) => set({ length_m: v })} />
            <Num label="Ancho de la cancha (m)" value={spec.width_m} onChange={(v) => set({ width_m: v })} />
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

      <SatelliteMeasure onUse={(length_m, width_m) => set({ length_m, width_m })} />

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
