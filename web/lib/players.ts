import { finishes } from "./analysis.ts";
import { physical } from "./physical.ts";
import { inStretches, passArrows, passesAndTurnovers, type Oriented } from "./positions.ts";
import type { Segment } from "./segments.ts";
import type { MatchEvent } from "./types.ts";

// Individual performance: one row per player of either team, joining what was tagged by hand (events with her
// player_id) and what was read from the corrected tracking (her name in the correction table). A figure that has no
// source in this match is null, never 0: "not measured" is not "none".

type Side = "own" | "opp";

export interface PlayerRow {
  key: string; // `${team}|${id}`
  team: Side;
  id: string; // as in the events and the tracking ("Paz", "R7")
  // Her team has events tagged with a player's name in this match. If not, her event figures were not noted (null in
  // metricValue), not zero.
  tagged: boolean;
  // From the events.
  events: number;
  goals: number;
  shots: number;
  on_target: number;
  key_passes: number;
  crosses: number;
  box_entries: number;
  recoveries: number;
  losses: number;
  duels_won: number;
  duels_lost: number;
  fouls: number;
  // From the tracking (null without positions of her).
  minutes: number | null; // time seen in frame (measured or filled): the denominator of the per-10-minutes rates
  // Minutes played on the clock (see playedMinutes); null = no data (a substitute with no substitution tagged).
  minutes_played: number | null;
  fill_time_pct: number | null; // share of the time seen that comes from filled positions
  fill_dist_pct: number | null; // share of the distance that comes from filled positions
  touches: number | null;
  passes: number | null; // completed
  passes_cut: number | null;
  progressive: number | null;
  distance_m: number | null;
  per_min_m: number | null;
  top_kmh: number | null;
  hsr_m: number | null;
  sprints: number | null;
}

export interface PlayersInput {
  events: MatchEvent[];
  parts: Oriented[];
  // Which half each video belongs to (match.yaml `period`, MatchVideo.period). Without it every video is its own half.
  videoPeriods?: { video_id: string; period: number }[];
  // Play stretches by video; with none, all the followed ball counts (as in ballReport).
  playByVideo?: Record<string, Segment[]>;
}

const clean = (s: string | null | undefined) => (s ?? "").trim();

export function playerRows({ events, parts, playByVideo = {}, videoPeriods }: PlayersInput): PlayerRow[] {
  const rows = new Map<string, PlayerRow>();
  const row = (team: Side, id: string): PlayerRow => {
    const key = `${team}|${id}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        key, team, id, tagged: false, events: 0, goals: 0, shots: 0, on_target: 0, key_passes: 0, crosses: 0, box_entries: 0, recoveries: 0, losses: 0,
        duels_won: 0, duels_lost: 0, fouls: 0, minutes: null, minutes_played: null, fill_time_pct: null, fill_dist_pct: null, touches: null, passes: null, passes_cut: null, progressive: null,
        distance_m: null, per_min_m: null, top_kmh: null, hsr_m: null, sprints: null,
      };
      rows.set(key, r);
    }
    return r;
  };

  // Events. A goal and its shot are one action (lib/analysis.ts finishes): the shot counts once, the goal goes to whoever
  // scored it.
  for (const e of events) {
    const id = clean(e.player_id);
    if (!id || (e.team !== "own" && e.team !== "opp") || e.type === "substitution") continue;
    const r = row(e.team, id);
    r.events++;
    if (e.type === "key_pass") r.key_passes++;
    else if (e.type === "cross") r.crosses++;
    else if (e.type === "box_entry") r.box_entries++;
    else if (e.type === "recovery") r.recoveries++;
    else if (e.type === "loss") r.losses++;
    else if (e.type === "foul") r.fouls++;
    else if (e.type === "duel" && e.outcome === "won") r.duels_won++;
    else if (e.type === "duel" && e.outcome === "lost") r.duels_lost++;
  }
  for (const team of ["own", "opp"] as const)
    for (const { shot, goal } of finishes(events, team)) {
      const scorer = clean(goal?.player_id) || clean(shot?.player_id);
      if (goal && scorer) row(team, scorer).goals++;
      const shooter = clean(shot?.player_id) || clean(goal?.player_id);
      if (!shot || !shooter) continue;
      const r = row(team, shooter);
      r.shots++;
      if (goal || shot.outcome === "on_target") r.on_target++;
    }

  for (const r of rows.values()) r.tagged = events.some((e) => e.team === r.team && clean(e.player_id) !== "");

  if (parts.length > 0) {
    // Physical: everyone with a name and positions.
    for (const team of ["own", "opp"] as const)
      for (const p of physical(parts, team)) {
        const r = row(team, p.name);
        r.minutes = Math.round((p.seconds / 60) * 10) / 10;
        r.fill_time_pct = p.fill_time_pct;
        r.fill_dist_pct = p.fill_dist_pct;
        r.distance_m = p.distance_m;
        r.per_min_m = p.per_min_m;
        r.top_kmh = p.top_kmh;
        r.hsr_m = p.hsr_m;
        r.sprints = p.sprints;
      }
    for (const [key, m] of playedMinutes({ events, parts, playByVideo, videoPeriods })) {
      const r = rows.get(key);
      if (r) r.minutes_played = m;
    }
    // Ball: touches, passes completed and cut, by the passer. Only with the ball followed in some part.
    const usePlay = Object.values(playByVideo).some((segs) => segs.some((g) => g.tipo === "juego" && g.end !== null));
    const withBall = parts.some((o) => o.file.ball.length > 0);
    if (withBall) {
      for (const r of rows.values())
        if (r.minutes !== null) {
          r.touches = 0;
          r.passes = 0;
          r.passes_cut = 0;
          r.progressive = 0;
        }
      for (const o of parts) {
        const f = o.file;
        const play = usePlay ? (playByVideo[f.video_id] ?? []) : null;
        const name = new Map(f.people.map((p) => [p.id, clean(p.player_id)]));
        const res = passesAndTurnovers(f);
        const named = (id: number, team: Side) => {
          const n = name.get(id);
          const r = n ? rows.get(`${team}|${n}`) : undefined;
          return r && r.touches !== null ? r : null;
        };
        for (const t of res.touches) {
          const r = inStretches(play, t.frame / f.fps) ? named(t.id, t.team) : null;
          if (r) r.touches = (r.touches ?? 0) + 1;
        }
        for (const p of res.passes) {
          const r = inStretches(play, p.from_frame / f.fps) ? named(p.from, p.team) : null;
          if (r) r.passes = (r.passes ?? 0) + 1;
        }
        for (const tv of res.turnovers) {
          const r = inStretches(play, tv.from_frame / f.fps) ? named(tv.from, tv.lost) : null;
          if (r) r.passes_cut = (r.passes_cut ?? 0) + 1;
        }
      }
      for (const team of ["own", "opp"] as const)
        for (const a of passArrows(parts, team, playByVideo)) {
          const r = a.progressive && a.from ? rows.get(`${team}|${clean(a.from)}`) : undefined;
          if (r && r.progressive !== null) r.progressive++;
        }
    }
  }
  return [...rows.values()].sort((a, b) => (a.team === b.team ? (b.minutes ?? 0) - (a.minutes ?? 0) || b.events - a.events : a.team === "own" ? -1 : 1));
}

// ------------------------------------------------------------------------------------------------- minutes played

// Rótulo para los minutos que no se pueden calcular (suplente sin cambio etiquetado): nunca se rellenan.
export const NO_DATA = "sin dato";

// Minutes played ON THE CLOCK, not time seen in frame:
//   sum over each half of [end of the half - start of the half] - minutes off the pitch in that half.
// Source of the half clock: the play stretches (`tipo = juego`) of segments.csv, per video: the start of the first and
// the end of the last. A half that comes in several videos (match.yaml `period`) adds its videos in id order. A video
// with no closed play stretch falls back to the extent of its tracking files (first start_frame to last end_frame).
// Starters = named players who appear in the first tracking clip of each half (the earliest part of its first video).
// Substitutions: `substitution` events (player_id leaves, player_in enters) and red cards (`foul`, detail red) set the
// time she enters or leaves, in the clock of that half. A player who is not a starter of a half and has no entry
// tagged in it is unknown for that half, and then her total is null (no data): it is not guessed.
// Returns minutes by `${team}|${name}`.
export function playedMinutes({ events, parts, playByVideo = {}, videoPeriods }: Pick<PlayersInput, "events" | "parts" | "playByVideo" | "videoPeriods">): Map<string, number | null> {
  const videoIds = [...new Set(parts.map((o) => o.file.video_id))];
  const periodOf = new Map<string, number>(videoIds.map((v, i) => [v, i + 1]));
  for (const vp of videoPeriods ?? []) if (videoIds.includes(vp.video_id)) periodOf.set(vp.video_id, vp.period);
  const num = (v: string) => Number(v.replace(/\D/g, "")) || 0;
  const periods = [...new Set(periodOf.values())].sort((a, b) => a - b);
  const keyOf = (team: string, name: string | null | undefined) => `${team}|${clean(name)}`;
  // Clock of each video: [start, end] in its own t_video.
  const bounds = (v: string): [number, number] | null => {
    const g = (playByVideo[v] ?? []).filter((x) => x.tipo === "juego" && x.end !== null);
    if (g.length) return [Math.min(...g.map((x) => x.start)), Math.max(...g.map((x) => x.end as number))];
    const fs = parts.filter((o) => o.file.video_id === v);
    if (!fs.length) return null;
    return [Math.min(...fs.map((o) => o.file.start_frame / o.file.fps)), Math.max(...fs.map((o) => o.file.end_frame / o.file.fps))];
  };
  const evVideo = (e: MatchEvent) => e.video_id ?? "v1";
  const total = new Map<string, number | null>();
  for (const o of parts)
    for (const p of o.file.people) if (clean(p.player_id) && (p.team === "own" || p.team === "opp")) total.set(keyOf(p.team, p.player_id), 0);
  for (const period of periods) {
    const vids = [...periodOf].filter(([, p]) => p === period).map(([v]) => v).sort((a, b) => num(a) - num(b));
    // Where each video starts on the clock of the half, and the length of the half.
    const offset = new Map<string, number>();
    let len = 0;
    for (const v of vids) {
      const b = bounds(v);
      if (!b) continue;
      offset.set(v, len - b[0]);
      len += b[1] - b[0];
    }
    if (len <= 0) continue;
    // Starters: named people with a position in the first clip of the half.
    const first = parts.filter((o) => o.file.video_id === vids[0]).sort((a, b) => a.file.start_frame - b.file.start_frame)[0];
    const starters = new Set<string>();
    if (first) {
      const seen = new Set<number>();
      for (const fr of first.file.frames) for (const q of fr.positions) seen.add(q.id);
      for (const p of first.file.people) if (seen.has(p.id) && clean(p.player_id) && (p.team === "own" || p.team === "opp")) starters.add(keyOf(p.team, p.player_id));
    }
    type Move = { t: number; key: string; on: boolean };
    const moves: Move[] = [];
    for (const e of events) {
      if ((e.team !== "own" && e.team !== "opp") || periodOf.get(evVideo(e)) !== period) continue;
      const off = offset.get(evVideo(e));
      if (off === undefined) continue;
      const t = Math.min(len, Math.max(0, e.t_video + off));
      if (e.type === "substitution") {
        if (clean(e.player_id)) moves.push({ t, key: keyOf(e.team, e.player_id), on: false });
        if (clean(e.player_in)) moves.push({ t, key: keyOf(e.team, e.player_in), on: true });
      } else if (e.type === "foul" && e.detail === "red" && clean(e.player_id)) moves.push({ t, key: keyOf(e.team, e.player_id), on: false });
    }
    moves.sort((a, b) => a.t - b.t);
    for (const key of [...total.keys()]) {
      const prev = total.get(key);
      if (prev === null || prev === undefined) continue;
      const mine = moves.filter((m) => m.key === key);
      const starter = starters.has(key);
      if (!starter && !mine.some((m) => m.on)) {
        // Nothing says she was on the pitch in this half (not in its first clip, no entry tagged): unknown, not guessed.
        total.set(key, null);
        continue;
      }
      let on = starter;
      let since = 0;
      let sum = 0;
      for (const m of mine) {
        if (m.on && !on) {
          on = true;
          since = m.t;
        } else if (!m.on && on) {
          on = false;
          sum += m.t - since;
        }
      }
      if (on) sum += len - since;
      total.set(key, prev + sum);
    }
  }
  const out = new Map<string, number | null>();
  for (const [k, v] of total) out.set(k, v === null ? null : Math.round((v / 60) * 10) / 10);
  return out;
}

// --------------------------------------------------------------------------------------------- what is compared

export interface Metric {
  key: keyof PlayerRow | "pass_pct" | "duel_pct";
  label: string;
  group: "Ataque" | "Con balón" | "Defensa" | "Físico";
  // Lower is better (losses, fouls): the bar of the best is still the longest, the text says which way it reads.
  lower?: boolean;
  unit?: string;
  // Can be shown per 10 minutes measured (counts, not ratios or speeds).
  rate?: boolean;
  // Counted from the tagged events.
  tagged?: boolean;
}

export const METRICS: Metric[] = [
  { key: "goals", label: "Goles", group: "Ataque", rate: true, tagged: true },
  { key: "shots", label: "Tiros", group: "Ataque", rate: true, tagged: true },
  { key: "on_target", label: "Tiros a puerta", group: "Ataque", rate: true, tagged: true },
  { key: "key_passes", label: "Pases clave", group: "Ataque", rate: true, tagged: true },
  { key: "crosses", label: "Centros", group: "Ataque", rate: true, tagged: true },
  { key: "box_entries", label: "Entradas al área", group: "Ataque", rate: true, tagged: true },
  { key: "touches", label: "Toques", group: "Con balón", rate: true },
  { key: "passes", label: "Pases completos", group: "Con balón", rate: true },
  { key: "pass_pct", label: "% pases completos", group: "Con balón", unit: "%" },
  { key: "progressive", label: "Pases progresivos", group: "Con balón", rate: true },
  { key: "recoveries", label: "Recuperaciones", group: "Defensa", rate: true, tagged: true },
  { key: "losses", label: "Pérdidas", group: "Defensa", lower: true, rate: true, tagged: true },
  { key: "duels_won", label: "Duelos ganados", group: "Defensa", rate: true, tagged: true },
  { key: "duel_pct", label: "% duelos ganados", group: "Defensa", unit: "%", tagged: true },
  { key: "fouls", label: "Faltas", group: "Defensa", lower: true, rate: true, tagged: true },
  { key: "minutes_played", label: "Minutos jugados", group: "Físico", unit: "min" },
  { key: "minutes", label: "Tiempo visto", group: "Físico", unit: "min" },
  { key: "distance_m", label: "Distancia", group: "Físico", unit: "m", rate: true },
  { key: "per_min_m", label: "Metros por minuto", group: "Físico", unit: "m/min" },
  { key: "top_kmh", label: "Velocidad máxima", group: "Físico", unit: "km/h" },
  { key: "hsr_m", label: "HSR (>18 km/h)", group: "Físico", unit: "m", rate: true },
  { key: "sprints", label: "Sprints", group: "Físico", rate: true },
  { key: "fill_dist_pct", label: "Distancia de relleno", group: "Físico", unit: "%" },
];

// The value of a metric for a player; per 10 minutes measured when asked and the metric allows it (needs minutes).
// Null: not measured for her (or a share with nothing to divide).
export function metricValue(r: PlayerRow, m: Metric, per10 = false): number | null {
  if (m.tagged && !r.tagged) return null;
  let v: number | null;
  if (m.key === "pass_pct") v = r.passes !== null && r.passes_cut !== null && r.passes + r.passes_cut > 0 ? Math.round((100 * r.passes) / (r.passes + r.passes_cut)) : null;
  else if (m.key === "duel_pct") v = r.duels_won + r.duels_lost > 0 ? Math.round((100 * r.duels_won) / (r.duels_won + r.duels_lost)) : null;
  else v = r[m.key] as number | null;
  if (v === null || !per10 || !m.rate) return v;
  if (!r.minutes) return null;
  return Math.round((v / r.minutes) * 10 * 10) / 10;
}

// Metrics worth a row for these players: at least one of them has a value above 0.
export function shownMetrics(rows: PlayerRow[], per10 = false): Metric[] {
  return METRICS.filter((m) => rows.some((r) => (metricValue(r, m, per10) ?? 0) > 0));
}

export const MAX_COMPARE = 4;
