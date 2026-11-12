"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClipEdit, ClipSnapshot } from "@/lib/annotations";
import { fixedFileName } from "@/lib/clips";
import { useFixedParts } from "@/lib/fixed";
import { loadClipCalib, pickClipFile, snapshotOf, type Calib } from "@/lib/clipSnapshot";
import { localVideo } from "@/lib/local";
import type { FixedFile } from "@/lib/positions";
import type { Match, RosterPlayer } from "@/lib/types";

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
      const calib = await loadClipCalib(folder, edit.video_id, edit.t_start, edit.t_end);
      if (!live) return;
      setVideoUrl(url);
      setCalib(calib);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [folder, edit.video_id, edit.t_start, edit.t_end]);

  const file: FixedFile | null = useMemo(() => (fixed ? pickClipFile([...fixed.parts.map((p) => p.file), ...fixed.unoriented], { video_id: edit.video_id, t_start: edit.t_start, t_end: edit.t_end }) : null), [fixed, edit.video_id, edit.t_start, edit.t_end]);

  const snapshot = useMemo(
    () => snapshotOf(file, calib, { match_id: edit.match_id, video_id: edit.video_id, t_start: edit.t_start, t_end: edit.t_end }, roster),
    [calib, file, roster, edit.match_id, edit.video_id, edit.t_start, edit.t_end],
  );

  if (snapshot) return { loading: false, videoUrl, snapshot, fixedFile: file ? fixedFileName(file) : null, source: "folder" };
  return {
    loading: loading && !!folder,
    videoUrl,
    snapshot: edit.snapshot ?? null,
    fixedFile: edit.fixed_file ?? null,
    source: edit.snapshot ? "saved" : "none",
  };
}
