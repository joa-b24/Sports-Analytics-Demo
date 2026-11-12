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
import { finishes } from "./analysis.ts";
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

// After a foul the rival takes a free kick (or a penalty): the goal that comes from it is the foul's consequence if the set piece
// is taken within this many seconds of the foul (the game stops, so it is longer than the window of a loss).
export const SET_PIECE_GAP_S = 90;
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

  // Goals and shots of her team, as lib/analysis.ts reads them (a shot and its goal are one action): the goal goes to whoever
  // scored it (the shooter when the goal was tagged with no name), a shot on target without goal to the shooter.
  for (const f of finishes(events, row.team)) {
    const scorer = clean(f.goal?.player_id) || clean(f.shot?.player_id);
    const shooter = clean(f.shot?.player_id) || clean(f.goal?.player_id);
    if (f.goal && scorer === row.id) hits.push({ delta: 0.5, label: "Gol", e: f.goal, target: null });
    else if (!f.goal && f.shot && shooter === row.id && f.shot.outcome === "on_target") hits.push({ delta: 0.2, label: "Tiro a puerta", e: f.shot, target: null });
  }

  // What the rival got from a moment: a goal or a shot within `within` s, or, after a foul, from the free kick (or penalty) the
  // rival takes: the set piece itself (outcome «remate») or a shot or goal within `within` s of it.
  type Outcome = { kind: "goal" | "shot" | "entry"; ev: MatchEvent };
  const direct = (from: MatchEvent, within: number, entries: boolean): Outcome | null => {
    const goal = after(from, within, (x) => x.team === rival && x.type === "goal");
    if (goal) return { kind: "goal", ev: goal };
    const shot = after(from, within, (x) => x.team === rival && isShot(x));
    if (shot) return { kind: "shot", ev: shot };
    const entry = entries ? after(from, within, (x) => x.team === rival && x.type === "box_entry") : undefined;
    return entry ? { kind: "entry", ev: entry } : null;
  };
  const afterFoul = (foul: MatchEvent): Outcome | null => {
    const d = direct(foul, lossS, false);
    if (d) return d;
    const fk = after(foul, SET_PIECE_GAP_S, (x) => x.team === rival && (x.type === "free_kick" || x.type === "penalty"));
    if (!fk) return null;
    const goal = after(fk, lossS, (x) => x.team === rival && x.type === "goal");
    if (goal || fk.type === "penalty") return goal ? { kind: "goal", ev: goal } : null;
    const shot = after(fk, lossS, (x) => x.team === rival && isShot(x));
    if (shot) return { kind: "shot", ev: shot };
    return fk.outcome === "shot" ? { kind: "shot", ev: fk } : null;
  };
  const cost = (o: Outcome) => (o.kind === "goal" ? -1 : o.kind === "shot" ? -0.5 : -0.3);
  const what = (o: Outcome) => (o.kind === "goal" ? "gol" : o.kind === "shot" ? "tiro" : "entrada al área");

  for (const e of sorted) {
    if (!mine(e)) continue;
    if (e.type === "corner") {
      hits.push(e.outcome === "shot" ? { delta: 0.4, label: "Córner que acaba en remate", e, target: null } : { delta: 0.1, label: "Córner a favor", e, target: null });
    } else if (e.type === "free_kick") {
      hits.push(e.outcome === "shot" ? { delta: 0.3, label: "Falta a favor que acaba en remate", e, target: null } : { delta: 0.1, label: "Falta a favor", e, target: null });
    } else if (e.type === "loss") {
      const again = after(e, quickS, (x) => x.type === "recovery" && mine(x));
      if (again) hits.push({ delta: 0.3, label: "Pérdida que ella misma recupera", e, target: null });
      // The loss ends in the rival's action, or in her own foul (within the window) and what came from that foul: one chain.
      const own = direct(e, lossS, true);
      const foul = after(e, lossS, (x) => x.type === "foul" && mine(x));
      const viaFoul = foul ? afterFoul(foul) : null;
      const o = own && own.kind !== "entry" ? own : (viaFoul ?? own);
      if (o) hits.push({ delta: cost(o), label: `Pérdida que acaba en ${viaFoul && o === viaFoul ? `falta y ${what(o)}` : what(o)} del rival`, e, target: o.ev.event_id });
    } else if (e.type === "foul") {
      if (e.detail === "red") hits.push({ delta: -1.5, label: "Tarjeta roja", e, target: null });
      const o = afterFoul(e);
      if (o && o.kind !== "entry") hits.push({ delta: cost(o), label: `Falta que acaba en ${what(o)} del rival`, e, target: o.ev.event_id });
    } else if (e.type === "recovery") {
      const goal = after(e, recS, (x) => x.team === row.team && x.type === "goal");
      const shot = goal ?? after(e, recS, (x) => x.team === row.team && isShot(x));
      if (goal) hits.push({ delta: 0.5, label: "Recuperación que acaba en gol propio", e, target: null });
      else if (shot) hits.push({ delta: 0.2, label: "Recuperación que acaba en tiro propio", e, target: null });
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
