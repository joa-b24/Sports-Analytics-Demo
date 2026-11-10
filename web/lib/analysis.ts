import type { Segment } from "./segments";
import type { MatchEvent } from "./types";
import { PITCH } from "./types.ts";

// Answers to the staff questions in docs/preguntas_cuerpo_tecnico.md, computed from hand-tagged events.
// Pure functions over plain arrays. Every result carries its sample size: the UI must show it.
// Convention of the contract: the analysed team ("own") attacks toward x = 105 in both halves; "opp" toward x = 0.

type Side = "own" | "opp";
const LENGTH = 105;
const WIDTH = 68;
export const SHOT_WINDOW_S = 15;
export const COUNTERPRESS_WINDOW_S = 8;

const other = (t: Side): Side => (t === "own" ? "opp" : "own");
const isShot = (e: MatchEvent) => e.type === "shot" || e.type === "goal";
const byTime = (events: MatchEvent[]) => [...events].sort((a, b) => a.t_video - b.t_video);

// True when an event matching `pred` happens within `window` seconds after events[i]. `events` sorted by time.
function followed(events: MatchEvent[], i: number, window: number, pred: (e: MatchEvent) => boolean): boolean {
  const t = events[i].t_video;
  for (let j = i + 1; j < events.length && events[j].t_video - t <= window; j++) if (pred(events[j])) return true;
  return false;
}

export interface Rate {
  // k of n
  k: number;
  n: number;
}

export interface Transitions {
  // B2: losses followed by a shot of the other team within 15 s.
  lossToShotAgainst: Rate;
  // B3: losses followed by an own recovery within 8 s.
  counterpress: Rate;
  // D1: recoveries followed by an own shot within 15 s.
  recoveryToShot: Rate;
  // D2: the recoveries that did end in a shot (for the zone map).
  recoveriesToShot: MatchEvent[];
}

export function transitions(all: MatchEvent[], team: Side): Transitions {
  const events = byTime(all);
  const out: Transitions = { lossToShotAgainst: { k: 0, n: 0 }, counterpress: { k: 0, n: 0 }, recoveryToShot: { k: 0, n: 0 }, recoveriesToShot: [] };
  events.forEach((e, i) => {
    if (e.team !== team) return;
    if (e.type === "loss") {
      out.lossToShotAgainst.n++;
      out.counterpress.n++;
      if (followed(events, i, SHOT_WINDOW_S, (x) => x.team === other(team) && isShot(x))) out.lossToShotAgainst.k++;
      if (followed(events, i, COUNTERPRESS_WINDOW_S, (x) => x.team === team && x.type === "recovery")) out.counterpress.k++;
    } else if (e.type === "recovery") {
      out.recoveryToShot.n++;
      if (followed(events, i, SHOT_WINDOW_S, (x) => x.team === team && isShot(x))) {
        out.recoveryToShot.k++;
        out.recoveriesToShot.push(e);
      }
    }
  });
  return out;
}

// The moments behind B2 and D1: each loss (or recovery) of `team` and the shot that came after it within
// SHOT_WINDOW_S (the first one). Losses are followed by a shot of the other team, recoveries by one of `team`.
export interface TransitionMoment {
  kind: "loss_to_shot" | "recovery_to_shot";
  start: MatchEvent;
  shot: MatchEvent;
}

export function transitionMoments(all: MatchEvent[], team: Side): TransitionMoment[] {
  const events = byTime(all);
  const out: TransitionMoment[] = [];
  events.forEach((e, i) => {
    if (e.team !== team || (e.type !== "loss" && e.type !== "recovery")) return;
    const shooter = e.type === "loss" ? other(team) : team;
    for (let j = i + 1; j < events.length && events[j].t_video - e.t_video <= SHOT_WINDOW_S; j++) {
      const x = events[j];
      if (x.team === shooter && isShot(x)) {
        out.push({ kind: e.type === "loss" ? "loss_to_shot" : "recovery_to_shot", start: e, shot: x });
        break;
      }
    }
  });
  return out;
}

// A goal and a shot of the same team tagged closer than this (s) are one action: the shot that went in. A penalty or a
// free kick taken as a shot is tagged with its shot too, so it is counted once, as that shot.
export const SAME_ACTION_S = 5;

// Each finish of a team, once: a shot (with its goal, if it went in) or a goal tagged without a shot (an own goal, a
// deflection). Tagging a goal, a shot and a penalty for the same action gives one shot and one goal, not three.
export interface Finish {
  shot: MatchEvent | null;
  goal: MatchEvent | null;
}
export function finishes(all: MatchEvent[], team: Side): Finish[] {
  const shots = byTime(all.filter((e) => e.team === team && e.type === "shot"));
  const goals = byTime(all.filter((e) => e.team === team && e.type === "goal"));
  const vid = (e: MatchEvent) => e.video_id ?? "v1";
  const used = new Set<string>();
  const out: Finish[] = shots.map((shot) => ({ shot, goal: null }));
  for (const g of goals) {
    let best: Finish | null = null;
    for (const f of out) {
      const s = f.shot;
      if (!s || used.has(s.event_id) || vid(s) !== vid(g) || Math.abs(s.t_video - g.t_video) > SAME_ACTION_S) continue;
      if (!best || Math.abs(s.t_video - g.t_video) < Math.abs((best.shot as MatchEvent).t_video - g.t_video)) best = f;
    }
    if (best) {
      best.goal = g;
      used.add((best.shot as MatchEvent).event_id);
    } else out.push({ shot: null, goal: g });
  }
  return out.sort((a, b) => (a.shot ?? a.goal)!.t_video - (b.shot ?? b.goal)!.t_video);
}

// One event per finish, for maps and lists: the shot, marked as a goal (type "goal") when it went in, with what is
// missing taken from its goal (position, spot on the goal); a goal without a shot as it is.
export function finishEvents(all: MatchEvent[]): MatchEvent[] {
  return (["own", "opp"] as Side[]).flatMap((team) =>
    finishes(all, team).map(({ shot, goal }) => {
      if (!shot) return goal as MatchEvent;
      if (!goal) return shot;
      return {
        ...shot,
        type: "goal" as const,
        x: shot.x ?? goal.x,
        y: shot.y ?? goal.y,
        goal_y: shot.goal_y ?? goal.goal_y ?? null,
        goal_z: shot.goal_z ?? goal.goal_z ?? null,
        player_id: shot.player_id ?? goal.player_id,
      };
    }),
  );
}

export interface ShotBreakdown {
  // Shots (a goal without a shot is not one).
  total: number;
  // Every goal, with or without its shot.
  goals: number;
  // Goals tagged without a shot (own goals, deflections): counted in `goals`, not in `total`.
  goalsWithoutShot: number;
  // Shots on target, the ones that went in included.
  onTarget: number;
  offTarget: number;
  blocked: number;
  // Shots tagged without a result (and not followed by a goal).
  unknown: number;
}

// A1
export function shotBreakdown(events: MatchEvent[], team: Side): ShotBreakdown {
  const out: ShotBreakdown = { total: 0, goals: 0, goalsWithoutShot: 0, onTarget: 0, offTarget: 0, blocked: 0, unknown: 0 };
  for (const { shot, goal } of finishes(events, team)) {
    if (goal) out.goals++;
    if (!shot) {
      out.goalsWithoutShot++;
      continue;
    }
    out.total++;
    if (goal || shot.outcome === "on_target") out.onTarget++;
    else if (shot.outcome === "off_target") out.offTarget++;
    else if (shot.outcome === "blocked") out.blocked++;
    else out.unknown++;
  }
  return out;
}

export interface Lanes {
  left: number;
  center: number;
  right: number;
  // Events without a marked position: not counted in any lane.
  missing: number;
}

// Lane seen by the attacking team. Own attacks toward +x, so its left is the low-y side; for opp it is the opposite.
export function laneOf(e: MatchEvent): "left" | "center" | "right" | null {
  if (e.y === null) return null;
  const third = e.y < WIDTH / 3 ? 0 : e.y < (2 * WIDTH) / 3 ? 1 : 2;
  if (third === 1) return "center";
  return (third === 0) === (e.team === "own") ? "left" : "right";
}

function lanes(events: MatchEvent[]): Lanes {
  const out: Lanes = { left: 0, center: 0, right: 0, missing: 0 };
  for (const e of events) {
    const l = laneOf(e);
    if (l) out[l]++;
    else out.missing++;
  }
  return out;
}

// A2, C2
export function finalThirdEntries(events: MatchEvent[], team: Side): Lanes & { total: number } {
  const es = events.filter((e) => e.team === team && e.type === "final_third_entry");
  return { ...lanes(es), total: es.length };
}

// A3
export function boxEntries(all: MatchEvent[], team: Side): Rate {
  const events = byTime(all);
  const out: Rate = { k: 0, n: 0 };
  events.forEach((e, i) => {
    if (e.team !== team || e.type !== "box_entry") return;
    out.n++;
    if (followed(events, i, SHOT_WINDOW_S, (x) => x.team === team && isShot(x))) out.k++;
  });
  return out;
}

export interface Tally {
  total: number;
  counts: Record<string, number>;
  // Tagged without that datum.
  unknown: number;
}

function tally(events: MatchEvent[], field: "outcome" | "detail", keys: string[]): Tally {
  const out: Tally = { total: events.length, counts: Object.fromEntries(keys.map((k) => [k, 0])), unknown: 0 };
  for (const e of events) {
    const v = e[field] ?? null;
    if (v !== null && v in out.counts) out.counts[v]++;
    else out.unknown++;
  }
  return out;
}

const SET_PIECE = ["shot", "cleared", "play_on"];

// A5: the crosses of a team. A corner played in the air (inswing / outswing) and a free kick taken as a cross are crosses
// into the box too; a short corner or a free kick played short, long or shot directly are not.
export const isCrossLike = (e: MatchEvent) =>
  e.type === "cross" || (e.type === "corner" && (e.detail === "inswing" || e.detail === "outswing")) || (e.type === "free_kick" && e.detail === "cross");
export function crosses(events: MatchEvent[], team: Side): { outcome: Tally; lanes: Lanes } {
  const es = events.filter((e) => e.team === team && isCrossLike(e));
  return { outcome: tally(es, "outcome", SET_PIECE), lanes: lanes(es) };
}

// E1, E2
export function setPieces(events: MatchEvent[], team: Side): { corners: Tally; delivery: Tally; freeKicks: Tally } {
  const corners = events.filter((e) => e.team === team && e.type === "corner");
  const fks = events.filter((e) => e.team === team && e.type === "free_kick");
  return { corners: tally(corners, "outcome", SET_PIECE), delivery: tally(corners, "detail", ["inswing", "outswing", "short"]), freeKicks: tally(fks, "outcome", SET_PIECE) };
}

// A4
export function goalKicks(events: MatchEvent[], team: Side): { length: Tally; outcome: Tally } {
  const es = events.filter((e) => e.team === team && e.type === "goal_kick");
  return { length: tally(es, "detail", ["short", "long"]), outcome: tally(es, "outcome", ["kept", "lost"]) };
}

// D3
export function firstPass(events: MatchEvent[], team: Side): Tally {
  return tally(events.filter((e) => e.team === team && e.type === "recovery"), "detail", ["forward", "backward"]);
}

// C1: thirds of the pitch seen by the team: own half is where it defends.
export function recoveryHeight(events: MatchEvent[], team: Side): { own: number; middle: number; rival: number; missing: number } {
  const out = { own: 0, middle: 0, rival: 0, missing: 0 };
  for (const e of events) {
    if (e.team !== team || e.type !== "recovery") continue;
    if (e.x === null) {
      out.missing++;
      continue;
    }
    const x = team === "own" ? e.x : LENGTH - e.x;
    if (x < LENGTH / 3) out.own++;
    else if (x < (2 * LENGTH) / 3) out.middle++;
    else out.rival++;
  }
  return out;
}

// Seconds of play elapsed at video time t. Null when t is not inside a "juego" stretch.
export function playTime(segments: Segment[], t: number): number | null {
  let acc = 0;
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (s.tipo !== "juego") continue;
    const end = s.end ?? Infinity;
    if (t >= s.start && t < end) return acc + (t - s.start);
    if (t >= end) acc += end - s.start;
  }
  return null;
}

export const BIN_MEASURES = {
  shots: "Tiros",
  recoveries: "Recuperaciones",
  losses: "Pérdidas",
  entries: "Entradas al último tercio y al área",
} as const;
export type BinMeasure = keyof typeof BIN_MEASURES;

export interface TimeBins {
  bins: { label: string; own: Record<BinMeasure, number>; opp: Record<BinMeasure, number> }[];
  // "juego": minutes of play, from the marked stretches. "video": minutes of video since the first event (no stretches marked).
  basis: "juego" | "video";
  // Events outside every play stretch: left out.
  skipped: number;
}

// F1: what each team produces in every stretch of `binMin` minutes.
export function timeBins(events: MatchEvent[], segments: Segment[], binMin: number): TimeBins {
  const hasPlay = segments.some((s) => s.tipo === "juego");
  const t0 = events.length ? Math.min(...events.map((e) => e.t_video)) : 0;
  const zero = (): Record<BinMeasure, number> => ({ shots: 0, recoveries: 0, losses: 0, entries: 0 });
  const bins: TimeBins["bins"] = [];
  let skipped = 0;
  for (const e of events) {
    if (e.team !== "own" && e.team !== "opp") continue;
    const t = hasPlay ? playTime(segments, e.t_video) : e.t_video - t0;
    if (t === null) {
      skipped++;
      continue;
    }
    const i = Math.floor(t / 60 / binMin);
    while (bins.length <= i) bins.push({ label: `${bins.length * binMin}–${(bins.length + 1) * binMin}′`, own: zero(), opp: zero() });
    const m: BinMeasure | null = e.type === "shot"
      ? "shots"
      : e.type === "recovery"
        ? "recoveries"
        : e.type === "loss"
          ? "losses"
          : e.type === "final_third_entry" || e.type === "box_entry"
            ? "entries"
            : null;
    if (m) bins[i][e.team][m]++;
  }
  return { bins, basis: hasPlay ? "juego" : "video", skipped };
}

// Momentum: how much threat each team creates around every minute of play. Every event adds a weight (a goal counts more
// than an entry to the last third) and the weights are summed in a sliding window, so the curve rises when a team keeps
// arriving and falls when it stops. Only the events with a team; the same clock as timeBins (minutes of play when the
// stretches are marked, else minutes of video since the first event).
export const MOMENTUM_WEIGHTS: Partial<Record<MatchEvent["type"], number>> = {
  goal: 5,
  shot: 3,
  box_entry: 2,
  final_third_entry: 1,
  corner: 1,
  cross: 1,
};

export interface Momentum {
  // One point per minute: the threat of each team in the window around it.
  points: { min: number; own: number; opp: number }[];
  basis: "juego" | "video";
  skipped: number;
  windowMin: number;
}

export function momentum(events: MatchEvent[], segments: Segment[], windowMin = 5): Momentum {
  const hasPlay = segments.some((s) => s.tipo === "juego");
  const t0 = events.length ? Math.min(...events.map((e) => e.t_video)) : 0;
  const hits: { min: number; team: "own" | "opp"; w: number }[] = [];
  let skipped = 0;
  for (const e of events) {
    const w = MOMENTUM_WEIGHTS[e.type];
    if (!w || (e.team !== "own" && e.team !== "opp")) continue;
    const t = hasPlay ? playTime(segments, e.t_video) : e.t_video - t0;
    if (t === null) {
      skipped++;
      continue;
    }
    hits.push({ min: t / 60, team: e.team, w });
  }
  const last = hits.length ? Math.ceil(Math.max(...hits.map((h) => h.min))) : 0;
  const points: Momentum["points"] = [];
  for (let m = 0; m <= last; m++) {
    let own = 0;
    let opp = 0;
    for (const h of hits) {
      if (Math.abs(h.min - m) > windowMin / 2) continue;
      if (h.team === "own") own += h.w;
      else opp += h.w;
    }
    points.push({ min: m, own, opp });
  }
  return { points, basis: hasPlay ? "juego" : "video", skipped, windowMin };
}

// Momentum as one signed curve (own above zero, opponent below): at each instant every team's threat is the sum of its
// events, each worth its weight and fading with time (half-life MOMENTUM_HALF_LIFE_MIN); the curve is the difference,
// smoothed, and scaled so the biggest swing of the match is ±100. Only past events count at each instant (momentum is
// what has just happened), so a goal makes the curve jump at that minute and then fade. The method follows the idea of
// recency-weighted threat (see README, «Referencias»); the weights are this project's own (MOMENTUM_WEIGHTS).
export const MOMENTUM_HALF_LIFE_MIN = 1.5;
const MOMENTUM_STEP_MIN = 0.25;
const MOMENTUM_SMOOTH_SIGMA_MIN = 0.5;

export interface MomentumCurve {
  // Every MOMENTUM_STEP_MIN minutes: the signed value in [-100, 100] and the unscaled threat of each team.
  points: { min: number; value: number; own: number; opp: number }[];
  goals: { min: number; team: "own" | "opp" }[];
  // Minute of the end of the first half, when both halves have events.
  halfTime: number | null;
  basis: "juego" | "video";
  skipped: number;
}

export function momentumCurve(events: MatchEvent[], segments: Segment[]): MomentumCurve {
  const hasPlay = segments.some((s) => s.tipo === "juego");
  const t0 = events.length ? Math.min(...events.map((e) => e.t_video)) : 0;
  const hits: { min: number; team: "own" | "opp"; w: number; half: number }[] = [];
  const goals: MomentumCurve["goals"] = [];
  let skipped = 0;
  for (const e of events) {
    const w = MOMENTUM_WEIGHTS[e.type];
    if (!w || (e.team !== "own" && e.team !== "opp")) continue;
    const t = hasPlay ? playTime(segments, e.t_video) : e.t_video - t0;
    if (t === null) {
      skipped++;
      continue;
    }
    hits.push({ min: t / 60, team: e.team, w, half: e.period ?? 1 });
    if (e.type === "goal") goals.push({ min: t / 60, team: e.team });
  }
  const basis = hasPlay ? "juego" : "video";
  if (hits.length === 0) return { points: [], goals, halfTime: null, basis, skipped };
  const last = Math.ceil(Math.max(...hits.map((h) => h.min))) + 1;
  const n = Math.round(last / MOMENTUM_STEP_MIN);
  const k = Math.LN2 / MOMENTUM_HALF_LIFE_MIN;
  const own = new Array<number>(n + 1).fill(0);
  const opp = new Array<number>(n + 1).fill(0);
  for (let i = 0; i <= n; i++) {
    const t = i * MOMENTUM_STEP_MIN;
    for (const h of hits) {
      if (h.min > t) continue;
      const v = h.w * Math.exp(-k * (t - h.min));
      if (h.team === "own") own[i] += v;
      else opp[i] += v;
    }
  }
  // Gaussian smoothing of the difference.
  const radius = Math.ceil((3 * MOMENTUM_SMOOTH_SIGMA_MIN) / MOMENTUM_STEP_MIN);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, j) => Math.exp(-0.5 * (((j - radius) * MOMENTUM_STEP_MIN) / MOMENTUM_SMOOTH_SIGMA_MIN) ** 2));
  const diff = own.map((v, i) => v - opp[i]);
  const smooth = diff.map((_, i) => {
    let s = 0;
    let wsum = 0;
    for (let j = -radius; j <= radius; j++) {
      const at = i + j;
      if (at < 0 || at > n) continue;
      s += diff[at] * kernel[j + radius];
      wsum += kernel[j + radius];
    }
    return s / wsum;
  });
  const peak = Math.max(...smooth.map(Math.abs));
  const points = smooth.map((v, i) => ({ min: i * MOMENTUM_STEP_MIN, value: peak > 0 ? (100 * v) / peak : 0, own: own[i], opp: opp[i] }));
  const firstHalf = hits.filter((h) => h.half === 1);
  const halfTime = firstHalf.length && firstHalf.length < hits.length ? Math.max(...firstHalf.map((h) => h.min)) : null;
  return { points, goals, halfTime, basis, skipped };
}

// Territory: the pitch in a grid (columns along its length, rows across it) where each cell counts the tagged actions with a
// position of each team. A cell «belongs» to the team with more of them; `share` is the own team's part of the cell. Events
// keep the absolute coordinates of the contract (our team attacks to the right).
export const TERRITORY_TYPES: readonly MatchEvent["type"][] = ["recovery", "loss", "final_third_entry", "box_entry", "shot", "goal", "cross", "corner", "free_kick", "duel", "foul", "key_pass"];
export interface TerritoryCell {
  own: number;
  opp: number;
  share: number | null;
}
export function territoryGrid(events: MatchEvent[], cols = 6, rows = 3): { cells: TerritoryCell[][]; placed: number; missing: number } {
  const cells: TerritoryCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ own: 0, opp: 0, share: null })));
  let placed = 0;
  let missing = 0;
  for (const e of events) {
    if ((e.team !== "own" && e.team !== "opp") || !TERRITORY_TYPES.includes(e.type)) continue;
    if (e.x === null || e.y === null || e.x === undefined || e.y === undefined) {
      missing++;
      continue;
    }
    const c = Math.min(cols - 1, Math.max(0, Math.floor((e.x / PITCH.length) * cols)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((e.y / PITCH.width) * rows)));
    cells[r][c][e.team]++;
    placed++;
  }
  for (const row of cells) for (const cell of row) cell.share = cell.own + cell.opp > 0 ? cell.own / (cell.own + cell.opp) : null;
  return { cells, placed, missing };
}
