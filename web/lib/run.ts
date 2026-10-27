"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "./store";
import { TRACKING_DEFAULTS, matchOfFolder, trackingParamsOf } from "./techTracking";

// The Python jobs the app can start when it runs on this computer (app/api/run). On the web they are not available
// and the app shows the command to copy instead.
export type JobKind = "test" | "process" | "kaggle" | "kaggle_pull" | "download";
export interface JobView {
  id: string;
  kind: JobKind;
  match: string;
  video: string;
  state: "running" | "done" | "failed" | "stopped";
  started: number;
  ended: number | null;
  code: number | null;
  last?: string;
  tail?: string[];
}

// The command each job runs, to copy into a terminal (from the project folder, with .venv active).
export const JOB_COMMAND: Record<JobKind, (match: string, video: string) => string> = {
  test: (m, v) => `python -m sportsan.tracking.process --match ${m} --video ${v} --test`,
  process: (m) => `python -m sportsan.tracking.overnight --match ${m}`,
  kaggle: (m, v) => `python -m sportsan.cloud.kaggle run tracking --match ${m} --videos ${v} --no-wait`,
  kaggle_pull: (m) => `python -m sportsan.cloud.kaggle pull --match ${m}`,
  download: (m, v) => `python -m sportsan.ingest.download_videos --match ${m} --video ${v} --youtube-id <id de YouTube>`,
};

// Jobs of one match; polls while one runs. `enabled` is null until known, false on the web.
export function useJobs(match: string | undefined) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [detail, setDetail] = useState<Record<string, JobView>>({});
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/run", { cache: "no-store" });
      if (!r.ok) return setEnabled(false);
      const d = (await r.json()) as { jobs: JobView[] };
      setEnabled(true);
      const mine = d.jobs.filter((j) => j.match === match);
      setJobs(mine);
      const running = mine.filter((j) => j.state === "running" || !detail[j.id] || detail[j.id].state === "running");
      for (const j of running) {
        const x = await fetch(`/api/run?id=${encodeURIComponent(j.id)}`, { cache: "no-store" });
        if (x.ok) {
          const v = (await x.json()) as JobView;
          setDetail((o) => ({ ...o, [v.id]: v }));
        }
      }
    } catch {
      setEnabled(false);
    }
  }, [match, detail]);
  const anyRunning = jobs.some((j) => j.state === "running");
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const id = anyRunning ? setInterval(() => void refresh(), 1500) : undefined;
    return () => {
      clearTimeout(first);
      if (id) clearInterval(id);
    };
    // refresh changes with `detail`; the interval only needs to exist while something runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, anyRunning]);
  const { matches } = useStore();
  const start = async (kind: JobKind, video: string, bandMarginM?: number) => {
    if (!match) return;
    // The margin of Detalles técnicos goes to the test and to the whole processing when it is not the default.
    const tech = trackingParamsOf(matchOfFolder(matches, match)).searchMarginM;
    if (bandMarginM === undefined && (kind === "test" || kind === "process") && tech !== TRACKING_DEFAULTS.searchMarginM) bandMarginM = tech;
    await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, match, video, ...(bandMarginM !== undefined ? { bandMarginM } : {}) }) });
    await refresh();
  };
  const stop = async (id: string) => {
    await fetch(`/api/run?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await refresh();
  };
  // The latest job of a kind, with its output.
  const latest = (kind: JobKind) => {
    const j = [...jobs].filter((x) => x.kind === kind).sort((a, b) => b.started - a.started)[0];
    return j ? { ...j, ...detail[j.id] } : null;
  };
  return { enabled, jobs, detail, start, stop, latest, refresh };
}
