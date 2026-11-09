"use client";

import { ArrowClockwise, CloudArrowDown, Stop, WarningCircle } from "@phosphor-icons/react";
import { Command } from "@/components/Command";
import { downloadCommand } from "@/lib/downloads";
import { useStore } from "@/lib/store";
import { matchOfFolder } from "@/lib/techTracking";
import type { Match } from "@/lib/types";
import { useVideoDownloads, type VideoDl, type VideoDownloads } from "@/lib/useVideoDownloads";

// The videos of a match that have a link but no file in its folder: the mark «Falta el video», the state of each
// download (pendiente / descargando / error), and the buttons to download, cancel and retry. Download is automatic
// (Detalles técnicos) when the app runs on this computer; the file is what Calibración and Tracking need.

const eta = (s: number | null) => (s === null ? "" : s >= 90 ? ` · quedan ~${Math.round(s / 60)} min` : ` · quedan ${Math.max(1, Math.round(s))} s`);

export function MissingTag({ className = "" }: { className?: string }) {
  return (
    <span className={`tag tag-warn ${className}`}>
      <WarningCircle size={12} weight="fill" aria-hidden />
      Falta el video
    </span>
  );
}

// Plain-text state of one video (for lists and the process panel).
export function dlText(v: VideoDl): string {
  switch (v.state) {
    case "pending":
      return "Pendiente de descargar";
    case "downloading":
      return `Descargando${v.pct !== null ? ` ${Math.round(v.pct)} %` : ""}${eta(v.etaS)}`;
    case "error":
      return `Error: ${v.message}`;
    case "stopped":
      return "Descarga cancelada";
    case "nolink":
      return "Sin enlace de YouTube";
    case "ready":
      return "Descargado";
    default:
      return "";
  }
}

function Row({ v, dl }: { v: VideoDl; dl: VideoDownloads }) {
  const busy = v.state === "downloading";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-sm">
      <MissingTag />
      <span className="text-ink-2">
        {v.label} <span className="text-faint">({v.video_id})</span>
      </span>
      <span className={`text-xs ${v.state === "error" ? "text-danger" : "text-muted"}`} role={v.state === "error" ? "alert" : undefined}>
        {dlText(v)}
      </span>
      {busy && (
        <span className="h-1.5 w-32 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.pct ?? undefined} aria-label={`Descarga de ${v.label}`}>
          <span className={`block h-full bg-own transition-[width] duration-500 ${v.pct === null ? "w-1/3 animate-pulse" : ""}`} style={v.pct === null ? undefined : { width: `${v.pct}%` }} />
        </span>
      )}
      <span className="ml-auto flex gap-2">
        {busy && (
          <button type="button" className="btn btn-ghost !py-0.5 text-xs" onClick={() => void dl.cancel(v.video_id)}>
            <Stop size={12} weight="fill" />
            Cancelar
          </button>
        )}
        {(v.state === "error" || v.state === "stopped") && (
          <button type="button" className="btn !py-0.5 text-xs" onClick={() => void dl.start(v.video_id)}>
            <ArrowClockwise size={12} />
            Reintentar
          </button>
        )}
        {v.state === "pending" && dl.local && (
          <button type="button" className="btn !py-0.5 text-xs" onClick={() => void dl.start(v.video_id)} disabled={!v.hasLink}>
            <CloudArrowDown size={12} />
            Descargar
          </button>
        )}
      </span>
    </li>
  );
}

// Under the header of the match: only while some registered video has no file. Nothing when the folder cannot be read.
export function VideoFilesBar({ match, dl }: { match: Match; dl: VideoDownloads }) {
  const missing = dl.items.filter((i) => i.hasLink && i.state !== "ready" && i.state !== "unknown");
  if (dl.names === null || missing.length === 0) return null;
  return (
    <section className="mb-4 rounded-lg bg-warn-900 px-4 py-2 print:hidden" aria-label="Videos que faltan en la carpeta del partido">
      <p className="m-0 pt-1 text-xs text-warn">
        Estos videos tienen enlace pero no están en <code>matches/{match.folder}/video/</code>. Mientras tanto se ven desde YouTube; Calibración y Tracking piden el archivo.
      </p>
      <ul className="m-0 list-none divide-y divide-line-soft p-0">
        {missing.map((v) => (
          <Row key={v.video_id} v={v} dl={dl} />
        ))}
      </ul>
    </section>
  );
}

// Calibración and Tracking cannot read the pixels of a YouTube frame (the browser does not allow it): they need the
// file. Shown where those screens used to be empty.
export function VideoMissingNotice({ folder, video, quiet = false }: { folder: string; video: string; quiet?: boolean }) {
  const { matches } = useStore();
  const match = matchOfFolder(matches, folder);
  const dl = useVideoDownloads(match);
  const v = dl.items.find((i) => i.video_id === video);
  // quiet: nothing until the folder confirms the file is missing (no flash while it is being looked up).
  if (quiet && (!v || v.state === "ready" || v.state === "unknown")) return null;
  return (
    <div className={`space-y-2 text-sm ${quiet ? "mb-3 rounded-lg bg-warn-900 px-4 py-3" : ""}`}>
      <p className="m-0 flex flex-wrap items-center gap-2 text-ink-2">
        <MissingTag />
        <span>
          No está <code>matches/{folder}/video/{video}.mp4</code>.
        </span>
      </p>
      <p className="m-0 text-pretty text-muted">
        El navegador no da acceso a los píxeles de un video incrustado de YouTube, por eso Calibración y Tracking necesitan el archivo del video en la carpeta del partido.
      </p>
      {v && v.state !== "ready" && (
        <div className="flex flex-wrap items-center gap-3">
          <span className={`text-xs ${v.state === "error" ? "text-danger" : "text-muted"}`} role={v.state === "error" ? "alert" : undefined}>
            {dlText(v)}
          </span>
          {v.state === "downloading" && (
            <button type="button" className="btn btn-ghost !py-0.5 text-xs" onClick={() => void dl.cancel(video)}>
              <Stop size={12} weight="fill" />
              Cancelar
            </button>
          )}
          {v.hasLink && dl.local && v.state !== "downloading" && (
            <button type="button" className="btn btn-primary" onClick={() => void dl.start(video)}>
              {v.state === "error" || v.state === "stopped" ? <ArrowClockwise size={15} /> : <CloudArrowDown size={15} />}
              {v.state === "error" || v.state === "stopped" ? "Reintentar la descarga" : "Descargar el video"}
            </button>
          )}
          {v.hasLink && !dl.local && match?.folder && <Command className="w-full">{downloadCommand(match.folder, video, match.videos?.find((x) => x.video_id === video)?.youtube_id ?? match.youtube_id)}</Command>}
          {!v.hasLink && <span className="text-xs text-faint">Este video no tiene enlace de YouTube: ábrelo desde un archivo.</span>}
        </div>
      )}
    </div>
  );
}
