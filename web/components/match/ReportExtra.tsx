"use client";

import { ArrowDown, ArrowUp, Eye, EyeSlash, Lock } from "@phosphor-icons/react";
import { useState } from "react";
import { RATING_NOTE, RatingBadge } from "@/components/match/RatingBadge";
import { COLORS, Pitch } from "@/components/Pitch";
import type { Rating } from "@/lib/rating";
import type { TrackingView } from "@/lib/trackingView";
import { NEED_TEXT, REPORT_SECTIONS, moveSection, toggleSection } from "@/lib/reportSections";
import { PITCH, type MatchEvent } from "@/lib/types";

type Side = "own" | "opp";
const color = (s: Side) => (s === "own" ? COLORS.own : COLORS.opp);
const onColor = (s: Side) => (s === "own" ? "var(--on-own)" : "var(--on-opp)");

// Every pitch of the report has the same size: the figure, and beside it the few figures that read it.
export function FigureRow({ children, aside, note }: { children: React.ReactNode; aside: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="grid gap-6 break-inside-avoid md:grid-cols-[minmax(0,1fr)_15rem] print:grid-cols-[minmax(0,1fr)_13rem]">
      <div className="min-w-0">
        {children}
        {note && <p className="mt-1 text-xs text-faint">{note}</p>}
      </div>
      <div className="min-w-0">{aside}</div>
    </div>
  );
}

// Label and figure, one per line; `mark` is the colour of the series it belongs to (text stays in ink).
export function StatList({ items, title }: { items: { label: string; value: React.ReactNode; mark?: string; hollow?: boolean }[]; title?: string }) {
  return (
    <dl className="text-sm">
      {title && <div className="mb-1 text-xs font-medium text-muted">{title}</div>}
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline justify-between gap-3 border-b border-line-soft py-2">
          <dt className="flex min-w-0 items-center gap-1.5 text-ink-2">
            {it.mark && <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={it.hollow ? { border: `2px solid ${it.mark}` } : { background: it.mark }} />}
            <span className="min-w-0">{it.label}</span>
          </dt>
          <dd className="num text-xl whitespace-nowrap text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Bloque: where the team spent its time (heat), each player's average position and the block measures.
export function TeamBlockSection({ view, side, team }: { view: TrackingView; side: Side; team: string }) {
  const b = view.block(side) ?? { players: [], line_m: null, length_m: null, width_m: null, seconds: 0 };
  const h = view.heat(side) ?? { nx: 42, ny: 28, seconds: [] as number[], total: 0 };
  const max = Math.max(...h.seconds, 1e-9);
  const cw = PITCH.length / h.nx;
  const ch = PITCH.width / h.ny;
  // heatmap() draws the analysed team attacking right; the rival is turned to attack right too.
  const cells = h.seconds.map((v, k) => {
    let i = k % h.nx;
    let j = Math.floor(k / h.nx);
    if (side === "opp") [i, j] = [h.nx - 1 - i, h.ny - 1 - j];
    return { x: i * cw, y: j * ch, o: v / max };
  });
  if (b.players.length === 0 && h.total === 0) return <p className="text-sm text-faint">Sin posiciones de {team} en las partes revisadas.</p>;
  return (
    <FigureRow
      note={<>Color: tiempo en cada zona · círculos: posición media · línea: altura de la defensa. {team} ataca hacia la derecha.</>}
      aside={
        <>
          <StatList
            items={(
              [
                ["Altura de la línea defensiva", b.line_m],
                ["Largo del equipo", b.length_m],
                ["Ancho del equipo", b.width_m],
              ] as const
            ).map(([k, v]) => ({ label: k, value: v === null ? <span className="text-faint">—</span> : `${v} m` }))}
          />
          <p className="mt-2 text-xs text-faint">
            {Math.round(b.seconds / 60)} min revisados. Altura desde su portería: media de las 4 más retrasadas sin la portera.
            {b.line_m === null && " Hacen falta al menos 7 jugadoras de campo con nombre."}
          </p>
        </>
      }
    >
        <Pitch showDirection={false}>
          {cells.map((c, k) => c.o > 0.08 && <rect key={k} x={c.x} y={c.y} width={cw} height={ch} fill={color(side)} style={{ opacity: `calc(var(--heat-floor) + var(--heat-gain) * ${0.75 * c.o})` }} />)}
          {b.line_m !== null && (
            <>
              <line
                x1={(b.line_m * PITCH.length) / (view.venueLength ?? PITCH.length)}
                x2={(b.line_m * PITCH.length) / (view.venueLength ?? PITCH.length)}
                y1={1}
                y2={PITCH.width - 1}
                stroke="var(--color-ink)"
                strokeWidth={0.35}
                strokeDasharray="1.2 1"
              />
            </>
          )}
          {b.players.map((p) => (
            <g key={p.name} transform={`translate(${p.x} ${p.y})`}>
              <circle r={2.4} fill="var(--color-bg)" stroke="var(--color-ink)" strokeWidth={0.35}>
                <title>{`${p.name}: ${Math.round(p.seconds / 60)} min medidos`}</title>
              </circle>
              <text y={0.8} textAnchor="middle" fontSize={2.1} fontWeight={700} fill="var(--color-ink)" style={{ fontStretch: "75%" }}>
                {p.name.slice(0, 3)}
              </text>
            </g>
          ))}
        </Pitch>
    </FigureRow>
  );
}

// Every pass as an arrow from the passer to the receiver; progressive ones (10 m or more forward) in full color.
export function PassMapSection({ view, side, team, events = [], onPick }: { view: TrackingView; side: Side; team: string; events?: MatchEvent[]; onPick?: (m: { video_id: string; t: number; label: string }) => void }) {
  const [all, setAll] = useState(false);
  const keyEvents = events.filter((e) => e.type === "key_pass" && e.team === side);
  const arrows = view.arrows(side, keyEvents);
  if (arrows.length === 0) return <p className="text-sm text-faint">Sin pases de {team} leídos del balón.</p>;
  const prog = arrows.filter((a) => a.progressive).length;
  const id = `pm-${side}`;
  const keys = arrows.filter((a) => a.key);
  const drawn = all ? arrows : arrows.filter((a) => a.progressive || a.key);
  // A click on an arrow plays the pass: a few seconds before it, in the player of the report.
  const hit = (a: { from: string | null; video_id: string; t: number }) =>
    onPick ? { style: { cursor: "pointer", pointerEvents: "stroke" as const }, onClick: () => onPick({ video_id: a.video_id, t: a.t, label: `Pase${a.from ? ` de ${a.from}` : ""}` }) } : {};
  const byPlayer = new Map<string, number>();
  for (const a of arrows) if (a.progressive && a.from) byPlayer.set(a.from, (byPlayer.get(a.from) ?? 0) + 1);
  const top = [...byPlayer].sort((x, y) => y[1] - x[1]).slice(0, 5);
  return (
    <FigureRow
      note={<>{arrows.length} pases con sus dos extremos en cuadro · {prog} progresivos (10 m o más hacia la portería rival, en color){keyEvents.length > 0 && <> · pases clave marcados en amarillo ({keys.length} de {keyEvents.length} ubicados en el balón)</>}. {team} ataca hacia la derecha.</>}
      aside={
        <>
          <StatList
            items={[
              { label: "Pases leídos", value: arrows.length },
              { label: "Progresivos", value: prog, mark: color(side) },
              { label: "Pases clave", value: `${keys.length} de ${keyEvents.length}` },
              { label: "% progresivos", value: `${Math.round((100 * prog) / arrows.length)} %` },
            ]}
          />
          {top.length > 0 && (
            <div className="mt-4">
              <StatList title="Más pases progresivos" items={top.map(([n, k]) => ({ label: n, value: k }))} />
            </div>
          )}
        </>
      }
    >
      <div className="seg mb-2 print:hidden" role="group" aria-label="Qué pases">
        <button type="button" className="seg-opt" aria-pressed={!all} onClick={() => setAll(false)}>
          Progresivos ({prog})
        </button>
        <button type="button" className="seg-opt" aria-pressed={all} onClick={() => setAll(true)}>
          Todos ({arrows.length})
        </button>
      </div>
      <Pitch showDirection={false}>
        <defs>
          <marker id={id} viewBox="0 0 6 6" refX={5} refY={3} markerWidth={3.5} markerHeight={3.5} orient="auto">
            <path d="M0 0L6 3L0 6z" fill="context-stroke" />
          </marker>
        </defs>
        {drawn.filter((a) => !a.key).map((a, i) => (
          <line
            key={i}
            x1={a.x1}
            y1={a.y1}
            x2={a.x2}
            y2={a.y2}
            stroke={a.progressive ? color(side) : "var(--color-muted)"}
            strokeOpacity={a.progressive ? 0.95 : 0.45}
            strokeWidth={a.progressive ? 0.45 : 0.3}
            markerEnd={`url(#${id})`}
            {...hit(a)}
          >
            <title>{`${a.from ?? "sin nombre"}${onPick ? " · clic para ver el video" : ""}`}</title>
          </line>
        ))}
        {keys.map((a, i) => (
          <g key={`k${i}`}>
            <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="var(--color-bg)" strokeWidth={1.3} strokeOpacity={0.7} />
            <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="var(--color-ball-track)" strokeWidth={0.7} markerEnd={`url(#${id})`} {...hit(a)}>
              <title>{`Pase clave${a.from ? ` de ${a.from}` : ""}${onPick ? " · clic para ver el video" : ""}`}</title>
            </line>
            <circle cx={a.x2} cy={a.y2} r={1.1} fill="var(--color-ball-track)" stroke="var(--color-bg)" strokeWidth={0.3} />
          </g>
        ))}
      </Pitch>
    </FigureRow>
  );
}

// Distance, top speed, high-speed running and sprints by player, over the time each one was measured.
export function PhysicalSection({ view, side, team, ratings }: { view: TrackingView; side: Side; team: string; ratings?: Map<string, Rating> }) {
  const rows = view.physical(side);
  if (rows.length === 0) return <p className="text-sm text-faint">Sin jugadoras con nombre de {team} en las partes revisadas.</p>;
  const maxD = Math.max(...rows.map((r) => r.distance_m), 1);
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-faint">
            <th className="py-1 font-normal">Jugadora</th>
            {ratings && (
              <th className="py-1 text-right font-normal" title={RATING_NOTE}>
                Calif. <span className="text-[9px] text-warn">en revisión</span>
              </th>
            )}
            <th className="py-1 text-right font-normal" title="Tiempo en cuadro (medido o rellenado)">Tiempo visto</th>
            <th className="py-1 text-right font-normal">Distancia</th>
            <th className="py-1 text-right font-normal">m/min</th>
            <th className="py-1 text-right font-normal" title="El momento más rápido de un sprint válido (22 km/h o más durante al menos 1 s, con aceleración posible). Sin sprint, no hay velocidad máxima.">Vel. máx. km/h</th>
            <th className="py-1 text-right font-normal" title="Carrera de alta velocidad: distancia a más de 18 km/h">HSR</th>
            <th className="py-1 text-right font-normal">Sprints</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-line-soft">
              <td className="py-1.5 text-ink">
                {r.name}
                <span className="mt-1 block h-0.5 rounded-full bg-line">
                  <span className="block h-full rounded-full" style={{ width: `${(100 * r.distance_m) / maxD}%`, background: color(side) }} />
                </span>
              </td>
              {ratings && (
                <td className="py-1.5 text-right">
                  <RatingBadge rating={ratings.get(`${side}|${r.name}`)} mark={false} />
                </td>
              )}
              <td className="num py-1.5 text-right text-muted">{Math.round(r.seconds / 60)} min</td>
              <td className="num py-1.5 text-right text-ink">{r.distance_m.toLocaleString("es-MX")} m</td>
              <td className="num py-1.5 text-right text-ink">{r.per_min_m ?? "—"}</td>
              <td className="num py-1.5 text-right text-ink">{r.top_kmh ?? "—"}</td>
              <td className="num py-1.5 text-right text-ink">{r.hsr_m} m</td>
              <td className="num py-1.5 text-right text-ink">{r.sprints}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ratings && <p className="mt-1 text-xs text-faint">Calificación (0-10, 6 = jugadora normal de su equipo en el partido): {RATING_NOTE}</p>}
      <p className="mt-1 text-xs text-faint">
        Solo el tiempo en cuadro: lo que la cámara no ve no se mide. Velocidad sobre ventanas de 1 s; HSR: distancia a más de 18 km/h; sprint: 22 km/h o más durante 1 s o más y con una aceleración posible (hasta 8 m/s²); la velocidad máxima es la del mejor sprint válido.
      </p>
    </div>
  );
}

// The analyst's layout: which sections, in what order. Locked ones stay listed with their reason.
export function SectionsEditor({ layout, extras, onChange, onDropExtra, missing, onClose }: { layout: string[]; extras: { id: string; title: string }[]; onChange: (l: string[]) => void; onDropExtra: (id: string) => void; missing: Record<string, string>; onClose: () => void }) {
  const shown = layout;
  const rest = REPORT_SECTIONS.filter((s) => !shown.includes(s.id));
  return (
    <div className="rounded-lg bg-raised p-4 shadow-[inset_0_0_0_1px_var(--color-line-soft)] print:hidden">
      <div className="mb-3 flex items-center gap-3">
        <h3 className="cond m-0 text-base font-extrabold text-ink uppercase">Secciones</h3>
        <span className="text-xs text-faint">{shown.length} en el informe · ordénalas con las flechas</span>
        <span className="flex-1" />
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Listo
        </button>
      </div>
      <ol className="space-y-1">
        {shown.map((id, i) => {
          const d = REPORT_SECTIONS.find((s) => s.id === id);
          const extra = id.startsWith("x:") ? extras.find((x) => `x:${x.id}` === id) : undefined;
          if (!d && !extra) return null;
          return (
            <li key={id} className="flex items-center gap-2 rounded-md bg-surface px-3 py-1.5 text-sm shadow-[inset_0_0_0_1px_var(--color-line-soft)]">
              <span className="tc w-5 text-right text-xs text-faint">{i + 1}</span>
              <span className="flex-1 text-ink">{d?.title ?? extra?.title}</span>
              {extra && <span className="tag">del dashboard</span>}
              {d && missing[id] && <span className="text-xs text-faint">{missing[id]}</span>}
              {d?.both && <span className="tag">compara</span>}
              <span className="inline-flex overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--color-line)]">
                <button type="button" className="btn btn-ghost !rounded-none !p-1" aria-label="Subir" disabled={i === 0} onClick={() => onChange(moveSection(layout, id, -1))}>
                  <ArrowUp size={14} />
                </button>
                <button type="button" className="btn btn-ghost !rounded-none !p-1" aria-label="Bajar" disabled={i === shown.length - 1} onClick={() => onChange(moveSection(layout, id, 1))}>
                  <ArrowDown size={14} />
                </button>
              </span>
              <button type="button" className="btn btn-ghost !p-1" aria-label="Quitar del informe" title={extra ? "Quitar este gráfico del informe" : "Ocultar del informe"} onClick={() => (extra ? onDropExtra(extra.id) : onChange(toggleSection(layout, id)))}>
                <EyeSlash size={14} />
              </button>
            </li>
          );
        })}
      </ol>
      {rest.length > 0 && (
        <>
          <div className="mt-4 mb-1 text-xs text-faint">Biblioteca</div>
          <ul className="grid gap-1 md:grid-cols-2">
            {rest.map((d) => (
              <li key={d.id} className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm">
                <span className={`flex-1 ${d.locked ? "text-faint" : "text-ink-2"}`}>{d.title}</span>
                {d.locked ? (
                  <span className="flex items-center gap-1 text-xs text-faint" title={d.locked}>
                    <Lock size={12} />
                    {d.needs === "dev" ? "en desarrollo" : NEED_TEXT[d.needs]}
                  </span>
                ) : (
                  <button type="button" className="btn btn-ghost !p-1" aria-label={`Añadir ${d.title}`} onClick={() => onChange(toggleSection(layout, d.id))}>
                    <Eye size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export { onColor };
