"use client";

import { shootoutText } from "@/lib/shootout";
import { FileText, Monitor, Path, PlayCircle, Scissors, SoccerBall, Strategy, Tag, Target, type Icon } from "@phosphor-icons/react";
import type { StepId, StepStatus } from "@/lib/steps";
import type { Match, MatchEvent } from "@/lib/types";

// The three modes of a match: capture the data from the video, study it (plays, the board, drawings over the video)
// and read it (analysis on screen and the report to export). They are chosen in the sidebar (?modo=); each lists its
// steps here. `main` is the step a mode opens on.
export const MODES = [
  {
    id: "captura",
    label: "Captura",
    main: "tag",
    steps: [
      ["calibration", "Calibración"],
      ["segments", "Tramos"],
      ["tracking", "Tracking"],
      ["ball", "Balón"],
      ["tag", "Eventos"],
    ],
  },
  {
    id: "estudio",
    label: "Estudio",
    main: "plays",
    steps: [
      ["plays", "Jugadas"],
      ["board", "Pizarrón"],
    ],
  },
  {
    id: "analisis",
    label: "Análisis",
    main: "analysis",
    steps: [
      ["analysis", "Pantalla"],
      ["report", "Informe"],
    ],
  },
] as const;
// One icon per step: in the bar of the match (green when the step is done) and in the match list (only the done ones).
export const STEP_ICONS: Record<StepId, Icon> = {
  calibration: Target,
  segments: Scissors,
  tracking: Path,
  ball: SoccerBall,
  tag: Tag,
  plays: PlayCircle,
  board: Strategy,
  analysis: Monitor,
  report: FileText,
};

export type ModeId = (typeof MODES)[number]["id"];
export type TabId = (typeof MODES)[number]["steps"][number][0];

export const modeOf = (tab: TabId): ModeId => MODES.find((m) => m.steps.some(([s]) => s === tab))?.id ?? "captura";
export const isMode = (x: string | null): x is ModeId => MODES.some((m) => m.id === x);
export const mainOf = (mode: ModeId): TabId => MODES.find((m) => m.id === mode)?.main ?? "tag";

// Goals per side from the tagged goals (an own goal is tagged for the side that benefits).
export function score(events: MatchEvent[]) {
  return {
    own: events.filter((e) => e.type === "goal" && e.team === "own").length,
    opp: events.filter((e) => e.type === "goal" && e.team === "opp").length,
  };
}

export function ScoreBug({ match, events, size = "md" }: { match: Match; events: MatchEvent[]; size?: "md" | "lg" }) {
  const s = score(events);
  const scored = events.some((e) => e.type === "goal");
  const h = size === "lg" ? "h-11 text-xl" : "h-8 text-[15px]";
  const box = size === "lg" ? "w-11 text-2xl" : "w-8 text-lg";
  return (
    <div className={`cond flex items-stretch font-bold uppercase ${h}`} aria-label={`${match.focus_team} ${s.own} - ${s.opp} ${match.other_team}`}>
      <span className="flex items-center gap-2 rounded-l-md bg-raised px-3 whitespace-nowrap">
        <i className="h-4 w-1 rounded-full bg-own" />
        {match.focus_team}
      </span>
      <span className={`grid place-items-center bg-ink font-extrabold text-bg tabular-nums ${box}`}>{scored ? s.own : "–"}</span>
      <span className={`grid place-items-center border-l border-bg bg-ink font-extrabold text-bg tabular-nums ${box}`}>{scored ? s.opp : "–"}</span>
      <span className="flex items-center gap-2 rounded-r-md bg-raised px-3 whitespace-nowrap">
        {match.other_team}
        <i className="h-4 w-1 rounded-full bg-opp" />
      </span>
      {match.shootout?.length ? (
        <span className="ml-1.5 flex items-center text-[0.7em] font-semibold whitespace-nowrap text-muted normal-case" title="Tanda de penales">
          ({shootoutText(match.shootout)})
        </span>
      ) : null}
    </div>
  );
}

type Props = {
  match: Match;
  events: MatchEvent[];
  tab: TabId;
  onTab: (t: TabId) => void;
  steps: Record<StepId, StepStatus>;
  // Between the score and the steps: the video selector.
  video?: React.ReactNode;
  // At the right end: the match data.
  children?: React.ReactNode;
};

// One bar: the score, the video, the steps of the mode (each with where it stands) and the match data.
export function MatchHeader({ match, events, tab, onTab, steps, video, children }: Props) {
  const mode = modeOf(tab);
  const modeSteps = MODES.find((m) => m.id === mode)?.steps ?? [];
  const progress = (st: StepStatus) => (st.state === "done" ? 100 : st.state === "partial" ? 50 : 0);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 print:hidden">
      <h1 className="m-0">
        <ScoreBug match={match} events={events} />
      </h1>
      {video}
      <ol className="flex min-w-0 flex-1 overflow-x-auto rounded-lg bg-surface" aria-label={`Pasos de ${MODES.find((m) => m.id === mode)?.label}`}>
        {modeSteps.map(([id, label], n) => {
          const st = steps[id as StepId];
          const on = tab === id;
          const I = STEP_ICONS[id as StepId];
          const done = st?.state === "done";
          return (
            <li key={id} className={`min-w-[7rem] flex-1 ${n > 0 ? "border-l border-line-soft" : ""}`}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onTab(id as TabId)}
                title={st?.text}
                className={`relative flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${on ? "bg-raised" : "hover:bg-raised/60"}`}
              >
                <span className={`cond flex items-center gap-1.5 text-[13px] font-bold whitespace-nowrap uppercase ${on ? "text-ink" : "text-muted"}`}>
                  <I size={15} weight={done ? "fill" : "regular"} className={done ? "text-ok" : "text-faint"} aria-hidden />
                  {label}
                  {done && <span className="sr-only"> (completo)</span>}
                </span>
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-line">
                  <span className={`block h-full transition-[width] duration-500 ${on ? "bg-own" : "bg-ink-2/60"}`} style={{ width: `${st ? progress(st) : 0}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {children}
      {/* The bar only names the steps (and ticks the finished ones); where the open step stands goes under it. */}
      {steps[tab as StepId]?.text && <p className="m-0 basis-full text-right text-xs text-faint">{steps[tab as StepId].text}</p>}
    </div>
  );
}
