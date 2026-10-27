"use client";

import { ArrowsMerge, Eraser, MagnifyingGlassMinus, MagnifyingGlassPlus, PushPin, Scissors, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { btn } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import type { TeamCode } from "@/lib/tracks";

// The line of the selected person under the video: one mark per processed frame where she has a box, coloured by the
// shirt of that box (so a change of team shows), her holes, the frames with two boxes, and the playhead. Click to go
// to a moment; feet marked by hand are white ticks and the holes the export will leave empty are red. Drag to choose a stretch and leave its boxes out, take it out as another person, or split there.

export interface TimelinePoint {
  frame: number;
  team: TeamCode;
  onPitch: boolean;
}

const WINDOW_S = 20; // half of the zoomed view

// What a stretch of a line carries when it is dragged onto another person (on the video or in the side panel).
export const RANGE_DRAG = "application/x-sportsan-range";

// A person a stretch can be joined to: the named ones of the part.
export interface JoinTarget {
  id: number;
  label: string;
  color: string;
}

// «Unir a…»: type to filter the named people, arrows to move, Enter to join, Esc to close.
function JoinPicker({ people, onPick, onClose }: { people: JoinTarget[]; onPick: (id: number) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = people.filter((p) => p.label.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = list[Math.min(i, list.length - 1)];
  return (
    <div className="enter absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl bg-raised p-1.5 shadow-[0_0_0_1px_var(--color-line),0_24px_48px_-16px_rgba(0,0,0,.7)]">
      <input
        autoFocus
        className="input w-full"
        placeholder="Unir a… (escribe su nombre)"
        aria-label="Buscar a quién unir el tramo"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setI((k) => Math.max(0, Math.min(list.length - 1, k + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Enter" && pick) {
            e.preventDefault();
            onPick(pick.id);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <ul className="mt-1 max-h-56 overflow-y-auto" role="listbox">
        {list.length === 0 && <li className="px-3 py-2 text-xs text-faint">Nadie con ese nombre en esta parte.</li>}
        {list.map((p, k) => (
          <li key={p.id}>
            <button
              type="button"
              role="option"
              aria-selected={p === pick}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${p === pick ? "bg-line-strong text-ink" : "text-ink-2 hover:bg-line"}`}
              onMouseEnter={() => setI(k)}
              onClick={() => onPick(p.id)}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PersonTimeline({
  points,
  conflicts,
  hints,
  manual = [],
  open = [],
  offCamera = [],
  greenRange = [2, 7],
  anomalies = [],
  onAnomaly,
  person,
  named = [],
  pinned = null,
  pinnedPoints = [],
  onJoin,
  start,
  end,
  frame,
  fps,
  stride,
  teamColors,
  onSeek,
  onDrop,
  onSeparate,
}: {
  points: TimelinePoint[];
  conflicts: number[];
  // Frames worth a look (changes of shirt).
  hints: number[];
  // Frames where her feet were marked by hand, and holes that will stay empty on export.
  manual?: number[];
  open?: [number, number][];
  // Holes where she left the frame: nothing to fix, filled on export.
  offCamera?: [number, number][];
  // Seconds [min, max] of a hole out of the camera shown green (Detalles técnicos).
  greenRange?: [number, number];
  // Impossible movements of hers still to look at (lib/anomalies.ts): from the jump to where she is back.
  anomalies?: { frame: number; until?: number; current?: boolean }[];
  onAnomaly?: (frame: number) => void;
  // Whose line this is (what a dragged stretch carries), the people a stretch can join, and the pinned player with her
  // own line (a thin strip under this one: her holes are where the stretch can fill).
  person: number;
  named?: JoinTarget[];
  pinned?: JoinTarget | null;
  pinnedPoints?: number[];
  onJoin?: (from: number, to: number, target: number) => void;
  start: number;
  end: number;
  frame: number;
  fps: number;
  stride: number;
  teamColors: Record<TeamCode, string>;
  onSeek: (frame: number) => void;
  onDrop: (from: number, to: number) => void;
  onSeparate: (from: number, to: number) => void;
}) {
  const [zoom, setZoom] = useState(end - start > 60 * fps);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [picking, setPicking] = useState(false);
  const join = (target: number) => {
    if (!range) return;
    onJoin?.(range[0], range[1], target);
    setRange(null);
    setPicking(false);
  };
  const drag = useRef<{ from: number; moved: boolean } | null>(null);
  // Ctrl + arrows choose a stretch from the frame on screen: the first press fixes one end there, the next ones move
  // the other end one processed frame (with Shift, one second) and the video follows it. Esc lets it go.
  const kb = useRef<{ anchor: number; edge: number } | null>(null);
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      if (e.key === "Escape" && range) {
        // Only the stretch goes; the selected player stays.
        e.preventDefault();
        e.stopImmediatePropagation();
        kb.current = null;
        setRange(null);
        setPicking(false);
        return;
      }
      // With a stretch chosen: u opens «Unir a…», j joins it to the pinned player.
      const typing = (e.target as HTMLElement | null)?.tagName === "INPUT";
      if (range && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "u" || (e.key === "j" && pinned))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "u") setPicking(true);
        else if (pinned) join(pinned.id);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["range", "checkbox"].includes((el as HTMLInputElement).type)))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const here = Math.round(frame / stride) * stride;
      const cur = kb.current && range ? kb.current : { anchor: here, edge: here };
      const step = (e.shiftKey ? Math.round(fps / stride) * stride : stride) * (e.key === "ArrowRight" ? 1 : -1);
      const edge = Math.min(end, Math.max(start, cur.edge + step));
      kb.current = { anchor: cur.anchor, edge };
      setRange([Math.min(cur.anchor, edge), Math.max(cur.anchor, edge)]);
      onSeek(edge);
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
  // The pinned player's line, in runs, for the strip under this one.
  const pinRuns: [number, number][] = [];
  for (const f of pinnedPoints) {
    if (f < v0 - stride || f > v1 + stride) continue;
    const last = pinRuns[pinRuns.length - 1];
    if (last && f - last[1] <= stride * 1.5) last[1] = f;
    else pinRuns.push([f, f]);
  }

  return (
    <div className="rounded-2xl bg-surface/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="text-ink-2">Línea de la seleccionada</span>
        <span className="hidden sm:inline">clic: ir · arrastrar o Ctrl + flechas (Mayús: de 1 s): elegir un tramo · Esc: soltarlo</span>
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
          kb.current = null;
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
        {offCamera
          .filter(([a, b]) => b >= v0 && a <= v1)
          .map(([a, b]) => {
            // 2 to 7 s out of the camera's reach: green, nothing to fill by hand.
            const green = (b - a) / fps >= greenRange[0] && (b - a) / fps <= greenRange[1];
            return (
              <span
                key={`o${a}`}
                className={`absolute top-4 bottom-4 rounded-sm ${green ? "bg-ok/50" : "bg-faint/40"}`}
                style={{ left: `${pct(a + stride)}%`, width: `max(2px, ${pct(b) - pct(a + stride)}%)` }}
                title={`Fuera de cuadro ${((b - a) / fps).toFixed(1)} s: se rellena al guardar${green ? " (verde: de ${greenRange[0]} a ${greenRange[1]} s fuera de la cámara, no hace falta rellenarlo a mano)" : ""}`}
              />
            );
          })}
        {open
          .filter(([a, b]) => b >= v0 && a <= v1)
          .map(([a, b]) => (
            <span
              key={`g${a}`}
              className="absolute top-4 bottom-4 rounded-sm bg-danger/60"
              style={{ left: `${pct(a + stride)}%`, width: `max(2px, ${pct(b) - pct(a + stride)}%)` }}
              title={`Hueco de ${((b - a) / fps).toFixed(1)} s que quedará vacío`}
            />
          ))}
        {manual
          .filter((f) => f >= v0 && f <= v1)
          .map((f) => (
            <span key={`m${f}`} className="absolute top-1.5 bottom-1.5 w-[3px] -translate-x-1/2 rounded-full bg-white" style={{ left: `${pct(f)}%` }} title="Marcada a mano" />
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
        {anomalies
          .filter((a) => (a.until ?? a.frame) >= v0 && a.frame <= v1)
          .map((a) => (
            <button
              key={`a${a.frame}`}
              type="button"
              className={`absolute inset-y-0.5 z-[1] -translate-x-px rounded-sm bg-danger/25 shadow-[inset_0_0_0_1.5px_var(--color-danger)] transition-colors hover:bg-danger/45 ${a.current ? "bg-danger/50" : ""}`}
              style={{ left: `${pct(a.frame - stride)}%`, width: `max(5px, ${pct(a.until ?? a.frame) - pct(a.frame - stride)}%)` }}
              title={`Salto imposible${a.until ? ` durante ${((a.until - a.frame) / fps).toFixed(1)} s (suele ser que la caja perdió sus pies)` : ""}: clic para revisarlo`}
              aria-label="Revisar el salto imposible"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onAnomaly?.(a.frame)}
            />
          ))}
        {range && (
          <span
            draggable
            className="absolute inset-y-0 z-[2] cursor-grab bg-accent/25 shadow-[inset_0_0_0_1px_var(--color-accent)] active:cursor-grabbing"
            style={{ left: `${pct(range[0])}%`, width: `${pct(range[1] + stride) - pct(range[0])}%` }}
            title="Arrástralo sobre otra jugadora (en el video o en el panel) para unírselo"
            onPointerDown={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.dataTransfer.setData(RANGE_DRAG, JSON.stringify({ person, from: range[0], to: range[1] }));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={(e) => e.dataTransfer.dropEffect !== "none" && setRange(null)}
          />
        )}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${pct(frame)}%` }} />
      </div>
      {pinned && pinned.id !== person && (
        <div className="mt-1 flex items-center gap-2" title={`Línea de ${pinned.label} (fijada): sus huecos son donde un tramo de esta puede ir`}>
          <PushPin size={11} weight="fill" className="shrink-0 text-accent" />
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-bg/80">
            {pinRuns.map(([a, b]) => (
              <span key={a} className="absolute inset-y-0 rounded-full" style={{ left: `${pct(a)}%`, width: `max(2px, ${pct(b + stride) - pct(a)}%)`, background: pinned.color }} />
            ))}
            <span className="absolute inset-y-0 w-px bg-white" style={{ left: `${pct(frame)}%` }} />
          </div>
        </div>
      )}
      <div className="tc mt-1 flex justify-between text-[10px] text-faint">
        <span>{fmtT(v0 / fps)}</span>
        <span className="font-sans">color = camiseta · blanco: marca a mano · recuadro rojo: salto imposible · rojo en medio: hueco por revisar · gris: fuera de cuadro · rojo arriba: dos cajas · ámbar abajo: cambio de camiseta</span>
        <span>{fmtT(v1 / fps)}</span>
      </div>
      {range && (
        <div className="enter relative mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="tc text-ink-2">
            {fmtT(range[0] / fps)} – {fmtT((range[1] + stride) / fps)} · {inRange} caja(s)
          </span>
          <button type="button" className={btn} disabled={!inRange} title="Quita sus cajas de este tramo: no cuentan ni se exportan" onClick={() => (onDrop(range[0], range[1]), setRange(null))}>
            <Eraser size={14} />
            Borrar
          </button>
          <button type="button" className={btn} disabled={!inRange} title="El tramo pasa a ser otra persona; ella sigue igual antes y después" onClick={() => (onSeparate(range[0], range[1]), setRange(null))}>
            <Scissors size={14} />
            Separar
          </button>
          <button type="button" className={`btn ${picking ? "btn-primary" : ""}`} disabled={!inRange || !onJoin} title="El tramo pasa a otra jugadora con nombre (u)" onClick={() => setPicking(!picking)}>
            <ArrowsMerge size={14} />
            Unir a… <kbd className="kbd">U</kbd>
          </button>
          {pinned && pinned.id !== person && (
            <button type="button" className={btn} disabled={!inRange} title={`El tramo pasa a ${pinned.label}, la fijada (j)`} onClick={() => join(pinned.id)}>
              <PushPin size={14} weight="fill" className="text-accent" />
              {pinned.label} <kbd className="kbd">J</kbd>
            </button>
          )}
          <span className="text-faint">o arrástralo sobre otra jugadora</span>
          <button type="button" className="text-faint hover:text-ink" aria-label="Cancelar el tramo" onClick={() => (setRange(null), setPicking(false))}>
            <X size={14} />
          </button>
          {picking && <JoinPicker people={named.filter((n) => n.id !== person)} onPick={join} onClose={() => setPicking(false)} />}
        </div>
      )}
    </div>
  );
}
