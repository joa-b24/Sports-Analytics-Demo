import { toCsv } from "./format.ts";
import { EVENT_COLUMNS } from "./uploads.ts";
import type { Match, MatchEvent, State, TrackEdits } from "./types.ts";

// What of a match is saved to its folder and whether it changed since the last time (lib/saveMatch.ts does the
// writing; components/match/SaveStatus.tsx shows it). Pure: no storage, no React.

// cyrb53: a 53-bit hash of a text, enough to tell two states apart (not for security).
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// The same object always gives the same text, whatever the order its keys were written in.
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// Last save of one item to disk, in this browser.
export interface SaveRecord {
  hash: string;
  at: number; // ms
}
export type SaveLog = Record<string, SaveRecord>;

// One thing saved to the folder: a part (labels + tracks_fixed, ball included) or the events of the match.
export interface SaveItem {
  id: string; // "part:<editsKey>" or "events"
  kind: "part" | "events";
  label: string;
  hash: string;
  key?: string;
  video_id?: string;
  start_frame?: number;
  end_frame?: number;
}

export const partId = (key: string) => `part:${key}`;

// "<match>|<video>|<start>_<end>" -> its pieces; null if it is not a part key.
export function parseKey(key: string): { match_id: string; video_id: string; start_frame: number; end_frame: number } | null {
  const m = key.match(/^(.+)\|([^|]+)\|(\d+)_(\d+)$/);
  return m ? { match_id: m[1], video_id: m[2], start_frame: +m[3], end_frame: +m[4] } : null;
}

const eventsOfVideo = (events: MatchEvent[], video: string) => events.filter((e) => (e.video_id ?? "v1") === video);

// Fingerprint of a part: its corrections, plus what else ends up in its tracks_fixed (the events of its video as ball
// positions, and where our team attacks in it). The hash of the corrections is kept per object: the store replaces the
// object on every edit, so an unchanged part is not hashed again.
const editsHashes = new WeakMap<TrackEdits, string>();
const editsHash = (edits: TrackEdits) => {
  let h = editsHashes.get(edits);
  if (h === undefined) {
    h = hashText(stableJson(edits));
    editsHashes.set(edits, h);
  }
  return h;
};
export function partHash(edits: TrackEdits, events: MatchEvent[], attack: string): string {
  const video = parseKey(edits.key)?.video_id ?? "v1";
  const ev = attack ? hashText(stableJson(eventsOfVideo(events, video).map((e) => [e.t_video, e.x, e.y]))) : "";
  return hashText(`${editsHash(edits)}|${attack}|${ev}`);
}

export const eventsHash = (events: MatchEvent[]) => hashText(stableJson([...events].sort((a, b) => a.event_id.localeCompare(b.event_id))));

const fmtFrames = (f: number, fps: number) => {
  const s = Math.round(f / fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Everything of a match that can be saved: every part with corrections (of its folder) and its events.
export function matchItems(state: Pick<State, "trackEdits" | "events">, match: Pick<Match, "match_id" | "folder">, attackOf: (video: string) => string, fps = 30): SaveItem[] {
  if (!match.folder) return [];
  const events = state.events.filter((e) => e.match_id === match.match_id);
  const parts: SaveItem[] = state.trackEdits
    .filter((e) => e.key.startsWith(`${match.folder}|`))
    .flatMap((e) => {
      const k = parseKey(e.key);
      if (!k) return [];
      return [
        {
          id: partId(e.key),
          kind: "part" as const,
          label: `${k.video_id} ${fmtFrames(k.start_frame, fps)}–${fmtFrames(k.end_frame, fps)}`,
          hash: partHash(e, events, attackOf(k.video_id)),
          key: e.key,
          video_id: k.video_id,
          start_frame: k.start_frame,
          end_frame: k.end_frame,
        },
      ];
    })
    .sort((a, b) => (a.video_id ?? "").localeCompare(b.video_id ?? "") || (a.start_frame ?? 0) - (b.start_frame ?? 0));
  return events.length ? [...parts, { id: "events", kind: "events", label: "Eventos", hash: eventsHash(events) }] : parts;
}

// Items whose state is not the one last saved (never saved counts as changed).
export const dirtyItems = (items: SaveItem[], log: SaveLog) => items.filter((i) => log[i.id]?.hash !== i.hash);

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export { hhmm };

// The line of the match header.
export function statusText(items: SaveItem[], log: SaveLog): { dirty: number; text: string; detail: string[] } {
  const dirty = dirtyItems(items, log);
  const detail = items.map((i) => {
    const r = log[i.id];
    const when = r ? `guardado a las ${hhmm(r.at)}${new Date(r.at).toDateString() !== new Date().toDateString() ? ` del ${new Date(r.at).toLocaleDateString("es-MX")}` : ""}` : "nunca guardado";
    return `${i.label}: ${dirty.includes(i) ? "sin guardar" : "al día"} (${when})`;
  });
  if (!items.length) return { dirty: 0, text: "Nada que guardar", detail };
  if (dirty.length) {
    const parts = dirty.filter((i) => i.kind === "part").length;
    const n = dirty.length;
    return { dirty: n, text: `Sin guardar: ${n} ${n === 1 ? "cambio" : "cambios"}${parts ? ` en ${parts} ${parts === 1 ? "parte" : "partes"}` : ""}`, detail };
  }
  const last = Math.max(...items.map((i) => log[i.id]?.at ?? 0));
  return { dirty: 0, text: `Todo guardado a las ${hhmm(last)}`, detail };
}

// A file on disk is newer than the last save of it from this browser (Python rewrote it, or another browser): it must
// not be overwritten without asking. Never saved from here and already on disk: also asked. Tolerance for clocks.
export function isConflict(diskMtime: number | null | undefined, record: SaveRecord | undefined, toleranceMs = 3000): boolean {
  if (diskMtime === null || diskMtime === undefined) return false;
  if (!record) return true;
  return diskMtime > record.at + toleranceMs;
}

// respaldo_<aaaa-mm-dd_hhmm>.json of a moment (local time).
export function backupName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `respaldo_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
}
const BACKUP = /^respaldo_\d{4}-\d{2}-\d{2}_\d{4}\.json$/;
// Backups to delete so that only the `keep` most recent remain (other files of the folder are never touched).
export function backupsToDelete(names: string[], keep = 5): string[] {
  return names
    .filter((n) => BACKUP.test(n))
    .sort()
    .reverse()
    .slice(keep);
}

// The same content as Datos -> Exportar respaldo, but only of one match (it restores the same way).
export function matchBackup(state: State, match: Match): Partial<State> & { scope: string; saved_at: string } {
  const id = match.match_id;
  const folder = match.folder ?? "";
  const ofFolder = (key: string) => !!folder && key.startsWith(`${folder}|`);
  return {
    scope: `partido:${id}`,
    saved_at: new Date().toISOString(),
    matches: [match],
    events: state.events.filter((e) => e.match_id === id),
    plays: state.plays.filter((p) => p.match_id === id),
    sessions: [],
    anchors: state.anchors.filter((a) => a.match_id === id || a.match_id === folder),
    segments: state.segments.filter((s) => s.match_id === id),
    venues: state.venues.filter((v) => v.venue_id === match.venue_id),
    trackEdits: state.trackEdits.filter((e) => ofFolder(e.key)),
    roster: state.roster,
    passes: (state.passes ?? []).filter((p) => p.match_id === id),
    boards: (state.boards ?? []).filter((b) => b.match_id === id),
    edits: (state.edits ?? []).filter((e) => e.match_id === id),
    jerseys: folder && state.jerseys[folder] ? { [folder]: state.jerseys[folder] } : {},
    ...(state.rivals && folder && state.rivals[folder] ? { rivals: { [folder]: state.rivals[folder] } } : {}),
    ...(state.reviews ? { reviews: state.reviews.filter((r) => ofFolder(r.key)) } : {}),
  };
}

// The events CSV of a match, with the columns of the contract (docs/data_contract.md), missing values empty.
export const eventsCsv = (events: MatchEvent[]) =>
  toCsv(events.map((e) => ({ ...e, video_id: e.video_id ?? "v1" })) as unknown as Record<string, unknown>[], EVENT_COLUMNS);

// Where the events go: the events CSV already in the folder (root or events/), else events_<folder>.csv at the root.
export function eventsPath(folder: string, rootNames: string[], eventsDirNames: string[]): string {
  const csv = (n: string) => /^events_[\w.-]+\.csv$/.test(n);
  const own = `events_${folder}.csv`;
  if (rootNames.includes(own)) return `matches/${folder}/${own}`;
  if (eventsDirNames.includes(own)) return `matches/${folder}/events/${own}`;
  const root = rootNames.find(csv);
  if (root) return `matches/${folder}/${root}`;
  const sub = eventsDirNames.find(csv);
  if (sub) return `matches/${folder}/events/${sub}`;
  return `matches/${folder}/${own}`;
}
