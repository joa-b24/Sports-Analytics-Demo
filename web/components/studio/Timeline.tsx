"use client";

import type { Icon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";

// The timeline of the two editors of Estudio, as in a video editor: a ruler with the playhead (drag it to scrub), an
// optional track of blocks (the board's steps), an optional track of markers (the clip's stops) and the drawings as
// bars on as many lanes as they need. A bar moves when dragged by its body and is trimmed by its edges; a click picks
// it. Everything fits its height: more lanes make them thinner, never a scroll.

export type TimelineItem = { id: string; start: number; end: number; color: string; label: string; icon?: Icon; dashed?: boolean };
export type TimelineBlock = { id: string; start: number; end: number; label: string; sub?: string };
export type TimelineMarker = { id: string; t: number; label: string; title?: string };

type Track = { label: string; icon?: Icon; action?: ReactNode };

type Props = {
  min: number;
  max: number;
  now: number;
  onSeek: (t: number) => void;
  fmt: (t: number) => string;
  // Top bar: playback and what applies to the whole piece (left), anything else (right).
  transport?: ReactNode;
  right?: ReactNode;
  blocks?: Track & { items: TimelineBlock[]; active: string | null; onPick: (id: string) => void };
  markers?: Track & { items: TimelineMarker[]; selected: string | null; onPick: (id: string) => void; onMove?: (id: string, t: number) => void };
  items: Track & {
    items: TimelineItem[];
    selected: string | null;
    onPick: (id: string | null) => void;
    onChange: (id: string, start: number, end: number) => void;
    // Times a dragged edge sticks to (the playhead is always one).
    snaps?: number[];
    // A bar is never shorter than this (s).
    minLength?: number;
    empty?: string;
  };
  // Lanes shown at full height; more than this and they get thinner.
  lanes?: number;
};

const HEAD = "7rem";
const LANE_H = 24;
const SNAP_PX = 7;
const EDGE_PX = 7;

// Lanes for bars: each one on the first lane where it does not overlap the previous bar.
export function packLanes<T extends { start: number; end: number }>(items: T[]): T[][] {
  const lanes: T[][] = [];
  for (const it of [...items].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const lane = lanes.find((l) => l[l.length - 1].end <= it.start + 1e-6);
    if (lane) lane.push(it);
    else lanes.push([it]);
  }
  return lanes;
}

// Ruler steps: the smallest "nice" one that leaves at least ~70 px between labels.
function tickStep(span: number, width: number): number {
  const per = (span * 70) / Math.max(1, width);
  return [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s >= per) ?? 600;
}

type Drag =
  | { kind: "seek" }
  | { kind: "item"; id: string; mode: "move" | "in" | "out"; x0: number; start: number; end: number; moved: boolean }
  | { kind: "marker"; id: string; x0: number; t: number; moved: boolean };

export function Timeline({ min, max, now, onSeek, fmt, transport, right, blocks, markers, items, lanes: maxLanes = 4 }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [drag, setDrag] = useState<Drag | null>(null);
  const span = Math.max(0.1, max - min);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const x = (t: number) => ((Math.min(max, Math.max(min, t)) - min) / span) * 100;
  const tAt = (clientX: number) => {
    const r = areaRef.current?.getBoundingClientRect();
    if (!r) return min;
    return min + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const pxToT = (px: number) => (px / Math.max(1, width)) * span;
  const snapList = [now, min, max, ...(items.snaps ?? [])];
  const snap = (t: number) => {
    let best = t;
    let d = pxToT(SNAP_PX);
    for (const s of snapList) {
      if (Math.abs(s - t) < d) {
        d = Math.abs(s - t);
        best = s;
      }
    }
    return best;
  };
  const minLen = items.minLength ?? 0.1;

  // The bar or marker being dragged, where it would land.
  const live = (it: TimelineItem): TimelineItem => {
    if (drag?.kind !== "item" || drag.id !== it.id) return it;
    return { ...it, start: drag.start, end: drag.end };
  };

  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    if (drag.kind === "seek") return onSeek(tAt(e.clientX));
    const dt = pxToT(e.clientX - drag.x0);
    const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 3;
    if (drag.kind === "marker") {
      const base = markers?.items.find((m) => m.id === drag.id)?.t ?? drag.t;
      return setDrag({ ...drag, t: Math.min(max, Math.max(min, snap(base + dt))), moved });
    }
    const it = items.items.find((i) => i.id === drag.id);
    if (!it) return;
    let { start, end } = it;
    if (drag.mode === "move") {
      const len = end - start;
      start = Math.min(max - len, Math.max(min, it.start + dt));
      // The edge nearest a snap point sticks to it.
      const s1 = snap(start);
      const s2 = snap(start + len) - len;
      start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : s2;
      end = start + len;
    } else if (drag.mode === "in") start = Math.min(end - minLen, Math.max(min, snap(it.start + dt)));
    else end = Math.max(start + minLen, Math.min(max, snap(it.end + dt)));
    setDrag({ ...drag, start, end, moved });
  };
  const onUp = () => {
    if (drag?.kind === "item") {
      if (drag.moved) items.onChange(drag.id, round2(drag.start), round2(drag.end));
      else items.onPick(drag.id);
    } else if (drag?.kind === "marker") {
      if (drag.moved && markers?.onMove) markers.onMove(drag.id, round2(drag.t));
      else markers?.onPick(drag.id);
    }
    setDrag(null);
  };
  const capture = (e: RPointerEvent) => (e.currentTarget as Element).setPointerCapture?.(e.pointerId);

  const lanes = packLanes(items.items.map(live));
  const shownLanes = Math.max(2, Math.min(maxLanes, lanes.length));
  const laneH = lanes.length > maxLanes ? Math.max(12, Math.floor((maxLanes * LANE_H) / lanes.length)) : LANE_H;
  const itemsH = Math.max(shownLanes * LANE_H, lanes.length * laneH) + 6;
  const step = tickStep(span, width);
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-6; t += step) ticks.push(t);
  const markerAt = (m: TimelineMarker) => (drag?.kind === "marker" && drag.id === m.id ? drag.t : m.t);

  const head = (tr: Track, h: number) => (
    <div className="flex items-center gap-1.5 border-r border-line-soft pr-2 pl-3 text-[11px] font-semibold tracking-wide text-muted uppercase" style={{ height: h }}>
      {tr.icon && <tr.icon size={13} aria-hidden />}
      <span className="cond truncate">{tr.label}</span>
      {tr.action && <span className="ml-auto flex items-center">{tr.action}</span>}
    </div>
  );

  return (
    <div ref={rootRef} className="relative flex flex-col overflow-hidden rounded-xl bg-surface select-none">
      {(transport || right) && (
        <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line-soft px-2 py-1.5">
          {transport}
          {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: `${HEAD} minmax(0,1fr)` }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        {/* Ruler */}
        <div className="border-r border-b border-line-soft" style={{ height: 22 }} />
        <div
          ref={areaRef}
          className="relative cursor-ew-resize border-b border-line-soft"
          style={{ height: 22 }}
          onPointerDown={(e) => {
            capture(e);
            setDrag({ kind: "seek" });
            onSeek(tAt(e.clientX));
          }}
        >
          {ticks.map((t) => (
            <span key={t} className="absolute top-0 h-full border-l border-line" style={{ left: `${x(t)}%` }}>
              <span className="tc absolute top-1 left-1 text-[10px] whitespace-nowrap text-faint">{fmt(t)}</span>
            </span>
          ))}
          <span className="pointer-events-none absolute top-0 z-10 h-full" style={{ left: `${x(now)}%` }}>
            <span className="absolute top-0 -left-[5px] h-2.5 w-2.5 rotate-45 rounded-[2px] bg-accent" />
          </span>
        </div>

        {/* Blocks (steps) */}
        {blocks && (
          <>
            {head(blocks, 34)}
            <div className="relative border-b border-line-soft" style={{ height: 34 }}>
              {blocks.items.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => blocks.onPick(b.id)}
                  aria-pressed={blocks.active === b.id}
                  title={b.sub || b.label}
                  className={`absolute top-1 bottom-1 flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md border px-2 text-left text-xs transition-colors ${
                    blocks.active === b.id ? "border-accent bg-accent-900 text-ink" : "border-line bg-raised text-ink-2 hover:border-line-strong"
                  }`}
                  style={{ left: `calc(${x(b.start)}% + 1px)`, width: `calc(${x(b.end) - x(b.start)}% - 2px)` }}
                >
                  <span className="tc font-semibold">{b.label}</span>
                  {b.sub && <span className="truncate text-faint">{b.sub}</span>}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Markers (stops) */}
        {markers && (
          <>
            {head(markers, 30)}
            <div className="relative border-b border-line-soft" style={{ height: 30 }}>
              {markers.items.length === 0 && <span className="absolute inset-y-0 left-2 flex items-center text-[11px] text-faint">Ninguna</span>}
              {markers.items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.title}
                  aria-pressed={markers.selected === m.id}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    capture(e);
                    setDrag({ kind: "marker", id: m.id, x0: e.clientX, t: m.t, moved: false });
                  }}
                  className={`absolute top-1 bottom-1 flex -translate-x-px items-center gap-1 rounded-r-md border-l-2 border-warn pr-2 pl-1.5 text-[11px] whitespace-nowrap transition-colors ${
                    markers.selected === m.id ? "bg-warn/30 text-ink" : "bg-warn/12 text-ink-2 hover:bg-warn/20"
                  } ${markers.onMove ? "cursor-grab" : ""}`}
                  style={{ left: `${x(markerAt(m))}%` }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Drawings */}
        {head(items, itemsH)}
        <div
          className="relative"
          style={{ height: itemsH }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            items.onPick(null);
            capture(e);
            setDrag({ kind: "seek" });
            onSeek(tAt(e.clientX));
          }}
        >
          {items.items.length === 0 && items.empty && <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[11px] text-faint">{items.empty}</span>}
          {lanes.map((lane, li) =>
            lane.map((it) => {
              const sel = items.selected === it.id;
              const I = it.icon;
              return (
                <div
                  key={it.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel}
                  title={`${it.label} · ${fmt(it.start)}–${fmt(it.end)} · arrastra para mover, los bordes para recortar`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    capture(e);
                    const r = e.currentTarget.getBoundingClientRect();
                    const mode = e.clientX - r.left < EDGE_PX ? "in" : r.right - e.clientX < EDGE_PX ? "out" : "move";
                    setDrag({ kind: "item", id: it.id, mode, x0: e.clientX, start: it.start, end: it.end, moved: false });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") items.onPick(it.id);
                  }}
                  className={`group absolute flex min-w-0 cursor-grab items-center gap-1 overflow-hidden rounded-[5px] px-1.5 text-[11px] font-medium active:cursor-grabbing ${sel ? "ring-2 ring-ink" : ""}`}
                  style={{
                    left: `${x(it.start)}%`,
                    width: `max(6px, ${x(it.end) - x(it.start)}%)`,
                    top: 3 + li * laneH,
                    height: laneH - 3,
                    background: `color-mix(in srgb, ${it.color} ${sel ? 55 : 32}%, var(--color-surface))`,
                    borderLeft: `3px ${it.dashed ? "dashed" : "solid"} ${it.color}`,
                    color: "var(--color-ink)",
                  }}
                >
                  {I && laneH >= 18 && <I size={12} weight="bold" className="shrink-0" aria-hidden />}
                  {laneH >= 16 && <span className="truncate">{it.label}</span>}
                  <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100" style={{ background: it.color }} />
                </div>
              );
            }),
          )}
        </div>
      </div>
      {/* Playhead across the tracks. */}
      <PlayheadLine areaRef={areaRef} rootRef={rootRef} pct={x(now)} />
    </div>
  );
}

// The vertical line of the playhead, drawn over every track below the ruler (positioned from the ruler's box).
function PlayheadLine({ areaRef, rootRef, pct }: { areaRef: React.RefObject<HTMLDivElement | null>; rootRef: React.RefObject<HTMLDivElement | null>; pct: number }) {
  const [box, setBox] = useState<{ left: number; width: number; top: number } | null>(null);
  useEffect(() => {
    const el = areaRef.current;
    const parent = rootRef.current;
    if (!el || !parent) return;
    const measure = () => {
      const a = el.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      setBox({ left: a.left - p.left, width: a.width, top: a.top - p.top });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [areaRef, rootRef]);
  if (!box) return null;
  return <span className="pointer-events-none absolute bottom-0 z-10 w-px bg-accent" style={{ left: box.left + (box.width * pct) / 100, top: box.top }} />;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
