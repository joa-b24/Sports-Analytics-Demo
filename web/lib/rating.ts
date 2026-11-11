// Player rating (0-10) of one match: IN REVIEW. A proposal of weights and discounts (docs/propuesta_calificacion_jugadora.md)
// that the staff has not approved: the app shows it marked as such. Pure functions over the rows of lib/players.ts and the
// events of the match.
//
// How it is made:
//   1. each metric of the player is compared with the players of her team and line in this match (z score, clipped to ±2);
//   2. the z scores are averaged with the weights of her line and taken to 0-10 (6 = the average of the group, see BASE_SCORE);
//   3. then what her actions cost or gave is added: a loss that ended in a shot or a goal of the rival, a foul that gave a
//      shot, a recovery that ended in an attack of hers... each one a line with its minute, never a hidden number.
// A metric with no data does not count (its weight goes to the others); with fewer than MIN_METRICS there is no rating.
import type { PlayerRow } from "./players.ts";
import type { MatchEvent } from "./types.ts";

export type RatingLine = "def" | "mid" | "fwd";
export type RatingKey = "pass_pct" | "progressive" | "key_passes" | "finishing" | "entries" | "recoveries" | "duel_pct" | "losses" | "hsr" | "fouls" | "touches";

export const RATING_LABELS: Record<RatingKey, string> = {
  pass_pct: "Pases completos",
  progressive: "Pases progresivos",
  key_passes: "Pases clave",
  finishing: "Tiros a puerta y goles",
  entries: "Entradas al área",
  recoveries: "Recuperaciones",
  duel_pct: "Duelos ganados",
  losses: "Pérdidas",
  hsr: "Alta intensidad",
  fouls: "Faltas",
  touches: "Toques",
};
// Weights by line (they add up to 100). The roster has no position yet, so every player is rated as `mid` (see lineOf).
export const RATING_WEIGHTS: Record<RatingLine, Record<RatingKey, number>> = {
  def: { pass_pct: 13, progressive: 10, key_passes: 3, finishing: 2, entries: 4, recoveries: 17, duel_pct: 18, losses: 12, hsr: 5, fouls: 5, touches: 11 },
  mid: { pass_pct: 12, progressive: 12, key_passes: 10, finishing: 8, entries: 9, recoveries: 12, duel_pct: 9, losses: 9, hsr: 6, fouls: 3, touches: 10 },
  fwd: { pass_pct: 7, progressive: 7, key_passes: 13, finishing: 26, entries: 13, recoveries: 6, duel_pct: 7, losses: 6, hsr: 5, fouls: 1, touches: 9 },
};
// The rating of an average player of the group. Football ratings are read with 6 as «normal» (5 would be a poor match), and a
// z score of ±2 takes it to the ends: z = +2 is 10, z = -2 is 2.
export const BASE_SCORE = 6;
export const POINTS_PER_Z = 2;
// Metrics where less is better.
const LOWER: RatingKey[] = ["losses", "fouls"];

export const MIN_METRICS = 4;
export const MIN_MINUTES = 20;
export const MIN_PASSES = 5;
export const MIN_DUELS = 3;
// With this many touches her losses are compared per 100 touches, not per 90 minutes.
export const MIN_TOUCHES_FOR_RATE = 15;
export const MIN_GROUP = 3;
export const Z_CLIP = 2;
// What the consequences of her actions can take away or give in a match.
export const ADJUST_MIN = -3;
export const ADJUST_MAX = 3;
// A chain that ends in the same action of the rival (a loss, then a foul, then the goal) takes away at most this much.
export const CHAIN_MIN = -1.5;

// The roster has no position: every player is rated with the midfield weights until it does.
export function lineOf(row: PlayerRow): RatingLine {
  void row;
  return "mid";
}

export interface RatingComponent {
  key: RatingKey;
  label: string;
  value: number; // her figure (per 90 minutes, or a percentage)
  mean: number; // the group's
  z: number;
  weight: number; // share of the weights used (0-1)
  points: number; // what it adds to the base, in rating points
}
export interface RatingAdjustment {
  delta: number;
  label: string;
  event_id: string;
  video_id: string;
  t: number;
}
export interface Rating {
  score: number | null;
  base: number | null;
  adjust: number;
  components: RatingComponent[];
  adjustments: RatingAdjustment[];
  used: number;
  total: number;
  minutes: number | null;
  // Why there is no score.
  reason?: string;
}
export interface RatingOptions {
  lossShotS?: number;
  recoveryAttackS?: number;
  quickRecoveryS?: number;
}

// A goal and a shot of the same player closer than this (s) are one action (lib/analysis.ts SAME_ACTION_S).
const SAME_ACTION_S = 5;
const vid = (e: MatchEvent) => e.video_id ?? "v1";
const other = (t: "own" | "opp") => (t === "own" ? "opp" : "own");
const isShot = (e: MatchEvent) => e.type === "shot" || e.type === "goal";
const clean = (s: string | null | undefined) => (s ?? "").trim();

// Her figure for each metric, or null when it was not measured for her.
export function ratingValues(r: PlayerRow): Record<RatingKey, number | null> {
  const mins = r.minutes_played ?? r.minutes;
  const per90 = (v: number | null) => (v === null || !mins || mins < MIN_MINUTES ? null : (v * 90) / mins);
  const pass = r.passes !== null && r.passes_cut !== null && r.passes + r.passes_cut >= MIN_PASSES ? (100 * r.passes) / (r.passes + r.passes_cut) : null;
  const duels = r.duels_won + r.duels_lost;
  const ev = (v: number) => (r.tagged ? per90(v) : null);
  return {
    pass_pct: pass,
    progressive: per90(r.progressive),
    key_passes: ev(r.key_passes),
    finishing: ev(r.on_target + r.goals),
    entries: ev(r.box_entries),
    recoveries: ev(r.recoveries),
    duel_pct: r.tagged && duels >= MIN_DUELS ? (100 * r.duels_won) / duels : null,
    // Losses count against the ball she handled: whoever touches it more loses it more.
    losses: r.tagged ? (r.touches !== null && r.touches >= MIN_TOUCHES_FOR_RATE ? (100 * r.losses) / r.touches : per90(r.losses)) : null,
    hsr: per90(r.hsr_m),
    touches: per90(r.touches),
    fouls: ev(r.fouls),
  };
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v: number[], m: number) => Math.sqrt(mean(v.map((x) => (x - m) ** 2)));

// What each action of the player cost or gave, from the events (same video, within the windows).
export function ratingAdjustments(row: PlayerRow, events: MatchEvent[], opts: RatingOptions = {}): RatingAdjustment[] {
  const lossS = opts.lossShotS ?? 15;
  const recS = opts.recoveryAttackS ?? 15;
  const quickS = opts.quickRecoveryS ?? 8;
  const sorted = [...events].sort((a, b) => a.t_video - b.t_video);
  const mine = (e: MatchEvent) => e.team === row.team && clean(e.player_id) === row.id;
  const rival = other(row.team);
  const after = (e: MatchEvent, within: number, pred: (x: MatchEvent) => boolean) => sorted.find((x) => x !== e && vid(x) === vid(e) && x.t_video > e.t_video && x.t_video - e.t_video <= within && pred(x));
  type Hit = { delta: number; label: string; e: MatchEvent; target: string | null };
  const hits: Hit[] = [];
  for (const e of sorted) {
    if (!mine(e)) continue;
    if (e.type === "goal") {
      hits.push({ delta: 0.7, label: "Gol", e, target: null });
    } else if (e.type === "shot") {
      // A shot on target; the shot of a goal is that goal (a goal tagged at most SAME_ACTION_S away is not counted twice).
      const isGoalShot = sorted.some((x) => x.type === "goal" && mine(x) && vid(x) === vid(e) && Math.abs(x.t_video - e.t_video) <= SAME_ACTION_S);
      if (e.outcome === "on_target" && !isGoalShot) hits.push({ delta: 0.25, label: "Tiro a puerta", e, target: null });
    } else if (e.type === "corner") {
      hits.push(e.outcome === "shot" ? { delta: 0.4, label: "Córner que acaba en remate", e, target: null } : { delta: 0.1, label: "Córner a favor", e, target: null });
    } else if (e.type === "free_kick") {
      hits.push(e.outcome === "shot" ? { delta: 0.3, label: "Falta a favor que acaba en remate", e, target: null } : { delta: 0.1, label: "Falta a favor", e, target: null });
    } else if (e.type === "loss") {
      const again = after(e, quickS, (x) => x.type === "recovery" && mine(x));
      if (again) hits.push({ delta: 0.3, label: "Pérdida que ella misma recupera", e, target: null });
      const goal = after(e, lossS, (x) => x.team === rival && x.type === "goal");
      const shot = goal ?? after(e, lossS, (x) => x.team === rival && isShot(x));
      const entry = shot ?? after(e, lossS, (x) => x.team === rival && x.type === "box_entry");
      if (goal) hits.push({ delta: -1, label: "Pérdida que acaba en gol del rival", e, target: goal.event_id });
      else if (shot) hits.push({ delta: -0.5, label: "Pérdida que acaba en tiro del rival", e, target: shot.event_id });
      else if (entry) hits.push({ delta: -0.3, label: "Pérdida que acaba en entrada al área del rival", e, target: entry.event_id });
    } else if (e.type === "foul") {
      if (e.detail === "red") hits.push({ delta: -1.5, label: "Tarjeta roja", e, target: null });
      const goal = after(e, lossS, (x) => x.team === rival && x.type === "goal");
      const shot = goal ?? after(e, lossS, (x) => x.team === rival && isShot(x));
      if (goal) hits.push({ delta: -1, label: "Falta que acaba en gol del rival", e, target: goal.event_id });
      else if (shot) hits.push({ delta: -0.5, label: "Falta que acaba en tiro del rival", e, target: shot.event_id });
    } else if (e.type === "recovery") {
      const goal = after(e, recS, (x) => x.team === row.team && x.type === "goal");
      const shot = goal ?? after(e, recS, (x) => x.team === row.team && isShot(x));
      if (goal) hits.push({ delta: 1, label: "Recuperación que acaba en gol propio", e, target: null });
      else if (shot) hits.push({ delta: 0.3, label: "Recuperación que acaba en tiro propio", e, target: null });
    } else if (e.type === "key_pass") {
      const goal = after(e, 8, (x) => x.team === row.team && x.type === "goal");
      const shot = goal ?? after(e, 8, (x) => x.team === row.team && x.type === "shot");
      if (goal) hits.push({ delta: 0.5, label: "Pase clave que acaba en gol", e, target: null });
      else if (shot) hits.push({ delta: 0.3, label: "Pase clave que acaba en tiro", e, target: null });
    }
  }
  // A foul she drew: the rival's foul tagged with her name (the fouled player).
  for (const e of sorted) if (e.type === "foul" && e.team === rival && clean(e.player_id) === row.id) hits.push({ delta: 0.3, label: "Falta provocada", e, target: null });
  // Losses and fouls that end in the same action of the rival are one chain: they add up to at most CHAIN_MIN.
  const out: RatingAdjustment[] = [];
  const byTarget = new Map<string, Hit[]>();
  for (const h of hits) {
    if (h.target && h.delta < 0) byTarget.set(h.target, [...(byTarget.get(h.target) ?? []), h]);
    else out.push({ delta: h.delta, label: h.label, event_id: h.e.event_id, video_id: vid(h.e), t: h.e.t_video });
  }
  for (const list of byTarget.values()) {
    const total = list.reduce((a, h) => a + h.delta, 0);
    const scale = total < CHAIN_MIN ? CHAIN_MIN / total : 1;
    for (const h of list) out.push({ delta: Math.round(h.delta * scale * 100) / 100, label: list.length > 1 ? `${h.label} (cadena)` : h.label, event_id: h.e.event_id, video_id: vid(h.e), t: h.e.t_video });
  }
  return out.sort((a, b) => a.t - b.t);
}

// The rating of every player of the rows. The reference of each metric: the players of her team and line with minutes and
// the metric measured; when they are fewer than MIN_GROUP, the whole team.
export function rateAll(rows: PlayerRow[], events: MatchEvent[], opts: RatingOptions = {}): Map<string, Rating> {
  const values = new Map(rows.map((r) => [r.key, ratingValues(r)]));
  const out = new Map<string, Rating>();
  const keys = Object.keys(RATING_LABELS) as RatingKey[];
  for (const r of rows) {
    const mins = r.minutes_played ?? r.minutes;
    const empty = (reason: string): Rating => ({ score: null, base: null, adjust: 0, components: [], adjustments: [], used: 0, total: keys.length, minutes: mins, reason });
    if (!mins || mins < MIN_MINUTES) {
      out.set(r.key, empty(`menos de ${MIN_MINUTES} min jugados`));
      continue;
    }
    const line = lineOf(r);
    const mine = values.get(r.key) as Record<RatingKey, number | null>;
    const comps: Omit<RatingComponent, "weight" | "points">[] = [];
    for (const k of keys) {
      const v = mine[k];
      if (v === null) continue;
      const pool = (pred: (x: PlayerRow) => boolean) => rows.filter((x) => x.team === r.team && pred(x) && (values.get(x.key) as Record<RatingKey, number | null>)[k] !== null).map((x) => (values.get(x.key) as Record<RatingKey, number | null>)[k] as number);
      let group = pool((x) => lineOf(x) === line);
      if (group.length < MIN_GROUP) group = pool(() => true);
      if (group.length < MIN_GROUP) continue;
      const m = mean(group);
      const s = sd(group, m);
      let z = s > 1e-9 ? (v - m) / s : 0;
      if (LOWER.includes(k)) z = -z;
      comps.push({ key: k, label: RATING_LABELS[k], value: Math.round(v * 10) / 10, mean: Math.round(m * 10) / 10, z: Math.max(-Z_CLIP, Math.min(Z_CLIP, z)) });
    }
    if (comps.length < MIN_METRICS) {
      out.set(r.key, { ...empty(`solo ${comps.length} métrica(s) con datos (hacen falta ${MIN_METRICS})`), components: [] });
      continue;
    }
    const wsum = comps.reduce((a, c) => a + RATING_WEIGHTS[line][c.key], 0);
    const components: RatingComponent[] = comps.map((c) => {
      const weight = RATING_WEIGHTS[line][c.key] / wsum;
      return { ...c, weight, points: POINTS_PER_Z * weight * c.z };
    });
    const base = BASE_SCORE + components.reduce((a, c) => a + c.points, 0);
    const adjustments = ratingAdjustments(r, events, opts);
    const adjust = Math.max(ADJUST_MIN, Math.min(ADJUST_MAX, adjustments.reduce((a, x) => a + x.delta, 0)));
    const score = Math.max(0, Math.min(10, base + adjust));
    out.set(r.key, { score: Math.round(score * 10) / 10, base: Math.round(base * 10) / 10, adjust: Math.round(adjust * 10) / 10, components, adjustments, used: components.length, total: keys.length, minutes: mins });
  }
  return out;
}
