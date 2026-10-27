"use client";

import { useState } from "react";
import { FigureRow, StatList } from "@/components/match/ReportExtra";
import { COLORS, Pitch } from "@/components/Pitch";
import { possessionCover } from "@/lib/playgroundHealth";
import type { BallSummary, NetworkData, ReportData, TouchRow } from "@/lib/report";
import { LANES_5, THIRDS_3 } from "@/lib/stats";

// The parts of the report read from the followed ball (lib/report.ts, BallSummary): possession, passes, the pass
// network and the touches by player. They only draw.

type Side = "own" | "opp";
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : "—");
const min = (s: number) => `${(s / 60).toFixed(1)} min`;
const sideColor = (s: Side) => (s === "own" ? COLORS.own : COLORS.opp);

export function coverageText(b: BallSummary): string {
  return b.share !== null ? `medido en ${pct(b.share, 1)} del tiempo de juego (${min(b.followed_s)})` : `medido en ${min(b.followed_s)} con el balón seguido`;
}

export function BallBlock({ data }: { data: ReportData }) {
  const b = data.summary.ball;
  if (!b) return null;
  const A = data.cover.focus_team;
  const B = data.cover.other_team;
  const name = (s: Side) => (s === "own" ? A : B);
  const assigned = b.possession.own + b.possession.opp;
  const total = assigned + b.possession.unassigned;
  // The possession never goes without its coverage; a low coverage or little measured contact warns (no global threshold: each
  // figure says what it rests on).
  const cov = possessionCover(b.possession_detail);
  return (
    <div className="space-y-6">
      <div className="break-inside-avoid">
        <div className="text-sm font-medium text-ink">Posesión</div>
        <p className="text-xs text-faint">Leída del balón seguido, {coverageText(b)}.</p>
        <p className="text-xs text-ink-2">
          Posesión {cov.text}.
        </p>
        {cov.warning && <p className="text-xs text-warn">{cov.warning}</p>}
        {b.possession_warning && <p className="text-xs text-warn">{b.possession_warning}</p>}
        <p className="text-[11px] text-faint print:hidden">{b.possession_params}. Se cambian en Configuración del partido › Detalles técnicos.</p>
        <div className="mt-3 flex items-baseline justify-between text-sm">
          <span>
            <span className="num text-3xl" style={{ color: COLORS.own }}>
              {pct(b.possession.own, assigned)}
            </span>{" "}
            <span className="text-ink-2">{A}</span>
          </span>
          <span>
            <span className="text-ink-2">{B}</span>{" "}
            <span className="num text-3xl" style={{ color: COLORS.opp }}>
              {pct(b.possession.opp, assigned)}
            </span>
          </span>
        </div>
        <div className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full" title={`${A} ${min(b.possession.own)} · ${B} ${min(b.possession.opp)} · sin asignar ${min(b.possession.unassigned)}`}>
          <span className="h-full rounded-full" style={{ width: `${(100 * b.possession.own) / Math.max(1, total)}%`, background: COLORS.own }} />
          <span className="h-full rounded-full bg-line" style={{ width: `${(100 * b.possession.unassigned) / Math.max(1, total)}%` }} />
          <span className="h-full flex-1 rounded-full" style={{ background: COLORS.opp }} />
        </div>
        <p className="mt-1 text-xs text-faint">
          Sobre el tiempo con dueño. Sin asignar (gris: disputado, suelto o sin toque medido): {min(b.possession.unassigned)}, {pct(b.possession.unassigned, total)} del tiempo seguido.
        </p>
      </div>

      <div className="break-inside-avoid">
        <div className="text-sm font-medium text-ink">Pases leídos del balón</div>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-faint">
              <th className="py-1 font-normal" />
              <th className="py-1 text-right font-normal">Completos</th>
              <th className="py-1 text-right font-normal">Cortados</th>
              <th className="py-1 text-right font-normal">% completos</th>
            </tr>
          </thead>
          <tbody>
            {(["own", "opp"] as const).map((s) => {
              const p = b.passes[s];
              return (
                <tr key={s} className="border-b border-line-soft">
                  <td className="py-1" style={{ color: sideColor(s) }}>
                    {name(s)}
                    {p.approx > 0 && <span className="ml-1.5 text-[11px] text-faint" title="Sin nombres en la mesa de corrección: se cuenta a nivel de equipo y puede mezclar cambios de fragmento">aprox.</span>}
                  </td>
                  <td className="num py-1 text-right text-ink">{p.completed}</td>
                  <td className="num py-1 text-right text-ink">{p.cut}</td>
                  <td className="num py-1 text-right text-ink">{pct(p.completed, p.completed + p.cut)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-3 grid gap-4 md:grid-cols-2 print:grid-cols-2">
          <ZoneTable title="Por tercio de origen" labels={[...THIRDS_3]} get={(s) => [b.passes[s].completed_by_third, b.passes[s].cut_by_third]} name={name} />
          <ZoneTable title="Por carril de origen" labels={[...LANES_5]} get={(s) => [b.passes[s].completed_by_lane, b.passes[s].cut_by_lane]} name={name} />
        </div>
        <p className="mt-2 text-xs text-faint">
          Origen visto por el equipo que pasa, atacando hacia la derecha. Cambios de equipo leídos del balón: {b.changes.confirmed} confirmados por una pérdida
          etiquetada a menos de 2 s y {b.changes.inferred} solo inferidos
          {b.changes.tagged_unmatched > 0 && `; ${b.changes.tagged_unmatched} pérdida(s) etiquetada(s) con el balón seguido no tienen cambio leído`}.
        </p>
      </div>
    </div>
  );
}

function ZoneTable({ title, labels, get, name }: { title: string; labels: string[]; get: (s: Side) => [number[], number[]]; name: (s: Side) => string }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-faint">
          <th className="pb-1 font-normal">{title}</th>
          {(["own", "opp"] as const).map((s) => (
            <th key={s} className="pb-1 text-right font-normal" style={{ color: sideColor(s) }} title="completos / cortados">
              {name(s)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map((l, i) => (
          <tr key={l} className="border-t border-line-soft">
            <td className="py-0.5 text-ink-2">{l}</td>
            {(["own", "opp"] as const).map((s) => {
              const [c, x] = get(s);
              return (
                <td key={s} className="num py-0.5 text-right text-ink">
                  {c[i]} / {x[i]}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Three letters per player, unique: "Zoe" and "Zoe S." become "Zoe" and "ZoS".
function shortLabels(names: string[]): Map<string, string> {
  const base = (n: string) => n.replace(/^#/, "").slice(0, 3);
  const count = new Map<string, number>();
  for (const n of names) count.set(base(n), (count.get(base(n)) ?? 0) + 1);
  return new Map(
    names.map((n) => {
      const words = n.replace(/^#/, "").split(/\s+/).filter(Boolean);
      return [n, count.get(base(n))! > 1 && words.length > 1 ? `${words[0].slice(0, 2)}${words[1][0]}` : base(n)];
    }),
  );
}

export function NetworkBlock({ net, team, side = "own" }: { net: NetworkData; team: string; side?: Side }) {
  const short = shortLabels(net.nodes.map((n) => n.player));
  const byKey = new Map(net.nodes.map((n) => [n.player, n]));
  const maxEdge = Math.max(1, ...net.edges.map((e) => e.count));
  const c = sideColor(side);
  const pairs = [...net.edges].sort((a, b) => b.count - a.count).slice(0, 5);
  const most = [...net.nodes].sort((a, b) => b.touches - a.touches).slice(0, 5);
  return (
    <FigureRow
      note={
        <>
          {net.passes} pases completos de {team}. Grosor: pases entre las dos, en los dos sentidos. Tamaño: toques. Cada jugadora en su posición media medida.
          {net.unnamed > 0 && ` ${net.unnamed} pase(s) con una jugadora sin nombre no salen.`}
        </>
      }
      aside={
        <>
          <StatList title="Conexiones más usadas" items={pairs.map((e) => ({ label: `${e.a} – ${e.b}`, value: e.count }))} />
          <div className="mt-4">
            <StatList title="Más toques" items={most.map((n) => ({ label: n.player, value: n.touches }))} />
          </div>
        </>
      }
    >
      <Pitch>
        {net.edges.map((e) => {
          const a = byKey.get(e.a);
          const b = byKey.get(e.b);
          if (!a || !b) return null;
          return (
            <line key={`${e.a}-${e.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={0.3 + (2 * e.count) / maxEdge} opacity={0.35 + (0.55 * e.count) / maxEdge} strokeLinecap="round">
              <title>{`${e.a} – ${e.b}: ${e.count}`}</title>
            </line>
          );
        })}
        {net.nodes.map((n) => (
          <g key={n.player} transform={`translate(${n.x} ${n.y})`}>
            <circle r={1.6 + Math.min(2.2, n.touches / 25)} fill={c} stroke="var(--color-bg)" strokeWidth={0.4}>
              <title>{`${n.player}: ${n.touches} toques`}</title>
            </circle>
            <text y={0.8} textAnchor="middle" fontSize={2.2} fontWeight={700} fill={side === "own" ? "var(--on-own)" : "var(--on-opp)"} pointerEvents="none">
              {short.get(n.player)}
            </text>
          </g>
        ))}
      </Pitch>
    </FigureRow>
  );
}

export function TouchesBlock({ rows, team, other, coverage, print, onPrint }: { rows: TouchRow[]; team: string; other: string; coverage: string; print: boolean; onPrint: (v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 print:hidden">
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Ocultar" : "Ver"} los {rows.length} mapas
        </button>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={print} onChange={(e) => onPrint(e.target.checked)} />
          Incluir en la impresión
        </label>
      </div>
      <div className={`${open ? "" : "hidden"} ${print ? "print:block" : ""}`}>
        <p className="mt-3 text-xs text-faint">Toques leídos del balón, {coverage}. Por 10 min: sobre el tiempo con el balón seguido.</p>
        <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4 print:grid-cols-4">
          {rows.map((r) => (
            <div key={`${r.team}-${r.player}`} className="break-inside-avoid">
              <div className="flex items-baseline justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 text-ink-2">
                  <i className="h-2.5 w-1 rounded-full" style={{ background: sideColor(r.team) }} />
                  {r.player}
                </span>
                <span className="num text-ink">
                  {r.touches} <span className="text-faint">· {r.per10 ?? "—"}/10′</span>
                </span>
              </div>
              <Pitch showDirection={false}>
                {r.points.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={0.9} fill={sideColor(r.team)} opacity={0.6} />
                ))}
              </Pitch>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-faint">
          Barra de color: {team} o {other}. Cada mapa con su equipo atacando hacia la derecha.
        </p>
      </div>
    </div>
  );
}

export function LeftoversList({ b, team, other }: { b: BallSummary; team: string; other: string }) {
  if (b.leftovers.length === 0) return null;
  return (
    <details className="mt-2 print:hidden">
      <summary className="cursor-pointer text-xs text-warn">
        {b.leftovers.length} trozo(s) sin nombre de un equipo con nombres: no toman el balón. Revísalos en la mesa de corrección.
      </summary>
      <ul className="mt-1 grid grid-cols-2 gap-x-4 text-xs text-faint md:grid-cols-4">
        {b.leftovers.slice(0, 80).map((l, i) => (
          <li key={i}>
            <span className="tc">{l.moment.label}</span> · {l.team === "own" ? team : other} · {l.seconds} s
          </li>
        ))}
      </ul>
      {b.leftovers.length > 80 && <p className="text-xs text-faint">… y {b.leftovers.length - 80} más.</p>}
    </details>
  );
}
