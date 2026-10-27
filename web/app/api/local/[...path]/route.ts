import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { folderMetaOf } from "@/lib/matchFolder";
import { createMatchFolderOnDisk } from "@/lib/matchFolderDisk";
import { uploadTarget } from "@/lib/uploads";

// Files of the repository, read and written by the app while it runs on this computer (npm run dev): the video of a
// match, its calibration and tracking files, segments.csv, match.yaml and the squad. A deployed app has no repository
// next to it, so there this answers 404 and the app falls back to choosing files by hand.
//
//   GET  /api/local/<ruta>          the file (videos with byte ranges, so they can be seeked)
//   GET  /api/local/<carpeta>?list  the files of a folder
//   PUT  /api/local/<ruta>          writes the body (only the files listed in WRITABLE); answers its mtime
//   DELETE /api/local/<ruta>        only an old backup of a match (respaldo/respaldo_*.json)
//   POST /api/local/matches/<carpeta>?create=folder   creates the folder of a match (video/, tracking/, minimal match.yaml)
//                                   when it is missing; only a name following aaaa_mm_dd_<local>_vs_<visitante>, and
//                                   nothing that already exists is overwritten
//   POST /api/local/<ruta>          uploads a file of a match folder from Datos (lib/uploads.ts says which), streamed
//                                   to disk (a video of several GB never sits in memory); 409 if it exists, unless
//                                   ?overwrite=1

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
// Only these parts of the repository are reachable.
// `weights` only to list it (the ball models present); the files inside are not reachable.
const READABLE = [/^matches$/, /^weights$/, /^matches\/[\w.-]+(\/.*)?$/, /^config\/roster\.json$/, /^data\/strava(\/.*)?$/, /^data\/boards(\/.*)?$/];
// Backups of one match (lib/saveAll.ts backupName): the only files the app may delete (to keep the 5 newest).
const BACKUP = /^matches\/[\w.-]+\/respaldo\/respaldo_\d{4}-\d{2}-\d{2}_\d{4}\.json$/;
const WRITABLE = [
  /^matches\/[\w.-]+\/tracking\/(tracks_fixed|anchors|labels)_[\w.-]+\.json$/,
  // Hand samples of the ball for training (Playground > Balón, lib/playground.ts); read by sportsan.tracking.ball train.
  /^matches\/[\w.-]+\/tracking\/ball_samples_v\d+\.json$/,
  // Possession check (Playground > Posesión, lib/possession.ts): the interval table of a video and the analyst's verdicts on it.
  /^matches\/[\w.-]+\/possession_v\d+\.csv$/,
  /^matches\/[\w.-]+\/possession_review_v\d+\.json$/,
  // Check of the passes read from the tracking (Playground > Pases, lib/playgroundPasses.ts): the analyst's verdicts on them.
  /^matches\/[\w.-]+\/passes_review_v\d+\.json$/,
  // Event detections of a video and the analyst's verdicts on them (Playground > Eventos, lib/eventDetect.ts, lib/eventReview.ts).
  /^matches\/[\w.-]+\/events_auto_v\d+\.json$/,
  /^matches\/[\w.-]+\/events_review_v\d+\.json$/,
  // Suggested events of a video waiting for the analyst's answer in the review pass (lib/processes.ts, «Procesos del partido» > Eventos).
  /^matches\/[\w.-]+\/events_suggest_v\d+\.json$/,
  /^matches\/[\w.-]+\/(match\.yaml|segments\.csv)$/,
  // Anchors named in the anchors mode of the table (lib/anchors.ts); suggest_ and links_ are written by Python.
  /^matches\/[\w.-]+\/tracking\/auto\/(ejemplo\/)?anchors_[\w.-]+\.json$/,
  // Data of the report (lib/report.ts), kept next to the match; out of git (it carries player names).
  /^matches\/[\w.-]+\/report_[\w.-]+\.json$/,
  // Drawings over the video of a play (lib/clips.ts) and the list of clips of the report; out of git (names).
  /^matches\/[\w.-]+\/edits\/edit_[\w.-]+\.json$/,
  /^matches\/[\w.-]+\/clips_[\w.-]+\.json$/,
  // A board play exported for the render (sportsan.clips.render --board).
  /^data\/boards\/board_[\w.-]+\.json$/,
  /^config\/roster\.json$/,
  // Answers of a review sample (sportsan.tracking.links_review / jumps_review, page /revision).
  /^matches\/[\w.-]+\/tracking\/revision\/[\w.-]+\/respuestas\.json$/,
  // «Guardar todo» of a match (lib/saveMatch.ts): its events as CSV and a backup of its browser data.
  /^matches\/[\w.-]+\/(events\/)?events_[\w.-]+\.csv$/,
  BACKUP,
];
const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".csv": "text/csv; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";

// Repository-relative path of the request, or null when it is outside what may be touched.
function resolve(parts: string[], allowed: RegExp[]): { rel: string; abs: string } | null {
  const rel = parts.map((p) => decodeURIComponent(p)).join("/");
  if (rel.split("/").some((p) => p === ".." || p === "") || !allowed.some((r) => r.test(rel))) return null;
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) return null;
  return { rel, abs };
}

const notFound = () => new Response("No disponible", { status: 404 });

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (!enabled()) return notFound();
  const { path: parts } = await ctx.params;
  const target = resolve(parts, READABLE);
  if (!target) return notFound();
  const info = await stat(target.abs).catch(() => null);
  if (!info) return notFound();

  if (info.isDirectory()) {
    if (!new URL(req.url).searchParams.has("list")) return notFound();
    const entries = await readdir(target.abs, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (e) => {
        const st = await stat(path.join(target.abs, e.name));
        return { name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, mtime: st.mtimeMs };
      }),
    );
    return Response.json(files.sort((a, b) => a.name.localeCompare(b.name)), { headers: { "Cache-Control": "no-store" } });
  }

  const type = TYPES[path.extname(target.abs).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || end < start) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    const body = Readable.toWeb(createReadStream(target.abs, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { "Content-Type": type, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${info.size}`, "Accept-Ranges": "bytes" },
    });
  }
  const body = Readable.toWeb(createReadStream(target.abs)) as ReadableStream;
  return new Response(body, { headers: { "Content-Type": type, "Content-Length": String(info.size), "Accept-Ranges": "bytes", "Cache-Control": "no-store" } });
}

export async function PUT(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (!enabled()) return notFound();
  const { path: parts } = await ctx.params;
  const target = resolve(parts, WRITABLE);
  if (!target) return new Response("Ese archivo no se puede escribir desde la app", { status: 403 });
  const text = await req.text();
  if (text.length > 60_000_000) return new Response("Demasiado grande", { status: 413 });
  await mkdir(path.dirname(target.abs), { recursive: true });
  await writeFile(target.abs, text, "utf-8");
  return Response.json({ ok: true, path: target.rel, mtime: (await stat(target.abs)).mtimeMs });
}

// Only old backups of a match («Guardar todo» keeps the 5 newest).
export async function DELETE(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (!enabled()) return notFound();
  const { path: parts } = await ctx.params;
  const target = resolve(parts, [BACKUP]);
  if (!target) return new Response("Ese archivo no se puede borrar desde la app", { status: 403 });
  await rm(target.abs, { force: true });
  return Response.json({ ok: true, path: target.rel });
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (!enabled()) return notFound();
  const { path: parts } = await ctx.params;
  const rel = parts.map((p) => decodeURIComponent(p)).join("/");
  if (new URL(req.url).searchParams.get("create") === "folder") {
    const done = await createMatchFolderOnDisk(ROOT, rel, folderMetaOf(await req.json().catch(() => null)));
    return done.ok ? Response.json({ ok: true, path: rel, created: done.created, yaml: done.yaml }) : Response.json({ error: done.error }, { status: done.status });
  }
  const target = uploadTarget(rel) ? resolve(parts, [/^matches\/[^/]+\/.+$/]) : null;
  if (!target) return Response.json({ error: "Ese archivo no se puede subir a la carpeta de un partido" }, { status: 403 });
  if (!req.body) return Response.json({ error: "Archivo vacío" }, { status: 400 });
  const existing = await stat(target.abs).catch(() => null);
  if (existing?.isDirectory()) return Response.json({ error: "Ya hay una carpeta con ese nombre" }, { status: 409 });
  if (existing && new URL(req.url).searchParams.get("overwrite") !== "1") {
    return Response.json({ exists: true, size: existing.size, path: target.rel }, { status: 409 });
  }
  await mkdir(path.dirname(target.abs), { recursive: true });
  // Written next to the target and renamed at the end: an interrupted upload never leaves half a file under the real
  // name (*.part is out of git).
  const part = `${target.abs}.${process.pid}.${Date.now()}.part`;
  try {
    await pipeline(Readable.fromWeb(req.body as import("node:stream/web").ReadableStream), createWriteStream(part));
    const size = (await stat(part)).size;
    if (size === 0) throw new Error("Archivo vacío");
    await rename(part, target.abs);
    return Response.json({ ok: true, path: target.rel, size });
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    const busy = (e as NodeJS.ErrnoException).code === "EPERM" || (e as NodeJS.ErrnoException).code === "EBUSY";
    return Response.json(
      { error: busy ? "El archivo está abierto en otro programa (o en el reproductor): ciérralo y vuelve a intentarlo" : `No se pudo guardar: ${(e as Error).message}` },
      { status: busy ? 423 : 500 },
    );
  }
}
