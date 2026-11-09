"use client";

import { ArrowDown, ArrowUp, CaretLeft, CaretRight, Play, Trash, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, input } from "@/components/Shell";
import { editSlide, moveSlide, removeSlide, slidesOf, type Slide } from "@/lib/deck";
import { mutate, useStore } from "@/lib/store";
import type { Match } from "@/lib/types";

// The presentation of a match: the slides are charts added from the analysis (button «Añadir a la presentación» on each
// panel). Here they are ordered, titled and annotated, and shown full screen for the coaches.
export function DeckView({ match }: { match: Match }) {
  const state = useStore();
  const id = match.match_id;
  const slides = slidesOf(state.decks, id);
  const [playing, setPlaying] = useState<number | null>(null);

  if (slides.length === 0)
    return (
      <Card>
        <p className="text-sm text-pretty text-muted">
          La presentación está vacía. En cualquier gráfico de la pantalla de análisis, el botón con el icono de pantalla de presentación lo añade como una diapositiva.
          Aquí las ordenas, les pones título y notas, y las muestras a pantalla completa.
        </p>
      </Card>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={() => setPlaying(0)}>
          <Play size={14} weight="fill" /> Presentar
        </button>
        <span className="text-xs text-faint">{slides.length} diapositiva(s). Flechas para pasar, Esc para salir.</span>
      </div>
      <ol className="space-y-3">
        {slides.map((s, i) => (
          <li key={s.id} className="card flex flex-wrap items-start gap-4 !p-3">
            <button type="button" className="w-56 shrink-0 overflow-hidden rounded-lg border border-line bg-bg" onClick={() => setPlaying(i)} aria-label={`Presentar desde «${s.title}»`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.image} alt={s.title} className="h-full w-full object-contain" />
            </button>
            <div className="min-w-0 flex-1 space-y-2">
              <input className={`${input} w-full`} aria-label="Título de la diapositiva" value={s.title} onChange={(e) => mutate((st) => ({ ...st, decks: editSlide(st.decks, id, s.id, { title: e.target.value }) }))} />
              <textarea
                className={`${input} min-h-16 w-full`}
                aria-label="Nota de la diapositiva"
                placeholder="Nota para decir en voz alta (se muestra bajo el gráfico)"
                value={s.note}
                onChange={(e) => mutate((st) => ({ ...st, decks: editSlide(st.decks, id, s.id, { note: e.target.value }) }))}
              />
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
      {playing !== null && <Stage slides={slides} start={Math.min(playing, slides.length - 1)} onClose={() => setPlaying(null)} />}
    </div>
  );
}

// Full screen: one slide at a time, arrows / space / swipe to move, Esc to leave.
function Stage({ slides, start, onClose }: { slides: Slide[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const root = useRef<HTMLDivElement>(null);
  const go = useCallback((by: number) => setI((n) => Math.max(0, Math.min(slides.length - 1, n + by))), [slides.length]);

  useEffect(() => {
    const el = root.current;
    void el?.requestFullscreen?.().catch(() => {});
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else if (e.key === "Escape") onClose();
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
  }, [go, onClose]);

  const touch = useRef<number | null>(null);
  const s = slides[i];
  return (
    <div
      ref={root}
      className="fixed inset-0 z-50 flex flex-col bg-bg"
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current === null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        touch.current = null;
      }}
    >
      <div className="flex items-center gap-3 px-6 pt-4">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">{s.title}</h2>
        <span className="tc text-xs text-faint">
          {i + 1} / {slides.length}
        </span>
        <button type="button" className="btn btn-ghost !p-1.5" aria-label="Salir de la presentación" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-6 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={s.image} alt={s.title} className="max-h-full max-w-full object-contain" />
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
