"use client";

import { useSyncExternalStore } from "react";
import type { State } from "./types";

// Local-first storage: everything lives in the browser (localStorage) and is
// moved between devices with export/import. Swap this module for a database
// client when the app becomes multi-user.

const KEY = "sportsan:v1";

export const EMPTY: State = { matches: [], events: [], plays: [], sessions: [], anchors: [], segments: [], venues: [], trackEdits: [], roster: [], passes: [], boards: [], edits: [], jerseys: {} };

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

// Interface preferences of this browser (not data: they are not part of the backup).
const PREFS_KEY = "sportsan:ui";
let prefs: Record<string, string> | null = null;
const prefListeners = new Set<() => void>();

function loadPrefs(): Record<string, string> {
  if (prefs) return prefs;
  try {
    prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    prefs = {};
  }
  return prefs;
}

// A preference read once (outside React rendering, or where a change need not redraw).
export const getPref = (key: string, fallback = "") => loadPrefs()[key] ?? fallback;

export function setPref(key: string, value: string) {
  prefs = { ...loadPrefs(), [key]: value };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Blocked storage: the preference lasts for this session only.
  }
  prefListeners.forEach((l) => l());
}

// After renaming a match folder: the preferences named after it (direction of attack, crop, chosen match...) follow.
export function renamePrefs(from: string, to: string) {
  // Folder names are letters, digits, _ . and -: only the dot needs escaping.
  const re = new RegExp(`(^|[:|])${from.replaceAll(".", "\\.")}(?=$|[:|])`, "g");
  const cur = loadPrefs();
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(cur)) next[k.replace(re, `$1${to}`)] = v === from ? to : v;
  prefs = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Blocked storage: the change lasts for this session only.
  }
  prefListeners.forEach((l) => l());
}

export function usePref(key: string, fallback = ""): string {
  return useSyncExternalStore(
    (l) => {
      prefListeners.add(l);
      return () => {
        prefListeners.delete(l);
      };
    },
    () => loadPrefs()[key] ?? fallback,
    () => fallback,
  );
}
