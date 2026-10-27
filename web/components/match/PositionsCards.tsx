"use client";

import { useMemo, useState } from "react";
import { COLORS, Pitch } from "@/components/Pitch";
import { Card, input } from "@/components/Shell";
import { useFixedParts } from "@/lib/fixed";
import { fmtT } from "@/lib/format";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { REST_DEFENCE, behindBallAtLosses, behindSummary, heatmap, namedPlayers, type BehindBall, type BehindSummary } from "@/lib/positions";
import { PITCH, type Match, type MatchEvent } from "@/lib/types";

// Cards from the corrected positions of the match (tracks_fixed_*.json, saved from the correction table): heat map,
// pass network and players behind the ball. Only the corrected stretches count, and only what the camera saw.

type Side = "own" | "opp";
const SIDES: Side[] = ["own", "opp"];

export function PositionsCards({ match, videoIds, events }: { match: Match; videoIds: string[]; events: MatchEvent[] }) {
  const fixed = useFixedParts(match.folder, videoIds);
  const [heatTeam, setHeatTeam] = useState<Side>("own");
  const [heatPlayer, setHeatPlayer] = useState("");
  const parts = useMemo(() => fixed?.parts ?? [], [fixed]);
  const heat = useMemo(() => heatmap(parts, heatTeam, heatPlayer || null), [parts, heatTeam, heatPlayer]);
  const players = useMemo(() => namedPlayers(parts, heatTeam), [parts, heatTeam]);
  const behind = useMemo(() => behindBallAtLosses(parts, events), [parts, events]);
  const name = (s: Side) => (s === "own" ? match.focus_team : match.other_team);
  const moment = useMomentPlayer(match);

  if (!match.folder || !fixed || parts.length === 0) {
    return (
      <Card title="Mapa de calor y jugadoras detrás del balón" note="desde el tracking">
        <p className="text-sm text-pretty text-muted">
          {!match.folder
            ? "Este partido no tiene carpeta (se pone en «editar datos»)."
            : !fixed
              ? "Buscando partes corregidas en la carpeta del partido…"
              : fixed.unoriented.length > 0
                ? `Hay ${fixed.unoriented.length} parte(s) con posiciones, pero no se sabe hacia dónde ataca cada equipo: indícalo en la vista Balón de la mesa de corrección.`
                : "Todavía no hay partes procesadas de este partido (pestaña Tracking)."}
        </p>
      </Card>
    );
  }

  const minutes = parts.reduce((n, o) => n + (o.file.end_frame - o.file.start_frame) / o.file.fps, 0) / 60;
  const inferred = parts.filter((o) => o.dir === "inferred").length;
  const corrected = parts.filter((o) => !o.file.auto);
  const correctedMin = corrected.reduce((n, o) => n + (o.file.end_frame - o.file.start_frame) / o.file.fps, 0) / 60;
  const max = Math.max(...heat.seconds, 1e-9);
  const cw = PITCH.length / heat.nx;
  const ch = PITCH.width / heat.ny;
  const summary = behindSummary(behind);
  const teamToggle = (value: Side, set: (s: Side) => void) => (
    <div className="seg">
      {SIDES.map((s) => (
        <button key={s} type="button" aria-pressed={value === s} onClick={() => set(s)} className="seg-opt">
          {name(s)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-pretty text-faint">
        {minutes.toFixed(1)} min de video con posiciones, {correctedMin.toFixed(1)} de ellos corregidos a mano. Lo no corregido cuenta solo por
        equipo (la camiseta de cada caja): sirve para mapas de calor, forma y jugadoras detrás del balón, no para saber quién es quién
        {inferred > 0 && ` · en ${inferred} parte(s) la dirección de ataque se dedujo de dónde pasa el tiempo cada equipo`}
        {fixed.unoriented.length > 0 && ` · ${fixed.unoriented.length} sin dirección de ataque (no se usan)`}. Siempre con {match.focus_team} atacando
        hacia la derecha. Solo cuenta lo que salió en cuadro.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mapa de calor" note={`${(heat.total / 60).toFixed(1)} min-jugadora vistos`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {teamToggle(heatTeam, (s) => {
              setHeatTeam(s);
              setHeatPlayer("");
            })}
            <select className={input} value={heatPlayer} aria-label="Jugadora" onChange={(e) => setHeatPlayer(e.target.value)}>
              <option value="">Todo el equipo</option>
              {players.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({(p.seconds / 60).toFixed(1)} min)
                </option>
              ))}
            </select>
          </div>
          <Pitch>
            {heat.seconds.map((v, k) =>
              v <= 0 ? null : (
                <rect
                  key={k}
                  x={(k % heat.nx) * cw}
                  y={Math.floor(k / heat.nx) * ch}
                  width={cw}
                  height={ch}
                  fill={heatTeam === "own" ? COLORS.own : COLORS.opp}
                  opacity={0.08 + 0.8 * Math.sqrt(v / max)}
                  pointerEvents="none"
                />
              ),
            )}
          </Pitch>
          <p className="mt-2 text-[11px] text-pretty text-faint">
            Tiempo en cada zona; las posiciones rellenadas en huecos cortos no cuentan. La portería de {name(heatTeam)} está a la{" "}
            {heatTeam === "own" ? "izquierda" : "derecha"}.
          </p>
        </Card>

        <Card title="Jugadoras por detrás del balón al perderlo" note="B4 · clic en un cuadro para ver la pérdida">
          {!summary ? (
            <p className="text-sm text-pretty text-muted">
              Ninguna pérdida de {match.focus_team} cae en un tramo corregido. Cuentan las pérdidas etiquetadas («Pérdida» con posición) y los
              cambios de equipo que se leen del balón seguido.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="num text-4xl text-ink">{summary.mean.toFixed(1)}</span>
                <span className="text-sm text-muted">por detrás del balón de media, en {summary.n} pérdida(s)</span>
              </div>
              <p className="mt-1 text-xs text-ink-2">
                {summary.covered} de {summary.n} pérdidas con {REST_DEFENCE} o más detrás del balón ({Math.round((100 * summary.covered) / summary.n)} %).
              </p>
              <BehindUnits summary={summary} multi={videoIds.length > 1} onPick={(b) => moment.show({ video_id: b.video_id, t: b.t, label: `Pérdida de ${match.focus_team}: ${b.behind} de ${b.seen} detrás del balón` })} />
              <p className="mt-2 text-[11px] text-pretty text-faint">
                Cada cuadro es una pérdida, agrupada por cuántas jugadoras de {match.focus_team} estaban entre el balón y su portería. Relleno =
                pérdida etiquetada; borde = cambio de equipo leído del balón. «de N» son las que salen en cuadro en ese instante (incluida la
                portera si se ve); las que no salen no se cuentan.
              </p>
            </>
          )}
          {moment.panel}
        </Card>
      </div>
    </div>
  );
}

// One square per loss, stacked by how many players were behind the ball: a histogram that keeps each loss clickable.
// Filled = tagged loss, outlined = change of team read from the ball; the columns with REST_DEFENCE or more are covered.
function BehindUnits({ summary, multi, onPick }: { summary: BehindSummary; multi: boolean; onPick: (b: BehindBall) => void }) {
  const tallest = Math.max(1, ...summary.columns.map((c) => c.items.length));
  const size = Math.max(6, Math.min(16, Math.floor(150 / tallest)));
  return (
    <div className="mt-3 flex items-end gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Pérdidas por jugadoras detrás del balón">
      {summary.columns.map((c) => (
        <div key={c.behind} className="flex flex-col items-center gap-1">
          <div className="flex flex-col-reverse gap-[2px]" style={{ minHeight: size }}>
            {c.items.map((b) => (
              <button
                key={`${b.video_id}${b.t}${b.source}`}
                type="button"
                onClick={() => onPick(b)}
                title={`${multi ? `${b.video_id} ` : ""}${fmtT(b.t)} · ${b.behind} de ${b.seen} · ${b.source === "event" ? "etiquetada" : "leída del balón"}`}
                aria-label={`Ver la pérdida de ${multi ? `${b.video_id} ` : ""}${fmtT(b.t)}: ${b.behind} de ${b.seen} detrás del balón`}
                className="rounded-[3px] transition-transform hover:scale-110 focus-visible:scale-110"
                style={{
                  width: size + 6,
                  height: size,
                  background: b.source === "event" ? COLORS.own : "transparent",
                  border: `1.5px solid ${COLORS.own}`,
                }}
              />
            ))}
          </div>
          <span className={`tc text-xs ${c.behind >= REST_DEFENCE ? "text-ok" : "text-muted"}`}>{c.behind}</span>
        </div>
      ))}
    </div>
  );
}
