"use client";

import { useSyncExternalStore } from "react";
import type { StepId, StepStatus } from "./steps.ts";

// Where each step of the open match stands, published by the match screen so the sidebar (which lists the steps of the
// mode) can tick the finished ones without computing them again. Memory only: nothing to save.
type Steps = Record<StepId, StepStatus>;
let current: { matchId: string; steps: Steps } | null = null;
const listeners = new Set<() => void>();

export function publishSteps(matchId: string, steps: Steps) {
  const same = current && current.matchId === matchId && (Object.keys(steps) as StepId[]).every((k) => current!.steps[k]?.state === steps[k].state && current!.steps[k]?.text === steps[k].text);
  if (same) return;
  current = { matchId, steps };
  listeners.forEach((l) => l());
}

export function useStepStatus(matchId: string): Steps | null {
  const snap = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => current,
    () => null,
  );
  return snap && snap.matchId === matchId ? snap.steps : null;
}
