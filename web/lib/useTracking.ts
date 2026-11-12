"use client";

import { useContext, useEffect, useMemo, useState } from "react";
import { aggregatesFingerprint, aggregatesPath, buildAggregates, parseAggregates, type TrackingAggregates } from "./aggregates.ts";
import { loadFixedParts, trackingFileList, type FixedParts } from "./fixed.ts";
import type { FixedFile } from "./positions.ts";
import { readLocal, writeLocal } from "./local.ts";
import { MOBILE } from "./mobile.ts";
import { hashText, stableJson } from "./saveAll.ts";
import type { Segment } from "./segments.ts";
import { getPref, useStore } from "./store.ts";
import { segmentsFromMarks } from "./segments.ts";
import { makeTrackingView, NO_TRACKING, type TrackingView } from "./trackingView.ts";
import { TrackingWindow } from "./trackingWindow.ts";
import type { Match, MatchEvent, State } from "./types.ts";
import { fullWindows, matchVideos, videoOf, type HalfWindows } from "./videos.ts";

// The tracking of a match for the screens that read it as figures (heat maps, passes, block, players): the saved aggregates
// when they are there and match the files (instant, small), else the positions read from the folder, and in that case the
// aggregates are built in the background and saved, so the next opening is fast. The lightweight copy of a match (the one
// that goes to the phone) has no positions at all: it only has the aggregates, and that is what is read.
//
//   view     what to ask for a heat map, the passes of a team... (lib/trackingView.ts)
//   loading  still deciding or reading
//   building the aggregates are being calculated (the screen already shows the figures from the positions)
export interface TrackingState {
  view: TrackingView;
  loading: boolean;
  building: boolean;
  // Only the aggregates: what needs the positions frame by frame (the correction table, a clip) is not there.
  light: boolean;
  // Parts with positions but without a known direction of play (the correction table says it).
  unoriented: FixedFile[];
}

interface Resolution {
  agg: TrackingAggregates | null;
  parts: FixedParts | null;
  key: string;
}

export const ATTEMPT_TYPES: string[] = ["shot", "goal", "cross", "corner", "free_kick", "goal_kick", "penalty"];
const attemptTimes = (events: MatchEvent[], video: string) => events.filter((e) => ATTEMPT_TYPES.includes(e.type) && (e.video_id ?? "v1") === video).map((e) => e.t_video).sort((x, y) => x - y);

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const resolving = new Map<string, Promise<Resolution>>();
const building = new Set<string>();
const builds = new Map<string, Promise<void>>();

// The play stretches that decide what counts: only these enter the key (a stretch the analyst moved changes the figures).
const playKey = (segs: Record<string, Segment[]>) => Object.entries(segs).map(([v, s]) => [v, s.filter((g) => g.tipo === "juego").map((g) => [g.start, g.end])]);

async function resolve(ctx: {
  folder: string;
  videoIds: string[];
  segmentsByVideo: Record<string, Segment[]>;
  events: MatchEvent[];
  videoPeriods: { video_id: string; period: number }[];
  videoHalves: Record<string, HalfWindows>;
  matchId: string;
  match: Match;
}): Promise<Resolution> {
  const files = await trackingFileList(ctx.folder, ctx.videoIds);
  const attack = Object.fromEntries(ctx.videoIds.map((v) => [v, getPref(`attack:${ctx.matchId}:${v}`) ?? null]));
  const fingerprint = aggregatesFingerprint({ files, segmentsByVideo: ctx.segmentsByVideo, videoPeriods: ctx.videoPeriods, videoHalves: ctx.videoHalves, attack, events: ctx.events });
  const key = `${ctx.folder}|${fingerprint}`;
  const open = resolving.get(key);
  if (open) return open;
  const run = (async (): Promise<Resolution> => {
    const saved = parseAggregates(await readLocal(aggregatesPath(ctx.folder)));
    // No positions in the folder (the lightweight copy): the aggregates are all there is. On the phone too when there are
    // aggregates, even if the files are there: the phone cannot read them.
    if (saved && (files.length === 0 || MOBILE || saved.fingerprint === fingerprint)) return { agg: saved, parts: null, key };
    if (files.length === 0) return { agg: null, parts: null, key };
    const parts = await loadFixedParts(ctx.folder, ctx.videoIds);
    // The tagged shots, crosses and set pieces of each video: the touch after them is not a pass cut (lib/positions.ts).
    for (const o of [...parts.parts, ...parts.unoriented.map((file) => ({ file }))]) o.file.attempts_t = attemptTimes(ctx.events, o.file.video_id);
    if (!MOBILE && parts.parts.length > 0 && !building.has(key)) {
      building.add(key);
      const job = (async () => {
        try {
          const agg = await buildAggregates({ match: ctx.match, parts: parts.parts, videoIds: ctx.videoIds, events: ctx.events, segmentsByVideo: ctx.segmentsByVideo, videoPeriods: ctx.videoPeriods, videoHalves: ctx.videoHalves, fingerprint });
          await writeLocal(aggregatesPath(ctx.folder), JSON.stringify(agg));
        } catch {
          // Not saved: the screens keep reading the positions and it is tried again next time.
        } finally {
          building.delete(key);
          resolving.delete(key);
          builds.delete(key);
          notify();
        }
      })();
      builds.set(key, job);
    }
    return { agg: null, parts, key };
  })();
  resolving.set(key, run);
  return run;
}

export function useTracking(match: Match, videoIds: string[], segmentsByVideo: Record<string, Segment[]>): TrackingState {
  const state = useStore();
  // The time filter of the analysis, when this screen is inside one (see lib/trackingWindow.ts).
  const win = useContext(TrackingWindow).segments;
  const folder = match.folder;
  const videoKey = videoIds.join(",");
  const events = useMemo(() => state.events.filter((e) => e.match_id === match.match_id), [state.events, match.match_id]);
  // Only what changes who is on the pitch matters for the key (see aggregatesFingerprint), not every tagged event.
  const subsKey = hashText(stableJson(events.filter((e) => e.type === "substitution" || (e.type === "foul" && e.detail === "red"))));
  const segKey = hashText(stableJson(playKey(segmentsByVideo)));
  const videoPeriods = useMemo(() => matchVideos(match).map((v, i) => ({ video_id: v.video_id, period: v.period ?? (i === 0 ? 1 : 2) })), [match]);
  const videoHalves = useMemo(() => {
    const out: Record<string, HalfWindows> = {};
    for (const v of matchVideos(match)) {
      const w = fullWindows(v);
      if (w) out[v.video_id] = w;
    }
    return out;
  }, [match]);
  const [bump, setBump] = useState(0);
  const [res, setRes] = useState<Resolution | null>(null);
  useEffect(() => {
    const l = () => setBump((b) => b + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void resolve({ folder, videoIds: videoKey.split(","), segmentsByVideo, events, videoPeriods, videoHalves, matchId: match.match_id, match }).then((r) => live && setRes(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- events and segments enter through their keys
  }, [folder, videoKey, segKey, subsKey, videoPeriods, videoHalves, match.match_id, bump]);

  const view = useMemo(() => (res ? makeTrackingView({ parts: res.parts?.parts ?? [], agg: res.agg, segmentsByVideo, videoIds: videoKey.split(","), window: win }) : NO_TRACKING), [res, segmentsByVideo, videoKey, win]);
  const isBuilding = !!res && !res.agg && !!res.parts && building.has(res.key);
  return { view, loading: !!folder && res === null, building: isBuilding, light: view.source === "agg", unoriented: res?.parts?.unoriented ?? [] };
}

// Makes sure the aggregates of a match are saved and match its files (builds them if not, and waits): what the zip for the
// phone does before it is made. «fresh»: they were already good; «built»: just built; «none»: there is no tracking to
// aggregate; «failed»: they could not be saved.
export async function ensureAggregates(state: State, match: Match): Promise<"fresh" | "built" | "none" | "failed"> {
  const folder = match.folder;
  if (!folder) return "none";
  const videos = matchVideos(match);
  const marks = state.segments.filter((g) => g.match_id === match.match_id);
  const segmentsByVideo: Record<string, Segment[]> = Object.fromEntries(videos.map((v) => [v.video_id, segmentsFromMarks(marks.filter((g) => videoOf(g) === v.video_id))]));
  const ctx = {
    folder,
    videoIds: videos.map((v) => v.video_id),
    segmentsByVideo,
    events: state.events.filter((e) => e.match_id === match.match_id),
    videoPeriods: videos.map((v, i) => ({ video_id: v.video_id, period: v.period ?? (i === 0 ? 1 : 2) })),
    videoHalves: Object.fromEntries(videos.flatMap((v) => { const w = fullWindows(v); return w ? [[v.video_id, w] as const] : []; })) as Record<string, HalfWindows>,
    matchId: match.match_id,
    match,
  };
  const r = await resolve(ctx);
  if (r.agg) return "fresh";
  if (!r.parts) return "none";
  const job = builds.get(r.key);
  if (!job) return "failed";
  await job;
  const again = await resolve(ctx);
  return again.agg ? "built" : "failed";
}
