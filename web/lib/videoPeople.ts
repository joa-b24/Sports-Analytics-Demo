"use client";

import { useEffect, useMemo, useState } from "react";
import { listLocal, readLocal } from "./local";
import { useStore } from "./store";
import { boxTeamOf, droppedSet, editsKey, fileTeamRefs, identityOf, isDropped, type TeamCode, type TracksFile } from "./tracks";

// Who is on screen at a frame of a video, from its processed part (tracks_<video>_<ini>_<fin>.json) and the corrections
// made on it: each box with the name given in the correction table. Lets the tagging pick a player by clicking her on
// the video. The tagging plays the whole original video, so a time of the video is directly a frame of the part.

export interface ScreenBox {
  identity: number;
  box: [number, number, number, number];
  team: TeamCode;
  player_id: string | null;
}

const partName = (videoId: string) => new RegExp(`^tracks_${videoId}_(\\d+)_(\\d+)\\.json$`);
const cache = new Map<string, TracksFile | null>();

export function useScreenBoxes(folder: string | undefined, videoId: string, frame: number, enabled: boolean): { boxes: ScreenBox[]; size: [number, number] } | null {
  const state = useStore();
  const [names, setNames] = useState<{ name: string; a: number; b: number }[] | null>(null);
  const [file, setFile] = useState<TracksFile | null>(null);
  useEffect(() => {
    if (!folder || !enabled) return;
    let live = true;
    void listLocal(`matches/${folder}/tracking`).then((files) => {
      if (!live) return;
      const re = partName(videoId);
      setNames(
        (files ?? []).flatMap((f) => {
          const m = !f.dir ? f.name.match(re) : null;
          return m ? [{ name: f.name, a: Number(m[1]), b: Number(m[2]) }] : [];
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [folder, videoId, enabled]);
  const part = enabled ? (names?.find((n) => frame >= n.a && frame < n.b) ?? null) : null;
  const path = part && folder ? `matches/${folder}/tracking/${part.name}` : null;
  useEffect(() => {
    if (!path) return;
    if (cache.has(path)) {
      const hit = cache.get(path) ?? null;
      queueMicrotask(() => setFile(hit));
      return;
    }
    let live = true;
    void readLocal(path).then((text) => {
      let f: TracksFile | null = null;
      try {
        const d = JSON.parse(text ?? "null") as TracksFile | null;
        f = d && Array.isArray(d.frames) ? d : null;
      } catch {
        f = null;
      }
      cache.set(path, f);
      if (live) setFile(f);
    });
    return () => {
      live = false;
    };
  }, [path]);
  const here = file && part && file.start_frame === part.a ? file : null;
  const edits = here ? state.trackEdits.find((e) => e.key === editsKey(here)) : undefined;
  const refs = useMemo(() => (here ? fileTeamRefs(here) : null), [here]);
  if (!here || !refs) return null;
  // The processed frame nearest to this one (1 of every `stride` is processed).
  let row = here.frames[0];
  for (const fr of here.frames) if (Math.abs(fr.frame - frame) < Math.abs(row.frame - frame)) row = fr;
  if (!row || Math.abs(row.frame - frame) > here.stride) return { boxes: [], size: [here.image_w, here.image_h] };
  const drop = edits ? droppedSet(edits) : new Set<string>();
  const removed = new Set(edits?.removed ?? []);
  const boxes = row.boxes.flatMap((b) => {
    if (!b[11] || (edits && isDropped(drop, b, row.frame))) return [];
    const id = edits ? identityOf(b, row.frame, edits) : (b[13] ?? b[0]);
    if (removed.has(id)) return [];
    const meta = edits?.people[String(id)] ?? {};
    return [{ identity: id, box: [b[1], b[2], b[3], b[4]] as [number, number, number, number], team: (meta.team as TeamCode | undefined) ?? boxTeamOf(b, refs), player_id: meta.player_id || null }];
  });
  return { boxes, size: [here.image_w, here.image_h] };
}
