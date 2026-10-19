"use client";

import { ArrowDown, ArrowUp, Eye, EyeSlash, Lock } from "@phosphor-icons/react";
import { useState } from "react";
import { COLORS, Pitch } from "@/components/Pitch";
import { physical, teamBlock } from "@/lib/physical";
import { heatmap, passArrows, type Oriented } from "@/lib/positions";
import { NEED_TEXT, REPORT_SECTIONS, moveSection, toggleSection } from "@/lib/reportSections";
import type { Segment } from "@/lib/segments";
import { PITCH } from "@/lib/types";

type Side = "own" | "opp";
const color = (s: Side) => (s === "own" ? COLORS.own : COLORS.opp);
const onColor = (s: Side) => (s === "own" ? "var(--on-own)" : "var(--on-opp)");

// Bloque: where the team spent its time (heat), each player's average position and the block measures.
export function TeamBlockSection({ parts, side, team }: { parts: Oriented[]; side: Side; team: string }) {
  const b = teamBlock(parts, side);
  const h = heatmap(parts, side, null, 21, 14);
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
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem] print:grid-cols-[minmax(0,1fr)_14rem]">
      <div>
        <Pitch showDirection={false}>
          {cells.map((c, k) => c.o > 0.08 && <rect key={k} x={c.x} y={c.y} width={cw} height={ch} fill={color(side)} opacity={0.75 * c.o} />)}
          {b.line_m !== null && (
            <>
              <line
                x1={(b.line_m * PITCH.length) / (parts[0]?.file.venue?.length_m ?? PITCH.length)}
                x2={(b.line_m * PITCH.length) / (parts[0]?.file.venue?.length_m ?? PITCH.length)}
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
        <p className="mt-1 text-xs text-faint">Color: tiempo en cada zona · círculos: posición media · línea: altura de la defensa. {team} ataca hacia la derecha.</p>
      </div>
      <dl className="text-sm">
        {(
          [
            ["Altura de la línea defensiva", b.line_m, "m"],
            ["Largo del equipo", b.length_m, "m"],
            ["Ancho del equipo", b.width_m, "m"],
          ] as const
        ).map(([k, v, u]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b border-line py-2.5">
            <dt className="text-ink-2">{k}</dt>
            <dd className="num text-2xl text-ink">{v === null ? <span className="text-faint">—</span> : `${v} ${u}`}</dd>
          </div>
        ))}
        <p className="mt-2 text-xs text-faint">
          {Math.round(b.seconds / 60)} min revisados. Altura desde su portería: media de las 4 más retrasadas sin la portera.
          {b.line_m === null && " Hacen falta al menos 7 jugadoras de campo con nombre."}
        </p>
      </dl>
    </div>
  );
}

// Every pass as an arrow from the passer to the receiver; progressive ones (10 m or more forward) in full color.
export function PassMapSection({ parts, side, team, segmentsByVideo }: { parts: Oriented[]; side: Side; team: string; segmentsByVideo: Record<string, Segment[]> }) {
  const [all, setAll] = useState(false);
  const arrows = passArrows(parts, side, segmentsByVideo);
  if (arrows.length === 0) return <p className="text-sm text-faint">Sin pases de {team} leídos del balón.</p>;
  const prog = arrows.filter((a) => a.progressive).length;
  const id = `pm-${side}`;
  const drawn = all ? arrows : arrows.filter((a) => a.progressive);
  return (
    <div className="md:max-w-[80%]">
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
        {drawn.map((a, i) => (
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
          >
            <title>{a.from ?? "sin nombre"}</title>
          </line>
        ))}
      </Pitch>
      <p className="mt-1 text-xs text-faint">
        {arrows.length} pases con sus dos extremos en cuadro · {prog} progresivos (10 m o más hacia la portería rival, en color). {team} ataca hacia la derecha.
      </p>
    </div>
  );
}

// Distance, top speed, high-speed running and sprints by player, over the time each one was measured.
export function PhysicalSection({ parts, side, team }: { parts: Oriented[]; side: Side; team: string }) {
  const rows = physical(parts, side);
  if (rows.length === 0) return <p className="text-sm text-faint">Sin jugadoras con nombre de {team} en las partes revisadas.</p>;
  const maxD = Math.max(...rows.map((r) => r.distance_m), 1);
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-faint">
            <th className="py-1 font-normal">Jugadora</th>
            <th className="py-1 text-right font-normal">Medido</th>
            <th className="py-1 text-right font-normal">Distancia</th>
            <th className="py-1 text-right font-normal">m/min</th>
            <th className="py-1 text-right font-normal">Máx. km/h</th>
            <th className="py-1 text-right font-normal">&gt;18 km/h</th>
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
      <p className="mt-1 text-xs text-faint">
        Solo el tiempo en cuadro: lo que la cámara no ve no se mide. Velocidad sobre ventanas de 1 s; sprint: más de 22 km/h durante 1 s o más.
      </p>
    </div>
  );
}

// The analyst's layout: which sections, in what order. Locked ones stay listed with their reason.
export function SectionsEditor({ layout, onChange, missing, onClose }: { layout: string[]; onChange: (l: string[]) => void; missing: Record<string, string>; onClose: () => void }) {
  const shown = layout;
  const rest = REPORT_SECTIONS.filter((s) => !shown.includes(s.id));
  return (
    <div className="rounded-lg bg-raised p-4 print:hidden">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="cond text-base font-extrabold text-ink uppercase">Secciones</h3>
        <button type="button" className="btn" onClick={onClose}>
          Listo
        </button>
      </div>
      <ol className="space-y-1">
        {shown.map((id, i) => {
          const d = REPORT_SECTIONS.find((s) => s.id === id);
          if (!d) return null;
          return (
            <li key={id} className="flex items-center gap-2 rounded-md bg-surface px-3 py-1.5 text-sm">
              <span className="flex-1 text-ink">{d.title}</span>
              {missing[id] && <span className="text-xs text-faint">{missing[id]}</span>}
              {d.both && <span className="tag">compara</span>}
              <button type="button" className="btn btn-ghost !p-1" aria-label="Subir" disabled={i === 0} onClick={() => onChange(moveSection(layout, id, -1))}>
                <ArrowUp size={14} />
              </button>
              <button type="button" className="btn btn-ghost !p-1" aria-label="Bajar" disabled={i === shown.length - 1} onClick={() => onChange(moveSection(layout, id, 1))}>
                <ArrowDown size={14} />
              </button>
              <button type="button" className="btn btn-ghost !p-1" aria-label="Quitar del informe" onClick={() => onChange(toggleSection(layout, id))}>
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
