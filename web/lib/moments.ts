// A moment of a match video that a panel can play under itself: the video and the time in it (t_video of that video,
// never of the joined axis of Analysis). Pure functions.
import type { MatchEvent } from "./types.ts";
import { videoOf } from "./videos.ts";

export interface Moment {
  video_id: string;
  t: number;
  label: string;
  // End of a stretch (same video): the player then offers to repeat [t, t_end] in a loop.
  t_end?: number;
}

// Seconds shown before the moment, so that the play is seen coming.
export const LEAD_S = 3;
export const momentStart = (t: number) => Math.max(0, t - LEAD_S);

// The same link the report uses for «ver»: opens the match at that moment.
export const momentHref = (matchId: string, m: Pick<Moment, "video_id" | "t">) =>
  `/partido?id=${encodeURIComponent(matchId)}&video=${encodeURIComponent(m.video_id)}&t=${Math.floor(momentStart(m.t))}`;

// The moment of an event. Analysis works on a joined axis (lib/videos.ts matchTimeline), so the event is looked up by
// its id among the events with their own video times; without that list the event already carries a video time.
export function momentOfEvent(e: MatchEvent, own: Map<string, MatchEvent> | null, label: string): Moment {
  const o = own?.get(e.event_id) ?? e;
  return { video_id: videoOf(o), t: o.t_video, label };
}
