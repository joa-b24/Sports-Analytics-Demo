"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { YT_ID, autoDownloadOn, downloadView, nextAutoDownload, type DlView } from "./downloads";
import { createMatchFolder, listLocal } from "./local";
import { isFolderName } from "./matchFolder";
import { useJobs } from "./run";
import type { Match } from "./types";
import { matchVideos } from "./videos";

// The video files of a match against its registered videos: which are in matches/<folder>/video/, which are being
// downloaded (python -m sportsan.ingest.download_videos through app/api/run) and, optionally, the creation of a missing
// folder and the automatic download. Everything is silent when the app does not run on this computer (names = null).

// How long the name of the folder must stay unchanged before the folder is created.
const CREATE_DELAY_MS = 2500;

export interface VideoDl extends DlView {
  video_id: string;
  label: string;
  hasLink: boolean;
}
export interface VideoDownloads {
  // Whether the repository is reachable (the app runs on this computer).
  local: boolean;
  // Files of video/ (null = unknown).
  names: string[] | null;
  items: VideoDl[];
  // Starts (or retries) the download of a video. Never twice at once for the same video.
  start: (videoId: string) => Promise<void>;
  cancel: (videoId: string) => Promise<void>;
  relist: () => void;
}

interface Opts {
  // Create the folder of the match when it does not exist (partido page only).
  create?: boolean;
  // Download by itself what is missing, if the match allows it (Detalles técnicos).
  auto?: boolean;
  // A video that was missing is now in the folder.
  onReady?: () => void;
  // The folder was just created.
  onCreated?: () => void;
}

export function useVideoDownloads(match: Match | undefined, opts: Opts = {}): VideoDownloads {
  const folder = match?.folder;
  const [names, setNames] = useState<string[] | null>(null);
  const [tick, setTick] = useState(0);
  const { enabled, jobs, detail, stop, refresh } = useJobs(folder);
  const relist = useCallback(() => setTick((n) => n + 1), []);
  const videos = match ? matchVideos(match) : [];
  const attempted = useRef(new Set<string>());
  const ready = useRef<Set<string> | null>(null);
  const cb = useRef(opts);
  useEffect(() => {
    cb.current = opts;
  });

  // The listing of video/; with `create`, the missing folder is created first (once per match and session).
  const metaKey = match ? JSON.stringify([match.kind, match.date, match.focus_team, match.other_team]) : "";
  useEffect(() => {
    if (!folder || !match) return;
    let live = true;
    void (async () => {
      let files = await listLocal(`matches/${folder}/video`);
      if (files === null) {
        const root = await listLocal("matches");
        if (root === null) return void (live && setNames(null));
        // Only when there is a video to download, and once the name stops changing: typing the name would otherwise
        // leave a folder for every valid prefix («..._vs_u», «..._vs_uc»).
        const hasLink = videos.some((v) => YT_ID.test(v.youtube_id));
        if (!root.some((e) => e.name === folder) && cb.current.create && hasLink && isFolderName(folder) && !attempted.current.has(`folder|${folder}`)) {
          await new Promise((r) => setTimeout(r, CREATE_DELAY_MS));
          if (!live) return;
          attempted.current.add(`folder|${folder}`);
          if (await createMatchFolder(folder, { kind: match.kind, date: match.date, own_team_name: match.focus_team, other_team_name: match.other_team })) {
            cb.current.onCreated?.();
            files = await listLocal(`matches/${folder}/video`);
          }
        }
      }
      if (live) setNames((files ?? []).map((f) => f.name));
    })();
    return () => {
      live = false;
    };
    // `metaKey` stands for the match data the new match.yaml is written from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, tick, metaKey]);

  const jobOf = (videoId: string) => {
    const j = jobs.filter((x) => x.kind === "download" && x.video === videoId).sort((a, b) => b.started - a.started)[0];
    return j ? { ...j, ...detail[j.id] } : null;
  };
  const running = jobs.some((j) => j.kind === "download" && j.state === "running");
  const doneId = jobs.filter((j) => j.kind === "download" && j.state !== "running").map((j) => j.id).join("|");
  // While a download runs the listing is read again, and when one ends.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(relist, 4000);
    return () => clearInterval(id);
  }, [running, relist]);
  useEffect(() => {
    if (!doneId) return;
    const t = setTimeout(relist, 0);
    return () => clearTimeout(t);
  }, [doneId, relist]);

  const items: VideoDl[] = videos.map((v) => ({
    video_id: v.video_id,
    label: v.label || v.video_id,
    hasLink: !!v.youtube_id,
    ...downloadView({ hasLink: !!v.youtube_id, names, videoId: v.video_id, job: jobOf(v.video_id) }),
  }));

  // A video that was missing and now is there: the screens read it again.
  const readyKey = items.filter((i) => i.state === "ready").map((i) => i.video_id).join("|");
  useEffect(() => {
    const now = new Set(readyKey ? readyKey.split("|") : []);
    const before = ready.current;
    ready.current = now;
    if (before && names !== null && [...now].some((v) => !before.has(v))) cb.current.onReady?.();
  }, [readyKey, names]);

  const start = async (videoId: string) => {
    const v = videos.find((x) => x.video_id === videoId);
    if (!folder || !v || !YT_ID.test(v.youtube_id) || enabled !== true) return;
    if (jobs.some((j) => j.kind === "download" && j.video === videoId && j.state === "running")) return;
    attempted.current.add(videoId);
    try {
      await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "download", match: folder, video: videoId, youtubeId: v.youtube_id }) });
    } catch {
      // The app lost the connection: the next refresh shows what happened.
    }
    await refresh();
  };
  const cancel = useCallback(
    async (videoId: string) => {
      const j = jobs.find((x) => x.kind === "download" && x.video === videoId && x.state === "running");
      if (j) await stop(j.id);
    },
    [jobs, stop],
  );

  // Automatic download: one at a time, and never again after an error or a cancel.
  const auto = !!opts.auto && !!match && autoDownloadOn(match);
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    if (!auto || enabled !== true) return;
    const next = nextAutoDownload({ auto, names, videos, jobs, attempted: attempted.current });
    if (next) void startRef.current(next);
    // `videos` comes from the match and only changes with it (its link is read when starting).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, enabled, names, jobs, match]);

  return { local: enabled === true && names !== null, names, items, start, cancel, relist };
}
