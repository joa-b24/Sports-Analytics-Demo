import { boxTeamOf, fileTeamRefs, identityOf, droppedSet, isDropped, merge, splitPerson, type DetBox, type TeamCode, type TracksFile } from "./tracks.ts";
import { PITCH, type TrackEdits } from "./types.ts";

// Where a person of the correction table is probably two people: the places worth looking at first. Pure functions.
//   jump: she moves farther than anyone can run between two consecutive positions.
//   excursion: she jumps away and, a moment later, jumps back to where she was going: a few boxes of somebody else.
//   team: her boxes change from one team's shirt to the other's and stay there.

// Faster than this (m/s) and farther than JUMP_MIN_M is not running, it is another person.
export const JUMP_SPEED_MS = 9;
export const JUMP_MIN_M = 3;
// Consecutive positions further apart in time than this (s) are a hole, not a jump.
const PAIR_MAX_S = 1;
// An excursion lasts at most this long (s).
export const EXCURSION_S = 2;
// A change of team needs this many boxes of each team, one run after the other.
export const TEAM_RUN = 10;

export type HintKind = "jump" | "excursion" | "team";
export interface CutHint {
  person: number;
  kind: HintKind;
  frame: number;
  // Excursions: first frame after it (where she is back).
  until?: number;
  // Meters of the jump, seconds of the excursion, or the two teams.
  meters?: number;
  seconds?: number;
  from?: TeamCode;
  to?: TeamCode;
}

export interface Obs {
  frame: number;
  x: number;
  y: number;
  team: TeamCode;
}

// Positions of every person of a part, in real meters of the venue, one per processed frame.
export function series(file: TracksFile, edits: TrackEdits): Map<number, Obs[]> {
  const sx = (file.venue?.length_m ?? PITCH.length) / PITCH.length;
  const sy = (file.venue?.width_m ?? PITCH.width) / PITCH.width;
  const refs = fileTeamRefs(file);
  const drop = droppedSet(edits);
  const removed = new Set(edits.removed);
  const out = new Map<number, Obs[]>();
  for (const fr of file.frames) {
    const seen = new Set<number>();
    for (const b of fr.boxes as DetBox[]) {
      if (isDropped(drop, b, fr.frame) || !b[11] || b[9] === null || b[10] === null) continue;
      const id = identityOf(b, fr.frame, edits);
      if (removed.has(id) || seen.has(id)) continue; // two boxes at once: the table already warns about those
      seen.add(id);
      const list = out.get(id) ?? [];
      list.push({ frame: fr.frame, x: b[9] * sx, y: b[10] * sy, team: boxTeamOf(b, refs) });
      out.set(id, list);
    }
  }
  return out;
}

export function cutHints(file: TracksFile, edits: TrackEdits): CutHint[] {
  const fps = file.fps;
  const out: CutHint[] = [];
  for (const [person, obs] of series(file, edits)) {
    // Jumps, and excursions: a jump out followed, soon, by a jump back to where she could be.
    const jumps: number[] = [];
    for (let i = 1; i < obs.length; i++) {
      const dt = (obs[i].frame - obs[i - 1].frame) / fps;
      const d = Math.hypot(obs[i].x - obs[i - 1].x, obs[i].y - obs[i - 1].y);
      if (dt <= PAIR_MAX_S && d > JUMP_MIN_M && d / dt > JUMP_SPEED_MS) jumps.push(i);
    }
    const used = new Set<number>();
    for (let a = 0; a < jumps.length; a++) {
      const i = jumps[a];
      if (used.has(i)) continue;
      const back = jumps.slice(a + 1).find((k) => (obs[k].frame - obs[i].frame) / fps <= EXCURSION_S && reachable(obs[i - 1], obs[k], fps));
      if (back !== undefined) {
        used.add(back);
        out.push({ person, kind: "excursion", frame: obs[i].frame, until: obs[back].frame, seconds: (obs[back].frame - obs[i].frame) / fps,
          meters: Math.hypot(obs[i].x - obs[i - 1].x, obs[i].y - obs[i - 1].y) });
      } else {
        out.push({ person, kind: "jump", frame: obs[i].frame, meters: Math.hypot(obs[i].x - obs[i - 1].x, obs[i].y - obs[i - 1].y) });
      }
    }
    // Team changes: a run of TEAM_RUN boxes of one team followed by a run of the other (undecided boxes do not break runs).
    const decided = obs.filter((o) => o.team === "own" || o.team === "opp");
    let runTeam: TeamCode | null = null;
    let runStart = 0;
    let prevTeam: TeamCode | null = null;
    let prevLen = 0;
    for (let i = 0; i <= decided.length; i++) {
      const t = i < decided.length ? decided[i].team : null;
      if (t === runTeam) continue;
      const len = i - runStart;
      if (runTeam && len >= TEAM_RUN) {
        if (prevTeam && prevTeam !== runTeam && prevLen >= TEAM_RUN) {
          out.push({ person, kind: "team", frame: decided[runStart].frame, from: prevTeam, to: runTeam });
        }
        prevTeam = runTeam;
        prevLen = len;
      }
      runTeam = t;
      runStart = i;
    }
  }
  // A jump and a team change at the same moment are one place to look at.
  const merged: CutHint[] = [];
  for (const h of out.sort((a, b) => a.frame - b.frame || a.person - b.person)) {
    const near = merged.find((m) => m.person === h.person && Math.abs(m.frame - h.frame) / fps <= 1 && m.kind !== "excursion" && h.kind !== "excursion");
    if (near && near.kind === "jump" && h.kind === "team") Object.assign(near, { from: h.from, to: h.to });
    else if (near && near.kind === "team" && h.kind === "jump") Object.assign(near, { kind: "jump", meters: h.meters, frame: h.frame });
    else merged.push(h);
  }
  return merged;
}

function reachable(a: Obs, b: Obs, fps: number): boolean {
  const dt = (b.frame - a.frame) / fps;
  return Math.hypot(b.x - a.x, b.y - a.y) <= JUMP_SPEED_MS * dt + JUMP_MIN_M;
}

// Apply a hint: a jump or a team change splits the person there; an excursion is taken out as a person of its own,
// and she goes on as herself after it.
// Every change of shirt cut at once. Each person is cut from her last change backwards, so the earlier changes still
// belong to her when their turn comes (a cut gives what follows to a new identity). Measured on the corrected parts:
// 5 of 6 of these were real changes of person.
export function applyTeamCuts(edits: TrackEdits, file: TracksFile, hints: CutHint[]): { edits: TrackEdits; cuts: number } {
  let out = edits;
  let cuts = 0;
  const team = hints.filter((h) => h.kind === "team").sort((a, b) => a.person - b.person || b.frame - a.frame);
  for (const h of team) {
    const r = splitPerson(out, h.person, h.frame, file);
    if (!r) continue;
    out = r.edits;
    cuts += 1;
  }
  return { edits: out, cuts };
}

export function applyHint(edits: TrackEdits, file: TracksFile, h: CutHint): TrackEdits {
  const first = splitPerson(edits, h.person, h.frame, file);
  if (!first) return edits;
  if (h.kind !== "excursion" || h.until === undefined) return first.edits;
  const second = splitPerson(first.edits, first.identity, h.until, file);
  return second ? merge(second.edits, h.person, second.identity) : first.edits;
}
