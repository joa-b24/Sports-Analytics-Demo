"use client";

import {
  ArrowUpRight,
  Circle,
  CornersOut,
  CursorClick,
  FloppyDisk,
  LineSegments,
  Pause,
  Play,
  Polygon,
  PresentationChart,
  TextT,
  Trash,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { DRAW_COLOR_LABELS, DRAW_COLOR_VAR } from "@/components/board/BoardView";
import { ClipDrawings } from "@/components/clip/ClipOverlay";
import { useClipData } from "@/components/clip/useClipData";
import { IconButton } from "@/components/Modal";
import { btn, btnPrimary, input } from "@/components/Shell";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import {
  ANNOTATION_LABELS,
  DRAW_COLORS,
  clipDrawingsAt,
  clipFreezes,
  isValidAnnotation,
  pitchToImage,
  project,
  revealCount,
  timeline,
  type Anchor,
  type Annotation,
  type AnnotationKind,
  type ClipEdit,
  type Freeze,
  type LabelMode,
  type Pt,
} from "@/lib/annotations";
import { addToEdit, editPath, hGap, homographyAt, labelFor, personAt, removeFromEdit, snapshotContext } from "@/lib/clips";
import { fmtT, isTyping } from "@/lib/format";
import { apply } from "@/lib/homography";
import { writeLocal } from "@/lib/local";
import { mutate, uid, useStore } from "@/lib/store";
import type { Match } from "@/lib/types";

type Tool = "select" | AnnotationKind;
const TOOLS: { id: Tool; label: string; key: string; icon: Icon }[] = [
  { id: "select", label: "Elegir", key: "m", icon: CursorClick },
  { id: "highlight", label: "Resaltar", key: "r", icon: Circle },
  { id: "arrow", label: "Flecha", key: "f", icon: ArrowUpRight },
  { id: "line", label: "Línea", key: "l", icon: LineSegments },
  { id: "zone", label: "Zona", key: "z", icon: Polygon },
  { id: "text", label: "Texto", key: "t", icon: TextT },
];
const HINTS: Record<Tool, string> = {
  select: "Clic en un dibujo para elegirlo y editarlo abajo.",
  highlight: "Clic sobre una jugadora (los puntos son las posiciones del tracking): el círculo la sigue mientras se vea.",
  arrow: "Arrastra sobre el césped. Si empieza o acaba en una jugadora, la sigue.",
  line: "Clic en dos o más jugadoras o puntos del césped; Enter para terminar.",
  zone: "Clic en tres o más jugadoras o puntos; Enter para terminar. Con jugadoras, la zona se recalcula en cada cuadro.",
  text: "Clic donde va el texto (queda fijo en la pantalla) y escríbelo abajo.",
};
const LABEL_MODES: [LabelMode, string][] = [
  ["number", "Dorsal"],
  ["name", "Nombre"],
  ["none", "Sin rótulo"],
];
// Seconds a new drawing lasts, and a new stop.
const NEW_DRAWING_S = 4;
const NEW_FREEZE_S = 3;
// A click within this distance of a player (px at 1080) picks her.
const PICK_PX = 45;
// How far off the pitch (m) a point of a drawing may be.
const OFF_PITCH_M = 5;

type Stop = { freeze: Freeze; start: number; hold: boolean };
type Pending = { kind: "arrow" | "line" | "zone"; anchors: Anchor[]; cursor: Pt | null; startPx: Pt | null };

export function ClipEditor({ match, edit, onClose, startPresenting = false }: { match: Match; edit: ClipEdit; onClose: () => void; startPresenting?: boolean }) {
  const { roster } = useStore();
  const data = useClipData(match, edit, roster ?? []);
  const video = (match.videos ?? []).find((v) => v.video_id === edit.video_id);
  const youtubeId = video?.youtube_id || (edit.video_id === "v1" ? match.youtube_id : "") || undefined;
  const playerRef = useRef<PlayerHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [presenting, setPresenting] = useState(startPresenting);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("warn");
  const [dashed, setDashed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<{ t: number; stop: { freeze: Freeze; shown: number; hold: boolean } | null }>({ t: edit.t_start, stop: null });
  const [msg, setMsg] = useState<string | null>(null);

  const save = (next: ClipEdit) => mutate((s) => ({ ...s, edits: (s.edits ?? []).map((x) => (x.edit_id === next.edit_id ? next : x)) }));

  // ------------------------------------------------------------------------------------------ playback engine
  const editRef = useRef(edit);
  const presentingRef = useRef(presenting);
  const engine = useRef<{ playing: boolean; consumed: Set<number>; stop: Stop | null; lastT: number }>({ playing: false, consumed: new Set(), stop: null, lastT: edit.t_start });
  useEffect(() => {
    editRef.current = edit;
    presentingRef.current = presenting;
  });

  const startPlay = () => {
    const p = playerRef.current;
    if (!p) return;
    const e = engine.current;
    let t = p.getTime();
    if (t < edit.t_start - 0.05 || t >= edit.t_end - 0.05) {
      t = edit.t_start;
      p.seek(t);
    }
    // Stops behind are done; the one right here, if any, is played.
    e.consumed = new Set(clipFreezes(edit).filter((f) => f.t < t - 0.02).map((f) => f.t));
    e.stop = null;
    e.lastT = t;
    e.playing = true;
    setPlaying(true);
    p.play();
  };
  const pausePlay = () => {
    engine.current.playing = false;
    engine.current.stop = null;
    setPlaying(false);
    playerRef.current?.pause();
  };
  // Leaves the current stop (or starts playing) — Space or → in the presentation.
  const advance = () => {
    const e = engine.current;
    if (e.stop) {
      e.consumed.add(e.stop.freeze.t);
      e.stop = null;
      e.playing = true;
      setPlaying(true);
      playerRef.current?.play();
    } else if (e.playing) pausePlay();
    else startPlay();
  };
  // Back to the stop before the current moment (or to the start of the clip) — ← in the presentation.
  const back = () => {
    const p = playerRef.current;
    const e = engine.current;
    if (!p) return;
    const now = e.stop ? e.stop.freeze.t - 0.01 : p.getTime() - 0.3;
    const prev = clipFreezes(edit).filter((f) => f.t < now).pop();
    p.pause();
    if (prev) {
      p.seek(prev.t);
      e.consumed = new Set(clipFreezes(edit).filter((f) => f.t < prev.t).map((f) => f.t));
      // The tick sets the start of the stop (-1: not started yet).
      e.stop = { freeze: prev, start: -1, hold: true };
      e.playing = true;
      setPlaying(true);
    } else {
      p.seek(edit.t_start);
      e.stop = null;
      e.playing = false;
      setPlaying(false);
    }
  };

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const p = playerRef.current;
      const e = engine.current;
      const ed = editRef.current;
      if (p) {
        if (e.stop) {
          if (e.stop.start < 0) e.stop.start = now;
          const elapsed = (now - e.stop.start) / 1000;
          const done = elapsed >= e.stop.freeze.duration_s;
          // In the editor the stop ends by itself; in the presentation it waits for Space or →.
          if (done && !presentingRef.current && e.playing) {
            e.consumed.add(e.stop.freeze.t);
            e.stop = null;
            p.play();
          } else {
            setView({ t: e.stop.freeze.t, stop: { freeze: e.stop.freeze, shown: revealCount(e.stop.freeze, elapsed), hold: done } });
          }
        }
        if (!e.stop) {
          const t = p.getTime();
          if (e.playing) {
            const f = clipFreezes(ed).find((x) => !e.consumed.has(x.t) && x.t >= e.lastT - 0.05 && x.t <= t + 0.02);
            if (f) {
              p.pause();
              p.seek(f.t);
              e.stop = { freeze: f, start: now, hold: false };
            } else if (t >= ed.t_end) {
              p.pause();
              e.playing = false;
              setPlaying(false);
            }
          }
          e.lastT = t;
          if (!e.stop) setView({ t, stop: null });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Start at the beginning of the clip once the player can seek.
  useEffect(() => {
    let tries = 0;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (p && p.getDuration() > 0) {
        p.seek(edit.t_start);
        clearInterval(id);
      } else if (++tries > 100) clearInterval(id);
    }, 150);
    return () => clearInterval(id);
  }, [edit.t_start]);

  // ---------------------------------------------------------------------------------------- what is drawn now
  const snap = data.snapshot;
  const image = { w: snap?.image_w ?? 1920, h: snap?.image_h ?? 1080 };
  const k = image.h / 1080;
  const ctx = useMemo(() => (snap ? snapshotContext(snap) : { positionOf: () => null }), [snap]);
  const t = view.t;
  const H = snap ? homographyAt(snap.homographies, Math.round(t * snap.fps), hGap(snap)) : null;
  const toImage = snap ? pitchToImage(H, snap.venue) : null;
  const labelOf = (id: number | string) => labelFor(id, edit.label_mode, snap);
  const drawn = clipDrawingsAt(edit, t, ctx, view.stop)
    .map((r) => project(r, toImage, image, labelOf))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const people = snap && toImage
    ? Object.keys(snap.tracks).flatMap((id) => {
        const p = ctx.positionOf(Number(id), t);
        const px = p && toImage(p);
        return px ? [{ id: Number(id), px }] : [];
      })
    : [];

  // Where each player stands in the frame, as an upright box (about 1.75 x 0.6 m at the local scale of the camera):
  // the drawings are cut out there so the players stay in front of them.
  const bodies: [number, number, number, number][] = snap && toImage
    ? Object.keys(snap.tracks).flatMap((id) => {
        const p = ctx.positionOf(Number(id), t);
        if (!p) return [];
        const feet = toImage(p);
        const side = toImage([p[0] + 105 / snap.venue.length_m, p[1]]);
        if (!feet || !side) return [];
        const s = Math.hypot(side[0] - feet[0], side[1] - feet[1]);
        if (!(s > 0) || s > image.w / 4) return [];
        const w = 0.6 * s;
        const h = 1.75 * s;
        return [[feet[0] - w / 2, feet[1] - h, w, h + 0.1 * s] as [number, number, number, number]];
      })
    : [];

  // ------------------------------------------------------------------------------------------------- drawing
  const toPitch = (px: Pt): Pt | null => {
    if (!H || !snap) return null;
    const m = apply(H, px) ?? apply(H.map((v) => -v), px);
    return m ? [Math.round((m[0] * 105) / snap.venue.length_m * 100) / 100, Math.round((m[1] * 68) / snap.venue.width_m * 100) / 100] : null;
  };
  const anchorAt = (px: Pt): Anchor | null => {
    const who = personAt(px, people, PICK_PX * k);
    if (who !== null) return { kind: "player", identity: who };
    const m = toPitch(px);
    // Beyond the lines the perspective blows distances up: a point far off the pitch is a slip, not a target.
    if (!m || m[0] < -OFF_PITCH_M || m[0] > 105 + OFF_PITCH_M || m[1] < -OFF_PITCH_M || m[1] > 68 + OFF_PITCH_M) return null;
    return { kind: "pitch", x: m[0], y: m[1] };
  };
  const pointer = (e: { clientX: number; clientY: number }): Pt | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  };
  const add = (kind: AnnotationKind, anchors: Anchor[], label?: string) => {
    const t_in = Math.round(t * 100) / 100;
    const a: Annotation = {
      id: uid("a"),
      kind,
      anchors,
      t_in,
      t_out: Math.min(edit.t_end, t_in + NEW_DRAWING_S),
      style: { color, ...(dashed ? { dashed: true } : {}), ...(label ? { label } : {}) },
    };
    if (!isValidAnnotation(a)) return;
    save(addToEdit(edit, a, t));
    setSelected(a.id);
  };
  const patchAnnotation = (id: string, p: Partial<Annotation>) => save({ ...edit, annotations: edit.annotations.map((a) => (a.id === id ? { ...a, ...p } : a)) });

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (presenting) return advance();
    const px = pointer(e);
    if (!px) return;
    if (tool === "select") return setSelected(null);
    if (playing) pausePlay();
    if (tool === "text") return add("text", [{ kind: "screen", x: Math.round((px[0] / image.w) * 1000) / 1000, y: Math.round((px[1] / image.h) * 1000) / 1000 }], "Texto");
    const a = anchorAt(px);
    if (!a) return setMsg(H ? "Ese punto queda fuera de la cancha." : "Este cuadro no tiene calibración: aquí solo se puede poner texto.");
    if (tool === "highlight") {
      if (a.kind !== "player") return setMsg("Haz clic sobre una jugadora (los puntos) para resaltarla.");
      return add("highlight", [a]);
    }
    if (tool === "arrow") {
      // The release counts even if it happens outside the video.
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return setPending({ kind: "arrow", anchors: [a], cursor: px, startPx: px });
    }
    if (tool === "line" || tool === "zone")
      setPending((cur) => ({ kind: tool, anchors: [...(cur?.kind === tool ? cur.anchors : []), a], cursor: px, startPx: null }));
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!pending) return;
    const px = pointer(e);
    if (px) setPending({ ...pending, cursor: px });
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    if (pending?.kind !== "arrow" || !pending.startPx) return;
    const px = pointer(e);
    const far = px && Math.hypot(px[0] - pending.startPx[0], px[1] - pending.startPx[1]) > 25 * k;
    const end = far ? anchorAt(px) : null;
    if (end) add("arrow", [pending.anchors[0], end]);
    else if (far) setMsg("La flecha acaba fuera de la cancha: no se guardó.");
    setPending(null);
  };
  const finish = () => {
    if (pending && pending.kind !== "arrow") add(pending.kind, pending.anchors);
    setPending(null);
  };
  const addFreeze = () => {
    pausePlay();
    const at = Math.round((playerRef.current?.getTime() ?? t) * 100) / 100;
    if (edit.freezes.some((f) => Math.abs(f.t - at) < 0.05)) return;
    save({ ...edit, freezes: [...edit.freezes, { t: at, duration_s: NEW_FREEZE_S, reveal: [] }].sort((a, b) => a.t - b.t) });
    setMsg(`Pausa en ${fmtT(at)}: lo que dibujes ahora aparece en ella, uno a uno.`);
  };

  const saveFile = async () => {
    const out: ClipEdit = { ...edit, snapshot: data.snapshot, fixed_file: data.fixedFile };
    save(out);
    if (!match.folder) return setMsg("El partido no tiene carpeta: la edición queda guardada en este navegador.");
    const ok = await writeLocal(editPath(match.folder, edit.edit_id), JSON.stringify(out));
    setMsg(ok ? `Guardado en matches/${match.folder}/edits/edit_${edit.edit_id}.json` : "No se pudo escribir en la carpeta del partido (¿la app corre en esta computadora?). La edición sigue guardada en el navegador.");
  };

  const present = () => {
    setPresenting(true);
    setSelected(null);
    setPending(null);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    pausePlay();
    playerRef.current?.seek(edit.t_start);
  };
  const stopPresenting = () => {
    setPresenting(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setPresenting((p) => (p && !startPresenting ? false : p));
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [startPresenting]);

  // Keys of the editor, before those of the match page (capture), which they replace while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "SELECT" || (el?.tagName === "INPUT" && (el as HTMLInputElement).type === "range")) return;
      const take = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (presenting) {
        if (e.key === " " || e.key === "ArrowRight" || e.key === "PageDown") {
          take();
          advance();
        } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
          take();
          back();
        } else if (e.key === "Escape") {
          take();
          if (startPresenting) onClose();
          else stopPresenting();
        }
        return;
      }
      if (e.key === " ") {
        take();
        if (engine.current.playing) pausePlay();
        else startPlay();
        return;
      }
      if (e.key === "Escape") {
        take();
        if (pending) setPending(null);
        else setSelected(null);
        return;
      }
      if (e.key === "Enter" && pending) {
        take();
        finish();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        take();
        save(removeFromEdit(edit, selected));
        return setSelected(null);
      }
      if (e.key === "p") {
        take();
        addFreeze();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        take();
        const p = playerRef.current;
        if (p) p.seek(Math.min(edit.t_end, Math.max(edit.t_start, p.getTime() + (e.shiftKey ? 1 / 30 : 1) * (e.key === "ArrowLeft" ? -1 : 1))));
        return;
      }
      const tl = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (tl) {
        take();
        setTool(tl.id);
        setPending(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const tl = timeline(edit);
  const span = Math.max(0.1, edit.t_end - edit.t_start);
  const pct = (v: number) => `${((Math.min(edit.t_end, Math.max(edit.t_start, v)) - edit.t_start) / span) * 100}%`;
  const sel = edit.annotations.find((a) => a.id === selected) ?? null;
  const pendingPx: Pt[] = [];
  for (const a of pending?.anchors ?? []) {
    const p = a.kind === "player" ? people.find((x) => x.id === a.identity)?.px : a.kind === "pitch" ? toImage?.([a.x, a.y]) : null;
    if (p) pendingPx.push(p);
  }
  const stopHere = edit.freezes.find((f) => Math.abs(f.t - t) < 0.05);

  const videoBox = (
    <div className={`relative mx-auto w-full ${presenting ? "max-w-[calc(100vh*16/9)]" : "xl:max-w-[calc((100vh-19rem)*16/9)]"}`}>
      <VideoPlayer ref={playerRef} fileUrl={data.videoUrl ?? undefined} youtubeId={data.videoUrl ? undefined : youtubeId} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${image.w} ${image.h}`}
        preserveAspectRatio="xMidYMid meet"
        className={`absolute inset-0 h-full w-full touch-none select-none ${presenting ? "cursor-pointer" : tool === "select" ? "" : "cursor-crosshair"}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {!presenting && tool !== "select" && tool !== "text" &&
          people.map((p) => <circle key={p.id} cx={p.px[0]} cy={p.px[1]} r={6 * k} fill="var(--color-ink)" fillOpacity={0.55} stroke="#000" strokeOpacity={0.5} strokeWidth={1.5 * k} pointerEvents="none" />)}
        <ClipDrawings items={drawn} image={image} bodies={bodies} selected={presenting ? null : selected} onPick={!presenting && tool === "select" ? setSelected : undefined} />
        {pendingPx.length > 0 && pending?.cursor && (
          <polyline points={[...pendingPx, pending.cursor].map((p) => p.join(",")).join(" ")} fill="none" stroke={DRAW_COLOR_VAR[color]} strokeWidth={3 * k} strokeDasharray={`${10 * k} ${8 * k}`} pointerEvents="none" />
        )}
        {view.stop && !presenting && (
          <text x={24 * k} y={50 * k} fontSize={30 * k} fontWeight={700} fill="#fff" stroke="#000" strokeWidth={5 * k} paintOrder="stroke" pointerEvents="none">
            Pausa · {view.stop.shown}/{view.stop.freeze.reveal.length}
          </text>
        )}
      </svg>
    </div>
  );

  return createPortal(
    <div
      ref={rootRef}
      className={presenting ? "fixed inset-0 z-[60] flex flex-col justify-center bg-black" : "fixed inset-0 z-[60] overflow-y-auto bg-bg px-4 py-4 md:px-8"}
      role="dialog"
      aria-label={presenting ? "Presentación del clip" : "Editar clip"}
    >
      <div className={presenting ? "w-full" : "mx-auto max-w-[1600px] space-y-3"}>
        {!presenting && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${input} min-w-48 flex-1 font-medium`} value={edit.title} aria-label="Título del clip" onChange={(e) => save({ ...edit, title: e.target.value })} />
              <div className="seg" aria-label="Rótulo de las jugadoras">
                {LABEL_MODES.map(([m, label]) => (
                  <button key={m} type="button" className="seg-opt" aria-pressed={edit.label_mode === m} onClick={() => save({ ...edit, label_mode: m })}>
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" className={btn} onClick={() => void saveFile()} title="Escribe edit_<id>.json en matches/<partido>/edits/ (con las posiciones y la calibración del tramo, para exportar a MP4)">
                <FloppyDisk size={15} />
                Guardar en la carpeta
              </button>
              <button type="button" className={btnPrimary} onClick={present}>
                <PresentationChart size={15} />
                Presentar
              </button>
              <IconButton label="Cerrar el editor" onClick={onClose}>
                <X size={16} />
              </IconButton>
            </div>
            <p className="text-xs text-muted">
              {data.loading
                ? "Leyendo la calibración y el tracking de la carpeta del partido…"
                : data.source === "folder"
                  ? `Calibración y posiciones de la carpeta del partido${data.fixedFile?.startsWith("tracks_fixed") ? " (tracking corregido)" : data.fixedFile ? " (tracking sin corregir: identidades del programa)" : " (sin tracking: solo puntos del césped y texto)"}.`
                  : data.source === "saved"
                    ? "Sin la carpeta del partido: se usan la calibración y las posiciones guardadas con la edición."
                    : "Sin calibración de este tramo: solo se puede poner texto en pantalla. Calibra y procesa el tramo en la pestaña Tracking para dibujar sobre el césped."}
              {msg && <span className="ml-2 text-ink-2">{msg}</span>}
            </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg" role="toolbar" aria-label="Herramientas">
            {TOOLS.map((x) => {
              const I = x.icon;
              return (
                <button key={x.id} type="button" className="seg-opt inline-flex items-center gap-1.5" aria-pressed={tool === x.id} title={`${x.label} (${x.key})`} onClick={() => {
                  setTool(x.id);
                  setPending(null);
                }}>
                  <I size={14} />
                  {x.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1">
            {DRAW_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={DRAW_COLOR_LABELS[c]}
                aria-pressed={color === c}
                onClick={() => (sel ? patchAnnotation(sel.id, { style: { ...sel.style, color: c } }) : setColor(c))}
                className={`h-5 w-5 rounded-full ${(sel ? sel.style.color : color) === c ? "ring-2 ring-ink ring-offset-2 ring-offset-bg" : ""}`}
                style={{ background: DRAW_COLOR_VAR[c] }}
              />
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={dashed} onChange={(e) => setDashed(e.target.checked)} />
            Discontinua
          </label>
          {pending && pending.kind !== "arrow" && (
            <button type="button" className={btnPrimary} onClick={finish} disabled={pending.anchors.length < (pending.kind === "zone" ? 3 : 2)}>
              Terminar {ANNOTATION_LABELS[pending.kind].toLowerCase()} (Enter)
            </button>
          )}
          <span className="text-xs text-faint">{HINTS[tool]}</span>
        </div>

          </>
        )}

        {videoBox}

        {presenting && (
          <div className="pointer-events-none absolute right-4 bottom-3 left-4 flex items-center justify-between text-xs text-white/60">
            <span>{edit.title}</span>
            <span>Espacio o → sigue · ← pausa anterior · Esc sale</span>
          </div>
        )}

        {!presenting && (
          <>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnPrimary} onClick={() => (playing ? pausePlay() : startPlay())}>
            {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            {playing ? "Pausa" : "Reproducir clip"}
          </button>
          <button type="button" className={btn} onClick={addFreeze} title="Detiene la imagen en este momento al reproducir (tecla p)">
            Pausa aquí (p)
          </button>
          <span className="tc text-xs text-muted">
            {fmtT(t)} · clip {fmtT(edit.t_start)}–{fmtT(edit.t_end)} · sale de {Math.round(tl.duration * 10) / 10} s con las pausas
          </span>
          <span className="text-xs text-faint">← → 1 s (con Mayús, un cuadro) · Supr borra el dibujo elegido</span>
        </div>

        {/* Timeline of the clip: the playhead, the stops and each drawing from its entry to its exit. */}
        <div className="space-y-1 rounded-2xl border border-line-soft p-3">
          <div
            className="relative h-6 cursor-pointer rounded-md bg-raised"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              pausePlay();
              playerRef.current?.seek(edit.t_start + ((e.clientX - r.left) / r.width) * span);
            }}
          >
            {edit.freezes.map((f) => (
              <span key={f.t} className="absolute top-0 h-full w-1 -translate-x-1/2 rounded bg-warn" style={{ left: pct(f.t) }} title={`Pausa ${fmtT(f.t)} · ${f.duration_s} s`} />
            ))}
            <span className="absolute top-0 h-full w-0.5 bg-ink" style={{ left: pct(t) }} />
          </div>
          {edit.annotations.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setSelected(a.id)}
              className={`relative block h-3 w-full rounded ${a.id === selected ? "bg-accent/20" : ""}`}
              title={`${ANNOTATION_LABELS[a.kind]} ${fmtT(a.t_in)}–${fmtT(a.t_out)}`}
            >
              <span
                className="absolute top-0.5 h-2 rounded-full"
                style={{ left: pct(a.t_in), width: `calc(${pct(a.t_out)} - ${pct(a.t_in)})`, background: DRAW_COLOR_VAR[a.style.color] ?? DRAW_COLOR_VAR.accent }}
              />
            </button>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-line-soft p-3 text-xs">
            <div className="mb-2 text-sm text-ink">Dibujo elegido</div>
            {!sel ? (
              <p className="text-faint">Ninguno: elige uno con la herramienta Elegir o en la línea de tiempo.</p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{ANNOTATION_LABELS[sel.kind]}</span>
                  <span className="text-faint">{sel.anchors.some((x) => x.kind === "player") ? "sigue a jugadoras" : sel.anchors[0].kind === "screen" ? "fijo en pantalla" : "fijo en el césped"}</span>
                  <span className="ml-auto">
                    <IconButton label="Borrar el dibujo (Supr)" tone="danger" onClick={() => {
                        save(removeFromEdit(edit, sel.id));
                        setSelected(null);
                      }}>
                      <Trash size={13} />
                    </IconButton>
                  </span>
                </div>
                <input
                  className={`${input} h-8 w-full text-xs`}
                  placeholder={sel.kind === "text" ? "Texto" : "Rótulo (opcional)"}
                  value={sel.style.label ?? ""}
                  onChange={(e) => patchAnnotation(sel.id, { style: { ...sel.style, label: e.target.value || undefined } })}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={btn} onClick={() => patchAnnotation(sel.id, { t_in: Math.min(Math.round(t * 100) / 100, sel.t_out - 0.1) })}>
                    Entra en {fmtT(sel.t_in)} → ahora
                  </button>
                  <button type="button" className={btn} onClick={() => patchAnnotation(sel.id, { t_out: Math.max(Math.round(t * 100) / 100, sel.t_in + 0.1) })}>
                    Sale en {fmtT(sel.t_out)} → ahora
                  </button>
                  {sel.kind !== "text" && (
                    <label className="flex items-center gap-1 text-muted">
                      <input type="checkbox" checked={!!sel.style.dashed} onChange={(e) => patchAnnotation(sel.id, { style: { ...sel.style, dashed: e.target.checked || undefined } })} />
                      Discontinua
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-line-soft p-3 text-xs">
            <div className="mb-2 text-sm text-ink">Pausas</div>
            {edit.freezes.length === 0 ? (
              <p className="text-faint">Ninguna. Detén el video en un momento clave y pulsa «Pausa aquí» (p): la imagen se congela y lo que dibujes ahí aparece uno a uno.</p>
            ) : (
              <ul className="space-y-1.5">
                {edit.freezes.map((f) => (
                  <li key={f.t} className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 ${stopHere === f ? "bg-warn/10" : ""}`}>
                    <button type="button" className="tc link" onClick={() => {
                        pausePlay();
                        playerRef.current?.seek(f.t);
                      }}>
                      {fmtT(f.t)}
                    </button>
                    <label className="flex items-center gap-1 text-muted">
                      <input
                        type="number"
                        min={0.5}
                        step={0.5}
                        className={`${input} h-7 w-16 px-2 py-0 text-xs`}
                        value={f.duration_s}
                        onChange={(e) => save({ ...edit, freezes: edit.freezes.map((x) => (x === f ? { ...x, duration_s: Math.max(0.5, Number(e.target.value) || 0.5) } : x)) })}
                      />
                      s
                    </label>
                    <span className="text-faint">
                      {f.reveal.length} {f.reveal.length === 1 ? "dibujo aparece" : "dibujos aparecen"}
                    </span>
                    <span className="ml-auto">
                      <IconButton label="Quitar la pausa" tone="danger" onClick={() => save({ ...edit, freezes: edit.freezes.filter((x) => x !== f) })}>
                        <Trash size={13} />
                      </IconButton>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className={`${btn} mt-2`} onClick={present}>
              <CornersOut size={14} />
              Probar en pantalla completa
            </button>
          </div>
        </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
