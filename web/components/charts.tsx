"use client";

import { useId } from "react";
import { COLORS, Pitch } from "./Pitch";
import { CountUp } from "./motion";
import { finishEvents } from "@/lib/analysis";
import { fmtT } from "@/lib/format";
import type { Segment } from "@/lib/segments";
import { EVENT_LABELS, EVENT_TYPES, PITCH, type MatchEvent } from "@/lib/types";

// Marks carry the classes a-bar / a-col / a-pop / a-draw / a-fade: when the chart sits inside a `.reveal`
// block (any Card), they animate in as it scrolls into view. `--i` staggers them. See globals.css.
const i = (n: number) => ({ "--i": n }) as React.CSSProperties;

export function Legend({ items }: { items: { color: string; label: string; hollow?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={it.hollow ? { border: `2px solid ${it.color}` } : { background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// Headline comparison: two big figures and the share of each team on one bar.
export function StatTile({ label, a, b, aLabel, bLabel }: { label: string; a: number; b: number; aLabel: string; bLabel: string }) {
  const total = a + b;
  return (
    <div className="min-w-0" title={`${label} · ${aLabel}: ${a} · ${bLabel}: ${b}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2.5">
        <span className="num text-5xl" style={{ color: COLORS.own }}>
          <CountUp value={a} />
        </span>
        <span className="text-xs text-faint">vs</span>
        <span className="num text-3xl" style={{ color: COLORS.opp }}>
          <CountUp value={b} />
        </span>
      </div>
      <div className="mt-2.5 flex h-1 gap-0.5 overflow-hidden rounded-full">
        {total === 0 ? (
          <span className="h-full w-full bg-line-soft" />
        ) : (
          <>
            <span className="a-bar h-full rounded-full" style={{ width: `${(a / total) * 100}%`, background: COLORS.own }} />
            <span className="a-fade h-full flex-1 rounded-full" style={{ background: COLORS.opp }} />
          </>
        )}
      </div>
    </div>
  );
}

// Paired horizontal bars: one row per category, two teams on a shared scale.
export function CompareBars({
  rows,
  aLabel,
  bLabel,
}: {
  rows: { label: string; a: number; b: number }[];
  aLabel: string;
  bLabel: string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  const bar = (v: number, color: string, who: string, label: string, n: number) => (
    <div className="flex items-center gap-2" title={`${label} · ${who}: ${v}`}>
      <div className="a-bar h-2 rounded-full" style={{ width: `${(v / max) * 82}%`, minWidth: v > 0 ? 4 : 0, background: color, ...i(n) }} />
      <span className="a-fade tc text-[11px] text-muted" style={i(n)}>
        {v}
      </span>
    </div>
  );
  return (
    <div>
      <Legend
        items={[
          { color: COLORS.own, label: aLabel },
          { color: COLORS.opp, label: bLabel },
        ]}
      />
      <div className="mt-4 space-y-3">
        {rows.map((r, n) => (
          <div key={r.label} className="grid grid-cols-[7.5rem_1fr] items-center gap-3">
            <div className="text-xs text-ink-2">{r.label}</div>
            <div className="space-y-1">
              {bar(r.a, COLORS.own, aLabel, r.label, n)}
              {bar(r.b, COLORS.opp, bLabel, r.label, n)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Match-sheet comparison: the label in the middle, each team's bar growing outwards from it, its figure at the end.
// Each row has its own scale (the larger of the two fills its side): it compares the teams, not the rows.
export function MirrorBars({ rows, aLabel, bLabel }: { rows: { label: string; a: number; b: number; fmt?: (v: number) => string }[]; aLabel: string; bLabel: string }) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS.own }} />
          {aLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          {bLabel}
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS.opp }} />
        </span>
      </div>
      <div className="space-y-2">
        {rows.map((r, n) => {
          const max = Math.max(r.a, r.b, 1e-9);
          const f = r.fmt ?? String;
          const lead = (v: number, o: number) => (v > o ? "text-ink font-semibold" : "text-muted");
          return (
            <div key={r.label} className="grid grid-cols-[2.75rem_minmax(0,1fr)_minmax(6.5rem,9rem)_minmax(0,1fr)_2.75rem] items-center gap-2" title={`${r.label} · ${aLabel}: ${f(r.a)} · ${bLabel}: ${f(r.b)}`}>
              <span className={`num text-right text-base ${lead(r.a, r.b)}`}>{f(r.a)}</span>
              <div className="flex h-2 justify-end">
                <div className="a-bar h-full rounded-l-[4px]" style={{ width: `${(100 * r.a) / max}%`, minWidth: r.a > 0 ? 3 : 0, background: COLORS.own, transformOrigin: "right center", ...i(n) }} />
              </div>
              <span className="text-center text-xs leading-tight text-ink-2">{r.label}</span>
              <div className="flex h-2">
                <div className="a-bar h-full rounded-r-[4px]" style={{ width: `${(100 * r.b) / max}%`, minWidth: r.b > 0 ? 3 : 0, background: COLORS.opp, ...i(n) }} />
              </div>
              <span className={`num text-base ${lead(r.b, r.a)}`}>{f(r.b)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Shots on the pitch: filled = goal, hollow = no goal. Colour = team.
export function ShotMap({ events, aLabel, bLabel }: { events: MatchEvent[]; aLabel: string; bLabel: string }) {
  // One mark per finish: a goal tagged together with its shot (and its penalty) is drawn once.
  const all = finishEvents(events);
  const shots = all.filter((e) => e.x !== null && e.y !== null);
  const missing = all.filter((e) => e.x === null || e.y === null).length;
  return (
    <div>
      <Legend
        items={[
          { color: COLORS.own, label: aLabel },
          { color: COLORS.opp, label: bLabel },
          { color: "var(--color-muted)", label: "Gol (relleno)" },
          { color: "var(--color-muted)", label: "Tiro sin gol", hollow: true },
        ]}
      />
      <Pitch className="mt-2">
        {shots.map((e, n) => {
          const c = e.team === "own" ? COLORS.own : COLORS.opp;
          return (
            <circle
              key={e.event_id}
              className="a-pop"
              style={i(n)}
              cx={e.x as number}
              cy={e.y as number}
              r={1.5}
              fill={e.type === "goal" ? c : "var(--color-surface)"}
              stroke={c}
              strokeWidth={0.55}
            >
              <title>{`${EVENT_LABELS[e.type]} · ${e.team === "own" ? aLabel : bLabel} · ${fmtT(e.t_video)}`}</title>
            </circle>
          );
        })}
      </Pitch>
      {missing > 0 && <p className="mt-1 text-xs text-faint">{missing} tiro(s) sin posición marcada no aparecen en el mapa.</p>}
    </div>
  );
}

const ZONE_STEPS = 6;

// Zone counts (thirds along the pitch x lanes across it: 3 x 3, or the 5 x 3 of the report), one hue, few to many.
export function ZoneMap({ grid, missing, showDirection = true }: { grid: number[][]; missing: number; showDirection?: boolean }) {
  const max = Math.max(0, ...grid.flat());
  const cw = PITCH.length / (grid[0]?.length || 3);
  const ch = PITCH.width / (grid.length || 3);
  return (
    <div>
      <Pitch showDirection={showDirection}>
        {grid.map((row, r) =>
          row.map((v, c) => {
            const step = max === 0 || v === 0 ? -1 : Math.min(ZONE_STEPS - 1, Math.floor((v / max) * (ZONE_STEPS - 1) + 0.0001));
            return (
              <g key={`${r}-${c}`} className="a-fade" style={i(r * row.length + c)}>
                <rect
                  x={c * cw + 0.5}
                  y={r * ch + 0.5}
                  width={cw - 1}
                  height={ch - 1}
                  rx={2}
                  fill={step < 0 ? "transparent" : `var(--zone-${step})`}
                  fillOpacity={0.92}
                >
                  <title>{`${v} evento(s) en esta zona`}</title>
                </rect>
                <text
                  x={c * cw + cw / 2}
                  y={r * ch + ch / 2 + 2}
                  textAnchor="middle"
                  fontSize={5.5}
                  fontWeight={600}
                  fontFamily="var(--font-cond)"
                  fill={step < 0 ? "var(--color-faint)" : step >= 3 ? "var(--zone-ink-hi)" : "var(--zone-ink-lo)"}
                  pointerEvents="none"
                >
                  {v}
                </text>
              </g>
            );
          }),
        )}
      </Pitch>
      {missing > 0 && <p className="mt-1 text-xs text-faint">{missing} evento(s) sin posición marcada no se cuentan.</p>}
    </div>
  );
}

// Single-series line over ordered categories, with an optional reference series.
export function LineChart({
  labels,
  series,
  reference,
  seriesLabel,
  referenceLabel,
  fmt,
}: {
  labels: string[];
  series: (number | null)[];
  reference?: (number | null)[];
  seriesLabel: string;
  referenceLabel?: string;
  fmt: (v: number) => string;
}) {
  const gid = useId();
  const W = 640;
  const H = 230;
  const m = { l: 48, r: 16, t: 14, b: 28 };
  const all = [...series, ...(reference ?? [])].filter((v): v is number => v !== null);
  if (all.length === 0) return <p className="text-sm text-faint">Sin datos para esta métrica.</p>;
  const max = Math.max(...all) * 1.08 || 1;
  const x = (k: number) => m.l + (labels.length <= 1 ? 0 : (k / (labels.length - 1)) * (W - m.l - m.r));
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b);
  // Gaps (null) break the line instead of being bridged.
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, k) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // Soft fill under each unbroken run of the series.
  const area = () => {
    let d = "";
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) {
        d += `M${x(run[0]).toFixed(1)},${y(0).toFixed(1)}`;
        for (const k of run) d += `L${x(k).toFixed(1)},${y(series[k] as number).toFixed(1)}`;
        d += `L${x(run[run.length - 1]).toFixed(1)},${y(0).toFixed(1)}Z`;
      }
      run = [];
    };
    series.forEach((v, k) => (v === null ? flush() : run.push(k)));
    flush();
    return d;
  };
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const every = Math.ceil(labels.length / 8);
  return (
    <div>
      <Legend
        items={[
          { color: COLORS.own, label: seriesLabel },
          ...(reference && referenceLabel ? [{ color: "var(--color-faint)", label: referenceLabel }] : []),
        ]}
      />
      <div className="mt-2 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={COLORS.own} stopOpacity={0.3} />
              <stop offset="1" stopColor={COLORS.own} stopOpacity={0} />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke="var(--color-line-soft)" strokeWidth={1} />
              <text x={m.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--color-faint)">
                {fmt(t)}
              </text>
            </g>
          ))}
          {labels.map((l, k) =>
            k % every === 0 ? (
              <text key={l + k} x={x(k)} y={H - 8} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)" fill="var(--color-faint)">
                {l.slice(5)}
              </text>
            ) : null,
          )}
          <path className="a-fade" d={area()} fill={`url(#${gid})`} />
          {reference && (
            <path className="a-fade" d={path(reference)} fill="none" stroke="var(--color-faint)" strokeWidth={1.5} strokeDasharray="4 4" />
          )}
          <path
            className="a-draw"
            pathLength={1}
            d={path(series)}
            fill="none"
            stroke={COLORS.own}
            strokeWidth={2.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {series.map((v, k) =>
            v === null ? null : (
              <circle key={k} className="a-pop" style={i(k)} cx={x(k)} cy={y(v)} r={4} fill="var(--color-surface)" stroke={COLORS.own} strokeWidth={2}>
                <title>{`${labels[k]} · ${seriesLabel}: ${fmt(v)}`}</title>
              </circle>
            ),
          )}
        </svg>
      </div>
    </div>
  );
}

// Every tagged event on a time axis, one lane per event type. Colour = team.
export function EventTimeline({
  events,
  segments = [],
  aLabel,
  bLabel,
  onSeek,
  timeLabel,
}: {
  events: MatchEvent[];
  // Stretches of the video; whatever is not "juego" is shaded behind the marks.
  segments?: Segment[];
  // Set when the axis joins several videos: writes the real video time of an event.
  timeLabel?: (e: MatchEvent) => string;
  aLabel: string;
  bLabel: string;
  onSeek?: (t: number) => void;
}) {
  if (events.length === 0) return <p className="text-sm text-faint">Aún no hay eventos que ubicar en el tiempo.</p>;
  const t0 = Math.min(...events.map((e) => e.t_video));
  const t1 = Math.max(...events.map((e) => e.t_video));
  const span = Math.max(1, t1 - t0);
  const lanes = EVENT_TYPES.map((type) => ({ type, evs: events.filter((e) => e.type === type) })).filter((l) => l.evs.length > 0);
  // Non-play stretches clipped to the visible range, as percentages.
  const shaded = segments
    .filter((s) => s.tipo !== "juego")
    .map((s) => ({ id: s.segment_id, tipo: s.tipo, a: Math.max(t0, s.start), b: Math.min(t1, s.end ?? t1) }))
    .filter((s) => s.b > s.a)
    .map((s) => ({ ...s, left: ((s.a - t0) / span) * 100, width: ((s.b - s.a) / span) * 100 }));
  return (
    <div>
      <Legend
        items={[
          { color: COLORS.own, label: aLabel },
          { color: COLORS.opp, label: bLabel },
        ]}
      />
      <div className="mt-4 space-y-1.5">
        {lanes.map((l, n) => (
          <div key={l.type} className="grid grid-cols-[6.5rem_1fr_1.75rem] items-center gap-3">
            <span className="truncate text-xs text-ink-2">{EVENT_LABELS[l.type]}</span>
            <div className="relative h-5 overflow-hidden rounded-full bg-bg/60">
              {shaded.map((s) => (
                <span
                  key={s.id}
                  title={s.tipo === "pausa" ? "Pausa" : "No medible"}
                  className="absolute top-0 bottom-0 bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--color-line)_3px_4px)]"
                  style={{ left: `${s.left}%`, width: `${s.width}%` }}
                />
              ))}
              {l.evs.map((e) => {
                const who = e.team === "own" ? aLabel : e.team === "opp" ? bLabel : "sin equipo";
                const style = {
                  left: `calc(${((e.t_video - t0) / span) * 100}% - 1.5px)`,
                  background: e.team === "own" ? COLORS.own : e.team === "opp" ? COLORS.opp : "var(--color-faint)",
                  ...i(n * 4),
                };
                const title = `${EVENT_LABELS[e.type]} · ${who} · ${timeLabel ? timeLabel(e) : fmtT(e.t_video)}`;
                const cls = "a-col absolute top-1 bottom-1 w-[3px] rounded-full";
                return onSeek ? (
                  <button
                    key={e.event_id}
                    type="button"
                    title={`${title} · clic para ir al video`}
                    aria-label={title}
                    onClick={() => onSeek(e.t_video)}
                    className={`${cls} cursor-pointer transition-[top,bottom,width] before:absolute before:-inset-x-1.5 before:-inset-y-1 hover:top-0 hover:bottom-0 hover:w-[5px]`}
                    style={style}
                  />
                ) : (
                  <span key={e.event_id} title={title} className={cls} style={style} />
                );
              })}
            </div>
            <span className="tc text-right text-[11px] text-faint">{l.evs.length}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[6.5rem_1fr_1.75rem] gap-3">
        <span />
        <span className="tc flex justify-between text-[10px] text-faint">
          <span>{timeLabel ? "inicio" : fmtT(t0)}</span>
          <span className="font-sans">
            {timeLabel ? "videos del partido en orden" : "tiempo del video"}
            {shaded.length > 0 ? " · rayado: pausa o no medible" : ""}
          </span>
          <span>{timeLabel ? "final" : fmtT(t1)}</span>
        </span>
        <span />
      </div>
    </div>
  );
}

// Small trend used on the summary screen: bars over ordered categories.
export function MiniBars({ values, labels, fmt }: { values: (number | null)[]; labels: string[]; fmt: (v: number) => string }) {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  return (
    <div className="flex h-24 items-end gap-1">
      {values.map((v, n) => (
        <div
          key={labels[n] + n}
          title={v === null ? `${labels[n]}: sin dato` : `${labels[n]}: ${fmt(v)}`}
          className={`a-col min-w-0 flex-1 rounded-t-md ${v === null ? "bg-line" : "bg-linear-to-t from-accent-800 to-accent-400"}`}
          style={{ height: v === null ? 2 : `${Math.max(4, (v / max) * 100)}%`, ...i(n * 2) }}
        />
      ))}
    </div>
  );
}

// Below this many events a proportion says little: the chart flags it instead of hiding the figure.
export const SMALL_SAMPLE = 10;

function SampleTag({ n }: { n: number }) {
  return n > 0 && n < SMALL_SAMPLE ? <span className="tag tag-outline">muestra pequeña</span> : null;
}

// "k of n" for the two teams: how often something ends a certain way.
export function RateDuo({
  a,
  b,
  aLabel,
  bLabel,
  unit,
}: {
  a: { k: number; n: number };
  b: { k: number; n: number };
  aLabel: string;
  bLabel: string;
  // What n counts, in plural: "pérdidas", "entradas al área".
  unit: string;
}) {
  const row = (r: { k: number; n: number }, who: string, color: string, n: number) => (
    <div title={`${who}: ${r.k} de ${r.n} ${unit}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="num text-4xl" style={{ color }}>
          {r.n === 0 ? "–" : <CountUp value={r.k} />}
        </span>
        <span className="text-xs text-muted">
          {r.n === 0 ? `sin ${unit}` : `de ${r.n} ${unit}`}
          {r.n > 0 && <span className="tc ml-1.5 text-faint">{Math.round((r.k / r.n) * 100)} %</span>}
        </span>
        <SampleTag n={r.n} />
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg/70">
        <div className="a-bar h-full rounded-full" style={{ width: `${r.n ? (r.k / r.n) * 100 : 0}%`, background: color, ...i(n) }} />
      </div>
      <div className="mt-1 text-[11px] text-faint">{who}</div>
    </div>
  );
  return (
    <div className="space-y-5">
      {row(a, aLabel, COLORS.own, 0)}
      {row(b, bLabel, COLORS.opp, 2)}
    </div>
  );
}

export interface PartsRow {
  who: string;
  color: string;
  parts: { label: string; value: number }[];
  // Events tagged without this datum, or without a position: shown apart, never spread over the parts.
  unknown?: number;
}

// How a total splits into a few categories, one bar per team. One hue per team; lighter steps for later parts.
export function PartsDuo({ rows, unknownLabel = "sin anotar" }: { rows: PartsRow[]; unknownLabel?: string }) {
  const steps = [100, 62, 34, 18];
  return (
    <div className="space-y-4">
      {rows.map((r, n) => {
        const known = r.parts.reduce((s, p) => s + p.value, 0);
        const total = known + (r.unknown ?? 0);
        return (
          <div key={r.who}>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
              <span className="text-ink-2">{r.who}</span>
              <span className="tc text-faint">n = {total}</span>
              <SampleTag n={total} />
            </div>
            <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-bg/70">
              {total === 0
                ? null
                : r.parts.map((p, k) =>
                    p.value === 0 ? null : (
                      <span
                        key={p.label}
                        title={`${r.who} · ${p.label}: ${p.value}`}
                        className="a-bar h-full"
                        style={{ width: `${(p.value / total) * 100}%`, background: `color-mix(in srgb, ${r.color} ${steps[k % steps.length]}%, var(--color-surface))`, ...i(n * 3 + k) }}
                      />
                    ),
                  )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
              {total === 0 ? (
                <span className="text-faint">Sin eventos de este tipo.</span>
              ) : (
                <>
                  {r.parts.map((p, k) => (
                    <span key={p.label} className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-sm" style={{ background: `color-mix(in srgb, ${r.color} ${steps[k % steps.length]}%, var(--color-surface))` }} />
                      {p.label} <span className="tc text-ink-2">{p.value}</span>
                    </span>
                  ))}
                  {(r.unknown ?? 0) > 0 && (
                    <span className="text-faint">
                      {unknownLabel} <span className="tc">{r.unknown}</span>
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Two columns per stretch of the match: what each team produced in it.
export function BinChart({
  bins,
  aLabel,
  bLabel,
}: {
  bins: { label: string; a: number; b: number }[];
  aLabel: string;
  bLabel: string;
}) {
  const max = Math.max(1, ...bins.flatMap((x) => [x.a, x.b]));
  if (bins.length === 0) return <p className="text-sm text-faint">Sin eventos dentro de un tramo de juego.</p>;
  return (
    <div>
      <Legend
        items={[
          { color: COLORS.own, label: aLabel },
          { color: COLORS.opp, label: bLabel },
        ]}
      />
      <div className="mt-4 overflow-x-auto">
        <div className="flex items-end gap-1.5" style={{ minWidth: bins.length * 34 }}>
          {bins.map((x, n) => (
            <div key={x.label} className="min-w-0 flex-1" title={`${x.label} · ${aLabel}: ${x.a} · ${bLabel}: ${x.b}`}>
              <div className="flex h-28 items-end justify-center gap-0.5 border-b border-line-soft">
                {([
                  [x.a, COLORS.own],
                  [x.b, COLORS.opp],
                ] as const).map(([v, color], k) => (
                  <div key={k} className="flex w-2.5 flex-col items-center justify-end" style={{ height: "100%" }}>
                    {v > 0 && <span className="a-fade tc mb-0.5 text-[9px] text-faint" style={i(n)}>{v}</span>}
                    <div className="a-col w-full rounded-t-sm" style={{ height: `${(v / max) * 78}%`, background: color, ...i(n) }} />
                  </div>
                ))}
              </div>
              <div className="tc mt-1 text-center text-[9px] whitespace-nowrap text-faint">{x.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Acute:chronic workload ratio per player on one scale, with the reference band shaded.
export function AcwrChart({
  players,
  band,
  onPick,
}: {
  players: { player_id: string; ratio: number | null; historyDays: number }[];
  band: [number, number];
  onPick?: (player_id: string) => void;
}) {
  const LO = 0.4;
  const HI = 2;
  const pos = (v: number) => `${((Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * 100}%`;
  const ready = players.filter((p) => p.ratio !== null);
  const waiting = players.filter((p) => p.ratio === null);
  return (
    <div>
      <div className="space-y-1">
        {ready.map((p, n) => {
          const r = p.ratio as number;
          const out = r < band[0] || r > band[1];
          const c = out ? "var(--color-warn)" : "var(--color-own)";
          const row = (
            <>
              <span className="tc truncate text-xs text-ink-2">{p.player_id}</span>
              <span className="relative h-4">
                <span className="absolute top-[7px] right-0 left-0 h-0.5 bg-line-soft" />
                <span className="absolute top-0.5 bottom-0.5 rounded-sm bg-accent/15" style={{ left: pos(band[0]), width: `calc(${pos(band[1])} - ${pos(band[0])})` }} />
                <span className="a-pop absolute top-[3px] h-2.5 w-2.5 -translate-x-1/2 rounded-full" style={{ left: pos(r), background: c, ...i(n) }} />
              </span>
              <span className="tc text-right text-xs" style={{ color: c }}>
                {r.toFixed(2)}
              </span>
            </>
          );
          const cls = "grid w-full grid-cols-[5.5rem_1fr_2.5rem] items-center gap-3 rounded-full px-2 py-1 text-left";
          const title = `${p.player_id}: ${r.toFixed(2)}${out ? " · fuera de la franja de referencia" : ""}`;
          return onPick ? (
            <button key={p.player_id} type="button" title={title} onClick={() => onPick(p.player_id)} className={`${cls} transition-colors hover:bg-raised/60`}>
              {row}
            </button>
          ) : (
            <div key={p.player_id} title={title} className={cls}>
              {row}
            </div>
          );
        })}
      </div>
      {ready.length > 0 && (
        <div className="mt-1 grid grid-cols-[5.5rem_1fr_2.5rem] gap-3 px-2">
          <span />
          <span className="tc relative h-4 text-[10px] text-faint">
            {[0.4, 0.8, 1.3, 2].map((v) => (
              <span key={v} className="absolute -translate-x-1/2" style={{ left: pos(v) }}>
                {v}
              </span>
            ))}
          </span>
          <span />
        </div>
      )}
      {waiting.length > 0 && (
        <p className="mt-3 text-xs text-pretty text-faint">
          Sin razón todavía (menos de cuatro semanas de historial): {waiting.map((p) => `${p.player_id} (${p.historyDays} d)`).join(", ")}.
        </p>
      )}
    </div>
  );
}
