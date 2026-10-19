import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import yauzl from "yauzl";
import { isMatchFolder, planZip, type ZipPlanEntry } from "@/lib/uploads";

// A .zip with a whole match folder (match.yaml, segments.csv, video/, tracking/, edits/) or a reference video, loaded
// from Datos while the app runs on this computer. Two steps, so nothing is written before the analyst has seen it:
//
//   POST   /api/unzip                         body = the zip, streamed to a temporary file -> {token, top, entries, yaml}
//   POST   /api/unzip?token=&folder=          unpacks the accepted entries into matches/<folder>/; 409 {conflicts} if
//          [&overwrite=1]                    any file is already there (nothing written), unless overwrite=1
//   DELETE /api/unzip?token=                  drops the temporary file
//
// Only the paths of lib/uploads.ts are written (no zip slip: every entry is checked and resolved under the folder),
// each one streamed to a .part file and renamed at the end. Deployed on the web this answers 404.

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
const MATCHES = path.join(ROOT, "matches");
const TMP = path.join(os.tmpdir(), "sportsan-upload");
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";
const notFound = () => new Response("No disponible", { status: 404 });
const tokenFile = (token: string | null) => (token && /^[a-f0-9]{32}$/.test(token) ? path.join(TMP, `${token}.zip`) : null);

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((ok, fail) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? fail(err) : ok(zip))));
}

function entries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((ok, fail) => {
    const out: yauzl.Entry[] = [];
    zip.on("entry", (e: yauzl.Entry) => {
      out.push(e);
      zip.readEntry();
    });
    zip.once("end", () => ok(out));
    zip.once("error", fail);
    zip.readEntry();
  });
}

function readStream(zip: yauzl.ZipFile, e: yauzl.Entry): Promise<Readable> {
  return new Promise((ok, fail) => zip.openReadStream(e, (err, s) => (err || !s ? fail(err) : ok(s))));
}

async function readText(zip: yauzl.ZipFile, e: yauzl.Entry): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of await readStream(zip, e)) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

// Temporary zips forgotten by a closed tab: removed after six hours.
async function sweep() {
  const files = await readdir(TMP).catch(() => [] as string[]);
  const old = Date.now() - 6 * 3600_000;
  for (const f of files) {
    const s = await stat(path.join(TMP, f)).catch(() => null);
    if (s && s.mtimeMs < old) await rm(path.join(TMP, f), { force: true }).catch(() => {});
  }
}

async function inspect(req: Request) {
  if (!req.body) return Response.json({ error: "Archivo vacío" }, { status: 400 });
  await mkdir(TMP, { recursive: true });
  void sweep();
  const token = randomUUID().replace(/-/g, "");
  const file = tokenFile(token)!;
  try {
    await pipeline(Readable.fromWeb(req.body as NodeReadableStream), createWriteStream(file));
  } catch (e) {
    await rm(file, { force: true });
    return Response.json({ error: `No se pudo recibir el zip: ${(e as Error).message}` }, { status: 500 });
  }
  let zip: yauzl.ZipFile | null = null;
  try {
    zip = await openZip(file);
    const list = await entries(zip);
    const plan = planZip(list.map((e) => ({ name: e.fileName, size: e.uncompressedSize })));
    // match.yaml is read now (it is small), so the screen can show which match the zip brings.
    const yamlEntry = plan.entries.find((p) => p.inner === "match.yaml");
    const raw = yamlEntry ? list.find((e) => e.fileName.replace(/\\/g, "/") === yamlEntry.name) : undefined;
    const yaml = raw && raw.uncompressedSize < 1_000_000 ? await readText(zip, raw) : null;
    return Response.json({ token, top: plan.top, entries: plan.entries, yaml });
  } catch (e) {
    await rm(file, { force: true });
    // yauzl refuses names that climb out of the folder or are absolute: the whole zip is refused, not only that entry.
    const unsafe = /invalid (relative path|characters in fileName)|absolute path/i.test((e as Error)?.message ?? "");
    return Response.json(
      { error: unsafe ? `El zip trae rutas inseguras (${(e as Error).message}): no se descomprime nada` : "Ese archivo no es un .zip válido (o está dañado)" },
      { status: 400 },
    );
  } finally {
    zip?.close();
  }
}

async function apply(token: string, folder: string, overwrite: boolean) {
  const file = tokenFile(token);
  if (!file || !(await stat(file).catch(() => null))) return Response.json({ error: "El zip ya no está: vuelve a elegirlo" }, { status: 410 });
  if (!isMatchFolder(folder)) return Response.json({ error: "Nombre de carpeta no válido" }, { status: 400 });
  const base = path.resolve(MATCHES, folder);
  if (!base.startsWith(MATCHES + path.sep)) return Response.json({ error: "Nombre de carpeta no válido" }, { status: 400 });

  const zip = await openZip(file);
  // Kept when the answer is a 409, so the analyst can confirm without sending the zip again.
  let keep = false;
  try {
    const list = await entries(zip);
    const plan = planZip(list.map((e) => ({ name: e.fileName, size: e.uncompressedSize })));
    const byName = new Map(list.map((e) => [e.fileName.replace(/\\/g, "/"), e]));
    const todo: { entry: yauzl.Entry; plan: ZipPlanEntry; abs: string }[] = [];
    for (const p of plan.entries) {
      if (!p.inner) continue;
      const abs = path.resolve(base, p.inner);
      if (!abs.startsWith(base + path.sep)) continue;
      todo.push({ entry: byName.get(p.name)!, plan: p, abs });
    }
    const conflicts: string[] = [];
    for (const t of todo) if (await stat(t.abs).catch(() => null)) conflicts.push(t.plan.inner!);
    if (conflicts.length && !overwrite) {
      keep = true;
      return Response.json({ conflicts }, { status: 409 });
    }

    const written: { inner: string; size: number }[] = [];
    const failed: { inner: string; error: string }[] = [];
    for (const t of todo) {
      const part = `${t.abs}.${process.pid}.${Date.now()}.part`;
      try {
        if (t.entry.isEncrypted()) throw new Error("está cifrado");
        await mkdir(path.dirname(t.abs), { recursive: true });
        await pipeline(await readStream(zip, t.entry), createWriteStream(part));
        await rename(part, t.abs);
        written.push({ inner: t.plan.inner!, size: t.plan.size });
      } catch (e) {
        await rm(part, { force: true }).catch(() => {});
        failed.push({ inner: t.plan.inner!, error: (e as Error).message });
      }
    }
    const skipped = plan.entries.filter((p) => !p.inner).map((p) => ({ name: p.name, reason: p.reason ?? "" }));
    return Response.json({ folder, written, failed, skipped });
  } finally {
    zip.close();
    if (!keep) await rm(file, { force: true }).catch(() => {});
  }
}

export async function POST(req: Request) {
  if (!enabled()) return notFound();
  const q = new URL(req.url).searchParams;
  const token = q.get("token");
  if (!token) return inspect(req);
  return apply(token, q.get("folder") ?? "", q.get("overwrite") === "1");
}

export async function DELETE(req: Request) {
  if (!enabled()) return notFound();
  const file = tokenFile(new URL(req.url).searchParams.get("token"));
  if (file) await rm(file, { force: true }).catch(() => {});
  return Response.json({ ok: true });
}
