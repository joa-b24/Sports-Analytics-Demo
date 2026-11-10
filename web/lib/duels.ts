import { partFor, positionsAt, type Oriented } from "./positions.ts";
import type { MatchEvent } from "./types.ts";

// Duels are tagged for our team only: the rival players have no names, so the event says which of ours took part and who won
// (outcome: won / lost from her side), the kind (aerial / ground) and where. When the tagger did not say which player, she
// is the one of our team, named in the correction table, who was nearest to the spot of the duel (or to the ball, if the
// duel has no spot). Pure: no storage, no React.

// Farther than this (meters) nobody is credited: better empty than a wrong name.
export const DUEL_MAX_M = 8;

export interface DuelOwner {
  player_id: string;
  dist_m: number;
}

export function duelOwner(parts: Oriented[], e: MatchEvent, maxM = DUEL_MAX_M): DuelOwner | null {
  const part = partFor(parts, e.video_id ?? "v1", e.t_video, e.t_video);
  const at = part ? positionsAt(part, e.t_video) : null;
  if (!part || !at) return null;
  const ref: [number, number] | null = e.x !== null && e.y !== null ? [e.x, e.y] : at.ball;
  if (!ref) return null;
  const names = new Map(part.file.people.map((p) => [p.id, p.player_id]));
  let best: DuelOwner | null = null;
  for (const d of at.players) {
    const name = names.get(d.id);
    if (d.team !== "own" || !name) continue;
    const dist = Math.hypot(d.x - ref[0], d.y - ref[1]);
    if (dist <= maxM && (!best || dist < best.dist_m)) best = { player_id: name, dist_m: dist };
  }
  return best;
}

// The duels with no player yet, and the change that completes each one (team: ours). `unmatched` are the ones the tracking
// could not name (no part, no named player near).
export function completeDuels(events: MatchEvent[], parts: Oriented[]): { patches: { event_id: string; patch: Partial<MatchEvent> }[]; pending: number } {
  const open = events.filter((e) => e.type === "duel" && !e.player_id);
  const patches = open.flatMap((e) => {
    const owner = duelOwner(parts, e);
    return owner ? [{ event_id: e.event_id, patch: { player_id: owner.player_id, team: "own" as const } }] : [];
  });
  return { patches, pending: open.length };
}
