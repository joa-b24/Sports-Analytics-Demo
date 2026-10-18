"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClipEdit, ClipSnapshot } from "@/lib/annotations";
import { buildSnapshot, fixedFileName } from "@/lib/clips";
import { useFixedParts } from "@/lib/fixed";
import { listLocal, localVideo, readLocal, tracksParts } from "@/lib/local";
import type { FixedFile } from "@/lib/positions";
import type { TracksFile } from "@/lib/tracks";
import type { Match, RosterPlayer } from "@/lib/types";

type Calib = { image_w: number; image_h: number; stride: number; fps: number; venue: { length_m: number; width_m: number } | null; homographies: [number, number[] | null][] };

// Calibration of the processed frames of a clip, read from the tracks_<video>_*.json parts it overlaps. A part is
// read once per session (they are large and never change).
const calibCache = new Map<string, Calib>();

export interface ClipData {
  loading: boolean;
  videoUrl: string | null;
  // From the files of the match folder when they are there; otherwise the copy saved in the edit.
  snapshot: ClipSnapshot | null;
  fixedFile: string | null;
  // What there is behind the drawings, said in the editor.
  source: "folder" | "saved" | "none";
}

export function useClipData(match: Match, edit: ClipEdit, roster: RosterPlayer[]): ClipData {
  const folder = match.folder;
  const fixed = useFixedParts(folder, [edit.video_id]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [calib, setCalib] = useState<Calib | null>(null);
  const [loading, setLoading] = useState(!!folder);

  useEffect(() => {
    if (!folder) return;
    let live = true;
    void (async () => {
      const url = await localVideo(folder, edit.video_id);
      const dir = `matches/${folder}/tracking`;
      const names = tracksParts(await listLocal(dir), edit.video_id);
      const parts: Calib[] = [];
      // The frame rate is known after the first part read; from then on, parts outside the clip are not read.
      let fps: number | null = null;
      for (const n of names) {
        const m = n.match(/_(\d+)_(\d+)\.json$/);
        if (!m) continue;
        if (fps && (Number(m[1]) > edit.t_end * fps || Number(m[2]) < edit.t_start * fps)) continue;
        const path = `${dir}/${n}`;
        let c = calibCache.get(path);
        if (!c) {
          try {
            const t = JSON.parse((await readLocal(path)) ?? "null") as TracksFile | null;
            if (!t?.frames) continue;
            c = {
              image_w: t.image_w,
              image_h: t.image_h,
              stride: t.stride,
              fps: t.fps,
              venue: t.venue?.length_m && t.venue?.width_m ? { length_m: t.venue.length_m, width_m: t.venue.width_m } : null,
              homographies: t.frames.map((f) => [f.frame, f.H ?? null]),
            };
            calibCache.set(path, c);
          } catch {
            continue;
          }
        }
        fps = c.fps;
        const f0 = edit.t_start * c.fps;
        const f1 = edit.t_end * c.fps;
        if (Number(m[1]) <= f1 && Number(m[2]) >= f0) parts.push(c);
      }
      if (!live) return;
      setVideoUrl(url);
      setCalib(
        parts.length
          ? { ...parts[0], venue: parts.find((p) => p.venue)?.venue ?? null, homographies: parts.flatMap((p) => p.homographies).sort((a, b) => a[0] - b[0]) }
          : null,
      );
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [folder, edit.video_id, edit.t_start, edit.t_end]);

  // The tracking part with most of the clip in it: corrected where there is one, otherwise the processed part.
  const file: FixedFile | null = useMemo(() => {
    if (!fixed) return null;
    const all = [...fixed.parts.map((p) => p.file), ...fixed.unoriented];
    const cover = (f: FixedFile) => Math.min(f.end_frame, edit.t_end * f.fps) - Math.max(f.start_frame, edit.t_start * f.fps);
    return all.filter((f) => f.video_id === edit.video_id && cover(f) > 0).sort((a, b) => Number(!!a.auto) - Number(!!b.auto) || cover(b) - cover(a))[0] ?? null;
  }, [fixed, edit.video_id, edit.t_start, edit.t_end]);

  const snapshot = useMemo(() => {
    if (!calib) return null;
    const venue = calib.venue ?? file?.venue ?? null;
    if (!venue) return null;
    const base: FixedFile = file ?? { kind: "tracks_fixed", match_id: edit.match_id, video_id: edit.video_id, fps: calib.fps, start_frame: 0, end_frame: 0, stride: calib.stride, people: [], ball: [], frames: [] };
    return buildSnapshot(base, { ...calib, venue }, roster, edit.t_start, edit.t_end);
  }, [calib, file, roster, edit.match_id, edit.video_id, edit.t_start, edit.t_end]);

  if (snapshot) return { loading: false, videoUrl, snapshot, fixedFile: file ? fixedFileName(file) : null, source: "folder" };
  return {
    loading: loading && !!folder,
    videoUrl,
    snapshot: edit.snapshot ?? null,
    fixedFile: edit.fixed_file ?? null,
    source: edit.snapshot ? "saved" : "none",
  };
}
