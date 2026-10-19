import { shotBreakdown } from "./analysis.ts";
import { missingReview } from "./tagging.ts";
import type { Match, MatchEvent } from "./types.ts";

// The short summary of a match in the list (Resumen): one sentence, a few comparisons and where its tagging stands.
// Pure functions.

export interface Comparison {
  label: string;
  // Focus team first, as in the score.
  own: number;
  opp: number;
  unit?: "%";
}

export interface MatchSummary {
  // First sentence of the summary written in the report; null when there is none.
  lead: string | null;
  // Only the measures with something on either side.
  comparisons: Comparison[];
  // Tagging: none yet, events left to review, or every event reviewed.
  status: { state: "empty" | "review" | "done"; text: string };
}

const LEAD_MAX = 160;

// First sentence of a text, cut at a word when it is very long.
export function firstSentence(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;
  const end = t.search(/[.!?](\s|$)/);
  const s = end >= 0 ? t.slice(0, end + 1) : t;
  if (s.length <= LEAD_MAX) return s;
  const cut = s.slice(0, LEAD_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), LEAD_MAX - 20)).trimEnd()}…`;
}

export function matchSummary(match: Pick<Match, "report" | "possession">, events: MatchEvent[]): MatchSummary {
  const count = (type: MatchEvent["type"], team: "own" | "opp") => events.filter((e) => e.type === type && e.team === team).length;
  const shots = { own: shotBreakdown(events, "own"), opp: shotBreakdown(events, "opp") };
  // Possession: share of the time with the ball followed that either team had it (time nobody had it left out).
  const p = match.possession;
  const held = p ? p.own + p.opp : 0;
  const possession: Comparison[] = p && held > 0 ? [{ label: "Posesión", own: Math.round((100 * p.own) / held), opp: 100 - Math.round((100 * p.own) / held), unit: "%" }] : [];
  const comparisons: Comparison[] = [
    ...possession,
    { label: "Tiros", own: shots.own.total, opp: shots.opp.total },
    { label: "A puerta", own: shots.own.onTarget, opp: shots.opp.onTarget },
    { label: "Córners", own: count("corner", "own"), opp: count("corner", "opp") },
    { label: "Recuperaciones", own: count("recovery", "own"), opp: count("recovery", "opp") },
  ].filter((c) => c.own + c.opp > 0);

  const toReview = events.filter((e) => missingReview(e).length > 0).length;
  const status: MatchSummary["status"] =
    events.length === 0
      ? { state: "empty", text: "Sin etiquetar" }
      : toReview > 0
        ? { state: "review", text: `${toReview} por revisar` }
        : { state: "done", text: "Eventos revisados" };

  return { lead: firstSentence(match.report?.resumen ?? ""), comparisons, status };
}
