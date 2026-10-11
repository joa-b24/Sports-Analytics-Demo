import type { SessionRow } from "./types";

// Training load from the post-training questionnaire: session load (sRPE) = RPE x minutes, and the
// acute:chronic workload ratio (ACWR) per player. Pure functions over plain arrays.

export const ACUTE_DAYS = 7;
export const CHRONIC_DAYS = 28;
// Usual reference band for the ratio. A guide for the staff, not a medical threshold.
export const SAFE_ACWR: [number, number] = [0.8, 1.3];

// Pre-training questionnaire scales, as the staff's form defines them. `worseHigh`: a higher answer is a worse state.
export const WELLNESS: { key: string; label: string; max: number; worseHigh: boolean }[] = [
  { key: "sleep_q", label: "Sueño", max: 7, worseHigh: true },
  { key: "stress", label: "Estrés", max: 7, worseHigh: true },
  { key: "fatigue", label: "Fatiga", max: 7, worseHigh: true },
  { key: "soreness", label: "Dolor muscular", max: 7, worseHigh: true },
  { key: "energy", label: "Energía", max: 10, worseHigh: false },
];

// Health answers that must not enter this app while it has no accounts or permissions: illness, menstrual period,
// mood and free-text complaints. Matched on the column name of the uploaded CSV.
const SENSITIVE = /(ill|sick|enferm|period|menstr|ciclo|mood|animo|ánimo|molest|discomfort|injur|lesi)/i;
export const isSensitiveColumn = (name: string) => SENSITIVE.test(name);

const DAY = 86400000;
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface LoadRow {
  date: string;
  session_id: string;
  player_id: string;
  rpe: number | null;
  duration_min: number | null;
  // "own": the player's row has it. "session": taken from the other players of the same session (their median).
  durationFrom: "own" | "session" | null;
  // Null when RPE or duration is missing: never estimated.
  load: number | null;
}

export function sessionLoads(sessions: SessionRow[]): LoadRow[] {
  const durations = new Map<string, number[]>();
  for (const s of sessions) {
    const d = s.metrics.duration_min;
    if (d === null || d === undefined || !(d > 0)) continue;
    const key = `${s.date}|${s.session_id}`;
    durations.set(key, [...(durations.get(key) ?? []), d]);
  }
  return sessions.map((s) => {
    const rpe = s.metrics.rpe ?? null;
    const own = s.metrics.duration_min ?? null;
    const shared = own !== null && own > 0 ? null : median(durations.get(`${s.date}|${s.session_id}`) ?? []);
    const duration = own !== null && own > 0 ? own : shared;
    return {
      date: s.date,
      session_id: s.session_id,
      player_id: s.player_id,
      rpe,
      duration_min: duration,
      durationFrom: own !== null && own > 0 ? "own" : shared !== null ? "session" : null,
      load: rpe !== null && duration !== null ? rpe * duration : null,
    };
  });
}

export interface Acwr {
  player_id: string;
  // Sum of the last 7 days.
  acute: number;
  // Weekly mean of the last 28 days.
  chronic: number;
  // Null until the history reaches the fourth week (first load at least 21 days back): before that the ratio means nothing.
  ratio: number | null;
  // Days between the player's first load and the reference date.
  historyDays: number;
}

// Ratio of each player on `asOf` (default: the last date with a load).
export function acwr(rows: LoadRow[], asOf?: string): { asOf: string | null; players: Acwr[] } {
  const loads = rows.filter((r): r is LoadRow & { load: number } => r.load !== null);
  if (loads.length === 0) return { asOf: null, players: [] };
  const ref = asOf ?? loads.reduce((m, r) => (r.date > m ? r.date : m), loads[0].date);
  const d0 = dayNumber(ref);
  const byPlayer = new Map<string, { acute: number; total: number; first: number }>();
  for (const r of loads) {
    const age = d0 - dayNumber(r.date);
    if (age < 0) continue;
    const p = byPlayer.get(r.player_id) ?? { acute: 0, total: 0, first: age };
    p.first = Math.max(p.first, age);
    if (age < CHRONIC_DAYS) p.total += r.load;
    if (age < ACUTE_DAYS) p.acute += r.load;
    byPlayer.set(r.player_id, p);
  }
  const players = [...byPlayer.entries()]
    .map(([player_id, p]) => {
      const chronic = p.total / (CHRONIC_DAYS / ACUTE_DAYS);
      return { player_id, acute: p.acute, chronic, ratio: p.first >= CHRONIC_DAYS - ACUTE_DAYS && chronic > 0 ? p.acute / chronic : null, historyDays: p.first };
    })
    .sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.player_id.localeCompare(b.player_id));
  return { asOf: ref, players };
}
