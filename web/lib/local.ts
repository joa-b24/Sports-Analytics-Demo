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

// A folder name following the rule, from the date and the two teams (lower case, no accents); "" without a date.
export function suggestFolder(date: string, home: string, away: string): string {
  const slug = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d || !slug(home) || !slug(away)) return "";
  return `${d[1]}_${d[2]}_${d[3]}_${slug(home)}_vs_${slug(away)}`;
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

// What the steps of a match read from its folder: the files in tracking/ ([] when the folder exists without it); null
// when the folder cannot be reached.
export async function readFolderFiles(folder: string): Promise<{ tracking: string[] } | null> {
  const files = await listLocal(`matches/${folder}/tracking`);
  if (files) return { tracking: files.map((f) => f.name) };
  return (await listLocal(`matches/${folder}`)) ? { tracking: [] } : null;
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

// Whether the repository is reachable (the app runs on this computer): the uploads of Datos only work then.
export async function localAvailable(): Promise<boolean> {
  return (await listLocal("matches")) !== null;
}

export interface UploadResult {
  ok: boolean;
  // 409: the file is already there (send again with overwrite to replace it).
  exists?: boolean;
  error?: string;
  json?: unknown;
}

// Sends a file (or any body) by XHR, which reports the bytes sent; the browser streams the File from disk, so a video of
// several GB is not read into memory. The `abort` signal cancels it.
function send(method: string, url: string, body: Blob | null, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<UploadResult & { status: number }> {
  return new Promise((done) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : (body?.size ?? 0));
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {}
      const err = (json as { error?: string } | null)?.error;
      done({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, exists: xhr.status === 409, error: err ?? (xhr.status === 404 ? "No disponible: la app no corre en esta computadora" : undefined), json });
    };
    xhr.onerror = () => done({ ok: false, status: 0, error: "Se perdió la conexión con la app" });
    xhr.onabort = () => done({ ok: false, status: 0, error: "Cancelado" });
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(body);
  });
}

// Uploads a file to a path of a match folder (lib/uploads.ts says which ones), never replacing one without overwrite.
export function uploadLocal(rel: string, file: Blob, opts: { overwrite?: boolean; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {}) {
  return send("POST", `${localUrl(rel)}${opts.overwrite ? "?overwrite=1" : ""}`, file, opts.onProgress, opts.signal);
}

export interface ZipInspection {
  token: string;
  top: string | null;
  entries: { name: string; inner: string | null; kind: string | null; size: number; reason?: string }[];
  yaml: string | null;
}

// Step 1 of a zip: sends it and gets back what it contains (nothing is written into matches/ yet).
export function inspectZip(file: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal) {
  return send("POST", "/api/unzip", file, onProgress, signal);
}

// Step 2: unpacks it into matches/<folder>/. A 409 lists the files that are already there.
export function applyZip(token: string, folder: string, overwrite: boolean) {
  return send("POST", `/api/unzip?token=${token}&folder=${encodeURIComponent(folder)}${overwrite ? "&overwrite=1" : ""}`, null);
}

export function dropZip(token: string) {
  return fetch(`/api/unzip?token=${token}`, { method: "DELETE" }).catch(() => null);
}
