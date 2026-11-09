import type { PossessionResult, PossessionSample } from "./possession.ts";
import type { MatchEvent } from "./types.ts";

// The possession read from the tracking, held to what the analyst tagged: a team does not keep the ball after its own
// "Pérdida" and a "Recuperación" gives the ball to the team that recovered it. The tracking alone credits a team while one
// of its players is the nearest to the ball; a tagged loss or recovery is a better witness of who has it at that moment.
//
// Only the samples are changed (what the report and the analysis add up); the intervals of the Laboratorio stay as
// read from the tracking. A changed sample says why in its notes (`event_loss`, `event_recovery`).

// Seconds after the event that it governs. Events are tagged by hand with a second or two of lag, so the window
// starts at the event and is short.
export const ANCHOR_S = { loss: 3, recovery: 2 } as const;

interface Anchor {
  t: number;
  kind: "loss" | "recovery";
  team: "own" | "opp";
}

export function anchorPossessionToEvents(res: PossessionResult, events: MatchEvent[]): PossessionResult {
  const byVideo = new Map<string, Anchor[]>();
  for (const e of events) {
    if ((e.type !== "loss" && e.type !== "recovery") || (e.team !== "own" && e.team !== "opp")) continue;
    const v = e.video_id ?? "v1";
    byVideo.set(v, [...(byVideo.get(v) ?? []), { t: e.t_video, kind: e.type, team: e.team }]);
  }
  if (byVideo.size === 0) return res;
  const fix = (s: PossessionSample): PossessionSample => {
    const list = byVideo.get(s.video_id);
    if (!list) return s;
    for (const a of list) {
      if (s.t0 < a.t || s.t0 >= a.t + ANCHOR_S[a.kind]) continue;
      if (a.kind === "loss" && s.team === a.team) return { ...s, team: "none", kind: "loose", contact: false, notes: [...s.notes, "event_loss"] };
      if (a.kind === "recovery" && s.kind !== "dead" && s.team !== a.team) return { ...s, team: a.team, kind: "control", notes: [...s.notes, "event_recovery"] };
    }
    return s;
  };
  return { ...res, samples: res.samples.map(fix) };
}
