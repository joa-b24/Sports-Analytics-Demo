// The folder of a match in matches/ (rule 14: aaaa_mm_dd_<local>_vs_<visitante>), created by the app when it is missing.
// Pure functions shared by the browser and by app/api/local (which does the writing, with a strict whitelist).

export const FOLDER_SUBDIRS = ["video", "tracking"] as const;

// Lower case, letters, digits and _, with a real date (same rule as sportsan.ingest.rename_match).
export function isFolderName(name: string): boolean {
  const m = name.match(/^(\d{4})_(\d{2})_(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*_vs_[a-z0-9]+(?:_[a-z0-9]+)*$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// The folder a request may create: exactly matches/<name> with a conforming name, nothing else (no '..', no subpath).
export function creatableFolder(rel: string): string | null {
  const parts = rel.split("/");
  return parts.length === 2 && parts[0] === "matches" && isFolderName(parts[1]) ? parts[1] : null;
}

export interface FolderMeta {
  kind?: string;
  date?: string;
  own_team_name?: string;
  other_team_name?: string;
}
const KINDS = ["own", "rival", "reference"];
const q = (v: string | undefined) => JSON.stringify(v && v.trim() ? v.trim().replace(/[\r\n]+/g, " ").slice(0, 80) : "REEMPLAZAR");

// Same shape as sportsan.ingest.download_videos.new_match_yaml, so Python adds its videos to it and the app's
// FolderSync (lib/matchYaml.ts) keeps its lines up to date. No video entry: the download adds it with its exact fps.
export function minimalMatchYaml(folder: string, meta: FolderMeta): string {
  const kind = KINDS.includes(meta.kind ?? "") ? meta.kind : "own";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? "") ? meta.date : undefined;
  return (
    `match_id: ${folder}\n` +
    `kind: ${kind}\n` +
    `date: ${q(date)}\n` +
    `own_team_name: ${q(meta.own_team_name)}\n` +
    `other_team_name: ${q(meta.other_team_name)}\n` +
    "analysis_stride: 3\n\n" +
    "venue:\n" +
    '  name: "REEMPLAZAR"\n\n' +
    "# Un partido puede venir en varios videos. t_video es el tiempo dentro de cada video.\n" +
    "videos:\n"
  );
}

// Body of the creation request (JSON): anything that is not a string is ignored.
export function folderMetaOf(body: unknown): FolderMeta {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  return { kind: s("kind"), date: s("date"), own_team_name: s("own_team_name"), other_team_name: s("other_team_name") };
}
