// Playground > Pases: the passes read from the tracking (lib/positions.ts passesAndTurnovers), listed so that the analyst
// can check them one by one against the video, with the same pattern as the possession (lib/playgroundPossession.ts):
// a paged list, a loop on the video, the scene on the pitch, a verdict (correct / incorrect / note), the accuracy over
// what was reviewed and a stratified sample. Passes tagged by hand are NOT here (lib/passSources.ts keeps them apart).
// Pure functions, no file access.
import { passesAndTurnovers, inStretches, partFor, positionsAt, type Oriented } from "./positions.ts";
import type { Scene, Verdict } from "./playgroundPossession.ts";
import type { Segment } from "./segments.ts";

export type PassTeam = "own" | "opp";

// A pass (completed) or a ball lost by the team (the other team had it next: «cortado»), as one row.
export interface PassItem {
  id: string;
  video_id: string;
  part: number; // start_frame of the part it was read from
  t_start: number; // the last touch of the passer (s of the video)
  t_end: number; // when the receiver (or the other team) first has it
  team: PassTeam;
  completed: boolean;
  from: number; // person id inside the part
  to: number | null; // none when the pass was cut
  from_name: string | null;
  to_name: string | null;
  // The team has no names in that part: read between two boxes, flagged approximate.
  approx: boolean;
}

export const passId = (video: string, t0: number, team: PassTeam, completed: boolean) => `${video}|${(Math.round(t0 * 100) / 100).toFixed(2)}|${team}|${completed ? "ok" : "cut"}`;

// All the passes and cut passes of the parts, inside the play stretches when there are closed ones, in video order. A
// stretch covered by two parts counts once (the first).
export function passItems(parts: Oriented[], segmentsByVideo: Record<string, Segment[]> = {}): PassItem[] {
  const usePlay = Object.values(segmentsByVideo).some((segs) => segs.some((g) => g.tipo === "juego" && g.end !== null));
  const seen = new Set<string>();
  const out: PassItem[] = [];
  for (const o of parts) {
    const f = o.file;
    const person = new Map(f.people.map((p) => [p.id, p]));
    const play = usePlay ? (segmentsByVideo[f.video_id] ?? []) : null;
    const r = passesAndTurnovers(f);
    const push = (item: Omit<PassItem, "id">) => {
      const id = passId(item.video_id, item.t_start, item.team, item.completed);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, ...item });
    };
    for (const p of r.passes) {
      const t0 = p.from_frame / f.fps;
      if (!inStretches(play, t0)) continue;
      push({ video_id: f.video_id, part: f.start_frame, t_start: t0, t_end: p.frame / f.fps, team: p.team, completed: true, from: p.from, to: p.to, from_name: person.get(p.from)?.player_id ?? null, to_name: person.get(p.to)?.player_id ?? null, approx: p.approx });
    }
    for (const tv of r.turnovers) {
      const t0 = tv.from_frame / f.fps;
      if (!inStretches(play, t0)) continue;
      push({ video_id: f.video_id, part: f.start_frame, t_start: t0, t_end: tv.frame / f.fps, team: tv.lost, completed: false, from: tv.from, to: null, from_name: person.get(tv.from)?.player_id ?? null, to_name: null, approx: false });
    }
  }
  return out.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_start - b.t_start);
}

// ------------------------------------------------------------------------------------------------- filters
export interface PassFilter {
  team: PassTeam | "all";
  result: "all" | "completed" | "cut";
  review: "all" | "pending" | "reviewed";
}
export const NO_PASS_FILTER: PassFilter = { team: "all", result: "all", review: "all" };
export const isPassFiltered = (f: PassFilter) => f.team !== "all" || f.result !== "all" || f.review !== "all";
export const filterPasses = (items: PassItem[], f: PassFilter, reviewed: Set<string>): PassItem[] =>
  items.filter(
    (p) =>
      (f.team === "all" || p.team === f.team) &&
      (f.result === "all" || (f.result === "completed") === p.completed) &&
      (f.review === "all" || (f.review === "reviewed") === reviewed.has(p.id)),
  );

// ------------------------------------------------------------------------------------------------- verdicts
export interface PassReview {
  id: string;
  video_id: string;
  t_start: number;
  t_end: number;
  team: PassTeam;
  completed: boolean;
  verdict: Verdict;
  note: string;
  at: string;
}
export interface PassReviewFile {
  kind: "pass_review";
  video_id: string;
  reviews: PassReview[];
}
export const passReviewPath = (folder: string, videoId: string) => `matches/${folder}/passes_review_${videoId}.json`;
export const emptyPassReview = (videoId: string): PassReviewFile => ({ kind: "pass_review", video_id: videoId, reviews: [] });

export function parsePassReview(text: string | null, videoId: string): PassReviewFile {
  try {
    const d = JSON.parse(text ?? "null") as PassReviewFile | null;
    if (d && d.kind === "pass_review" && Array.isArray(d.reviews)) {
      const reviews = d.reviews.filter((r) => r && typeof r.id === "string" && (r.verdict === "correct" || r.verdict === "incorrect"));
      return { kind: "pass_review", video_id: videoId, reviews };
    }
  } catch {
    // Unreadable: starts empty rather than guessing.
  }
  return emptyPassReview(videoId);
}

// Marks the pass; a null verdict clears it.
export function setPassVerdict(f: PassReviewFile, p: PassItem, verdict: Verdict | null, note: string, at = new Date().toISOString()): PassReviewFile {
  const rest = f.reviews.filter((x) => x.id !== p.id);
  if (verdict === null) return { ...f, reviews: rest };
  const entry: PassReview = { id: p.id, video_id: p.video_id, t_start: p.t_start, t_end: p.t_end, team: p.team, completed: p.completed, verdict, note: note.trim(), at };
  return { ...f, reviews: [...rest, entry].sort((a, b) => a.t_start - b.t_start) };
}
export const passReviewOf = (f: PassReviewFile | undefined, p: PassItem): PassReview | null => f?.reviews.find((x) => x.id === p.id) ?? null;

export interface PassReviewStats {
  reviewed: number;
  correct: number;
  incorrect: number;
  accuracy: number | null; // correct / reviewed; null with nothing reviewed
  // Of the reviewed ones, those still in the current list (the tracking or the play stretches may have changed since).
  current: number;
}
export function passReviewStats(reviews: PassReview[], items: PassItem[]): PassReviewStats {
  const ids = new Set(items.map((p) => p.id));
  const correct = reviews.filter((r) => r.verdict === "correct").length;
  return { reviewed: reviews.length, correct, incorrect: reviews.length - correct, accuracy: reviews.length > 0 ? correct / reviews.length : null, current: reviews.filter((r) => ids.has(r.id)).length };
}

// ------------------------------------------------------------------------------------------------- sample
export const stratumOfPass = (p: PassItem) => `${p.team}|${p.completed ? "ok" : "cut"}|${p.approx ? "approx" : "named"}`;

// `n` passes to review, spread over the strata (team / completed or cut / approximate or named) in turn, and inside a
// stratum evenly through the match. Deterministic. The ones already reviewed are skipped.
export function passSample(items: PassItem[], n: number, done: Set<string> = new Set()): PassItem[] {
  const groups = new Map<string, PassItem[]>();
  for (const p of [...items].sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_start - b.t_start)) {
    if (done.has(p.id)) continue;
    const k = stratumOfPass(p);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const keys = [...groups.keys()].sort();
  const total = [...groups.values()].reduce((a, g) => a + g.length, 0);
  let left = Math.min(n, total);
  const quota = new Map<string, number>();
  while (left > 0) {
    let moved = false;
    for (const k of keys) {
      if (left === 0) break;
      if ((quota.get(k) ?? 0) < (groups.get(k) as PassItem[]).length) {
        quota.set(k, (quota.get(k) ?? 0) + 1);
        left--;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const out: PassItem[] = [];
  for (const k of keys) {
    const g = groups.get(k) as PassItem[];
    const q = quota.get(k) ?? 0;
    for (let j = 0; j < q; j++) out.push(g[Math.min(g.length - 1, Math.floor(((j + 0.5) * g.length) / q))]);
  }
  return out.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_start - b.t_start);
}

// ------------------------------------------------------------------------------------------------- scene
// The pitch at the passer's last touch: everybody of the part at that instant, a ring on the passer, and where the ball
// is when the pass starts and when it ends. Null when no processed part covers the instant.
export function passScene(parts: Oriented[], p: PassItem): { scene: Scene; ends: { start: [number, number] | null; end: [number, number] | null } } | null {
  const o = parts.find((x) => x.file.video_id === p.video_id && x.file.start_frame === p.part) ?? partFor(parts, p.video_id, p.t_start, p.t_start + 1e-3);
  if (!o) return null;
  const at = positionsAt(o, p.t_start);
  if (!at) return null;
  const dot = at.players.find((d) => d.id === p.from);
  const person = o.file.people.find((x) => x.id === p.from);
  const owner: Scene["owner"] = dot
    ? { id: p.from, role: "holder", name: person?.player_id ?? null, team: dot.team, distance: at.ball ? Math.hypot(dot.x - at.ball[0], dot.y - at.ball[1]) : null }
    : null;
  const ballAt = (t: number) => (partFor(parts, p.video_id, t, t + 1e-3) ? (positionsAt(partFor(parts, p.video_id, t, t + 1e-3) as Oriented, t)?.ball ?? null) : null);
  return { scene: { t: p.t_start, dots: at.players, ball: at.ball, owner, view: at.view }, ends: { start: ballAt(p.t_start), end: ballAt(p.t_end) } };
}

// ------------------------------------------------------------------------------------------------- summary
export interface PassCounts {
  completed: number;
  cut: number;
  approx: number;
}
export function passCounts(items: PassItem[], team: PassTeam | "all" = "all"): PassCounts {
  const mine = items.filter((p) => team === "all" || p.team === team);
  return { completed: mine.filter((p) => p.completed).length, cut: mine.filter((p) => !p.completed).length, approx: mine.filter((p) => p.completed && p.approx).length };
}
