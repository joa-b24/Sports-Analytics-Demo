// «Procesos del partido»: the pure logic behind the panel. Three things:
//   1. the report of the quick tracking test (tracking/revision/quick/summary.json) and its verdict;
//   2. the prerequisites of «Relleno y balón automático» (parts with anchors, ball model, hand samples);
//   3. the run of «Eventos»: the detections become events (authorised types) or suggestions for the review pass,
//      without touching the events tagged by hand, and the run can be undone as a block.
// No file access, no React.
import { DETECTED_TYPES, RULE_NAME, type DetectedEvent, type DetectedType } from "./eventDetect.ts";
import { duplicatesOf } from "./tagging.ts";
import { testVerdict } from "./trackingSettings.ts";
import { EVENT_DETAILS, type MatchEvent } from "./types.ts";

// ------------------------------------------------------------------------------------------------- the plan
// «Ver plan» is text printed by Python. The panel shows it as is and highlights the estimate line.
export function planLines(text: string): { lines: string[]; estimate: string | null } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  const est = lines.find((l) => /^Estimado:/.test(l)) ?? null;
  return { lines, estimate: est ? est.replace(/^Estimado:\s*/, "") : null };
}

// ------------------------------------------------------------------------------------------------- quick report
export interface QuickRow {
  start: number;
  end: number;
  found: number;
  wanted: number;
  dropped: number;
  neighboursM: number | null;
  worstM: number | null;
  refsM: number | null;
  missing: number | null;
  frames: number | null;
  ok: boolean;
}
export interface QuickSummary {
  videoId: string;
  part: string;
  startS: number;
  endS: number;
  // Video fps, from the stretch the test processed (frames over seconds); null when the report lacks it.
  fps: number | null;
  created: string;
  // What process measured in the stretch (absent fields stay null: nothing is made up).
  calibratedShare: number | null;
  onPitchMedian: number | null;
  boxesMedian: number | null;
  identities: number | null;
  msPerFrame: number | null;
  samples: number;
  toReview: number;
  rows: QuickRow[];
  suggest: { chains: number; suggestions: number } | null;
  linkModel: boolean;
  files: string[];
  calibFiles: string[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The same rule as `library check` uses to say «bien» or «REVISAR».
export const quickRowOk = (r: { found: number; neighboursM: number | null; refsM: number | null; missing: number | null }) =>
  !!r.found && r.neighboursM !== null && r.neighboursM < 1 && (r.refsM ?? 0) < 1.5 && !r.missing;

export function parseQuickSummary(text: string | null | undefined): QuickSummary | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!d || typeof d !== "object") return null;
    const proc = (d.process && typeof d.process === "object" ? d.process : {}) as Record<string, unknown>;
    const chk = (d.calibration_check && typeof d.calibration_check === "object" ? d.calibration_check : {}) as Record<string, unknown>;
    const rows: QuickRow[] = (Array.isArray(chk.rows) ? chk.rows : []).flatMap((r: Record<string, unknown>) => {
      if (!r || typeof r !== "object") return [];
      const row = {
        start: num(r.start) ?? 0,
        end: num(r.end) ?? 0,
        found: num(r.found) ?? 0,
        wanted: num(r.wanted) ?? 0,
        dropped: Array.isArray(r.dropped) ? r.dropped.length : (num(r.dropped) ?? 0),
        neighboursM: num(r.neighbours_m),
        worstM: num(r.worst_m),
        refsM: num(r.refs_m),
        missing: num(r.missing),
        frames: num(r.frames),
      };
      return [{ ...row, ok: quickRowOk(row) }];
    });
    const files = Array.isArray(d.files) ? d.files.filter((f: unknown): f is string => typeof f === "string") : [];
    const sg = d.suggest && typeof d.suggest === "object" ? (d.suggest as Record<string, unknown>) : null;
    return {
      videoId: typeof d.video_id === "string" ? d.video_id : "",
      part: typeof d.part === "string" ? d.part : "",
      startS: num(d.start_s) ?? 0,
      endS: num(d.end_s) ?? 0,
      fps: (() => {
        const f0 = num(proc.start_frame), f1 = num(proc.end_frame), s0 = num(proc.start_s), s1 = num(proc.end_s);
        return f0 !== null && f1 !== null && s0 !== null && s1 !== null && s1 > s0 ? Math.round(((f1 - f0) / (s1 - s0)) * 100) / 100 : null;
      })(),
      created: typeof d.created === "string" ? d.created : "",
      calibratedShare: num(proc.calibrated_share),
      onPitchMedian: num(proc.on_pitch_median),
      boxesMedian: num(proc.boxes_median),
      identities: num(proc.identities),
      msPerFrame: num(proc.ms_per_frame),
      samples: num(chk.samples) ?? rows.length,
      toReview: num(chk.to_review) ?? rows.filter((r) => !r.ok).length,
      rows,
      suggest: sg ? { chains: num(sg.chains) ?? 0, suggestions: num(sg.suggestions) ?? 0 } : null,
      linkModel: d.link_model === true,
      files,
      calibFiles: files.filter((f) => /^calib_.*\.json$/.test(f)),
    };
  } catch {
    return null;
  }
}

// What the quick report says in one sentence, from what was measured (never from what was not).
export function quickVerdict(q: QuickSummary): { tone: "ok" | "warn" | "bad"; text: string } {
  if (q.samples === 0 && q.calibratedShare === null) return { tone: "warn", text: "La prueba no dejó cifras de calibración: revisa el registro antes de correr todo." };
  if (q.calibratedShare !== null && q.onPitchMedian !== null) {
    const v = testVerdict({ calibrated_share: q.calibratedShare, on_pitch_median: q.onPitchMedian } as Parameters<typeof testVerdict>[0]);
    if (v.tone === "bad") return v;
    if (q.toReview > 0) return { tone: "warn", text: `${q.toReview} de ${q.samples} tramos de calibración piden revisión: añade un ancla cerca y reconstruye la biblioteca. ${v.text}` };
    return v;
  }
  if (q.toReview > 0) return { tone: "warn", text: `${q.toReview} de ${q.samples} tramos de calibración piden revisión: añade un ancla cerca y reconstruye la biblioteca.` };
  return { tone: "ok", text: "La calibración de la prueba quedó dentro de lo esperado." };
}

// ------------------------------------------------------------------------------------------------- prerequisites
export interface Check {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}
export interface FillBallFacts {
  // File names of tracking/ (tracks_<video>_<ini>_<fin>.json, ball_samples_<video>.json, link_model.json...).
  tracking: string[];
  // File names of tracking/auto/ (anchors_<part>.json).
  auto: string[];
  // File names of weights/.
  weights: string[];
  // Samples counted in each ball_samples_<video>.json: video id -> positives (null: not readable).
  samples: Record<string, number | null>;
  // The video ids asked about (all the match's, or the one chosen).
  videos: string[];
}
const PART = /^tracks_(v\d+)_(\d+)_(\d+)\.json$/;
export const partsOf = (tracking: string[], video: string) => tracking.filter((n) => PART.exec(n)?.[1] === video).map((n) => n.replace(/^tracks_/, "").replace(/\.json$/, ""));
export const hasAnchors = (auto: string[], part: string) => auto.includes(`anchors_${part}.json`);
export const ballModels = (weights: string[]) => weights.filter((n) => /^ball_model[A-Za-z0-9_.-]*\.pt$/.test(n));

export function fillBallChecks(f: FillBallFacts): Check[] {
  const out: Check[] = [];
  for (const v of f.videos) {
    const parts = partsOf(f.tracking, v);
    const withA = parts.filter((p) => hasAnchors(f.auto, p));
    out.push({
      id: `parts_${v}`,
      ok: parts.length > 0,
      label: `Partes procesadas de ${v}`,
      detail: parts.length ? `${parts.length} partes (tracks_${v}_*.json)` : "Ninguna: corre antes «Todo el tracking».",
    });
    out.push({
      id: `anchors_${v}`,
      ok: withA.length > 0,
      label: `Anclas de la analista en ${v}`,
      detail: withA.length ? `${withA.length} de ${parts.length} partes tienen anclas` : "Ninguna parte tiene anclas (se ponen en la mesa de Anclas); sin ellas no hay nada que rellenar.",
    });
  }
  out.push({ id: "link_model", ok: f.tracking.includes("link_model.json"), label: "Modelo de uniones", detail: f.tracking.includes("link_model.json") ? "tracking/link_model.json" : "Falta tracking/link_model.json (el relleno lo necesita)." });
  const models = ballModels(f.weights);
  out.push({
    id: "ball_model",
    ok: models.length > 0,
    label: "Modelo de balón entrenado",
    detail: models.length ? models.join(", ") : "No hay weights/ball_model*.pt: marca balones en Herramientas de evaluación › Balón y entrena.",
  });
  for (const v of f.videos) {
    const n = f.samples[v];
    out.push({
      id: `samples_${v}`,
      ok: n !== null && n !== undefined && n > 0,
      label: `Muestras de balón de ${v}`,
      detail: n === null || n === undefined ? `No hay ball_samples_${v}.json.` : `${n} marcas a mano en ball_samples_${v}.json`,
    });
  }
  return out;
}
// Samples are what train the model, so they only block when there is no model to use.
export function fillBallBlockers(checks: Check[]): string[] {
  const hasModel = checks.find((c) => c.id === "ball_model")?.ok;
  return checks.filter((c) => !c.ok && !(c.id.startsWith("samples_") && hasModel)).map((c) => `${c.label}: ${c.detail}`);
}
export function countSamples(text: string | null | undefined): number | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text) as { samples?: unknown };
    return Array.isArray(d.samples) ? d.samples.length : 0;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------- «Eventos» run
// Types whose action is manual and that have no detector today. The card says so and creates nothing for them.
// (The goal is always manual.)
export const NO_DETECTOR: { type: "shot" | "key_pass" | "duel" | "goal"; label: string }[] = [
  { type: "shot", label: "Tiro" },
  { type: "key_pass", label: "Pase clave" },
  { type: "duel", label: "Duelo" },
  { type: "goal", label: "Gol (siempre a mano)" },
];

export const AUTO_ID_PREFIX = "auto-";
export type Decision = "accepted" | "rejected";
// events_suggest_<video>.json: what is still to be answered in the review pass.
export interface SuggestFile {
  kind: "events_suggest";
  video_id: string;
  at: string;
  items: DetectedEvent[];
  decided: Record<string, Decision>;
}
export const suggestPath = (folder: string, videoId: string) => `matches/${folder}/events_suggest_${videoId}.json`;
export const emptySuggest = (videoId: string): SuggestFile => ({ kind: "events_suggest", video_id: videoId, at: "", items: [], decided: {} });
export function parseSuggest(text: string | null | undefined, videoId: string): SuggestFile {
  if (!text) return emptySuggest(videoId);
  try {
    const d = JSON.parse(text) as Partial<SuggestFile>;
    if (d.kind !== "events_suggest" || !Array.isArray(d.items)) return emptySuggest(videoId);
    const decided: Record<string, Decision> = {};
    for (const [k, v] of Object.entries(d.decided ?? {})) if (v === "accepted" || v === "rejected") decided[k] = v;
    return { kind: "events_suggest", video_id: videoId, at: typeof d.at === "string" ? d.at : "", items: d.items.filter((e): e is DetectedEvent => !!e && typeof e.id === "string" && DETECTED_TYPES.includes(e.type)), decided };
  } catch {
    return emptySuggest(videoId);
  }
}

// A detection as an event of the match. Only own/opp detections become events (an unknown team cannot be filed).
// The detail is kept only when the type has it in its catalogue; the rule goes in the note.
export function eventOfDetection(d: DetectedEvent, matchId: string, period: 1 | 2, id: string, auto: boolean): MatchEvent | null {
  if (d.team !== "own" && d.team !== "opp") return null;
  const detail = d.detail && EVENT_DETAILS[d.type]?.[d.detail] ? d.detail : null;
  const ev: MatchEvent = {
    event_id: id,
    match_id: matchId,
    video_id: d.video_id,
    t_video: Math.round(d.t_video * 10) / 10,
    period,
    type: d.type,
    team: d.team,
    player_id: d.player,
    x: Math.round(d.x * 10) / 10,
    y: Math.round(d.y * 10) / 10,
    outcome: null,
    detail,
    note: `${auto ? "Automático" : "Sugerido"}: ${RULE_NAME[d.type]}`,
  };
  if (d.x_end != null && d.y_end != null && (d.type === "cross" || d.type === "corner")) {
    ev.x_end = Math.round(d.x_end * 10) / 10;
    ev.y_end = Math.round(d.y_end * 10) / 10;
  }
  if (auto) ev.auto = true;
  return ev;
}

export interface AutoRunInput {
  dets: DetectedEvent[];
  // Every event of the match now (manual and automatic): none is touched, all count for the duplicates.
  existing: MatchEvent[];
  // Types accepted as automatic (Match.tech.autoEvents).
  auto: DetectedType[];
  matchId: string;
  periodOf: (videoId: string, t: number) => 1 | 2;
  // Identifies the run (events get «auto-<stamp>-<detection id>»).
  stamp: string;
  // Answers of earlier runs, by video.
  prior?: Record<string, SuggestFile>;
}
export interface AutoRunResult {
  created: MatchEvent[];
  // New suggestions by video, with the old answers kept.
  suggest: Record<string, SuggestFile>;
  stats: { created: number; suggestions: number; duplicates: number; noTeam: number; decidedBefore: number };
}

export function runAutoEvents(i: AutoRunInput, at = new Date().toISOString()): AutoRunResult {
  const created: MatchEvent[] = [];
  const keep = (type: DetectedType) => i.auto.includes(type);
  const pending: Record<string, DetectedEvent[]> = {};
  const stats = { created: 0, suggestions: 0, duplicates: 0, noTeam: 0, decidedBefore: 0 };
  const videos = new Set(i.dets.map((d) => d.video_id));
  for (const v of Object.keys(i.prior ?? {})) videos.add(v);
  const sorted = [...i.dets].sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_video - b.t_video);
  for (const d of sorted) {
    const before = i.prior?.[d.video_id]?.decided[d.id];
    const probe = { event_id: "", type: d.type, team: d.team as MatchEvent["team"], t_video: d.t_video, video_id: d.video_id };
    // A detection already tagged (by hand or by an earlier run) is a duplicate: nothing is added, it is not suggested again.
    if (duplicatesOf([...i.existing, ...created], probe).length > 0) {
      stats.duplicates++;
      continue;
    }
    if (d.team !== "own" && d.team !== "opp") {
      // It cannot be an event without a team: the analyst decides in the review pass.
      stats.noTeam++;
    } else if (keep(d.type)) {
      const ev = eventOfDetection(d, i.matchId, i.periodOf(d.video_id, d.t_video), `${AUTO_ID_PREFIX}${i.stamp}-${d.id}`, true);
      if (ev) {
        created.push(ev);
        stats.created++;
        continue;
      }
    }
    if (before) {
      stats.decidedBefore++;
      continue;
    }
    (pending[d.video_id] ??= []).push(d);
    stats.suggestions++;
  }
  const suggest: Record<string, SuggestFile> = {};
  for (const v of videos) {
    const old = i.prior?.[v] ?? emptySuggest(v);
    suggest[v] = { kind: "events_suggest", video_id: v, at, items: pending[v] ?? [], decided: old.decided };
  }
  return { created, suggest, stats };
}

// Suggestions still to answer: not decided, and not already tagged meanwhile.
export function pendingSuggestions(f: SuggestFile, events: MatchEvent[]): DetectedEvent[] {
  return f.items
    .filter((d) => !f.decided[d.id])
    .filter((d) => duplicatesOf(events, { event_id: "", type: d.type, team: d.team as MatchEvent["team"], t_video: d.t_video, video_id: d.video_id }).length === 0)
    .sort((a, b) => a.t_video - b.t_video);
}
export const decide = (f: SuggestFile, id: string, d: Decision | null): SuggestFile => {
  const decided = { ...f.decided };
  if (d) decided[id] = d;
  else delete decided[id];
  return { ...f, decided };
};

// The events of a run, found by their id, so «Deshacer esta corrida» needs no extra storage.
export const stampOfEvent = (e: Pick<MatchEvent, "event_id" | "auto">): string | null => (e.auto ? (/^auto-([a-z0-9]+)-/.exec(e.event_id)?.[1] ?? null) : null);
export function lastAutoRun(events: MatchEvent[]): { stamp: string; ids: string[]; at: number } | null {
  const by = new Map<string, string[]>();
  for (const e of events) {
    const s = stampOfEvent(e);
    if (s) by.set(s, [...(by.get(s) ?? []), e.event_id]);
  }
  let best: { stamp: string; ids: string[]; at: number } | null = null;
  for (const [stamp, ids] of by) {
    const at = parseInt(stamp, 36);
    if (!best || at > best.at) best = { stamp, ids, at };
  }
  return best;
}
export const newStamp = (now = Date.now()) => now.toString(36);
// The events without those of a run.
export const withoutRun = (events: MatchEvent[], stamp: string): MatchEvent[] => events.filter((e) => stampOfEvent(e) !== stamp);

// ------------------------------------------------------------------------------------------------- display
// «~12 min», «~1 h 05 min», «menos de 1 min»; "" when there is no estimate yet.
export function fmtEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "menos de 1 min";
  const m = Math.round(seconds / 60);
  return m >= 60 ? `~${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `~${m} min`;
}
// The report of a quick test is «of this run» when it was written after the run started (a full run that starts later hides it).
export function quickIsCurrent(q: Pick<QuickSummary, "created">, started: number | null): boolean {
  const t = Date.parse(q.created) / 1000;
  return Number.isFinite(t) && (started === null || t >= started - 5);
}
