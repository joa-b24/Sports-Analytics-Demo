import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

// Files of the repository, read and written by the app while it runs on this computer (npm run dev): the video of a
// match, its calibration and tracking files, segments.csv, match.yaml and the squad. A deployed app has no repository
// next to it, so there this answers 404 and the app falls back to choosing files by hand.
//
//   GET  /api/local/<ruta>          the file (videos with byte ranges, so they can be seeked)
//   GET  /api/local/<carpeta>?list  the files of a folder
//   PUT  /api/local/<ruta>          writes the body (only the files listed in WRITABLE)

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
// Only these parts of the repository are reachable.
const READABLE = [/^matches\/[\w.-]+(\/.*)?$/, /^config\/roster\.json$/, /^data\/strava(\/.*)?$/];
const WRITABLE = [
  /^matches\/[\w.-]+\/tracking\/(tracks_fixed|anchors|labels)_[\w.-]+\.json$/,
  /^matches\/[\w.-]+\/(match\.yaml|segments\.csv)$/,
  // Data of the report (lib/report.ts), kept next to the match; out of git (it carries player names).
  /^matches\/[\w.-]+\/report_[\w.-]+\.json$/,
  /^config\/roster\.json$/,
];
const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
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
      entries.map(async (e) => ({ name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : (await stat(path.join(target.abs, e.name))).size })),
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
  return Response.json({ ok: true, path: target.rel });
}
