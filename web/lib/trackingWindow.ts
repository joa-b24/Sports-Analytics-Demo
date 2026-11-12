"use client";

import { createContext } from "react";
import type { Segment } from "./segments.ts";
import type { MatchEvent } from "./types.ts";

// The time filter of the analysis, for the panels that read the tracking. `segments`: the play stretches cut to the window (null
// without a filter): the passes, touches, heat maps, block and physical load follow it. `allEvents`: the events of the whole
// match, which the rating always uses (a rating of a few minutes would say nothing).
export interface TrackingWindowValue {
  segments: Record<string, Segment[]> | null;
  allEvents: MatchEvent[] | null;
}
export const TrackingWindow = createContext<TrackingWindowValue>({ segments: null, allEvents: null });
