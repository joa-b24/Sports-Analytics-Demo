import { shotBreakdown } from "./analysis.ts";
import type { StepId, StepStatus } from "./steps.ts";
import { firstSentence } from "./summary.ts";
import type { Match, MatchEvent } from "./types.ts";

// What Inicio shows: our last match, what we know of the next rival and the tasks left. Pure functions.

// Team names compared without case, accents or extra spaces ("Anáhuac" = "anahuac ").
export const teamKey = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const byDateDesc = (a: Match, b: Match) => (b.date || "").localeCompare(a.date || "");
const goals = (events: MatchEvent[], team: "own" | "opp") => events.filter((e) => e.type === "goal" && e.team === team).length;

// Our last match: the most recent one with events (a match just created says nothing yet), or else the most recent.
export function lastOwnMatch(matches: Match[], events: MatchEvent[]): Match | null {
  const own = matches.filter((m) => m.kind === "own").sort(byDateDesc);
  const tagged = new Set(events.map((e) => e.match_id));
  return own.find((m) => tagged.has(m.match_id)) ?? own[0] ?? null;
}

// The rival being prepared: the team of the most recent rival video.
export function nextRival(matches: Match[]): string | null {
  return matches.filter((m) => m.kind === "rival").sort(byDateDesc)[0]?.focus_team ?? null;
}

export interface RivalVideo {
  match: Match;
  events: number;
  // Goals of the rival (for) and of its opponent (against); null without events.
  score: { for: number; against: number } | null;
}

export interface Meeting {
  match: Match;
  // Our goals and theirs; null without events.
  score: { own: number; opp: number } | null;
}

export interface RivalDossier {
  team: string;
  // Its videos, newest first.
  videos: RivalVideo[];
  // Videos with at least one event.
  tagged: number;
  // Over the tagged videos (the rival is the analysed team: `own`).
  shots: number;
  onTarget: number;
  goalsFor: number;
  goalsAgainst: number;
  // First sentence of the newest report summary written for one of its videos.
  lead: { text: string; match: Match } | null;
  // Our matches against it, newest first.
  meetings: Meeting[];
  demo: boolean;
}

export function rivalDossier(team: string, matches: Match[], events: MatchEvent[]): RivalDossier {
  const key = teamKey(team);
  const of = (m: Match) => events.filter((e) => e.match_id === m.match_id);
  const videos: RivalVideo[] = matches
    .filter((m) => m.kind === "rival" && teamKey(m.focus_team) === key)
    .sort(byDateDesc)
    .map((m) => {
      const ev = of(m);
      return { match: m, events: ev.length, score: ev.length ? { for: goals(ev, "own"), against: goals(ev, "opp") } : null };
    });
  const tagged = videos.filter((v) => v.events > 0);
  const all = tagged.flatMap((v) => of(v.match));
  const shots = shotBreakdown(all, "own");
  const withLead = videos.map((v) => ({ text: firstSentence(v.match.report?.resumen ?? ""), match: v.match })).find((l) => l.text);
  const meetings: Meeting[] = matches
    .filter((m) => m.kind === "own" && teamKey(m.other_team) === key)
    .sort(byDateDesc)
    .map((m) => {
      const ev = of(m);
      return { match: m, score: ev.length ? { own: goals(ev, "own"), opp: goals(ev, "opp") } : null };
    });
  return {
    team,
    videos,
    tagged: tagged.length,
    shots: shots.total,
    onTarget: shots.onTarget,
    goalsFor: tagged.reduce((n, v) => n + (v.score?.for ?? 0), 0),
    goalsAgainst: tagged.reduce((n, v) => n + (v.score?.against ?? 0), 0),
    lead: withLead?.text ? { text: withLead.text, match: withLead.match } : null,
    meetings,
    demo: videos.some((v) => v.match.is_demo) || meetings.some((m) => m.match.is_demo),
  };
}

// Width of each side of a face-off bar, as a share (0-1) of its half. Percentages fill against 100; counts against
// the larger of the two, so the side that leads reaches the end.
export function faceOff(own: number, opp: number, unit?: "%"): [number, number] {
  if (unit === "%") return [Math.max(0, Math.min(1, own / 100)), Math.max(0, Math.min(1, opp / 100))];
  const max = Math.max(own, opp);
  return max > 0 ? [own / max, opp / max] : [0, 0];
}

export type TaskMode = "captura" | "estudio" | "analisis";

export interface Task {
  match: Match;
  step: StepId;
  mode: TaskMode;
  // What to do, as a verb.
  label: string;
  // Where it stands.
  text: string;
}

// Tasks left, match by match (newest first): the tagging and the stretches of play from the steps, and the summary of
// the report once there are events. Reference videos are left out.
export function pendingTasks(rows: { match: Match; steps: Record<StepId, StepStatus>; events: number }[]): Task[] {
  return rows
    .filter((r) => r.match.kind !== "reference")
    .sort((a, b) => byDateDesc(a.match, b.match))
    .flatMap((r) => {
      const out: Task[] = [];
      const { tag, segments } = r.steps;
      if (tag.state === "todo") out.push({ match: r.match, step: "tag", mode: "captura", label: "Etiquetar eventos", text: tag.text });
      else if (tag.state === "partial") {
        // Partial: events left to review, or only end positions missing (then «0 por revisar» says nothing).
        const review = Number(/(\d+) por revisar/.exec(tag.text)?.[1] ?? 1);
        const text = review > 0 ? tag.text : tag.text.replace(/ · 0 por revisar/, "");
        out.push({ match: r.match, step: "tag", mode: "captura", label: review > 0 ? "Revisar eventos" : "Completar destinos", text });
      }
      if (segments.state === "todo") out.push({ match: r.match, step: "segments", mode: "captura", label: "Marcar tramos", text: segments.text });
      else if (segments.state === "partial") out.push({ match: r.match, step: "segments", mode: "captura", label: "Terminar tramos", text: segments.text });
      if (r.events > 0 && !(r.match.report?.resumen ?? "").trim())
        out.push({ match: r.match, step: "report", mode: "analisis", label: "Escribir el resumen", text: "el informe no tiene resumen" });
      return out;
    });
}
