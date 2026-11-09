import { END_TYPES, EVENT_DETAILS, EVENT_OUTCOMES, GOAL_TYPES, type EventType, type MatchEvent, type Team } from "./types.ts";

// Rules of the three tagging passes. Pure functions: no storage, no React.
//   Pass 1: what happened (type and team), fast, while the video plays.
//   Pass 2: review one by one: position, player, result, detail, note.
//   Pass 3: how shots, crosses, corners and free kicks were taken: where they ended.

// Two events of the same type and team closer than this (s) are probably the same action tagged twice.
export const DUPLICATE_S = 3;
// An event is "active" (shown over the video and highlighted) from its time until this much later (s).
export const ACTIVE_S = 2;

export type Pass = 1 | 2 | 3;

// Events of the same type and team within DUPLICATE_S of `e` (itself left out).
export function duplicatesOf(events: MatchEvent[], e: Pick<MatchEvent, "event_id" | "type" | "team" | "t_video" | "video_id">): MatchEvent[] {
  return events.filter(
    (o) =>
      o.event_id !== e.event_id &&
      o.type === e.type &&
      o.team === e.team &&
      (o.video_id ?? "v1") === (e.video_id ?? "v1") &&
      Math.abs(o.t_video - e.t_video) < DUPLICATE_S,
  );
}

// Events whose moment the video is going through: from their time until ACTIVE_S later.
export function activeAt(events: MatchEvent[], t: number, span = ACTIVE_S): MatchEvent[] {
  return events.filter((e) => t >= e.t_video && t < e.t_video + span);
}

// What pass 2 still has to fill in: the position, and the result for the types that have one.
export function missingReview(e: MatchEvent): string[] {
  const out: string[] = [];
  // A substitution has no place on the pitch; what it needs is who comes in.
  if (e.type === "substitution") return e.player_in ? [] : ["quién entra"];
  if (e.x === null || e.y === null) out.push("posición");
  if (EVENT_OUTCOMES[e.type] && !e.outcome) out.push("resultado");
  return out;
}

export const endKind = (type: EventType): "goal" | "landing" | null =>
  GOAL_TYPES.includes(type) ? "goal" : END_TYPES.includes(type) ? "landing" : null;

// Fields to change when an event becomes another type: result and detail depend on the type, and so does the end
// position (a shot keeps its spot on the goal if it becomes a penalty, not if it becomes a foul).
export function retype(e: Pick<MatchEvent, "type">, type: EventType): Partial<MatchEvent> {
  const patch: Partial<MatchEvent> = { type, outcome: null, detail: null };
  if (e.type === "substitution" && type !== "substitution") patch.player_in = null;
  if (endKind(type) !== endKind(e.type)) Object.assign(patch, { x_end: null, y_end: null, goal_y: null, goal_z: null });
  return patch;
}

// End position read from a file: kept only when the type takes it and both values are there.
export function cleanEnd(type: EventType, v: { x_end: number | null; y_end: number | null; goal_y: number | null; goal_z: number | null }) {
  const kind = endKind(type);
  const landing = kind === "landing" && v.x_end !== null && v.y_end !== null;
  const goal = kind === "goal" && v.goal_y !== null && v.goal_z !== null;
  return { x_end: landing ? v.x_end : null, y_end: landing ? v.y_end : null, goal_y: goal ? v.goal_y : null, goal_z: goal ? v.goal_z : null };
}

// Whether this event asks for an end position in pass 3. A shot marked as blocked in pass 2 never reached the goal, and
// a free kick that was not a shot (cleared, play went on) has no spot on the goal: neither asks for one.
export function asksEnd(e: Pick<MatchEvent, "type" | "outcome">): boolean {
  const kind = endKind(e.type);
  if (kind === null) return false;
  if (e.type === "shot" && e.outcome === "blocked") return false;
  if (e.type === "free_kick" && e.outcome && e.outcome !== "shot") return false;
  return true;
}

// What pass 3 still has to fill in: where it ended. Null when the event does not ask for an end (asksEnd).
export function missingEnd(e: MatchEvent): boolean | null {
  if (!asksEnd(e)) return null;
  const kind = endKind(e.type);
  if (kind === "goal") return e.goal_y == null || e.goal_z == null;
  if (kind === "landing") return e.x_end == null || e.y_end == null;
  return null;
}

export interface EventFilter {
  types: EventType[]; // empty = all
  team: Team | "all";
  player: string; // "" = any; matched without case
  onlyMissing: boolean;
}
export const NO_FILTER: EventFilter = { types: [], team: "all", player: "", onlyMissing: false };

// The events a pass works on, in time order: pass 3 only takes the events that ask for an end position (asksEnd).
export function eventsFor(pass: Pass, events: MatchEvent[], f: EventFilter): MatchEvent[] {
  const player = f.player.trim().toLowerCase();
  return events
    .filter((e) => (pass === 3 ? asksEnd(e) : true))
    .filter((e) => f.types.length === 0 || f.types.includes(e.type))
    .filter((e) => f.team === "all" || e.team === f.team)
    .filter((e) => !player || (e.player_id ?? "").toLowerCase().includes(player))
    .filter((e) => !f.onlyMissing || (pass === 3 ? missingEnd(e) === true : missingReview(e).length > 0))
    .sort((a, b) => a.t_video - b.t_video);
}

// Names already used in the events of a match, most used first: suggestions for the player field.
export function knownPlayers(events: MatchEvent[]): string[] {
  const count = new Map<string, number>();
  for (const e of events) if (e.player_id) count.set(e.player_id, (count.get(e.player_id) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
}

// The details an event can take now: a shot is "saved" only when it went on target (a save is the goalkeeper's).
export function detailsFor(e: Pick<MatchEvent, "type" | "outcome">): [string, string][] {
  const all = Object.entries(EVENT_DETAILS[e.type] ?? {});
  return e.type === "shot" && e.outcome !== "on_target" ? [] : all;
}

// Setting the result of an event: a shot that is no longer on target loses its save.
export function outcomePatch(e: Pick<MatchEvent, "type" | "detail">, outcome: string | null): Partial<MatchEvent> {
  return e.type === "shot" && outcome !== "on_target" && e.detail === "saved" ? { outcome, detail: null } : { outcome };
}

// The card of a foul, one click at a time: none, yellow, red, none again.
export function nextCard(detail: string | null | undefined): "yellow" | "red" | null {
  return detail === "yellow" ? "red" : detail === "red" ? null : "yellow";
}
