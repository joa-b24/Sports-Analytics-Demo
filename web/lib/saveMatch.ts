"use client";

// Writing a match to its folder: one part (the «Guardar» of the table) or everything that changed («Guardar todo» of
// the match header). What changed is told by the fingerprints of lib/saveAll.ts, kept per folder in this browser
// (preference `saved:<folder>`, out of the backup: it describes this computer's disk). Never overwrites a file of the
// folder newer than the last save from here without asking.
import { useMemo } from "react";
import { DEFAULT_SMOOTH, buildFixed, fixedName, type SmoothCfg } from "./fixedExport";
import { buildLabels, labelsName } from "./labels";
import { deleteLocal, listLocal, readLocal, writeLocalInfo, type LocalEntry } from "./local";
import type { BallAuto } from "./parts";
import { backupName, backupsToDelete, eventsCsv, eventsPath, isConflict, matchBackup, matchItems, dirtyItems, parseKey, partId, type SaveItem, type SaveLog, type SaveRecord } from "./saveAll";
import { getPref, setPref, usePref } from "./store";
import { emptyEdits, type JerseyColors, type TracksFile } from "./tracks";
import type { Match, MatchEvent, State, TrackEdits } from "./types";

export const logPref = (folder: string) => `saved:${folder}`;
const parseLog = (text: string): SaveLog => {
  try {
    const v = JSON.parse(text || "{}") as SaveLog;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
export const readLog = (folder: string) => parseLog(getPref(logPref(folder), "{}"));
export function useSaveLog(folder: string | undefined): SaveLog {
  const text = usePref(logPref(folder ?? "_"), "{}");
  return useMemo(() => parseLog(text), [text]);
}
function record(folder: string, add: SaveLog) {
  setPref(logPref(folder), JSON.stringify({ ...readLog(folder), ...add }));
}

export const attackOf = (folder: string) => (video: string) => getPref(`attack:${folder}:${video}`, "");
// Autosave every 5 minutes (off unless chosen).
export const AUTOSAVE_PREF = "autosave";
export const AUTOSAVE_MS = 5 * 60 * 1000;

export type Choice = "overwrite" | "skip" | "cancel";
// Asked when a file of the folder is newer than the last save from this browser.
export type Ask = (path: string, why: string) => Promise<Choice>;

const NO_COLORS: Partial<JerseyColors> = {};

const conflictWhy = (entry: LocalEntry, rec: SaveRecord | undefined) =>
  rec
    ? `En la carpeta es de las ${new Date(entry.mtime ?? 0).toLocaleString("es-MX")}, más nuevo que el último guardado desde este navegador (${new Date(rec.at).toLocaleString("es-MX")}). Quizá lo reescribió Python.`
    : `Ya existe en la carpeta (${new Date(entry.mtime ?? 0).toLocaleString("es-MX")}) y nunca se guardó desde este navegador.`;

// Checks the files a save is about to write; "skip"/"cancel" if one of them must not be written.
async function check(paths: string[], listings: Map<string, LocalEntry[] | null>, rec: SaveRecord | undefined, ask: Ask): Promise<Choice> {
  for (const p of paths) {
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (!listings.has(dir)) listings.set(dir, await listLocal(dir));
    const entry = listings.get(dir)?.find((e) => e.name === p.slice(dir.length + 1));
    if (entry && isConflict(entry.mtime, rec)) {
      const c = await ask(p, conflictWhy(entry, rec));
      if (c !== "overwrite") return c;
    }
  }
  return "overwrite";
}

export interface PartInput {
  folder: string;
  file: TracksFile;
  edits: TrackEdits | undefined;
  hash: string;
  colors?: Partial<JerseyColors>;
  smooth: SmoothCfg | null;
  showRefs?: boolean;
  events: MatchEvent[];
  attack: string;
  ballAuto: BallAuto | null;
  // Salto máximo del balón (Detalles técnicos); absent: the default.
  ballJumpMs?: number;
}
export interface PartResult {
  state: "saved" | "skipped" | "cancelled" | "error";
  note: string;
  at?: number;
}

// One part: tracks_fixed (corrections, ball and smoothing) and labels, as the table always wrote them.
export async function savePart(p: PartInput, ask: Ask, listings = new Map<string, LocalEntry[] | null>()): Promise<PartResult> {
  const key = `${p.file.match_id}|${p.file.video_id}|${p.file.start_frame}_${p.file.end_frame}`;
  const id = partId(key);
  const dir = `matches/${p.folder}/tracking`;
  const fixedPath = `${dir}/${fixedName(p.file)}`;
  const labelsPath = `${dir}/${labelsName(p.file)}`;
  const choice = await check([fixedPath, labelsPath], listings, readLog(p.folder)[id], ask);
  if (choice !== "overwrite") return { state: choice === "skip" ? "skipped" : "cancelled", note: "No se guardó: el archivo de la carpeta es más nuevo." };
  const edits = p.edits ?? emptyEdits(key);
  const { out, note } = buildFixed(p.file, edits, { colors: p.colors, smooth: p.smooth, showRefs: p.showRefs, events: p.events, attackRight: p.attack ? p.attack === "right" : null, ballAuto: p.ballAuto, ballJumpMs: p.ballJumpMs });
  const a = await writeLocalInfo(fixedPath, JSON.stringify(out));
  if (!a.ok) return { state: "error", note: `No se pudo escribir ${fixedName(p.file)}: ${a.error}` };
  const b = await writeLocalInfo(labelsPath, JSON.stringify(buildLabels(p.file, edits, p.colors ?? NO_COLORS)));
  if (!b.ok) return { state: "error", note: `Se escribió ${fixedName(p.file)} pero no ${labelsName(p.file)}: ${b.error}` };
  const at = Math.max(a.mtime ?? 0, b.mtime ?? 0, Date.now());
  record(p.folder, { [id]: { hash: p.hash, at } });
  return { state: "saved", note, at };
}

async function readJson<T>(rel: string): Promise<T | null> {
  const text = await readLocal(rel);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface Progress {
  done: number;
  total: number;
  label: string;
}
export interface SaveAllResult {
  parts: number;
  events: number | null;
  backup: string | null;
  errors: string[];
  skipped: string[];
  cancelled: boolean;
  nothing: boolean;
}

// Everything of the match that changed: the parts (each with the same export as its «Guardar»), the events and a backup.
// An error in one part does not stop the others.
export async function saveAll(state: State, match: Match, ask: Ask, onProgress: (p: Progress) => void): Promise<SaveAllResult> {
  const res: SaveAllResult = { parts: 0, events: null, backup: null, errors: [], skipped: [], cancelled: false, nothing: false };
  const folder = match.folder;
  if (!folder) return { ...res, errors: ["El partido no tiene carpeta."] };
  const attack = attackOf(folder);
  const items = matchItems(state, match, attack);
  const dirty = dirtyItems(items, readLog(folder));
  if (!dirty.length) return { ...res, nothing: true };
  const listings = new Map<string, LocalEntry[] | null>();
  const dir = `matches/${folder}/tracking`;
  if (!(await listLocal(dir)) && dirty.some((d) => d.kind === "part")) return { ...res, errors: ["No se puede leer la carpeta del partido: la app no corre en esta computadora."] };
  const events = state.events.filter((e) => e.match_id === match.match_id);
  const steps = dirty.length + 1;
  let n = 0;
  for (const item of dirty) {
    onProgress({ done: n, total: steps, label: item.kind === "part" ? `Parte ${item.label}` : "Eventos" });
    // Let the bar paint before a long part.
    await new Promise((r) => setTimeout(r, 20));
    try {
      const r = item.kind === "part" ? await saveOnePart(item, folder, state, events, attack, ask, listings) : await saveEvents(item, folder, events, ask, listings);
      if (r.state === "saved") {
        if (item.kind === "part") res.parts++;
        else res.events = events.length;
      } else if (r.state === "skipped") res.skipped.push(item.label);
      else if (r.state === "cancelled") {
        res.cancelled = true;
        break;
      } else res.errors.push(`${item.label}: ${r.note}`);
    } catch (e) {
      res.errors.push(`${item.label}: ${e instanceof Error ? e.message : "error inesperado"}`);
    }
    n++;
  }
  if (!res.cancelled && (res.parts || res.events !== null)) {
    onProgress({ done: n, total: steps, label: "Respaldo" });
    const name = backupName(new Date());
    const w = await writeLocalInfo(`matches/${folder}/respaldo/${name}`, JSON.stringify(matchBackup(state, match)));
    if (w.ok) {
      res.backup = name;
      const old = backupsToDelete(((await listLocal(`matches/${folder}/respaldo`)) ?? []).map((e) => e.name));
      for (const o of old) await deleteLocal(`matches/${folder}/respaldo/${o}`);
    } else res.errors.push(`Respaldo: ${w.error}`);
  }
  onProgress({ done: steps, total: steps, label: "" });
  return res;
}

async function saveOnePart(item: SaveItem, folder: string, state: State, events: MatchEvent[], attack: (v: string) => string, ask: Ask, listings: Map<string, LocalEntry[] | null>): Promise<PartResult> {
  const k = parseKey(item.key ?? "");
  if (!k) return { state: "error", note: "clave de parte no válida" };
  const base = `${k.video_id}_${k.start_frame}_${k.end_frame}`;
  const file = await readJson<TracksFile>(`matches/${folder}/tracking/tracks_${base}.json`);
  if (!file || !Array.isArray(file.frames)) return { state: "error", note: `no está tracks_${base}.json en la carpeta` };
  const auto = await readJson<BallAuto & { kind?: string }>(`matches/${folder}/tracking/ball_auto_${base}.json`);
  return savePart(
    {
      folder,
      file,
      edits: state.trackEdits.find((e) => e.key === item.key),
      hash: item.hash,
      colors: state.jerseys[folder] ?? NO_COLORS,
      smooth: DEFAULT_SMOOTH,
      events,
      attack: attack(k.video_id),
      ballAuto: auto && auto.kind === "ball_auto" && Array.isArray(auto.frames) ? { frames: auto.frames, ask: auto.ask ?? [] } : null,
    },
    ask,
    listings,
  );
}

async function saveEvents(item: SaveItem, folder: string, events: MatchEvent[], ask: Ask, listings: Map<string, LocalEntry[] | null>): Promise<PartResult> {
  const root = (await listLocal(`matches/${folder}`)) ?? [];
  const sub = (await listLocal(`matches/${folder}/events`)) ?? [];
  listings.set(`matches/${folder}`, root);
  listings.set(`matches/${folder}/events`, sub);
  const path = eventsPath(folder, root.filter((e) => !e.dir).map((e) => e.name), sub.filter((e) => !e.dir).map((e) => e.name));
  const choice = await check([path], listings, readLog(folder).events, ask);
  if (choice !== "overwrite") return { state: choice === "skip" ? "skipped" : "cancelled", note: "" };
  const w = await writeLocalInfo(path, eventsCsv(events));
  if (!w.ok) return { state: "error", note: `No se pudo escribir ${path}: ${w.error}` };
  const at = Math.max(w.mtime ?? 0, Date.now());
  record(folder, { events: { hash: item.hash, at } });
  return { state: "saved", note: path, at };
}

// "Guardé 6 partes, 412 eventos" and what went wrong.
export function resultText(r: SaveAllResult): string {
  if (r.nothing) return "No había nada sin guardar.";
  const done = [
    r.parts ? `${r.parts} ${r.parts === 1 ? "parte" : "partes"}` : "",
    r.events !== null ? `${r.events} ${r.events === 1 ? "evento" : "eventos"}` : "",
  ].filter(Boolean);
  const head = done.length ? `Guardé ${done.join(", ")}${r.backup ? ` y el respaldo ${r.backup}` : ""}.` : "No se guardó nada.";
  const tail = [r.cancelled ? "Cancelado." : "", r.skipped.length ? `Saltados: ${r.skipped.join(", ")}.` : "", r.errors.length ? `Errores: ${r.errors.join(" · ")}` : ""].filter(Boolean);
  return [head, ...tail].join(" ");
}
