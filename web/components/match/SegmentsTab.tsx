"use client";

import { type Icon, ClockClockwise, DownloadSimple, FlagCheckered, Pause, Play as PlayIcon, Trash, UploadSimple, Warning } from "@phosphor-icons/react";
import { IconButton } from "@/components/Modal";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Card, btn } from "@/components/Shell";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { downloadText, fmtT, isTyping, parseCsv } from "@/lib/format";
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

// The four marks: name, key, icon, color and what each one means.
const KINDS: readonly { id: SegmentKind | "fin"; label: string; key: string; Icon: Icon; color: string; hint: string }[] = [
  { id: "juego", label: "Juego", key: "G", Icon: PlayIcon, color: SEGMENT_COLORS.juego, hint: "Desde aquí se juega" },
  { id: "pausa", label: "Pausa", key: "P", Icon: Pause, color: SEGMENT_COLORS.pausa, hint: "Previa, medio tiempo o interrupción larga" },
  { id: "no_medible", label: "No medible", key: "X", Icon: Warning, color: SEGMENT_COLORS.no_medible, hint: "Se juega pero no se ve bien" },
  { id: "fin", label: "Fin", key: "E", Icon: FlagCheckered, color: "var(--color-faint)", hint: "Cierra el tramo anterior sin empezar otro" },
];

type Props = {
  match: Match;
  // Video being marked; its marks are the ones received.
  videoId: string;
  marks: SegmentMark[];
  // For segments.csv, which covers every video of the match.
  videoIds: string[];
  segmentsByVideo: Record<string, Segment[]>;
  time: number;
  duration?: number;
  playerRef: RefObject<PlayerHandle | null>;
  // Under the video: where the timeline goes.
  belowSlot?: HTMLElement | null;
};

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function SegmentsTab({ match, videoId, marks, videoIds, segmentsByVideo, time, duration, playerRef, belowSlot }: Props) {
  const sameVideo = (m: SegmentMark) => m.match_id === match.match_id && videoOf(m) === videoId;
  const [saved, setSaved] = useState("");
  const segments = segmentsFromMarks(marks);
  const sorted = [...marks].sort((a, b) => a.t_video - b.t_video);
  const current = segmentAt(segments, time);
  const open = segments.find((s) => s.end === null) ?? null;
  const span = Math.max(1, duration ?? 0, time, ...marks.map((m) => m.t_video));

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
      if (isTyping(el) || e.ctrlKey || e.metaKey || e.altKey) return;
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
  const exportCsv = () => {
    const text = segmentsCsv(videoIds, segmentsByVideo);
    downloadText("segments.csv", text, "text/csv");
    if (match.folder) void writeLocal(`matches/${match.folder}/segments.csv`, text).then((ok) => setSaved(ok ? `Guardado en matches/${match.folder}/segments.csv` : ""));
  };
  const kindOf = (t: SegmentKind | "fin") => KINDS.find((k) => k.id === t) ?? KINDS[3];

  // Whole video on one bar, under the player; click to jump.
  const timeline = (
    <div className="rounded-lg bg-surface p-3">
      <div
        className="relative h-6 cursor-pointer overflow-hidden rounded-full bg-bg/70"
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
        <span className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-ink" style={{ left: `${Math.min(100, (time / span) * 100)}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {SEGMENT_KINDS.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: SEGMENT_COLORS[k] }} />
            {SEGMENT_LABELS[k]} <span className="tc text-faint">{fmtDur(totalSeconds(segments, k))}</span>
          </span>
        ))}
        <span className="ml-auto text-faint">{current ? `${current.segment_id} · ${SEGMENT_LABELS[current.tipo]}` : "sin tramo"}</span>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      {belowSlot ? createPortal(timeline, belowSlot) : timeline}
      <Card className="shrink-0" title="Tramos del video" note={<span className="tc">{fmtT(time)}</span>}>
        <div className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={`${k.id === "juego" ? "btn btn-primary" : btn} justify-between`} onClick={() => add(k.id)} title={k.hint}>
              <span className="inline-flex items-center gap-2">
                <k.Icon size={14} weight={k.id === "juego" || k.id === "pausa" ? "fill" : "regular"} />
                {k.label}
              </span>
              <kbd className="kbd">{k.key}</kbd>
            </button>
          ))}
        </div>
        {open && (
          <p className="mt-3 flex items-center gap-2 rounded-2xl bg-warn-900/60 px-3 py-2 text-xs text-warn" title="Hasta que tenga final no entra en el CSV">
            <Warning size={14} className="shrink-0" />
            {SEGMENT_LABELS[open.tipo]} desde {fmtT(open.start)} sin cerrar
          </p>
        )}
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col" title="Marcas" note={`${segments.length} tramos`} delay={60}>
        {sorted.length === 0 ? (
          <p className="flex-1 text-sm text-faint">Aún no hay marcas.</p>
        ) : (
          <ol className="-mx-1 max-h-[26rem] min-h-0 flex-1 space-y-1 overflow-auto px-1 xl:max-h-none">
            {sorted.map((m) => {
              const seg = m.tipo === "fin" ? undefined : segments.find((s) => s.start === m.t_video);
              const k = kindOf(m.tipo);
              const on = seg !== undefined && current?.segment_id === seg.segment_id;
              return (
                <li
                  key={m.mark_id}
                  className={`group flex items-center gap-3 rounded-lg py-1.5 pr-1.5 pl-3 transition-colors ${on ? "bg-raised" : "hover:bg-raised/60"}`}
                  style={{ boxShadow: `inset 3px 0 0 ${k.color}` }}
                >
                  <span className="tc w-8 shrink-0 text-xs text-faint">{seg?.segment_id ?? ""}</span>
                  <button type="button" className="tc shrink-0 text-sm text-ink hover:text-accent-300" title="Ir a esta marca" onClick={() => playerRef.current?.seek(m.t_video)}>
                    {fmtT(m.t_video)}
                  </button>
                  <span className="tc min-w-0 flex-1 truncate text-xs text-faint">
                    {seg ? (seg.end === null ? "→ sin cerrar" : `→ ${fmtT(seg.end)} · ${fmtDur(seg.end - seg.start)}`) : ""}
                  </span>
                  {/* The kind, as four small toggles instead of a dropdown. */}
                  <span className="flex shrink-0 rounded-md bg-bg/60 p-0.5" role="group" aria-label="Tipo de marca">
                    {KINDS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        aria-pressed={m.tipo === o.id}
                        title={o.label}
                        aria-label={o.label}
                        onClick={() => patch(m.mark_id, { tipo: o.id })}
                        className={`grid h-6 w-6 place-items-center rounded transition-colors ${m.tipo === o.id ? "bg-raised" : "text-faint hover:text-ink"}`}
                        style={m.tipo === o.id ? { color: o.color } : undefined}
                      >
                        <o.Icon size={12} weight={m.tipo === o.id ? "fill" : "regular"} />
                      </button>
                    ))}
                  </span>
                  <span className="flex shrink-0 opacity-60 transition-opacity group-hover:opacity-100">
                    <IconButton label="Mover esta marca al momento actual del video" onClick={() => patch(m.mark_id, { t_video: now() })}>
                      <ClockClockwise size={14} />
                    </IconButton>
                    <IconButton label="Borrar la marca" tone="danger" onClick={() => remove(m.mark_id)}>
                      <Trash size={14} />
                    </IconButton>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            className={btn}
            disabled={Object.values(segmentsByVideo).every((list) => list.every((s) => s.end === null))}
            title="Un solo segments.csv para todo el partido"
            onClick={exportCsv}
          >
            <DownloadSimple size={15} />
            Exportar
          </button>
          <label
            className={`${btn} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}
            title="Reemplaza las marcas de todo el partido"
          >
            <UploadSimple size={15} />
            Importar
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={importCsv} />
          </label>
          {saved && <span className="text-xs text-ok">{saved}</span>}
        </div>
      </Card>
    </div>
  );
}
