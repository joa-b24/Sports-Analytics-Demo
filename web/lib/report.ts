// Everything the report draws, computed from the data of a match: a JSON-serialisable ReportData. ReportTab only
// draws it, and "Exportar datos del reporte" saves it as report_<match_id>.json (the static viewer will open that file
// without the app). Pure functions: no storage, no React.
//
// The report adapts to the data there is, by levels:
//   N1  tagged events
//   N2  + ball followed by hand                          possession, passes, touches (inferred)
//   N3  + tracking reviewed (big holes interpolated)     positions, team shape, players behind the ball
//   N4  + tracking fully corrected (players named)       pass network and touches by player
// A section without its level is not drawn empty: it says what it needs. Nothing missing is filled with an average
// or a guess, and every inferred figure carries the share of play time it was measured on.
//
// In a "rival" match the `own` team of the data is the team being studied (focus_team), not ours: the report always
// speaks of "equipo analizado" and "contrario".
import {
  SHOT_WINDOW_S,
  boxEntries,
  crosses as crossTally,
  finalThirdEntries,
  goalKicks,
  playTime,
  setPieces as setPieceTallies,
  shotBreakdown,
  timeBins,
  transitionMoments,
  transitions,
  type Rate,
  type Tally,
  type TimeBins,
  type TransitionMoment,
} from "./analysis.ts";
import { fmtT, youtubeLink } from "./format.ts";
import { BALL_FILL_S } from "./parts.ts";
import type { Oriented } from "./positions.ts";
import type { Segment } from "./segments.ts";
import { LANES_5, THIRDS_3, countByType, laneThirdOf, zoneGrid5x3 } from "./stats.ts";
import { EMPTY_REPORT, type ManualResult, type Match, type MatchEvent, type Play, type Report, type RosterPlayer } from "./types.ts";
import { matchTimeline, matchVideos, videoOf } from "./videos.ts";

type Side = "own" | "opp";

export const REPORT_VERSION = 1;

// --------------------------------------------------------------------------------------------- saved reports

// A report saved before a field existed opens with its default; a field of the wrong type is taken as missing.
export function normalizeReport(r: Partial<Report> | null | undefined): Report {
  const src = (r ?? {}) as Record<string, unknown>;
  const text = (k: keyof Report) => (typeof src[k] === "string" ? (src[k] as string) : "");
  const results = Array.isArray(src.results_manual) ? (src.results_manual as unknown[]) : [];
  return {
    ...EMPTY_REPORT,
    resumen: text("resumen"),
    fortalezas: text("fortalezas"),
    debilidades: text("debilidades"),
    balon_parado: text("balon_parado"),
    jugadoras_clave: text("jugadoras_clave"),
    plan: text("plan"),
    conclusiones: text("conclusiones"),
    jornada: text("jornada"),
    results_manual: results.filter((x): x is ManualResult => !!x && typeof x === "object").map((x) => ({
      date: typeof x.date === "string" ? x.date : "",
      opponent: typeof x.opponent === "string" ? x.opponent : "",
      home: x.home === true,
      // A result without its goals is kept as written (NaN) and left out of the recent results, never taken as 0.
      goals_for: Number.isFinite(x.goals_for) ? x.goals_for : NaN,
      goals_against: Number.isFinite(x.goals_against) ? x.goals_against : NaN,
      competition: typeof x.competition === "string" ? x.competition : "",
    })),
  };
}

// --------------------------------------------------------------------------------------------- data level

export type Level = 0 | 1 | 2 | 3 | 4;
export const LEVEL_NAMES: Record<Exclude<Level, 0>, string> = {
  1: "eventos etiquetados",
  2: "balón seguido",
  3: "tracking revisado",
  4: "tracking completo corregido",
};
// There is no minimum coverage: a source counts as soon as there is some, and every figure that comes from it says on
// how much of the play time it was measured. The level is only a summary for the cover.

export interface Coverage {
  seconds: number;
  // Of the play time. Null when no play stretch is marked: then it cannot be said.
  share: number | null;
}

export interface LevelInfo {
  level: Level;
  events: number;
  // Play time from the "juego" stretches of every video (s). Null: none marked.
  play_s: number | null;
  ball: Coverage;
  tracking: Coverage;
  // Share of the positions of the analysed team, in the reviewed parts, that belong to a named player.
  named_share: number | null;
  // Which sources there are. Each section asks for its own, not for a level.
  sources: { events: boolean; ball: boolean; tracking: boolean; names: boolean };
  // "Nivel de datos: N2 · balón seguido en 64 % del tiempo de juego"
  label: string;
  // What is missing for the next level, in plain words.
  next: string | null;
}

const pct = (share: number) => `${Math.round(share * 100)} %`;

// Seconds of the "juego" stretches of one video that fall inside [t0, t1).
function playInside(segments: Segment[], t0: number, t1: number): number {
  let s = 0;
  for (const g of segments) {
    if (g.tipo !== "juego") continue;
    const a = Math.max(g.start, t0);
    const b = Math.min(g.end ?? Infinity, t1);
    if (b > a) s += b - a;
  }
  return s;
}
// Coverage is counted on a grid of COVER_STEP_S per video, so a stretch covered by two files (a joined export and its
// parts, say) counts once. Only inside closed play stretches when there are any: an open last stretch has no length.
export const COVER_STEP_S = 0.5;
function addSpan(cells: Set<string>, video: string, t0: number, t1: number, play: Segment[] | null) {
  for (let k = Math.floor(t0 / COVER_STEP_S); k * COVER_STEP_S < t1; k++) {
    const mid = (k + 0.5) * COVER_STEP_S;
    if (play && !play.some((g) => mid >= g.start && mid < (g.end as number))) continue;
    cells.add(`${video}|${k}`);
  }
}

// Where the ball is followed in a part: each processed frame holding a hand mark, or a position joined to a hand mark
// less than BALL_FILL_S away, covers the time until the next processed frame. Ball positions taken only from tagged
// events do not count: every part has those.
function addBallFollowed(cells: Set<string>, o: Oriented, play: Segment[] | null) {
  const f = o.file;
  const manual = f.ball.filter((b) => b.source === "manual").map((b) => b.frame).sort((a, b) => a - b);
  if (manual.length === 0) return;
  const near = (frame: number) => {
    let lo = 0;
    let hi = manual.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (manual[mid] < frame) lo = mid + 1;
      else hi = mid;
    }
    const d = Math.min(Math.abs(manual[lo] - frame), lo > 0 ? Math.abs(manual[lo - 1] - frame) : Infinity);
    return d / f.fps <= BALL_FILL_S;
  };
  const step = Math.max(1, f.stride) / f.fps;
  for (const b of f.ball) if (b.source === "manual" || near(b.frame)) addSpan(cells, f.video_id, b.frame / f.fps, b.frame / f.fps + step, play);
}

export function dataLevel(events: MatchEvent[], segmentsByVideo: Record<string, Segment[]>, parts: Oriented[]): LevelInfo {
  const closed = (v: string) => (segmentsByVideo[v] ?? []).filter((g) => g.tipo === "juego" && g.end !== null);
  const hasPlay = Object.keys(segmentsByVideo).some((v) => closed(v).length > 0);
  const play_s = hasPlay ? Object.keys(segmentsByVideo).reduce((s, v) => s + playInside(closed(v), 0, Infinity), 0) : null;
  const share = (seconds: number) => (play_s ? Math.min(1, seconds / play_s) : null);

  const ballCells = new Set<string>();
  const trackCells = new Set<string>();
  let ownSeen = 0;
  let ownNamed = 0;
  for (const o of parts) {
    const play = hasPlay ? closed(o.file.video_id) : null;
    addBallFollowed(ballCells, o, play);
    // Reviewed: exported from the correction table (not built from an uncorrected part) and with players of a team in
    // it. A file exported only for its ball has no reviewed positions.
    const reviewed = !o.file.auto && o.file.frames.length > 0 && o.file.people.some((p) => p.team === "own" || p.team === "opp");
    if (!reviewed) continue;
    addSpan(trackCells, o.file.video_id, o.file.start_frame / o.file.fps, o.file.end_frame / o.file.fps, play);
    const named = new Set(o.file.people.filter((p) => p.team === "own" && p.player_id).map((p) => p.id));
    const own = new Set(o.file.people.filter((p) => p.team === "own").map((p) => p.id));
    for (const fr of o.file.frames)
      for (const q of fr.positions) {
        if (q.source === "interpolated" || !own.has(q.id)) continue;
        ownSeen++;
        if (named.has(q.id)) ownNamed++;
      }
  }
  const ballS = ballCells.size * COVER_STEP_S;
  const trackS = trackCells.size * COVER_STEP_S;
  const ball: Coverage = { seconds: ballS, share: share(ballS) };
  const tracking: Coverage = { seconds: trackS, share: share(trackS) };
  const named_share = ownSeen > 0 ? ownNamed / ownSeen : null;

  const sources = { events: events.length > 0, ball: ball.seconds > 0, tracking: trackS > 0, names: (named_share ?? 0) > 0 };
  // The level is the last of the ladder with its source there (N3 needs N2: the ball is marked in the reviewed parts).
  const level: Level = !sources.events ? 0 : !sources.ball ? 1 : !sources.tracking ? 2 : !sources.names ? 3 : 4;
  const cover = (c: Coverage) => (c.share !== null ? pct(c.share) : `${Math.round(c.seconds / 60)} min`);
  const bits = [
    sources.ball ? `balón seguido en ${cover(ball)}` : "sin balón seguido",
    ...(sources.tracking ? [`tracking revisado en ${cover(tracking)}`] : []),
  ];
  const tail =
    level === 0
      ? "sin eventos"
      : `${bits.join(" · ")}${play_s !== null && (sources.ball || sources.tracking) ? " del tiempo de juego" : ""}${sources.names ? ` · nombre en ${pct(named_share ?? 0)} de las posiciones` : ""}`;
  const next =
    level === 0
      ? "Etiqueta eventos del partido."
      : play_s === null && (sources.ball || sources.tracking)
        ? "Marca los tramos de juego para saber qué parte del partido está medida."
        : null;
  return { level, events: events.length, play_s, ball, tracking, named_share, sources, label: `Nivel de datos: N${level} · ${tail}`, next };
}

// What a section needs. `ok` false: the report shows `need` instead (and nothing when printed).
export interface Gate {
  ok: boolean;
  need: string;
}
const NEEDS = {
  events: "Requiere eventos etiquetados",
  ball: "Requiere el balón seguido en alguna parte del partido",
  tracking: "Requiere partes del tracking revisadas en la mesa de corrección",
  names: "Requiere nombres en el tracking y el balón seguido",
} as const;
// `wip`: the source is there but the section is not built yet.
const gate = (have: boolean, need: keyof typeof NEEDS, wip?: string): Gate => ({ ok: have && !wip, need: have && wip ? wip : NEEDS[need] });

// --------------------------------------------------------------------------------------------- moments

export interface Moment {
  video_id: string;
  // Time inside its own video (s), and how it is written ("1.er tiempo 0:41:10").
  t: number;
  label: string;
  // Minute of play (1 = the first minute), from the play stretches. Null without them.
  minute: number | null;
  youtube: string | null;
  // The moment in the app's player (local video or YouTube).
  app: string;
}

// --------------------------------------------------------------------------------------------- recent results

export interface ResultRow {
  date: string;
  opponent: string;
  // Home or away. Null for app matches: the app does not record it.
  home: boolean | null;
  goals_for: number;
  goals_against: number;
  result: "V" | "E" | "D";
  competition: string;
  source: "app" | "manual";
  match_id: string | null;
}
export const RECENT_N = 5;

// Team names compared without case, accents or extra spaces.
export const sameTeam = (a: string, b: string) => {
  const n = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  return n(a) !== "" && n(a) === n(b);
};

// Score from the tagged goals: each `goal` event counts for the team it is tagged with. Assumption: an own goal is
// tagged as a goal of the team that benefits; one tagged with the team that scored it into its own net counts for
// that team, and nothing here corrects it (the event says nothing about it). Null without events.
export function scoreOf(events: MatchEvent[]): { own: number; opp: number } | null {
  if (events.length === 0) return null;
  const c = { own: countByType(events, "own").goal, opp: countByType(events, "opp").goal };
  return c;
}
const resultOf = (gf: number, ga: number): "V" | "E" | "D" => (gf > ga ? "V" : gf < ga ? "D" : "E");

// The last RECENT_N results of `team`, newest first: matches of the app where it plays (as focus_team or as
// other_team) and results written by hand. A hand result on the same date against the same opponent as an app match
// is the same match: the app one is kept. App matches without events have no result and are left out (`no_events`).
export function recentResults(
  team: string,
  library: { match: Match; events: MatchEvent[] }[],
  manual: ManualResult[],
  withDemo = false,
): { rows: ResultRow[]; total: number; no_events: number } {
  const rows: ResultRow[] = [];
  let no_events = 0;
  for (const { match: m, events } of library) {
    if (m.is_demo && !withDemo) continue;
    const asFocus = sameTeam(m.focus_team, team);
    const asOther = !asFocus && sameTeam(m.other_team, team);
    if (!asFocus && !asOther) continue;
    const score = scoreOf(events);
    if (!score) {
      no_events++;
      continue;
    }
    const gf = asFocus ? score.own : score.opp;
    const ga = asFocus ? score.opp : score.own;
    rows.push({ date: m.date, opponent: asFocus ? m.other_team : m.focus_team, home: null, goals_for: gf, goals_against: ga, result: resultOf(gf, ga), competition: "", source: "app", match_id: m.match_id });
  }
  for (const r of manual) {
    if (!Number.isFinite(r.goals_for) || !Number.isFinite(r.goals_against)) continue;
    if (rows.some((x) => x.source === "app" && x.date === r.date && sameTeam(x.opponent, r.opponent))) continue;
    rows.push({ ...r, result: resultOf(r.goals_for, r.goals_against), source: "manual", match_id: null });
  }
  // Newest first; rows without a date go last.
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (a.date ? 0 : 1) - (b.date ? 0 : 1));
  return { rows: rows.slice(0, RECENT_N), total: rows.length, no_events };
}

// --------------------------------------------------------------------------------------------- report data

export interface SummaryRow {
  key: string;
  label: string;
  own: number;
  opp: number;
  // For box entries: how many ended in a shot.
  rate?: { own: Rate; opp: Rate };
}

export interface ShotPoint {
  id: string;
  team: Side;
  x: number;
  y: number;
  goal: boolean;
  outcome: string | null;
  goal_y: number | null;
  goal_z: number | null;
  player: string | null;
  moment: Moment;
}
export interface CrossArrow {
  id: string;
  team: Side;
  x: number;
  y: number;
  x_end: number;
  y_end: number;
  outcome: string | null;
  player: string | null;
  moment: Moment;
}
export interface DuelPoint {
  id: string;
  team: Side;
  x: number;
  y: number;
  outcome: string | null;
  detail: string | null;
  player: string | null;
  moment: Moment;
}
export interface Grid {
  grid: number[][];
  missing: number;
}

export interface TransitionRow {
  id: string;
  moment: Moment;
  // "Banda izquierda · Campo propio", seen by the team of the loss or recovery. Null without position.
  zone: string | null;
  shot: Moment;
  goal: boolean;
  // Seconds from the loss or recovery to the shot.
  seconds: number;
  player: string | null;
}
export interface TeamTransitions {
  losses: TransitionRow[];
  recoveries: TransitionRow[];
  loss_to_shot: Rate;
  counterpress: Rate;
  recovery_to_shot: Rate;
}

export interface SetPieceSide {
  corners: { outcome: Tally; delivery: Tally };
  free_kicks: Tally;
  goal_kicks: { length: Tally; outcome: Tally };
  penalties: { total: number; scored: number };
}
export interface PlayRow {
  id: string;
  title: string;
  note: string;
  moment: Moment;
  end_label: string;
}

export interface ReportData {
  version: number;
  generated: string;
  anonymized: boolean;
  cover: {
    kind: Match["kind"];
    title: string;
    match_id: string;
    name: string;
    date: string;
    jornada: string;
    // Goals tagged by each team. Null without events.
    score: { own: number; opp: number } | null;
    focus_team: string;
    other_team: string;
    is_demo: boolean;
    level: LevelInfo;
  };
  results: { rows: ResultRow[]; total: number; no_events: number };
  summary: {
    rows: SummaryRow[];
    // Final-third entries without a lane: not used here.
    bins: Record<"5" | "10", TimeBins>;
    possession: Gate;
  };
  maps: {
    shots: ShotPoint[];
    shots_no_pos: number;
    crosses: CrossArrow[];
    // Crosses counted in the summary that are not on the map: no end marked (`no_end`) or no start (`no_pos`).
    crosses_no_end: Record<Side, number>;
    crosses_no_pos: Record<Side, number>;
    crosses_outcome: Record<Side, Tally>;
    // Null when the match has no duels tagged: the map is not shown.
    duels: { points: DuelPoint[]; no_pos: number; won: Record<Side, number>; lost: Record<Side, number> } | null;
    zones: { loss: Record<Side, Grid>; recovery: Record<Side, Grid> };
  };
  transitions: Record<Side, TeamTransitions>;
  set_pieces: { own: SetPieceSide; opp: SetPieceSide; plays: PlayRow[] };
  patterns: Gate;
  key_players: { touches: Gate };
  plays: PlayRow[];
  texts: {
    resumen: string;
    fortalezas: string;
    debilidades: string;
    balon_parado: string;
    jugadoras_clave: string;
    // "plan" in a report of a rival or a reference video, "conclusiones" in one of our own matches.
    closing: { key: "plan" | "conclusiones"; title: string; text: string };
  };
  method: string[];
}

export interface ReportInput {
  match: Match;
  // Events of the match, each with the time inside its own video (they are put on one axis here).
  events: MatchEvent[];
  plays: Play[];
  segmentsByVideo: Record<string, Segment[]>;
  // Corrected (tracks_fixed) or processed parts, oriented with the analysed team attacking right (lib/fixed.ts).
  parts: Oriented[];
  roster: RosterPlayer[];
  // Every match in the app with its events, for the recent results.
  library: { match: Match; events: MatchEvent[] }[];
  // Names replaced by shirt numbers, to share the report outside the staff.
  anonymize?: boolean;
  // ISO date of the report (passed in: the function stays pure).
  now?: string;
}

const isShot = (e: MatchEvent) => e.type === "shot" || e.type === "goal";
const zoneLabel = (e: MatchEvent) => {
  const z = laneThirdOf(e);
  return z ? `${LANES_5[z.lane]} · ${THIRDS_3[z.third]}` : null;
};

export const reportFileName = (match: Pick<Match, "match_id" | "folder">) => `report_${match.folder ?? match.match_id}.json`;

export function buildReport(input: ReportInput): ReportData {
  const { match, plays, segmentsByVideo, parts } = input;
  const report = normalizeReport(match.report);
  const videos = matchVideos(match);
  const label = (vid: string) => videos.find((v) => v.video_id === vid)?.label ?? vid;
  const ytOf = (vid: string) => videos.find((v) => v.video_id === vid)?.youtube_id || null;
  const raw = input.events.filter((e) => e.match_id === match.match_id && videos.some((v) => v.video_id === videoOf(e)));
  // One axis for the whole match, so that no 15-second window spans two videos; the moments keep the video times.
  const timeline = matchTimeline(videos, raw, segmentsByVideo);
  const events = timeline.events.filter((e) => e.team === "own" || e.team === "opp");
  const original = new Map(raw.map((e) => [e.event_id, e]));
  const hasPlay = timeline.segments.some((g) => g.tipo === "juego");

  const momentAt = (video_id: string, t: number): Moment => {
    const pt = hasPlay ? playTime(timeline.segments, t + (timeline.offsets[video_id] ?? 0)) : null;
    const yt = ytOf(video_id);
    return {
      video_id,
      t,
      label: videos.length > 1 ? `${label(video_id)} ${fmtT(t)}` : fmtT(t),
      minute: pt === null ? null : Math.floor(pt / 60) + 1,
      youtube: yt ? youtubeLink(yt, Math.max(0, t - 3)) : null,
      app: `/partido?id=${encodeURIComponent(match.match_id)}&video=${encodeURIComponent(video_id)}&t=${Math.max(0, Math.floor(t - 3))}`,
    };
  };
  const momentOf = (e: MatchEvent): Moment => {
    const o = original.get(e.event_id) ?? e;
    return momentAt(videoOf(o), o.t_video);
  };
  const side = (e: MatchEvent) => e.team as Side;

  const level = dataLevel(raw, segmentsByVideo, parts);
  const src = level.sources;

  // Summary.
  const own = countByType(events, "own");
  const opp = countByType(events, "opp");
  const sh = { own: shotBreakdown(events, "own"), opp: shotBreakdown(events, "opp") };
  const box = { own: boxEntries(events, "own"), opp: boxEntries(events, "opp") };
  const summaryRows: SummaryRow[] = [
    { key: "goals", label: "Goles", own: own.goal, opp: opp.goal },
    { key: "shots", label: "Tiros (con goles)", own: sh.own.total, opp: sh.opp.total },
    { key: "on_target", label: "Tiros a puerta", own: sh.own.onTarget, opp: sh.opp.onTarget },
    { key: "final_third", label: "Entradas al último tercio", own: finalThirdEntries(events, "own").total, opp: finalThirdEntries(events, "opp").total },
    { key: "box", label: "Entradas al área", own: box.own.n, opp: box.opp.n, rate: box },
    { key: "crosses", label: "Centros", own: own.cross, opp: opp.cross },
    { key: "corners", label: "Córners", own: own.corner, opp: opp.corner },
    { key: "fouls", label: "Faltas", own: own.foul, opp: opp.foul },
    { key: "losses", label: "Pérdidas", own: own.loss, opp: opp.loss },
    { key: "recoveries", label: "Recuperaciones", own: own.recovery, opp: opp.recovery },
  ];

  // Maps.
  const shots: ShotPoint[] = events
    .filter((e) => isShot(e) && e.x !== null && e.y !== null)
    .map((e) => ({
      id: e.event_id,
      team: side(e),
      x: e.x as number,
      y: e.y as number,
      goal: e.type === "goal",
      outcome: e.outcome,
      goal_y: e.goal_y ?? null,
      goal_z: e.goal_z ?? null,
      player: e.player_id,
      moment: momentOf(e),
    }));
  const crossEvents = events.filter((e) => e.type === "cross");
  const arrows: CrossArrow[] = crossEvents
    .filter((e) => e.x !== null && e.y !== null && e.x_end != null && e.y_end != null)
    .map((e) => ({
      id: e.event_id,
      team: side(e),
      x: e.x as number,
      y: e.y as number,
      x_end: e.x_end as number,
      y_end: e.y_end as number,
      outcome: e.outcome,
      player: e.player_id,
      moment: momentOf(e),
    }));
  const per = (fn: (s: Side) => number) => ({ own: fn("own"), opp: fn("opp") });
  const duelEvents = events.filter((e) => e.type === "duel");
  const duels =
    duelEvents.length === 0
      ? null
      : {
          points: duelEvents
            .filter((e) => e.x !== null && e.y !== null)
            .map((e) => ({ id: e.event_id, team: side(e), x: e.x as number, y: e.y as number, outcome: e.outcome, detail: e.detail ?? null, player: e.player_id, moment: momentOf(e) })),
          no_pos: duelEvents.filter((e) => e.x === null || e.y === null).length,
          won: per((s) => duelEvents.filter((e) => e.team === s && e.outcome === "won").length),
          lost: per((s) => duelEvents.filter((e) => e.team === s && e.outcome === "lost").length),
        };
  const gridOf = (type: "loss" | "recovery") => ({
    own: zoneGrid5x3(events.filter((e) => e.type === type && e.team === "own")),
    opp: zoneGrid5x3(events.filter((e) => e.type === type && e.team === "opp")),
  });

  // Transitions.
  const transOf = (s: Side): TeamTransitions => {
    const t = transitions(events, s);
    const moments = transitionMoments(events, s);
    const row = (m: TransitionMoment): TransitionRow => ({
      id: m.start.event_id,
      moment: momentOf(m.start),
      zone: zoneLabel(m.start),
      shot: momentOf(m.shot),
      goal: m.shot.type === "goal",
      seconds: Math.round(m.shot.t_video - m.start.t_video),
      player: m.start.player_id,
    });
    return {
      losses: moments.filter((m) => m.kind === "loss_to_shot").map(row),
      recoveries: moments.filter((m) => m.kind === "recovery_to_shot").map(row),
      loss_to_shot: t.lossToShotAgainst,
      counterpress: t.counterpress,
      recovery_to_shot: t.recoveryToShot,
    };
  };

  // Set pieces. A penalty is scored when a goal of the same team is tagged within PENALTY_GOAL_S after it.
  const setPieceOf = (s: Side): SetPieceSide => {
    const sp = setPieceTallies(events, s);
    const pens = events.filter((e) => e.team === s && e.type === "penalty");
    return {
      corners: { outcome: sp.corners, delivery: sp.delivery },
      free_kicks: sp.freeKicks,
      goal_kicks: goalKicks(events, s),
      penalties: {
        total: pens.length,
        scored: pens.filter((p) => events.some((g) => g.team === s && g.type === "goal" && g.t_video >= p.t_video && g.t_video - p.t_video <= PENALTY_GOAL_S)).length,
      },
    };
  };
  const playRow = (p: Play): PlayRow => ({ id: p.play_id, title: p.title, note: p.note, moment: momentAt(videoOf(p), p.t_start), end_label: fmtT(p.t_end) });
  const orderedPlays = [...plays]
    .filter((p) => p.match_id === match.match_id)
    .sort((a, b) => videos.findIndex((v) => v.video_id === videoOf(a)) - videos.findIndex((v) => v.video_id === videoOf(b)) || a.t_start - b.t_start);

  const ownMatch = match.kind === "own";
  const data: ReportData = {
    version: REPORT_VERSION,
    generated: input.now ?? "",
    anonymized: !!input.anonymize,
    cover: {
      kind: match.kind,
      title: match.kind === "rival" ? "Informe de rival (análisis previo)" : match.kind === "reference" ? "Informe de video de referencia" : "Informe post-partido",
      match_id: match.folder ?? match.match_id,
      name: match.name,
      date: match.date,
      jornada: report.jornada ?? "",
      score: scoreOf(events),
      focus_team: match.focus_team,
      other_team: match.other_team,
      is_demo: !!match.is_demo,
      level,
    },
    results: recentResults(match.focus_team, input.library, report.results_manual ?? [], !!match.is_demo),
    summary: {
      rows: summaryRows,
      bins: { "5": timeBins(events, timeline.segments, 5), "10": timeBins(events, timeline.segments, 10) },
      possession: gate(src.ball, "ball", "Posesión y pases: en desarrollo (siguiente versión del reporte)."),
    },
    maps: {
      shots,
      shots_no_pos: events.filter((e) => isShot(e) && (e.x === null || e.y === null)).length,
      crosses: arrows,
      crosses_no_end: per((s) => crossEvents.filter((e) => e.team === s && e.x !== null && e.y !== null && (e.x_end == null || e.y_end == null)).length),
      crosses_no_pos: per((s) => crossEvents.filter((e) => e.team === s && (e.x === null || e.y === null)).length),
      crosses_outcome: { own: crossTally(events, "own").outcome, opp: crossTally(events, "opp").outcome },
      duels,
      zones: { loss: gridOf("loss"), recovery: gridOf("recovery") },
    },
    transitions: { own: transOf("own"), opp: transOf("opp") },
    set_pieces: { own: setPieceOf("own"), opp: setPieceOf("opp"), plays: orderedPlays.filter((p) => p.abp).map(playRow) },
    patterns: gate(src.events, "events", "Patrones: en desarrollo (siguiente versión del reporte)."),
    key_players: { touches: gate(src.names && src.ball, "names", "Toques por jugadora: en desarrollo (siguiente versión del reporte).") },
    plays: orderedPlays.map(playRow),
    texts: {
      resumen: report.resumen,
      fortalezas: report.fortalezas,
      debilidades: report.debilidades,
      balon_parado: report.balon_parado,
      jugadoras_clave: report.jugadoras_clave,
      closing: ownMatch
        ? { key: "conclusiones", title: "Conclusiones del partido", text: report.conclusiones ?? "" }
        : { key: "plan", title: "Plan de partido propuesto", text: report.plan },
    },
    method: methodLines(raw, events, videos.length, level, duelEvents.length),
  };
  return input.anonymize ? anonymize(data, input) : data;
}

export const PENALTY_GOAL_S = 10;

function methodLines(raw: MatchEvent[], events: MatchEvent[], nVideos: number, level: LevelInfo, duels: number): string[] {
  const noPos = events.filter((e) => e.x === null || e.y === null).length;
  const lines = [
    `Eventos: ${raw.length} etiquetados a mano sobre ${nVideos === 1 ? "el video" : `${nVideos} videos`}; ${noPos} sin posición marcada no salen en los mapas.`,
    level.play_s === null
      ? "Tramos de juego: sin marcar. El gráfico por tramos cuenta minutos de video desde el primer evento y no se puede medir ninguna cobertura."
      : `Tramos de juego: ${Math.round(level.play_s / 60)} min marcados. Los minutos del informe son minutos de juego.`,
    level.ball.seconds > 0
      ? `Balón: seguido a mano en ${level.ball.share !== null ? pct(level.ball.share) : "una parte"} del tiempo de juego (${Math.round(level.ball.seconds / 60)} min). Los huecos de hasta ${BALL_FILL_S} s entre marcas se unen en línea recta y no cuentan como medición para toques ni pases.`
      : "Balón: sin seguir a mano. No hay cifras de posesión ni de pases.",
    level.tracking.seconds > 0
      ? `Tracking: revisado en ${level.tracking.share !== null ? pct(level.tracking.share) : "una parte"} del tiempo de juego${level.named_share !== null ? `; ${pct(level.named_share)} de las posiciones del equipo analizado tienen nombre` : ""}. Lo que no sale en cuadro no está ausente, solo no se ve.`
      : "Tracking: sin partes revisadas.",
    `Transiciones: pérdida o recuperación seguida de un tiro en menos de ${SHOT_WINDOW_S} s.`,
    "Marcador: goles etiquetados de cada equipo (un autogol se etiqueta como gol del equipo que se beneficia).",
  ];
  if (duels > 0) lines.push(`Duelos: ${duels} etiquetados, solo en este partido; el resultado es para el equipo del evento.`);
  return lines;
}

// --------------------------------------------------------------------------------------------- anonymize

// Names replaced by the shirt number (from the squad, or the name itself when it is a number) or by a stable code
// (J1, J2...) when there is none. Free texts are scrubbed too, word by word, so that no name is left in the JSON.
function anonymize(data: ReportData, input: ReportInput): ReportData {
  const names = new Set<string>();
  for (const e of input.events) if (e.player_id) names.add(e.player_id);
  for (const p of input.roster) names.add(p.player_id);
  for (const o of input.parts) for (const p of o.file.people) if (p.player_id) names.add(p.player_id);
  const number = new Map(input.roster.map((p) => [p.player_id.toLowerCase(), p.number]));
  const code = new Map<string, string>();
  let k = 0;
  for (const n of [...names].sort((a, b) => a.localeCompare(b, "es"))) {
    const shirt = number.get(n.toLowerCase()) ?? (/^#?\s*\d{1,3}$/.test(n.trim()) ? Number(n.replace(/\D/g, "")) : null);
    code.set(n, shirt !== null && shirt !== undefined ? `#${shirt}` : `J${++k}`);
  }
  // Longest first, so that "Ana Paula" goes before "Ana". Only names with a letter: a bare number is already a number.
  const patterns = [...code]
    .filter(([n]) => /\p{L}/u.test(n))
    .sort((a, b) => b[0].length - a[0].length)
    .map(([n, c]) => [new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), c] as const);
  const scrub = (s: string) => patterns.reduce((acc, [re, c]) => acc.replace(re, c), s);
  // Links and identifiers are not text: left as they are.
  const keep = new Set(["youtube", "app", "video_id", "id", "match_id", "generated", "date", "kind", "key", "result", "source"]);
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") return key === "player" ? (code.get(v) ?? scrub(v)) : key && keep.has(key) ? v : scrub(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k2, x]) => [k2, walk(x, k2)]));
    return v;
  };
  return walk(data) as ReportData;
}
