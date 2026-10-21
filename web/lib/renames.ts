"use client";

import { useEffect } from "react";
import { readLocal } from "./local";
import { mutate, renamePrefs } from "./store";

// Renamed match folders (python -m sportsan.ingest.rename_match, or the match's gear): the browser's data named after
// the folder follow it. The terminal leaves a record in matches/renames.json and the app applies it when it opens;
// applying a rename twice changes nothing.

export interface FolderRename {
  from: string;
  to: string;
}

export function applyRename(r: FolderRename) {
  mutate((s) => ({
    ...s,
    matches: s.matches.map((m) => (m.folder === r.from ? { ...m, folder: r.to } : m)),
    trackEdits: s.trackEdits.map((e) => (e.key.startsWith(`${r.from}|`) ? { ...e, key: r.to + e.key.slice(r.from.length) } : e)),
    anchors: s.anchors.map((a) => (a.match_id === r.from ? { ...a, match_id: r.to } : a)),
  }));
  renamePrefs(r.from, r.to);
}

// Once per session, when the app runs next to the repository: the renames done from the terminal, in order. Applying
// one that is already applied changes nothing, so the list is simply replayed.
let checked = false;
export function useRenamesFromFile() {
  useEffect(() => {
    if (checked) return;
    checked = true;
    void readLocal("matches/renames.json").then((text) => {
      if (!text) return;
      try {
        for (const r of JSON.parse(text) as FolderRename[]) if (r && r.from && r.to) applyRename(r);
      } catch {
        // A broken file is left alone.
      }
    });
  }, []);
}
