// Technical details of a match, part 2: the parameters of the tracking tools (automatic fill, green gaps, ball
// confidence, search strip, jump of the g key) and of the automatic events. Kept PER MATCH in Match.tech.tracking (only
// what the analyst changed; the rest are the defaults). Pure functions, no file access. The consumers read from here:
//   fill*, unnamedCost -> runTask «fill» flags (--seg-*, --unnamed-cost)        doubt*  -> «Unión dudosa» suggestions
//   green*             -> PersonTimeline and Unión rápida                       ball*   -> «Detectar balón» (--accept), jumps
//   searchMarginM      -> process --band-margin                                 gStepS  -> the g key of the table
import { DETECTED_TYPES, type DetectedType } from "./eventDetect.ts";
import { PASS_RATE, type EventReviewFile } from "./eventReview.ts";
import { withTech } from "./tech.ts";
import type { Match } from "./types.ts";

type Holder = Pick<Match, "tech"> | null | undefined;
export interface TrackingParams {
  fillMaxCost: number;
  fillMinEntryP: number;
  fillInternalP: number;
  fillRejectClose: boolean;
  unnamedCost: number;
  doubtMinP: number;
  doubtMaxCost: number;
  greenMinS: number;
  greenMaxS: number;
  ballAcceptP: number;
  ballJumpMs: number;
  ballTrajMaxJumpM: number;
  searchMarginM: number;
  gStepS: number;
  // Auto-accept of safe suggestions (lib/autoAccept.ts): minimum p, and whether the batch is applied on opening a part.
  autoAcceptP: number;
  autoAcceptOn: boolean;
  // Sample pass of the anchors mode (lib/samples.ts): minimum gap between samples (s) and own boxes in view.
  sampleGapS: number;
  sampleMinPlayers: number;
}
// Same as the Python ones (tracking/segments.py DEFAULT_POLICY, anchors_cli UNNAMED_COST_REAL, process BAND_MARGIN_M).
export const TRACKING_DEFAULTS: TrackingParams = {
  fillMaxCost: 1.0,
  fillMinEntryP: 0.8,
  fillInternalP: 0.995,
  fillRejectClose: true,
  unnamedCost: 2.0,
  doubtMinP: 0.8,
  doubtMaxCost: 1.0,
  greenMinS: 2,
  greenMaxS: 7,
  ballAcceptP: 0.95,
  ballJumpMs: 30,
  ballTrajMaxJumpM: 10,
  searchMarginM: 3,
  gStepS: 1,
  autoAcceptP: 0.98,
  autoAcceptOn: false,
  sampleGapS: 45,
  sampleMinPlayers: 8,
};

export interface TrackingField {
  key: Exclude<keyof TrackingParams, "fillRejectClose" | "autoAcceptOn">;
  group: "fill" | "gaps" | "ball" | "search" | "keys" | "assist";
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  help: string;
}
export const TRACKING_GROUPS: { id: TrackingField["group"]; title: string; help: string }[] = [
  { id: "fill", title: "Relleno automático", help: "Con qué rigor el relleno (variante B) da un trozo de track a una jugadora. Se pasan al lanzar «Rellenar»." },
  { id: "gaps", title: "Huecos permitidos (verdes)", help: "Un hueco fuera de cámara de esta duración se marca verde: no queda pendiente de rellenar a mano." },
  { id: "ball", title: "Balón", help: "Qué tan seguro debe estar el detector para marcar un balón, y cuánto salto se le permite." },
  { id: "search", title: "Franja de búsqueda del tracking", help: "Zona de la imagen donde el detector busca personas." },
  { id: "keys", title: "Mesa de corrección", help: "Atajos de la mesa." },
  { id: "assist", title: "Anclas: aceptar seguras y muestras", help: "Cuánta seguridad pide «Aceptar las seguras» y cómo se eligen los cuadros de la pasada por muestras." },
];
export const TRACKING_FIELDS: TrackingField[] = [
  { key: "fillMaxCost", group: "fill", label: "Costo máximo", unit: "", min: 0.1, max: 5, step: 0.1, help: "Una cadena con costo mayor queda sin asignar." },
  { key: "fillMinEntryP", group: "fill", label: "Probabilidad mínima de entrada", unit: "", min: 0.5, max: 1, step: 0.01, help: "Probabilidad mínima de la unión que enlaza la cadena con la anterior de la jugadora." },
  { key: "fillInternalP", group: "fill", label: "Probabilidad de uniones internas", unit: "", min: 0.5, max: 1, step: 0.001, help: "Un trozo unido con una unión más floja se suelta de la cadena." },
  { key: "unnamedCost", group: "fill", label: "Costo de dejar sin nombre", unit: "", min: 0.5, max: 10, step: 0.1, help: "Cuánto cuesta dejar una cadena sin jugadora (UNNAMED_COST_REAL): más alto, asigna más." },
  { key: "doubtMinP", group: "fill", label: "Unión dudosa: probabilidad mínima", unit: "", min: 0.5, max: 1, step: 0.01, help: "Las sugerencias de unión dudosa con menos probabilidad no se ofrecen (solo puede endurecer lo que escribe Python)." },
  { key: "doubtMaxCost", group: "fill", label: "Unión dudosa: costo máximo", unit: "", min: 0.1, max: 5, step: 0.1, help: "Las sugerencias con más costo no se ofrecen." },
  { key: "greenMinS", group: "gaps", label: "Hueco verde: mínimo", unit: "s", min: 0.5, max: 30, step: 0.5, help: "Debajo de esto el hueco fuera de cámara no se pinta verde." },
  { key: "greenMaxS", group: "gaps", label: "Hueco verde: máximo", unit: "s", min: 1, max: 60, step: 0.5, help: "Arriba de esto es una salida larga y se revisa a mano." },
  { key: "ballAcceptP", group: "ball", label: "Confianza mínima de la detección", unit: "", min: 0.8, max: 0.99, step: 0.01, help: "Probabilidad mínima para aceptar un balón detectado (ball run --accept): más alta, menos marcas y más seguras." },
  { key: "ballJumpMs", group: "ball", label: "Salto máximo del balón", unit: "m/s", min: 5, max: 100, step: 1, help: "Una posición del detector que salta más rápido que esto se desconfía (un tiro fuerte ronda 30)." },
  { key: "ballTrajMaxJumpM", group: "ball", label: "Salto máximo al corregir trayectorias", unit: "m", min: 1, max: 50, step: 1, help: "Reservado para la corrección de la trayectoria del balón (aún sin algoritmo): solo se guarda." },
  { key: "searchMarginM", group: "search", label: "Margen alrededor de la cancha", unit: "m", min: 0, max: 15, step: 0.5, help: "Con la franja «auto», metros fuera de la cancha donde aún se busca (process --band-margin). Más margen, más cuadro que detectar." },
  { key: "gStepS", group: "keys", label: "Salto de la tecla g", unit: "s", min: 0.2, max: 10, step: 0.1, help: "Segundos que avanza g dentro de un hueco." },
  { key: "autoAcceptP", group: "assist", label: "Seguras: probabilidad mínima", unit: "", min: 0.9, max: 0.999, step: 0.001, help: "Una unión sugerida solo es «segura» con al menos esta probabilidad (y sin choques ni costo alto). Por defecto 0.98: sin confirmar, los trozos nuevos aciertan ~76 % (83–84 % con p ≥ 0.8–0.9)." },
  { key: "sampleGapS", group: "assist", label: "Muestras: separación mínima", unit: "s", min: 10, max: 300, step: 5, help: "Tiempo mínimo entre dos cuadros de la pasada por muestras." },
  { key: "sampleMinPlayers", group: "assist", label: "Muestras: jugadoras propias a la vista", unit: "", min: 3, max: 11, step: 1, help: "Un cuadro solo es muestra si se ven al menos tantas cajas de nuestro equipo (por color de uniforme)." },
];
export const trackingFieldOf = (key: keyof TrackingParams) => TRACKING_FIELDS.find((f) => f.key === key);

// A value inside the limits of its field, else the fallback (a number that is not finite keeps the previous value).
export const clampTracking = (f: TrackingField, v: number, fallback: number) => (Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, v)) : fallback);

// Parameters in force: defaults with what the analyst changed over them (ill-typed or out-of-range values are ignored,
// and a green range with min above max goes back to the defaults).
export function trackingParamsOf(m: Holder): TrackingParams {
  const set = m?.tech?.tracking;
  const out: TrackingParams = { ...TRACKING_DEFAULTS };
  if (!set) return out;
  for (const f of TRACKING_FIELDS) {
    const v = set[f.key];
    if (typeof v === "number" && Number.isFinite(v) && v >= f.min && v <= f.max) Object.assign(out, { [f.key]: v });
  }
  if (typeof set.fillRejectClose === "boolean") out.fillRejectClose = set.fillRejectClose;
  if (typeof set.autoAcceptOn === "boolean") out.autoAcceptOn = set.autoAcceptOn;
  if (out.greenMinS > out.greenMaxS) {
    out.greenMinS = TRACKING_DEFAULTS.greenMinS;
    out.greenMaxS = TRACKING_DEFAULTS.greenMaxS;
  }
  return out;
}
export function trackingDiff(p: TrackingParams): Partial<Record<string, number | boolean>> {
  const out: Partial<Record<string, number | boolean>> = {};
  for (const k of Object.keys(TRACKING_DEFAULTS) as (keyof TrackingParams)[]) if (p[k] !== TRACKING_DEFAULTS[k]) out[k] = p[k];
  return out;
}
export const trackingChanged = (m: Holder): string[] => Object.keys(trackingDiff(trackingParamsOf(m)));
// The match with one parameter changed (a value equal to the default is dropped; with nothing left the part goes away).
// A green range that would end up with min above max is refused (the match comes back unchanged).
export function withTrackingParam(m: Match, key: keyof TrackingParams, value: number | boolean): Match {
  const next = { ...trackingParamsOf(m), [key]: value };
  if (next.greenMinS > next.greenMaxS) return m;
  const d = trackingDiff(next);
  return withTech(m, { tracking: Object.keys(d).length ? d : undefined });
}
export const resetTracking = (m: Match): Match => withTech(m, { tracking: undefined });

// What the «Rellenar» request carries (lib/runTask.ts): only what differs from the defaults, so a better default of the
// Python side reaches the matches that did not touch it.
export interface FillRequest {
  unnamedCost?: number;
  seg?: { maxCost?: number; minEntryP?: number; internalP?: number; rejectClose?: boolean };
}
export function fillRequestOf(m: Holder): FillRequest {
  const p = trackingParamsOf(m);
  const d = TRACKING_DEFAULTS;
  const seg: NonNullable<FillRequest["seg"]> = {};
  if (p.fillMaxCost !== d.fillMaxCost) seg.maxCost = p.fillMaxCost;
  if (p.fillMinEntryP !== d.fillMinEntryP) seg.minEntryP = p.fillMinEntryP;
  if (p.fillInternalP !== d.fillInternalP) seg.internalP = p.fillInternalP;
  if (p.fillRejectClose !== d.fillRejectClose) seg.rejectClose = p.fillRejectClose;
  return { ...(p.unnamedCost !== d.unnamedCost ? { unnamedCost: p.unnamedCost } : {}), ...(Object.keys(seg).length ? { seg } : {}) };
}
// The request of «Detectar balón automáticamente»: its probability (always sent: the analyst's default is 0.95).
export const ballRequestOf = (m: Holder) => ({ accept: trackingParamsOf(m).ballAcceptP });

// The match whose folder is this one (the workspace components know the folder, not the match).
export const matchOfFolder = <T extends Pick<Match, "folder">>(matches: T[], folder: string | undefined | null): T | undefined => (folder ? matches.find((x) => x.folder === folder) : undefined);

// ------------------------------------------------------------------------------------------------- automatic events
// Precision of each detected type over what the analyst reviewed in the Playground (events_review_<video>.json, all the
// videos given). Reviews of an earlier version of a rule cannot be told apart here (the detections are not loaded), so
// the figure is «sobre lo revisado», and the verdict follows the same rule as the Playground (≥ 80 % with enough reviews).
export interface TypeReviewFigure {
  type: DetectedType;
  reviewed: number;
  correct: number;
  precision: number | null;
  verdict: "pass" | "redefine" | "few" | "none";
}
export function reviewFigures(files: EventReviewFile[]): Record<DetectedType, TypeReviewFigure> {
  const minReviews = files.length ? Math.max(...files.map((f) => f.min_reviews)) : 0;
  const out = {} as Record<DetectedType, TypeReviewFigure>;
  for (const t of DETECTED_TYPES) {
    let reviewed = 0;
    let correct = 0;
    for (const f of files)
      for (const r of f.reviews)
        if (r.type === t) {
          reviewed++;
          if (r.verdict === "correct") correct++;
        }
    const precision = reviewed > 0 ? correct / reviewed : null;
    out[t] = { type: t, reviewed, correct, precision, verdict: precision === null ? "none" : reviewed < minReviews ? "few" : precision >= PASS_RATE ? "pass" : "redefine" };
  }
  return out;
}
export const AUTO_EVENTS_LEGEND = "Los eventos de este tipo se crean automáticamente a partir de la detección; aparecerán marcados como “automático”.";
