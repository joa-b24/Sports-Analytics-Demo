"use client";

import { DownloadSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { Card, btnPrimary } from "@/components/Shell";
import { buildMatchZip, type ZipMode, type ZipProgress } from "@/lib/matchZip";
import { ensureAggregates } from "@/lib/useTracking";
import { saveAll } from "@/lib/saveMatch";
import { useStore } from "@/lib/store";
import { formatBytes } from "@/lib/uploads";
import type { Match } from "@/lib/types";
import { NoticeLine, type Notice } from "./DropZone";

// Download the zip of a match (without its video) to load it in another copy of the app (Datos › .zip there). First saves
// what is pending in this browser into the folder, then zips the folder and the events as they are now.
export function ZipExportCard({ local }: { local: boolean | null }) {
  const state = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<ZipMode>("light");
  const [progress, setProgress] = useState<ZipProgress | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const withFolder = state.matches.filter((m) => m.folder);

  const download = async (match: Match, mode: ZipMode) => {
    const folder = match.folder as string;
    setBusy(match.match_id);
    setMode(mode);
    setNotice(null);
    try {
      // What is pending goes to the folder first; a conflict is skipped (the folder's version stays), as the autosave does.
      const saved = await saveAll(state, match, async () => "skip", () => {}).catch(() => null);
      const events = state.events.filter((e) => e.match_id === match.match_id);
      // The aggregates of the tracking go in both zips, up to date: built here if they are not (it can take a minute).
      setProgress({ done: 0, total: 1, name: "tracking" });
      const agg = await ensureAggregates(state, match);
      const z = await buildMatchZip(folder, events, setProgress, mode);
      const url = URL.createObjectURL(new Blob([z.bytes as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = mode === "light" ? `${folder}_ligero.zip` : `${folder}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const skipped = saved && saved.skipped.length > 0 ? ` ${saved.skipped.length} parte(s) con cambios sin guardar se saltaron por tener una versión más nueva en la carpeta: usa Ctrl+S en el partido y vuelve a descargar.` : "";
      setNotice({
        tone: z.failed.length || skipped || agg === "failed" ? "warn" : "ok",
        text: `${mode === "light" ? `${folder}_ligero.zip` : `${folder}.zip`}: ${z.files} archivos, ${formatBytes(z.bytes.length)}, sin el video.${agg === "failed" ? " No se pudieron guardar los datos resumidos del tracking: el zip va sin ellos." : ""}${z.failed.length ? ` No se pudieron leer: ${z.failed.join(", ")}.` : ""}${skipped}`,
      });
    } catch (e) {
      setNotice({ tone: "bad", text: `No se pudo armar el zip: ${e instanceof Error ? e.message : "error"}.` });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <Card title="Descargar el zip de un partido" note="para cargarlo en la app de Vercel">
      <p className="mb-3 text-xs text-pretty text-muted">
        <b>Ligero</b>: match.yaml, segments.csv, ediciones de clips, informe, los eventos de ahora y los datos del tracking ya resumidos (mapas de calor, pases,
        bloque, físico, calificación): pocos MB, es el que abre el celular. <b>Completo</b>: lo mismo con el tracking entero (decenas de MB), para la laptop o un
        respaldo. Ninguno lleva el video: en la otra app se enlaza el de YouTube. Las jugadas, el pizarrón y la presentación viajan en el respaldo de abajo.
      </p>
      {local === false ? (
        <p className="text-xs text-warn">Solo funciona con la app abierta en la laptop del proyecto: aquí no hay carpeta matches/.</p>
      ) : withFolder.length === 0 ? (
        <p className="text-xs text-faint">Ningún partido tiene carpeta todavía.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {withFolder.map((m) => (
            <li key={m.match_id} className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {m.name} <span className="font-mono text-xs text-faint">{m.folder}</span>
              </span>
              <button type="button" className={btnPrimary} disabled={!!busy || !local} onClick={() => void download(m, "light")} title="Eventos, informe y los datos del tracking ya resumidos: pesa pocos MB, para la app del celular">
                <DownloadSimple size={14} />
                {busy === m.match_id && mode === "light" ? (progress ? `Preparando ${progress.done}/${progress.total}…` : "Preparando…") : "Ligero (celular)"}
              </button>
              <button type="button" className="btn" disabled={!!busy || !local} onClick={() => void download(m, "full")} title="Todo lo del partido menos el video, con el tracking completo: pesa decenas de MB">
                <DownloadSimple size={14} />
                {busy === m.match_id && mode === "full" ? (progress ? `Leyendo ${progress.done}/${progress.total}…` : "Preparando…") : "Completo"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <NoticeLine notice={notice} />
    </Card>
  );
}
