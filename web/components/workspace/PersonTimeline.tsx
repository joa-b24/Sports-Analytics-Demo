"use client";

import { ArrowsSplit, Eraser, MagnifyingGlassMinus, MagnifyingGlassPlus, Scissors, X } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { btn } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import type { TeamCode } from "@/lib/tracks";

// The line of the selected person under the video: one mark per processed frame where she has a box, coloured by the
// shirt of that box (so a change of team shows), her holes, the frames with two boxes, and the playhead. Click to go
// to a moment; drag to choose a stretch and leave its boxes out, take it out as another person, or split there.

export interface TimelinePoint {
  frame: number;
  team: TeamCode;
  onPitch: boolean;
}

const WINDOW_S = 20; // half of the zoomed view

export function PersonTimeline({
  points,
  conflicts,
  hints,
  start,
  end,
  frame,
  fps,
  stride,
  teamColors,
  onSeek,
  onDrop,
  onSeparate,
  onSplit,
}: {
  points: TimelinePoint[];
  conflicts: number[];
  // Frames worth a look (changes of shirt).
  hints: number[];
  start: number;
  end: number;
  frame: number;
  fps: number;
  stride: number;
  teamColors: Record<TeamCode, string>;
  onSeek: (frame: number) => void;
  onDrop: (from: number, to: number) => void;
  onSeparate: (from: number, to: number) => void;
  onSplit: (frame: number) => void;
}) {
  const [zoom, setZoom] = useState(end - start > 60 * fps);
  const [range, setRange] = useState<[number, number] | null>(null);
  const drag = useRef<{ from: number; moved: boolean } | null>(null);
  const half = Math.round(WINDOW_S * fps);
  const v0 = zoom ? Math.max(start, Math.min(frame - half, end - 2 * half)) : start;
  const v1 = zoom ? Math.min(end, v0 + 2 * half) : end;
  const span = Math.max(1, v1 - v0);
  const pct = (f: number) => ((f - v0) / span) * 100;
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = v0 + ((e.clientX - r.left) / r.width) * span;
    return Math.round(Math.min(v1, Math.max(v0, f)) / stride) * stride;
  };
  // Runs of consecutive marks of the same shirt, to draw few elements.
  const runs: { a: number; b: number; team: TeamCode; onPitch: boolean }[] = [];
  for (const p of points) {
    if (p.frame < v0 - stride || p.frame > v1 + stride) continue;
    const last = runs[runs.length - 1];
    if (last && p.frame - last.b <= stride * 1.5 && last.team === p.team && last.onPitch === p.onPitch) last.b = p.frame;
    else runs.push({ a: p.frame, b: p.frame, team: p.team, onPitch: p.onPitch });
  }
  const inRange = range ? points.filter((p) => p.frame >= range[0] && p.frame <= range[1]).length : 0;

  return (
    <div className="rounded-2xl bg-surface/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="text-ink-2">Línea de la seleccionada</span>
        <span className="hidden sm:inline">clic: ir · arrastrar: elegir un tramo</span>
        <span className="tc ml-auto">
          {fmtT(v0 / fps)} – {fmtT(v1 / fps)}
        </span>
        <button
          type="button"
          className="text-faint transition-colors hover:text-ink"
          title={zoom ? "Ver toda la parte" : `Ver ${2 * WINDOW_S} s alrededor del momento actual`}
          aria-label={zoom ? "Ver toda la parte" : "Acercar"}
          onClick={() => setZoom(!zoom)}
        >
          {zoom ? <MagnifyingGlassMinus size={15} /> : <MagnifyingGlassPlus size={15} />}
        </button>
      </div>
      <div
        className="relative h-11 cursor-pointer touch-none overflow-hidden rounded-xl bg-bg/80 select-none"
        role="presentation"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { from: at(e), moved: false };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const f = at(e);
          if (Math.abs(f - drag.current.from) >= stride) {
            drag.current.moved = true;
            setRange([Math.min(f, drag.current.from), Math.max(f, drag.current.from)]);
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            setRange(null);
            onSeek(at(e));
          }
        }}
      >
        {runs.map((r) => (
          <span
            key={`${r.a}-${r.team}`}
            className="absolute top-2 bottom-2 rounded-sm"
            style={{
              left: `${pct(r.a)}%`,
              width: `max(2px, ${pct(r.b + stride) - pct(r.a)}%)`,
              background: teamColors[r.team],
              opacity: r.onPitch ? 1 : 0.35,
            }}
          />
        ))}
        {conflicts
          .filter((f) => f >= v0 && f <= v1)
          .map((f) => (
            <span key={`c${f}`} className="absolute top-0 h-2 w-[3px] -translate-x-1/2 rounded-b bg-danger" style={{ left: `${pct(f)}%` }} title="Dos cajas a la vez" />
          ))}
        {hints
          .filter((f) => f >= v0 && f <= v1)
          .map((f) => (
            <span key={`h${f}`} className="absolute bottom-0 h-2 w-[3px] -translate-x-1/2 rounded-t bg-warn" style={{ left: `${pct(f)}%` }} title="Cambio de camiseta" />
          ))}
        {range && (
          <span className="absolute inset-y-0 bg-accent/25 shadow-[inset_0_0_0_1px_var(--color-accent)]" style={{ left: `${pct(range[0])}%`, width: `${pct(range[1] + stride) - pct(range[0])}%` }} />
        )}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${pct(frame)}%` }} />
      </div>
      <div className="tc mt-1 flex justify-between text-[10px] text-faint">
        <span>{fmtT(v0 / fps)}</span>
        <span className="font-sans">color = camiseta de cada caja · rojo arriba: dos cajas a la vez · ámbar abajo: cambio de camiseta</span>
        <span>{fmtT(v1 / fps)}</span>
      </div>
      {range && (
        <div className="enter mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="tc text-ink-2">
            {fmtT(range[0] / fps)} – {fmtT((range[1] + stride) / fps)} · {inRange} caja(s)
          </span>
          <button type="button" className={btn} disabled={!inRange} title="Quita sus cajas de este tramo: no cuentan ni se exportan" onClick={() => (onDrop(range[0], range[1]), setRange(null))}>
            <Eraser size={14} />
            Quitar estas cajas
          </button>
          <button type="button" className={btn} disabled={!inRange} title="El tramo pasa a ser otra persona; ella sigue igual antes y después" onClick={() => (onSeparate(range[0], range[1]), setRange(null))}>
            <Scissors size={14} />
            Separar como otra persona
          </button>
          <button type="button" className={btn} title="Desde el inicio del tramo en adelante es otra persona" onClick={() => (onSplit(range[0]), setRange(null))}>
            <ArrowsSplit size={14} />
            Partir al inicio
          </button>
          <button type="button" className="text-faint hover:text-ink" aria-label="Cancelar el tramo" onClick={() => setRange(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
