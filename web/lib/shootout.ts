import type { MatchEvent, ShootoutKick } from "./types.ts";

// Penalty shootout after a draw (the league gives one more point to its winner). It happens after the match, so its
// kicks are not match events: they live with the match (Match.shootout). Pure functions.

export const KICK_LABELS: Record<ShootoutKick["result"], string> = { goal: "Gol", saved: "Atajado", missed: "Fuera" };

export function shootoutScore(kicks: ShootoutKick[] | undefined): { own: number; opp: number } | null {
  if (!kicks || kicks.length === 0) return null;
  return {
    own: kicks.filter((k) => k.team === "own" && k.result === "goal").length,
    opp: kicks.filter((k) => k.team === "opp" && k.result === "goal").length,
  };
}

// Whether the match ended level by its tagged goals (with events tagged at all): the shootout is asked then.
export function endedLevel(events: Pick<MatchEvent, "type" | "team">[]): boolean {
  if (events.length === 0) return false;
  const own = events.filter((e) => e.type === "goal" && e.team === "own").length;
  const opp = events.filter((e) => e.type === "goal" && e.team === "opp").length;
  return own === opp;
}

// "(4–3 pen.)", or "" without a shootout.
export function shootoutText(kicks: ShootoutKick[] | undefined): string {
  const s = shootoutScore(kicks);
  return s ? `${s.own}–${s.opp} pen.` : "";
}
