"use client";

import { ArrowDown, ArrowUp, CaretLeft, CaretRight, Eraser, FilmSlate, PencilSimple, PersonSimpleRun, PencilSimpleLine, Play, Plus, Target, Trash, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SLIDE_H, SLIDE_W, SlideCanvas } from "@/components/match/SlideCanvas";
import { SlideEditor } from "@/components/match/SlideEditor";
import { Select } from "@/components/Select";
import { Card, input } from "@/components/Shell";
import { BoardSlide, boardOfSlide } from "@/components/match/BoardSlide";
import { boardsOf } from "@/lib/boards";
import { addSlide, blankSlide, boardSlide, clipSlide, editSlide, moveSlide, removeSlide, slidesOf, type Slide } from "@/lib/deck";
import { listLocal, localUrl } from "@/lib/local";
import { mutate, uid, useStore } from "@/lib/store";
import type { Match } from "@/lib/types";

// The presentation of a match: slides made of charts added from the analysis (button «Añadir a la presentación» on each
// panel), of edited clips of Estudio, or blank ones; every slide can carry text, boxes and arrows. Here they are ordered,
// titled and annotated, and shown full screen for the coaches, who can also draw over them live.
export function DeckView({ match }: { match: Match }) {
  const state = useStore();
  const id = match.match_id;
  const slides = slidesOf(state.decks, id);
  const [playing, setPlaying] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const edits = (state.edits ?? []).filter((e) => e.match_id === id);
  const plays = (state.plays ?? []).filter((p) => p.match_id === id && p.keyframes.length > 1);
  const boards = boardsOf(state);
  const push = (s: Slide) => mutate((st) => ({ ...st, decks: addSlide(st.decks, id, s) }));
  const editingSlide = slides.find((s) => s.id === editing) ?? null;

  const adders = (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn" onClick={() => push(blankSlide(uid("sl"), "Diapositiva en blanco"))}>
        <Plus size={14} />
        Diapositiva en blanco
      </button>
      <Select
        variant="field"
        label="Añadir un clip editado"
        value={null}
        display={
          <span className="inline-flex items-center gap-1.5">
            <FilmSlate size={14} aria-hidden />
            Añadir clip
          </span>
        }
        onChange={(v) => {
          const e = edits.find((x) => x.edit_id === v);
          if (e) push(clipSlide(uid("sl"), e.edit_id, e.title || "Clip"));
        }}
        options={edits.length ? edits.map((e) => ({ value: e.edit_id, label: e.title || e.edit_id })) : [{ value: "-", label: "No hay clips editados (se hacen en Estudio › Jugadas)" }]}
      />
      <Select
        variant="field"
        label="Añadir una animación"
        value={null}
        display={
          <span className="inline-flex items-center gap-1.5">
            <PersonSimpleRun size={14} aria-hidden />
            Añadir animación
          </span>
        }
        onChange={(v) => {
          if (!v) return;
          if (v.startsWith("b:")) {
            const b = boards.find((x) => x.board_id === v.slice(2));
            if (b) push(boardSlide(uid("sl"), { board: b.board_id }, b.title || "Pizarrón"));
          } else if (v.startsWith("p:")) {
            const p = plays.find((x) => x.play_id === v.slice(2));
            if (p) push(boardSlide(uid("sl"), { play: p.play_id }, p.title || "Jugada"));
          }
        }}
        options={
          boards.length + plays.length
            ? [
                ...plays.map((p, i) => ({ value: `p:${p.play_id}`, label: p.title || p.play_id, group: i === 0 ? "Jugadas de este partido" : undefined })),
                ...boards.map((b, i) => ({ value: `b:${b.board_id}`, label: b.title || b.board_id, group: i === 0 ? "Pizarrón" : undefined })),
              ]
            : [{ value: "-", label: "No hay jugadas ni pizarrones (se hacen en Estudio)" }]
        }
      />
    </div>
  );

  if (slides.length === 0)
    return (
      <div className="space-y-4">
        <Card>
          <p className="text-sm text-pretty text-muted">
            La presentación está vacía. En cualquier gráfico del dashboard, el botón con el icono de pantalla de presentación lo añade como diapositiva; también puedes
            empezar con una diapositiva en blanco o con un clip editado de Estudio. Aquí las ordenas, les pones título, notas, texto, cuadros y flechas, y las muestras a
            pantalla completa.
          </p>
        </Card>
        {adders}
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={() => setPlaying(0)}>
          <Play size={14} weight="fill" /> Presentar
        </button>
        {adders}
        <span className="text-xs text-faint">{slides.length} diapositiva(s). Flechas para pasar, Esc para salir; en vivo: D dibuja, L señala, C borra.</span>
      </div>
      <ol className="space-y-3">
        {slides.map((s, i) => (
          <li key={s.id} className="card flex flex-wrap items-start gap-4 !p-3">
            <button type="button" className="relative w-56 shrink-0 overflow-hidden rounded-md border border-line bg-bg" onClick={() => setPlaying(i)} aria-label={`Presentar desde «${s.title}»`}>
              <SlideCanvas slide={s} />
              {s.kind === "clip" && (
                <span className="absolute inset-0 grid place-items-center bg-bg/50 text-ink">
                  <FilmSlate size={28} />
                </span>
              )}
              {s.kind === "board" && (
                <span className="absolute inset-0 grid place-items-center bg-bg/50 text-ink">
                  <PersonSimpleRun size={28} />
                </span>
              )}
            </button>
            <div className="min-w-0 flex-1 space-y-2">
              <input className={`${input} w-full`} aria-label="Título de la diapositiva" value={s.title} onChange={(e) => mutate((st) => ({ ...st, decks: editSlide(st.decks, id, s.id, { title: e.target.value }) }))} />
              <textarea
                className={`${input} min-h-16 w-full`}
                aria-label="Nota de la diapositiva"
                placeholder="Nota para decir en voz alta (se muestra bajo la diapositiva)"
                value={s.note}
                onChange={(e) => mutate((st) => ({ ...st, decks: editSlide(st.decks, id, s.id, { note: e.target.value }) }))}
              />
              {s.kind === "board" && <p className="m-0 text-xs text-faint">Animación: se reproduce al presentar, con sus pasos y dibujos; se puede pausar o mover con la barra.</p>}
              {s.kind !== "clip" && (
                <button type="button" className="btn" onClick={() => setEditing(s.id)}>
                  <PencilSimpleLine size={14} />
                  Texto, cuadros y flechas{(s.items?.length ?? 0) > 0 ? ` · ${s.items?.length}` : ""}
                </button>
              )}
              {s.kind === "clip" && <p className="m-0 text-xs text-faint">Clip de Estudio: se reproduce su MP4 exportado (Estudio › Jugadas › Exportar).</p>}
            </div>
            <div className="flex flex-col gap-1">
              <button type="button" className="btn btn-ghost !p-1.5" aria-label="Subir" disabled={i === 0} onClick={() => mutate((st) => ({ ...st, decks: moveSlide(st.decks, id, s.id, -1) }))}>
                <ArrowUp size={14} />
              </button>
              <button type="button" className="btn btn-ghost !p-1.5" aria-label="Bajar" disabled={i === slides.length - 1} onClick={() => mutate((st) => ({ ...st, decks: moveSlide(st.decks, id, s.id, 1) }))}>
                <ArrowDown size={14} />
              </button>
              <button type="button" className="btn btn-ghost !p-1.5 hover:text-danger" aria-label="Quitar de la presentación" onClick={() => mutate((st) => ({ ...st, decks: removeSlide(st.decks, id, s.id) }))}>
                <Trash size={14} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      {editingSlide && <SlideEditor matchId={id} slide={editingSlide} onClose={() => setEditing(null)} />}
      {playing !== null && <Stage match={match} slides={slides} start={Math.min(playing, slides.length - 1)} onClose={() => setPlaying(null)} />}
    </div>
  );
}

// The newest exported MP4 of an edit (matches/<folder>/clips/<edit_id>_*.mp4), or null while it is not there.
function useClipFile(folder: string | undefined, editId: string | undefined): { url: string | null; looked: boolean } {
  const [out, setOut] = useState<{ key: string; url: string | null } | null>(null);
  const key = `${folder}|${editId}`;
  useEffect(() => {
    if (!folder || !editId) return;
    let live = true;
    void listLocal(`matches/${folder}/clips`).then((files) => {
      const hit = (files ?? [])
        .filter((f) => !f.dir && f.name.startsWith(`${editId}_`) && f.name.endsWith(".mp4") && !f.name.endsWith(".part.mp4"))
        .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0];
      if (live) setOut({ key, url: hit ? localUrl(`matches/${folder}/clips/${hit.name}`) : null });
    });
    return () => {
      live = false;
    };
  }, [folder, editId, key]);
  return out && out.key === key ? { url: out.url, looked: true } : { url: null, looked: false };
}

type Tool = "none" | "pen" | "laser";
type Stroke = { color: string; pts: [number, number][] };
const PEN_COLORS = ["#ff4d4d", "#ffd23f", "#ffffff", "#3ddc97"];

// Full screen: one slide at a time, arrows / space / swipe to move, Esc to leave. With the pen (D) or the pointer (L) the
// presenter draws or points over the slide while talking; C clears the drawing of the slide, V stops drawing.
function Stage({ match, slides, start, onClose }: { match: Match; slides: Slide[]; start: number; onClose: () => void }) {
  const state = useStore();
  const [i, setI] = useState(start);
  const [tool, setTool] = useState<Tool>("none");
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [strokes, setStrokes] = useState<Record<string, Stroke[]>>({});
  const [laser, setLaser] = useState<[number, number] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const live = useRef<Stroke | null>(null);
  const go = useCallback((by: number) => setI((n) => Math.max(0, Math.min(slides.length - 1, n + by))), [slides.length]);
  const s = slides[i];
  const mine = strokes[s.id] ?? [];
  const clip = useClipFile(match.folder, s.kind === "clip" ? s.clip : undefined);

  useEffect(() => {
    const el = root.current;
    void el?.requestFullscreen?.().catch(() => {});
    const key = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else if (e.key === "Escape") onClose();
      else if (k === "d") setTool((t) => (t === "pen" ? "none" : "pen"));
      else if (k === "l") setTool((t) => (t === "laser" ? "none" : "laser"));
      else if (k === "v") setTool("none");
      else if (k === "c") setStrokes((m) => ({ ...m, [slides[i].id]: [] }));
      else return;
      e.preventDefault();
    };
    const fs = () => {
      if (!document.fullscreenElement) onClose();
    };
    window.addEventListener("keydown", key);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("fullscreenchange", fs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [go, onClose, i, slides]);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * SLIDE_W, ((e.clientY - r.top) / r.height) * SLIDE_H];
  };
  const touch = useRef<number | null>(null);
  const path = (pts: [number, number][]) => pts.map((p, n) => `${n ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const drawing = (
    <svg
      viewBox={`0 0 ${SLIDE_W} ${SLIDE_H}`}
      className={`absolute inset-0 h-full w-full ${tool === "none" ? "pointer-events-none" : "touch-none"}`}
      style={{ cursor: tool === "pen" ? "crosshair" : tool === "laser" ? "none" : undefined }}
      onPointerDown={(e) => {
        if (tool !== "pen") return;
        e.currentTarget.setPointerCapture(e.pointerId);
        live.current = { color: penColor, pts: [at(e)] };
        setStrokes((m) => ({ ...m, [s.id]: [...(m[s.id] ?? []), live.current as Stroke] }));
      }}
      onPointerMove={(e) => {
        if (tool === "laser") return setLaser(at(e));
        const l = live.current;
        if (tool !== "pen" || !l) return;
        l.pts = [...l.pts, at(e)];
        setStrokes((m) => ({ ...m, [s.id]: [...(m[s.id] ?? []).slice(0, -1), { ...l }] }));
      }}
      onPointerUp={() => (live.current = null)}
      onPointerLeave={() => setLaser(null)}
    >
      {mine.map((st, n) => (
        <path key={n} d={path(st.pts)} fill="none" stroke={st.color} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" opacity={0.92} />
      ))}
      {tool === "laser" && laser && (
        <>
          <circle cx={laser[0]} cy={laser[1]} r={34} fill="#ff2d2d" opacity={0.25} />
          <circle cx={laser[0]} cy={laser[1]} r={13} fill="#ff2d2d" />
        </>
      )}
    </svg>
  );

  const bar = (
    <div className="flex items-center gap-1" role="toolbar" aria-label="Dibujar en vivo">
      <button type="button" className={`btn !p-1.5 ${tool === "pen" ? "btn-primary" : "btn-ghost"}`} aria-pressed={tool === "pen"} title="Marcador (D)" aria-label="Marcador" onClick={() => setTool(tool === "pen" ? "none" : "pen")}>
        <PencilSimple size={17} />
      </button>
      <button type="button" className={`btn !p-1.5 ${tool === "laser" ? "btn-primary" : "btn-ghost"}`} aria-pressed={tool === "laser"} title="Puntero (L)" aria-label="Puntero" onClick={() => setTool(tool === "laser" ? "none" : "laser")}>
        <Target size={17} />
      </button>
      {tool === "pen" &&
        PEN_COLORS.map((c) => (
          <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={penColor === c} onClick={() => setPenColor(c)} className="h-5 w-5 rounded-full" style={{ background: c, boxShadow: penColor === c ? "0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-ink)" : "inset 0 0 0 1px rgba(255,255,255,.3)" }} />
        ))}
      <button type="button" className="btn btn-ghost !p-1.5" title="Borrar lo dibujado (C)" aria-label="Borrar lo dibujado" disabled={mine.length === 0} onClick={() => setStrokes((m) => ({ ...m, [s.id]: [] }))}>
        <Eraser size={17} />
      </button>
    </div>
  );

  return (
    <div
      ref={root}
      className="fixed inset-0 z-50 flex flex-col bg-bg"
      onTouchStart={(e) => (touch.current = tool === "none" ? e.touches[0].clientX : null)}
      onTouchEnd={(e) => {
        if (touch.current === null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        touch.current = null;
      }}
    >
      <div className="flex items-center gap-3 px-6 pt-4">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">{s.title}</h2>
        {bar}
        <span className="tc text-xs text-faint">
          {i + 1} / {slides.length}
        </span>
        <button type="button" className="btn btn-ghost !p-1.5" aria-label="Salir de la presentación" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-6 py-3">
        <div className="relative w-full overflow-hidden rounded-md" style={{ maxWidth: "min(100%, calc((100vh - 11rem) * 16 / 9))" }}>
          <SlideCanvas slide={s}>
            {s.kind === "clip" &&
              (clip.url ? (
                <video key={clip.url} src={clip.url} controls autoPlay className="absolute inset-0 h-full w-full bg-black object-contain" />
              ) : (
                <div className="absolute inset-0 grid place-items-center bg-bg p-8 text-center text-sm text-muted">
                  {clip.looked ? (
                    <p className="m-0 max-w-md text-pretty">Este clip todavía no tiene un MP4 exportado. Ábrelo en Estudio › Jugadas y usa Exportar; luego vuelve aquí.</p>
                  ) : (
                    <p className="m-0">Buscando el clip…</p>
                  )}
                </div>
              ))}
            {s.kind === "board" && <BoardSlide key={s.id} board={boardOfSlide(state, s)} live />}
            {drawing}
          </SlideCanvas>
        </div>
        <button type="button" className="btn btn-ghost absolute left-2 !p-2" aria-label="Anterior" disabled={i === 0} onClick={() => go(-1)}>
          <CaretLeft size={22} />
        </button>
        <button type="button" className="btn btn-ghost absolute right-2 !p-2" aria-label="Siguiente" disabled={i === slides.length - 1} onClick={() => go(1)}>
          <CaretRight size={22} />
        </button>
      </div>
      {s.note && <p className="px-8 pb-5 text-center text-base text-pretty text-ink-2">{s.note}</p>}
    </div>
  );
}

