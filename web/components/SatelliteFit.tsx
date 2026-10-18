"use client";

import { ArrowClockwise, ArrowCounterClockwise, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ImageSquare, MagnifyingGlassMinus, MagnifyingGlassPlus, Ruler } from "@phosphor-icons/react";
import { useState } from "react";
import { btn, btnPrimary, input } from "@/components/Shell";
import type { Pt } from "@/lib/homography";
import { nudge, placementFromTwo, toImage, type Placement } from "@/lib/overlay";
import type { VenueSpec } from "@/lib/types";
import { buildVenue } from "@/lib/venue";

// A satellite capture of the venue, used two ways. Measure: two clicks on the scale bar, two along the length, two
// across the width. Fit: two points of the model clicked on the image place the whole venue over it (soccer pitch and
// football grid), so the venue settings can be adjusted until every line sits on the paint. The image stays in this
// browser tab; only the venue settings are kept.

type Seg = [Pt, Pt];
type MeasureMode = "scale" | "length" | "width";
type Mode = MeasureMode | "a1" | "a2";
const MEASURES: { id: MeasureMode; label: string; color: string }[] = [
  { id: "scale", label: "Escala", color: "#fde047" },
  { id: "length", label: "Largo", color: "#22d3ee" },
  { id: "width", label: "Ancho", color: "#f0abfc" },
];
const ANCHOR_COLOR = "#ffffff";
const dist = (s: Seg) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
const DEG = Math.PI / 180;

// Fine adjustments on top of the two-point fit: pixels on screen, turn and scale around the middle of the anchors.
interface Adjust {
  px: number;
  py: number;
  turn: number;
  zoom: number;
}
const NO_ADJUST: Adjust = { px: 0, py: 0, turn: 0, zoom: 1 };

export function SatelliteFit({ spec, onUse }: { spec: VenueSpec; onUse: (length_m: number, width_m: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<Mode>("scale");
  const [segs, setSegs] = useState<Partial<Record<MeasureMode, Seg>>>({});
  const [pending, setPending] = useState<Pt | null>(null);
  const [scaleM, setScaleM] = useState(20);
  // Fit.
  const venue = buildVenue(spec);
  const overlay = spec.kind === "football_overlay";
  const defaults: [string, string] = overlay ? ["yl-10_fs", "yl10_fs"] : ["sc_l_cf", "sc_r_cf"];
  const [anchorIds, setAnchorIds] = useState<[string, string]>(defaults);
  const [anchorPx, setAnchorPx] = useState<{ a1?: Pt; a2?: Pt }>({});
  const [flip, setFlip] = useState(false);
  const [adjust, setAdjust] = useState<Adjust>(NO_ADJUST);
  const [opacity, setOpacity] = useState(0.85);
  const [zoom, setZoom] = useState(1);

  const pxPerM = segs.scale && scaleM > 0 ? dist(segs.scale) / scaleM : null;
  const length = pxPerM && segs.length ? dist(segs.length) / pxPerM : null;
  const width = pxPerM && segs.width ? dist(segs.width) / pxPerM : null;
  const r = size ? size.w / 220 : 4;

  // The landmarks follow the settings: change the grid offset and the anchored points stay on their pixels, the
  // rest of the model moves.
  const lm = (id: string) => venue.landmarks.find((l) => l.id === id);
  const m1 = lm(anchorIds[0]);
  const m2 = lm(anchorIds[1]);
  const base = m1 && m2 && anchorPx.a1 && anchorPx.a2 ? placementFromTwo([m1.x, m1.y], [m2.x, m2.y], anchorPx.a1, anchorPx.a2, flip) : null;
  const pivot: Pt | null = m1 && m2 ? [(m1.x + m2.x) / 2, (m1.y + m2.y) / 2] : null;
  const placed: Placement | null =
    base && pivot
      ? (() => {
          const p = nudge(base, pivot, { turn: adjust.turn, zoom: adjust.zoom });
          return { ...p, tx: p.tx + adjust.px, ty: p.ty + adjust.py };
        })()
      : null;

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!size) return;
    const box = e.currentTarget.getBoundingClientRect();
    const p: Pt = [((e.clientX - box.left) / box.width) * size.w, ((e.clientY - box.top) / box.height) * size.h];
    if (mode === "a1" || mode === "a2") {
      setAnchorPx((a) => ({ ...a, [mode]: p }));
      setAdjust(NO_ADJUST);
      if (mode === "a1" && !anchorPx.a2) setMode("a2");
      return;
    }
    if (!pending) return setPending(p);
    setSegs((s) => ({ ...s, [mode]: [pending, p] }));
    setPending(null);
    // Move on to the next measurement that is still missing.
    const next = MEASURES.find((m) => m.id !== mode && !segs[m.id]);
    if (next) setMode(next.id);
  };

  // Fine adjustment from the keyboard when the image has the focus: arrows move 1 px (Shift: 10), Q / E turn 0.1°
  // (Shift: 1°), - / + scale 0.1 % (Shift: 1 %).
  const onKey = (e: React.KeyboardEvent) => {
    if (!placed) return;
    const big = e.shiftKey;
    const step = big ? 10 : 1;
    const k = e.key.toLowerCase();
    const map: Record<string, Partial<Adjust>> = {
      arrowleft: { px: adjust.px - step },
      arrowright: { px: adjust.px + step },
      arrowup: { py: adjust.py - step },
      arrowdown: { py: adjust.py + step },
      q: { turn: adjust.turn - (big ? 1 : 0.1) * DEG },
      e: { turn: adjust.turn + (big ? 1 : 0.1) * DEG },
      "-": { zoom: adjust.zoom * (big ? 0.99 : 0.999) },
      _: { zoom: adjust.zoom * 0.99 },
      "+": { zoom: adjust.zoom * (big ? 1.01 : 1.001) },
      "=": { zoom: adjust.zoom * 1.001 },
    };
    const ch = map[k];
    if (!ch) return;
    e.preventDefault();
    setAdjust((a) => ({ ...a, ...ch }));
  };

  const line = (pts: Pt[]) => pts.map((p) => toImage(placed as Placement, p).join(",")).join(" ");
  const hint = pending
    ? "Ahora el segundo extremo."
    : mode === "scale"
      ? "Haz clic en los dos extremos de la barra de escala."
      : mode === "length"
        ? "Haz clic en las dos líneas de meta, a lo largo de una banda."
        : mode === "width"
          ? "Haz clic en las dos bandas, a lo largo de una línea de meta."
          : `Haz clic en la imagen donde está: ${(mode === "a1" ? m1 : m2)?.label ?? "el punto"}.`;

  return (
    <div className="rounded-2xl bg-bg/50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Ruler size={16} className="text-accent-300" />
        <span className="text-sm text-ink-2">Imagen satelital: medir y calzar el modelo</span>
        <label className={`${btn} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
          <ImageSquare size={15} />
          {url ? "Cambiar imagen" : "Elegir imagen"}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (url) URL.revokeObjectURL(url);
              setUrl(URL.createObjectURL(f));
              setSize(null);
              setSegs({});
              setPending(null);
              setMode("scale");
              setAnchorPx({});
              setAdjust(NO_ADJUST);
            }}
          />
        </label>
      </div>
      {!url ? (
        <p className="mt-2 text-xs text-pretty text-faint">
          Una captura de un mapa satelital de la sede (con la barra de escala si quieres medir). La imagen no se guarda ni se sube: solo se usan
          las medidas y los ajustes de la sede.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="seg">
              {MEASURES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={mode === m.id}
                  className="seg-opt inline-flex items-center gap-1.5"
                  onClick={() => {
                    setMode(m.id);
                    setPending(null);
                  }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                  {m.label}
                  {segs[m.id] && <Check size={12} />}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              La barra de escala mide
              <input className={`${input} tc w-20`} type="number" min={0} step="any" value={scaleM} onChange={(e) => setScaleM(Number(e.target.value))} />m
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="text-ink-2">Calzar:</span>
            {(["a1", "a2"] as const).map((a, i) => (
              <span key={a} className="inline-flex items-center gap-1">
                <button type="button" className={`seg-opt rounded-lg border border-line px-2 py-1 ${mode === a ? "border-accent text-ink" : ""}`} aria-pressed={mode === a} onClick={() => setMode(a)}>
                  Punto {i + 1} {anchorPx[a] && <Check size={12} className="inline" />}
                </button>
                <select
                  className={`${input} max-w-56`}
                  aria-label={`Punto ${i + 1} del modelo`}
                  value={anchorIds[i]}
                  onChange={(e) => setAnchorIds((ids) => (i === 0 ? [e.target.value, ids[1]] : [ids[0], e.target.value]))}
                >
                  {venue.landmarks.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </span>
            ))}
            <label className="inline-flex items-center gap-1.5" title="Si el modelo queda al revés (la banda cercana del lado equivocado)">
              <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
              Voltear
            </label>
          </div>

          <p className="mt-2 text-xs text-faint">{hint}</p>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <button type="button" className={`${btn} h-7 w-7 !p-0`} aria-label="Alejar" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 1))}>
                <MagnifyingGlassMinus size={13} />
              </button>
              <span className="tc w-8 text-center">×{zoom}</span>
              <button type="button" className={`${btn} h-7 w-7 !p-0`} aria-label="Acercar" disabled={zoom >= 4} onClick={() => setZoom((z) => Math.min(4, z + 1))}>
                <MagnifyingGlassPlus size={13} />
              </button>
            </span>
            {placed && (
              <label className="inline-flex items-center gap-2">
                Modelo
                <input type="range" min={0.15} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Opacidad del modelo" />
              </label>
            )}
          </div>

          <div className="mt-2 max-h-[75vh] overflow-auto rounded-xl">
            <div className="relative" style={{ width: `${zoom * 100}%` }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, nothing to optimise */}
              <img src={url} alt="Imagen satelital de la sede" className="block w-full" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
              {size && (
                <svg
                  viewBox={`0 0 ${size.w} ${size.h}`}
                  className="absolute inset-0 h-full w-full cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                  onClick={onClick}
                  onKeyDown={onKey}
                  tabIndex={0}
                  role="img"
                  aria-label="Imagen con el modelo de la sede encima"
                >
                  {placed && (
                    <g opacity={opacity} pointerEvents="none">
                      {venue.lines.map((l, n) => (
                        <polyline
                          key={n}
                          points={line(l.pts)}
                          fill="none"
                          stroke={l.group === "football" ? venue.colors.football : venue.colors.soccer}
                          strokeWidth={l.group === "football" ? 1.2 : 1.6}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                      {venue.landmarks
                        .filter((l) => l.group === "hash")
                        .map((l) => {
                          const [u, v] = toImage(placed, [l.x, l.y]);
                          return <circle key={l.id} cx={u} cy={v} r={r * 0.45} fill={venue.colors.football} />;
                        })}
                    </g>
                  )}
                  {MEASURES.map((m) => {
                    const s = segs[m.id];
                    return s ? (
                      <g key={m.id} stroke={m.color} fill={m.color}>
                        <line x1={s[0][0]} y1={s[0][1]} x2={s[1][0]} y2={s[1][1]} strokeWidth={r / 2} />
                        <circle cx={s[0][0]} cy={s[0][1]} r={r} />
                        <circle cx={s[1][0]} cy={s[1][1]} r={r} />
                      </g>
                    ) : null;
                  })}
                  {(["a1", "a2"] as const).map((a) => {
                    const p = anchorPx[a];
                    return p ? <circle key={a} cx={p[0]} cy={p[1]} r={r} fill="none" stroke={ANCHOR_COLOR} strokeWidth={r / 3} /> : null;
                  })}
                  {pending && <circle cx={pending[0]} cy={pending[1]} r={r} fill="none" stroke="#ffffff" strokeWidth={r / 2} />}
                </svg>
              )}
            </div>
          </div>

          {placed && (
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
              <span className="text-ink-2">Ajuste fino del modelo</span>
              <span className="inline-flex items-center gap-1">
                {(
                  [
                    [ArrowLeft, "Mover a la izquierda", { px: -1 }],
                    [ArrowUp, "Mover arriba", { py: -1 }],
                    [ArrowDown, "Mover abajo", { py: 1 }],
                    [ArrowRight, "Mover a la derecha", { px: 1 }],
                  ] as const
                ).map(([Icon, label, d]) => (
                  <button
                    key={label}
                    type="button"
                    className={`${btn} h-7 w-7 !p-0`}
                    title={`${label} 1 px (flechas; con Mayús, 10 px)`}
                    aria-label={label}
                    onClick={() => setAdjust((a) => ({ ...a, px: a.px + ("px" in d ? d.px : 0), py: a.py + ("py" in d ? d.py : 0) }))}
                  >
                    <Icon size={13} />
                  </button>
                ))}
              </span>
              <span className="inline-flex items-center gap-1">
                <button type="button" className={`${btn} h-7 w-7 !p-0`} title="Girar 0.1° (Q; con Mayús, 1°)" aria-label="Girar a la izquierda" onClick={() => setAdjust((a) => ({ ...a, turn: a.turn - 0.1 * DEG }))}>
                  <ArrowCounterClockwise size={13} />
                </button>
                <button type="button" className={`${btn} h-7 w-7 !p-0`} title="Girar 0.1° (E; con Mayús, 1°)" aria-label="Girar a la derecha" onClick={() => setAdjust((a) => ({ ...a, turn: a.turn + 0.1 * DEG }))}>
                  <ArrowClockwise size={13} />
                </button>
              </span>
              <span className="inline-flex items-center gap-1">
                <button type="button" className={`${btn} h-7 !px-2`} title="Escala −0.1 % (tecla -)" onClick={() => setAdjust((a) => ({ ...a, zoom: a.zoom * 0.999 }))}>
                  −0.1 %
                </button>
                <button type="button" className={`${btn} h-7 !px-2`} title="Escala +0.1 % (tecla +)" onClick={() => setAdjust((a) => ({ ...a, zoom: a.zoom * 1.001 }))}>
                  +0.1 %
                </button>
              </span>
              <button type="button" className={`${btn} h-7 !px-2`} onClick={() => setAdjust(NO_ADJUST)}>
                Quitar ajuste
              </button>
              <span className="tc text-faint">
                {placed.scale.toFixed(2)} px/m · {(placed.angle / DEG).toFixed(2)}°
              </span>
            </div>
          )}
          {placed && (
            <p className="mt-1 text-xs text-pretty text-faint">
              Los dos puntos quedan fijos y el resto del modelo sigue a los ajustes de la sede: cambia el desplazamiento de la rejilla, las marcas
              interiores o las medidas (botones −/+ arriba) hasta que todas las líneas caigan sobre la pintura. Con la imagen seleccionada, las flechas
              mueven el modelo, Q / E lo giran y − / + lo escalan.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="num text-3xl text-ink-2">{pxPerM ? pxPerM.toFixed(2) : "–"}</div>
              <div className="mt-1 text-[11px] text-muted">px por metro</div>
            </div>
            <div>
              <div className="num text-3xl text-ink">{length ? length.toFixed(1) : "–"}</div>
              <div className="mt-1 text-[11px] text-muted">largo (m)</div>
            </div>
            <div>
              <div className="num text-3xl text-ink">{width ? width.toFixed(1) : "–"}</div>
              <div className="mt-1 text-[11px] text-muted">ancho (m)</div>
            </div>
            <button type="button" className={btnPrimary} disabled={!length || !width} onClick={() => length && width && onUse(Math.round(length * 10) / 10, Math.round(width * 10) / 10)}>
              Usar estas medidas
            </button>
          </div>
          <p className="mt-2 text-xs text-pretty text-faint">
            Medir sobre una captura tiene un error de alrededor del 2 %. Las medidas se confirman después con cuadros calibrados.
          </p>
        </>
      )}
    </div>
  );
}
