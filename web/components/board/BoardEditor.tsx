"use client";

import {
  ArrowUpRight,
  Circle,
  CircleDashed,
  CursorClick,
  LineSegments,
  Polygon,
  Plus,
  TextT,
  Trash,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { BoardView, DRAW_COLOR_LABELS, DRAW_COLOR_VAR } from "@/components/board/BoardView";
import { IconButton } from "@/components/Modal";
import { toMeters } from "@/components/Pitch";
import { btnPrimary, input } from "@/components/Shell";
import { FitAspect, PanelTitle, SidePanel, StudioFrame, ToolRail, type FrameLayout } from "@/components/studio/Studio";
import {
  ANNOTATION_LABELS,
  DRAW_COLORS,
  isValidAnnotation,
  resolve,
  resolveAll,
  type Anchor,
  type Annotation,
  type AnnotationKind,
  type Pt,
  type ResolveContext,
} from "@/lib/annotations";
import { addStep, framingBox, moveToken, removeStep, spanOfSteps, stepsOf, toggleToken } from "@/lib/boards";
import { isTyping } from "@/lib/format";
import { uid } from "@/lib/store";
import type { Board } from "@/lib/types";

type Tool = "move" | AnnotationKind;

const TOOLS: { id: Tool; label: string; key: string; icon: Icon; hint: string }[] = [
  { id: "move", label: "Mover", key: "m", icon: CursorClick, hint: "Arrastra fichas y balón. Clic en un dibujo lo elige: sus puntos fijos se arrastran y, en una flecha, el punto medio la curva." },
  { id: "highlight", label: "Resaltar", key: "r", icon: Circle, hint: "Clic en una ficha: el círculo la sigue en todos los pasos." },
  { id: "arrow", label: "Flecha", key: "f", icon: ArrowUpRight, hint: "Arrastra desde donde sale hasta donde llega. Si empieza o acaba en una ficha, la sigue." },
  { id: "line", label: "Línea", key: "l", icon: LineSegments, hint: "Clic en dos o más fichas o puntos; Enter para terminar. Entre fichas, la línea las sigue." },
  { id: "zone", label: "Zona", key: "z", icon: Polygon, hint: "Clic en tres o más fichas o puntos; Enter para terminar. Con fichas, la zona es el contorno que forman en cada paso." },
  { id: "text", label: "Texto", key: "t", icon: TextT, hint: "Clic donde va el texto y escríbelo en la lista de dibujos." },
];

// A piece is "under the pointer" within this distance (m).
const PICK_M = 2.4;
// A drag shorter than this is a click (m).
const MIN_ARROW_M = 1.5;

type Pending = { kind: "arrow" | "line" | "zone"; anchors: Anchor[]; cursor: Pt | null };
type HandleDrag = { index: number; insert: boolean; x: number; y: number };

type Panel = "step" | "board" | "list";
const PANEL_TABS: [Panel, string][] = [
  ["step", "Paso"],
  ["board", "Jugada"],
  ["list", "Jugadas"],
];

type Props = {
  board: Board;
  save: (b: Board) => void;
  // The bar on top and two tabs of the side panel come from the workspace (the play's data and the list of plays).
  header: ReactNode;
  boardPanel: ReactNode;
  listPanel: ReactNode;
  layout: FrameLayout;
};

export function BoardEditor({ board, save, header, boardPanel, listPanel, layout }: Props) {
  const [step, setStep] = useState(0);
  const [panel, setPanel] = useState<Panel>("step");
  const [tool, setTool] = useState<Tool>("move");
  const [color, setColor] = useState<string>("accent");
  const [dashed, setDashed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [handle, setHandle] = useState<HandleDrag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const k = Math.min(step, board.keyframes.length - 1);
  const kf = board.keyframes[k];
  const pos = kf?.pos ?? {};
  const t = kf?.t ?? 0;

  // Positions of this step, with the piece being dragged where the pointer is: the drawings tied to it follow it.
  const ctx: ResolveContext = {
    positionOf: (id) => {
      if (drag && id === drag.id) return [drag.x, drag.y];
      const p = pos[String(id)];
      return p ? [p[0], p[1]] : null;
    },
  };
  const sel = board.annotations.find((a) => a.id === selected) ?? null;
  // While a fixed point is dragged, the selected drawing is shown with it there.
  const shownAnnotations = useMemo(() => {
    if (!sel || !handle) return board.annotations;
    const moved = withHandle(sel, handle);
    return board.annotations.map((a) => (a.id === sel.id ? moved : a));
  }, [board.annotations, sel, handle]);
  const drawings = resolveAll(shownAnnotations, t, ctx);
  const here = board.annotations.filter((a) => stepsOf(board, a).includes(k));

  const tokenAt = (p: Pt): string | null => {
    let best: string | null = null;
    let bestD = PICK_M;
    for (const tk of board.tokens) {
      const q = pos[tk.id];
      if (!q) continue;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bestD) {
        bestD = d;
        best = tk.id;
      }
    }
    return best;
  };
  const anchorAt = (p: Pt): Anchor => {
    const id = tokenAt(p);
    return id ? { kind: "player", identity: id } : { kind: "pitch", x: round2(p[0]), y: round2(p[1]) };
  };
  const pointOf = (a: Anchor): Pt | null => (a.kind === "player" ? ctx.positionOf(a.identity, t) : [a.x, a.y]);

  const add = (kind: AnnotationKind, anchors: Anchor[], label?: string) => {
    const a: Annotation = {
      id: uid("a"),
      kind,
      anchors,
      ...spanOfSteps(board, k, k),
      style: { color, ...(dashed ? { dashed: true } : {}), ...(label ? { label } : {}) },
    };
    if (!isValidAnnotation(a)) return;
    save({ ...board, annotations: [...board.annotations, a] });
    setSelected(a.id);
    setPanel("step");
  };
  const patchAnnotation = (id: string, p: Partial<Annotation>) =>
    save({ ...board, annotations: board.annotations.map((a) => (a.id === id ? { ...a, ...p } : a)) });
  const removeAnnotation = (id: string) => {
    save({ ...board, annotations: board.annotations.filter((a) => a.id !== id) });
    if (selected === id) setSelected(null);
  };

  const finish = () => {
    if (!pending) return;
    if (pending.kind !== "arrow") add(pending.kind, pending.anchors);
    setPending(null);
  };

  const pointer = (e: { clientX: number; clientY: number }): Pt | null => {
    if (!svgRef.current) return null;
    const m = toMeters(svgRef.current, e);
    return [m.x, m.y];
  };

  const onBackground = (e: RPointerEvent<SVGSVGElement>) => {
    const p = pointer(e);
    if (!p || !kf) return;
    if (tool === "move") return setSelected(null);
    if (tool === "text") return add("text", [{ kind: "pitch", x: round2(p[0]), y: round2(p[1]) }], "Texto");
    if (tool === "arrow") return setPending({ kind: "arrow", anchors: [{ kind: "pitch", x: round2(p[0]), y: round2(p[1]) }], cursor: p });
    if (tool === "line" || tool === "zone") addToPending(tool, { kind: "pitch", x: round2(p[0]), y: round2(p[1]) }, p);
  };

  const addToPending = (kind: "line" | "zone", a: Anchor, p: Pt) =>
    setPending((cur) => {
      const list = cur && cur.kind === kind ? cur.anchors : [];
      // The same piece twice in a row is a double click, not a new point.
      const last = list[list.length - 1];
      if (last && a.kind === "player" && last.kind === "player" && last.identity === a.identity) return cur;
      return { kind, anchors: [...list, a], cursor: p };
    });

  const onToken = (id: string, e: RPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const p = pos[id];
    if (!p) return;
    const anchor: Anchor = { kind: "player", identity: id };
    if (tool === "move") return setDrag({ id, x: p[0], y: p[1] });
    if (tool === "highlight") return id === "ball" ? undefined : add("highlight", [anchor]);
    if (tool === "text") return add("text", [{ kind: "pitch", x: round2(p[0]), y: round2(p[1] - 3) }], "Texto");
    if (tool === "arrow") return setPending({ kind: "arrow", anchors: [anchor], cursor: [p[0], p[1]] });
    if (tool === "line" || tool === "zone") addToPending(tool, anchor, [p[0], p[1]]);
  };

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const p = pointer(e);
    if (!p) return;
    if (drag) setDrag({ id: drag.id, x: p[0], y: p[1] });
    else if (handle) setHandle({ ...handle, x: p[0], y: p[1] });
    else if (pending) setPending({ ...pending, cursor: p });
  };

  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    if (drag) {
      save(moveToken(board, k, drag.id, [round2(drag.x), round2(drag.y)]));
      setDrag(null);
      return;
    }
    if (handle && sel) {
      patchAnnotation(sel.id, { anchors: withHandle(sel, handle).anchors });
      setHandle(null);
      return;
    }
    if (pending?.kind === "arrow") {
      const p = pointer(e);
      const from = pointOf(pending.anchors[0]);
      if (p && from && Math.hypot(p[0] - from[0], p[1] - from[1]) >= MIN_ARROW_M) add("arrow", [pending.anchors[0], anchorAt(p)]);
      setPending(null);
    }
  };

  const chooseTool = (id: Tool) => {
    setTool(id);
    setPending(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        setPending(null);
        setSelected(null);
        return;
      }
      if (e.key === "Enter" && pending) {
        e.preventDefault();
        finish();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        removeAnnotation(selected);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const n = board.keyframes.length;
        setStep((s) => Math.max(0, Math.min(n - 1, s + (e.key === "ArrowRight" ? 1 : -1))));
        setPending(null);
        return;
      }
      const tl = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (tl) chooseTool(tl.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Fixed points of the selected drawing (to drag) and, for an arrow, the middle of each stretch (to curve it).
  const resolvedSel = sel ? resolve(sel, t, ctx) : null;
  const handles: { index: number; insert: boolean; p: Pt }[] = [];
  if (sel && resolvedSel && tool === "move" && !handle) {
    sel.anchors.forEach((a, i) => {
      if (a.kind === "pitch") handles.push({ index: i, insert: false, p: [a.x, a.y] });
    });
    if (sel.kind === "arrow")
      for (let i = 0; i < resolvedSel.points.length - 1; i++) {
        const [a, b] = [resolvedSel.points[i], resolvedSel.points[i + 1]];
        handles.push({ index: i + 1, insert: true, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
      }
  }
  const pendingPts = pending ? [...pending.anchors.map(pointOf).filter((p): p is Pt => p !== null), ...(pending.cursor ? [pending.cursor] : [])] : [];
  const hint = TOOLS.find((x) => x.id === tool)?.hint;
  const [, , vw, vh] = framingBox(board.framing);
  const aspect = vw / vh;

  if (!kf) return null;

  const stepNote = (
    <div>
      <PanelTitle>Paso {k + 1}</PanelTitle>
      <textarea
        className={`${input} w-full text-sm`}
        rows={2}
        placeholder="Nota del paso (sale en la lámina)"
        value={kf.note ?? ""}
        onChange={(e) => save({ ...board, keyframes: board.keyframes.map((x, j) => (j === k ? { ...x, note: e.target.value } : x)) })}
      />
    </div>
  );

  return (
    <StudioFrame
      {...layout}
      header={header}
      rail={
        <ToolRail
          tools={TOOLS}
          value={tool}
          onChange={chooseTool}
          color={sel ? sel.style.color : color}
          onColor={(c) => (sel ? patchAnnotation(sel.id, { style: { ...sel.style, color: c } }) : setColor(c))}
          dashed={sel ? !!sel.style.dashed : dashed}
          onDashed={(d) => (sel && sel.kind !== "text" ? patchAnnotation(sel.id, { style: { ...sel.style, dashed: d || undefined } }) : setDashed(d))}
          dashedIcon={CircleDashed}
        />
      }
      canvas={
        <div className="flex h-full flex-col">
          <p className="mb-1 min-h-5 truncate px-1 text-xs text-faint" title={hint}>
            {pending && pending.kind !== "arrow"
              ? `${ANNOTATION_LABELS[pending.kind]}: ${pending.anchors.length} ${pending.anchors.length === 1 ? "punto" : "puntos"} · Enter termina, Esc cancela`
              : hint}
          </p>
          <div className="min-h-0 flex-1">
            <FitAspect aspect={aspect}>
              <BoardView
                svgRef={svgRef}
                framing={board.framing}
                fit
                className="touch-none"
                tokens={board.tokens}
                positions={pos}
                drawings={drawings}
                selected={selected}
                drag={drag}
                onToken={onToken}
                onPickDrawing={tool === "move" ? setSelected : undefined}
                onPointerDown={onBackground}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={() => {
                  if (drag || handle) onUp({} as RPointerEvent<SVGSVGElement>);
                }}
              >
                {pendingPts.length >= 2 && (
                  <polyline
                    points={pendingPts.map((p) => p.join(",")).join(" ")}
                    fill="none"
                    stroke={DRAW_COLOR_VAR[color]}
                    strokeWidth={0.4}
                    strokeDasharray="0.8 0.8"
                    pointerEvents="none"
                  />
                )}
                {pendingPts.slice(0, pending?.anchors.length ?? 0).map((p, i) => (
                  <circle key={i} cx={p[0]} cy={p[1]} r={0.7} fill={DRAW_COLOR_VAR[color]} pointerEvents="none" />
                ))}
                {handles.map((h) => (
                  <circle
                    key={`${h.index}_${h.insert}`}
                    cx={h.p[0]}
                    cy={h.p[1]}
                    r={h.insert ? 0.8 : 1}
                    fill={h.insert ? "var(--color-bg)" : "var(--color-ink)"}
                    stroke="var(--color-accent-300)"
                    strokeWidth={0.35}
                    className="cursor-move"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setHandle({ index: h.index, insert: h.insert, x: h.p[0], y: h.p[1] });
                    }}
                  />
                ))}
              </BoardView>
            </FitAspect>
          </div>
        </div>
      }
      controls={
        <>
          <span className="cond px-1 text-[12px] font-bold tracking-wide text-muted uppercase">Pasos</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {board.keyframes.map((s, i) => (
              <button
                key={`${s.t}_${i}`}
                type="button"
                aria-pressed={i === k}
                aria-label={`Paso ${i + 1}`}
                title={s.note || `Paso ${i + 1}`}
                onClick={() => {
                  setStep(i);
                  setPending(null);
                }}
                className={`tc h-8 min-w-8 rounded-md px-2 text-xs font-semibold transition-colors ${
                  i === k ? "bg-accent-900 text-accent-300 ring-1 ring-accent/60" : "bg-raised text-ink-2 hover:bg-line"
                }`}
              >
                {i + 1}
              </button>
            ))}
            <IconButton
              label="Añadir un paso (copia las posiciones del último)"
              onClick={() => {
                save(addStep(board));
                setStep(board.keyframes.length);
              }}
            >
              <Plus size={15} />
            </IconButton>
          </div>
          <span className="hidden text-xs text-faint 2xl:inline">← → cambia de paso</span>
          {pending && pending.kind !== "arrow" && (
            <button type="button" className={btnPrimary} onClick={finish} disabled={pending.anchors.length < (pending.kind === "zone" ? 3 : 2)}>
              Terminar {ANNOTATION_LABELS[pending.kind].toLowerCase()}
            </button>
          )}
          <IconButton
            label={board.keyframes.length > 1 ? `Borrar el paso ${k + 1} y los dibujos que empiezan en él` : "La jugada necesita al menos un paso"}
            tone="danger"
            disabled={board.keyframes.length <= 1}
            onClick={() => {
              save(removeStep(board, k));
              setStep(Math.max(0, k - 1));
              setSelected(null);
            }}
          >
            <Trash size={15} />
          </IconButton>
        </>
      }
      side={
        <SidePanel tabs={PANEL_TABS} value={panel} onChange={setPanel}>
          {panel === "step" ? (
            <div className="space-y-4">
              {stepNote}
              <div>
                <PanelTitle>Dibujos del paso</PanelTitle>
                {here.length === 0 ? (
                  <p className="text-xs text-faint">Ninguno. Elige una herramienta en la barra y dibuja sobre la cancha.</p>
                ) : (
                  <ul className="space-y-2">
                    {here.map((a) => (
                      <DrawingRow
                        key={a.id}
                        a={a}
                        board={board}
                        active={a.id === selected}
                        onSelect={() => setSelected(a.id)}
                        onPatch={(p) => patchAnnotation(a.id, p)}
                        onRemove={() => removeAnnotation(a.id)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : panel === "board" ? (
            <div className="space-y-4">
              {boardPanel}
              <div>
                <PanelTitle>Fichas</PanelTitle>
                <p className="mb-2 text-xs text-faint">Dorsal o rol de cada ficha. Quitar una la saca de todos los pasos (y borra sus dibujos).</p>
                <ul className="grid grid-cols-2 gap-1.5">
                  {board.tokens.map((tk) => {
                    const on = board.keyframes.some((x) => x.pos[tk.id]);
                    return (
                      <li key={tk.id} className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={on} aria-label={on ? "Quitar del pizarrón" : "Poner en el pizarrón"} onChange={() => save(toggleToken(board, tk.id))} />
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: tk.team === "ball" ? "var(--color-ball)" : tk.team === "own" ? "var(--color-own)" : "var(--color-opp)" }}
                        />
                        {tk.team === "ball" ? (
                          <span className="text-muted">Balón</span>
                        ) : (
                          <input
                            className={`${input} h-7 w-full min-w-0 px-2 py-0 text-xs`}
                            value={tk.label}
                            maxLength={4}
                            aria-label="Dorsal o rol"
                            onChange={(e) => save({ ...board, tokens: board.tokens.map((x) => (x.id === tk.id ? { ...x, label: e.target.value } : x)) })}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          ) : (
            listPanel
          )}
        </SidePanel>
      }
    />
  );
}

function DrawingRow({
  a,
  board,
  active,
  onSelect,
  onPatch,
  onRemove,
}: {
  a: Annotation;
  board: Board;
  active: boolean;
  onSelect: () => void;
  onPatch: (p: Partial<Annotation>) => void;
  onRemove: () => void;
}) {
  const steps = stepsOf(board, a);
  const from = steps[0] ?? 0;
  const to = steps[steps.length - 1] ?? from;
  return (
    <li
      onClick={onSelect}
      className={`rounded-xl border p-2 text-xs transition-colors ${active ? "border-accent bg-accent/10" : "border-line-soft hover:border-line"}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-ink">{ANNOTATION_LABELS[a.kind]}</span>
        <span className="text-faint">{a.anchors.filter((x) => x.kind === "player").length > 0 ? "sigue a fichas" : "fijo"}</span>
        <span className="ml-auto">
          <IconButton label="Borrar el dibujo (Supr)" tone="danger" onClick={onRemove}>
            <Trash size={13} />
          </IconButton>
        </span>
      </div>
      <input
        className={`${input} mt-1.5 h-7 w-full px-2 py-0 text-xs`}
        placeholder={a.kind === "text" ? "Texto" : "Rótulo (opcional)"}
        value={a.style.label ?? ""}
        onChange={(e) => onPatch({ style: { ...a.style, label: e.target.value || undefined } })}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <ColorPick value={a.style.color} onChange={(c) => onPatch({ style: { ...a.style, color: c } })} small />
        {a.kind !== "text" && (
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!a.style.dashed} onChange={(e) => onPatch({ style: { ...a.style, dashed: e.target.checked || undefined } })} />
            Discontinua
          </label>
        )}
        <label className="flex items-center gap-1 text-muted">
          Hasta el paso
          <select className={`${input} h-7 py-0 text-xs`} value={to} onChange={(e) => onPatch(spanOfSteps(board, from, Number(e.target.value)))}>
            {board.keyframes.map((_, i) =>
              i >= from ? (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ) : null,
            )}
          </select>
        </label>
      </div>
    </li>
  );
}

function ColorPick({ value, onChange, small = false }: { value: string; onChange: (c: string) => void; small?: boolean }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Color">
      {DRAW_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          title={DRAW_COLOR_LABELS[c]}
          onClick={(e) => {
            e.stopPropagation();
            onChange(c);
          }}
          className={`rounded-full transition-transform ${small ? "h-4 w-4" : "h-5 w-5"} ${value === c ? "scale-110 ring-2 ring-ink ring-offset-2 ring-offset-bg" : "hover:scale-110"}`}
          style={{ background: DRAW_COLOR_VAR[c] }}
        />
      ))}
    </div>
  );
}

// The drawing with a fixed point moved (or a point added in the middle of an arrow, to curve it).
function withHandle(a: Annotation, h: HandleDrag): Annotation {
  const p: Anchor = { kind: "pitch", x: round2(h.x), y: round2(h.y) };
  const anchors = h.insert ? [...a.anchors.slice(0, h.index), p, ...a.anchors.slice(h.index)] : a.anchors.map((x, i) => (i === h.index ? p : x));
  return { ...a, anchors };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
