// Playground > Balón: pure logic. Which ball the report uses in each part, and the hand samples that train the ball
// tracker. No storage, no React: the components read the files and call these.

// ---------------------------------------------------------------- 0) where the ball of each part comes from

export type BallSourceKey = "manual" | "auto" | "event" | "interpolated" | "none";
export const SOURCE_LABEL: Record<BallSourceKey, string> = {
  manual: "Marcado a mano",
  auto: "Automático",
  event: "Desde eventos",
  interpolated: "Solo interpolado",
  none: "Ninguno",
};

export interface SourceShares {
  // Sampled frames of the part (the frames of tracks_fixed) and how many have each source.
  total: number;
  counts: Record<BallSourceKey, number>;
}

// The minimum a tracks_fixed file must have for this (FixedFile in positions.ts has more).
export interface BallFileLike {
  frames: { frame: number }[];
  ball: { frame: number; source: string }[];
}

const keyOf = (s: string): BallSourceKey => (s === "manual" || s === "auto" || s === "event" || s === "interpolated" ? s : "interpolated");

// % of the frames of a part by the source of its ball: exactly what the report reads (tracks_fixed.ball). A frame
// without a ball counts as «none». A source the app does not know counts as interpolated (never as a measurement).
export function sourceShares(f: BallFileLike): SourceShares {
  const counts: Record<BallSourceKey, number> = { manual: 0, auto: 0, event: 0, interpolated: 0, none: 0 };
  const bySource = new Map<number, BallSourceKey>();
  for (const b of f.ball) bySource.set(b.frame, keyOf(b.source));
  for (const fr of f.frames) counts[bySource.get(fr.frame) ?? "none"]++;
  return { total: f.frames.length, counts };
}

export const pct = (n: number, total: number): number => (total > 0 ? (100 * n) / total : 0);

// The source that gives most of the measured ball (hand, tracker, events); interpolated or none when there is none.
export function mainSource(s: SourceShares): BallSourceKey {
  const c = s.counts;
  const real = (["manual", "auto", "event"] as const).filter((k) => c[k] > 0).sort((a, b) => c[b] - c[a]);
  if (real.length > 0) return real[0];
  return c.interpolated > 0 ? "interpolated" : "none";
}

export interface PartBallInfo {
  // tracks_<part>.json exists / tracks_fixed_<part>.json exists (the report reads the second one if it is there).
  part: string;
  hasFixed: boolean;
  shares: SourceShares | null;
  // ball_auto_<part>.json: modification time (ms) or null.
  autoMtime: number | null;
  fixedMtime: number | null;
}

// One sentence per doubt the analyst can have about a part.
export function partNotes(p: PartBallInfo): string[] {
  const out: string[] = [];
  if (!p.hasFixed) out.push("Sin tracks_fixed: el informe usa las posiciones sin corregir, que no traen balón.");
  if (p.autoMtime !== null && p.hasFixed && p.shares) {
    if (p.shares.counts.auto === 0) out.push("Hay ball_auto, pero el informe no usa ninguno de sus puntos (se incorpora al guardar la parte en la mesa).");
    else if (p.fixedMtime !== null && p.autoMtime > p.fixedMtime) out.push("ball_auto es más nuevo que lo que lee el informe: guarda la parte en la mesa para incorporarlo.");
  }
  if (p.autoMtime === null && p.shares && p.shares.counts.auto > 0) out.push("El informe tiene balón automático, pero ya no existe el archivo ball_auto de esta parte.");
  return out;
}

// Total of the whole match (all parts with a tracks_fixed), as shares of the sampled frames.
export function totalShares(parts: PartBallInfo[]): SourceShares {
  const counts: Record<BallSourceKey, number> = { manual: 0, auto: 0, event: 0, interpolated: 0, none: 0 };
  let total = 0;
  for (const p of parts) {
    if (!p.shares) continue;
    total += p.shares.total;
    for (const k of Object.keys(counts) as BallSourceKey[]) counts[k] += p.shares.counts[k];
  }
  return { total, counts };
}

// "tracks_v2_0_4259.json" -> "v2_0_4259" (also tracks_fixed_, ball_auto_).
export const partKey = (name: string): string | null => name.match(/^(?:tracks_fixed_|tracks_|ball_auto_)(v\d+_\d+_\d+)\.json$/)?.[1] ?? null;
export const partVideo = (part: string): string => part.split("_")[0];
export const partRange = (part: string): [number, number] => {
  const m = part.match(/_(\d+)_(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

// ---------------------------------------------------------------- 1) samples

// The file the Python side reads (matches/<id>/tracking/ball_samples_<video>.json). Do not change without telling it.
export interface BallSample {
  t_video: number;
  px: [number, number];
  aerial: boolean;
  shadow_px: [number, number] | null;
}
export interface BallNegative {
  t_video: number;
}
export interface BallSamplesFile {
  kind: "ball_samples";
  video_id: string;
  fps: number;
  samples: BallSample[];
  negatives: BallNegative[];
}

export const SAMPLES_GOAL: [number, number] = [100, 200];
// Samples closer than this in time are the same moment: a new one replaces the old.
export const SAME_MOMENT_S = 0.12;

export const samplesPath = (folder: string, video: string) => `matches/${folder}/tracking/ball_samples_${video}.json`;
export const metricsPath = (folder: string, video: string) => `matches/${folder}/tracking/ball_metrics_${video}.json`;

export const emptySamples = (video: string, fps: number): BallSamplesFile => ({ kind: "ball_samples", video_id: video, fps, samples: [], negatives: [] });

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const pt = (p: unknown): [number, number] | null => (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)) ? [r1(p[0]), r1(p[1])] : null);

export function parseSamples(text: string | null, video: string, fps: number): BallSamplesFile {
  if (!text) return emptySamples(video, fps);
  try {
    const d = JSON.parse(text) as Partial<BallSamplesFile>;
    if (d.kind !== "ball_samples") return emptySamples(video, fps);
    const samples: BallSample[] = [];
    for (const s of Array.isArray(d.samples) ? d.samples : []) {
      const px = pt(s?.px);
      if (!px || typeof s.t_video !== "number" || !Number.isFinite(s.t_video)) continue;
      samples.push({ t_video: r3(s.t_video), px, aerial: s.aerial === true, shadow_px: pt(s.shadow_px) });
    }
    const negatives = (Array.isArray(d.negatives) ? d.negatives : []).filter((n) => typeof n?.t_video === "number" && Number.isFinite(n.t_video)).map((n) => ({ t_video: r3(n.t_video) }));
    return { kind: "ball_samples", video_id: video, fps: typeof d.fps === "number" && d.fps > 0 ? d.fps : fps, samples: samples.sort((a, b) => a.t_video - b.t_video), negatives: negatives.sort((a, b) => a.t_video - b.t_video) };
  } catch {
    return emptySamples(video, fps);
  }
}

// A sample at a moment: replaces whatever was marked there (a sample or a «not visible»).
export function addSample(f: BallSamplesFile, t: number, px: [number, number], aerial: boolean): BallSamplesFile {
  const s: BallSample = { t_video: r3(t), px: [r1(px[0]), r1(px[1])], aerial, shadow_px: null };
  return {
    ...f,
    samples: [...f.samples.filter((x) => Math.abs(x.t_video - t) > SAME_MOMENT_S), s].sort((a, b) => a.t_video - b.t_video),
    negatives: f.negatives.filter((x) => Math.abs(x.t_video - t) > SAME_MOMENT_S),
  };
}

export function addNegative(f: BallSamplesFile, t: number): BallSamplesFile {
  return {
    ...f,
    samples: f.samples.filter((x) => Math.abs(x.t_video - t) > SAME_MOMENT_S),
    negatives: [...f.negatives.filter((x) => Math.abs(x.t_video - t) > SAME_MOMENT_S), { t_video: r3(t) }].sort((a, b) => a.t_video - b.t_video),
  };
}

// The shadow of an aerial sample (the optional second click).
export function setShadow(f: BallSamplesFile, t: number, px: [number, number] | null): BallSamplesFile {
  return { ...f, samples: f.samples.map((s) => (s.aerial && Math.abs(s.t_video - t) <= SAME_MOMENT_S ? { ...s, shadow_px: px ? [r1(px[0]), r1(px[1])] : null } : s)) };
}

export function removeAt(f: BallSamplesFile, t: number): BallSamplesFile {
  return { ...f, samples: f.samples.filter((x) => Math.abs(x.t_video - t) > SAME_MOMENT_S), negatives: f.negatives.filter((x) => Math.abs(x.t_video - t) > SAME_MOMENT_S) };
}

export interface SampleStats {
  total: number;
  ground: number;
  aerial: number;
  negatives: number;
  // 0..1 towards the lower end of the goal (100); more than 1 is past it.
  progress: number;
  reached: boolean;
  // Share of aerial ones among the samples, null without samples.
  aerialShare: number | null;
}

export function sampleStats(f: BallSamplesFile): SampleStats {
  const aerial = f.samples.filter((s) => s.aerial).length;
  const total = f.samples.length;
  return {
    total,
    ground: total - aerial,
    aerial,
    negatives: f.negatives.length,
    progress: total / SAMPLES_GOAL[0],
    reached: total >= SAMPLES_GOAL[0],
    aerialShare: total > 0 ? aerial / total : null,
  };
}

export interface PartSpan {
  key: string;
  video_id: string;
  fps: number;
  start_frame: number;
  end_frame: number;
}

// Moments to mark, spread over the parts: each new one goes to the part with fewest samples per second and, inside it,
// to the middle of the widest gap between samples (and the ones already suggested). Deterministic, nothing random.
export function suggestInstants(parts: PartSpan[], samples: { t_video: number; video_id?: string }[], count: number, video?: string): { part: string; video_id: string; t_video: number }[] {
  const spans = parts.filter((p) => (!video || p.video_id === video) && p.end_frame > p.start_frame && p.fps > 0).map((p) => ({ p, a: p.start_frame / p.fps, b: p.end_frame / p.fps }));
  const pts = new Map<string, number[]>();
  for (const s of spans) {
    pts.set(
      s.p.key,
      samples.filter((x) => (x.video_id ?? s.p.video_id) === s.p.video_id && x.t_video >= s.a && x.t_video <= s.b).map((x) => x.t_video),
    );
  }
  const out: { part: string; video_id: string; t_video: number }[] = [];
  for (let i = 0; i < count && spans.length > 0; i++) {
    const best = spans.reduce((m, s) => ((pts.get(s.p.key)!.length + 1) / (s.b - s.a) < (pts.get(m.p.key)!.length + 1) / (m.b - m.a) ? s : m));
    const list = [...(pts.get(best.p.key) ?? [])].sort((a, b) => a - b);
    const edges = [best.a, ...list, best.b];
    let gap = 0;
    let at = (best.a + best.b) / 2;
    for (let k = 0; k + 1 < edges.length; k++) {
      if (edges[k + 1] - edges[k] > gap) {
        gap = edges[k + 1] - edges[k];
        at = (edges[k] + edges[k + 1]) / 2;
      }
    }
    at = Math.round(at * 10) / 10;
    pts.get(best.p.key)!.push(at);
    out.push({ part: best.p.key, video_id: best.p.video_id, t_video: at });
  }
  return out.sort((x, y) => x.video_id.localeCompare(y.video_id) || x.t_video - y.t_video);
}

// ---------------------------------------------------------------- 2) validation metrics (written by the trainer)

// matches/<id>/tracking/ball_metrics_<video>.json, to be written by sportsan.tracking.ball train:
// { kind:"ball_metrics", video_id, trained_at, n_train, n_val, ground:{n, precision}, aerial:{n, precision} }
// precision in 0..1 on the held-out 20 % (null when that group has no samples there).
export interface BallMetrics {
  trained_at: string | null;
  n_train: number | null;
  n_val: number | null;
  ground: { n: number | null; precision: number | null };
  aerial: { n: number | null; precision: number | null };
}

export function parseMetrics(text: string | null): BallMetrics | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    if (d.kind !== "ball_metrics") return null;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const grp = (g: unknown) => {
      const o = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
      const p = num(o.precision);
      return { n: num(o.n), precision: p !== null && p >= 0 && p <= 1 ? p : null };
    };
    return { trained_at: typeof d.trained_at === "string" ? d.trained_at : null, n_train: num(d.n_train), n_val: num(d.n_val), ground: grp(d.ground), aerial: grp(d.aerial) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 3) result of the tracker

export interface AutoPoint {
  frame: number;
  px: number;
  py: number;
  p: number;
}

// Points with a probability in three bands, for the summary of a run.
export function probabilityBands(points: AutoPoint[]): { high: number; mid: number; low: number } {
  const o = { high: 0, mid: 0, low: 0 };
  for (const q of points) {
    if (q.p >= 0.99) o.high++;
    else if (q.p >= 0.95) o.mid++;
    else o.low++;
  }
  return o;
}

// Points within `windowS` seconds of a time, to draw over the video.
export function pointsNear(points: AutoPoint[], fps: number, t: number, windowS = 0.4): AutoPoint[] {
  const f = t * fps;
  const w = windowS * fps;
  return points.filter((q) => Math.abs(q.frame - f) <= w);
}

// The next (dir 1) or previous (dir -1) point after a time, or null.
export function stepPoint(points: AutoPoint[], fps: number, t: number, dir: 1 | -1): AutoPoint | null {
  const f = t * fps;
  const margin = 0.5;
  const sorted = [...points].sort((a, b) => a.frame - b.frame);
  if (dir === 1) return sorted.find((q) => q.frame > f + margin) ?? null;
  return [...sorted].reverse().find((q) => q.frame < f - margin) ?? null;
}

// ---------------------------------------------------------------- video clicks

// A click inside the box of the video (its rectangle on screen) -> pixels of the video image, which is shown whole and
// centred in the box («contain»). null if the click falls on the bars outside the image.
export function clickToPx(box: { w: number; h: number }, image: { w: number; h: number }, click: { x: number; y: number }): [number, number] | null {
  if (box.w <= 0 || box.h <= 0 || image.w <= 0 || image.h <= 0) return null;
  const k = Math.min(box.w / image.w, box.h / image.h);
  const x = (click.x - (box.w - image.w * k) / 2) / k;
  const y = (click.y - (box.h - image.h * k) / 2) / k;
  if (x < 0 || y < 0 || x > image.w || y > image.h) return null;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}
