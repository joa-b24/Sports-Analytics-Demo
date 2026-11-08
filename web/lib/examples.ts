// Ejemplos de balón de la analista para reentrenar el clasificador (página /revision/ejemplos; Python:
// sportsan.tracking.ball_examples). Archivo de verdad aparte: matches/<id>/tracking/revision/balon/ejemplos.json.
// Pixeles del video; t_video = frame / fps. Funciones puras: sin almacenamiento ni React.

export const WHY = ["zapato", "cabeza", "yarda", "otro"] as const;
export type Why = (typeof WHY)[number];
export const WHY_LABEL: Record<Why, string> = { zapato: "Zapato", cabeza: "Cabeza", yarda: "Yarda / línea", otro: "Otro" };
// Meta de positivos para que valga la pena reentrenar.
export const GOAL_POSITIVES = 100;

export interface PlanItem {
  id: string;
  video_id: string;
  frame: number;
  fps: number;
  t_video: number;
}
export interface Positive {
  id: string;
  video_id: string;
  t_video: number;
  px: [number, number];
  aerial: boolean;
}
export interface Skipped {
  id: string;
  video_id: string;
  t_video: number;
}
export interface Negative {
  id: string;
  video_id: string;
  t_video: number;
  px: [number, number];
  why: Why;
}
export interface ExamplesFile {
  kind: "ball_examples";
  positives: Positive[];
  skipped: Skipped[];
  negatives: Negative[];
}
// A detection of the short trial (ensayo.json, kind "ball_trial").
export interface TrialDet {
  frame: number;
  px: number;
  py: number;
  p: number;
  tier?: string;
}

export const emptyExamples = (): ExamplesFile => ({ kind: "ball_examples", positives: [], skipped: [], negatives: [] });

const r1 = (n: number) => Math.round(n * 10) / 10;

export function parseExamples(text: string | null): ExamplesFile {
  if (!text) return emptyExamples();
  try {
    const d = JSON.parse(text) as Partial<ExamplesFile>;
    if (d.kind !== "ball_examples") return emptyExamples();
    return { kind: "ball_examples", positives: d.positives ?? [], skipped: d.skipped ?? [], negatives: d.negatives ?? [] };
  } catch {
    return emptyExamples();
  }
}

// Whatever was answered for an id, so a second answer replaces the first.
const without = (f: ExamplesFile, id: string): ExamplesFile => ({
  ...f,
  positives: f.positives.filter((x) => x.id !== id),
  skipped: f.skipped.filter((x) => x.id !== id),
  negatives: f.negatives.filter((x) => x.id !== id),
});

export const answered = (f: ExamplesFile, id: string): "positive" | "skipped" | "negative" | null =>
  f.positives.some((x) => x.id === id) ? "positive" : f.skipped.some((x) => x.id === id) ? "skipped" : f.negatives.some((x) => x.id === id) ? "negative" : null;

export function addPositive(f: ExamplesFile, item: { id: string; video_id: string; t_video: number }, px: [number, number], aerial: boolean): ExamplesFile {
  const base = without(f, item.id);
  return { ...base, positives: [...base.positives, { id: item.id, video_id: item.video_id, t_video: item.t_video, px: [r1(px[0]), r1(px[1])], aerial }] };
}

export function addSkipped(f: ExamplesFile, item: { id: string; video_id: string; t_video: number }): ExamplesFile {
  const base = without(f, item.id);
  return { ...base, skipped: [...base.skipped, { id: item.id, video_id: item.video_id, t_video: item.t_video }] };
}

export const removeAnswer = (f: ExamplesFile, id: string): ExamplesFile => without(f, id);

// Trial detections get their own ids: the frame of that video.
export const trialId = (video: string, frame: number) => `t_${video}_${frame}`;

// «No es balón» on a detection of the trial: a hard negative at its place.
export function addNegative(f: ExamplesFile, video: string, fps: number, d: TrialDet, why: Why): ExamplesFile {
  const id = trialId(video, d.frame);
  const base = without(f, id);
  return { ...base, negatives: [...base.negatives, { id, video_id: video, t_video: Math.round((d.frame / fps) * 10000) / 10000, px: [r1(d.px), r1(d.py)], why }] };
}

// «Sí es balón» on a detection of the trial: one more positive.
export function confirmDetection(f: ExamplesFile, video: string, fps: number, d: TrialDet): ExamplesFile {
  return addPositive(f, { id: trialId(video, d.frame), video_id: video, t_video: Math.round((d.frame / fps) * 10000) / 10000 }, [d.px, d.py], false);
}

export function counts(f: ExamplesFile) {
  return {
    positives: f.positives.length,
    skipped: f.skipped.length,
    negatives: f.negatives.length,
    byWhy: Object.fromEntries(WHY.map((w) => [w, f.negatives.filter((n) => n.why === w).length])) as Record<Why, number>,
    missing: Math.max(0, GOAL_POSITIVES - f.positives.length),
  };
}

// Index of the next item of the list that has no answer, looking forward from `from` and wrapping; -1 if all are answered.
export function nextPending<T extends { id: string }>(list: T[], f: ExamplesFile, from: number): number {
  for (let k = 0; k < list.length; k++) {
    const i = (from + k) % list.length;
    if (!answered(f, list[i].id)) return i;
  }
  return -1;
}

// Detections of the trial that are not interpolated, in time order.
export const trialDetections = (frames: TrialDet[] | undefined): TrialDet[] => [...(frames ?? [])].filter((d) => d.tier !== "interp").sort((a, b) => a.frame - b.frame);
