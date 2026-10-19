"use client";

import { Check } from "@phosphor-icons/react";
import Link from "next/link";
import type { StepId, StepStatus } from "@/lib/steps";
import type { Match, MatchEvent } from "@/lib/types";

// The three modes of a match: capture the data from the video, study it (plays, drawings, the board) and read it
// (analysis on screen and the report to export). Each mode lists its steps.
export const MODES = [
  { id: "capture", label: "Captura", main: "tag", steps: [["calibration", "Calibración"], ["segments", "Tramos"], ["tracking", "Tracking"], ["tag", "Eventos"]] },
  { id: "study", label: "Estudio", main: "plays", steps: [["plays", "Jugadas"]] },
  { id: "analysis", label: "Análisis", main: "analysis", steps: [["analysis", "Pantalla"], ["report", "Informe"]] },
] as const;
export type ModeId = (typeof MODES)[number]["id"];
export type TabId = (typeof MODES)[number]["steps"][number][0];

export const modeOf = (tab: TabId): ModeId => MODES.find((m) => m.steps.some(([s]) => s === tab))?.id ?? "capture";

// Goals per side from the tagged goals (an own goal is tagged for the side that benefits).
export function score(events: MatchEvent[]) {
  return {
    own: events.filter((e) => e.type === "goal" && e.team === "own").length,
    opp: events.filter((e) => e.type === "goal" && e.team === "opp").length,
  };
}

type Props = {
  match: Match;
  events: MatchEvent[];
  tab: TabId;
  onTab: (t: TabId) => void;
  steps: Record<StepId, StepStatus>;
  // Right end of the bar: the video selector, the match data.
  children?: React.ReactNode;
};

const fmtDate = (d: string) => {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return y && m && day ? `${day} ${months[m - 1]} ${y}` : d;
};

export function MatchHeader({ match, events, tab, onTab, steps, children }: Props) {
  const mode = modeOf(tab);
  const s = score(events);
  const scored = events.some((e) => e.type === "goal");
  const modeSteps = MODES.find((m) => m.id === mode)?.steps ?? [];
  const progress = (st: StepStatus) => (st.state === "done" ? 100 : st.state === "partial" ? 50 : 0);
  return (
    <div className="mb-4 print:hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href="/partidos" className="cond text-sm font-bold text-faint uppercase transition-colors hover:text-ink">
          Partidos
        </Link>
        {/* The score bug: the match is the unit of the app. */}
        <h1 className="cond m-0 flex h-9 items-stretch text-lg font-bold uppercase" aria-label={`${match.focus_team} ${s.own} - ${s.opp} ${match.other_team}`}>
          <span className="flex items-center gap-2 rounded-l-md bg-raised px-3 whitespace-nowrap">
            <i className="h-4 w-1 rounded-full bg-own" />
            {match.focus_team}
          </span>
          <span className="grid w-9 place-items-center bg-ink text-xl font-extrabold text-bg tabular-nums">{scored ? s.own : "–"}</span>
          <span className="grid w-9 place-items-center border-l border-bg bg-ink text-xl font-extrabold text-bg tabular-nums">{scored ? s.opp : "–"}</span>
          <span className="flex items-center gap-2 rounded-r-md bg-raised px-3 whitespace-nowrap">
            {match.other_team}
            <i className="h-4 w-1 rounded-full bg-opp" />
          </span>
        </h1>
        <span className="text-sm text-faint">{fmtDate(match.date)}</span>
        <nav className="seg mx-auto" aria-label="Modo">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={mode === m.id}
              onClick={() => onTab(m.main)}
              className={`cond rounded-md px-4 py-1 text-[15px] font-bold uppercase transition-colors ${
                mode === m.id ? "bg-ink text-bg" : "text-muted hover:text-ink"
              }`}
            >
              {m.label}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>

      {/* The steps of the mode, each with where it stands; clicking one opens it. */}
      {modeSteps.length > 1 && (
        <ol className="mt-3 grid overflow-hidden rounded-lg bg-surface" style={{ gridTemplateColumns: `repeat(${modeSteps.length}, minmax(0, 1fr))` }} aria-label="Pasos">
          {modeSteps.map(([id, label], n) => {
            const st = steps[id as StepId];
            const on = tab === id;
            return (
              <li key={id} className={n > 0 ? "border-l border-line-soft" : ""}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onTab(id as TabId)}
                  className={`relative flex w-full items-baseline justify-between gap-3 px-4 pt-2 pb-2.5 text-left transition-colors ${on ? "bg-raised" : "hover:bg-raised/60"}`}
                >
                  <span className={`cond flex items-center gap-1.5 text-sm font-bold uppercase ${on ? "text-ink" : "text-ink-2"}`}>
                    {st?.state === "done" && <Check size={13} weight="bold" className="text-ok" />}
                    {label}
                  </span>
                  {st && <span className="truncate text-xs text-muted">{st.text}</span>}
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-line">
                    <span className={`block h-full ${on ? "bg-own" : "bg-ink-2"}`} style={{ width: `${st ? progress(st) : 0}%` }} />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
