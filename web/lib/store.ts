"use client";

import { renumberPrefKey } from "./renumber";
import { useSyncExternalStore } from "react";
import type { State } from "./types";
import { createWriter, loadInitial } from "./storeIdb.ts";
import { normalizeEvents } from "./tagging.ts";

// Local-first storage: everything lives in the browser (IndexedDB, no practical size cap) and is moved between devices
// with export/import. The old localStorage copy (`sportsan:v1`) is copied once on the first start and then left alone as
// a backup. Swap this module for a database client when the app becomes multi-user.
//
// mutate() is synchronous in memory. Reading IndexedDB is asynchronous, so until the state is loaded (a few ms) the store
// is `ready = false`: Shell holds the screens back (useStoreReady) and any mutate() meanwhile is replayed on the loaded state.

const KEY = "sportsan:v1";

export const EMPTY: State = { matches: [], events: [], plays: [], sessions: [], anchors: [], segments: [], venues: [], trackEdits: [], roster: [], passes: [], boards: [], edits: [], jerseys: {} };

let state: State = EMPTY;
let ready = false;
let db: IDBDatabase | null = null;
let dirty = false;
let blocked = false; // the stored state could not be read: never overwrite it
let saveError: string | null = null;
let queued: ((s: State) => State)[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function load(): State {
  return state;
}

function setError(message: string | null) {
  if (saveError === message) return;
  saveError = message;
  notify();
}

const write = createWriter(
  () => db,
  (e) => {
    if (e) dirty = true; // not saved: try again on the next change or when the tab is hidden
    setError(e ? `${e.message || "error desconocido"}` : null);
  },
);

// The whole state is serialised on every change (megabytes once a match has tracks and corrections), so the write is
// grouped: the screen updates at once and the browser storage follows within `WRITE_DELAY_MS`. A change that is still
// waiting is written when the tab is hidden or closed.
const WRITE_DELAY_MS = 400;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!ready || !dirty) return;
  if (blocked || !db) {
    setError(blocked ? "no se pudo leer lo guardado antes, así que no se escribe encima" : "IndexedDB no está disponible");
    return;
  }
  dirty = false;
  try {
    write(JSON.stringify(state));
  } catch (e) {
    dirty = true;
    setError(e instanceof Error ? e.message : String(e));
  }
}

async function init() {
  let text: string | null = null;
  try {
    const r = await loadInitial(window.indexedDB, () => localStorage.getItem(KEY));
    db = r.db;
    text = r.text;
    if (typeof navigator !== "undefined") void navigator.storage?.persist?.().catch(() => {});
  } catch (e) {
    // IndexedDB failed: show what localStorage has (read only) and warn; nothing is written.
    blocked = true;
    setError(e instanceof Error ? e.message : String(e));
    try {
      text = localStorage.getItem(KEY);
    } catch {
      text = null;
    }
  }
  let base: State = EMPTY;
  if (text) {
    try {
      base = { ...EMPTY, ...JSON.parse(text) };
    } catch {
      blocked = true;
      setError("lo guardado está dañado y no se pudo leer");
    }
  }
  for (const fn of queued) base = fn(base);
  if (queued.length) dirty = true;
  // Names with spaces and duels under the wrong team are fixed on every start (see normalizeEvents).
  const clean = normalizeEvents(base.events ?? []);
  if (clean !== base.events && !blocked) {
    base = { ...base, events: clean };
    dirty = true;
  }
  queued = [];
  state = base;
  ready = true;
  notify();
  if (dirty) flush();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  void init();
}

export function mutate(fn: (s: State) => State) {
  if (!ready) {
    queued.push(fn);
    return;
  }
  const before = state.events;
  state = fn(state);
  if (state.events !== before) {
    const clean = normalizeEvents(state.events);
    if (clean !== state.events) state = { ...state, events: clean };
  }
  dirty = true;
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, WRITE_DELAY_MS);
  notify();
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

// False until the saved state is loaded; true on the server never (the screens are drawn on the client).
export function useStoreReady(): boolean {
  return useSyncExternalStore(subscribe, () => ready, () => false);
}

// Why the last save failed (null = fine). Shown by StorageNotice; cleared when a later save works.
export function useSaveError(): string | null {
  return useSyncExternalStore(subscribe, () => saveError, () => null);
}

// Tries to save right now (the notice's "Reintentar" button).
export function retrySave() {
  dirty = true;
  flush();
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

// The preferences of a match that name a video (attack:<match>:v1...) follow a renumbering of its videos.
export function renumberPrefs(names: string[], map: Record<string, string>) {
  const cur = loadPrefs();
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(cur)) next[renumberPrefKey(k, names, map)] = v;
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
