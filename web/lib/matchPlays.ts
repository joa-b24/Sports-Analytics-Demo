// The plays of a whole match for Estudio: every play of every video on one list, ordered by match time, with the video
// and time of each and the filters of the list. Pure functions: no storage, no React.
import type { EventType, Match, MatchEvent, MatchVideo, Play, Team } from "./types.ts";
import { DEFAULT_VIDEO, VIDEO_GAP_S, videoOf } from "./videos.ts";

export interface MatchPlay {
  play: Play;
  video_id: string;
  video_label: string;
  // Seconds in the video, as the play stores them.
  t_start: number;
  t_end: number;
  // Position on the match axis (videos in order, VIDEO_GAP_S between them): for ordering and for showing «minuto del partido».
  t_match: number;
  // What the events inside the stretch say about it: the type of the first one and its team. Null when none.
  type: EventType | null;
  team: Team | null;
  edited: boolean;
}

// Offsets of the videos on the match axis from the plays themselves (a video lasts up to its last play or event).
export function playOffsets(videos: MatchVideo[], plays: Play[], events: MatchEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  let offset = 0;
  for (const v of videos) {
    out[v.video_id] = offset;
    const last = Math.max(0, ...plays.filter((p) => videoOf(p) === v.video_id).map((p) => p.t_end), ...events.filter((e) => videoOf(e) === v.video_id).map((e) => e.t_video));
    offset += last + VIDEO_GAP_S;
  }
  return out;
}

// What the events inside [t_start, t_end] of the play's video say: type and team of the earliest one.
export function playTraits(play: Pick<Play, "t_start" | "t_end" | "video_id">, events: MatchEvent[]): { type: EventType | null; team: Team | null } {
  const inside = events.filter((e) => videoOf(e) === videoOf(play) && e.t_video >= play.t_start && e.t_video <= play.t_end).sort((a, b) => a.t_video - b.t_video);
  const first = inside.find((e) => e.team === "own" || e.team === "opp") ?? inside[0];
  return first ? { type: first.type, team: first.team } : { type: null, team: null };
}

export function matchPlays(match: Pick<Match, "youtube_id" | "videos">, videos: MatchVideo[], plays: Play[], events: MatchEvent[], editedPlayIds: Set<string>): MatchPlay[] {
  const offsets = playOffsets(videos, plays, events);
  const label = new Map(videos.map((v) => [v.video_id, v.label]));
  const known = new Set(videos.map((v) => v.video_id));
  return plays
    .map((p): MatchPlay => {
      // A play of a video the match no longer has is read as the first one's (a row without video_id is v1).
      const vid = known.has(videoOf(p)) ? videoOf(p) : (videos[0]?.video_id ?? DEFAULT_VIDEO);
      return {
        play: p,
        video_id: vid,
        video_label: label.get(vid) ?? vid,
        t_start: p.t_start,
        t_end: p.t_end,
        t_match: (offsets[vid] ?? 0) + p.t_start,
        ...playTraits(p, events),
        edited: editedPlayIds.has(p.play_id),
      };
    })
    .sort((a, b) => a.t_match - b.t_match || a.play.play_id.localeCompare(b.play.play_id));
}

export interface PlayFilter {
  video: string; // "" = all
  kind: string; // "" = all, "abp", "edited", or an event type
  team: string; // "" = all, "own", "opp", "none" (no event inside)
}
export const NO_FILTER: PlayFilter = { video: "", kind: "", team: "" };

export function filterPlays(list: MatchPlay[], f: PlayFilter): MatchPlay[] {
  return list.filter((m) => {
    if (f.video && m.video_id !== f.video) return false;
    if (f.kind === "abp" && !m.play.abp) return false;
    if (f.kind === "edited" && !m.edited) return false;
    if (f.kind && f.kind !== "abp" && f.kind !== "edited" && m.type !== f.kind) return false;
    if (f.team === "none" ? m.team !== null : f.team && m.team !== f.team) return false;
    return true;
  });
}

// Event types present among the plays, for the «tipo» filter.
export const typesPresent = (list: MatchPlay[]): EventType[] => [...new Set(list.flatMap((m) => (m.type ? [m.type] : [])))];
