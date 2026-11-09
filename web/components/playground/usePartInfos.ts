"use client";

import { useEffect, useState } from "react";
import { listLocal, readLocal } from "@/lib/local";
import { parseFixed } from "@/lib/positions";
import { partKey, partRange, partVideo, sourceShares, type PartBallInfo, type PartSpan } from "@/lib/playground";

export interface PartRow extends PartBallInfo {
  span: PartSpan | null;
  hasRaw: boolean;
  hasAuto: boolean;
}

export interface VideoMeta {
  fps: number;
  image_w: number;
  image_h: number;
}

// Tracks_fixed files are heavy (2 MB or more): shares are computed once per file and modification time.
const cache = new Map<string, ReturnType<typeof sourceShares> | null>();

// What the report uses as ball in each part of the match, read from the folder (tracking/): the tracks_fixed it reads,
// the processed parts and the ball_auto files with their dates. `tick` forces a new read.
export function usePartInfos(folder: string | undefined, videoIds: string[], tick: number) {
  const [parts, setParts] = useState<PartRow[] | null>(null);
  const [meta, setMeta] = useState<Record<string, VideoMeta>>({});
  const [error, setError] = useState<string | null>(null);
  const key = videoIds.join(",");
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void (async () => {
      const dir = `matches/${folder}/tracking`;
      const files = await listLocal(dir);
      if (!live) return;
      if (!files) {
        setParts(null);
        setError("No se puede leer la carpeta del partido (la app debe correr en esta computadora).");
        return;
      }
      setError(null);
      const byName = new Map(files.map((f) => [f.name, f]));
      const keys = new Set<string>();
      for (const f of files) {
        const k = f.dir ? null : partKey(f.name);
        if (k && videoIds.includes(partVideo(k))) keys.add(k);
      }
      const metas: Record<string, VideoMeta> = {};
      const spans = new Map<string, PartSpan>();
      for (const v of videoIds) {
        const txt = byName.has(`tracks_${v}_index.json`) ? await readLocal(`${dir}/tracks_${v}_index.json`) : null;
        try {
          const d = txt ? (JSON.parse(txt) as { fps?: number; image_w?: number; image_h?: number; chunks?: { file: string; start_frame: number; end_frame: number }[] }) : null;
          if (d && d.fps && d.image_w && d.image_h) metas[v] = { fps: d.fps, image_w: d.image_w, image_h: d.image_h };
          for (const c of d?.chunks ?? []) {
            const k = partKey(c.file);
            if (k && d?.fps) spans.set(k, { key: k, video_id: v, fps: d.fps, start_frame: c.start_frame, end_frame: c.end_frame });
          }
        } catch {
          // No index: the spans come from the names below.
        }
      }
      const rows: PartRow[] = [];
      for (const k of [...keys].sort((a, b) => partVideo(a).localeCompare(partVideo(b)) || partRange(a)[0] - partRange(b)[0])) {
        const fixed = byName.get(`tracks_fixed_${k}.json`);
        const auto = byName.get(`ball_auto_${k}.json`);
        let shares = null;
        if (fixed) {
          const ck = `${dir}/${fixed.name}|${fixed.mtime ?? 0}|${fixed.size}`;
          if (!cache.has(ck)) {
            const f = parseFixed((await readLocal(`${dir}/${fixed.name}`)) ?? "");
            cache.set(ck, f ? sourceShares(f) : null);
          }
          shares = cache.get(ck) ?? null;
          if (!live) return;
        }
        const v = partVideo(k);
        const [a, b] = partRange(k);
        const fps = metas[v]?.fps;
        rows.push({
          part: k,
          hasFixed: !!fixed,
          hasRaw: byName.has(`tracks_${k}.json`),
          hasAuto: !!auto,
          shares,
          autoMtime: auto?.mtime ?? null,
          fixedMtime: fixed?.mtime ?? null,
          span: spans.get(k) ?? (fps ? { key: k, video_id: v, fps, start_frame: a, end_frame: b } : null),
        });
      }
      if (!live) return;
      setMeta(metas);
      setParts(rows);
    })();
    return () => {
      live = false;
    };
    // videoIds is read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, key, tick]);
  return { parts, meta, error };
}
