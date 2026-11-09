// Server side of the creation of a match folder (app/api/local, ?create=folder): subfolders and a minimal match.yaml,
// leaving everything that already exists as it is. Separate from the route so that it can be tested on a temporary folder.
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FOLDER_SUBDIRS, creatableFolder, minimalMatchYaml, type FolderMeta } from "./matchFolder.ts";

export type CreateResult = { ok: true; created: boolean; yaml: boolean } | { ok: false; status: number; error: string };

export async function createMatchFolderOnDisk(root: string, rel: string, meta: FolderMeta): Promise<CreateResult> {
  const name = creatableFolder(rel);
  if (!name) return { ok: false, status: 403, error: "El nombre de la carpeta no sigue aaaa_mm_dd_local_vs_visitante" };
  const dir = path.join(root, "matches", name);
  const existed = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
  for (const sub of FOLDER_SUBDIRS) await mkdir(path.join(dir, sub), { recursive: true });
  // "wx": an existing match.yaml is never replaced.
  try {
    await writeFile(path.join(dir, "match.yaml"), minimalMatchYaml(name, meta), { encoding: "utf-8", flag: "wx" });
    return { ok: true, created: !existed, yaml: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { ok: true, created: !existed, yaml: false };
    return { ok: false, status: 500, error: `No se pudo crear match.yaml: ${(e as Error).message}` };
  }
}
