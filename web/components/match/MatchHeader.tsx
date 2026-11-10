"use client";

import { shootoutText } from "@/lib/shootout";
import { FileText, Monitor, Path, PlayCircle, PresentationChart, Scissors, SoccerBall, Strategy, Tag, Target, type Icon } from "@phosphor-icons/react";
import { setHeaderRightSlot, setHeaderSlot } from "@/lib/stepBus";
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
      ["tracking", "Jugadoras"],
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
      ["analysis", "Dashboard"],
      ["report", "Informe"],
      ["deck", "Presentación"],
    ],
  },
] as const;
// One icon per step: in the bar of the match (green when the step is done) and in the match list (only the done ones).
export const STEP_ICONS: Record<TabId, Icon> = {
  calibration: Target,
  segments: Scissors,
  tracking: Path,
  ball: SoccerBall,
  tag: Tag,
  plays: PlayCircle,
  board: Strategy,
  analysis: Monitor,
  report: FileText,
  deck: PresentationChart,
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
  // Right after the steps: whether the match is saved to its folder (components/match/SaveStatus.tsx).
  status?: React.ReactNode;
  // Next to the score: marks of the match (for instance «Falta el video»).
  badge?: React.ReactNode;
  // At the right end: the match data.
  children?: React.ReactNode;
};

// One slim bar: the score, the video, the save state and the match data. The steps of the mode are in the sidebar.
export function MatchHeader({ match, events, tab, onTab, steps, video, status, badge, children }: Props) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 print:hidden">
      <h1 className="m-0">
        <ScoreBug match={match} events={events} />
      </h1>
      {badge}
      {video}
      {/* Mode switches of the open step (captura: anchors / quick review / table) are drawn here. */}
      <div ref={setHeaderSlot} className="flex items-center gap-2 empty:hidden" />
      <span className="flex-1" />
      {status}
      {/* A step can put a control here, next to the settings (the filter of the dashboard). */}
      <div ref={setHeaderRightSlot} className="flex items-center gap-2 empty:hidden" />
      {children}
      {/* The bar only names the steps (and ticks the finished ones); where the open step stands goes under it. */}
      {modeOf(tab) !== "analisis" && steps[tab as StepId]?.text && <p className="m-0 basis-full text-right text-xs text-faint">{steps[tab as StepId].text}</p>}
    </div>
  );
}
