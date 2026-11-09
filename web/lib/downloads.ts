// Automatic download of the videos of a match that are registered with a YouTube link but have no file in
// matches/<id>/video/. The browser decides what to download (these pure functions); app/api/run starts
// `python -m sportsan.ingest.download_videos` (yt-dlp with the options of CLAUDE.md, «Descargar un video») only when the app
// runs on this computer. The video is never edited or joined (rule 3) and never goes to the repository (.gitignore).
import type { MatchVideo } from "./types.ts";

export const YT_ID = /^[\w-]{11}$/;
const MATCH = /^[\w.-]+$/;
const VIDEO = /^v\d+$/;

export interface DownloadArgs {
  match: string;
  video: string;
  youtubeId: string;
}

// Strict whitelist: the values go to a command line (as separate arguments, never through a shell).
export function validateDownload(body: unknown): { ok: true; args: DownloadArgs } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.match !== "string" || !MATCH.test(b.match) || b.match.includes("..")) return { ok: false, error: "Partido no válido." };
  if (typeof b.video !== "string" || !VIDEO.test(b.video)) return { ok: false, error: "Video no válido." };
  if (typeof b.youtubeId !== "string" || !YT_ID.test(b.youtubeId)) return { ok: false, error: "El enlace de YouTube no es válido." };
  return { ok: true, args: { match: b.match, video: b.video, youtubeId: b.youtubeId } };
}

export const downloadArgv = (a: DownloadArgs): string[] => ["-m", "sportsan.ingest.download_videos", "--match", a.match, "--video", a.video, "--youtube-id", a.youtubeId];

// The command to copy when the app does not run on this computer.
export const downloadCommand = (match: string, video: string, youtubeId: string) =>
  `python -m sportsan.ingest.download_videos --match ${match} --video ${video} --youtube-id ${youtubeId}`;

// The finished file of a video in the listing of video/ (video/v1.mp4): not the *.part of a download in progress, not
// the v1.f137.mp4 pieces yt-dlp leaves while it merges, not the light copy (v1_proxy.mp4).
export function videoFileOf(names: string[] | null | undefined, videoId: string): string | null {
  if (!names) return null;
  const prefix = `${videoId}.`;
  return names.find((n) => n.startsWith(prefix) && /^(mp4|webm|mkv|mov)$/i.test(n.slice(prefix.length))) ?? null;
}

export type VideoLike = Pick<MatchVideo, "video_id" | "youtube_id" | "label">;
// Registered videos (with a link) whose file is not in the folder. `names` null = the folder cannot be read: unknown, so none.
export function missingVideos(videos: VideoLike[], names: string[] | null | undefined): VideoLike[] {
  if (!names) return [];
  return videos.filter((v) => !!v.youtube_id && !videoFileOf(names, v.video_id));
}

// yt-dlp progress line: «[download]  45.3% of ~ 1.20GiB at 3.4MiB/s ETA 05:12». ETA is absent at the end or when unknown.
export function parseProgress(line: string | undefined): { pct: number; etaS: number | null } | null {
  const m = /\[download\]\s+(\d+(?:\.\d+)?)%(?:.*?ETA\s+((?:\d+:)?\d+:\d+))?/.exec(line ?? "");
  if (!m) return null;
  const eta = m[2] ? m[2].split(":").reduce((t, x) => t * 60 + Number(x), 0) : null;
  return { pct: Math.min(100, Number(m[1])), etaS: eta };
}

// A short message in Spanish from the output of a failed download (never the dump itself).
export function downloadError(lines: string[] | undefined): string {
  const text = (lines ?? []).join("\n");
  if (/No encuentro yt-dlp|No module named yt_dlp/.test(text)) return "Falta yt-dlp: pip install yt-dlp.";
  if (/Private video|Sign in to confirm|members-only|Join this channel/i.test(text)) return "El video es privado o pide iniciar sesión.";
  if (/Video unavailable|has been removed|not available|no longer available/i.test(text)) return "YouTube dice que el video no está disponible.";
  if (/CERTIFICATE|SSL/i.test(text)) return "Falló un certificado al conectar con YouTube.";
  if (/HTTP Error 4\d\d|Unable to download|getaddrinfo|timed out|Connection/i.test(text)) return "No se pudo conectar con YouTube (¿sin internet?).";
  if (/ffmpeg|ffprobe/i.test(text) && /not found|No such file/i.test(text)) return "Falta ffmpeg.";
  if (/No space left|disk full/i.test(text)) return "No hay espacio en el disco.";
  if (/ENOENT|python\.exe/.test(text)) return "No se encontró .venv/Scripts/python.exe en la raíz del repositorio.";
  return "La descarga falló. Revisa el registro en tracking/revision/.";
}

// What the analyst sees for one registered video.
export type DlState = "ready" | "pending" | "downloading" | "error" | "stopped" | "nolink" | "unknown";
export interface DlJob {
  state: "running" | "done" | "failed" | "stopped";
  last?: string;
  tail?: string[];
}
export interface DlView {
  state: DlState;
  pct: number | null;
  etaS: number | null;
  message: string;
}
// names: the listing of video/ (null = unreachable). job: the latest download job of this video, if any.
export function downloadView(i: { hasLink: boolean; names: string[] | null; videoId: string; job: DlJob | null }): DlView {
  const none = { pct: null, etaS: null, message: "" };
  if (i.names === null) return { state: "unknown", ...none };
  if (videoFileOf(i.names, i.videoId)) return { state: "ready", ...none };
  if (!i.hasLink) return { state: "nolink", ...none };
  const j = i.job;
  if (!j) return { state: "pending", ...none };
  if (j.state === "running") {
    const lines = j.tail ?? (j.last ? [j.last] : []);
    const p = [...lines].reverse().map(parseProgress).find((x) => x !== null) ?? null;
    return { state: "downloading", pct: p?.pct ?? null, etaS: p?.etaS ?? null, message: "" };
  }
  if (j.state === "stopped") return { state: "stopped", ...none, message: "Descarga cancelada." };
  if (j.state === "failed") return { state: "error", ...none, message: downloadError(j.tail ?? (j.last ? [j.last] : [])) };
  // «done» but the file is not there.
  return { state: "error", ...none, message: "Terminó sin dejar el archivo. Revisa el registro en tracking/revision/." };
}

export const DL_LABEL: Record<DlState, string> = {
  ready: "Descargado",
  pending: "Pendiente",
  downloading: "Descargando",
  error: "Error",
  stopped: "Cancelado",
  nolink: "Sin enlace",
  unknown: "",
};

interface JobRef {
  video: string;
  kind: string;
  state: string;
}
// Which video to download next by itself, or null. Only when the app reaches the folder, the switch is on, no download
// is running, and the video has a link, no file, no earlier job (a failed or cancelled one is retried by hand with
// «Reintentar», never by itself) and was not tried in this session.
export function nextAutoDownload(i: { auto: boolean; names: string[] | null; videos: VideoLike[]; jobs: JobRef[]; attempted: ReadonlySet<string> }): string | null {
  if (!i.auto || i.names === null) return null;
  const dl = i.jobs.filter((j) => j.kind === "download");
  if (dl.some((j) => j.state === "running")) return null;
  for (const v of missingVideos(i.videos, i.names)) {
    if (!YT_ID.test(v.youtube_id)) continue;
    if (i.attempted.has(v.video_id) || dl.some((j) => j.video === v.video_id)) continue;
    return v.video_id;
  }
  return null;
}

// The switch «Descargar videos que falten automáticamente» (Detalles técnicos): on unless explicitly turned off.
export const autoDownloadOn = (m: { tech?: { autoDownload?: boolean } } | null | undefined): boolean => m?.tech?.autoDownload !== false;
