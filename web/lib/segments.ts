import type { SegmentKind, SegmentMark } from "./types";

// Segments of the original video, derived from the cut marks. Pure functions: no storage, no React.
// Output format: segments.csv of the data contract (segment_id, video_id, start, end, tipo), read by
// sportsan.timebase.load_segments. One file per match: the video_id column says which video each row belongs to.

export interface Segment {
  segment_id: string;
  start: number;
  // null while the last stretch has no closing mark.
  end: number | null;
  tipo: SegmentKind;
}

const KINDS: readonly string[] = ["juego", "pausa", "no_medible"];

export function segmentsFromMarks(marks: SegmentMark[]): Segment[] {
  const sorted = [...marks].sort((a, b) => a.t_video - b.t_video);
  const out: Segment[] = [];
  sorted.forEach((m, i) => {
    if (m.tipo === "fin") return;
    const next = sorted[i + 1];
    // Two marks on the same instant: the later one wins, the first leaves no stretch.
    if (next && next.t_video <= m.t_video) return;
    out.push({ segment_id: "", start: m.t_video, end: next ? next.t_video : null, tipo: m.tipo });
  });
  return out.map((s, i) => ({ ...s, segment_id: `s${String(i + 1).padStart(2, "0")}` }));
}

// HH:MM:SS, with one decimal only when the time is not a whole second.
export function fmtHms(sec: number): string {
  const t = Math.max(0, Math.round(sec * 10) / 10);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t - h * 3600 - m * 60;
  const ss = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss}`;
}

export function parseHms(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => p.trim() === "" || Number.isNaN(Number(p)))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

// segments.csv of a whole match: the videos in order, with segment ids numbered across all of them so that every
// row (and the clip cut from it) has a unique name. Only closed segments are written: an open one has no `end`.
export function segmentsCsv(videoIds: string[], byVideo: Record<string, Segment[]>): string {
  const rows: string[] = [];
  for (const v of videoIds) {
    for (const s of byVideo[v] ?? []) {
      if (s.end === null) continue;
      rows.push(`s${String(rows.length + 1).padStart(2, "0")},${v},${fmtHms(s.start)},${fmtHms(s.end)},${s.tipo}`);
    }
  }
  return ["segment_id,video_id,start,end,tipo", ...rows].join("\n") + "\n";
}

export interface CsvMark {
  video_id: string;
  t_video: number;
  tipo: SegmentKind | "fin";
}

// Rows of a segments.csv -> cut marks, per video. A file without the video_id column describes the first video.
// A gap between two rows of the same video is not labelled in the file, so it is closed with "fin".
export function marksFromCsvRows(rows: Record<string, string>[], defaultVideo = "v1"): CsvMark[] {
  const segs = rows
    .map((r) => ({ video_id: (r.video_id ?? "").trim() || defaultVideo, start: parseHms(r.start ?? ""), end: parseHms(r.end ?? ""), tipo: (r.tipo ?? "").trim() }))
    .filter((s): s is { video_id: string; start: number; end: number; tipo: SegmentKind } => s.start !== null && s.end !== null && s.end > s.start && KINDS.includes(s.tipo));
  const marks: CsvMark[] = [];
  for (const video_id of [...new Set(segs.map((s) => s.video_id))]) {
    const own = segs.filter((s) => s.video_id === video_id).sort((a, b) => a.start - b.start);
    own.forEach((s, i) => {
      marks.push({ video_id, t_video: s.start, tipo: s.tipo });
      const next = own[i + 1];
      if (!next || next.start > s.end) marks.push({ video_id, t_video: s.end, tipo: "fin" });
    });
  }
  return marks;
}

export function segmentAt(segments: Segment[], t: number): Segment | null {
  return segments.find((s) => t >= s.start && (s.end === null || t < s.end)) ?? null;
}

// While tagging, nothing happens in a pause or outside the marked stretches (before kick-off, after the end).
// If `t` is in one of those, returns where the next stretch that is not a pause starts; null when `t` is already
// in play, when nothing is marked, or when nothing playable is left ahead.
export function skipTarget(segments: Segment[], t: number): number | null {
  const here = segmentAt(segments, t);
  if (here && here.tipo !== "pausa") return null;
  const next = segments.filter((s) => s.tipo !== "pausa" && s.start > t).sort((a, b) => a.start - b.start)[0];
  return next ? next.start : null;
}

export function totalSeconds(segments: Segment[], tipo: SegmentKind): number {
  return segments.reduce((acc, s) => (s.tipo === tipo && s.end !== null ? acc + (s.end - s.start) : acc), 0);
}
