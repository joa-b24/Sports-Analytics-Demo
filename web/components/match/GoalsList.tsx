"use client";

import { Play } from "@phosphor-icons/react";
import { COLORS } from "@/components/Pitch";
import { fmtT } from "@/lib/format";
import type { MatchEvent } from "@/lib/types";

// The goals of the match as a list: each one opens its moment in the player under the panel.
export function GoalsList({
  goals,
  aLabel,
  bLabel,
  timeLabel,
  onPick,
}: {
  goals: MatchEvent[];
  aLabel: string;
  bLabel: string;
  // Set when the axis joins several videos: writes the real video time of an event.
  timeLabel?: (e: MatchEvent) => string;
  onPick: (e: MatchEvent) => void;
}) {
  if (goals.length === 0) return <p className="mt-3 text-xs text-faint">Sin goles etiquetados en este corte.</p>;
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-xs text-faint">Goles · clic para verlos en el video</h3>
      <ul className="flex flex-wrap gap-1.5">
        {goals.map((g) => (
          <li key={g.event_id}>
            <button type="button" className="btn btn-ghost gap-1.5 text-xs" onClick={() => onPick(g)} title="Ver el gol en el video">
              <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: g.team === "own" ? COLORS.own : COLORS.opp }} />
              <span className="text-ink tabular-nums">{timeLabel ? timeLabel(g) : fmtT(g.t_video)}</span>
              <span className="text-ink-2">{g.team === "own" ? aLabel : bLabel}</span>
              {g.player_id && <span className="text-muted">{g.player_id}</span>}
              <Play size={11} weight="fill" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
