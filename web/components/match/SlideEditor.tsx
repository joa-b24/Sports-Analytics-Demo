"use client";

import { ArrowUpRight, CursorClick, Circle, Square, TextT, Trash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ItemShape, SLIDE_H, SLIDE_W, SlideCanvas } from "@/components/match/SlideCanvas";
import { input } from "@/components/Shell";
import { SLIDE_COLORS, SLIDE_COLOR_VAR, dropItem, editSlide, upsertItem, type Slide, type SlideItem } from "@/lib/deck";
import { mutate, uid } from "@/lib/store";

type Tool = "select" | "text" | "rect" | "ellipse" | "arrow";
const TOOLS: { id: Tool; label: string; icon: typeof TextT; hint: string }[] = [
  { id: "select", label: "Mover", icon: CursorClick, hint: "Elige una pieza y arrástrala" },
  { id: "text", label: "Texto", icon: TextT, hint: "Clic en la diapositiva" },
  { id: "rect", label: "Cuadro", icon: Square, hint: "Arrastra para dibujarlo" },
  { id: "ellipse", label: "Círculo", icon: Circle, hint: "Arrastra para dibujarlo" },
  { id: "arrow", label: "Flecha", icon: ArrowUpRight, hint: "Arrastra de dónde sale a dónde llega" },
];

// The workbench of one slide, inline (as in a design tool): the tools in a column on the left, the slide big on a grey table in
// the middle, and the inspector on the right with the title, the note and what is chosen. Every change is saved at once in the
// deck of the match. `editable` false (a clip or an animation): the slide is shown but its pieces cannot be drawn on it.
export function SlideEditor({ matchId, slide, editable = true, preview }: { matchId: string; slide: Slide; editable?: boolean; preview?: React.ReactNode }) {
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
      const t = e.target as HTMLElement | null;
      const typing = t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable;
      if (typing) return;
      if (sel && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        save(dropItem(items, sel));
        setSel(null);
      } else if (e.key === "Escape") {
        setSel(null);
        setTool("select");
      } else if (editable && !e.ctrlKey && !e.metaKey) {
        const k = { v: "select", t: "text", r: "rect", o: "ellipse", a: "arrow" }[e.key.toLowerCase()] as Tool | undefined;
        if (k) setTool(k);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, items, editable]);

  const down = (e: React.PointerEvent) => {
    if (!editable) return;
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
    setDraft(tool === "arrow" ? { id: uid("it"), kind: "arrow", x, y, x2: x, y2: y, color: colorName } : { id: uid("it"), kind: tool === "ellipse" ? "ellipse" : "rect", x, y, w: 0, h: 0, color: colorName });
  };
  const move = (e: React.PointerEvent) => {
    const [x, y] = point(e);
    if (draft) {
      const [sx, sy] = start.current;
      setDraft(draft.kind === "arrow" ? { ...draft, x2: x, y2: y } : { ...draft, x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) });
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
      // A shape is drawn from its corner while the pointer moves: keep the one that was dragged, not a click.
      const tiny = draft.kind === "arrow" ? Math.hypot(((draft.x2 ?? draft.x) - draft.x) * SLIDE_W, ((draft.y2 ?? draft.y) - draft.y) * SLIDE_H) < 20 : (draft.w ?? 0) < 0.01 || (draft.h ?? 0) < 0.01;
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
      if (tool !== "select" || !editable) return;
      e.stopPropagation();
      (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
      setSel(it.id);
      const [fx, fy] = point(e);
      drag.current = { id: it.id, fx, fy, from: it };
    },
  });
  const patchSel = (p: Partial<SlideItem>) => selected && save(upsertItem(items, { ...selected, ...p }));
  const patchSlide = (p: Partial<Pick<Slide, "title" | "note">>) => mutate((st) => ({ ...st, decks: editSlide(st.decks, matchId, slide.id, p) }));

  return (
    <div className="grid min-h-0 gap-3 lg:grid-cols-[3.25rem_minmax(0,1fr)_16.5rem]">
      {/* Tools, in a column. */}
      <div className="flex gap-1.5 lg:flex-col" role="toolbar" aria-label="Herramientas" aria-orientation="vertical">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tool === t.id}
            disabled={!editable}
            title={`${t.label} (${{ select: "V", text: "T", rect: "R", ellipse: "O", arrow: "A" }[t.id]}): ${t.hint}`}
            onClick={() => setTool(t.id)}
            className={`grid h-11 w-11 place-items-center rounded-lg transition-colors disabled:opacity-35 ${tool === t.id ? "bg-own text-white shadow-[0_6px_14px_-6px_var(--color-own)]" : "text-muted hover:bg-raised hover:text-ink"}`}
          >
            <t.icon size={20} weight={tool === t.id ? "fill" : "regular"} />
          </button>
        ))}
      </div>

      {/* The slide, big, on the table. */}
      <div className="min-w-0 rounded-xl bg-bg/60 p-4 shadow-[inset_0_0_0_1px_var(--color-line-soft)] sm:p-6">
        <div
          ref={box}
          className="relative mx-auto w-full max-w-[64rem] overflow-hidden rounded-md shadow-[0_18px_40px_-18px_rgba(0,0,0,.7),0_0_0_1px_var(--color-line)]"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          style={{ touchAction: "none", cursor: !editable ? "default" : tool === "select" ? "default" : "crosshair" }}
        >
          <SlideCanvas slide={{ ...slide, items: [] }}>{preview}</SlideCanvas>
          <svg viewBox={`0 0 ${SLIDE_W} ${SLIDE_H}`} className="absolute inset-0 h-full w-full">
            {items.map((it) => (
              <ItemShape key={it.id} it={it} selected={it.id === sel} handlers={grab(it)} />
            ))}
            {draft && <ItemShape it={draft} />}
          </svg>
        </div>
        {!editable && <p className="mt-3 mb-0 text-center text-xs text-faint">Esta diapositiva se reproduce al presentar; aquí se le ponen el título y la nota.</p>}
      </div>

      {/* Inspector. */}
      <aside className="min-w-0 space-y-4 text-xs">
        <div>
          <div className="eyebrow mb-1.5">Diapositiva</div>
          <input className={`${input} w-full`} aria-label="Título de la diapositiva" value={slide.title} onChange={(e) => patchSlide({ title: e.target.value })} />
          <textarea
            className={`${input} mt-2 min-h-20 w-full`}
            aria-label="Nota de la diapositiva"
            placeholder="Nota para decir en voz alta (se muestra bajo la diapositiva al presentar)"
            value={slide.note}
            onChange={(e) => patchSlide({ note: e.target.value })}
          />
        </div>
        {editable && (
          <>
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
                      className="h-6 w-6 rounded-full transition-transform hover:scale-110"
                      style={{ background: SLIDE_COLOR_VAR[c], boxShadow: current === c ? "0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-ink)" : "inset 0 0 0 1px var(--color-line-strong)" }}
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
                    <textarea className={`${input} min-h-16 w-full`} aria-label="Texto" value={selected.text ?? ""} onChange={(e) => patchSel({ text: e.target.value })} />
                    <label className="flex items-center gap-2 text-muted">
                      Tamaño
                      <input type="range" min={0.03} max={0.2} step={0.005} value={selected.size ?? 0.07} onChange={(e) => patchSel({ size: Number(e.target.value) })} className="min-w-0 flex-1" />
                    </label>
                  </>
                )}
                {(selected.kind === "rect" || selected.kind === "ellipse") && (
                  <>
                    <label className="flex items-center gap-2 text-muted">
                      Ancho
                      <input type="range" min={0.03} max={1} step={0.005} value={selected.w ?? 0.1} onChange={(e) => patchSel({ w: Number(e.target.value) })} className="min-w-0 flex-1" />
                    </label>
                    <label className="flex items-center gap-2 text-muted">
                      Alto
                      <input type="range" min={0.03} max={1} step={0.005} value={selected.h ?? 0.1} onChange={(e) => patchSel({ h: Number(e.target.value) })} className="min-w-0 flex-1" />
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
              <p className="m-0 text-pretty text-faint">Elige una herramienta (V, T, R, O, A) o una pieza para cambiar su color o texto. {items.length} pieza(s) en la diapositiva.</p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
