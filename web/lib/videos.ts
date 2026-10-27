import type { Segment } from "./segments";
import type { FullVideoMarks, Match, MatchEvent, MatchVideo } from "./types";

// A match can come in several videos (usually one per half). Every time in the app (`t_video`) is a time inside
// its own video; the rows say which one with `video_id`. Pure functions: no storage, no React.

export const DEFAULT_VIDEO = "v1";

// Rows saved before matches could have several videos carry no video_id: they belong to the first one.
export const videoOf = (row: { video_id?: string }): string => row.video_id ?? DEFAULT_VIDEO;

export function matchVideos(match: Pick<Match, "youtube_id" | "videos">): MatchVideo[] {
  if (match.videos && match.videos.length > 0) return match.videos;
  return [{ video_id: DEFAULT_VIDEO, youtube_id: match.youtube_id, label: "1.er tiempo" }];
}

export function nextVideo(videos: MatchVideo[]): MatchVideo {
  let n = videos.length + 1;
  while (videos.some((v) => v.video_id === `v${n}`)) n++;
  return { video_id: `v${n}`, youtube_id: "", label: n === 2 ? "2.º tiempo" : `Video ${n}` };
}

// Seconds left between one video and the next on the match timeline, so that no 15-second window spans two videos.
export const VIDEO_GAP_S = 120;

export interface MatchTimeline {
  // Same events, with t_video moved onto one continuous axis (videos in order). Only for analysis: never stored.
  events: MatchEvent[];
  segments: Segment[];
  // What was added to the times of each video.
  offsets: Record<string, number>;
}

// Puts the events and stretches of every video on one axis, in the order of the videos.
export function matchTimeline(videos: MatchVideo[], events: MatchEvent[], segmentsByVideo: Record<string, Segment[]>): MatchTimeline {
  const offsets: Record<string, number> = {};
  let offset = 0;
  const outEvents: MatchEvent[] = [];
  const outSegments: Segment[] = [];
  const single = videos.length === 1;
  for (const v of videos) {
    offsets[v.video_id] = offset;
    const evs = events.filter((e) => videoOf(e) === v.video_id);
    const segs = segmentsByVideo[v.video_id] ?? [];
    for (const e of evs) outEvents.push(offset === 0 ? e : { ...e, t_video: e.t_video + offset });
    for (const s of segs) {
      outSegments.push({
        ...s,
        segment_id: single ? s.segment_id : `${v.video_id}·${s.segment_id}`,
        start: s.start + offset,
        end: s.end === null ? null : s.end + offset,
      });
    }
    const last = Math.max(0, ...evs.map((e) => e.t_video), ...segs.map((s) => s.end ?? s.start));
    offset += last + VIDEO_GAP_S;
  }
  return { events: outEvents.sort((a, b) => a.t_video - b.t_video), segments: outSegments, offsets };
}

// ------------------------------------------------------------------------------------------------- «Partido completo»
// A video can hold both halves (a broadcast). Then its four marks (start and end of each half, in its own seconds) are
// kept in MatchVideo.full. Only a complete, ordered set counts; with less, the video is read as one half, as before.
export interface HalfWindows {
  h1: [number, number];
  h2: [number, number];
}
export function fullWindows(v: Pick<MatchVideo, "full"> | null | undefined): HalfWindows | null {
  const f = v?.full;
  if (!f) return null;
  const { h1_start: a, h1_end: b, h2_start: c, h2_end: d } = f;
  if (![a, b, c, d].every((x) => typeof x === "number" && Number.isFinite(x) && (x as number) >= 0)) return null;
  if (!((a as number) < (b as number) && (b as number) <= (c as number) && (c as number) < (d as number))) return null;
  return { h1: [a as number, b as number], h2: [c as number, d as number] };
}
export const isFullVideo = (v: Pick<MatchVideo, "full"> | null | undefined) => !!v?.full;

// The marks as they would be saved after changing one (undefined removes it).
export function withFullMark(v: MatchVideo, key: keyof FullVideoMarks, value: number | undefined): MatchVideo {
  const full = { ...(v.full ?? {}), [key]: value };
  if (value === undefined) delete full[key];
  return { ...v, full };
}

// Half of a video that is one half (period of the video, else the first video is 1 and the others 2).
export const videoPeriod = (v: MatchVideo, index: number): 1 | 2 => v.period ?? (index === 0 ? 1 : 2);

// Half that a time of the video belongs to: in a full video, by the marks (before the middle of the break is the first
// half); in any other, the video's own.
export function periodAt(v: MatchVideo, index: number, t: number): 1 | 2 {
  const w = fullWindows(v);
  if (!w) return videoPeriod(v, index);
  return t < (w.h1[1] + w.h2[0]) / 2 ? 1 : 2;
}
// The video as one half again (the marks are dropped).
export function withoutFull(v: MatchVideo): MatchVideo {
  const out = { ...v };
  delete out.full;
  return out;
}
