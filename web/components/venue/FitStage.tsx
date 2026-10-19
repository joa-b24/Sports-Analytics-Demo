"use client";

import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsOutCardinal,
  Check,
  CheckCircle,
  CornersOut,
  FlipVertical,
  ImageSquare,
  ListChecks,
  MagnifyingGlass,
  PencilLine,
  Ruler,
  SoccerBall,
  Trash,
  Upload,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Num } from "@/components/venue/fields";
import { ModelDrawing } from "@/components/venue/ModelDrawing";
import { uid } from "@/lib/store";
import type { Pt } from "@/lib/homography";
import type { VenueSpec } from "@/lib/types";
import { buildVenue } from "@/lib/venue";
import {
  corners,
  dragHandle,
  edgeMids,
  fitRect,
  handlePoint,
  imageToModel,
  impliedMeasures,
  modelDistance,
  modelToImage,
  rectScale,
  referenceGroups,
  resizeToSpec,
  rotHandle,
  segLength,
  type Handle,
  type PitchRect,
  type VenueLayer,
} from "@/lib/venueFit";

// The image side of the venue editor: a satellite capture (or a drone photo) with the venue drawn over it. The pitch
// is a rectangle that keeps its right angles: drag inside to move it, the corners and the middle of each side to fit
// the sides, the handle above it to turn it. A loupe follows the cursor. Tools: scale bar, goal mouth, extra lines and
// mowing stripes, and a checklist of reference points. The image stays in this tab; only the venue settings are kept.

type Tool = "fit" | "scale" | "goal" | "draw" | "check";
type Seg = [Pt, Pt];
type View = { x: number; y: number; w: number; h: number };
// The rectangle and the venue measures it was drawn for: when the measures change it is redrawn from them.
type Fit = { r: PitchRect; L: number; W: number };
type Drag = { kind: "handle"; h: Handle; start: PitchRect; from: Pt } | { kind: "press"; client: Pt; view: View; moved: boolean; img: Pt };

const TOOLS: { id: Tool; label: string; icon: typeof Ruler }[] = [
  { id: "fit", label: "Calzar cancha", icon: ArrowsOutCardinal },
  { id: "scale", label: "Escala", icon: Ruler },
  { id: "goal", label: "Portería", icon: SoccerBall },
  { id: "draw", label: "Dibujar", icon: PencilLine },
  { id: "check", label: "Verificar", icon: ListChecks },
];
const LINE_PAINTS: [string, string][] = [
  ["Blanco", "#f8fafc"],
  ["Verde pasto", "#a3e635"],
  ["Amarillo", "#facc15"],
  ["Cian", "#67e8f9"],
];
const LOUPE = 176;
const DEG = Math.PI / 180;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

type Props = {
  spec: VenueSpec;
  onChange: (p: Partial<VenueSpec>) => void;
  focus: string | null;
  setFocus: (g: string | null) => void;
};

export function FitStage({ spec, onChange, focus, setFocus }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [tool, setTool] = useState<Tool>("fit");
  const [scaleSeg, setScaleSeg] = useState<Seg | null>(null);
  const [scaleM, setScaleM] = useState<number | undefined>(20);
  const [goalSeg, setGoalSeg] = useState<Seg | null>(null);
  const [pending, setPending] = useState<Pt | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ img: Pt; sx: number; sy: number } | null>(null);
  const [selected, setSelected] = useState<Handle>("body");
  const [opacity, setOpacity] = useState(0.85);
  const [loupe, setLoupe] = useState(true);
  const [mag, setMag] = useState(4);
  const [drawKind, setDrawKind] = useState<"line" | "stripes">("line");
  const [lineColor, setLineColor] = useState(LINE_PAINTS[1][1]);
  const [over, setOver] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const L = spec.length_m;
  const W = spec.width_m;
  const venue = buildVenue(spec);
  const pxPerM = scaleSeg && scaleM && scaleM > 0 ? segLength(scaleSeg[0], scaleSeg[1]) / scaleM : null;
  // Redrawn from the measures when they changed since the last fit: with the scale bar when there is one, else the
  // length keeps its pixels per meter.
  const rect: PitchRect | null = fit
    ? fit.L === L && fit.W === W
      ? fit.r
      : resizeToSpec(fit.r, L, W, pxPerM ?? fit.r.lpx / fit.L)
    : null;
  const setRect = (r: PitchRect) => setFit({ r, L, W });
  // Screen pixels per image pixel (the view keeps its proportions inside the box).
  const k = view ? Math.min(box.w / view.w, box.h / view.h) : 1;
  const unit = 1 / k;
  const dragging = drag?.kind === "handle";

  // Box size, for the scale of handles and the pan.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width || 1, h: e.contentRect.height || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const load = useCallback(
    (file: File | Blob) => {
      const next = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return next;
        });
        const s = { w: img.naturalWidth, h: img.naturalHeight };
        setSize(s);
        setView({ x: 0, y: 0, w: s.w, h: s.h });
        setFit({ r: fitRect(s.w, s.h, L, W), L, W });
        setScaleSeg(null);
        setGoalSeg(null);
        setPending(null);
        setTool("fit");
      };
      img.src = next;
    },
    [L, W],
  );

  // Paste a capture straight from the clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (f) {
        e.preventDefault();
        load(f);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [load]);

  const toImg = (clientX: number, clientY: number): Pt | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  };

  // Wheel: zoom around the cursor. Registered by hand because React's wheel listener cannot prevent the page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !size) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      const f = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        if (!v) return v;
        const w = Math.min(size.w, Math.max(size.w / 16, v.w / f));
        const h = (v.h * w) / v.w;
        return { x: p.x - ((p.x - v.x) * w) / v.w, y: p.y - ((p.y - v.y) * h) / v.h, w, h };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [size]);

  const addLayer = (layer: VenueLayer) => onChange({ layers: [...(spec.layers ?? []), layer] });
  const stripes = (spec.layers ?? []).find((l) => l.kind === "stripes");
  const lines = (spec.layers ?? []).filter((l) => l.kind === "line");
  const updateStripes = (p: Partial<Extract<VenueLayer, { kind: "stripes" }>>) =>
    onChange({ layers: (spec.layers ?? []).map((l) => (l.kind === "stripes" ? { ...l, ...p } : l)) });

  // A click that did not drag: the two-click tools take it.
  const click = (p: Pt) => {
    if (tool === "fit" || tool === "check") return;
    if (tool === "draw" && drawKind === "stripes") return;
    if (!pending) return setPending(p);
    const seg: Seg = [pending, p];
    setPending(null);
    if (tool === "scale") setScaleSeg(seg);
    else if (tool === "goal") setGoalSeg(seg);
    else if (tool === "draw" && rect) {
      addLayer({ id: uid("capa"), kind: "line", color: lineColor, pts: seg.map((q) => imageToModel(rect, L, W, q).map((v) => round(v, 2)) as Pt) });
    }
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = toImg(e.clientX, e.clientY);
    if (!p || !view) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const h = (e.target as Element).closest("[data-handle]")?.getAttribute("data-handle") as Handle | null;
    if (h && rect && tool === "fit") {
      setSelected(h);
      setDrag({ kind: "handle", h, start: rect, from: p });
      return;
    }
    setDrag({ kind: "press", client: [e.clientX, e.clientY], view, moved: false, img: p });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toImg(e.clientX, e.clientY);
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (p && wrap) setHover({ img: p, sx: e.clientX - wrap.left, sy: e.clientY - wrap.top });
    if (!drag || !p) return;
    if (drag.kind === "handle") {
      setRect(dragHandle(drag.start, drag.h, drag.from, p));
      return;
    }
    const dx = e.clientX - drag.client[0];
    const dy = e.clientY - drag.client[1];
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    setView({ ...drag.view, x: drag.view.x - dx / k, y: drag.view.y - dy / k });
  };

  const onPointerUp = () => {
    if (drag?.kind === "press" && !drag.moved) click(drag.img);
    setDrag(null);
  };

  // Keyboard: arrows move the selected handle one screen pixel (Shift: ten), Q / E turn 0.1° (Shift: 1°), L shows
  // the loupe, Esc drops a half-made measure.
  const onKey = (e: React.KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (key === "escape") return setPending(null);
    if (key === "l") return setLoupe((v) => !v);
    if (!rect || tool !== "fit") return;
    const step = (e.shiftKey ? 10 : 1) / k;
    const moves: Record<string, Pt> = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
    if (moves[key]) {
      e.preventDefault();
      const from = handlePoint(rect, selected, 30 * unit);
      const to: Pt = [from[0] + moves[key][0], from[1] + moves[key][1]];
      setRect(dragHandle(rect, selected === "rot" ? "body" : selected, from, to));
    } else if (key === "q" || key === "e") {
      e.preventDefault();
      setRect({ ...rect, angle: rect.angle + (key === "q" ? -1 : 1) * (e.shiftKey ? 1 : 0.1) * DEG });
    }
  };

  const toolHint: Record<Tool, string> = {
    fit: "Arrastra la cancha para moverla, las esquinas y los lados para calzarla y el tirador de arriba para girarla. Rueda: zoom; arrastrar fuera de la cancha: desplazar.",
    scale: pending ? "Ahora el otro extremo de la barra." : "Haz clic en los dos extremos de la barra de escala del mapa.",
    goal: pending ? "Ahora el otro poste." : "Haz clic en los dos postes de una portería.",
    draw: drawKind === "stripes" ? "Ajusta el ancho y el desplazamiento hasta que las franjas caigan sobre el pasto." : pending ? "Ahora el final de la línea." : "Dos clics: inicio y final de la línea.",
    check: "Elige un grupo para resaltarlo y comprueba con la lupa que sus puntos caen sobre la pintura.",
  };

  const implied = rect ? impliedMeasures(rect, L, pxPerM) : null;
  const goalM = rect && goalSeg ? modelDistance(rect, L, W, goalSeg[0], goalSeg[1]) : null;
  const groups = referenceGroups(spec.kind);
  const checked = new Set(spec.checked ?? []);
  const toggleChecked = (id: string) => onChange({ checked: checked.has(id) ? [...checked].filter((c) => c !== id) : [...checked, id] });

  // Everything drawn over the image, at a given size of one screen pixel in image units (the loupe draws it again).
  const overlay = (u: number, interactive: boolean) => {
    if (!rect) return null;
    const map = (p: Pt) => modelToImage(rect, L, W, p);
    const c = corners(rect);
    const showHandles = tool === "fit";
    return (
      <>
        <g opacity={dragging ? Math.min(opacity, 0.4) : opacity} pointerEvents="none">
          <ModelDrawing venue={venue} map={map} px unit={u} focus={tool === "check" ? focus : null} />
        </g>
        {showHandles && (
          <g>
            <polygon
              data-handle={interactive ? "body" : undefined}
              points={c.map((p) => p.join(",")).join(" ")}
              className={`fill-accent/5 stroke-accent-300 ${interactive ? "cursor-move" : ""}`}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="4 4"
              opacity={dragging ? 0.5 : 0.9}
            />
            {(() => {
              const top = edgeMids(rect)[0];
              const rot = rotHandle(rect, 30 * u);
              return (
                <g>
                  <line x1={top[0]} y1={top[1]} x2={rot[0]} y2={rot[1]} className="stroke-accent-300" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <circle data-handle={interactive ? "rot" : undefined} cx={rot[0]} cy={rot[1]} r={6 * u} className={`fill-surface stroke-accent-300 ${interactive ? "cursor-grab" : ""}`} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                </g>
              );
            })()}
            {edgeMids(rect).map((p, i) => (
              <rect
                key={`e${i}`}
                data-handle={interactive ? `e${i}` : undefined}
                x={p[0] - 4 * u}
                y={p[1] - 4 * u}
                width={8 * u}
                height={8 * u}
                rx={2 * u}
                transform={`rotate(${(rect.angle / DEG).toFixed(3)} ${p[0]} ${p[1]})`}
                className={`${selected === `e${i}` ? "fill-accent-300" : "fill-surface"} stroke-accent-300 ${interactive ? (i % 2 ? "cursor-ew-resize" : "cursor-ns-resize") : ""}`}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {c.map((p, i) => (
              <circle
                key={`c${i}`}
                data-handle={interactive ? `c${i}` : undefined}
                cx={p[0]}
                cy={p[1]}
                r={6 * u}
                className={`${selected === `c${i}` ? "fill-accent-300" : "fill-surface"} stroke-accent-300 ${interactive ? "cursor-crosshair" : ""}`}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        )}
        {(
          [
            [scaleSeg, "stroke-warn fill-warn"],
            [goalSeg, "stroke-ok fill-ok"],
          ] as const
        ).map(([s, cls], n) =>
          s ? (
            <g key={n} className={cls} pointerEvents="none">
              <line x1={s[0][0]} y1={s[0][1]} x2={s[1][0]} y2={s[1][1]} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <circle cx={s[0][0]} cy={s[0][1]} r={3.5 * u} />
              <circle cx={s[1][0]} cy={s[1][1]} r={3.5 * u} />
            </g>
          ) : null,
        )}
        {pending && hover && (
          <line x1={pending[0]} y1={pending[1]} x2={hover.img[0]} y2={hover.img[1]} className="stroke-ink" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        )}
        {pending && <circle cx={pending[0]} cy={pending[1]} r={4 * u} className="fill-none stroke-ink" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
      </>
    );
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) load(f);
    e.target.value = "";
  };
  const fileButton = (compact: boolean) => (
    <label title={compact ? "Cambiar imagen" : undefined} className="btn relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400">
      <ImageSquare size={15} />
      {compact ? <span className="sr-only">Cambiar imagen</span> : url ? "Cambiar imagen" : "Elegir imagen"}
      <input type="file" accept="image/*" className="sr-only" onChange={onFile} />
    </label>
  );

  // Loupe: the same image and drawing, magnified around the cursor, placed beside it so the pointer stays visible.
  const loupeView = hover && view && url && size && loupe ? { half: LOUPE / (2 * k * mag), left: hover.sx + 24 + LOUPE > box.w ? hover.sx - 24 - LOUPE : hover.sx + 24, top: hover.sy - LOUPE - 24 < 0 ? hover.sy + 24 : hover.sy - LOUPE - 24 } : null;

  return (
    <div className="flex min-h-[70vh] flex-1 flex-col overflow-hidden rounded-[10px] bg-surface lg:min-h-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
        {fileButton(!!url)}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <div className="seg" role="group" aria-label="Herramienta">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="seg-opt inline-flex items-center gap-1.5"
              aria-pressed={tool === t.id}
              disabled={!url}
              onClick={() => {
                setTool(t.id);
                setPending(null);
                if (t.id !== "check") setFocus(null);
              }}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {url && (
          <>
            <label className="inline-flex items-center gap-2 text-xs text-muted" title="Opacidad de la cancha dibujada (baja sola mientras arrastras)">
              Cancha
              <input type="range" min={0.15} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Opacidad de la cancha dibujada" className="w-20" />
            </label>
            <div className="seg" role="group" aria-label="Lupa">
              <button type="button" className="seg-opt inline-flex items-center gap-1" aria-pressed={loupe} onClick={() => setLoupe((v) => !v)} title="Lupa que sigue al cursor (tecla L)">
                <MagnifyingGlass size={14} />
              </button>
              {[2, 4, 8].map((m) => (
                <button key={m} type="button" className="seg-opt tc !px-2" aria-pressed={loupe && mag === m} onClick={() => {
                    setMag(m);
                    setLoupe(true);
                  }}>
                  ×{m}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-ghost" title="Ver la imagen completa" onClick={() => size && setView({ x: 0, y: 0, w: size.w, h: size.h })}>
              <CornersOut size={15} />
            </button>
          </>
        )}
      </div>

      <div
        ref={wrapRef}
        className={`relative min-h-0 flex-1 overflow-hidden bg-bg ${over ? "ring-2 ring-accent ring-inset" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
          if (f) load(f);
        }}
      >
        {!url || !size || !view ? (
          <div className="grid h-full place-items-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-raised text-muted">
                <Upload size={24} />
              </span>
              <p className="text-sm text-ink-2">Arrastra aquí una captura satelital de la sede, pégala con Ctrl + V o elígela.</p>
              {fileButton(false)}
              <p className="text-xs text-pretty text-faint">La imagen no se guarda ni se sube: solo se guardan las medidas y los dibujos de la sede.</p>
            </div>
          </div>
        ) : (
          <>
            <svg
              ref={svgRef}
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              preserveAspectRatio="xMidYMid meet"
              className={`absolute inset-0 h-full w-full touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-inset ${
                drag?.kind === "press" && drag.moved ? "cursor-grabbing" : tool === "fit" || tool === "check" ? "cursor-grab" : "cursor-crosshair"
              }`}
              tabIndex={0}
              role="application"
              aria-label="Imagen de la sede con la cancha dibujada encima"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
              onPointerLeave={() => !drag && setHover(null)}
              onKeyDown={onKey}
            >
              <image href={url} x={0} y={0} width={size.w} height={size.h} />
              {overlay(unit, true)}
            </svg>
            {loupeView && hover && (
              <div
                className="pointer-events-none absolute overflow-hidden rounded-full bg-bg shadow-[0_0_0_2px_var(--color-ink),0_10px_30px_rgba(0,0,0,0.5)]"
                style={{ left: loupeView.left, top: loupeView.top, width: LOUPE, height: LOUPE }}
                aria-hidden
              >
                <svg viewBox={`${hover.img[0] - loupeView.half} ${hover.img[1] - loupeView.half} ${loupeView.half * 2} ${loupeView.half * 2}`} className="h-full w-full">
                  <image href={url} x={0} y={0} width={size.w} height={size.h} />
                  {overlay(unit / mag, false)}
                  <g className="stroke-ink" strokeWidth={1}>
                    <line x1={hover.img[0] - loupeView.half} y1={hover.img[1]} x2={hover.img[0] - loupeView.half * 0.15} y2={hover.img[1]} vectorEffect="non-scaling-stroke" />
                    <line x1={hover.img[0] + loupeView.half * 0.15} y1={hover.img[1]} x2={hover.img[0] + loupeView.half} y2={hover.img[1]} vectorEffect="non-scaling-stroke" />
                    <line x1={hover.img[0]} y1={hover.img[1] - loupeView.half} x2={hover.img[0]} y2={hover.img[1] - loupeView.half * 0.15} vectorEffect="non-scaling-stroke" />
                    <line x1={hover.img[0]} y1={hover.img[1] + loupeView.half * 0.15} x2={hover.img[0]} y2={hover.img[1] + loupeView.half} vectorEffect="non-scaling-stroke" />
                  </g>
                </svg>
                <span className="tc absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-bg/80 px-1.5 text-[10px] text-ink-2">×{mag}</span>
              </div>
            )}
            <span className="tc pointer-events-none absolute bottom-2 left-2 rounded bg-bg/75 px-1.5 py-0.5 text-[10px] text-muted">
              zoom ×{round(size.w / view.w, 1)}
            </span>
          </>
        )}
      </div>

      {url && rect && (
        <div className="flex min-h-[3.75rem] flex-wrap items-center gap-x-5 gap-y-2 border-t border-line-soft px-3 py-2">
          {tool === "fit" && implied && (
            <>
              <Readout label={implied.absolute ? "Lados en la imagen" : "Ancho según la proporción"}>
                {implied.absolute ? `${round(implied.length)} × ${round(implied.width)}` : round(implied.width)}
                <span className="text-faint"> m</span>
              </Readout>
              <Readout label={pxPerM ? "Escala medida" : "Escala"}>
                {round(pxPerM ?? rectScale(rect, L, W), 2)}
                <span className="text-faint"> px/m</span>
              </Readout>
              <Readout label="Giro">
                {round(((rect.angle / DEG) % 360 + 540) % 360 - 180, 1)}
                <span className="text-faint">°</span>
              </Readout>
              <span className="inline-flex items-center gap-1">
                <button type="button" className="btn h-8 w-8 !p-0" title="Girar −0.1° (Q; con Mayús, 1°)" aria-label="Girar a la izquierda" onClick={() => setRect({ ...rect, angle: rect.angle - 0.1 * DEG })}>
                  <ArrowCounterClockwise size={14} />
                </button>
                <button type="button" className="btn h-8 w-8 !p-0" title="Girar +0.1° (E; con Mayús, 1°)" aria-label="Girar a la derecha" onClick={() => setRect({ ...rect, angle: rect.angle + 0.1 * DEG })}>
                  <ArrowClockwise size={14} />
                </button>
                <button type="button" className="btn h-8 w-8 !p-0" title="Voltear: la banda cercana pasa al otro lado" aria-label="Voltear" aria-pressed={rect.flip} onClick={() => setRect({ ...rect, flip: !rect.flip })}>
                  <FlipVertical size={14} />
                </button>
              </span>
              <span className="flex-1" />
              <button type="button" className="btn" title="Vuelve a dibujar la cancha con el largo y el ancho de los campos" onClick={() => setRect(resizeToSpec(rect, L, W, pxPerM ?? rectScale(rect, L, W)))}>
                Proporciones de la sede
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={Math.abs(implied.length - L) < 0.05 && Math.abs(implied.width - W) < 0.05}
                onClick={() => onChange({ length_m: round(implied.length), width_m: round(implied.width) })}
              >
                <Check size={14} />
                Usar estas medidas
              </button>
            </>
          )}
          {tool === "scale" && (
            <>
              <div className="w-36">
                <Num label="La barra de escala mide" value={scaleM} step={1} optional onChange={setScaleM} />
              </div>
              <Readout label="Escala">{pxPerM ? round(pxPerM, 2) : "—"}<span className="text-faint"> px/m</span></Readout>
              {implied?.absolute && (
                <Readout label="Lados en la imagen">
                  {round(implied.length)} × {round(implied.width)}
                  <span className="text-faint"> m</span>
                </Readout>
              )}
              <span className="flex-1" />
              {scaleSeg && (
                <button type="button" className="btn btn-ghost" onClick={() => setScaleSeg(null)}>
                  <Trash size={14} />
                  Quitar escala
                </button>
              )}
            </>
          )}
          {tool === "goal" && (
            <>
              <Readout label="Ancho medido">{goalM ? round(goalM, 2) : "—"}<span className="text-faint"> m</span></Readout>
              <Readout label="Guardado">{spec.goal_width_m ?? "—"}<span className="text-faint"> m</span></Readout>
              <span className="max-w-xs text-[11px] text-pretty text-faint">El alto no se ve desde arriba: escríbelo a mano en Portería.</span>
              <span className="flex-1" />
              <button type="button" className="btn btn-primary" disabled={!goalM} onClick={() => goalM && onChange({ goal_width_m: round(goalM, 2) })}>
                <Check size={14} />
                Guardar como ancho de portería
              </button>
            </>
          )}
          {tool === "draw" && (
            <>
              <div className="seg" role="group" aria-label="Qué dibujar">
                <button type="button" className="seg-opt" aria-pressed={drawKind === "line"} onClick={() => setDrawKind("line")}>
                  Línea
                </button>
                <button type="button" className="seg-opt" aria-pressed={drawKind === "stripes"} onClick={() => {
                    setDrawKind("stripes");
                    setPending(null);
                  }}>
                  Franjas del pasto
                </button>
              </div>
              {drawKind === "line" ? (
                <>
                  <span className="inline-flex items-center gap-1.5" role="radiogroup" aria-label="Color de la línea">
                    {LINE_PAINTS.map(([name, hex]) => (
                      <button
                        key={hex}
                        type="button"
                        role="radio"
                        aria-checked={lineColor === hex}
                        title={name}
                        aria-label={name}
                        onClick={() => setLineColor(hex)}
                        className={`h-5 w-5 rounded-full ${lineColor === hex ? "shadow-[0_0_0_2px_var(--color-surface),0_0_0_3.5px_var(--color-accent)]" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}
                        style={{ background: hex }}
                      />
                    ))}
                  </span>
                  <span className="text-xs text-muted">{lines.length} línea(s)</span>
                  {lines.length > 0 && (
                    <>
                      <button type="button" className="btn btn-ghost" onClick={() => onChange({ layers: (spec.layers ?? []).filter((l) => l !== lines[lines.length - 1]) })}>
                        <ArrowCounterClockwise size={14} />
                        Quitar la última
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => onChange({ layers: (spec.layers ?? []).filter((l) => l.kind !== "line") })}>
                        <Trash size={14} />
                        Quitar todas
                      </button>
                    </>
                  )}
                </>
              ) : stripes ? (
                <>
                  <div className="seg" role="group" aria-label="Dirección de las franjas">
                    <button type="button" className="seg-opt" aria-pressed={stripes.axis === "across"} onClick={() => updateStripes({ axis: "across" })}>
                      Paralelas a la meta
                    </button>
                    <button type="button" className="seg-opt" aria-pressed={stripes.axis === "along"} onClick={() => updateStripes({ axis: "along" })}>
                      Paralelas a la banda
                    </button>
                  </div>
                  <div className="w-32">
                    <Num label="Ancho de franja" value={stripes.width_m} step={0.1} onChange={(v) => v !== undefined && updateStripes({ width_m: Math.max(0.5, v) })} />
                  </div>
                  <div className="w-32">
                    <Num label="Desplazamiento" value={stripes.offset_m} step={0.1} onChange={(v) => v !== undefined && updateStripes({ offset_m: v })} />
                  </div>
                  <button type="button" className="btn btn-ghost" onClick={() => onChange({ layers: (spec.layers ?? []).filter((l) => l.kind !== "stripes") })}>
                    <Trash size={14} />
                    Quitar franjas
                  </button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => addLayer({ id: uid("capa"), kind: "stripes", color: "#a3e635", axis: "across", width_m: round(L / 18, 1), offset_m: 0 })}>
                  Añadir franjas
                </button>
              )}
            </>
          )}
          {tool === "check" && (
            <div className="flex flex-wrap items-center gap-1.5">
              {groups.map((g) => (
                <span key={g.id} className={`inline-flex items-center overflow-hidden rounded-full border ${focus === g.id ? "border-accent" : "border-line"}`}>
                  <button type="button" className={`px-3 py-1 text-xs transition-colors ${focus === g.id ? "bg-accent-900 text-accent-200" : "text-ink-2 hover:bg-raised"}`} aria-pressed={focus === g.id} onClick={() => setFocus(focus === g.id ? null : g.id)}>
                    {g.label}
                  </button>
                  <button
                    type="button"
                    className={`border-l px-2 py-1 transition-colors ${checked.has(g.id) ? "border-ok/40 text-ok" : "border-line text-faint hover:text-ink"}`}
                    aria-pressed={checked.has(g.id)}
                    title={checked.has(g.id) ? "Calza con la imagen (clic para quitar)" : "Marcar que calza con la imagen"}
                    aria-label={`${g.label}: calza`}
                    onClick={() => toggleChecked(g.id)}
                  >
                    <CheckCircle size={15} weight={checked.has(g.id) ? "fill" : "regular"} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="basis-full text-[11px] text-pretty text-faint">{toolHint[tool]}</p>
        </div>
      )}
    </div>
  );
}

function Readout({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-faint">{label}</span>
      <span className="num text-xl text-ink">{children}</span>
    </div>
  );
}
