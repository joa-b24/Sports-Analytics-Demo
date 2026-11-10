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

// A slot in the bar of the match where a step puts its own mode switches (anchors / quick review / table...), so the
// step does not draw a second bar under it. Memory only.
let headerSlot: HTMLElement | null = null;
const slotListeners = new Set<() => void>();
export function setHeaderSlot(el: HTMLElement | null) {
  if (headerSlot === el) return;
  headerSlot = el;
  slotListeners.forEach((l) => l());
}
export function useHeaderSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (cb) => (slotListeners.add(cb), () => void slotListeners.delete(cb)),
    () => headerSlot,
    () => null,
  );
}

// The videos of the open match and which one is shown, so the sidebar draws them as chips (only with more than one)
// and picks one. Published by the match screen.
export type VideoChoice = { matchId: string; videos: { id: string; label: string }[]; selected: string; pick: (id: string) => void };
let videoChoice: VideoChoice | null = null;
const videoListeners = new Set<() => void>();
export function publishVideos(v: VideoChoice | null) {
  const same =
    videoChoice && v && videoChoice.matchId === v.matchId && videoChoice.selected === v.selected && videoChoice.videos.length === v.videos.length && videoChoice.videos.every((x, i) => x.id === v.videos[i].id && x.label === v.videos[i].label);
  if (same) {
    if (videoChoice && v) videoChoice.pick = v.pick;
    return;
  }
  videoChoice = v;
  videoListeners.forEach((l) => l());
}
export function useVideoChoice(matchId: string): VideoChoice | null {
  const snap = useSyncExternalStore(
    (cb) => (videoListeners.add(cb), () => void videoListeners.delete(cb)),
    () => videoChoice,
    () => null,
  );
  return snap && snap.matchId === matchId ? snap : null;
}
