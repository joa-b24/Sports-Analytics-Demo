"use client";

import { useEffect, useState } from "react";
import { listLocal, readLocal } from "./local";
import { autoFixed, fixedName, inferOwnAttacksRight, parseFixed, type FixedFile, type Oriented } from "./positions";
import { getPref } from "./store";
import type { TracksFile } from "./tracks";

// Positions of a match, oriented with the analysed team attacking right. Corrected parts (tracks_fixed_*.json) where
// there are; elsewhere, the processed parts nobody corrected (tracks_*.json) as positions by team (`file.auto`), which
// is enough for everything at team level. The direction is the one said in the correction table for that video; if
// none, it is inferred from where each team spends its time (`dir: "inferred"`); parts where neither works are left
// out (`unoriented`).
export interface FixedParts {
  parts: (Oriented & { dir: "said" | "inferred" })[];
  unoriented: FixedFile[];
}

const rawName = (videoId: string) => new RegExp(`^tracks_${videoId}_(\\d+)_(\\d+)\\.json$`);
const range = (name: string): [number, number] => {
  const m = name.match(/_(\d+)_(\d+)\.json$/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

// Files already read in this session, by path (a processed part does not change; a corrected one is read again).
const rawCache = new Map<string, FixedFile>();

export function useFixedParts(folder: string | undefined, videoIds: string[], withAuto = true): FixedParts | null {
  const [out, setOut] = useState<FixedParts | null>(null);
  const key = videoIds.join(",");
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void (async () => {
      const dir = `matches/${folder}/tracking`;
      const files = (await listLocal(dir)) ?? [];
      const yaml = await readLocal(`matches/${folder}/match.yaml`);
      const len = Number(yaml?.match(/pitch_length_m:\s*([\d.]+)/)?.[1]);
      const wid = Number(yaml?.match(/pitch_width_m:\s*([\d.]+)/)?.[1]);
      const venue = len > 0 && wid > 0 ? { length_m: len, width_m: wid } : null;
      const read: FixedFile[] = [];
      for (const v of key.split(",")) {
        const fixedNames = files.filter((f) => !f.dir && fixedName(v).test(f.name)).map((f) => f.name);
        for (const n of fixedNames) {
          const f = parseFixed((await readLocal(`${dir}/${n}`)) ?? "");
          // Files saved before the venue went into them: the size of the match venue.
          if (f) read.push(f.venue ? f : { ...f, venue });
        }
        if (!withAuto) continue;
        const covered = fixedNames.map(range);
        const raws = files.filter((f) => !f.dir && rawName(v).test(f.name)).map((f) => f.name);
        for (const n of raws) {
          const [a, b] = range(n);
          if (covered.some(([c, d]) => c < b && a < d)) continue;
          const path = `${dir}/${n}`;
          let f = rawCache.get(path);
          if (!f) {
            try {
              const t = JSON.parse((await readLocal(path)) ?? "null") as TracksFile | null;
              if (!t || !Array.isArray(t.frames)) continue;
              f = autoFixed(t);
              rawCache.set(path, f);
            } catch {
              continue;
            }
          }
          read.push(f.venue ? f : { ...f, venue });
        }
      }
      const parts: FixedParts["parts"] = [];
      const unoriented: FixedFile[] = [];
      // One direction per video (a video is one half), inferred from all its parts together.
      const byVideo = new Map<string, FixedFile[]>();
      for (const f of read) byVideo.set(f.video_id, [...(byVideo.get(f.video_id) ?? []), f]);
      const inferredOf = new Map([...byVideo].map(([v, fs]) => [v, inferOwnAttacksRight(fs)]));
      for (const file of read.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.start_frame - b.start_frame)) {
        const said = getPref(`attack:${file.match_id}:${file.video_id}`);
        const inferred = said ? null : (inferredOf.get(file.video_id) ?? null);
        if (said) parts.push({ file, ownRight: said === "right", dir: "said" });
        else if (inferred !== null) parts.push({ file, ownRight: inferred, dir: "inferred" });
        else unoriented.push(file);
      }
      if (live) setOut({ parts, unoriented });
    })();
    return () => {
      live = false;
    };
  }, [folder, key, withAuto]);
  return folder ? out : null;
}
