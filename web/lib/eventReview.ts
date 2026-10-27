// Playground > Eventos: the analyst's check of the detections of lib/eventDetect.ts. Pure functions, no file access.
//
// The truth comes only from here: the verdicts she gives to detections, the events she adds that were not detected and the
// time windows where she reviewed everything (only there can a recall be told). The events tagged by hand are never read.
// Reviews keep the rule_version of the detection they judged: if the rule changes afterwards they stop counting (they were
// about another rule) and the screen says so.
import { DETECTED_TYPES, EVENT_DEFAULTS, TYPE_KEYS, type DetectedEvent, type DetectedType, type EventParams } from "./eventDetect.ts";
import { positionsAt, partFor, type Dot, type Oriented } from "./positions.ts";
import type { Segment } from "./segments.ts";

export const MIN_REVIEWS_DEFAULT = 20; // reviews per type before the verdict means anything (configurable)
export const PASS_RATE = 0.8; // «acierto» the analyst asks of each event

export const TYPE_LABEL: Record<DetectedType, string> = {
  throw_in: "Saque de banda",
  free_kick: "Tiro libre",
  corner: "Córner",
  penalty: "Penal",
  goal_kick: "Saque de meta",
  foul: "Falta / fuera de lugar",
  loss: "Pérdida",
  final_third_entry: "Entrada al último tercio",
  box_entry: "Entrada al área",
  cross: "Centro",
};
export const TYPE_HELP: Record<DetectedType, string> = {
  throw_in: "Se marca en la reanudación: el balón detenido junto a la banda empieza a moverse.",
  free_kick: "Se marca en la reanudación: balón detenido dentro de la cancha, con las jugadoras casi quietas.",
  corner: "Se marca en la reanudación: balón detenido en una esquina. Equipo: el que ataca esa portería.",
  penalty: "Se marca en la reanudación: balón detenido en el punto penal.",
  goal_kick: "Se marca en la reanudación: balón detenido en el área chica tras salir (no si la portera lo tenía en juego).",
  foul: "Se marca al inicio de la pausa, antes de un tiro libre o un penal. La falta y el fuera de lugar salen iguales: la revisión decide.",
  loss: "Cualquier cambio de posesión, en el último toque del equipo que lo pierde. La recuperación se anota al revisar.",
  final_third_entry: "El balón cruza hacia adelante el último tercio con posesión del equipo y sin perderla.",
  box_entry: "El balón cruza hacia adelante el borde del área con posesión del equipo.",
  cross: "Del carril exterior o interior al carril central (5 carriles). El detalle dice de cuál.",
};
export const TEAM_LABEL: Record<string, string> = { own: "Nuestro equipo", opp: "Rival", unk: "Sin equipo" };
export const CONF_LABEL: Record<string, string> = { high: "Alta", medium: "Media", low: "Baja" };
export const FLAG_LABEL: Record<string, string> = {
  from_cut: "inicio de tramo (no se vio la salida)",
  cut_stop: "la pausa es el corte entre tramos",
  ball_gap: "balón no visto un rato",
  truncated: "el tramo termina antes de confirmarlo",
  unnamed: "jugadora sin nombre",
  team_unk: "equipo no determinado",
  team_fallback: "equipo deducido de la última posesión",
  team_discrepancy: "quien saca y la última posesión no coinciden",
  no_touch_sample: "sin toque medido del equipo",
};

// ------------------------------------------------------------------------------------------------- files
export const eventsAutoPath = (folder: string, videoId: string) => `matches/${folder}/events_auto_${videoId}.json`;
export const eventReviewPath = (folder: string, videoId: string) => `matches/${folder}/events_review_${videoId}.json`;

export type EventVerdict = "correct" | "incorrect";
export interface EventReview {
  id: string;
  type: DetectedType;
  video_id: string;
  t_video: number;
  x: number;
  y: number;
  team: string;
  rule_version: string;
  verdict: EventVerdict;
  note: string;
  at: string;
}
export interface MissedEvent {
  id: string;
  type: DetectedType;
  video_id: string;
  t_video: number;
  note: string;
  at: string;
}
export interface ReviewWindow {
  id: string;
  video_id: string;
  t0: number;
  t1: number;
  at: string;
}
export interface EventReviewFile {
  kind: "events_review";
  video_id: string;
  min_reviews: number;
  reviews: EventReview[];
  missed: MissedEvent[];
  windows: ReviewWindow[];
}
export const emptyEventReview = (videoId: string): EventReviewFile => ({ kind: "events_review", video_id: videoId, min_reviews: MIN_REVIEWS_DEFAULT, reviews: [], missed: [], windows: [] });

const isType = (t: unknown): t is DetectedType => DETECTED_TYPES.includes(t as DetectedType);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

export function parseEventReview(text: string | null, videoId: string): EventReviewFile {
  try {
    const d = JSON.parse(text ?? "null") as Partial<EventReviewFile> | null;
    if (d && d.kind === "events_review") {
      return {
        kind: "events_review",
        video_id: videoId,
        min_reviews: num(d.min_reviews) && (d.min_reviews as number) >= 1 ? Math.round(d.min_reviews as number) : MIN_REVIEWS_DEFAULT,
        reviews: (d.reviews ?? []).filter((r) => r && typeof r.id === "string" && isType(r.type) && (r.verdict === "correct" || r.verdict === "incorrect") && num(r.t_video)),
        missed: (d.missed ?? []).filter((r) => r && typeof r.id === "string" && isType(r.type) && num(r.t_video)),
        windows: (d.windows ?? []).filter((w) => w && typeof w.id === "string" && num(w.t0) && num(w.t1) && w.t1 > w.t0),
      };
    }
  } catch {
    // Unreadable: starts empty rather than guessing.
  }
  return emptyEventReview(videoId);
}

// Marks the detection; a null verdict clears the mark.
export function setEventVerdict(f: EventReviewFile, ev: DetectedEvent, verdict: EventVerdict | null, note: string, at = new Date().toISOString()): EventReviewFile {
  const rest = f.reviews.filter((r) => r.id !== ev.id);
  if (verdict === null) return { ...f, reviews: rest };
  const entry: EventReview = { id: ev.id, type: ev.type, video_id: ev.video_id, t_video: ev.t_video, x: ev.x, y: ev.y, team: ev.team, rule_version: ev.rule_version, verdict, note: note.trim(), at };
  return { ...f, reviews: [...rest, entry].sort((a, b) => a.t_video - b.t_video) };
}
export const reviewOfEvent = (f: EventReviewFile, ev: DetectedEvent): EventReview | null => f.reviews.find((r) => r.id === ev.id) ?? null;

export function addMissed(f: EventReviewFile, type: DetectedType, t_video: number, note: string, at = new Date().toISOString()): EventReviewFile {
  const id = `missed|${type}|${f.video_id}|${t_video.toFixed(2)}`;
  const m: MissedEvent = { id, type, video_id: f.video_id, t_video, note: note.trim(), at };
  return { ...f, missed: [...f.missed.filter((x) => x.id !== id), m].sort((a, b) => a.t_video - b.t_video) };
}
export const removeMissed = (f: EventReviewFile, id: string): EventReviewFile => ({ ...f, missed: f.missed.filter((m) => m.id !== id) });

// Null if the window is empty or goes backwards.
export function addWindow(f: EventReviewFile, t0: number, t1: number, at = new Date().toISOString()): EventReviewFile | null {
  if (!(t1 > t0) || t0 < 0) return null;
  const id = `window|${f.video_id}|${t0.toFixed(1)}|${t1.toFixed(1)}`;
  return { ...f, windows: [...f.windows.filter((w) => w.id !== id), { id, video_id: f.video_id, t0, t1, at }].sort((a, b) => a.t0 - b.t0) };
}
export const removeWindow = (f: EventReviewFile, id: string): EventReviewFile => ({ ...f, windows: f.windows.filter((w) => w.id !== id) });
export const inWindows = (ws: ReviewWindow[], t: number) => ws.some((w) => t >= w.t0 && t <= w.t1);

// ------------------------------------------------------------------------------------------------- statistics
export type TypeVerdict = "pass" | "redefine" | "few";
export const VERDICT_LABEL: Record<TypeVerdict, string> = { pass: "Pasa (≥80 %)", redefine: "Redefinir regla (<80 %)", few: "Pocas revisiones" };

export interface TypeStats {
  type: DetectedType;
  detected: number;
  reviewed: number; // valid reviews: same rule version, detection still there
  correct: number;
  incorrect: number;
  precision: number | null;
  stale: number; // reviews given to another version of the rule: they do not count
  orphan: number; // same version but the detection no longer comes out (possession or ball changed)
  // Recall, only inside the windows reviewed in full.
  truth: number; // correct detections + events added by hand inside the windows
  found: number; // of those, the ones the rule found
  recall: number | null;
  windowPending: number; // detections inside the windows not reviewed yet: the recall is not final
  verdict: TypeVerdict;
}

export function typeStats(type: DetectedType, dets: DetectedEvent[], f: EventReviewFile, minReviews = f.min_reviews): TypeStats {
  const mine = dets.filter((e) => e.type === type);
  const byId = new Map(mine.map((e) => [e.id, e]));
  const version = mine[0]?.rule_version ?? null;
  let correct = 0;
  let incorrect = 0;
  let stale = 0;
  let orphan = 0;
  const valid = new Map<string, EventReview>();
  for (const r of f.reviews.filter((x) => x.type === type)) {
    const e = byId.get(r.id);
    if (version !== null && r.rule_version !== version) stale++;
    else if (!e) orphan++;
    else {
      valid.set(r.id, r);
      if (r.verdict === "correct") correct++;
      else incorrect++;
    }
  }
  const reviewed = correct + incorrect;
  const found = [...valid.values()].filter((r) => r.verdict === "correct" && inWindows(f.windows, r.t_video)).length;
  const added = f.missed.filter((m) => m.type === type && inWindows(f.windows, m.t_video)).length;
  const truth = found + added;
  const windowPending = mine.filter((e) => inWindows(f.windows, e.t_video) && !valid.has(e.id)).length;
  const precision = reviewed > 0 ? correct / reviewed : null;
  return {
    type,
    detected: mine.length,
    reviewed,
    correct,
    incorrect,
    precision,
    stale,
    orphan,
    truth,
    found,
    recall: truth > 0 ? found / truth : null,
    windowPending,
    verdict: reviewed < minReviews || precision === null ? "few" : precision >= PASS_RATE ? "pass" : "redefine",
  };
}
export const allTypeStats = (dets: DetectedEvent[], f: EventReviewFile): TypeStats[] => DETECTED_TYPES.map((t) => typeStats(t, dets, f));

// A review counts for a detection only if it is of the same rule version.
export function isReviewed(f: EventReviewFile, ev: DetectedEvent): boolean {
  const r = f.reviews.find((x) => x.id === ev.id);
  return !!r && r.rule_version === ev.rule_version;
}

// A sample spread over the types: of each, as many unreviewed detections as it lacks to reach minReviews (at most `cap`),
// evenly through the match. Deterministic; sorted by time.
export function eventSample(dets: DetectedEvent[], f: EventReviewFile, minReviews = f.min_reviews, cap = 30): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  for (const type of DETECTED_TYPES) {
    const mine = dets.filter((e) => e.type === type);
    const have = mine.filter((e) => isReviewed(f, e)).length;
    const todo = mine.filter((e) => !isReviewed(f, e)).sort((a, b) => a.t_video - b.t_video);
    const need = Math.min(cap, Math.max(0, minReviews - have), todo.length);
    for (let j = 0; j < need; j++) out.push(todo[Math.min(todo.length - 1, Math.floor(((j + 0.5) * todo.length) / need))]);
  }
  return out.sort((a, b) => a.t_video - b.t_video || a.type.localeCompare(b.type));
}

// ------------------------------------------------------------------------------------------------- filters
export interface EventFilter {
  team: "all" | "own" | "opp" | "unk";
  state: "all" | "pending" | "correct" | "incorrect";
  confidence: "all" | "high" | "medium" | "low";
}
export const NO_EVENT_FILTER: EventFilter = { team: "all", state: "all", confidence: "all" };
export const isEventFiltered = (f: EventFilter) => f.team !== "all" || f.state !== "all" || f.confidence !== "all";
export function filterEvents(dets: DetectedEvent[], f: EventFilter, rv: EventReviewFile): DetectedEvent[] {
  return dets.filter((e) => {
    if (f.team !== "all" && e.team !== f.team) return false;
    if (f.confidence !== "all" && e.confidence !== f.confidence) return false;
    if (f.state !== "all") {
      const r = rv.reviews.find((x) => x.id === e.id && x.rule_version === e.rule_version);
      if (f.state === "pending" ? !!r : r?.verdict !== f.state) return false;
    }
    return true;
  });
}

// ------------------------------------------------------------------------------------------------- scene
export interface EventScene {
  t: number;
  dots: Dot[];
  ball: [number, number] | null;
  view: [number, number][] | null;
}
// The pitch at the moment of the detection (null if no processed part covers it).
export function sceneOfEvent(parts: Oriented[], ev: Pick<DetectedEvent, "video_id" | "t_video">): EventScene | null {
  const o = partFor(parts, ev.video_id, ev.t_video, ev.t_video + 1e-3);
  const at = o ? positionsAt(o, ev.t_video) : null;
  return at ? { t: ev.t_video, dots: at.players, ball: at.ball, view: at.view } : null;
}

// The stretch of video to loop for a detection: a little before and after the moment.
export const eventMoment = (ev: Pick<DetectedEvent, "t_video">) => ({ t: Math.max(0, ev.t_video - 2), t_end: ev.t_video + 3 });

// ------------------------------------------------------------------------------------------------- prerequisites
export interface PartBall {
  video_id: string;
  start_frame: number;
  end_frame: number;
  play_s: number; // seconds of play stretches inside the part
  covered_s: number; // of those, seconds with a measured ball (hand mark or tracker) within nearS
  share: number | null;
  manual: number; // measured marks by source
  auto: number;
}
// How much of the play time of each part has a measured ball nearby. Interpolated positions are not measurements.
export function ballCoverage(parts: Oriented[], segmentsByVideo: Record<string, Segment[]>, nearS = 2): PartBall[] {
  const playUsed = Object.keys(segmentsByVideo).some((v) => (segmentsByVideo[v] ?? []).some((g) => g.tipo === "juego" && g.end !== null));
  return parts.map((o) => {
    const f = o.file;
    const t0 = f.start_frame / f.fps;
    const t1 = f.end_frame / f.fps;
    const plays = playUsed ? (segmentsByVideo[f.video_id] ?? []).filter((g) => g.tipo === "juego" && g.end !== null) : [{ segment_id: "all", start: t0, end: t1 as number | null, tipo: "juego" as const }];
    const inPlay = (t: number) => plays.some((g) => t >= g.start && t < (g.end as number));
    const play_s = plays.reduce((a, g) => a + Math.max(0, Math.min(t1, g.end as number) - Math.max(t0, g.start)), 0);
    const marks = f.ball.filter((b) => b.source !== "interpolated").map((b) => b.frame / f.fps).sort((a, b) => a - b);
    const step = Math.max(1, f.stride) / f.fps;
    let covered = 0;
    let j = 0;
    for (const fr of f.frames) {
      const t = fr.frame / f.fps;
      if (!inPlay(t)) continue;
      while (j + 1 < marks.length && marks[j + 1] <= t) j++;
      const d = marks.length ? Math.min(Math.abs(marks[j] - t), j + 1 < marks.length ? Math.abs(marks[j + 1] - t) : Infinity) : Infinity;
      if (d <= nearS) covered += step;
    }
    const covered_s = Math.min(covered, play_s);
    return {
      video_id: f.video_id,
      start_frame: f.start_frame,
      end_frame: f.end_frame,
      play_s,
      covered_s,
      share: play_s > 0 ? covered_s / play_s : null,
      manual: f.ball.filter((b) => b.source === "manual").length,
      auto: f.ball.filter((b) => b.source === "auto").length,
    };
  });
}
export const coverageTotal = (rows: PartBall[]) => {
  const play = rows.reduce((a, r) => a + r.play_s, 0);
  const cov = rows.reduce((a, r) => a + r.covered_s, 0);
  return { play_s: play, covered_s: cov, share: play > 0 ? cov / play : null };
};

// The file of detections saved next to the match (matches/<id>/events_auto_<video>.json): only working data.
export interface EventsAutoFile {
  kind: "events_auto";
  video_id: string;
  generated_at: string;
  rule_versions: Record<string, string>;
  events: DetectedEvent[];
}
export function eventsAutoFile(videoId: string, dets: DetectedEvent[], at = new Date().toISOString()): EventsAutoFile {
  const rule_versions: Record<string, string> = {};
  for (const e of dets) rule_versions[e.type] = e.rule_version;
  return { kind: "events_auto", video_id: videoId, generated_at: at, rule_versions, events: dets.filter((e) => e.video_id === videoId) };
}

// ------------------------------------------------------------------------------------------------- parameters (screen)

export interface EventParamField {
  key: keyof EventParams;
  label: string;
  unit: "m" | "s" | "m/s" | "";
  min: number;
  max: number;
  step: number;
  help: string;
  main?: boolean; // shown without opening «Más parámetros»
}
export const EVENT_PARAM_FIELDS: EventParamField[] = [
  { key: "restS", label: "Tiempo detenido", unit: "s", min: 0.5, max: 10, step: 0.5, help: "Segundos con el balón en el mismo lugar antes de que cuente como balón detenido.", main: true },
  { key: "restRadiusM", label: "Radio de reposo", unit: "m", min: 0.3, max: 4, step: 0.1, help: "El balón que se mueve menos que esto sigue detenido." },
  { key: "moveM", label: "Distancia para reanudar", unit: "m", min: 1, max: 10, step: 0.5, help: "El balón debe alejarse tanto del punto de reposo para contar como reanudación.", main: true },
  { key: "moveWindowS", label: "Ventana de salida", unit: "s", min: 0.5, max: 6, step: 0.5, help: "Tiempo, tras dejar el radio de reposo, para alejarse la distancia anterior." },
  { key: "headS", label: "Reanudación al inicio del tramo", unit: "s", min: 2, max: 60, step: 1, help: "Un balón detenido al empezar un tramo se reconoce si se cobra dentro de este tiempo." },
  { key: "gapEntryS", label: "Hueco que cuenta como «no visto»", unit: "s", min: 0.5, max: 10, step: 0.5, help: "Un hueco del balón más largo que esto antes del reposo lleva la bandera de balón no visto." },
  { key: "takerM", label: "Distancia de quien saca", unit: "m", min: 0.5, max: 6, step: 0.5, help: "La persona más cercana al balón detenido, dentro de esta distancia, es quien saca." },
  { key: "lineBandM", label: "Banda: distancia a la línea", unit: "m", min: 0.3, max: 5, step: 0.1, help: "Balón detenido a menos que esto de una banda: saque de banda.", main: true },
  { key: "cornerM", label: "Córner: distancia a la esquina", unit: "m", min: 1, max: 8, step: 0.5, help: "Balón detenido a menos que esto de una esquina: córner.", main: true },
  { key: "boxDepthM", label: "Saque de meta: profundidad", unit: "m", min: 2, max: 12, step: 0.5, help: "Hasta qué distancia de la línea de fondo cuenta como área chica." },
  { key: "boxHalfM", label: "Saque de meta: mitad del ancho", unit: "m", min: 3, max: 20, step: 0.5, help: "Distancia máxima al centro de la portería para el saque de meta." },
  { key: "penaltyM", label: "Penal: distancia al punto", unit: "m", min: 0.5, max: 4, step: 0.1, help: "Balón detenido a menos que esto del punto penal." },
  { key: "penaltyS", label: "Penal: tiempo detenido", unit: "s", min: 1, max: 15, step: 0.5, help: "Segundos mínimos en el punto penal." },
  { key: "freeKickS", label: "Tiro libre: tiempo detenido", unit: "s", min: 1, max: 20, step: 0.5, help: "Segundos mínimos con el balón detenido y las jugadoras casi quietas.", main: true },
  { key: "pauseSpeedMs", label: "Pausa: velocidad de las jugadoras", unit: "m/s", min: 0.2, max: 5, step: 0.1, help: "Mediana de la velocidad de las jugadoras seguidas por debajo de la cual el juego está pausado.", main: true },
  { key: "centerM", label: "Saque de centro: radio", unit: "m", min: 1, max: 15, step: 0.5, help: "Un balón detenido así de cerca del centro es un saque de centro: no se marca." },
  { key: "lossGapS", label: "Pérdida: tiempo máximo", unit: "s", min: 1, max: 15, step: 0.5, help: "Si el otro equipo controla antes de este tiempo desde el último control, es un cambio de posesión.", main: true },
  { key: "lossBallTolS", label: "Pérdida: balón medido", unit: "s", min: 0.5, max: 5, step: 0.5, help: "Sin toque medido, el último balón medido debe estar a menos de este tiempo del final del control." },
  { key: "touchM", label: "Distancia de toque", unit: "m", min: 0.5, max: 4, step: 0.1, help: "Quien está más cerca del balón medido que esto lo toca.", main: true },
  { key: "contestM", label: "Margen de disputa", unit: "m", min: 0, max: 3, step: 0.1, help: "Si las dos están así de cerca, el balón es disputado y nadie lo toca." },
  { key: "thirdFrac", label: "Último tercio desde", unit: "", min: 0.5, max: 0.9, step: 0.01, help: "Fracción del largo de la cancha (70/105 ≈ 0.67) donde empieza el último tercio.", main: true },
  { key: "areaDepthM", label: "Área: profundidad", unit: "m", min: 8, max: 25, step: 0.5, help: "Distancia de la línea de fondo al borde del área.", main: true },
  { key: "areaHalfM", label: "Área: mitad del ancho", unit: "m", min: 8, max: 30, step: 0.5, help: "Distancia máxima al centro para estar dentro del ancho del área." },
  { key: "hystM", label: "Antes de cruzar: distancia atrás", unit: "m", min: 0, max: 15, step: 0.5, help: "El balón debió estar así de lejos detrás de la línea poco antes de cruzarla." },
  { key: "cooldownS", label: "No repetir antes de", unit: "s", min: 0, max: 30, step: 1, help: "Segundos mínimos entre dos entradas del mismo equipo." },
  { key: "confirmS", label: "Conserva el balón", unit: "s", min: 0, max: 15, step: 0.5, help: "Tiempo tras cruzar en que el rival no debe controlar para confirmar la entrada." },
  { key: "crossMaxS", label: "Centro: tiempo máximo", unit: "s", min: 1, max: 10, step: 0.5, help: "Tiempo que tarda el balón en llegar al carril central.", main: true },
  { key: "crossLateralM", label: "Centro: desplazamiento lateral", unit: "m", min: 3, max: 30, step: 1, help: "Lo que se mueve hacia el centro como mínimo.", main: true },
];
export const fieldsOfType = (type: DetectedType): EventParamField[] => EVENT_PARAM_FIELDS.filter((f) => TYPE_KEYS[type].includes(f.key));
export const changedKeys = (p: EventParams, type: DetectedType): (keyof EventParams)[] => TYPE_KEYS[type].filter((k) => p[k] !== EVENT_DEFAULTS[k]);
export function clampEventParam(f: EventParamField, raw: number, prev: number): number {
  return Number.isFinite(raw) ? Math.min(f.max, Math.max(f.min, raw)) : prev;
}
