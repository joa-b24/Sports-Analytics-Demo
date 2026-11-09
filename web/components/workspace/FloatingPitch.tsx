"use client";

import { ArrowsOutSimple, MapTrifold, Minus, Plus, X } from "@phosphor-icons/react";
import { useState } from "react";

// A map of the pitch over the full-screen video: it can be dragged by its title, made larger or smaller (buttons or the
// corner) and hidden (a small «Mapa» button brings it back). Where it was left is kept while the page is open.
let last = { x: 16, y: 72, w: 360, hidden: false };
const MIN_W = 180;

export function FloatingPitch({ children, title = "Mapa" }: { children: React.ReactNode; title?: string }) {
  const [box, setBoxState] = useState(last);
  const setBox = (b: typeof last) => {
    last = b;
    setBoxState(b);
  };
  const start = (e: React.PointerEvent, kind: "move" | "size") => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const from = box;
    // Listening on the window: the pointer can leave the title while it is dragged.
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (kind === "move") setBox({ ...from, x: Math.max(0, from.x + dx), y: Math.max(0, from.y + dy) });
      else setBox({ ...from, w: Math.max(MIN_W, Math.min(window.innerWidth - 32, from.w + dx)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  if (box.hidden) {
    return (
      <button type="button" className="btn absolute z-20" style={{ left: box.x, top: box.y }} title="Mostrar el mapa de la cancha" onClick={() => setBox({ ...box, hidden: false })}>
        <MapTrifold size={15} /> Mapa
      </button>
    );
  }
  return (
    <div className="absolute z-20 overflow-hidden rounded-2xl bg-surface/90 shadow-[0_0_0_1px_var(--color-line),0_18px_40px_-12px_rgba(0,0,0,.7)] backdrop-blur" style={{ left: box.x, top: box.y, width: box.w }} data-testid="floating-pitch">
      <div className="flex cursor-grab touch-none items-center gap-1 px-2 py-1 text-[11px] text-muted select-none active:cursor-grabbing" onPointerDown={(e) => start(e, "move")}>
        <span className="flex-1 text-ink-2">{title}</span>
        <button type="button" className="rounded p-1 hover:text-ink" aria-label="Achicar el mapa" onPointerDown={(e) => e.stopPropagation()} onClick={() => setBox({ ...box, w: Math.max(MIN_W, box.w - 60) })}>
          <Minus size={13} />
        </button>
        <button type="button" className="rounded p-1 hover:text-ink" aria-label="Agrandar el mapa" onPointerDown={(e) => e.stopPropagation()} onClick={() => setBox({ ...box, w: Math.min(window.innerWidth - 32, box.w + 60) })}>
          <Plus size={13} />
        </button>
        <button type="button" className="rounded p-1 hover:text-ink" aria-label="Ocultar el mapa" onPointerDown={(e) => e.stopPropagation()} onClick={() => setBox({ ...box, hidden: true })}>
          <X size={13} />
        </button>
      </div>
      <div className="px-1 pb-1">{children}</div>
      <div className="absolute right-0 bottom-0 grid h-5 w-5 cursor-nwse-resize touch-none place-items-center text-faint" aria-label="Cambiar el tamaño del mapa" onPointerDown={(e) => start(e, "size")}>
        <ArrowsOutSimple size={11} />
      </div>
    </div>
  );
}
