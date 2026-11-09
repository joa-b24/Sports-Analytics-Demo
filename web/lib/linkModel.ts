// The link model of a match (tracking/link_model.json): one per match, used by every video, trained by
// sportsan.tracking.links_eval from the parts corrected by hand (labels_<part>.json). Pure functions: what the Anclas panel
// says about it from the listing of matches/<id>/tracking.

export interface DirEntry {
  name: string;
  dir?: boolean;
  mtime?: number;
}

export interface LinkModelStatus {
  hasModel: boolean;
  // Parts with labels (and their tracks_ file), e.g. v1_41994_43460.
  labelParts: string[];
  // Video prefixes of those parts (v1, v2), in order of appearance.
  videos: string[];
  // Parts whose labels are newer than the model (empty without a model or without mtimes).
  newer: string[];
}

const LABELS = /^labels_(v\d+_\d+_\d+)\.json$/;

export function linkModelStatus(entries: readonly DirEntry[] | null | undefined): LinkModelStatus {
  const files = (entries ?? []).filter((e) => !e.dir);
  const names = new Set(files.map((e) => e.name));
  const labelParts: string[] = [];
  const mtimeOf = new Map<string, number | undefined>();
  for (const e of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const m = LABELS.exec(e.name);
    if (!m || !names.has(`tracks_${m[1]}.json`)) continue;
    labelParts.push(m[1]);
    mtimeOf.set(m[1], e.mtime);
  }
  const videos: string[] = [];
  for (const p of labelParts) {
    const v = p.split("_")[0];
    if (!videos.includes(v)) videos.push(v);
  }
  const model = files.find((e) => e.name === "link_model.json");
  const newer = model && model.mtime != null ? labelParts.filter((p) => (mtimeOf.get(p) ?? 0) > (model.mtime as number)) : [];
  return { hasModel: !!model, labelParts, videos, newer };
}

// The notice of the panel: null when there is nothing to say.
export type LinkModelNotice =
  | { kind: "missing"; text: string; canTrain: true }
  | { kind: "no-labels"; text: string; canTrain: false }
  | { kind: "stale"; text: string; canTrain: true };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function linkModelNotice(s: LinkModelStatus): LinkModelNotice | null {
  if (!s.hasModel) {
    if (!s.labelParts.length)
      return {
        kind: "no-labels",
        canTrain: false,
        text: "Falta el modelo de uniones de este partido y aún no hay con qué entrenarlo. Primero corrige y guarda una parte en la mesa (con nombres de jugadoras): eso crea sus etiquetas.",
      };
    return {
      kind: "missing",
      canTrain: true,
      text: `Falta el modelo de uniones de este partido. Se entrena una vez con las partes que ya corregiste (${plural(s.labelParts.length, "parte con etiquetas", "partes con etiquetas")}: ${s.labelParts.join(", ")}). ~8 min.`,
    };
  }
  if (s.newer.length)
    return {
      kind: "stale",
      canTrain: true,
      text: `Hay ${plural(s.newer.length, "parte corregida más nueva", "partes corregidas más nuevas")} que el modelo de uniones (${s.newer.join(", ")}). Puedes reentrenarlo para que las use; no hace falta.`,
    };
  return null;
}
