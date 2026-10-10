"use client";

import { useSyncExternalStore } from "react";
import type { State } from "./types";

// Local-first storage: everything lives in the browser (localStorage) and is
// moved between devices with export/import. Swap this module for a database
// client when the app becomes multi-user.

const KEY = "sportsan:v1";

export const EMPTY: State = { matches: [], events: [], plays: [], sessions: [], anchors: [] };

let state: State | null = null;
const listeners = new Set<() => void>();

function load(): State {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    state = EMPTY;
  }
  return state as State;
}

export function mutate(fn: (s: State) => State) {
  state = fn(load());
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the change still lives in memory for this session.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useStore(): State {
  return useSyncExternalStore(subscribe, load, () => EMPTY);
}

const noop = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
