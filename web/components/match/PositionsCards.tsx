"use client";

import { useMemo, useState } from "react";
import { COLORS, Pitch } from "@/components/Pitch";
import { Panel } from "@/components/match/Panel";
import { Card, input } from "@/components/Shell";
import { useFixedParts } from "@/lib/fixed";
import { heatmapSmooth, namedPlayers } from "@/lib/positions";
import { PITCH, type Match, type MatchEvent } from "@/lib/types";

// Cards from the corrected positions of the match (tracks_fixed_*.json, saved from the correction table): the heat map.
// Only the corrected stretches count, and only what the camera saw.

type Side = "own" | "opp";
const SIDES: Side[] = ["own", "opp"];

export function PositionsCards({ match, videoIds }: { match: Match; videoIds: string[]; events?: MatchEvent[] }) {
  const fixed = useFixedParts(match.folder, videoIds);
  const [heatTeam, setHeatTeam] = useState<Side | "both">("own");
  const [heatPlayer, setHeatPlayer] = useState("");
  const parts = useMemo(() => fixed?.parts ?? [], [fixed]);
  const one: Side = heatTeam === "both" ? "own" : heatTeam;
  const heat = useMemo(() => heatmapSmooth(parts, one, heatPlayer || null), [parts, one, heatPlayer]);
  const heatOpp = useMemo(() => (heatTeam === "both" ? heatmapSmooth(parts, "opp", null) : null), [parts, heatTeam]);
  const players = useMemo(() => namedPlayers(parts, one), [parts, one]);
  const name = (s: Side) => (s === "own" ? match.focus_team : match.other_team);

  if (!match.folder || !fixed || parts.length === 0) {
    return (
      <Card title="Mapa de calor" note="desde el tracking">
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
  const cells = (h: typeof heat, side: Side) => {
    const max = Math.max(...h.seconds, 1e-9);
    const cw = PITCH.length / h.nx;
    const ch = PITCH.width / h.ny;
    return h.seconds.map((v, k) =>
      v / max <= 0.03 ? null : (
        <rect key={k} x={(k % h.nx) * cw} y={Math.floor(k / h.nx) * ch} width={cw} height={ch} fill={side === "own" ? COLORS.own : COLORS.opp} style={{ opacity: `calc(var(--heat-floor) + var(--heat-gain) * ${0.08 + 0.8 * Math.sqrt(v / max)})` }} pointerEvents="none" />
      ),
    );
  };
  return (
    <div className="space-y-4">
      <p className="text-xs text-pretty text-faint">
        {minutes.toFixed(1)} min de video con posiciones, {correctedMin.toFixed(1)} de ellos corregidos a mano. Lo no corregido cuenta solo por
        equipo (la camiseta de cada caja): sirve para mapas de calor y forma, no para saber quién es quién
        {inferred > 0 && ` · en ${inferred} parte(s) la dirección de ataque se dedujo de dónde pasa el tiempo cada equipo`}
        {fixed.unoriented.length > 0 && ` · ${fixed.unoriented.length} sin dirección de ataque (no se usan)`}. Siempre con {match.focus_team} atacando
        hacia la derecha. Solo cuenta lo que salió en cuadro.
      </p>
      <div className="grid gap-4">
        <Panel title="Mapa de calor" note={heatTeam === "both" ? "los dos equipos" : `${(heat.total / 60).toFixed(1)} min-jugadora vistos`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="seg">
              {([...SIDES, "both"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={heatTeam === s}
                  onClick={() => {
                    setHeatTeam(s);
                    setHeatPlayer("");
                  }}
                  className="seg-opt"
                >
                  {s === "both" ? "Lado a lado" : name(s)}
                </button>
              ))}
            </div>
            {heatTeam !== "both" && (
              <select className={input} value={heatPlayer} aria-label="Jugadora" onChange={(e) => setHeatPlayer(e.target.value)}>
                <option value="">Todo el equipo</option>
                {players.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} ({(p.seconds / 60).toFixed(1)} min)
                  </option>
                ))}
              </select>
            )}
          </div>
          {heatTeam === "both" && heatOpp ? (
            <div className="grid gap-4 md:grid-cols-2">
              {(
                [
                  ["own", heat],
                  ["opp", heatOpp],
                ] as const
              ).map(([side, h]) => (
                <figure key={side} className="min-w-0">
                  <figcaption className="mb-1 text-xs text-ink-2">{name(side)}</figcaption>
                  <Pitch>{cells(h, side)}</Pitch>
                </figure>
              ))}
            </div>
          ) : (
            <Pitch>{cells(heat, one)}</Pitch>
          )}
          <p className="mt-2 text-[11px] text-pretty text-faint">
            Tiempo en cada zona; las posiciones rellenadas en huecos cortos no cuentan.
            {heatTeam !== "both" && ` La portería de ${name(one)} está a la ${one === "own" ? "izquierda" : "derecha"}.`}
          </p>
        </Panel>
      </div>
    </div>
  );
}
