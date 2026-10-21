"use client";

import { Plus, X } from "@phosphor-icons/react";
import { KICK_LABELS, endedLevel, shootoutScore } from "@/lib/shootout";
import { mutate, useStore } from "@/lib/store";
import type { Match, MatchEvent, ShootoutKick } from "@/lib/types";

// The penalty shootout of a drawn match, in the match data: each kick with its team, taker (optional) and result.
export function ShootoutPanel({ match, events }: { match: Match; events: MatchEvent[] }) {
  const { roster } = useStore();
  const kicks = match.shootout ?? [];
  if (!endedLevel(events) && kicks.length === 0) return null;
  const set = (next: ShootoutKick[]) =>
    mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, shootout: next.length ? next : undefined } : m)) }));
  const score = shootoutScore(kicks);
  const players = match.kind === "own" ? (roster ?? []) : [];
  const column = (team: "own" | "opp") => (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-2">
        <i className={`h-3 w-1 rounded-full ${team === "own" ? "bg-own" : "bg-opp"}`} />
        <span className="truncate">{team === "own" ? match.focus_team : match.other_team}</span>
        <span className="tc ml-auto text-ink">{score ? score[team] : 0}</span>
      </div>
      {kicks.map((k, i) =>
        k.team !== team ? null : (
          <div key={i} className="flex items-center gap-1 rounded-md bg-bg/60 px-1.5 py-1">
            <span className="tc w-4 text-[10px] text-faint">{kicks.slice(0, i + 1).filter((x) => x.team === team).length}</span>
            {team === "own" && players.length > 0 ? (
              <select
                className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none"
                aria-label="Quién tiró"
                value={k.player_id ?? ""}
                onChange={(e) => set(kicks.map((x, j) => (j === i ? { ...x, player_id: e.target.value || null } : x)))}
              >
                <option value="">¿quién?</option>
                {players.map((p) => (
                  <option key={p.player_id} value={p.player_id}>
                    {p.number !== null ? `${p.number} · ` : ""}
                    {p.player_id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-faint"
                placeholder="¿quién? (opcional)"
                aria-label="Quién tiró"
                value={k.player_id ?? ""}
                onChange={(e) => set(kicks.map((x, j) => (j === i ? { ...x, player_id: e.target.value || null } : x)))}
              />
            )}
            <button
              type="button"
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${k.result === "goal" ? "bg-ok/20 text-ok" : k.result === "saved" ? "bg-warn/20 text-warn" : "bg-danger/15 text-danger"}`}
              title="Clic: gol, atajado, fuera"
              onClick={() => set(kicks.map((x, j) => (j === i ? { ...x, result: x.result === "goal" ? "saved" : x.result === "saved" ? "missed" : "goal" } : x)))}
            >
              {KICK_LABELS[k.result]}
            </button>
            <button type="button" className="grid h-4 w-4 place-items-center text-faint hover:text-danger" aria-label="Quitar el tiro" onClick={() => set(kicks.filter((_, j) => j !== i))}>
              <X size={10} />
            </button>
          </div>
        ),
      )}
      <button type="button" className="link inline-flex items-center gap-1 text-[11px]" onClick={() => set([...kicks, { team, player_id: null, result: "goal" }])}>
        <Plus size={11} /> tiro
      </button>
    </div>
  );
  return (
    <section className="border-t border-line p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="cond m-0 text-sm font-bold tracking-wide text-ink uppercase">Tanda de penales</h3>
        <span className="text-[11px] text-faint">{kicks.length === 0 ? "empate: ¿hubo penales?" : `${score?.own}–${score?.opp}`}</span>
      </div>
      <div className="flex gap-3">
        {column("own")}
        {column("opp")}
      </div>
    </section>
  );
}
