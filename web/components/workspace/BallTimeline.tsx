"use client";

import { ArrowUp, Check, Eraser, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { btn } from "@/components/Shell";
import { fmtT } from "@/lib/format";

// The line of the ball under the video, like a player's line but in the colour of the ball (--color-ball-track, chosen in
// Configuración › Apariencia). Three rows: the tracker's detections (ticks, chained in «tracklets»), the path as it is
// exported (interpolated stretches faint, flights amber) and the hand marks (green on the ground, amber in the air).
// Drag to choose a stretch (or click a tracklet) and take out its detections, accept them as marks, take out marks or
// change them to ground / air. Everything goes through the parent's edits, so Ctrl + Z undoes it.

export interface BallLineData {
  // Live detections of the tracker (not rejected, not replaced by a mark) and their tracklets.
  auto: number[];
  tracklets: { from: number; to: number }[];
  marks: { frame: number; air: boolean }[];
  // Stretches of the path that are interpolated and those that are a flight [from, to] (frames).
  interpolated: [number, number][];
  flights: [number, number][];
  // Frames bounding impossible jumps.
  jumps: number[];
}

const WINDOW_S = 20;

export function BallTimeline({
  data,
  start,
  end,
  frame,
  fps,
  stride,
  onSeek,
  onRejectAuto,
  onAcceptAuto,
  onRemoveMarks,
  onSetAir,
}: {
  data: BallLineData;
  start: number;
  end: number;
  frame: number;
  fps: number;
  stride: number;
  onSeek: (frame: number) => void;
  onRejectAuto: (from: number, to: number) => void;
  onAcceptAuto: (from: number, to: number) => void;
  onRemoveMarks: (from: number, to: number) => void;
  onSetAir: (from: number, to: number, air: boolean) => void;
}) {
  const [zoom, setZoom] = useState(end - start > 60 * fps);
  const [range, setRange] = useState<[number, number] | null>(null);
  const drag = useRef<{ from: number; moved: boolean } | null>(null);
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      if (!range || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        setRange(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        onRejectAuto(range[0], range[1]);
        setRange(null);
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const half = Math.round(WINDOW_S * fps);
  const v0 = zoom ? Math.max(start, Math.min(frame - half, end - 2 * half)) : start;
  const v1 = zoom ? Math.min(end, v0 + 2 * half) : end;
  const span = Math.max(1, v1 - v0);
  const pct = (f: number) => ((f - v0) / span) * 100;
  const vis = (a: number, b: number) => b >= v0 && a <= v1;
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = v0 + ((e.clientX - r.left) / r.width) * span;
    return Math.round(Math.min(v1, Math.max(v0, f)) / stride) * stride;
  };
  const inR = (f: number) => (range ? f >= range[0] && f <= range[1] : false);
  const nAuto = range ? data.auto.filter(inR).length : 0;
  const nMarks = range ? data.marks.filter((m) => inR(m.frame)).length : 0;
  const nAir = range ? data.marks.filter((m) => inR(m.frame) && m.air).length : 0;
  const w = (a: number, b: number) => `max(2px, ${pct(b + stride) - pct(a)}%)`;

  return (
    <div className="rounded-2xl bg-surface/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="text-ink-2">Línea del balón</span>
        <span className="hidden sm:inline">clic: ir · arrastrar o clic en un tramo detectado: elegir · Supr: borrar lo detectado · Esc: soltar</span>
        <span className="tc ml-auto">
          {fmtT(v0 / fps)} – {fmtT(v1 / fps)}
        </span>
        <button type="button" className="text-faint transition-colors hover:text-ink" title={zoom ? "Ver toda la parte" : `Ver ${2 * WINDOW_S} s alrededor del momento actual`} aria-label={zoom ? "Ver toda la parte" : "Acercar"} onClick={() => setZoom(!zoom)}>
          {zoom ? <MagnifyingGlassMinus size={15} /> : <MagnifyingGlassPlus size={15} />}
        </button>
      </div>
      <div
        className="relative h-14 cursor-pointer touch-none overflow-hidden rounded-xl bg-bg/80 select-none"
        data-testid="ball-line"
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
          if (!d || d.moved) return;
          const f = at(e);
          // A click on a tracklet chooses all of it; anywhere else just goes there.
          const t = data.tracklets.find((x) => f >= x.from - stride && f <= x.to + stride);
          setRange(t ? [t.from, t.to] : null);
          onSeek(f);
        }}
      >
        {/* Top: detections of the tracker, a bar per tracklet and a tick per detection. */}
        {data.tracklets
          .filter((t) => vis(t.from, t.to))
          .map((t) => (
            <span key={`t${t.from}`} className="absolute top-1 h-2 rounded-sm opacity-35" style={{ left: `${pct(t.from)}%`, width: w(t.from, t.to), background: "var(--color-ball-track)" }} title={`Tramo detectado de ${((t.to - t.from + stride) / fps).toFixed(1)} s`} />
          ))}
        {data.auto
          .filter((f) => f >= v0 && f <= v1)
          .map((f) => (
            <span key={`a${f}`} className="absolute top-1 h-2 w-[2px] -translate-x-1/2" style={{ left: `${pct(f)}%`, background: inR(f) ? "var(--color-ink)" : "var(--color-ball-track)" }} />
          ))}
        {/* Middle: the path, interpolated faint, flights amber. */}
        {data.interpolated
          .filter(([a, b]) => vis(a, b))
          .map(([a, b]) => (
            <span key={`i${a}`} className="absolute top-[26px] h-1 rounded-sm bg-faint/35" style={{ left: `${pct(a)}%`, width: w(a, b) }} />
          ))}
        {data.flights
          .filter(([a, b]) => vis(a, b))
          .map(([a, b]) => (
            <span key={`f${a}`} className="absolute top-[24px] h-2 rounded-sm bg-warn/55" style={{ left: `${pct(a)}%`, width: w(a, b) }} title="Vuelo (balón en el aire)" />
          ))}
        {/* Bottom: hand marks, green on the ground and amber in the air. */}
        {data.marks
          .filter((m) => m.frame >= v0 && m.frame <= v1)
          .map((m) => (
            <span key={`m${m.frame}`} className={`absolute bottom-1 h-3 w-[3px] -translate-x-1/2 rounded-full ${m.air ? "bg-warn" : "bg-ok"}`} style={{ left: `${pct(m.frame)}%` }} title={m.air ? "Marca en el aire" : "Marca en el suelo"} />
          ))}
        {data.jumps
          .filter((f) => f >= v0 && f <= v1)
          .map((f) => (
            <span key={`j${f}`} className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-danger/70" style={{ left: `${pct(f)}%` }} title="Cuadro de un salto imposible" />
          ))}
        {range && <span className="pointer-events-none absolute inset-y-0 z-[2] bg-accent/20 shadow-[inset_0_0_0_1px_var(--color-accent)]" style={{ left: `${pct(range[0])}%`, width: `${pct(range[1] + stride) - pct(range[0])}%` }} />}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${pct(frame)}%` }} />
      </div>
      <div className="tc mt-1 flex justify-between text-[10px] text-faint">
        <span>{fmtT(v0 / fps)}</span>
        <span className="font-sans">arriba: detectado por el programa · en medio: trayectoria (tenue: interpolada, ámbar: vuelo) · abajo: tus marcas (verde suelo, ámbar aire) · rojo: salto imposible</span>
        <span>{fmtT(v1 / fps)}</span>
      </div>
      {range && (
        <div className="enter mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="tc text-ink-2">
            {fmtT(range[0] / fps)} – {fmtT((range[1] + stride) / fps)} · {nAuto} detectada(s) · {nMarks} marca(s)
          </span>
          <button type="button" className={btn} disabled={!nAuto} title="Estas detecciones no son el balón: se quitan (Supr). Ctrl + Z las recupera" onClick={() => (onRejectAuto(range[0], range[1]), setRange(null))}>
            <Eraser size={14} />
            Borrar detectadas
          </button>
          <button type="button" className={btn} disabled={!nAuto} title="Las revisaste y sí son el balón: pasan a ser marcas tuyas" onClick={() => (onAcceptAuto(range[0], range[1]), setRange(null))}>
            <Check size={14} />
            Aceptar como marcas
          </button>
          <button type="button" className={btn} disabled={!nMarks} title="Quita tus marcas del tramo (y las rectas que las tocan)" onClick={() => (onRemoveMarks(range[0], range[1]), setRange(null))}>
            <Eraser size={14} />
            Borrar marcas
          </button>
          <button type="button" className={btn} disabled={!nMarks || nAir === nMarks} title="Las marcas del tramo pasan a ser balón en el aire" onClick={() => onSetAir(range[0], range[1], true)}>
            <ArrowUp size={14} />
            En el aire
          </button>
          <button type="button" className={btn} disabled={!nAir} title="Las marcas del tramo vuelven a ser balón en el suelo" onClick={() => onSetAir(range[0], range[1], false)}>
            En el suelo
          </button>
          <button type="button" className="text-faint hover:text-ink" aria-label="Soltar el tramo" onClick={() => setRange(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
