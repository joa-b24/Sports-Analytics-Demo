"use client";

// Files of the repository next to the app (app/api/local): the video, calibration and tracking of each match folder.
// They only exist while the app runs on this computer; every function here fails softly (null / false) otherwise, and
// the screens keep their "choose a file" buttons.

// Names of match folders: aaaa_mm_dd_<local>_vs_<visitante>, lower case, letters, digits and _ (same rule as
// sportsan.ingest.rename_match).
export const FOLDER_RULE = "aaaa_mm_dd_<local>_vs_<visitante>";
export function isFolderName(name: string): boolean {
  const m = name.match(/^(\d{4})_(\d{2})_(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*_vs_[a-z0-9]+(?:_[a-z0-9]+)*$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export interface LocalEntry {
  name: string;
  dir: boolean;
  size: number;
}

const base = "/api/local/";
const enc = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");

export const localUrl = (rel: string) => base + enc(rel);

// Files of a folder of the repository (for instance "matches/partido_2026_09_25/tracking"); null if not reachable.
export async function listLocal(rel: string): Promise<LocalEntry[] | null> {
  try {
    const r = await fetch(`${localUrl(rel)}?list`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as LocalEntry[]) : null;
  } catch {
    return null;
  }
}

export async function readLocal(rel: string): Promise<string | null> {
  try {
    const r = await fetch(localUrl(rel), { cache: "no-store" });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

// The same file as a File, for the screens that already take one from a file input.
export async function localFile(rel: string): Promise<File | null> {
  try {
    const r = await fetch(localUrl(rel), { cache: "no-store" });
    return r.ok ? new File([await r.blob()], rel.split("/").pop() ?? rel) : null;
  } catch {
    return null;
  }
}

export async function writeLocal(rel: string, text: string): Promise<boolean> {
  try {
    const r = await fetch(localUrl(rel), { method: "PUT", body: text });
    return r.ok;
  } catch {
    return false;
  }
}

// URL of the video of `videoId` in a match folder (video/<videoId>.<ext>), or null if it is not there.
export async function localVideo(folder: string, videoId: string): Promise<string | null> {
  const files = await listLocal(`matches/${folder}/video`);
  const hit = files?.find((f) => !f.dir && f.name.startsWith(`${videoId}.`) && /\.(mp4|webm|mkv|mov)$/i.test(f.name));
  return hit ? localUrl(`matches/${folder}/video/${hit.name}`) : null;
}

// Names of the processed parts of a video in a listing of its tracking folder.
export const tracksParts = (files: LocalEntry[] | null, videoId: string) =>
  (files ?? []).filter((f) => !f.dir && new RegExp(`^tracks_${videoId}_\\d+_\\d+\\.json$`).test(f.name)).map((f) => f.name);
