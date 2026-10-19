"use client";

import { DownloadSimple, FilmStrip, FolderSimple, ListBullets, MapTrifold, Plus } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, btn, btnPrimary, input } from "@/components/Shell";
import { Select } from "@/components/Select";
import { downloadText, parseCsv, toCsv } from "@/lib/format";
import { isFolderName, listLocal, suggestFolder, uploadLocal, type LocalEntry } from "@/lib/local";
import { mutate, uid, useStore } from "@/lib/store";
import { EMPTY_REPORT, type Match, type MatchKind } from "@/lib/types";
import { EVENT_COLUMNS, eventsFromCsv, formatBytes, isMatchFolder, trackingInner, videoInner } from "@/lib/uploads";
import { matchVideos, nextVideo, videoOf } from "@/lib/videos";
import { Confirm, DropZone, NoticeLine, Progress, type Notice } from "./DropZone";

const NEW = "__new";
const KIND_LABEL: Record<MatchKind, string> = { own: "Nuestro", rival: "Rival", reference: "Referencia" };

type Sending = { name: string; sent: number; total: number; abort: AbortController };

// What the folder of a match holds now: videos, tracking files and whether match.yaml is there.
type FolderView = { video: LocalEntry[]; tracking: LocalEntry[]; yaml: boolean; exists: boolean };

async function readFolder(folder: string): Promise<FolderView | null> {
  const root = await listLocal(`matches/${folder}`);
  if (!root) return { video: [], tracking: [], yaml: false, exists: false };
  const [video, tracking] = await Promise.all([listLocal(`matches/${folder}/video`), listLocal(`matches/${folder}/tracking`)]);
  const files = (l: LocalEntry[] | null) => (l ?? []).filter((f) => !f.dir && !f.name.endsWith(".part") && f.name !== ".gitkeep");
  return { video: files(video), tracking: files(tracking), yaml: root.some((f) => f.name === "match.yaml"), exists: true };
}

// The files of one match: pick (or create) the match, then its events CSV, its videos and its tracking. Events live in
// this browser; videos and tracking are written into matches/<folder>/ and need the app running on this computer.
export function MatchFiles({ local, folders, onFolders }: { local: boolean | null; folders: string[]; onFolders: () => void }) {
  const state = useStore();
  const [pick, setPick] = useState<string>("");
  const matchId = pick === NEW ? NEW : state.matches.some((m) => m.match_id === pick) ? pick : (state.matches[0]?.match_id ?? NEW);
  const match = state.matches.find((m) => m.match_id === matchId) ?? null;

  const options = [
    ...state.matches.map((m) => ({ value: m.match_id, label: m.name, group: undefined as string | undefined })),
    { value: NEW, label: "Nuevo partido…" },
  ];

  return (
    <Card title="Archivos de un partido" note="eventos, video y tracking">
      <div className="flex flex-wrap items-center gap-2">
        <Select<string> variant="field" label="Partido" className="min-w-0 flex-1" value={matchId} options={options} onChange={(v) => setPick(v ?? "")} />
      </div>
      {matchId === NEW ? (
        <NewMatch folders={folders} onCreated={(id) => setPick(id)} />
      ) : match ? (
        <MatchBody key={match.match_id} match={match} local={local} folders={folders} onFolders={onFolders} />
      ) : null}
    </Card>
  );
}

function NewMatch({ folders, onCreated }: { folders: string[]; onCreated: (id: string) => void }) {
  const [kind, setKind] = useState<MatchKind>("own");
  const [focus, setFocus] = useState("");
  const [other, setOther] = useState("");
  const [date, setDate] = useState("");
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const folder = folderDraft ?? suggestFolder(date, focus, other);
  const folderOk = folder === "" || isFolderName(folder) || folders.includes(folder);

  const create = () => {
    if (!focus.trim() || !folderOk) return;
    const id = uid("m");
    const m: Match = {
      match_id: id,
      name: `${focus.trim()} vs ${other.trim() || "?"}`,
      kind,
      date,
      focus_team: focus.trim(),
      other_team: other.trim() || "Contrario",
      youtube_id: "",
      ...(folder ? { folder } : {}),
      report: { ...EMPTY_REPORT },
    };
    mutate((s) => ({ ...s, matches: [...s.matches, m] }));
    onCreated(id);
  };

  return (
    <div className="enter mt-4 grid gap-3">
      <div className="seg w-full" role="group" aria-label="Tipo de video">
        {(Object.keys(KIND_LABEL) as MatchKind[]).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className="seg-opt flex-1 text-center text-xs">
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={input} placeholder={kind === "rival" ? "Rival que se estudia" : "Equipo analizado"} aria-label="Equipo analizado" value={focus} onChange={(e) => setFocus(e.target.value)} />
        <input className={input} placeholder="Contrario" aria-label="Contrario" value={other} onChange={(e) => setOther(e.target.value)} />
        <input className={input} type="date" aria-label="Fecha" value={date} onChange={(e) => setDate(e.target.value)} />
        <input
          className={`${input} font-mono text-xs`}
          placeholder="aaaa_mm_dd_local_vs_visitante"
          aria-label="Carpeta en matches/"
          list="sportsan-folders"
          value={folder}
          onChange={(e) => setFolderDraft(e.target.value.trim())}
        />
      </div>
      {!folderOk && <p className="text-xs text-warn">La carpeta debe seguir aaaa_mm_dd_local_vs_visitante (minúsculas, sin acentos) o ser una que ya existe.</p>}
      <div>
        <button type="button" className={btnPrimary} disabled={!focus.trim() || !folderOk} onClick={create}>
          <Plus size={15} />
          Crear partido
        </button>
      </div>
    </div>
  );
}

function MatchBody({ match, local, folders, onFolders }: { match: Match; local: boolean | null; folders: string[]; onFolders: () => void }) {
  const state = useStore();
  const folder = match.folder ?? null;
  const [view, setView] = useState<FolderView | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    if (!folder || !local) return;
    void readFolder(folder).then((v) => {
      if (live) setView(v);
    });
    return () => {
      live = false;
    };
  }, [folder, local, tick]);

  const events = state.events.filter((e) => e.match_id === match.match_id);
  const canWrite = !!local && !!folder;

  return (
    <div className="mt-4 grid gap-4">
      <FolderLine match={match} view={folder && local ? view : null} local={local} folders={folders} />
      <div className="grid gap-4 lg:grid-cols-3">
        <EventsTile match={match} count={events.length} />
        <VideoTile match={match} disabled={!canWrite} view={view} onDone={() => (refresh(), onFolders())} />
        <TrackingTile match={match} disabled={!canWrite} view={view} onDone={() => (refresh(), onFolders())} />
      </div>
    </div>
  );
}

// Where the files of the match go, and what is already there. A match without a folder gets one here.
function FolderLine({ match, view, local, folders }: { match: Match; view: FolderView | null; local: boolean | null; folders: string[] }) {
  const [draft, setDraft] = useState(() => suggestFolder(match.date, match.focus_team, match.other_team));
  if (!match.folder) {
    const ok = isFolderName(draft) || folders.includes(draft);
    return (
      <div className="rounded-xl border border-line px-3 py-3 text-xs">
        <p className="text-muted">Este partido aún no tiene carpeta en matches/. Sin ella no se pueden guardar su video ni su tracking.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${input} min-w-0 flex-1 font-mono text-xs`} aria-label="Carpeta en matches/" list="sportsan-folders" placeholder="aaaa_mm_dd_local_vs_visitante" value={draft} onChange={(e) => setDraft(e.target.value.trim())} />
          <button
            type="button"
            className={btn}
            disabled={!ok}
            onClick={() => mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, folder: draft } : m)) }))}
          >
            <FolderSimple size={15} />
            Usar esta carpeta
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5 font-mono text-ink-2">
        <FolderSimple size={14} className="text-faint" />
        matches/{match.folder}
      </span>
      {local === false ? null : !view ? (
        <span className="text-faint">leyendo…</span>
      ) : !view.exists ? (
        <span className="text-faint">la carpeta se crea con el primer archivo</span>
      ) : (
        <>
          <span className="text-muted">
            <span className="num text-ink-2">{view.video.length}</span> {view.video.length === 1 ? "video" : "videos"}
          </span>
          <span className="text-muted">
            <span className="num text-ink-2">{view.tracking.length}</span> {view.tracking.length === 1 ? "archivo" : "archivos"} de tracking
          </span>
          <span className={view.yaml ? "text-muted" : "text-faint"}>{view.yaml ? "match.yaml" : "sin match.yaml"}</span>
        </>
      )}
    </div>
  );
}

function Tile({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-line-soft bg-bg/40 p-3">
      <div className="mb-3 flex items-center gap-2 text-sm text-ink">
        <span className="text-faint">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

// Events of the match, in this browser: export them as a CSV of the contract, or add the rows of one.
function EventsTile({ match, count }: { match: Match; count: number }) {
  const state = useStore();
  const [notice, setNotice] = useState<Notice>(null);
  const take = async (files: File[]) => {
    const f = files[0];
    if (!/\.csv$/i.test(f.name)) return setNotice({ tone: "bad", text: "Ese archivo no es un CSV." });
    const rows = parseCsv(await f.text());
    if (rows.length === 0) return setNotice({ tone: "bad", text: "El CSV está vacío o no tiene encabezados." });
    if (!("t_video" in rows[0]) || !("type" in rows[0])) return setNotice({ tone: "bad", text: "Faltan las columnas t_video y type del contrato." });
    const out = eventsFromCsv(rows, match.match_id, () => uid("e"));
    if (out.events.length === 0) return setNotice({ tone: "bad", text: `Ninguna fila válida: ${out.skipped} sin t_video o con un type que no está en el catálogo.` });
    mutate((s) => ({ ...s, events: [...s.events, ...out.events] }));
    setNotice({
      tone: out.skipped || out.offPitch ? "warn" : "ok",
      text: `${out.events.length} eventos añadidos.${out.skipped ? ` ${out.skipped} filas omitidas (sin t_video o type desconocido).` : ""}${
        out.offPitch ? ` ${out.offPitch} coordenadas fuera de la cancha de 105 × 68 quedaron vacías.` : ""
      }`,
    });
  };
  return (
    <Tile icon={<ListBullets size={16} />} title="Eventos · CSV">
      <DropZone accept=".csv,text/csv" label="Añadir eventos" hint="se leen en el navegador" onFiles={(f) => void take(f)} />
      <button
        type="button"
        className={`${btn} mt-2 justify-center`}
        disabled={count === 0}
        onClick={() =>
          downloadText(
            `events_${match.folder ?? match.match_id}.csv`,
            toCsv(state.events.filter((e) => e.match_id === match.match_id).map((e) => ({ ...e, video_id: videoOf(e) })) as unknown as Record<string, unknown>[], EVENT_COLUMNS),
            "text/csv",
          )
        }
      >
        <DownloadSimple size={15} />
        Exportar {count} eventos
      </button>
      <NoticeLine notice={notice} />
    </Tile>
  );
}

// One video of the match into video/<video_id>.<ext>, streamed from disk with its progress.
function VideoTile({ match, disabled, view, onDone }: { match: Match; disabled: boolean; view: FolderView | null; onDone: () => void }) {
  const videos = matchVideos(match);
  const fresh = nextVideo(videos);
  const [videoId, setVideoId] = useState(videos[0].video_id);
  const [sending, setSending] = useState<Sending | null>(null);
  const [conflict, setConflict] = useState<{ file: File; inner: string } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const isNew = !videos.some((v) => v.video_id === videoId);
  const label = (id: string) => videos.find((v) => v.video_id === id)?.label ?? fresh.label;
  const has = (id: string) => view?.video.find((f) => f.name.startsWith(`${id}.`));

  const send = async (file: File, overwrite: boolean) => {
    const inner = videoInner(videoId, file.name);
    if (!inner || !match.folder) return setNotice({ tone: "bad", text: "Formato no admitido: el reproductor abre MP4, WebM, MKV o MOV." });
    const abort = new AbortController();
    setConflict(null);
    setNotice(null);
    setSending({ name: file.name, sent: 0, total: file.size, abort });
    const r = await uploadLocal(`matches/${match.folder}/${inner}`, file, {
      overwrite,
      signal: abort.signal,
      onProgress: (sent, total) => setSending((s) => (s ? { ...s, sent, total } : s)),
    });
    setSending(null);
    if (r.exists && !overwrite) return setConflict({ file, inner });
    if (!r.ok) return setNotice({ tone: "bad", text: r.error ?? "No se pudo subir el video." });
    if (isNew) {
      mutate((s) => ({
        ...s,
        matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, videos: [...matchVideos(m), { ...fresh, video_id: videoId }] } : m)),
      }));
    }
    setNotice({ tone: "ok", text: `Guardado en ${inner} (${formatBytes(file.size)}).${isNew ? ` Se añadió «${fresh.label}» al partido.` : ""}` });
    onDone();
  };

  const opts = [
    ...videos.map((v) => ({ value: v.video_id, label: `${v.video_id} · ${v.label}${has(v.video_id) ? " · ya está" : ""}` })),
    { value: fresh.video_id, label: `${fresh.video_id} · video nuevo` },
  ];

  return (
    <Tile icon={<FilmStrip size={16} />} title="Video">
      <Select<string> variant="field" label="Video del partido" className="mb-2 w-full" value={videoId} options={opts} onChange={(v) => v && setVideoId(v)} />
      {sending ? (
        <Progress name={sending.name} sent={sending.sent} total={sending.total} onCancel={() => sending.abort.abort()} />
      ) : (
        <DropZone accept="video/mp4,video/webm,video/x-matroska,video/quicktime,.mp4,.webm,.mkv,.mov" label={`Subir ${label(videoId)}`} hint={`MP4, WebM, MKV o MOV → video/${videoId}`} disabled={disabled} onFiles={(f) => void send(f[0], false)} />
      )}
      {conflict && (
        <Confirm yes="Reemplazar" onYes={() => void send(conflict.file, true)} onNo={() => setConflict(null)}>
          Ya hay un archivo en <code>{conflict.inner}</code>. ¿Reemplazarlo por «{conflict.file.name}»? El anterior se pierde.
        </Confirm>
      )}
      <NoticeLine notice={notice} />
    </Tile>
  );
}

// Tracking files (tracks_*, tracks_fixed_*, calib_*, library_*...) into tracking/, one after the other.
function TrackingTile({ match, disabled, view, onDone }: { match: Match; disabled: boolean; view: FolderView | null; onDone: () => void }) {
  const [sending, setSending] = useState<Sending | null>(null);
  const [conflicts, setConflicts] = useState<File[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const abortAll = useRef(false);

  const run = async (files: File[], overwrite: boolean) => {
    if (!match.folder) return;
    const bad = files.filter((f) => !trackingInner(f.name));
    const good = files.filter((f) => trackingInner(f.name));
    const clash: File[] = [];
    const ok: string[] = [];
    const failed: string[] = [];
    abortAll.current = false;
    setConflicts([]);
    setNotice(null);
    for (const f of good) {
      if (abortAll.current) break;
      const abort = new AbortController();
      setSending({ name: f.name, sent: 0, total: f.size, abort });
      const r = await uploadLocal(`matches/${match.folder}/${trackingInner(f.name)}`, f, {
        overwrite,
        signal: abort.signal,
        onProgress: (sent, total) => setSending((s) => (s ? { ...s, sent, total } : s)),
      });
      if (r.exists && !overwrite) clash.push(f);
      else if (r.ok) ok.push(f.name);
      else failed.push(`${f.name}: ${r.error ?? "error"}`);
    }
    setSending(null);
    setConflicts(clash);
    const parts = [
      ok.length ? `${ok.length} ${ok.length === 1 ? "archivo guardado" : "archivos guardados"} en tracking/.` : "",
      bad.length ? `No son archivos de tracking (tracks_, calib_, library_, anchors_, labels_, ball_ … .json/.npz/.parquet): ${bad.map((f) => f.name).join(", ")}.` : "",
      failed.length ? `Fallaron: ${failed.join("; ")}.` : "",
    ].filter(Boolean);
    if (parts.length) setNotice({ tone: failed.length || bad.length ? (ok.length ? "warn" : "bad") : "ok", text: parts.join(" ") });
    if (ok.length) onDone();
  };

  return (
    <Tile icon={<MapTrifold size={16} />} title="Tracking">
      {sending ? (
        <Progress
          name={sending.name}
          sent={sending.sent}
          total={sending.total}
          onCancel={() => {
            abortAll.current = true;
            sending.abort.abort();
          }}
        />
      ) : (
        <DropZone
          accept=".json,.npz,.parquet"
          multiple
          label="Subir archivos de tracking"
          hint={view && view.tracking.length ? `ya hay ${view.tracking.length} en tracking/` : "tracks_, tracks_fixed_, calib_, library_…"}
          disabled={disabled}
          onFiles={(f) => void run(f, false)}
        />
      )}
      {conflicts.length > 0 && (
        <Confirm yes={`Reemplazar ${conflicts.length}`} onYes={() => void run(conflicts, true)} onNo={() => setConflicts([])}>
          {conflicts.length === 1 ? "Ya existe" : `Ya existen ${conflicts.length} archivos:`} <code>{conflicts.map((f) => f.name).join(", ")}</code>.{" "}
          {conflicts.length === 1 ? "¿Reemplazarlo? La versión anterior se pierde." : "¿Reemplazarlos? Las versiones anteriores se pierden."}
        </Confirm>
      )}
      <NoticeLine notice={notice} />
    </Tile>
  );
}

// Folder names of matches/ for the folder inputs (datalist), plus whether they are reachable at all.
export function FolderList({ folders }: { folders: string[] }) {
  return (
    <datalist id="sportsan-folders">
      {folders.filter(isMatchFolder).map((f) => (
        <option key={f} value={f} />
      ))}
    </datalist>
  );
}
