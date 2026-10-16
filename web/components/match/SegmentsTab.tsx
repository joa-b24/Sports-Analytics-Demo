"use client";

import { ClockClockwise, DownloadSimple, FlagCheckered, Pause, Play as PlayIcon, Trash, UploadSimple, Warning } from "@phosphor-icons/react";
import { IconButton } from "@/components/Modal";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Card, btn } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { downloadText, fmtT, parseCsv } from "@/lib/format";
import { marksFromCsvRows, segmentAt, segmentsCsv, segmentsFromMarks, totalSeconds, type Segment } from "@/lib/segments";
import { writeLocal } from "@/lib/local";
import { mutate, uid } from "@/lib/store";
import { videoOf } from "@/lib/videos";
import { SEGMENT_KINDS, SEGMENT_LABELS, type Match, type SegmentKind, type SegmentMark } from "@/lib/types";

export const SEGMENT_COLORS: Record<SegmentKind, string> = {
  juego: "var(--color-accent)",
  pausa: "var(--color-line-strong)",
  no_medible: "var(--color-warn)",
};

type Props = {
  match: Match;
  // Video being marked; its marks are the ones received.
  videoId: string;
  marks: SegmentMark[];
  // For segments.csv, which covers every video of the match.
  videoIds: string[];
  segmentsByVideo: Record<string, Segment[]>;
  time: number;
  playerRef: RefObject<PlayerHandle | null>;
};

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function SegmentsTab({ match, videoId, marks, videoIds, segmentsByVideo, time, playerRef }: Props) {
  const sameVideo = (m: SegmentMark) => m.match_id === match.match_id && videoOf(m) === videoId;
  const [saved, setSaved] = useState("");
  const segments = segmentsFromMarks(marks);
  const sorted = [...marks].sort((a, b) => a.t_video - b.t_video);
  const current = segmentAt(segments, time);
  const open = segments.find((s) => s.end === null) ?? null;
  const span = Math.max(1, time, ...marks.map((m) => m.t_video));

  const now = () => Math.round((playerRef.current?.getTime() ?? time) * 10) / 10;
  const add = (tipo: SegmentKind | "fin") => {
    const t = now();
    mutate((s) => ({
      ...s,
      // A new mark on the same instant replaces the old one.
      segments: [
        ...s.segments.filter((m) => !(sameVideo(m) && Math.abs(m.t_video - t) < 0.05)),
        { mark_id: uid("g"), match_id: match.match_id, video_id: videoId, t_video: t, tipo },
      ],
    }));
  };
  // Shortcuts: G (game) starts play, P a pause, X a stretch that cannot be measured, E ends the open one.
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });
  useEffect(() => {
    const keys: Record<string, SegmentKind | "fin"> = { g: "juego", p: "pausa", x: "no_medible", e: "fin" };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const tipo = keys[e.key.toLowerCase()];
      if (tipo) addRef.current(tipo);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const patch = (id: string, p: Partial<SegmentMark>) =>
    mutate((s) => ({ ...s, segments: s.segments.map((m) => (m.mark_id === id ? { ...m, ...p } : m)) }));
  const remove = (id: string) => mutate((s) => ({ ...s, segments: s.segments.filter((m) => m.mark_id !== id) }));

  const importCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const parsed = marksFromCsvRows(parseCsv(await f.text()));
    if (parsed.length === 0) return;
    mutate((s) => ({
      ...s,
      segments: [
        ...s.segments.filter((m) => m.match_id !== match.match_id),
        ...parsed.map((m) => ({ ...m, mark_id: uid("g"), match_id: match.match_id })),
      ],
    }));
  };

  return (
    <div className="space-y-5">
      <Card title="Tramos del video" note={<span className="tc">Ahora {fmtT(time)}</span>}>
        <p className="mb-4 text-xs text-pretty text-muted">
          El video no se recorta. Marca dónde cambia lo que pasa: desde cada marca hasta la siguiente es juego, pausa (previa, medio tiempo,
          interrupciones largas) o no medible (se juega pero no se ve bien). Pulsa el botón justo cuando empieza el tramo.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => add("juego")}>
            <PlayIcon size={14} weight="fill" />
            Empieza juego <kbd className="kbd ml-1">G</kbd>
          </button>
          <button type="button" className={btn} onClick={() => add("pausa")}>
            <Pause size={14} weight="fill" />
            Empieza pausa <kbd className="kbd ml-1">P</kbd>
          </button>
          <button type="button" className={btn} onClick={() => add("no_medible")}>
            <Warning size={14} />
            Empieza no medible <kbd className="kbd ml-1">X</kbd>
          </button>
          <button type="button" className={btn} onClick={() => add("fin")} title="Cierra el tramo anterior sin empezar otro">
            <FlagCheckered size={14} />
            Fin aquí <kbd className="kbd ml-1">E</kbd>
          </button>
        </div>

        {segments.length > 0 && (
          <>
            {/* Whole video on one bar; click to jump. */}
            <div
              className="relative mt-5 h-7 cursor-pointer overflow-hidden rounded-full bg-bg/70"
              role="presentation"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                playerRef.current?.seek(((e.clientX - r.left) / r.width) * span);
              }}
            >
              {segments.map((s) => (
                <span
                  key={s.segment_id}
                  title={`${s.segment_id} · ${SEGMENT_LABELS[s.tipo]} · ${fmtT(s.start)} – ${s.end === null ? "sin cerrar" : fmtT(s.end)}`}
                  className="absolute top-0 bottom-0"
                  style={{
                    left: `${(s.start / span) * 100}%`,
                    width: `${(((s.end ?? span) - s.start) / span) * 100}%`,
                    background: `color-mix(in srgb, ${SEGMENT_COLORS[s.tipo]} ${s.tipo === "juego" ? 85 : 55}%, transparent)`,
                    boxShadow: "inset -1px 0 0 var(--color-bg)",
                  }}
                />
              ))}
              <span className="absolute top-0 bottom-0 w-0.5 bg-ink" style={{ left: `${(time / span) * 100}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {SEGMENT_KINDS.map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: SEGMENT_COLORS[k] }} />
                  {SEGMENT_LABELS[k]} <span className="tc text-faint">{fmtDur(totalSeconds(segments, k))}</span>
                </span>
              ))}
              <span className="ml-auto text-faint">Ahora: {current ? `${current.segment_id} · ${SEGMENT_LABELS[current.tipo]}` : "sin tramo"}</span>
            </div>
          </>
        )}

        {open && (
          <p className="mt-4 flex items-start gap-2 rounded-2xl bg-warn-900/60 px-3 py-2 text-xs text-warn">
            <Warning size={14} className="mt-0.5 shrink-0" />
            El último tramo ({SEGMENT_LABELS[open.tipo]}, desde {fmtT(open.start)}) no tiene final. Ve al momento donde termina y pulsa «Fin
            aquí»; hasta entonces no entra en el CSV.
          </p>
        )}
      </Card>

      <Card title="Marcas" note={`${segments.length} tramos`} delay={60}>
        {sorted.length === 0 ? (
          <p className="text-sm text-faint">Aún no hay marcas. Empieza por el inicio del video: normalmente una pausa (la previa) y luego juego.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="table-nocturne w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  <th className="py-1 pr-2">Tramo</th>
                  <th className="py-1 pr-2">Empieza</th>
                  <th className="py-1 pr-2">Termina</th>
                  <th className="py-1 pr-2">Dura</th>
                  <th className="py-1 pr-2">Tipo</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((m) => {
                  const seg = m.tipo === "fin" ? null : segments.find((s) => s.start === m.t_video);
                  return (
                    <tr key={m.mark_id} className="border-t border-line-soft">
                      <td className="tc py-1 pr-2 text-faint">{seg?.segment_id ?? "—"}</td>
                      <td className="py-1 pr-2">
                        <button type="button" className="tc link" onClick={() => playerRef.current?.seek(m.t_video)}>
                          {fmtT(m.t_video)}
                        </button>
                      </td>
                      <td className="tc py-1 pr-2 text-ink-2">{seg ? (seg.end === null ? "sin cerrar" : fmtT(seg.end)) : ""}</td>
                      <td className="tc py-1 pr-2 text-ink-2">{seg && seg.end !== null ? fmtDur(seg.end - seg.start) : ""}</td>
                      <td className="py-1 pr-2">
                        <select
                          className="bg-transparent text-sm"
                          value={m.tipo}
                          aria-label="Tipo de tramo"
                          onChange={(e) => patch(m.mark_id, { tipo: e.target.value as SegmentKind | "fin" })}
                        >
                          {SEGMENT_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {SEGMENT_LABELS[k]}
                            </option>
                          ))}
                          <option value="fin">Fin</option>
                        </select>
                      </td>
                      <td className="py-1 text-right text-xs whitespace-nowrap">
                        <IconButton label="Mover esta marca al momento actual del video" onClick={() => patch(m.mark_id, { t_video: now() })}>
                          <ClockClockwise size={14} />
                        </IconButton>
                        <IconButton label="Borrar la marca" tone="danger" onClick={() => remove(m.mark_id)}>
                          <Trash size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btn}
            disabled={Object.values(segmentsByVideo).every((list) => list.every((s) => s.end === null))}
            onClick={() => {
              const text = segmentsCsv(videoIds, segmentsByVideo);
              downloadText("segments.csv", text, "text/csv");
              if (match.folder) void writeLocal(`matches/${match.folder}/segments.csv`, text).then((ok) => setSaved(ok ? `Guardado en matches/${match.folder}/segments.csv.` : ""));
            }}
          >
            <DownloadSimple size={15} />
            Exportar segments.csv
          </button>
          {saved && <span className="text-xs text-ok">{saved}</span>}
          <label className={`${btn} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
            <UploadSimple size={15} />
            Importar segments.csv
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={importCsv} />
          </label>
        </div>
        <p className="mt-3 text-xs text-pretty text-faint">
          Un solo archivo para todo el partido, en su carpeta (<code>matches/&lt;match_id&gt;/segments.csv</code>): la columna{" "}
          <code>video_id</code> dice a qué video pertenece cada tramo, y es el que usan el corte de segmentos y el tracking.
          {videoIds.length > 1 && ` Incluye los ${videoIds.length} videos, no solo el que tienes abierto.`} Importar reemplaza las marcas de
          todo el partido.
        </p>
      </Card>
    </div>
  );
}
