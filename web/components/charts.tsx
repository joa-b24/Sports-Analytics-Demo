import { COLORS, Pitch } from "./Pitch";
import { fmtT } from "@/lib/format";
import { EVENT_LABELS, PITCH, type MatchEvent } from "@/lib/types";

export function Legend({ items }: { items: { color: string; label: string; hollow?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={i.hollow ? { border: `2px solid ${i.color}` } : { background: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function StatTile({ label, a, b, aLabel, bLabel }: { label: string; a: number; b: number; aLabel: string; bLabel: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-3">
        <span className="text-2xl font-semibold text-slate-900 tabular-nums">{a}</span>
        <span className="text-sm text-slate-400">vs</span>
        <span className="text-2xl font-semibold text-slate-900 tabular-nums">{b}</span>
      </div>
      <div className="mt-1 flex gap-3 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ background: COLORS.own }} />
          {aLabel}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ background: COLORS.opp }} />
          {bLabel}
        </span>
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
  const bar = (v: number, color: string, who: string, label: string) => (
    <div className="flex items-center gap-2" title={`${label} · ${who}: ${v}`}>
      <div className="h-2.5 rounded-r" style={{ width: `${(v / max) * 82}%`, minWidth: v > 0 ? 3 : 0, background: color }} />
      <span className="text-xs text-slate-600 tabular-nums">{v}</span>
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
      <div className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
            <div className="text-xs text-slate-700">{r.label}</div>
            <div className="space-y-0.5 border-l border-slate-300 pl-0">
              {bar(r.a, COLORS.own, aLabel, r.label)}
              {bar(r.b, COLORS.opp, bLabel, r.label)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Shots on the pitch: filled = goal, hollow = no goal. Colour = team.
export function ShotMap({ events, aLabel, bLabel }: { events: MatchEvent[]; aLabel: string; bLabel: string }) {
  const shots = events.filter((e) => (e.type === "shot" || e.type === "goal") && e.x !== null && e.y !== null);
  const missing = events.filter((e) => (e.type === "shot" || e.type === "goal") && (e.x === null || e.y === null)).length;
  return (
    <div>
      <Legend
        items={[
          { color: COLORS.own, label: aLabel },
          { color: COLORS.opp, label: bLabel },
          { color: "#52514e", label: "Gol (relleno)" },
          { color: "#52514e", label: "Tiro sin gol", hollow: true },
        ]}
      />
      <Pitch className="mt-2">
        {shots.map((e) => {
          const c = e.team === "own" ? COLORS.own : COLORS.opp;
          return (
            <circle
              key={e.event_id}
              cx={e.x as number}
              cy={e.y as number}
              r={1.5}
              fill={e.type === "goal" ? c : COLORS.grass}
              stroke={c}
              strokeWidth={0.55}
            >
              <title>{`${EVENT_LABELS[e.type]} · ${e.team === "own" ? aLabel : bLabel} · ${fmtT(e.t_video)}`}</title>
            </circle>
          );
        })}
      </Pitch>
      {missing > 0 && <p className="mt-1 text-xs text-slate-500">{missing} tiro(s) sin posición marcada no aparecen en el mapa.</p>}
    </div>
  );
}

const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#104281"];

// 3 x 3 zone counts (thirds along the pitch x lanes across it), one hue, light to dark.
export function ZoneMap({ grid, missing }: { grid: number[][]; missing: number }) {
  const max = Math.max(0, ...grid.flat());
  const cw = PITCH.length / 3;
  const ch = PITCH.width / 3;
  return (
    <div>
      <Pitch>
        {grid.map((row, r) =>
          row.map((v, c) => {
            const step = max === 0 || v === 0 ? -1 : Math.min(RAMP.length - 1, Math.floor((v / max) * (RAMP.length - 1) + 0.0001));
            return (
              <g key={`${r}-${c}`}>
                <rect
                  x={c * cw + 0.4}
                  y={r * ch + 0.4}
                  width={cw - 0.8}
                  height={ch - 0.8}
                  rx={1}
                  fill={step < 0 ? "transparent" : RAMP[step]}
                  fillOpacity={0.9}
                >
                  <title>{`${v} evento(s) en esta zona`}</title>
                </rect>
                <text
                  x={c * cw + cw / 2}
                  y={r * ch + ch / 2 + 1.8}
                  textAnchor="middle"
                  fontSize={4}
                  fontWeight={600}
                  fill={step >= 3 ? "#ffffff" : "#0b0b0b"}
                  pointerEvents="none"
                >
                  {v}
                </text>
              </g>
            );
          }),
        )}
      </Pitch>
      {missing > 0 && <p className="mt-1 text-xs text-slate-500">{missing} evento(s) sin posición marcada no se cuentan.</p>}
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
  const W = 640;
  const H = 220;
  const m = { l: 48, r: 16, t: 12, b: 28 };
  const all = [...series, ...(reference ?? [])].filter((v): v is number => v !== null);
  if (all.length === 0) return <p className="text-sm text-slate-500">Sin datos para esta métrica.</p>;
  const max = Math.max(...all) * 1.08 || 1;
  const x = (i: number) => m.l + (labels.length <= 1 ? 0 : (i / (labels.length - 1)) * (W - m.l - m.r));
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b);
  // Gaps (null) break the line instead of being bridged.
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const every = Math.ceil(labels.length / 8);
  return (
    <div>
      <Legend
        items={[
          { color: COLORS.own, label: seriesLabel },
          ...(reference && referenceLabel ? [{ color: "#8a8983", label: referenceLabel }] : []),
        ]}
      />
      <div className="mt-2 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke="#e6e5e1" strokeWidth={1} />
              <text x={m.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="#52514e">
                {fmt(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % every === 0 ? (
              <text key={l + i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#52514e">
                {l.slice(5)}
              </text>
            ) : null,
          )}
          {reference && <path d={path(reference)} fill="none" stroke="#8a8983" strokeWidth={1.5} strokeDasharray="4 3" />}
          <path d={path(series)} fill="none" stroke={COLORS.own} strokeWidth={2} strokeLinejoin="round" />
          {series.map((v, i) =>
            v === null ? null : (
              <circle key={i} cx={x(i)} cy={y(v)} r={4} fill={COLORS.own} stroke="#ffffff" strokeWidth={2}>
                <title>{`${labels[i]} · ${seriesLabel}: ${fmt(v)}`}</title>
              </circle>
            ),
          )}
        </svg>
      </div>
    </div>
  );
}
