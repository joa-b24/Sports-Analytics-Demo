// The zip of a match, read on the device (the laptop's version is app/api/unzip). Same two steps and same answers as the
// server: first what the zip holds, then writing it into matches/<folder>/ — a file that already exists is only replaced
// when asked. Entries are decompressed one at a time while writing, so the whole match is never in memory at once.
import { unzipSync } from "fflate";
import type { Fs } from "./mobileFs.ts";
import { planZip, type ZipPlanEntry } from "./uploads.ts";

interface Answer {
  ok: boolean;
  status: number;
  exists?: boolean;
  error?: string;
  json?: unknown;
}

const held = new Map<string, { file: Blob; entries: ZipPlanEntry[] }>();

const bytesOf = async (file: Blob) => new Uint8Array(await file.arrayBuffer());

// Step 1: the entries and, when there is one, the text of match.yaml. Nothing is written.
export async function inspectZipHere(fs: Fs, file: Blob): Promise<Answer> {
  void fs;
  let listed: { name: string; size: number }[] = [];
  let yaml: string | null = null;
  try {
    const data = await bytesOf(file);
    unzipSync(data, {
      filter: (f) => {
        listed.push({ name: f.name, size: f.originalSize });
        return false;
      },
    });
    const plan = planZip(listed);
    const y = plan.entries.find((e) => e.inner === "match.yaml");
    if (y) {
      const one = unzipSync(data, { filter: (f) => f.name === y.name });
      const bytes = one[y.name];
      yaml = bytes ? new TextDecoder().decode(bytes) : null;
    }
    const token = `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    held.set(token, { file, entries: plan.entries });
    listed = [];
    return { ok: true, status: 200, json: { token, top: plan.top, entries: plan.entries, yaml } };
  } catch {
    return { ok: false, status: 400, error: "No se pudo leer el zip (¿está dañado o es muy grande para este dispositivo?)." };
  }
}

// Step 2: writes the accepted entries under matches/<folder>/. 409 with the list of files that would be replaced.
export async function applyZipHere(fs: Fs, token: string, folder: string, overwrite: boolean): Promise<Answer> {
  const z = held.get(token);
  if (!z) return { ok: false, status: 410, error: "El zip ya no está en memoria: súbelo de nuevo." };
  const accepted = z.entries.filter((e) => e.inner);
  const skipped = z.entries.filter((e) => !e.inner).map((e) => ({ name: e.name }));
  if (!overwrite) {
    const conflicts: string[] = [];
    for (const e of accepted) if (await fs.exists(`matches/${folder}/${e.inner}`)) conflicts.push(e.inner as string);
    if (conflicts.length) return { ok: false, status: 409, exists: true, json: { conflicts } };
  }
  const data = await bytesOf(z.file);
  const written: { inner: string; size: number }[] = [];
  const failed: { inner: string; error: string }[] = [];
  for (const e of accepted) {
    const inner = e.inner as string;
    try {
      const got = unzipSync(data, { filter: (f) => f.name === e.name })[e.name];
      if (!got) throw new Error("no está en el zip");
      const at = await fs.write(`matches/${folder}/${inner}`, new Blob([got as BlobPart]));
      if (at === null) throw new Error("ruta no válida");
      written.push({ inner, size: got.length });
    } catch (err) {
      failed.push({ inner, error: err instanceof Error ? err.message : "error" });
    }
  }
  held.delete(token);
  return { ok: true, status: 200, json: { written, failed, skipped } };
}

export const dropZipHere = (token: string) => void held.delete(token);
