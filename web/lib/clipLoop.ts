// Loop of a clip (or of a play): the stretch that repeats is the clip's, with an optional margin on both sides.
// Pure functions.
import type { ClipEdit } from "./annotations.ts";

export const LOOP_MARGINS = [0, 1, 2, 3] as const;
export const LOOP_PREF = "studio:loop";
export const LOOP_MARGIN_PREF = "studio:loopMargin";

export const parseMargin = (v: string | null | undefined): number => {
  const n = Number(v);
  return (LOOP_MARGINS as readonly number[]).includes(n) ? n : 0;
};

export interface LoopWindow {
  start: number;
  end: number;
}

// Where playback runs when looping: the clip's start and end, moved out by the margin (never before 0).
export function loopWindow(edit: Pick<ClipEdit, "t_start" | "t_end">, margin: number): LoopWindow {
  return { start: Math.max(0, edit.t_start - margin), end: edit.t_end + margin };
}

// What to do at video time t: keep going, go back to the start of the window, or stop (no loop: at the clip's end).
export function loopAction(t: number, edit: Pick<ClipEdit, "t_start" | "t_end">, loop: boolean, margin: number): "continue" | "restart" | "stop" {
  const w = loop ? loopWindow(edit, margin) : { start: edit.t_start, end: edit.t_end };
  if (t < w.end) return "continue";
  return loop ? "restart" : "stop";
}

// Stops (freezes) already passed when playback starts at t: the ones before t. After a restart none is consumed
// again, so every pause of the clip plays on each lap.
export const consumedAt = (freezeTimes: number[], t: number): Set<number> => new Set(freezeTimes.filter((f) => f < t - 0.02));
