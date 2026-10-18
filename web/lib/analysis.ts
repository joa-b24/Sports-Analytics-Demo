import type { Segment } from "./segments";
import type { MatchEvent } from "./types";

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

// A5
export function crosses(events: MatchEvent[], team: Side): { outcome: Tally; lanes: Lanes } {
  const es = events.filter((e) => e.team === team && e.type === "cross");
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
