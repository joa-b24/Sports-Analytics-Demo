"use client";

import { CaretLeft, CaretRight, Check, Scissors, UserSwitch, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { DOUBT_LABELS, FOCUS_COLORS } from "@/lib/anchors";
import { boxRect, doubtType, RESOLUTION_NAMES, jumpBetween, type Answer, type DoubtBox, type RichDoubt } from "@/lib/doubts";
import { fmtT } from "@/lib/format";
import type { TracksFile } from "@/lib/tracks";

// One doubt of the anchors mode as a card with its own view by kind: the jump with BEFORE / AFTER and its arrow on the
// pitch, the two places with boxes A and B, the doubtful join with the end of the chain and the candidate. Only the
// boxes of the doubt are highlighted; ← / → go through the frames around it without leaving it.

const LABELS: Record<string, string[]> = { salto: ["1", "2"], dos_sitios: ["A", "B"], union_dudosa: ["Fin", "Cand."] };
const CAPTIONS: Record<string, string[]> = { salto: ["ANTES", "DESPUÉS"], dos_sitios: ["A", "B"], union_dudosa: ["FIN DEL TROZO", "CANDIDATA"] };
export const boxLabel = (kind: string, i: number) => LABELS[kind]?.[i] ?? String(i + 1);

// Crops of the video around each box, drawn from a hidden copy of the video (the main one does not move).
function useCrops(url: string | null, file: TracksFile, boxes: DoubtBox[]) {
  const ref = useRef<HTMLVideoElement>(null);
  const [crops, setCrops] = useState<Record<string, string>>({});
  const want = boxes.map((b) => `${b.frame}:${b.track}`).join(",");
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    let live = true;
    const run = async () => {
      if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
      const out: Record<string, string> = {};
      for (const b of boxes) {
        const rect = boxRect(file, b);
        if (!rect || !live) continue;
        v.currentTime = (b.frame + 0.5) / file.fps;
        await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
        if (!live) return;
        const k = v.videoWidth / (file.image_w || v.videoWidth || 1);
        const [x1, y1, x2, y2] = rect.map((n) => n * k);
        const h = Math.max(120, (y2 - y1) * 2.6);
        const w = h * 1.6;
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const sx = Math.max(0, Math.min(v.videoWidth - w, cx - w / 2));
        const sy = Math.max(0, Math.min(v.videoHeight - h, cy - h / 2));
        const c = document.createElement("canvas");
        c.width = 240;
        c.height = 150;
        const g = c.getContext("2d");
        if (!g) continue;
        g.drawImage(v, sx, sy, w, h, 0, 0, 240, 150);
        g.lineWidth = 3;
        g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-warn") || "orange";
        g.strokeRect(((x1 - sx) / w) * 240, ((y1 - sy) / h) * 150, ((x2 - x1) / w) * 240, ((y2 - y1) / h) * 150);
        try {
          out[`${b.frame}:${b.track}`] = c.toDataURL("image/jpeg", 0.8);
        } catch {
          // A video from another origin cannot be read: no crop.
        }
      }
      if (live) setCrops(out);
    };
    void run();
    return () => {
      live = false;
    };
    // `want` stands for the boxes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, want, file]);
  return { ref, crops };
}

export function DoubtCard({
  d,
  boxes,
  derived,
  file,
  videoUrl,
  viewFrame,
  steps,
  index,
  total,
  onStep,
  onGo,
  onAnswer,
  onOther,
  onCut,
  onPrev,
  onNext,
  onClose,
}: {
  d: RichDoubt;
  boxes: DoubtBox[];
  derived: boolean;
  file: TracksFile;
  videoUrl: string | null;
  viewFrame: number;
  steps: number[];
  index: number;
  total: number;
  onStep: (dir: 1 | -1) => void;
  onGo: (frame: number) => void;
  onAnswer: (a: Answer, i?: number) => void;
  onOther: () => void;
  onCut: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const fps = file.fps;
  const type = doubtType(d.kind);
  const { ref, crops } = useCrops(videoUrl, file, boxes.slice(0, 2));
  const jump = boxes.length >= 2 ? jumpBetween(file, boxes[0], boxes[1]) : null;
  const meters = d.jump?.dist_m ?? jump?.meters;
  const secs = d.jump?.dt_s ?? jump?.seconds;
  const speed = d.jump?.speed_ms ?? jump?.speed;
  const from = d.jump?.from ?? jump?.from;
  const to = d.jump?.to ?? jump?.to;
  const si = steps.indexOf(viewFrame);
  const kb = (k: string) => <kbd className="kbd ml-auto">{k}</kbd>;
  const b = "btn !justify-start !gap-1.5 !px-2 !py-1 text-[11px]";

  const answers: React.ReactNode =
    d.kind === "salto" ? (
      <>
        <button type="button" className={`${b} btn-primary`} onClick={() => onAnswer("pick", 0)}>1 es ella {kb("1")}</button>
        <button type="button" className={`${b} btn-primary`} onClick={() => onAnswer("pick", 1)}>2 es ella {kb("2")}</button>
        <button type="button" className={b} onClick={() => onAnswer("none")}>Ninguna {kb("0")}</button>
        <button type="button" className={b} onClick={() => onAnswer("ok")}><Check size={13} /> Es real {kb("Enter")}</button>
      </>
    ) : d.kind === "dos_sitios" ? (
      <>
        <button type="button" className={`${b} btn-primary`} onClick={() => onAnswer("pick", 0)}>A es ella {kb("A")}</button>
        <button type="button" className={`${b} btn-primary`} onClick={() => onAnswer("pick", 1)}>B es ella {kb("B")}</button>
        <button type="button" className={b} onClick={() => onAnswer("none")}>Ninguna {kb("0")}</button>
        <button type="button" className={b} onClick={() => onAnswer("both")}>Las dos (doble) {kb("Enter")}</button>
      </>
    ) : d.kind === "union_dudosa" ? (
      <>
        <button type="button" className={`${b} btn-primary`} onClick={() => onAnswer("join")}>Unir {kb("1")}</button>
        <button type="button" className={b} onClick={() => onAnswer("nojoin")}>No unir {kb("2")}</button>
        <button type="button" className={b} onClick={onOther}><UserSwitch size={13} /> Otra {kb("D")}</button>
        <button type="button" className={b} onClick={() => onAnswer("ok")}><Check size={13} /> Está bien {kb("Enter")}</button>
      </>
    ) : (
      <>
        <button type="button" className={`${b} btn-primary`} onClick={() => onAnswer("ok")}><Check size={13} /> Está bien {kb("Enter")}</button>
        <button type="button" className={b} onClick={onOther}><UserSwitch size={13} /> Es otra {kb("D")}</button>
      </>
    );

  return (
    <div className="space-y-2">
      {/* Hidden copy of the video for the crops. */}
      {videoUrl && <video ref={ref} src={videoUrl} muted preload="auto" className="hidden" crossOrigin="anonymous" />}
      <div className="flex items-center gap-1.5 text-xs">
        <button type="button" className="btn btn-ghost !p-1" aria-label="Duda anterior (Shift + Tab)" onClick={onPrev}><CaretLeft size={13} /></button>
        <span className="tc text-faint">{index + 1}/{total}</span>
        <button type="button" className="btn btn-ghost !p-1" aria-label="Duda siguiente (Tab)" onClick={onNext}><CaretRight size={13} /></button>
        <span className="font-bold text-warn">{DOUBT_LABELS[d.kind] ?? d.kind}</span>
        {derived && <span className="tag !px-1 !py-0 text-[9px] text-warn" title="Cajas calculadas en la app: este relleno aún no trae «boxes» (archivo anterior o de ejemplo)">ejemplo</span>}
        <span className="min-w-0 flex-1 truncate text-ink">{d.players.join(", ") || `trozo ${d.track}`}</span>
        <button type="button" className="btn btn-ghost !p-1" aria-label="Cortar: quitar las cajas de este trozo ±0.5 s (S)" title="Cortar ±0.5 s (S)" onClick={onCut}><Scissors size={13} /></button>
        {d.kind !== "union_dudosa" && <button type="button" className="btn btn-ghost !p-1" aria-label="Es otra jugadora (D)" title="Es otra (D)" onClick={onOther}><UserSwitch size={13} /></button>}
        <button type="button" className="btn btn-ghost !p-1" aria-label="Volver a la lista" onClick={onClose}><X size={13} /></button>
      </div>
      <p className="text-[11px] text-ink-2">{type?.todo ?? "Revisa la caja resaltada."}</p>

      {boxes.length >= 2 && (
        <div className="grid grid-cols-2 gap-1.5">
          {boxes.slice(0, 2).map((x, i) => {
            const crop = crops[`${x.frame}:${x.track}`];
            const here = Math.abs(viewFrame - x.frame) <= file.stride;
            return (
              <button key={i} type="button" className={`overflow-hidden rounded-lg bg-raised text-left ring-2 ${here ? "" : "ring-transparent"}`} style={here ? { ["--tw-ring-color" as string]: FOCUS_COLORS[i] } : undefined} title="Ir a este cuadro" onClick={() => onGo(x.frame)}>
                <div className="grid aspect-[16/10] place-items-center bg-bg text-[10px] text-faint">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {crop ? <img src={crop} alt={`${CAPTIONS[d.kind]?.[i] ?? ""} caja ${x.track}`} className="h-full w-full object-cover" /> : videoUrl ? "…" : "sin video"}
                </div>
                <div className="flex items-center gap-1 px-1.5 py-0.5 text-[10px]">
                  <span className="tc grid h-4 min-w-4 place-items-center rounded-full px-1 font-bold text-bg" style={{ background: FOCUS_COLORS[i] }}>{boxLabel(d.kind, i)}</span>
                  <span className="font-bold text-ink">{CAPTIONS[d.kind]?.[i] ?? ""}</span>
                  <span className="tc ml-auto text-faint">{fmtT(x.frame / fps)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {boxes.length < 2 && boxes.length > 0 && <p className="text-[11px] text-faint">Una sola caja: la del trozo {boxes[0].track}.</p>}

      {d.kind === "salto" && from && to && (
        <div className="flex items-center gap-2">
          <svg viewBox="-2 -2 109 72" className="h-12 w-[78px] shrink-0 rounded bg-bg text-faint" aria-label="Salto sobre la cancha">
            <rect x="0" y="0" width="105" height="68" fill="none" stroke="currentColor" strokeWidth="0.8" />
            <line x1="52.5" y1="0" x2="52.5" y2="68" stroke="currentColor" strokeWidth="0.5" />
            <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke="var(--color-warn)" strokeWidth="1.2" strokeDasharray="3 2" />
            <circle cx={from[0]} cy={from[1]} r="2.6" fill={FOCUS_COLORS[0]} />
            <circle cx={to[0]} cy={to[1]} r="2.6" fill={FOCUS_COLORS[1]} />
          </svg>
          <p className="tc text-[11px] text-ink-2">
            {meters != null ? `${meters.toFixed(1)} m` : "—"} en {secs != null ? `${secs.toFixed(2)} s` : "—"}
            <br />
            <span className={speed != null && speed > 9 ? "text-danger" : ""}>{speed != null && Number.isFinite(speed) ? `${(speed * 3.6).toFixed(0)} km/h` : "—"}</span>
            <span className="text-faint"> (máx. ~30)</span>
          </p>
        </div>
      )}
      {d.resolution?.default && <p className="text-[11px] text-faint">Si no eliges, Python haría: {RESOLUTION_NAMES[d.resolution.default] ?? d.resolution.default}</p>}

      <div className="flex items-center gap-1.5 text-[11px] text-ink-2">
        <button type="button" className="btn btn-ghost !p-1" aria-label="Cuadro anterior (←)" disabled={si <= 0} onClick={() => onStep(-1)}><CaretLeft size={13} /></button>
        <div className="relative h-1.5 flex-1 rounded-full bg-raised">
          {boxes.slice(0, 2).map((x, i) => (
            <span key={i} className="absolute top-1/2 h-2.5 w-1 -translate-y-1/2 rounded" style={{ left: `${(100 * Math.max(0, steps.indexOf(steps.reduce((p, c) => (Math.abs(c - x.frame) < Math.abs(p - x.frame) ? c : p), steps[0] ?? 0)))) / Math.max(1, steps.length - 1)}%`, background: FOCUS_COLORS[i] }} />
          ))}
          <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink" style={{ left: `${(100 * Math.max(0, si)) / Math.max(1, steps.length - 1)}%` }} />
        </div>
        <button type="button" className="btn btn-ghost !p-1" aria-label="Cuadro siguiente (→)" disabled={si >= steps.length - 1} onClick={() => onStep(1)}><CaretRight size={13} /></button>
        <span className="tc w-12 text-right" title="← / → recorren los cuadros ±1 s; Tab, la siguiente duda">{(((viewFrame - d.frame) / fps) >= 0 ? "+" : "") + ((viewFrame - d.frame) / fps).toFixed(1)} s</span>
      </div>

      <div className="grid grid-cols-2 gap-1">{answers}</div>
    </div>
  );
}
