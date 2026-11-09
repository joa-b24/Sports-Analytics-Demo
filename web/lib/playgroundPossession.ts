// Playground > Posesión: logic of the check (parameters, filters, review sample, the analyst's verdicts, the scene of an
// interval). Pure functions, no file access; the interval table itself comes from lib/possession.ts.
import { partFor, positionsAt, type Dot, type Oriented } from "./positions.ts";
import {
  POSSESSION_DEFAULTS, type BallSrc, type Lab, type PossessionKind, type PossessionParams, type PossessionResult, type PossessionRow, type PossessionTeam, type Suspect, type TeamSeconds,
} from "./possession.ts";

// ------------------------------------------------------------------------------------------------- parameters
export interface ParamField {
  key: keyof PossessionParams;
  label: string;
  unit: "m" | "s" | "m/s";
  min: number;
  max: number;
  step: number;
  help: string;
  advanced?: boolean;
}
export const PARAM_FIELDS: ParamField[] = [
  { key: "controlM", label: "Distancia de control", unit: "m", min: 0.5, max: 5, step: 0.1, help: "Quien está más cerca del balón que esto lo toca." },
  { key: "controlS", label: "Tiempo para controlar", unit: "s", min: 0, max: 3, step: 0.1, help: "Toques seguidos de un equipo que hacen falta para contar un control." },
  { key: "maxCtrlSpeedMs", label: "Velocidad máxima del balón", unit: "m/s", min: 2, max: 30, step: 0.5, help: "Un balón más rápido que esto en el control solo pasa de largo." },
  { key: "gapS", label: "Hueco tolerado en el control", unit: "s", min: 0, max: 2, step: 0.1, help: "Segundos sin toque que no cortan un control.", advanced: true },
  { key: "holdS", label: "Posesión sin nuevo control", unit: "s", min: 0, max: 15, step: 0.5, help: "Si ningún control posterior confirma el vuelo: cuánto sigue siendo del equipo tras su último toque medido, solo sobre balón medido.", advanced: true },
  { key: "restFlightMinMs", label: "Velocidad mínima de un vuelo", unit: "m/s", min: 0.5, max: 10, step: 0.5, help: "Entre dos posiciones medidas del balón, un hueco más lento que esto (en línea recta) es una pausa del juego, no un vuelo.", advanced: true },
  { key: "stillRadiusM", label: "Radio del balón quieto", unit: "m", min: 0.2, max: 5, step: 0.1, help: "Un balón que no sale de este radio durante el tiempo de abajo está muerto aunque haya una jugadora al lado (reanudaciones).", advanced: true },
  { key: "stillS", label: "Tiempo del balón quieto", unit: "s", min: 1, max: 30, step: 0.5, help: "Cuánto debe estar quieto para contarlo como pausa.", advanced: true },
  { key: "restGapS", label: "Hueco mínimo para una pausa", unit: "s", min: 0.5, max: 10, step: 0.5, help: "Huecos del balón medido más cortos que esto nunca son una reanudación.", advanced: true },
  { key: "contestedHoldS", label: "Balón disputado", unit: "s", min: 0, max: 8, step: 0.5, help: "Cuánto conserva la posesión el anterior dueño en una disputa.", advanced: true },
  { key: "contestMarginM", label: "Margen de disputa", unit: "m", min: 0, max: 3, step: 0.1, help: "Dos equipos así de cerca del balón lo disputan.", advanced: true },
  { key: "restSpeedMs", label: "Velocidad de balón quieto", unit: "m/s", min: 0.1, max: 3, step: 0.1, help: "Por debajo de esto el balón está en reposo.", advanced: true },
  { key: "restS", label: "Tiempo para balón muerto", unit: "s", min: 0.5, max: 8, step: 0.5, help: "Reposo con nadie cerca durante este tiempo corta la posesión.", advanced: true },
  { key: "joinCutMaxM", label: "Unir cortes si el balón se movió menos de", unit: "m", min: 0, max: 60, step: 1, help: "Entre tramos de juego, el balón se sigue si no se fue más lejos.", advanced: true },
];
export const paramChanged = (p: PossessionParams, key: keyof PossessionParams) => p[key] !== POSSESSION_DEFAULTS[key];
export const changedParams = (p: PossessionParams): string[] => PARAM_FIELDS.filter((f) => paramChanged(p, f.key)).map((f) => f.key);

// A typed value inside the limits of its field (NaN or empty: the previous one).
export function clampParam(f: ParamField, raw: number, prev: number): number {
  if (!Number.isFinite(raw)) return prev;
  return Math.min(f.max, Math.max(f.min, raw));
}

// ------------------------------------------------------------------------------------------------- table filters
export interface RowFilter {
  team: PossessionTeam | "all";
  kind: PossessionKind | "all";
  source: BallSrc | "mixed" | "all";
  interp: "all" | "yes" | "no";
  // Only intervals longer than this many seconds (null: any length).
  minDur: number | null;
}
export const NO_FILTER: RowFilter = { team: "all", kind: "all", source: "all", interp: "all", minDur: null };
export const rowDuration = (r: Pick<PossessionRow, "t_start" | "t_end">) => r.t_end - r.t_start;
// Text of the «mayor a X s» field to a filter value: empty or not a positive number means no filter.
export const parseMinDur = (text: string): number | null => {
  const n = Number(text.replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};
export const isFiltered = (f: RowFilter) => f.team !== "all" || f.kind !== "all" || f.source !== "all" || f.interp !== "all" || f.minDur !== null;
export const filterRows = (rows: PossessionRow[], f: RowFilter): PossessionRow[] =>
  rows.filter(
    (r) =>
      (f.team === "all" || r.team === f.team) &&
      (f.kind === "all" || r.kind === f.kind) &&
      (f.source === "all" || r.flags.ball_source === f.source) &&
      (f.interp === "all" || (f.interp === "yes") === r.flags.ball_interp) &&
      (f.minDur === null || rowDuration(r) > f.minDur),
  );

export const TEAM_LABEL: Record<PossessionTeam, string> = { own: "Nuestro equipo", opp: "Rival", none: "Sin dueño" };
export const KIND_LABEL: Record<PossessionKind, string> = { control: "Control", contested: "Disputado", loose: "Suelto", dead: "Muerto", unknown: "Sin certeza" };
export const SRC_LABEL: Record<BallSrc | "mixed", string> = { manual: "A mano", auto: "Tracker", event: "Evento", interp: "Interpolado", mixed: "Mezclado" };
export const NOTE_LABEL: Record<string, string> = {
  joined_cut: "corte unido",
  cut_reset: "corte: reinicia",
  blocked: "caja bloqueante",
  ball_jump: "salto del balón",
  no_measured_touch: "sin toque medido",
  flight: "balón en vuelo",
  rest: "en reposo",
  out: "fuera",
  no_players: "sin jugadoras",
  short_touch: "toque corto",
  restart_gap: "pausa: balón no visto",
  flight_confirmed: "vuelo confirmado por el siguiente control",
  flight_lost: "vuelo perdido: el siguiente control es del otro equipo",
  hold_measured: "posesión tras el último toque medido",
};

// ------------------------------------------------------------------------------------------------- review sample
export const rowId = (r: PossessionRow) => `${r.video_id}|${(Math.round(r.t_start * 100) / 100).toFixed(2)}|${r.team}|${r.kind}`;
export const stratumOf = (r: PossessionRow) => `${r.team}|${r.kind}|${r.flags.ball_source}`;

// A spread of `n` intervals to review: one pick at a time from each team / kind / ball source group in turn, and inside
// a group evenly through the match (not the first ones). Deterministic. Intervals under minS are skipped (they cannot be
// told apart on the video); the ones already reviewed too.
export function reviewSample(rows: PossessionRow[], n: number, done: Set<string> = new Set(), minS = 0.5): PossessionRow[] {
  const groups = new Map<string, PossessionRow[]>();
  for (const r of [...rows].sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_start - b.t_start)) {
    if (r.t_end - r.t_start < minS || done.has(rowId(r))) continue;
    const k = stratumOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const keys = [...groups.keys()].sort();
  // Each group spreads its picks evenly: the j-th pick of a group of m takes the item at (j + 0.5) / total share.
  const out: PossessionRow[] = [];
  const total = [...groups.values()].reduce((a, g) => a + g.length, 0);
  const want = Math.min(n, total);
  const quota = new Map<string, number>();
  // Quota by round robin: no group gets more than it has.
  let left = want;
  while (left > 0) {
    let moved = false;
    for (const k of keys) {
      if (left === 0) break;
      if ((quota.get(k) ?? 0) < (groups.get(k) as PossessionRow[]).length) {
        quota.set(k, (quota.get(k) ?? 0) + 1);
        left--;
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const k of keys) {
    const g = groups.get(k) as PossessionRow[];
    const q = quota.get(k) ?? 0;
    for (let j = 0; j < q; j++) {
      out.push(g[Math.min(g.length - 1, Math.floor(((j + 0.5) * g.length) / q))]);
    }
  }
  return out.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_start - b.t_start);
}

// ------------------------------------------------------------------------------------------------- verdicts
export type Verdict = "correct" | "incorrect";
export interface Review {
  id: string;
  video_id: string;
  t_start: number;
  t_end: number;
  team: PossessionTeam;
  kind: PossessionKind;
  verdict: Verdict;
  note: string;
  at: string;
}
export interface ReviewFile {
  kind: "possession_review";
  video_id: string;
  // The parameters under which the verdicts were given: they are about intervals that exist only with them.
  params: PossessionParams;
  reviews: Review[];
}
export const reviewPath = (folder: string, videoId: string) => `matches/${folder}/possession_review_${videoId}.json`;
export const emptyReview = (videoId: string, params: PossessionParams = POSSESSION_DEFAULTS): ReviewFile => ({ kind: "possession_review", video_id: videoId, params, reviews: [] });

export function parseReview(text: string | null, videoId: string): ReviewFile {
  try {
    const d = JSON.parse(text ?? "null") as ReviewFile | null;
    if (d && d.kind === "possession_review" && Array.isArray(d.reviews)) {
      const reviews = d.reviews.filter((r) => r && typeof r.id === "string" && (r.verdict === "correct" || r.verdict === "incorrect"));
      return { kind: "possession_review", video_id: videoId, params: { ...POSSESSION_DEFAULTS, ...(d.params ?? {}) }, reviews };
    }
  } catch {
    // Unreadable: starts empty rather than guessing.
  }
  return emptyReview(videoId);
}

// Marks the interval; marking it again with the same verdict and no note clears it.
export function setVerdict(f: ReviewFile, r: PossessionRow, verdict: Verdict | null, note: string, params: PossessionParams, at = new Date().toISOString()): ReviewFile {
  const id = rowId(r);
  const rest = f.reviews.filter((x) => x.id !== id);
  if (verdict === null) return { ...f, params, reviews: rest };
  const entry: Review = { id, video_id: r.video_id, t_start: r.t_start, t_end: r.t_end, team: r.team, kind: r.kind, verdict, note: note.trim(), at };
  return { ...f, params, reviews: [...rest, entry].sort((a, b) => a.t_start - b.t_start) };
}
export const reviewOf = (f: ReviewFile | undefined, r: PossessionRow): Review | null => f?.reviews.find((x) => x.id === rowId(r)) ?? null;

export interface ReviewStats {
  reviewed: number;
  correct: number;
  incorrect: number;
  accuracy: number | null; // correct / reviewed; null with nothing reviewed
  // Of the reviewed ones, those that still exist in the current table (the parameters may have changed since).
  current: number;
}
export function reviewStats(reviews: Review[], rows: PossessionRow[]): ReviewStats {
  const ids = new Set(rows.map(rowId));
  const correct = reviews.filter((r) => r.verdict === "correct").length;
  return {
    reviewed: reviews.length,
    correct,
    incorrect: reviews.length - correct,
    accuracy: reviews.length > 0 ? correct / reviews.length : null,
    current: reviews.filter((r) => ids.has(r.id)).length,
  };
}

// ------------------------------------------------------------------------------------------------- scene of an interval
export interface Scene {
  t: number; // video second shown
  dots: Dot[];
  ball: [number, number] | null;
  // The box the table gives the interval (holder, or blocker when the interval is "blocked"), when it is in the part.
  owner: { id: number; role: "holder" | "blocker"; name: string | null; team: string; distance: number | null } | null;
  view: [number, number][] | null;
}

// What to draw for an interval: the instant of its sample that has a deciding box nearest to the middle, the people of
// that part at that instant, the ball and the box that decided. Null when no processed part covers the interval.
export function sceneAt(result: PossessionResult, parts: Oriented[], row: PossessionRow): Scene | null {
  const mid = (row.t_start + row.t_end) / 2;
  const inside = result.samples.filter((s) => s.video_id === row.video_id && s.t0 >= row.t_start - 1e-6 && s.t1 <= row.t_end + 1e-6);
  const withOwner = inside.filter((s) => s.owner);
  const pick = (withOwner.length ? withOwner : inside).reduce<(typeof inside)[number] | null>((b, s) => (b === null || Math.abs(s.t0 - mid) < Math.abs(b.t0 - mid) ? s : b), null);
  const t = pick ? pick.t0 : mid;
  const o = partFor(parts, row.video_id, t, t + 1e-3);
  if (!o) return null;
  const at = positionsAt(o, t);
  if (!at) return null;
  let owner: Scene["owner"] = null;
  if (pick?.owner) {
    const [, partStr, idStr] = pick.owner.split("|");
    const id = Number(idStr);
    const dot = at.players.find((d) => d.id === id);
    if (Number(partStr) === o.file.start_frame && dot) {
      const person = o.file.people.find((p) => p.id === id);
      owner = {
        id,
        role: pick.notes.includes("blocked") ? "blocker" : "holder",
        name: person?.player_id ?? null,
        team: dot.team,
        distance: at.ball ? Math.hypot(dot.x - at.ball[0], dot.y - at.ball[1]) : null,
      };
    }
  }
  return { t, dots: at.players, ball: at.ball, owner, view: at.view };
}

// ------------------------------------------------------------------------------------------------- suspect boxes
export const SUSPECT_LABEL: Record<Suspect["reason"], string> = {
  opp_like_own: "Rival que se viste como nosotras",
  staff_as_team: "Posible cuerpo técnico o banca",
  unk_near_ball: "Caja sin equipo junto al balón",
  contested_pair: "Duda: dos cajas igual de cerca",
};
const sgn = (v: number) => `${v > 0 ? "+" : ""}${v.toLocaleString("es-MX", { maximumFractionDigits: 1 })} s`;
const AS: Record<string, string> = { own: "nuestra", opp: "rival", none: "quitada" };
// «Si fuera nuestra: nuestro +2.1 s, rival -2.1 s» for each change the suspect carries.
export function effectText(effect: Suspect["effect_if"], reason?: Suspect["reason"]): string[] {
  if (reason === "contested_pair")
    return (Object.entries(effect) as [string, TeamSeconds][]).map(([as, d]) => `Si gana la caja ${as === "own" ? "nuestra" : "rival"}: nuestro ${sgn(d.own)}, rival ${sgn(d.opp)}, sin dueño ${sgn(d.none)}`);
  return (Object.entries(effect) as [string, TeamSeconds][]).map(([as, d]) => `Si fuera ${AS[as]}: nuestro ${sgn(d.own)}, rival ${sgn(d.opp)}, sin dueño ${sgn(d.none)}`);
}

// Typical shirt colour of a team over several parts (Lab, median of the parts that have one).
export function medianLab(labs: (Lab | null | undefined)[]): Lab | null {
  const ok = labs.filter((l): l is Lab => !!l);
  if (ok.length === 0) return null;
  const med = (i: number) => {
    const v = ok.map((l) => l[i]).sort((a, b) => a - b);
    return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  };
  return [med(0), med(1), med(2)];
}


// ------------------------------------------------------------------------------------------------- loop of one interval
export const LOOP_MARGIN_MAX = 5;
export const clampMargin = (m: number) => (Number.isFinite(m) ? Math.min(LOOP_MARGIN_MAX, Math.max(0, m)) : 0);

// The stretch of video to repeat: [t_start - margin, t_end + margin], not before 0 nor after the end of the video when
// it is known (duration 0 or null = unknown). Null when nothing would be left to play.
export function loopWindow(t0: number, t1: number, margin: number, duration: number | null = null): { start: number; end: number } | null {
  const m = clampMargin(margin);
  const start = Math.max(0, t0 - m);
  const end = duration && duration > 0 ? Math.min(duration, t1 + m) : t1 + m;
  return end - start > 0.05 ? { start, end } : null;
}
// What the loop does at video second t: go back to the start once the end is reached (or when the video ran on past
// the stretch by more than `slack`, e.g. after a seek made while the tick was waiting); null while it is inside.
export function loopSeek(t: number, win: { start: number; end: number }, slack = 0.6): number | null {
  if (t >= win.end - 0.05) return win.start;
  if (t > win.end + slack) return win.start;
  return null;
}

// ------------------------------------------------------------------------------------------------- panel sizes
// Sizes of the panels as fractions that add up to 1 (or the first of two): kept in a preference as text.
export const MIN_PANEL = 0.12;
export const clampFrac = (f: number, min = MIN_PANEL, max = 1 - MIN_PANEL) => Math.min(max, Math.max(min, f));
export function parseFracs(text: string, n: number, fallback: number[]): number[] {
  const v = text.split(",").map(Number);
  if (v.length !== n || v.some((x) => !Number.isFinite(x) || x < MIN_PANEL * 0.99) || Math.abs(v.reduce((a, b) => a + b, 0) - 1) > 0.01) return fallback;
  return v;
}
export const formatFracs = (v: number[]) => v.map((x) => x.toFixed(4)).join(",");
// Moves divider `i` (between panel i and i+1) to `delta` of the whole, keeping every panel at least MIN_PANEL wide.
export function dragDivider(v: number[], i: number, delta: number): number[] {
  const pair = v[i] + v[i + 1];
  const a = Math.min(pair - MIN_PANEL, Math.max(MIN_PANEL, v[i] + delta));
  const out = v.slice();
  out[i] = a;
  out[i + 1] = pair - a;
  return out;
}

// ------------------------------------------------------------------------------------------------- ball at both ends
// Where the ball is when the interval starts and when it ends (null: no processed part, or no ball measured there).
export function ballEnds(parts: Oriented[], row: PossessionRow): { start: [number, number] | null; end: [number, number] | null } {
  const at = (t: number) => {
    const o = partFor(parts, row.video_id, t, t + 1e-3);
    return o ? (positionsAt(o, t)?.ball ?? null) : null;
  };
  return { start: at(row.t_start), end: at(Math.max(row.t_start, row.t_end - 0.05)) };
}
// Exact times with a decimal: 0:12:03.4
export const fmtTd = (sec: number) => {
  const d = Math.round(Math.max(0, sec) * 10);
  const h = Math.floor(d / 36000);
  const m = Math.floor((d % 36000) / 600);
  const r = (d % 600) / 10;
  return `${h}:${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
};
