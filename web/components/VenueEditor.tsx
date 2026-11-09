"use client";

import { ArrowLeft, Check, Plus, X } from "@phosphor-icons/react";
import { useState } from "react";
import { FitStage } from "@/components/venue/FitStage";
import { ModelDrawing } from "@/components/venue/ModelDrawing";
import { Num, Paint, Panel } from "@/components/venue/fields";
import type { VenueSpec } from "@/lib/types";
import { DEFAULT_HASH_M, FOOTBALL_WIDTH_M, SOCCER_DEFAULTS, buildVenue, type Venue } from "@/lib/venue";

// The soccer markings that can differ from regulation, with the reference points each one moves.
const MARKINGS: [keyof typeof SOCCER_DEFAULTS, string, string][] = [
  ["box_depth_m", "Área grande · fondo", "boxes"],
  ["box_width_m", "Área grande · ancho", "boxes"],
  ["goal_area_depth_m", "Área chica · fondo", "boxes"],
  ["goal_area_width_m", "Área chica · ancho", "boxes"],
  ["penalty_spot_m", "Punto penal (desde la línea)", "boxes"],
  ["circle_r_m", "Radio del círculo central", "mid"],
];

// Top view of a venue model, with its own paint colours, goals and extra drawings. Fills its box, keeping proportions.
// The paint is usually white or yellow, so the light theme keeps a dark ground under it.
export function VenueDiagram({ venue, className = "", focus = null }: { venue: Venue; className?: string; focus?: string | null }) {
  const b = venue.bounds;
  // One screen pixel is about this many meters at the usual sizes; only the dots use it.
  const unit = (b.x1 - b.x0) / 420;
  return (
    <svg viewBox={`${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`} preserveAspectRatio="xMidYMid meet" className={`w-full rounded-[10px] bg-pitch [[data-theme=light]_&]:bg-ink ${className}`} role="img" aria-label={`Modelo de ${venue.name || "la sede"}`}>
      <ModelDrawing venue={venue} map={(p) => p} px={false} unit={unit} focus={focus} />
    </svg>
  );
}

type Props = { initial: VenueSpec; isNew: boolean; onSave: (spec: VenueSpec) => void; onCancel: () => void };

// One screen, no scroll: measures and colours on the left with the model preview under them; the image of the venue,
// with the model fitted over it, on the right.
export function VenueEditor({ initial, isNew, onSave, onCancel }: Props) {
  const [spec, setSpec] = useState<VenueSpec>(initial);
  const [focus, setFocus] = useState<string | null>(null);
  const set = (p: Partial<VenueSpec>) => setSpec((s) => ({ ...s, ...p }));
  const overlay = spec.kind === "football_overlay";
  const lengthOk = spec.length_m >= 40 && spec.length_m <= 130;
  const widthOk = spec.width_m >= 30 && spec.width_m <= 100;
  const valid = spec.name.trim() !== "" && lengthOk && widthOk;
  const venue = buildVenue(spec);
  const changed = JSON.stringify(spec) !== JSON.stringify(initial);
  const save = () => {
    const out: VenueSpec = { ...spec, name: spec.name.trim() };
    // Empty lists are left out, so a venue that never used them stays as it was.
    if (!out.layers?.length) delete out.layers;
    if (!out.checked?.length) delete out.checked;
    if (!out.ref_lines?.length) delete out.ref_lines;
    onSave(out);
  };

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-5.25rem)]">
      <header className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost" onClick={onCancel} title="Volver a las sedes sin guardar">
          <ArrowLeft size={15} />
          Sedes
        </button>
        <input
          className="min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-2 py-1 text-2xl text-ink outline-none placeholder:text-faint hover:border-line focus:border-accent"
          value={spec.name}
          placeholder="Nombre de la sede"
          aria-label="Nombre de la sede"
          autoFocus={isNew}
          onChange={(e) => set({ name: e.target.value })}
        />
        {!valid && (
          <span className="text-xs text-warn">
            {spec.name.trim() === "" ? "Falta el nombre." : "Las medidas no son las de una cancha (largo 40–130 m, ancho 30–100 m)."}
          </span>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary" disabled={!valid || (!isNew && !changed)} onClick={save}>
          <Check size={15} />
          {isNew ? "Guardar sede" : "Guardar cambios"}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
          <Panel title="Cancha" aside="metros reales">
            <div className="seg mb-3 flex w-full" role="group" aria-label="Qué hay pintado">
              <button type="button" className="seg-opt flex-1" aria-pressed={!overlay} onClick={() => set({ kind: "soccer" })}>
                Solo fútbol
              </button>
              <button type="button" className="seg-opt flex-1" aria-pressed={overlay} onClick={() => set({ kind: "football_overlay" })}>
                Sobre americano
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Num label="Largo" value={spec.length_m} step={0.05} onChange={(v) => v !== undefined && set({ length_m: v })} />
              <Num label="Ancho" value={spec.width_m} step={0.05} onChange={(v) => v !== undefined && set({ width_m: v })} />
            </div>
          </Panel>

          <Panel
            title="Marcas de fútbol"
            aside={
              MARKINGS.some(([k]) => spec[k] !== undefined) ? (
                <button
                  type="button"
                  className="link"
                  title="Volver a las medidas reglamentarias"
                  onClick={() => set(Object.fromEntries(MARKINGS.map(([k]) => [k, undefined])) as Partial<VenueSpec>)}
                >
                  reglamentarias
                </button>
              ) : (
                "reglamentarias"
              )
            }
          >
            <p className="mb-2 text-[11px] text-pretty text-faint">Los puntos de referencia salen de estas medidas: al pasar por un campo se resaltan los que mueve.</p>
            <div className="grid grid-cols-2 gap-2.5">
              {MARKINGS.map(([k, label, group]) => (
                <Num key={k} label={label} value={spec[k] ?? SOCCER_DEFAULTS[k]} step={0.05} onFocus={() => setFocus(group)} onChange={(v) => v !== undefined && set({ [k]: v === SOCCER_DEFAULTS[k] ? undefined : v })} />
              ))}
            </div>
          </Panel>

          {overlay && (
            <Panel title="Rejilla de americano" aside="yardas fijas">
              <div className="grid grid-cols-2 gap-2.5">
                <Num
                  label="Ancho entre bandas"
                  value={spec.football_width_m ?? Math.round(FOOTBALL_WIDTH_M * 100) / 100}
                  step={0.05}
                  onFocus={() => setFocus("yard")}
                  onChange={(v) => v !== undefined && set({ football_width_m: Math.abs(v - FOOTBALL_WIDTH_M) < 0.005 ? undefined : v })}
                />
                <Num label="Marcas lejanas (desde su banda)" value={spec.hash_far_m ?? DEFAULT_HASH_M} step={0.05} onFocus={() => setFocus("hash")} onChange={(v) => v !== undefined && set({ hash_far_m: v })} />
                <Num label="Marcas cercanas (desde su banda)" value={spec.hash_near_m ?? DEFAULT_HASH_M} step={0.05} onFocus={() => setFocus("hash")} onChange={(v) => v !== undefined && set({ hash_near_m: v })} />
                <Num label="Desplazada a lo largo" value={spec.grid_dx_m ?? 0} step={0.05} onFocus={() => setFocus("yard")} onChange={(v) => v !== undefined && set({ grid_dx_m: v })} />
                <Num label="Desplazada a lo ancho" value={spec.grid_dy_m ?? 0} step={0.05} onFocus={() => setFocus("yard")} onChange={(v) => v !== undefined && set({ grid_dy_m: v })} />
              </div>
            </Panel>
          )}

          <Panel title="Portería" aside={spec.goal_width_m === undefined ? "sin medir" : undefined}>
            <div className="grid grid-cols-2 gap-2.5">
              <Num label="Ancho" value={spec.goal_width_m} step={0.01} optional placeholder="sin medir" onChange={(v) => set({ goal_width_m: v })} />
              <Num label="Alto" value={spec.goal_height_m} step={0.01} optional placeholder="sin medir" onChange={(v) => set({ goal_height_m: v })} />
            </div>
          </Panel>

          <Panel title="Líneas extra para calibrar" aside="pintura gastada">
            <p className="mb-2 text-[11px] text-pretty text-faint">
              Rectas que se ven aunque la pintura no: dónde acaba el pasto, una reja. Distancia desde la esquina lejana izquierda; negativo es por fuera
              (fin del pasto 1 m tras la banda lejana: paralela a las bandas, −1). Salen en Calibración › Líneas.
            </p>
            <div className="space-y-2">
              {(spec.ref_lines ?? []).map((r) => {
                const upd = (p: Partial<typeof r>) => set({ ref_lines: (spec.ref_lines ?? []).map((x) => (x.id === r.id ? { ...x, ...p } : x)) });
                return (
                  <div key={r.id} className="space-y-1.5 rounded-lg bg-bg/50 p-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        className="min-w-0 flex-1 rounded-[7px] border border-line-strong bg-transparent px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                        value={r.label}
                        placeholder="Nombre (p. ej. fin del pasto lejano)"
                        aria-label="Nombre de la línea"
                        onChange={(e) => upd({ label: e.target.value })}
                      />
                      <button
                        type="button"
                        className="grid h-7 w-7 place-items-center rounded-md text-faint hover:text-danger"
                        aria-label="Quitar la línea"
                        onClick={() => set({ ref_lines: (spec.ref_lines ?? []).filter((x) => x.id !== r.id) })}
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 items-end gap-2">
                      <div className="seg flex w-full" role="group" aria-label="Orientación">
                        <button type="button" className="seg-opt flex-1 !px-1 text-[11px]" aria-pressed={r.axis === "along"} onClick={() => upd({ axis: "along" })}>
                          ∥ bandas
                        </button>
                        <button type="button" className="seg-opt flex-1 !px-1 text-[11px]" aria-pressed={r.axis === "across"} onClick={() => upd({ axis: "across" })}>
                          ∥ fondo
                        </button>
                      </div>
                      <Num label={r.axis === "along" ? "Desde la banda lejana" : "Desde el fondo izquierdo"} value={r.at_m} step={0.1} onChange={(v) => v !== undefined && upd({ at_m: v })} />
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="btn !py-1 text-xs"
                onClick={() => set({ ref_lines: [...(spec.ref_lines ?? []), { id: Math.random().toString(36).slice(2, 8), label: "Fin del pasto lejano", axis: "along", at_m: -1 }] })}
              >
                <Plus size={12} /> Añadir línea
              </button>
            </div>
          </Panel>

          <Panel title="Colores de la pintura">
            <div className="space-y-2">
              <Paint label="Líneas de fútbol" value={spec.soccer_color} onChange={(v) => set({ soccer_color: v })} />
              {overlay && <Paint label="Rejilla de americano" value={spec.grid_color} onChange={(v) => set({ grid_color: v })} />}
            </div>
          </Panel>

          <div className="flex min-h-36 flex-1 flex-col rounded-[10px] bg-surface p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="tc text-[11px] tracking-[0.08em] text-faint uppercase">Vista previa</h3>
              <span className="text-[11px] text-faint">banda cercana abajo</span>
            </div>
            <div className="relative min-h-0 flex-1">
              <VenueDiagram venue={venue} focus={focus} className="absolute inset-0 h-full" />
            </div>
          </div>
        </div>

        <FitStage spec={spec} onChange={set} focus={focus} setFocus={setFocus} />
      </div>
    </div>
  );
}
