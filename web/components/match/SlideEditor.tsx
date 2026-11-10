"use client";

import { ArrowUpRight, CursorClick, Square, TextT, Trash, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ItemShape, SLIDE_H, SLIDE_W, SlideCanvas } from "@/components/match/SlideCanvas";
import { SLIDE_COLORS, SLIDE_COLOR_VAR, dropItem, editSlide, upsertItem, type Slide, type SlideItem } from "@/lib/deck";
import { mutate, uid } from "@/lib/store";

type Tool = "select" | "text" | "rect" | "arrow";
const TOOLS: { id: Tool; label: string; icon: typeof TextT; hint: string }[] = [
  { id: "select", label: "Mover", icon: CursorClick, hint: "Elige una pieza y arrástrala" },
  { id: "text", label: "Texto", icon: TextT, hint: "Clic en la diapositiva" },
  { id: "rect", label: "Cuadro", icon: Square, hint: "Arrastra para dibujarlo" },
  { id: "arrow", label: "Flecha", icon: ArrowUpRight, hint: "Arrastra de dónde sale a dónde llega" },
];

// Edits the text, boxes and arrows of one slide over its chart: pick a tool, draw, move, change colour or size. Every
// change is saved at once in the deck of the match.
export function SlideEditor({ matchId, slide, onClose }: { matchId: string; slide: Slide; onClose: () => void }) {
  const [tool, setTool] = useState<Tool>("select");
  const [colorName, setColorName] = useState<string>("warn");
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<SlideItem | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; fx: number; fy: number; from: SlideItem } | null>(null);
  // Where a box or arrow being drawn started (a box grows from this corner whichever way the pointer goes).
  const start = useRef<[number, number]>([0, 0]);
  const items = slide.items ?? [];
  const selected = items.find((i) => i.id === sel) ?? null;

  const save = (next: SlideItem[]) => mutate((st) => ({ ...st, decks: editSlide(st.decks, matchId, slide.id, { items: next }) }));
  const point = (e: React.PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.tagName === "INPUT" || (e.target as HTMLElement | null)?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (!typing && sel && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        save(dropItem(items, sel));
        setSel(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, items, onClose]);

  const down = (e: React.PointerEvent) => {
    if (tool === "select") return setSel(null);
    const [x, y] = point(e);
    if (tool === "text") {
      const it: SlideItem = { id: uid("it"), kind: "text", x, y, text: "Texto", size: 0.07, color: colorName };
      save(upsertItem(items, it));
      setSel(it.id);
      setTool("select");
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = [x, y];
    setDraft(tool === "rect" ? { id: uid("it"), kind: "rect", x, y, w: 0, h: 0, color: colorName } : { id: uid("it"), kind: "arrow", x, y, x2: x, y2: y, color: colorName });
  };
  const move = (e: React.PointerEvent) => {
    const [x, y] = point(e);
    if (draft) {
      const [sx, sy] = start.current;
      setDraft(draft.kind === "rect" ? { ...draft, x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) } : { ...draft, x2: x, y2: y });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = x - d.fx;
    const dy = y - d.fy;
    const f = d.from;
    const moved: SlideItem = { ...f, x: f.x + dx, y: f.y + dy, ...(f.kind === "arrow" ? { x2: (f.x2 ?? f.x) + dx, y2: (f.y2 ?? f.y) + dy } : {}) };
    save(upsertItem(items, moved));
  };
  const up = () => {
    if (draft) {
      // A rectangle is drawn from its corner while the pointer moves: keep the one that was dragged, not a click.
      const tiny = draft.kind === "rect" ? (draft.w ?? 0) < 0.01 || (draft.h ?? 0) < 0.01 : Math.hypot(((draft.x2 ?? draft.x) - draft.x) * SLIDE_W, ((draft.y2 ?? draft.y) - draft.y) * SLIDE_H) < 20;
      if (!tiny) {
        save(upsertItem(items, draft));
        setSel(draft.id);
        setTool("select");
      }
      setDraft(null);
    }
    drag.current = null;
  };
  const grab = (it: SlideItem) => ({
    onPointerDown: (e: React.PointerEvent<SVGGElement>) => {
      if (tool !== "select") return;
      e.stopPropagation();
      (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
      setSel(it.id);
      const [fx, fy] = point(e);
      drag.current = { id: it.id, fx, fy, from: it };
    },
  });
  const patchSel = (p: Partial<SlideItem>) => selected && save(upsertItem(items, { ...selected, ...p }));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/80 p-4 backdrop-blur-sm" role="presentation" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Editar la diapositiva" onClick={(e) => e.stopPropagation()} className="enter flex max-h-[94vh] w-[min(78rem,96vw)] flex-col overflow-hidden rounded-lg bg-raised shadow-[0_0_0_1px_var(--color-line-strong),0_30px_60px_-20px_rgba(0,0,0,.8)]">
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 className="m-0 min-w-0 flex-1 truncate text-base text-ink">{slide.title}</h2>
          <button type="button" className="btn h-8 w-8 !p-0" aria-label="Cerrar" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div ref={box} className="relative self-start overflow-hidden rounded-md shadow-[0_0_0_1px_var(--color-line)]" onPointerDown={down} onPointerMove={move} onPointerUp={up} style={{ touchAction: "none", cursor: tool === "select" ? "default" : "crosshair" }}>
            <SlideCanvas slide={{ ...slide, items: [] }} />
            <svg viewBox={`0 0 ${SLIDE_W} ${SLIDE_H}`} className="absolute inset-0 h-full w-full">
              {items.map((it) => (
                <ItemShape key={it.id} it={it} selected={it.id === sel} handlers={grab(it)} />
              ))}
              {draft && <ItemShape it={draft} />}
            </svg>
          </div>
          <aside className="space-y-4 text-xs">
            <div>
              <div className="eyebrow mb-1.5">Herramienta</div>
              <div className="grid grid-cols-2 gap-1.5">
                {TOOLS.map((t) => (
                  <button key={t.id} type="button" aria-pressed={tool === t.id} title={t.hint} onClick={() => setTool(t.id)} className={`btn justify-start ${tool === t.id ? "btn-primary" : ""}`}>
                    <t.icon size={15} />
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-faint">{TOOLS.find((t) => t.id === tool)?.hint}</p>
            </div>
            <div>
              <div className="eyebrow mb-1.5">Color</div>
              <div className="flex gap-1.5">
                {SLIDE_COLORS.map((c) => {
                  const current = selected ? selected.color : colorName;
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color ${c}`}
                      aria-pressed={current === c}
                      onClick={() => (selected ? patchSel({ color: c }) : setColorName(c))}
                      className="h-6 w-6 rounded-full transition-transform"
                      style={{ background: SLIDE_COLOR_VAR[c], boxShadow: current === c ? "0 0 0 2px var(--color-raised), 0 0 0 4px var(--color-ink)" : "inset 0 0 0 1px var(--color-line-strong)" }}
                    />
                  );
                })}
              </div>
            </div>
            {selected ? (
              <div className="space-y-2.5">
                <div className="eyebrow">Pieza elegida</div>
                {selected.kind === "text" && (
                  <>
                    <textarea className="input min-h-16 w-full" aria-label="Texto" value={selected.text ?? ""} onChange={(e) => patchSel({ text: e.target.value })} />
                    <label className="flex items-center gap-2 text-muted">
                      Tamaño
                      <input type="range" min={0.03} max={0.2} step={0.005} value={selected.size ?? 0.07} onChange={(e) => patchSel({ size: Number(e.target.value) })} className="min-w-0 flex-1" />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  className="btn hover:text-danger"
                  onClick={() => {
                    save(dropItem(items, selected.id));
                    setSel(null);
                  }}
                >
                  <Trash size={14} />
                  Quitar (Supr)
                </button>
              </div>
            ) : (
              <p className="text-faint">Elige una pieza para cambiar su color o texto. {items.length} pieza(s) en la diapositiva.</p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
