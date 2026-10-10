"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { downloadText, fmtT } from "@/lib/format";
import { apply, fitHomography, fitQuality, invertFor, type Pt } from "@/lib/homography";
import { mutate, uid, useHydrated, useStore } from "@/lib/store";
import type { AnchorPoint, CalibAnchor } from "@/lib/types";
import { VENUES, toNormalized, type Landmark, type Venue } from "@/lib/venue";

const GROUPS: { id: Landmark["group"]; label: string }[] = [
  { id: "football", label: "Rejilla de americano (exacta)" },
  { id: "hash", label: "Marcas interiores (posición sin confirmar, no usar aún)" },
  { id: "soccer", label: "Líneas de fútbol (por verificar)" },
];
const OVERLAY = { football: "#22d3ee", soccer: "#f0abfc" };
// Reprojection error above this (meters) is flagged in the table.
const WARN_M = 1.5;

// Model lines projected to the image, cut wherever a point falls behind the camera or absurdly far away.
function projectLines(venue: Venue, Hinv: number[], w: number, h: number) {
  const out: { d: string; group: "football" | "soccer" }[] = [];
  for (const line of venue.lines) {
    let run: Pt[] = [];
    const flush = () => {
      if (run.length > 1) out.push({ d: "M" + run.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L"), group: line.group });
      run = [];
    };
    for (let i = 0; i < line.pts.length - 1; i++) {
      const [a, b] = [line.pts[i], line.pts[i + 1]];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
      for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
        const p = apply(Hinv, [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
        if (!p || Math.abs(p[0]) > 4 * w || Math.abs(p[1]) > 4 * h) flush();
        else run.push(p);
      }
    }
    flush();
  }
  return out;
}

export default function CalibrationPage() {
  const state = useStore();
  const hydrated = useHydrated();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number; duration: number } | null>(null);
  const [fps, setFps] = useState(29.97002997);
  const [time, setTime] = useState(0);
  const [matchId, setMatchId] = useState("partido_2026_09_25");
  const [videoId, setVideoId] = useState("v1");
  const [venueId, setVenueId] = useState(VENUES[0].venue_id);
  const [shown, setShown] = useState<Record<Landmark["group"], boolean>>({ football: true, hash: false, soccer: true });

  const [points, setPoints] = useState<AnchorPoint[]>([]);
  const [pointsFrame, setPointsFrame] = useState<number | null>(null);
  const [pendingPx, setPendingPx] = useState<Pt | null>(null);
  const [pendingLm, setPendingLm] = useState<string | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);

  const venue = VENUES.find((v) => v.venue_id === venueId) ?? VENUES[0];
  const byId = useMemo(() => new Map(venue.landmarks.map((l) => [l.id, l])), [venue]);
  const frame = Math.round(time * fps);
  const stale = pointsFrame !== null && pointsFrame !== frame;

  // Follow the frame that is actually on screen, not the requested time.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !fileUrl) return;
    let handle = 0;
    let alive = true;
    const hasRvfc = typeof v.requestVideoFrameCallback === "function";
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      if (!alive) return;
      setTime(meta.mediaTime);
      handle = v.requestVideoFrameCallback(onFrame);
    };
    const onTime = () => setTime(v.currentTime);
    if (hasRvfc) handle = v.requestVideoFrameCallback(onFrame);
    else {
      v.addEventListener("timeupdate", onTime);
      v.addEventListener("seeked", onTime);
    }
    return () => {
      alive = false;
      if (hasRvfc) v.cancelVideoFrameCallback(handle);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
    };
  }, [fileUrl]);

  const seekFrame = useCallback(
    (f: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      // Aim at the middle of the frame so rounding never lands on its neighbour.
      v.currentTime = Math.max(0, (f + 0.5) / fps);
    },
    [fps],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const step = (e.shiftKey ? Math.round(fps) : 1) * (e.key === "ArrowRight" ? 1 : -1);
        seekFrame(Math.round(v.currentTime * fps - 0.5) + step);
      } else if (e.key === " ") {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.key === "Escape") {
        setPendingPx(null);
        setPendingLm(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fps, seekFrame]);

  const toPixels = (e: { clientX: number; clientY: number }): Pt | null => {
    const ctm = overlayRef.current?.getScreenCTM();
    if (!ctm || !dims) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    if (p.x < 0 || p.y < 0 || p.x > dims.w || p.y > dims.h) return null;
    return [p.x, p.y];
  };

  const addPair = (lm: string, px: Pt) => {
    setPoints((ps) => [...ps.filter((p) => p.landmark_id !== lm), { landmark_id: lm, px: px[0], py: px[1] }]);
    setPointsFrame(frame);
    setPendingPx(null);
    setPendingLm(null);
  };

  const onVideoClick = (e: React.MouseEvent) => {
    const px = toPixels(e);
    if (!px || stale) return;
    videoRef.current?.pause();
    if (pendingLm) addPair(pendingLm, px);
    else setPendingPx(px);
  };

  const onLandmarkClick = (id: string) => {
    if (stale) return;
    if (pendingPx) addPair(id, pendingPx);
    else setPendingLm(id === pendingLm ? null : id);
  };

  const drawLoupe = (px: Pt | null) => {
    const c = loupeRef.current;
    const v = videoRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !v || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!px) return;
    const sw = c.width / 5;
    const sh = c.height / 5;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(v, px[0] - sw / 2, px[1] - sh / 2, sw, sh, 0, 0, c.width, c.height);
    ctx.strokeStyle = "#f43f5e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c.width / 2, 0);
    ctx.lineTo(c.width / 2, c.height);
    ctx.moveTo(0, c.height / 2);
    ctx.lineTo(c.width, c.height / 2);
    ctx.stroke();
  };

  const onVideoMove = (e: React.MouseEvent) => {
    const px = toPixels(e);
    setHover(px);
    drawLoupe(px);
  };

  const fit = useMemo(() => {
    const pairs = points.flatMap((p) => {
      const lm = byId.get(p.landmark_id);
      return lm ? [{ p, lm }] : [];
    });
    const src = pairs.map(({ p }) => [p.px, p.py] as Pt);
    const dst = pairs.map(({ lm }) => [lm.x, lm.y] as Pt);
    const H = fitHomography(src, dst);
    const Hinv = H ? invertFor(H, dst) : null;
    return { pairs, H, Hinv, quality: H ? fitQuality(H, src, dst) : null };
  }, [points, byId]);

  const projected = useMemo(
    () => (fit.Hinv && dims ? projectLines(venue, fit.Hinv, dims.w, dims.h) : []),
    [fit.Hinv, dims, venue],
  );

  const hoverM = hover && fit.H ? apply(fit.H, hover) : null;
  const hoverN = hoverM ? toNormalized(venue, hoverM) : null;
  const looValues = fit.quality?.leaveOneOut.filter((v): v is number => v !== null) ?? [];
  const looMax = looValues.length ? Math.max(...looValues) : null;

  const anchors = state.anchors
    .filter((a) => a.match_id === matchId && a.video_id === videoId)
    .sort((a, b) => a.frame - b.frame);

  const reset = () => {
    setPoints([]);
    setPointsFrame(null);
    setPendingPx(null);
    setPendingLm(null);
  };

  const saveAnchor = () => {
    if (!dims || pointsFrame === null || !fit.H) return;
    const anchor: CalibAnchor = {
      anchor_id: uid("a"),
      match_id: matchId,
      video_id: videoId,
      venue_id: venue.venue_id,
      frame: pointsFrame,
      t_video: pointsFrame / fps,
      image_w: dims.w,
      image_h: dims.h,
      points,
    };
    mutate((s) => ({
      ...s,
      anchors: [
        ...s.anchors.filter((a) => !(a.match_id === matchId && a.video_id === videoId && a.frame === pointsFrame)),
        anchor,
      ],
    }));
  };

  const loadAnchor = (a: CalibAnchor) => {
    setVenueId(a.venue_id);
    setPoints(a.points);
    setPointsFrame(a.frame);
    setPendingPx(null);
    setPendingLm(null);
    seekFrame(a.frame);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    setFileUrl(URL.createObjectURL(f));
    setDims(null);
    setTime(0);
    reset();
  };

  const b = venue.bounds;
  const dotR = dims ? dims.w / 260 : 6;
  const saved = pointsFrame !== null && anchors.some((a) => a.frame === pointsFrame && a.points === points);

  if (!hydrated) return null;

  return (
    <>
      <PageHeader
        title="Calibración de cancha"
        subtitle="Marca en un frame del video puntos cuya posición real se conoce. Con cuatro o más se calcula la relación entre la imagen y la cancha, y la cancha se dibuja encima del video para comprobar que calza."
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">Archivo de video (no sale de esta computadora)</span>
            <input type="file" accept="video/*" onChange={onFile} className="text-sm" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">Partido (match_id)</span>
            <input className={input} value={matchId} onChange={(e) => setMatchId(e.target.value.trim())} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">Video</span>
            <input className={`${input} w-20`} value={videoId} onChange={(e) => setVideoId(e.target.value.trim())} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">Cuadros por segundo</span>
            <input
              className={`${input} w-28`}
              type="number"
              step="any"
              min={1}
              value={fps}
              onChange={(e) => setFps(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">Sede</span>
            <select className={input} value={venueId} onChange={(e) => setVenueId(e.target.value)}>
              {VENUES.map((v) => (
                <option key={v.venue_id} value={v.venue_id}>
                  {v.name} ({v.length_m} x {v.width_m} m)
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          <Card>
            {!fileUrl ? (
              <p className="text-sm text-slate-600">
                Elige el archivo del video (por ejemplo <code>matches/{matchId}/video/v1.mp4</code>). Aquí hace falta el
                archivo y no YouTube, porque hay que avanzar cuadro por cuadro.
              </p>
            ) : (
              <>
                <div className="relative overflow-hidden rounded bg-black">
                  <video
                    ref={videoRef}
                    src={fileUrl}
                    muted
                    playsInline
                    preload="auto"
                    className="block w-full"
                    onLoadedMetadata={(e) =>
                      setDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight, duration: e.currentTarget.duration })
                    }
                  />
                  {dims && (
                    <svg
                      ref={overlayRef}
                      viewBox={`0 0 ${dims.w} ${dims.h}`}
                      className={`absolute inset-0 h-full w-full ${stale ? "cursor-not-allowed" : "cursor-crosshair"}`}
                      onClick={onVideoClick}
                      onMouseMove={onVideoMove}
                      onMouseLeave={() => {
                        setHover(null);
                        drawLoupe(null);
                      }}
                    >
                      <g opacity={stale ? 0.25 : 1}>
                        {projected.map((l, i) => (
                          <path key={i} d={l.d} fill="none" stroke={OVERLAY[l.group]} strokeWidth={dotR / 3} opacity={0.9} />
                        ))}
                        {points.map((p) => (
                          <g key={p.landmark_id}>
                            <circle cx={p.px} cy={p.py} r={dotR} fill="none" stroke="#f43f5e" strokeWidth={dotR / 3} />
                            <circle cx={p.px} cy={p.py} r={dotR / 5} fill="#f43f5e" />
                          </g>
                        ))}
                      </g>
                      {pendingPx && (
                        <circle cx={pendingPx[0]} cy={pendingPx[1]} r={dotR} fill="none" stroke="#fde047" strokeWidth={dotR / 3} />
                      )}
                    </svg>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <button type="button" className={btn} onClick={() => seekFrame(frame - Math.round(fps))}>
                    −1 s
                  </button>
                  <button type="button" className={btn} onClick={() => seekFrame(frame - 1)}>
                    −1 cuadro
                  </button>
                  <button
                    type="button"
                    className={btn}
                    onClick={() => {
                      const v = videoRef.current;
                      if (!v) return;
                      if (v.paused) void v.play();
                      else v.pause();
                    }}
                  >
                    Reproducir / pausar
                  </button>
                  <button type="button" className={btn} onClick={() => seekFrame(frame + 1)}>
                    +1 cuadro
                  </button>
                  <button type="button" className={btn} onClick={() => seekFrame(frame + Math.round(fps))}>
                    +1 s
                  </button>
                  <span className="ml-2 tabular-nums text-slate-700">
                    {fmtT(time)} · cuadro {frame}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Posición en el video"
                  className="mt-2 w-full"
                  min={0}
                  max={dims?.duration ?? 0}
                  step={1 / fps}
                  value={time}
                  onChange={(e) => seekFrame(Math.round(Number(e.target.value) * fps))}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Teclas: ← → un cuadro, Mayús + ← → un segundo, espacio reproduce o pausa, Esc cancela el punto pendiente.
                </p>
              </>
            )}
          </Card>

          {stale && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span>
                Los puntos marcados son del cuadro {pointsFrame}; el video está en el {frame}. La cámara se mueve, así que
                no valen aquí.
              </span>
              <button type="button" className={btn} onClick={() => pointsFrame !== null && seekFrame(pointsFrame)}>
                Volver al cuadro {pointsFrame}
              </button>
              <button type="button" className={btn} onClick={reset}>
                Empezar de cero en este cuadro
              </button>
            </div>
          )}

          <Card title="Ajuste">
            {fit.pairs.length < 4 ? (
              <p className="text-sm text-slate-600">
                {fit.pairs.length} de 4 puntos como mínimo. Conviene marcar 6 o más, repartidos entre la banda lejana y la
                cercana: con puntos de una sola línea no se puede calcular.
              </p>
            ) : !fit.H || !fit.quality ? (
              <p className="text-sm text-amber-900">
                No se puede calcular con estos puntos: están casi alineados o alguno está asignado a un punto equivocado.
                Añade uno a otra profundidad de la cancha.
              </p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-800">
                  <span>
                    Error de ajuste (RMS): <strong className="tabular-nums">{fit.quality.rms.toFixed(2)} m</strong>
                  </span>
                  <span>
                    Peor error dejando un punto fuera:{" "}
                    <strong className="tabular-nums">{looMax === null ? "hacen falta 5 puntos" : `${looMax.toFixed(2)} m`}</strong>
                  </span>
                </div>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="font-medium">Punto</th>
                      <th className="font-medium">Ajuste (m)</th>
                      <th className="font-medium">Dejándolo fuera (m)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {fit.pairs.map(({ p, lm }, i) => {
                      const loo = fit.quality?.leaveOneOut[i] ?? null;
                      const bad = (loo ?? fit.quality?.residuals[i] ?? 0) > WARN_M;
                      return (
                        <tr key={p.landmark_id} className={`border-t border-slate-100 ${bad ? "bg-amber-50" : ""}`}>
                          <td className="py-1">
                            {lm.label}
                            {!lm.exact && <span className="text-slate-500"> (por verificar)</span>}
                          </td>
                          <td className="tabular-nums">{fit.quality?.residuals[i].toFixed(2)}</td>
                          <td className="tabular-nums">{loo === null ? "—" : loo.toFixed(2)}</td>
                          <td className="text-right">
                            <button
                              type="button"
                              className="text-slate-600 underline"
                              onClick={() => setPoints((ps) => ps.filter((q) => q.landmark_id !== p.landmark_id))}
                            >
                              quitar
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-slate-500">
                  «Dejándolo fuera» recalcula sin ese punto y mide cuánto se aleja: es la estimación honesta del error. Una
                  fila resaltada (más de {WARN_M} m) suele ser un clic impreciso o un punto mal asignado.
                </p>
              </>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} disabled={!fit.H || stale || saved} onClick={saveAnchor}>
                {saved ? "Ancla guardada" : `Guardar ancla del cuadro ${pointsFrame ?? frame}`}
              </button>
              <button type="button" className={btn} disabled={points.length === 0} onClick={reset}>
                Borrar puntos
              </button>
            </div>
          </Card>
        </div>

        <div className="space-y-3">
          <Card title="Lupa y posición">
            <div className="flex items-start gap-3">
              <canvas ref={loupeRef} width={240} height={135} className="rounded border border-slate-200 bg-slate-100" />
              <div className="text-xs text-slate-700">
                {hover ? (
                  <>
                    <div className="tabular-nums">
                      Imagen: {hover[0].toFixed(0)}, {hover[1].toFixed(0)} px
                    </div>
                    {hoverM && hoverN ? (
                      <>
                        <div className="mt-1 tabular-nums">
                          Cancha real: {hoverM[0].toFixed(1)}, {hoverM[1].toFixed(1)} m
                        </div>
                        <div className="tabular-nums">
                          Normalizada (105 x 68): {hoverN[0].toFixed(1)}, {hoverN[1].toFixed(1)}
                        </div>
                      </>
                    ) : (
                      <div className="mt-1 text-slate-500">Sin calibración todavía.</div>
                    )}
                  </>
                ) : (
                  <span className="text-slate-500">Pasa el cursor sobre el video.</span>
                )}
              </div>
            </div>
          </Card>

          <Card title="Puntos de referencia de la sede">
            <p className="mb-2 text-xs text-slate-600">
              {pendingPx
                ? "Ahora elige aquí a qué punto corresponde el clic amarillo."
                : pendingLm
                  ? `Ahora haz clic en el video sobre: ${byId.get(pendingLm)?.label ?? ""}.`
                  : "Haz clic en el video y luego aquí, o al revés. Vista desde la cámara: la banda cercana queda abajo."}
            </p>
            <svg viewBox={`${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`} className="w-full select-none rounded bg-slate-800">
              {venue.lines.map((l, i) => (
                <polyline
                  key={i}
                  points={l.pts.map((p) => p.join(",")).join(" ")}
                  fill="none"
                  stroke={l.group === "football" ? "#cbd5e1" : "#facc15"}
                  strokeWidth={0.25}
                  opacity={shown[l.group] ? 0.9 : 0.15}
                />
              ))}
              {venue.landmarks
                .filter((l) => l.group === "football" && l.id.endsWith("_fs") && /^yl-?\d+_fs$/.test(l.id))
                .map((l) => {
                  const k = Number(l.id.slice(2, -3));
                  const yards = 50 - Math.abs(k) * 5;
                  return k % 2 === 0 && yards > 0 ? (
                    <text key={l.id} x={l.x} y={venue.width_m / 2 + 1.2} textAnchor="middle" fontSize={3} fill="#94a3b8">
                      {yards}
                    </text>
                  ) : null;
                })}
              {venue.landmarks
                .filter((l) => shown[l.group])
                .map((l) => {
                  const used = points.some((p) => p.landmark_id === l.id);
                  const active = pendingLm === l.id;
                  return (
                    <g key={l.id} className="cursor-pointer" onClick={() => onLandmarkClick(l.id)}>
                      <title>{l.label}</title>
                      <circle cx={l.x} cy={l.y} r={1.8} fill="transparent" />
                      <circle
                        cx={l.x}
                        cy={l.y}
                        r={active ? 1.3 : 0.85}
                        fill={used ? "#f43f5e" : active ? "#fde047" : l.group === "soccer" ? "#facc15" : "#f8fafc"}
                        stroke="#0f172a"
                        strokeWidth={0.2}
                      />
                    </g>
                  );
                })}
            </svg>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
              {GROUPS.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={shown[g.id]} onChange={(e) => setShown((s) => ({ ...s, [g.id]: e.target.checked }))} />
                  {g.label}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              En la rejilla de americano, el punto es donde la línea de yarda toca el borde interior de la franja blanca de
              la banda. Sobre el video, la rejilla se dibuja en celeste y las líneas de fútbol en rosa.
            </p>
          </Card>

          <Card title={`Anclas guardadas (${anchors.length})`}>
            {anchors.length === 0 ? (
              <p className="text-sm text-slate-600">Todavía no hay anclas para este partido y video.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {anchors.map((a) => (
                  <li key={a.anchor_id} className="flex items-center justify-between gap-2 border-t border-slate-100 pt-1">
                    <span className="tabular-nums text-slate-800">
                      {fmtT(a.t_video)} · cuadro {a.frame} · {a.points.length} puntos
                    </span>
                    <span className="flex gap-3 text-xs">
                      <button type="button" className="text-blue-700 underline" onClick={() => loadAnchor(a)}>
                        abrir
                      </button>
                      <button
                        type="button"
                        className="text-slate-600 underline"
                        onClick={() => mutate((s) => ({ ...s, anchors: s.anchors.filter((x) => x.anchor_id !== a.anchor_id) }))}
                      >
                        borrar
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className={`${btn} mt-3`}
              disabled={anchors.length === 0}
              onClick={() =>
                downloadText(
                  `anchors_${matchId}_${videoId}.json`,
                  JSON.stringify({ schema_version: 1, match_id: matchId, video_id: videoId, fps, anchors }, null, 1),
                  "application/json",
                )
              }
            >
              Exportar anclas (JSON)
            </button>
          </Card>
        </div>
      </div>
    </>
  );
}
