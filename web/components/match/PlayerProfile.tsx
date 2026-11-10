"use client";

import { useMemo } from "react";
import { Select } from "@/components/Select";
import { PlayerMap } from "@/components/match/PlayerMap";
import { PlayerHeat, fmt, usePlayersData } from "@/components/match/PlayersCompare";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { Panel } from "@/components/match/Panel";
import { COLORS } from "@/components/Pitch";
import { Card } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import { momentOfEvent } from "@/lib/moments";
import { METRICS, NO_DATA, metricValue, type PlayerRow } from "@/lib/players";
import type { Segment } from "@/lib/segments";
import { setPref, usePref } from "@/lib/store";
import { EVENT_LABELS, type Match, type MatchEvent } from "@/lib/types";

const GROUPS = ["Ataque", "Con balón", "Defensa", "Físico"] as const;

// The match of one player: her figures, where she played, her shots and every event tagged with her name, each one a click
// away from its moment in the video. For two or more players side by side, see PlayersCompare.
export function PlayerProfile({
  match,
  events,
  videoIds,
  segmentsByVideo,
  ownTimes,
  timeLabel,
}: {
  match: Match;
  events: MatchEvent[];
  videoIds: string[];
  segmentsByVideo: Record<string, Segment[]>;
  // The same events with their own video times, to open a moment (see lib/moments).
  ownTimes: Map<string, MatchEvent> | null;
  timeLabel?: (e: MatchEvent) => string;
}) {
  const { rows, parts, label, fixed } = usePlayersData(match, events, videoIds, segmentsByVideo);
  const moment = useMomentPlayer(match);
  const prefKey = `profile:${match.match_id}`;
  const saved = usePref(prefKey, "");
  const row: PlayerRow | undefined = rows.find((r) => r.key === saved) ?? rows.find((r) => r.team === "own");
  const team = (s: "own" | "opp") => (s === "own" ? match.focus_team : match.other_team);
  const color = row?.team === "opp" ? COLORS.opp : COLORS.own;

  const mine = useMemo(() => (row ? events.filter((e) => e.player_id === row.id && e.team === row.team).sort((a, b) => a.t_video - b.t_video) : []), [events, row]);

  if (rows.length === 0)
    return (
      <Card>
        <p className="text-sm text-muted">Ninguna jugadora tiene datos propios todavía: hacen falta eventos con su nombre o su nombre en la mesa de corrección del tracking.</p>
        {match.folder && fixed === null && <p className="mt-2 text-xs text-faint">Leyendo el tracking de la carpeta del partido…</p>}
      </Card>
    );
  if (!row) return null;

  const minutes = row.minutes_played ?? null;
  const when = (e: MatchEvent) => (timeLabel ? timeLabel(e) : fmtT(e.t_video));
  const open = (e: MatchEvent) => moment.show(momentOfEvent(e, ownTimes, `${EVENT_LABELS[e.type]} · ${label(row)}`));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-surface/60 px-5 py-4">
        <span className="h-10 w-1.5 rounded-full" style={{ background: color }} />
        <div className="min-w-0">
          <div className="text-xl font-semibold text-ink">{label(row)}</div>
          <div className="text-xs text-muted">
            {team(row.team)} · {minutes != null ? `${Math.round(minutes)} min jugados` : `minutos jugados: ${NO_DATA}`}
            {row.events > 0 ? ` · ${row.events} eventos con su nombre` : ""}
          </div>
        </div>
        <div className="ml-auto">
          <Select
            variant="field"
            label="Elegir jugadora"
            value={row.key}
            onChange={(v) => v && setPref(prefKey, v)}
            options={(["own", "opp"] as const).flatMap((side) =>
              rows
                .filter((r) => r.team === side)
                .map((r, i) => ({ value: r.key, label: label(r), color: side === "own" ? COLORS.own : COLORS.opp, group: i === 0 ? team(side) : undefined })),
            )}
          />
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Sus cifras" note="del partido">
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {GROUPS.map((g) => {
              const ms = METRICS.filter((m) => m.group === g && (metricValue(row, m) ?? 0) > 0);
              if (ms.length === 0) return null;
              return (
                <div key={g}>
                  <div className="eyebrow mb-1.5">{g}</div>
                  <div className="divide-y divide-line-soft">
                    {ms.map((m) => {
                      const v = metricValue(row, m) as number;
                      const unit = m.unit === "%" ? " %" : m.unit ? ` ${m.unit}` : "";
                      return (
                        <div key={m.key} className="flex items-baseline justify-between gap-3 py-1.5">
                          <span className="text-xs text-ink-2">{m.label}</span>
                          <span className="num text-lg text-ink">
                            {fmt(v)}
                            <span className="text-xs text-faint">{unit}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Dónde jugó" note="tiempo en cada zona, atacando hacia la derecha">
          {row.minutes ? <PlayerHeat parts={parts} row={row} color={color} name={label(row)} /> : <p className="text-sm text-faint">No hay posiciones con su nombre en el tracking corregido.</p>}
        </Panel>

        <Panel title="Su mapa" note="elige qué ver; atacando hacia la derecha">
          <PlayerMap row={row} events={mine} parts={parts} segmentsByVideo={segmentsByVideo} color={color} onPick={open} />
        </Panel>

        <Panel title="Sus jugadas" note={`${mine.length} evento(s) con su nombre`}>
          {mine.length === 0 ? (
            <p className="text-sm text-faint">Ningún evento etiquetado con su nombre.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-line-soft overflow-y-auto pr-1">
              {mine.map((e) => (
                <li key={e.event_id}>
                  <button type="button" onClick={() => open(e)} className="flex w-full items-center gap-3 py-1.5 text-left text-sm transition-colors hover:bg-raised">
                    <span className="tc w-14 shrink-0 text-faint">{when(e)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{EVENT_LABELS[e.type]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      {moment.panel}
    </div>
  );
}
