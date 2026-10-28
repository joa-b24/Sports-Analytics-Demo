"use client";

import { TimeRange } from "@/components/TimeRange";
import {
  ArrowUpRight,
  Circle,
  CircleDashed,
  CursorClick,
  FloppyDisk,
  HandPalm,
  LineSegments,
  ChartBar,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretLeft,
  CaretRight,
  FilmSlate,
  Pause,
  PencilSimpleLine,
  Play,
  Polygon,
  PresentationChart,
  Repeat,
  TextT,
  Trash,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ClipDrawings } from "@/components/clip/ClipOverlay";
import { useClipData } from "@/components/clip/useClipData";
import { IconButton } from "@/components/Modal";
import { btn, btnPrimary, input } from "@/components/Shell";
import { PaletteEditor, useDrawColor, usePalette } from "@/components/studio/palette";
import { PlayMetricsCard, PlayMetricsPanel } from "@/components/studio/PlayMetricsPanel";
import { ColorPick, FitAspect, PanelTitle, RailButton, SidePanel, StudioFrame, TimeField, ToolRail, useWide } from "@/components/studio/Studio";
import { Timeline } from "@/components/studio/Timeline";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import {
  ANNOTATION_LABELS,
  HIGHLIGHT_SHAPES,
  HIGHLIGHT_SHAPE_LABELS,
  highlightShape,
  LABEL_SIDES,
  LABEL_SIDE_LABELS,
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
  type HighlightShape,
  type LabelMode,
  type LabelSide,
  type Pt,
} from "@/lib/annotations";
import { addToEdit, editPath, hGap, homographyAt, labelFor, migrateEdit, personAt, removeFromEdit, snapshotContext } from "@/lib/clips";
import { LOOP_MARGINS, LOOP_MARGIN_PREF, LOOP_PREF, consumedAt, loopAction, loopWindow, parseMargin } from "@/lib/clipLoop";
import { FALLBACK_FPS, frameLabel, stepTime } from "@/lib/frameStep";
import { fmtT, isTyping } from "@/lib/format";
import { apply } from "@/lib/homography";
import { writeLocal } from "@/lib/local";
import { mutate, setPref, uid, usePref, useStore } from "@/lib/store";
import type { Match } from "@/lib/types";

// Wall clock for the frame steps, read in event handlers only.
const nowMs = () => performance.now();

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
  select: "Clic en un dibujo para elegirlo y editarlo en el panel «Dibujo».",
  highlight: "Clic sobre una jugadora (los puntos son las posiciones del tracking): el círculo la sigue mientras se vea.",
  arrow: "Arrastra sobre el césped. Si empieza o acaba en una jugadora, la sigue.",
  line: "Clic en dos o más jugadoras o puntos del césped; Enter para terminar.",
  zone: "Clic en tres o más jugadoras o puntos; Enter para terminar. Con jugadoras, la zona se recalcula en cada cuadro.",
  text: "Clic donde va el texto (queda fijo en la pantalla) y escríbelo en el panel «Dibujo».",
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
  const dc = useDrawColor();
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
  const [selectedFreeze, setSelectedFreeze] = useState<string | null>(null);
  const wide = useWide();
  const palette = usePalette();
  // Loop of the clip (on/off and margin in seconds) and the metrics (panel tab and card over the video).
  const loop = usePref(LOOP_PREF, "off") === "on";
  const margin = parseMargin(usePref(LOOP_MARGIN_PREF, "0"));
  const loopRef = useRef({ on: loop, margin });
  const [sideTab, setSideTab] = useState<"clip" | "metrics">("clip");
  const metricsOver = usePref("studio:metricsOver", "off") === "on";
  // The label being dragged, in px of a 1080-high frame from its place.
  const [labelDrag, setLabelDrag] = useState<{ id: string; dx: number; dy: number; from: Pt; base: [number, number] } | null>(null);

  const save = (next: ClipEdit) => mutate((s) => ({ ...s, edits: (s.edits ?? []).map((x) => (x.edit_id === next.edit_id ? next : x)) }));
  // Start and end of the clip; its play (when it comes from one) follows, since the clip always opens with the play's.
  const setRange = (p: { t_start?: number; t_end?: number }) =>
    mutate((s) => ({
      ...s,
      edits: (s.edits ?? []).map((x) => (x.edit_id === edit.edit_id ? { ...x, ...p } : x)),
      plays: edit.play_id ? s.plays.map((pl) => (pl.play_id === edit.play_id ? { ...pl, ...p } : pl)) : s.plays,
    }));

  // ------------------------------------------------------------------------------------------ playback engine
  const editRef = useRef(edit);
  const presentingRef = useRef(presenting);
  const engine = useRef<{ playing: boolean; consumed: Set<number>; stop: Stop | null; lastT: number; lastLoop: number }>({ playing: false, consumed: new Set(), stop: null, lastT: edit.t_start, lastLoop: 0 });
  useEffect(() => {
    editRef.current = edit;
    presentingRef.current = presenting;
    loopRef.current = { on: loop, margin };
  });
  // A clip saved with the old box mark opens with the oval (the rest is kept).
  useEffect(() => {
    const m = migrateEdit(edit);
    if (m !== edit) save(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.edit_id]);

  const startPlay = () => {
    const p = playerRef.current;
    if (!p) return;
    const e = engine.current;
    let t = p.getTime();
    const w = loopWindow(edit, loop ? margin : 0);
    if (t < w.start - 0.05 || t >= edit.t_end - 0.05) {
      t = w.start;
      p.seek(t);
    }
    // Stops behind are done; the one right here, if any, is played.
    e.consumed = consumedAt(clipFreezes(edit).map((f) => f.t), t);
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
          const settling = now - e.lastLoop < 400;
          if (e.playing && !settling) {
            const f = clipFreezes(ed).find((x) => !e.consumed.has(x.t) && x.t >= e.lastT - 0.05 && x.t <= t + 0.02);
            if (f) {
              p.pause();
              p.seek(f.t);
              e.stop = { freeze: f, start: now, hold: false };
            } else {
              const lp = loopRef.current;
              const act = loopAction(t, ed, lp.on, lp.margin);
              if (act === "restart") {
                // Back to the start of the window with every pause to play again; a short guard while the seek lands.
                if (now - e.lastLoop > 400) {
                  const w = loopWindow(ed, lp.margin);
                  e.lastLoop = now;
                  e.consumed = new Set();
                  e.lastT = w.start;
                  p.seek(w.start);
                }
              } else if (act === "stop") {
                p.pause();
                e.playing = false;
                setPlaying(false);
              }
            }
          }
          if (!settling) e.lastT = t;
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
  // Exact frame rate of the video (the one of its tracking); without tracking the steps assume FALLBACK_FPS and say so.
  const fps = snap?.fps ?? FALLBACK_FPS;
  const labOpts = { side: edit.label_side, hidden: new Set((edit.hidden_labels ?? []).map(String)) };
  const drawn = clipDrawingsAt(edit, t, ctx, view.stop)
    .map((r) => (labelDrag && r.id === labelDrag.id ? { ...r, style: { ...r.style, label_dx: labelDrag.dx, label_dy: labelDrag.dy } } : r))
    .map((r) => project(r, toImage, image, labelOf, labOpts))
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
      style: { color, ...(dashed ? { dashed: true } : {}), ...(label ? { label } : {}), ...(kind === "highlight" && edit.highlight_shape && edit.highlight_shape !== "oval" ? { shape: edit.highlight_shape } : {}) },
    };
    if (!isValidAnnotation(a)) return;
    save(addToEdit(edit, a, t));
    setSelected(a.id);
    setSelectedFreeze(null);
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
  const startLabelDrag = (id: string, e: React.PointerEvent) => {
    const a = edit.annotations.find((x) => x.id === id);
    const px = pointer(e);
    if (!a || !px || presenting || tool !== "select") return;
    svgRef.current?.setPointerCapture?.(e.pointerId);
    setSelected(id);
    setSelectedFreeze(null);
    const base: [number, number] = [a.style.label_dx ?? 0, a.style.label_dy ?? 0];
    setLabelDrag({ id, dx: base[0], dy: base[1], from: px, base });
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (labelDrag) {
      const px = pointer(e);
      if (px) setLabelDrag({ ...labelDrag, dx: Math.round(labelDrag.base[0] + (px[0] - labelDrag.from[0]) / k), dy: Math.round(labelDrag.base[1] + (px[1] - labelDrag.from[1]) / k) });
      return;
    }
    if (!pending) return;
    const px = pointer(e);
    if (px) setPending({ ...pending, cursor: px });
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    if (labelDrag) {
      const a = edit.annotations.find((x) => x.id === labelDrag.id);
      if (a) patchAnnotation(a.id, { style: { ...a.style, label_dx: labelDrag.dx || undefined, label_dy: labelDrag.dy || undefined } });
      setLabelDrag(null);
      return;
    }
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
    setSelectedFreeze(String(at));
    setSelected(null);
    setMsg(`Pausa en ${fmtT(at)}: lo que dibujes ahora aparece en ella, uno a uno.`);
  };

  const saveFile = async () => {
    const out: ClipEdit = { ...edit, snapshot: data.snapshot, fixed_file: data.fixedFile, ...(Object.keys(palette).length ? { palette } : {}) };
    save(out);
    if (!match.folder) return setMsg("El partido no tiene carpeta: la edición queda guardada en este navegador.");
    const ok = await writeLocal(editPath(match.folder, edit.edit_id), JSON.stringify(out));
    setMsg(ok ? `Guardado en matches/${match.folder}/edits/edit_${edit.edit_id}.json` : "No se pudo escribir en la carpeta del partido (¿la app corre en esta computadora?). La edición sigue guardada en el navegador.");
  };

  // MP4 of the clip (sportsan.clips.render through app/api/run): saves the edit in the folder first, then waits for the job.
  const [exporting, setExporting] = useState(false);
  const exportMp4 = async (profile: "charla" | "whatsapp") => {
    if (!match.folder) return setMsg("El partido no tiene carpeta: no hay dónde escribir el MP4.");
    setExporting(true);
    try {
      await saveFile();
      const r = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "clip", match: match.folder, editId: edit.edit_id, profile }) });
      if (!r.ok) return setMsg(r.status === 404 ? "Exportar solo funciona con la app corriendo en esta computadora." : `No se pudo empezar la exportación (${await r.text()}).`);
      const job = (await r.json()) as { id: string };
      setMsg(`Exportando el MP4 (${profile})…`);
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 1500));
        const x = await fetch(`/api/run?id=${encodeURIComponent(job.id)}`, { cache: "no-store" });
        if (!x.ok) return setMsg("Se perdió el trabajo de exportación (¿se reinició la app?).");
        const v = (await x.json()) as { state: string; tail?: string[] };
        if (v.state === "running") continue;
        return setMsg(v.state === "done" ? `Listo: matches/${match.folder}/clips/${edit.edit_id}_${profile}.mp4` : `La exportación falló: ${(v.tail ?? []).slice(-3).join(" ")}`);
      }
    } finally {
      setExporting(false);
    }
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

  // Frame by frame: from the frame under the playhead (or from the last step, while the player still catches up with it).
  const lastStep = useRef<{ t: number; at: number } | null>(null);
  const stepFrames = (n: number) => {
    const p = playerRef.current;
    if (!p) return;
    pausePlay();
    const from = lastStep.current && nowMs() - lastStep.current.at < 500 ? lastStep.current.t : p.getTime();
    const to = stepTime(from, fps, n, edit.t_start, edit.t_end);
    lastStep.current = { t: to, at: nowMs() };
    p.seek(to);
  };
  const stepSeconds = (sec: number) => stepFrames(Math.round(sec * fps));
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
        if (e.key === "b") {
          take();
          setPref(LOOP_PREF, loop ? "off" : "on");
        } else if (e.key === " " || e.key === "ArrowRight" || e.key === "PageDown") {
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
      if ((e.key === "Delete" || e.key === "Backspace") && selectedFreeze) {
        take();
        save({ ...edit, freezes: edit.freezes.filter((f) => String(f.t) !== selectedFreeze) });
        return setSelectedFreeze(null);
      }
      if (e.key === "p") {
        take();
        addFreeze();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        take();
        stepFrames((e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1));
        return;
      }
      if (e.key === "b") {
        take();
        setPref(LOOP_PREF, loop ? "off" : "on");
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
  const sel = edit.annotations.find((a) => a.id === selected) ?? null;
  const pendingPx: Pt[] = [];
  for (const a of pending?.anchors ?? []) {
    const p = a.kind === "player" ? people.find((x) => x.id === a.identity)?.px : a.kind === "pitch" ? toImage?.([a.x, a.y]) : null;
    if (p) pendingPx.push(p);
  }
  const stopHere = edit.freezes.find((f) => Math.abs(f.t - t) < 0.05);

  // The video keeps its place in the tree when presenting (it only becomes a fixed full-screen layer), so the player is
  // not reloaded.
  const videoBox = (
    <div className={presenting ? "fixed inset-0 z-[70] flex flex-col justify-center bg-black" : ""}>
      <div className={presenting ? "relative mx-auto w-full max-w-[calc(100vh*16/9)]" : "relative w-full"}>
        <VideoPlayer ref={playerRef} fileUrl={data.videoUrl ?? undefined} youtubeId={data.videoUrl ? undefined : youtubeId} />
        {metricsOver && !presenting && <PlayMetricsCard match={match} videoId={edit.video_id} t0={edit.t_start} t1={edit.t_end} />}
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
          <ClipDrawings items={drawn} image={image} bodies={bodies} selected={presenting ? null : selected} onPick={!presenting && tool === "select" ? setSelected : undefined} onLabelDown={!presenting && tool === "select" ? startLabelDrag : undefined} />
          {pendingPx.length > 0 && pending?.cursor && (
            <polyline points={[...pendingPx, pending.cursor].map((p) => p.join(",")).join(" ")} fill="none" stroke={dc(color)} strokeWidth={3 * k} strokeDasharray={`${10 * k} ${8 * k}`} pointerEvents="none" />
          )}
          {view.stop && !presenting && (
            <text x={24 * k} y={50 * k} fontSize={30 * k} fontWeight={700} fill="#fff" stroke="#000" strokeWidth={5 * k} paintOrder="stroke" pointerEvents="none">
              Pausa · {view.stop.shown}/{view.stop.freeze.reveal.length}
            </text>
          )}
        </svg>
      </div>
      {presenting && (
        <>
          <button
            type="button"
            aria-pressed={loop}
            onClick={() => setPref(LOOP_PREF, loop ? "off" : "on")}
            title="Repite el tramo (b)"
            className={`absolute top-3 right-4 z-10 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs backdrop-blur ${loop ? "bg-accent text-white" : "bg-black/50 text-white/70 hover:text-white"}`}
          >
            <Repeat size={14} />
            Bucle {loop ? "sí" : "no"}
            {loop && margin > 0 ? ` · ±${margin} s` : ""}
          </button>
          <div className="pointer-events-none absolute right-4 bottom-3 left-4 flex items-center justify-between text-xs text-white/60">
            <span>{edit.title}</span>
            <span>Espacio o → sigue · ← pausa anterior · b bucle · Esc sale</span>
          </div>
        </>
      )}
    </div>
  );

  const source = data.loading
    ? "Leyendo la calibración y el tracking de la carpeta del partido…"
    : data.source === "folder"
      ? `Calibración y posiciones de la carpeta del partido${data.fixedFile?.startsWith("tracks_fixed") ? " (tracking corregido)" : data.fixedFile ? " (tracking sin corregir: identidades del programa)" : " (sin tracking: solo puntos del césped y texto)"}.`
      : data.source === "saved"
        ? "Sin la carpeta del partido: se usan la calibración y las posiciones guardadas con la edición."
        : "Sin calibración de este tramo: solo se puede poner texto en pantalla. Calibra y procesa el tramo en la pestaña Tracking para dibujar sobre el césped.";

  const header = (
    <>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-muted" aria-hidden>
        <PencilSimpleLine size={18} />
      </span>
      <input className={`${input} min-w-48 flex-1 font-medium`} value={edit.title} aria-label="Título del clip" onChange={(e) => save({ ...edit, title: e.target.value })} />
      <button type="button" className={btn} onClick={() => void saveFile()} title="Escribe edit_<id>.json en matches/<partido>/edits/ (con las posiciones y la calibración del tramo, para exportar a MP4)">
        <FloppyDisk size={15} />
        Guardar en la carpeta
      </button>
      <button type="button" className={btn} disabled={exporting} onClick={() => void exportMp4("charla")} title="MP4 en 1080p para proyectar (matches/<partido>/clips/)">
        <FilmSlate size={15} />
        {exporting ? "Exportando…" : "Exportar MP4"}
      </button>
      <button type="button" className={btn} disabled={exporting} onClick={() => void exportMp4("whatsapp")} title="MP4 de 720p y ~1.5 Mbps; rotula por dorsal">
        WhatsApp
      </button>
      <button type="button" className={btnPrimary} onClick={present}>
        <PresentationChart size={15} />
        Presentar
      </button>
      <IconButton label="Cerrar el editor" onClick={onClose}>
        <X size={16} />
      </IconButton>
      <p className="m-0 basis-full text-xs text-muted">
        {source}
        {msg && <span className="ml-2 text-ink-2">{msg}</span>}
      </p>
    </>
  );

  const ICONS: Record<AnnotationKind, Icon> = { highlight: Circle, arrow: ArrowUpRight, line: LineSegments, zone: Polygon, text: TextT };
  const freezeSel = edit.freezes.find((f) => String(f.t) === selectedFreeze) ?? null;
  const seek = (to: number) => {
    pausePlay();
    playerRef.current?.seek(Math.min(edit.t_end, Math.max(edit.t_start, to)));
  };
  // A stop moved: the drawings that appear in it go with it.
  const moveFreeze = (from: number, to: number) => {
    if (edit.freezes.some((f) => f.t !== from && Math.abs(f.t - to) < 0.05)) return;
    save({
      ...edit,
      freezes: edit.freezes.map((f) => (f.t === from ? { ...f, t: to } : f)).sort((x, y) => x.t - y.t),
      annotations: edit.annotations.map((a) => (a.t_in === from ? { ...a, t_in: to, t_out: Math.max(a.t_out, to + 0.1) } : a)),
    });
    setSelectedFreeze(String(to));
  };
  const clampIn = (v: number, a: Annotation) => Math.min(a.t_out - 0.1, Math.max(edit.t_start, Math.round(v * 100) / 100));
  const clampOut = (v: number, a: Annotation) => Math.max(a.t_in + 0.1, Math.min(edit.t_end, Math.round(v * 100) / 100));

  // Players that have a highlight in the clip (to remove the label of one of them).
  const markedPlayers = [...new Set(edit.annotations.flatMap((a) => (a.kind === "highlight" && a.anchors[0]?.kind === "player" ? [a.anchors[0].identity] : [])))];

  const inspector = sel ? (
    <div className="space-y-4 text-xs">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md" style={{ background: `color-mix(in srgb, ${dc(sel.style.color)} 35%, transparent)` }}>
          {(() => {
            const I = ICONS[sel.kind];
            return <I size={15} weight="bold" />;
          })()}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">{ANNOTATION_LABELS[sel.kind]}</span>
          <span className="block text-faint">{sel.anchors.some((x) => x.kind === "player") ? "sigue a jugadoras" : sel.anchors[0].kind === "screen" ? "fijo en pantalla" : "fijo en el césped"}</span>
        </span>
        <span className="ml-auto">
          <IconButton
            label="Borrar el dibujo (Supr)"
            tone="danger"
            onClick={() => {
              save(removeFromEdit(edit, sel.id));
              setSelected(null);
            }}
          >
            <Trash size={14} />
          </IconButton>
        </span>
      </div>
      <input
        className={`${input} h-8 w-full text-xs`}
        placeholder={sel.kind === "text" ? "Texto" : "Rótulo (opcional)"}
        value={sel.style.label ?? ""}
        onChange={(e) => patchAnnotation(sel.id, { style: { ...sel.style, label: e.target.value || undefined } })}
      />
      {sel.kind === "highlight" && (
        <div className="space-y-2">
          <PanelTitle>Resalte</PanelTitle>
          <ShapeSeg value={highlightShape(sel.style)} onChange={(v) => patchAnnotation(sel.id, { style: { ...sel.style, shape: v === "oval" ? undefined : v } })} label="Forma del resalte" />
        </div>
      )}
      {sel.kind !== "text" && (
        <div className="space-y-2">
          <PanelTitle right={<span className="text-faint">arrástralo en el video</span>}>Rótulo</PanelTitle>
          <SideSeg value={sel.style.label_side ?? edit.label_side ?? "up"} onChange={(v) => patchAnnotation(sel.id, { style: { ...sel.style, label_side: v, label_dx: undefined, label_dy: undefined } })} label="Lado del rótulo" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!sel.style.label_off} onChange={(e) => patchAnnotation(sel.id, { style: { ...sel.style, label_off: e.target.checked || undefined } })} />
              Sin rótulo en este dibujo
            </label>
            {(sel.style.label_dx || sel.style.label_dy) && (
              <button type="button" className="link" onClick={() => patchAnnotation(sel.id, { style: { ...sel.style, label_dx: undefined, label_dy: undefined } })}>
                Volver a su sitio
              </button>
            )}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <PanelTitle>Estilo</PanelTitle>
        <ColorPick value={sel.style.color} onChange={(c) => patchAnnotation(sel.id, { style: { ...sel.style, color: c } })} />
        {sel.kind !== "text" && (
          <label className="flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={!!sel.style.dashed} onChange={(e) => patchAnnotation(sel.id, { style: { ...sel.style, dashed: e.target.checked || undefined } })} />
            Línea discontinua
          </label>
        )}
      </div>
      <div className="space-y-1.5">
        <PanelTitle right={<span className="tc text-faint">{Math.round((sel.t_out - sel.t_in) * 10) / 10} s</span>}>Tiempo</PanelTitle>
        <TimeField label="Entra" value={sel.t_in} fmt={fmtT} now={t} onChange={(v) => patchAnnotation(sel.id, { t_in: clampIn(v, sel) })} />
        <TimeField label="Sale" value={sel.t_out} fmt={fmtT} now={t} onChange={(v) => patchAnnotation(sel.id, { t_out: clampOut(v, sel) })} />
        {edit.freezes.some((f) => f.reveal.includes(sel.id)) && <p className="text-faint">Aparece en la pausa de {fmtT(sel.t_in)}.</p>}
      </div>
      <p className="text-faint">En la línea de tiempo: arrastra la barra para moverla y sus bordes para recortarla; se pegan al cabezal y a las pausas.</p>
    </div>
  ) : freezeSel ? (
    <div className="space-y-4 text-xs">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-warn/25 text-warn">
          <HandPalm size={15} weight="bold" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">Pausa</span>
          <button type="button" className="tc link" onClick={() => seek(freezeSel.t)}>
            {fmtT(freezeSel.t)}
          </button>
        </span>
        <span className="ml-auto">
          <IconButton
            label="Quitar la pausa"
            tone="danger"
            onClick={() => {
              save({ ...edit, freezes: edit.freezes.filter((x) => x !== freezeSel) });
              setSelectedFreeze(null);
            }}
          >
            <Trash size={14} />
          </IconButton>
        </span>
      </div>
      <TimeField label="Dura" value={freezeSel.duration_s} fmt={(v) => `${v} s`} onChange={(v) => save({ ...edit, freezes: edit.freezes.map((x) => (x === freezeSel ? { ...x, duration_s: Math.max(0.5, Math.round(v * 2) / 2) } : x)) })} />
      <div>
        <PanelTitle right={<span className="text-faint">en este orden</span>}>Aparecen</PanelTitle>
        {freezeSel.reveal.length === 0 ? (
          <p className="text-faint">Nada todavía: con el cabezal en la pausa, lo que dibujes aparece en ella, uno a uno.</p>
        ) : (
          <ol className="space-y-1">
            {freezeSel.reveal.map((id, i) => {
              const a = edit.annotations.find((x) => x.id === id);
              if (!a) return null;
              const move = (d: number) => {
                const r = [...freezeSel.reveal];
                [r[i], r[i + d]] = [r[i + d], r[i]];
                save({ ...edit, freezes: edit.freezes.map((x) => (x === freezeSel ? { ...x, reveal: r } : x)) });
              };
              return (
                <li key={id} className="flex items-center gap-2 rounded-md bg-raised px-2 py-1">
                  <span className="tc w-4 text-faint">{i + 1}</span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: dc(a.style.color) }} />
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-ink-2 hover:text-ink" onClick={() => setSelected(a.id)}>
                    {a.style.label || ANNOTATION_LABELS[a.kind]}
                  </button>
                  <button type="button" className="px-1 text-faint hover:text-ink disabled:opacity-30" disabled={i === 0} aria-label="Antes" onClick={() => move(-1)}>
                    ↑
                  </button>
                  <button type="button" className="px-1 text-faint hover:text-ink disabled:opacity-30" disabled={i === freezeSel.reveal.length - 1} aria-label="Después" onClick={() => move(1)}>
                    ↓
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <p className="text-faint">Arrastra la pausa en la línea de tiempo para cambiarla de momento: sus dibujos se van con ella.</p>
    </div>
  ) : (
    <div className="space-y-4 text-xs">
      <dl className="grid grid-cols-2 gap-2">
        {(
          [
            ["Clip", `${Math.round(span * 10) / 10} s`],
            ["Con pausas", `${Math.round(tl.duration * 10) / 10} s`],
            ["Dibujos", String(edit.annotations.length)],
            ["Pausas", String(edit.freezes.length)],
          ] as const
        ).map(([k2, v]) => (
          <div key={k2} className="rounded-lg bg-raised px-2.5 py-2">
            <dt className="text-faint">{k2}</dt>
            <dd className="num text-lg text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <PanelTitle>Rótulo de las jugadoras</PanelTitle>
        <div className="seg flex" aria-label="Rótulo de las jugadoras">
          {LABEL_MODES.map(([m, label]) => (
            <button key={m} type="button" className="seg-opt flex-1 text-center" aria-pressed={edit.label_mode === m} onClick={() => save({ ...edit, label_mode: m })}>
              {label}
            </button>
          ))}
        </div>
        <div className="mt-2 space-y-2">
          <SideSeg value={edit.label_side ?? "up"} onChange={(v) => save({ ...edit, label_side: v })} label="Lado de los rótulos" />
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className={`${btn} !px-2 !py-1 text-xs`}
              disabled={edit.label_mode === "none" && edit.annotations.every((a) => a.kind === "text" || a.style.label_off)}
              onClick={() => save({ ...edit, label_mode: "none", annotations: edit.annotations.map((a) => (a.kind === "text" ? a : { ...a, style: { ...a.style, label_off: true } })) })}
              title="Quita el nombre o dorsal y el texto de todos los dibujos que no son texto en pantalla"
            >
              Quitar todos
            </button>
            <button
              type="button"
              className={`${btn} !px-2 !py-1 text-xs`}
              disabled={!edit.annotations.some((a) => a.style.label_off) && !edit.hidden_labels?.length}
              onClick={() => save({ ...edit, hidden_labels: undefined, annotations: edit.annotations.map((a) => (a.style.label_off ? { ...a, style: { ...a.style, label_off: undefined } } : a)) })}
            >
              Volver a mostrarlos
            </button>
          </div>
          {markedPlayers.length > 0 && (
            <div>
              <p className="m-0 mb-1 text-faint">Quitar el rótulo de una jugadora:</p>
              <div className="flex flex-wrap gap-1">
                {markedPlayers.map((id) => {
                  const off = (edit.hidden_labels ?? []).map(String).includes(String(id));
                  return (
                    <button
                      key={String(id)}
                      type="button"
                      aria-pressed={off}
                      onClick={() => save({ ...edit, hidden_labels: off ? (edit.hidden_labels ?? []).filter((x) => String(x) !== String(id)) : [...(edit.hidden_labels ?? []), id] })}
                      className={`rounded-md px-1.5 py-0.5 text-[11px] ${off ? "bg-raised text-faint line-through" : "bg-accent-900 text-accent-300"}`}
                    >
                      {labelFor(id, edit.label_mode === "none" ? "number" : edit.label_mode, snap) ?? `#${id}`}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <div>
        <PanelTitle>Resalte nuevo</PanelTitle>
        <ShapeSeg value={edit.highlight_shape ?? "oval"} onChange={(v) => save({ ...edit, highlight_shape: v })} label="Forma del resalte nuevo" />
      </div>
      <details className="rounded-lg bg-raised px-2.5 py-2">
        <summary className="cursor-pointer text-muted">Paleta de colores</summary>
        <div className="mt-2">
          <PaletteEditor />
        </div>
      </details>
      <div>
        <PanelTitle>Teclas</PanelTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-faint">
          {(
            [
              ["Espacio", "reproducir / pausar"],
              ["← →", "un cuadro (Mayús: 10 cuadros)"],
              ["b", "bucle del tramo"],
              ["p", "pausa aquí"],
              ["m r f l z t", "herramientas"],
              ["Enter / Esc", "terminar / cancelar"],
              ["Supr", "borrar lo elegido"],
            ] as const
          ).map(([k2, v]) => (
            <Fragment key={k2}>
              <dt className="tc text-ink-2">{k2}</dt>
              <dd className="m-0">{v}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
      <p className="text-faint">Elige un dibujo o una pausa en el video o en la línea de tiempo para editarlo aquí.</p>
    </div>
  );

  const timelinePanel = (
    <Timeline
      min={edit.t_start}
      max={edit.t_end}
      now={t}
      fmt={fmtT}
      onSeek={seek}
      lanes={wide && typeof window !== "undefined" && window.innerHeight < 860 ? 2 : 3}
      transport={
        <>
          <button
            type="button"
            className={`${btnPrimary} h-9 w-9 !p-0`}
            onClick={() => (playing ? pausePlay() : startPlay())}
            aria-label={playing ? "Pausar el clip (espacio)" : "Reproducir el clip (espacio)"}
            title={playing ? "Pausar el clip (espacio)" : "Reproducir el clip (espacio)"}
          >
            {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
          </button>
          <span className="inline-flex items-center rounded-md bg-raised" role="group" aria-label="Avance por cuadro">
            <StepBtn icon={CaretDoubleLeft} label="Un segundo atrás (Mayús + ←: 10 cuadros)" onClick={() => stepSeconds(-1)} />
            <StepBtn icon={CaretLeft} label="Un cuadro atrás (←)" onClick={() => stepFrames(-1)} />
            <span className="tc min-w-24 px-1 text-center text-[11px] text-ink" title={snap ? `${fps.toFixed(3)} cuadros por segundo` : `Sin tracking no se conoce la tasa del video: se supone ${FALLBACK_FPS} cuadros por segundo`}>
              {frameLabel(t, fps, edit.t_start)}
              {!snap && <span className="text-faint"> · {FALLBACK_FPS} fps supuestos</span>}
            </span>
            <StepBtn icon={CaretRight} label="Un cuadro adelante (→)" onClick={() => stepFrames(1)} />
            <StepBtn icon={CaretDoubleRight} label="Un segundo adelante (Mayús + →: 10 cuadros)" onClick={() => stepSeconds(1)} />
          </span>
          <span className="tc rounded-md bg-raised px-2 py-1 text-xs text-ink">
            {fmtT(t)} <span className="text-faint">/ {Math.round(span * 10) / 10} s</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              className={`${btn} !px-2`}
              aria-pressed={loop}
              onClick={() => setPref(LOOP_PREF, loop ? "off" : "on")}
              title="Repite el tramo del clip con sus dibujos y pausas (b)"
            >
              <Repeat size={14} weight={loop ? "bold" : "regular"} className={loop ? "text-accent-300" : ""} />
              Bucle {loop ? "sí" : "no"}
            </button>
            {loop && (
              <select className="rounded-md bg-raised px-1.5 py-1.5 text-xs text-ink-2" aria-label="Margen del bucle" value={margin} onChange={(e) => setPref(LOOP_MARGIN_PREF, e.target.value)}>
                {LOOP_MARGINS.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? "sin margen" : `± ${m} s`}
                  </option>
                ))}
              </select>
            )}
          </span>
          <button type="button" className={btn} aria-pressed={metricsOver} onClick={() => setPref("studio:metricsOver", metricsOver ? "off" : "on")} title="Muestra las cifras clave de la jugada sobre el video (todas en la pestaña Métricas)">
            <ChartBar size={14} />
            Métricas
          </button>
          <button type="button" className={btn} onClick={addFreeze} title="Congela la imagen en este momento al reproducir (p)">
            <HandPalm size={14} />
            Pausa aquí
          </button>
          {pending && pending.kind !== "arrow" && (
            <button type="button" className={btnPrimary} onClick={finish} disabled={pending.anchors.length < (pending.kind === "zone" ? 3 : 2)}>
              Terminar {ANNOTATION_LABELS[pending.kind].toLowerCase()}
            </button>
          )}
        </>
      }
      right={
        <>
          <TimeRange start={edit.t_start} end={edit.t_end} now={t} onChange={setRange} />
          <span className="tc text-xs text-muted" title="Duración del clip con las pausas">
            con pausas {Math.round(tl.duration * 10) / 10} s
          </span>
        </>
      }
      markers={{
        label: "Pausas",
        icon: HandPalm,
        items: edit.freezes.map((f) => ({ id: String(f.t), t: f.t, label: `${f.duration_s} s · ${f.reveal.length}`, title: `Pausa en ${fmtT(f.t)}: ${f.duration_s} s, ${f.reveal.length} dibujo(s) que aparecen en ella` })),
        selected: selectedFreeze,
        onPick: (id) => {
          setSelectedFreeze(id);
          setSelected(null);
          seek(Number(id));
        },
        onMove: (id, to) => moveFreeze(Number(id), to),
      }}
      items={{
        label: "Dibujos",
        icon: PencilSimpleLine,
        items: edit.annotations.map((a) => ({
          id: a.id,
          start: a.t_in,
          end: a.t_out,
          color: dc(a.style.color),
          label: a.style.label || ANNOTATION_LABELS[a.kind],
          icon: ICONS[a.kind],
          dashed: !!a.style.dashed,
        })),
        selected,
        onPick: (id) => {
          setSelected(id);
          setSelectedFreeze(null);
        },
        onChange: (id, start, end) => patchAnnotation(id, { t_in: start, t_out: end }),
        snaps: edit.freezes.map((f) => f.t),
        empty: "Elige una herramienta y dibuja sobre el video",
      }}
    />
  );

  return createPortal(
    <div
      ref={rootRef}
      className={`fixed inset-0 z-[60] bg-bg px-4 py-4 md:px-6 ${wide ? "flex flex-col" : "overflow-y-auto"}`}
      role="dialog"
      aria-label={presenting ? "Presentación del clip" : "Editar clip"}
    >
      <StudioFrame
        fixed={wide}
        className={wide ? "min-h-0 flex-1" : ""}
        header={header}
        rail={
          <ToolRail
            tools={TOOLS.map(({ id, label, key, icon }) => ({ id, label, key, icon }))}
            value={tool}
            onChange={(id) => {
              setTool(id);
              setPending(null);
            }}
            color={sel ? sel.style.color : color}
            onColor={(c) => (sel ? patchAnnotation(sel.id, { style: { ...sel.style, color: c } }) : setColor(c))}
            dashed={sel ? !!sel.style.dashed : dashed}
            onDashed={(d) => (sel && sel.kind !== "text" ? patchAnnotation(sel.id, { style: { ...sel.style, dashed: d || undefined } }) : setDashed(d))}
            dashedIcon={CircleDashed}
          >
            <RailButton label="Pausa aquí (p): congela la imagen al reproducir" icon={HandPalm} onClick={addFreeze} active={!!stopHere} />
          </ToolRail>
        }
        canvas={
          <div className="flex h-full flex-col">
            <div className="mb-1 flex min-h-6 items-center gap-2 px-1 text-xs text-faint">
              <p className="m-0 min-w-0 flex-1 truncate" title={HINTS[tool]}>
                {pending && pending.kind !== "arrow"
                  ? `${ANNOTATION_LABELS[pending.kind]}: ${pending.anchors.length} ${pending.anchors.length === 1 ? "punto" : "puntos"} · Enter termina, Esc cancela`
                  : HINTS[tool]}
              </p>
              {tool === "highlight" && (
                <ShapeSeg value={edit.highlight_shape ?? "oval"} onChange={(v) => save({ ...edit, highlight_shape: v })} label="Resalte nuevo" />
              )}
            </div>
            <div className="min-h-0 flex-1">
              <FitAspect aspect={image.w / image.h}>{videoBox}</FitAspect>
            </div>
          </div>
        }
        timeline={timelinePanel}
        side={
          <SidePanel
            tabs={[
              ["clip", sel ? "Dibujo" : freezeSel ? "Pausa" : "Clip"],
              ["metrics", "Métricas"],
            ]}
            value={sideTab}
            onChange={setSideTab}
          >
            {sideTab === "metrics" ? <PlayMetricsPanel match={match} videoId={edit.video_id} t0={edit.t_start} t1={edit.t_end} /> : inspector}
          </SidePanel>
        }
      />
    </div>,
    document.body,
  );
}

// Shape of a highlight (oval, arrow, none) as a small segmented control.
function ShapeSeg({ value, onChange, label }: { value: HighlightShape; onChange: (v: HighlightShape) => void; label: string }) {
  return (
    <div className="seg flex shrink-0" role="group" aria-label={label}>
      {HIGHLIGHT_SHAPES.map((v) => (
        <button key={v} type="button" className="seg-opt flex-1 !px-2 !py-0.5 text-center text-xs" aria-pressed={value === v} onClick={() => onChange(v)}>
          {HIGHLIGHT_SHAPE_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

// Side of the label of a marked player.
function SideSeg({ value, onChange, label }: { value: LabelSide; onChange: (v: LabelSide) => void; label: string }) {
  return (
    <div className="seg flex" role="group" aria-label={label}>
      {LABEL_SIDES.map((v) => (
        <button key={v} type="button" className="seg-opt flex-1 !px-1.5 !py-0.5 text-center text-xs" aria-pressed={value === v} onClick={() => onChange(v)}>
          {LABEL_SIDE_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

function StepBtn({ icon: I, label, onClick }: { icon: Icon; label: string; onClick: () => void }) {
  return (
    <button type="button" className="px-1.5 py-1.5 text-muted hover:text-ink" aria-label={label} title={label} onClick={onClick}>
      <I size={13} weight="bold" />
    </button>
  );
}
