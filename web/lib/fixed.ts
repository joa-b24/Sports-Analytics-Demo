"use client";

import { useEffect, useState } from "react";
import { listLocal, readLocal } from "./local";
import { fixedName, inferOwnAttacksRight, parseFixed, type FixedFile, type Oriented } from "./positions";
import { getPref } from "./store";

// Corrected parts of a match (tracks_fixed_*.json in its tracking folder), oriented with the analysed team attacking
// right. The direction is the one said in the correction table for that video; if none, it is inferred from where
// each team spends its time (`dir: "inferred"`); parts where neither works are left out (`unoriented`).
export interface FixedParts {
  parts: (Oriented & { dir: "said" | "inferred" })[];
  unoriented: FixedFile[];
}

export function useFixedParts(folder: string | undefined, videoIds: string[]): FixedParts | null {
  const [out, setOut] = useState<FixedParts | null>(null);
  const key = videoIds.join(",");
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void (async () => {
      const files = await listLocal(`matches/${folder}/tracking`);
      const names = (files ?? []).filter((f) => !f.dir && key.split(",").some((v) => fixedName(v).test(f.name))).map((f) => f.name);
      const read = (await Promise.all(names.map((n) => readLocal(`matches/${folder}/tracking/${n}`)))).flatMap((t) => {
        const f = t ? parseFixed(t) : null;
        return f ? [f] : [];
      });
      const parts: FixedParts["parts"] = [];
      const unoriented: FixedFile[] = [];
      for (const file of read.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.start_frame - b.start_frame)) {
        const said = getPref(`attack:${file.match_id}:${file.video_id}`);
        const inferred = said ? null : inferOwnAttacksRight(file);
        if (said) parts.push({ file, ownRight: said === "right", dir: "said" });
        else if (inferred !== null) parts.push({ file, ownRight: inferred, dir: "inferred" });
        else unoriented.push(file);
      }
      if (live) setOut({ parts, unoriented });
    })();
    return () => {
      live = false;
    };
  }, [folder, key]);
  return folder ? out : null;
}
