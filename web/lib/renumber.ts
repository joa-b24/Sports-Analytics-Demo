// Renumber the videos of a match (v1, v2...) so that they follow the order of the match: the first half is v1. Pure functions over the
// state of the app; the files of the folder are renamed by python -m sportsan.ingest.renumber_videos (app/api/renumber), and both
// use the same map {old id -> new id}. A row without video_id is v1, so it is made explicit when v1 moves.
import type { MatchVideo, State } from "./types.ts";

export type VideoMap = Record<string, string>;
const ID = /^v\d+$/;

// The map that puts the videos, in the order the match shows them, under v1..vn; null when they already are.
export function renumberPlan(ordered: Pick<MatchVideo, "video_id">[]): VideoMap | null {
  const map: VideoMap = {};
  ordered.forEach((v, i) => {
    const to = `v${i + 1}`;
    if (v.video_id !== to) map[v.video_id] = to;
  });
  return Object.keys(map).length ? map : null;
}

// A map that can be applied: ids of the form vN, no two videos to the same id, and nobody left on a target that is not moving.
export function validMap(map: VideoMap, existing: string[]): boolean {
  const keys = Object.keys(map);
  const targets = Object.values(map);
  if (!keys.length || !keys.every((k) => ID.test(k)) || !targets.every((t) => ID.test(t))) return false;
  if (new Set(targets).size !== targets.length) return false;
  return targets.every((t) => !existing.includes(t) || keys.includes(t));
}

export const mapText = (map: VideoMap) => Object.entries(map).map(([a, b]) => `${a}=${b}`).join(",");

const mapId = (map: VideoMap, v: string | undefined): string => {
  const id = v || "v1";
  return map[id] ?? id;
};
// Explicit only when it changes (a row with no video_id is v1 and stays so while v1 does not move).
const withVideo = <T extends { video_id?: string }>(row: T, map: VideoMap): T => {
  const to = mapId(map, row.video_id);
  return to === (row.video_id || "v1") && row.video_id === undefined ? row : { ...row, video_id: to };
};

// File names and keys that carry an id as a word (tracks_v1_0_9.json, folder|v1|0_9): every id changes at once.
const TOKEN = /(?<![A-Za-z0-9])v(\d+)(?![A-Za-z0-9])/g;
export const mapToken = (s: string, map: VideoMap) => s.replace(TOKEN, (t, n) => map[`v${n}`] ?? t);

// Strings of the edits of a part that cite files (links_v1_0_9.json...) follow the files; names and numbers are left alone.
function deepStrings<T>(node: T, map: VideoMap): T {
  if (typeof node === "string") return (/^[\w./-]+$/.test(node) && /[_./]/.test(node) ? mapToken(node, map) : node) as T;
  if (Array.isArray(node)) return node.map((x) => deepStrings(x, map)) as T;
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deepStrings(v, map)])) as T;
  return node;
}

// The state of the app with the videos of ONE match renumbered. Other matches are not touched.
export function renumberState(state: State, matchId: string, folder: string | undefined, map: VideoMap): State {
  const mine = <T extends { match_id?: string }>(r: T) => r.match_id === matchId;
  const keyOf = (k: string) => (folder && k.startsWith(`${folder}|`) ? `${folder}|${mapToken(k.slice(folder.length + 1), map)}` : k);
  const matches = state.matches.map((m) => {
    if (m.match_id !== matchId) return m;
    const videos = (m.videos ?? []).map((v) => ({ ...v, video_id: mapId(map, v.video_id) })).sort((a, b) => a.video_id.localeCompare(b.video_id, undefined, { numeric: true }));
    return { ...m, videos: m.videos ? videos : m.videos, youtube_id: videos[0]?.youtube_id ?? m.youtube_id };
  });
  return {
    ...state,
    matches,
    events: state.events.map((e) => (mine(e) ? withVideo(e, map) : e)),
    plays: state.plays.map((p) => (mine(p) ? withVideo(p, map) : p)),
    segments: state.segments.map((g) => (mine(g) ? withVideo(g, map) : g)),
    anchors: state.anchors.map((a) => (mine(a) ? withVideo(a, map) : a)),
    passes: state.passes.map((p) => (mine(p) ? withVideo(p, map) : p)),
    edits: (state.edits ?? []).map((e) => (mine(e) ? withVideo(e, map) : e)),
    trackEdits: state.trackEdits.map((t) => (folder && t.key.startsWith(`${folder}|`) ? deepStrings({ ...t, key: keyOf(t.key) }, map) : t)),
    reviews: state.reviews?.map((r) => (folder && r.key.startsWith(`${folder}|`) ? { ...r, key: keyOf(r.key) } : r)),
  };
}

// A preference key of this match that names a video: attack:<match>:v1, ... Only keys with the match or its folder in them.
export function renumberPrefKey(key: string, names: string[], map: VideoMap): string {
  const parts = key.split(/([:|])/);
  const hit = parts.some((p, i) => i % 2 === 0 && names.includes(p));
  if (!hit) return key;
  return parts.map((p, i) => (i % 2 === 0 && ID.test(p) ? (map[p] ?? p) : p)).join("");
}
