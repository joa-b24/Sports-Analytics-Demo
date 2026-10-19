// What the Datos screen may write into a match folder (matches/<folder>/), shared by the browser and the server route
// (app/api/local, app/api/unzip): which paths are accepted, where a video or a tracking file goes, how the entries of a
// zip map onto the folder, and how a match.yaml becomes a match of the app. Pure functions: no storage, no React.
import { cleanEnd } from "./tagging.ts";
import { EMPTY_REPORT, EVENT_TYPES, type EventType, type Match, type MatchEvent, type MatchKind, type MatchVideo, type Team } from "./types.ts";

// Files of a match folder that can be uploaded, relative to the folder. Everything heavy or carrying player names
// (video/, tracking/, edits/, report_*.json, clips_*.json) is out of git (see .gitignore); match.yaml and segments.csv
// are small and versioned.
export const VIDEO_EXT = ["mp4", "webm", "mkv", "mov"] as const;
const INNER_RULES: { kind: UploadKind; re: RegExp }[] = [
  { kind: "video", re: /^video\/[\w-]+\.(mp4|webm|mkv|mov)$/i },
  { kind: "tracking", re: /^tracking\/(tracks|calib|library|anchors|labels|ball|tracking)_[\w.-]+\.(json|npz|parquet)$/ },
  { kind: "match", re: /^(match\.yaml|segments\.csv)$/ },
  { kind: "edits", re: /^edits\/edit_[\w.-]+\.json$/ },
  { kind: "report", re: /^(report|clips)_[\w.-]+\.json$/ },
];
export type UploadKind = "video" | "tracking" | "match" | "edits" | "report";

// Folders of matches/ the app may write into: letters, digits, _ . - and not starting with a dot.
export const isMatchFolder = (name: string) => /^[\w-][\w.-]*$/.test(name) && !name.includes("..");

// Kind of a path inside a match folder, or null when it may not be written.
export function innerKind(inner: string): UploadKind | null {
  if (inner.split("/").some((p) => p === "" || p === "." || p === "..")) return null;
  return INNER_RULES.find((r) => r.re.test(inner))?.kind ?? null;
}

// A repository path (matches/<folder>/<inner>) the app may upload, split; null otherwise.
export function uploadTarget(rel: string): { folder: string; inner: string; kind: UploadKind } | null {
  const m = rel.match(/^matches\/([^/]+)\/(.+)$/);
  if (!m || !isMatchFolder(m[1])) return null;
  const kind = innerKind(m[2]);
  return kind ? { folder: m[1], inner: m[2], kind } : null;
}

// Where a chosen video file goes: video/<videoId>.<ext>; null for a format the player cannot open.
export function videoInner(videoId: string, fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!/^[\w-]+$/.test(videoId) || !(VIDEO_EXT as readonly string[]).includes(ext)) return null;
  return `video/${videoId}.${ext}`;
}

// Where a chosen tracking file goes (tracking/<name>), or null if its name is not one the pipeline writes.
export function trackingInner(fileName: string): string | null {
  const inner = `tracking/${fileName}`;
  return innerKind(inner) === "tracking" ? inner : null;
}

// Entries of a zip, as written by any zip tool (backslashes, a top folder, matches/<id>/...), onto paths inside the
// match folder. A shared top folder (the match folder zipped as a whole) is removed; so is a leading matches/<id>/.
// Folders, hidden files (__MACOSX, .DS_Store) and anything outside the accepted paths come back with a reason.
export interface ZipPlanEntry {
  name: string;
  inner: string | null;
  kind: UploadKind | null;
  size: number;
  reason?: string;
}

export function zipTopFolder(names: string[]): string | null {
  const files = names.map((n) => n.replace(/\\/g, "/")).filter((n) => !n.endsWith("/") && !isJunk(n));
  if (files.length === 0) return null;
  const m = files[0].match(/^(matches\/[^/]+\/|[^/]+\/)/);
  if (!m) return null;
  const top = m[1];
  // A zip of the folder's contents (video/, tracking/...) has no top folder to remove.
  if (["video/", "tracking/", "edits/"].includes(top)) return null;
  return files.every((f) => f.startsWith(top)) ? top : null;
}

const isJunk = (n: string) => n.split("/").some((p) => p === "__MACOSX" || (p.startsWith(".") && p !== "." && p !== ".."));

export function planZip(entries: { name: string; size: number }[]): { top: string | null; entries: ZipPlanEntry[] } {
  const top = zipTopFolder(entries.map((e) => e.name));
  const out: ZipPlanEntry[] = [];
  for (const e of entries) {
    const name = e.name.replace(/\\/g, "/");
    if (name.endsWith("/")) continue;
    if (isJunk(name)) continue;
    const inner = top && name.startsWith(top) ? name.slice(top.length) : name;
    if (inner.startsWith("/") || /^[a-zA-Z]:/.test(inner)) {
      out.push({ name, inner: null, kind: null, size: e.size, reason: "ruta absoluta" });
      continue;
    }
    const kind = innerKind(inner);
    out.push(kind ? { name, inner, kind, size: e.size } : { name, inner: null, kind: null, size: e.size, reason: "no es un archivo de la carpeta de un partido" });
  }
  return { top, entries: out };
}

// The fields of a match.yaml the app uses. Only the simple layout this project writes (top-level `key: value` and the
// `videos:` list of `- key: value` items); comments and "REEMPLAZAR" placeholders are dropped, so a missing value stays
// missing.
export interface MatchYaml {
  match_id?: string;
  kind?: string;
  date?: string;
  own_team_name?: string;
  other_team_name?: string;
  videos: { video_id: string; youtube_id?: string; period?: 1 | 2; label?: string }[];
}

function scalar(raw: string): string | undefined {
  let v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    const end = v.indexOf(q, 1);
    v = end > 0 ? v.slice(1, end) : v.slice(1);
  } else {
    v = v.replace(/\s+#.*$/, "").trim();
  }
  if (v === "" || v === "~" || v === "null" || /^REEMPLAZAR$/i.test(v)) return undefined;
  return v;
}

export function parseMatchYaml(text: string): MatchYaml {
  const out: MatchYaml = { videos: [] };
  let section: string | null = null;
  let video: Record<string, string> | null = null;
  const pushVideo = () => {
    if (video?.video_id) {
      const p = Number(video.period);
      out.videos.push({
        video_id: video.video_id,
        ...(video.youtube_id ? { youtube_id: video.youtube_id } : {}),
        ...(p === 1 || p === 2 ? { period: p } : {}),
        ...(video.label ? { label: video.label } : {}),
      });
    }
    video = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const top = line.match(/^([A-Za-z_]\w*):(.*)$/);
    if (top) {
      if (section === "videos") pushVideo();
      section = top[1];
      const v = scalar(top[2]);
      if (v !== undefined && ["match_id", "kind", "date", "own_team_name", "other_team_name"].includes(top[1])) {
        (out as unknown as Record<string, string>)[top[1]] = v;
      }
      continue;
    }
    if (section !== "videos") continue;
    const item = line.match(/^\s*-\s+([A-Za-z_]\w*):(.*)$/);
    const field = line.match(/^\s+([A-Za-z_]\w*):(.*)$/);
    if (item) {
      pushVideo();
      video = {};
      const v = scalar(item[2]);
      if (v !== undefined) video[item[1]] = v;
    } else if (field && video) {
      const v = scalar(field[2]);
      if (v !== undefined) video[field[1]] = v;
    }
  }
  if (section === "videos") pushVideo();
  return out;
}

const KINDS: MatchKind[] = ["own", "rival", "reference"];

// The match of the app for a folder whose match.yaml was just loaded. With an existing match only what it lacks is
// filled in (videos it does not have, an empty link, date or team): what was typed in the app is never overwritten.
export function matchFromYaml(y: MatchYaml, folder: string, existing: Match | undefined, newId: string): Match {
  const videos: MatchVideo[] = y.videos.map((v, i) => ({
    video_id: v.video_id,
    youtube_id: v.youtube_id ?? "",
    label: v.label ?? (v.period === 2 || (v.period === undefined && i > 0) ? "2.º tiempo" : "1.er tiempo"),
    ...(v.period ? { period: v.period } : {}),
  }));
  if (!existing) {
    const focus = y.own_team_name ?? folder;
    const other = y.other_team_name ?? "Contrario";
    return {
      match_id: newId,
      name: `${focus} vs ${y.other_team_name ?? "?"}`,
      kind: KINDS.includes(y.kind as MatchKind) ? (y.kind as MatchKind) : "own",
      date: y.date && /^\d{4}-\d{2}-\d{2}$/.test(y.date) ? y.date : "",
      focus_team: focus,
      other_team: other,
      youtube_id: videos[0]?.youtube_id ?? "",
      ...(videos.length ? { videos } : {}),
      folder,
      report: { ...EMPTY_REPORT },
    };
  }
  const have: MatchVideo[] =
    existing.videos && existing.videos.length ? existing.videos : [{ video_id: "v1", youtube_id: existing.youtube_id, label: "1.er tiempo" }];
  const merged = have.map((v) => {
    const y2 = videos.find((x) => x.video_id === v.video_id);
    return y2 && !v.youtube_id && y2.youtube_id ? { ...v, youtube_id: y2.youtube_id } : v;
  });
  for (const v of videos) if (!merged.some((m) => m.video_id === v.video_id)) merged.push(v);
  return {
    ...existing,
    folder: existing.folder ?? folder,
    date: existing.date || (y.date && /^\d{4}-\d{2}-\d{2}$/.test(y.date) ? y.date : ""),
    focus_team: existing.focus_team || y.own_team_name || existing.focus_team,
    other_team: existing.other_team && existing.other_team !== "Contrario" ? existing.other_team : (y.other_team_name ?? existing.other_team),
    youtube_id: merged[0]?.youtube_id ?? existing.youtube_id,
    videos: merged,
  };
}

// "1.4 GB", "820 KB": sizes for the upload messages.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// Columns of the events CSV (docs/data_contract.md), in the order they are exported.
export const EVENT_COLUMNS = ["event_id", "match_id", "video_id", "t_video", "period", "type", "team", "player_id", "x", "y", "outcome", "detail", "note", "x_end", "y_end", "goal_y", "goal_z"];

// Empty or non-numeric cells become null (the contract's NaN): never filled in.
const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

// Rows of an events CSV onto events of one match. A row without a valid t_video (seconds, >= 0) or with a type outside
// the catalogue is skipped and counted; coordinates outside the 105 x 68 pitch become missing, an unknown team "unk".
export function eventsFromCsv(rows: Record<string, string>[], matchId: string, makeId: () => string): { events: MatchEvent[]; skipped: number; offPitch: number } {
  const events: MatchEvent[] = [];
  let skipped = 0;
  let offPitch = 0;
  const coord = (v: number | null, max: number) => {
    if (v === null) return null;
    if (v < 0 || v > max) {
      offPitch++;
      return null;
    }
    return v;
  };
  for (const r of rows) {
    const t = num(r.t_video);
    const type = (r.type ?? "").trim();
    if (t === null || t < 0 || !(EVENT_TYPES as readonly string[]).includes(type)) {
      skipped++;
      continue;
    }
    const team = (r.team ?? "").trim();
    events.push({
      event_id: makeId(),
      match_id: matchId,
      video_id: r.video_id?.trim() || "v1",
      t_video: t,
      period: r.period?.trim() === "2" ? 2 : 1,
      type: type as EventType,
      team: (["own", "opp", "ref", "unk"].includes(team) ? team : "unk") as Team,
      player_id: r.player_id?.trim() || null,
      x: coord(num(r.x), 105),
      y: coord(num(r.y), 68),
      outcome: r.outcome?.trim() || null,
      detail: r.detail?.trim() || null,
      note: r.note || null,
      ...cleanEnd(type as EventType, { x_end: coord(num(r.x_end), 105), y_end: coord(num(r.y_end), 68), goal_y: num(r.goal_y), goal_z: num(r.goal_z) }),
    });
  }
  return { events, skipped, offPitch };
}
