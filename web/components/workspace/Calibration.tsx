"use client";

import { Anchor, Selection, ArrowClockwise, ArrowCounterClockwise, CaretDown, CircleHalf, CaretLeft, CaretRight, CaretUp, Check, CheckCircle, Crop, Crosshair, DownloadSimple, Eraser, Eye, FastForward, FolderOpen, GearSix, Info, Keyboard, Pause, Play, Plus, Rewind, SkipBack, SkipForward, TerminalWindow, Trash, Warning, X } from "@phosphor-icons/react";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { IconButton, Modal } from "@/components/Modal";
import { Select } from "@/components/Select";
import { Command } from "@/components/Command";
import { KitPanel, sampleShirt, useKits } from "@/components/workspace/KitPanel";
import type { JerseyKey } from "@/lib/tracks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLORS, Pitch } from "@/components/Pitch";
import { FilePicker, partLabel } from "@/components/LocalPick";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { localVideo, readLocal, writeLocal } from "@/lib/local";
import { readVideoMask, writeVideoMask } from "@/lib/matchYaml";
import { SpeedControl } from "@/components/SpeedControl";
import { downloadText, fmtT, isTyping } from "@/lib/format";
import { parseHms } from "@/lib/segments";
import { apply, fitHomography, fitQuality, invert, invertFor, lerpHomography, orient, type Pt } from "@/lib/homography";
import { mutate, setPref, uid, useHydrated, usePref, useStore } from "@/lib/store";
import type { AnchorPoint, CalibAnchor } from "@/lib/types";
import { VENUES, allVenues, toNormalized, type Landmark, type Venue } from "@/lib/venue";
import { IX, landmarksWith, linePoints, namedLines, type ImageLine } from "@/lib/calibLines";
import { ARC_MIN, constraintPoints, fitHybrid, type ArcInput } from "@/lib/calibFit";

const GROUPS: { id: Landmark["group"]; label: string; short: string }[] = [
  { id: "football", label: "Rejilla de americano (exacta)", short: "Americano" },
  { id: "hash", label: "Marcas interiores (posición sin confirmar, no usar aún)", short: "Interiores" },
  { id: "soccer", label: "Líneas de fútbol (por verificar)", short: "Fútbol" },
];
const OVERLAY = { football: "#22d3ee", soccer: "#f0abfc" };
// Reprojection error above this (meters) is flagged in the table.
const WARN_M = 1.5;
const NUDGE_STEPS = [0.25, 1, 5];
// Width of the side panel (px), dragged from its left edge.
const SIDE_MIN = 320;
const SIDE_MAX = 600;
const SIDE_DEFAULT = 400;
// How a fit reads: honest error (leaving one point out) when there is one, else the RMS of the fit.
const fitVerdict = (m: number) => (m <= 1 ? { label: "Bueno", cls: "text-ok" } : m <= WARN_M ? { label: "Aceptable", cls: "text-accent-200" } : { label: "Revisar", cls: "text-warn" });

// Calibration of every frame of a stretch, computed by `python -m sportsan.tracking.propagate` from the exported anchors.
// It is kept in memory only: a stretch of a few seconds already holds hundreds of matrices.
// One part of the detection run (`python -m sportsan.tracking.detect`): boxes in pixels with their track id.
interface Detections {
  name: string;
  start: number;
  end: number;
  stride: number;
  // frame -> rows [track_id, x1, y1, x2, y2, conf, lab_l, lab_a, lab_b, x, y, on_pitch, team]. The last four exist only
  // when the part was computed together with the calibration (sportsan.tracking.process).
  frames: Map<number, DetBox[]>;
  hasPositions: boolean;
  quality: {
    people_median?: number;
    tracks?: number;
    tracks_long?: number;
    tracks_per_person?: number;
    low_visibility?: [number, number][];
    calibrated_share?: number;
    on_pitch_median?: number;
    on_pitch_tracks?: number;
    on_pitch_tracks_long?: number;
    on_pitch_tracks_short?: number;
    on_pitch_tracks_per_person?: number;
  };
}

type DetBox = [number, number, number, number, number, number, number, number, number, number | null, number | null, boolean, string];
const TEAM_COLORS: Record<string, string> = { own: COLORS.own, opp: COLORS.opp, ref: "var(--color-warn)" };

// A stable, well separated colour per track id.
const trackColor = (id: number) => `hsl(${(id * 47) % 360} 90% 62%)`;

// "Realzar líneas": grey, strong contrast and a little brightness; white paint on grass comes out of the green.
const ENHANCE_FILTER = "grayscale(1) contrast(2.4) brightness(1.08)";

type ArcId = "center" | "pen_l" | "pen_r";

interface CalibTrack {
  name: string;
  start: number;
  end: number;
  frames: Map<number, { H: number[] | null; source: string; dis: number | null }>;
  check: { frame: number; error_mean_m: number | null; error_max_m: number | null }[];
  meanDis: number | null;
  worst: { frame: number; dis: number } | null;
  // The frames that disagree most (propagated only), worst first, at least a second apart.
  worstList: { frame: number; dis: number }[];
}

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

// Calibration of one video of a match. Inside a match (embedded) its folder, video and venue come from the match and
// the page header is left out; on its own route they are typed in.
// The handlers below take the event of a file input; a file read from the match folder goes through them too.
const asEvent = (files: File[]) => ({ target: { files, value: "" } }) as unknown as React.ChangeEvent<HTMLInputElement>;

export function Calibration({
  folder,
  video,
  venue: venueInit,
  onVenue,
  embedded = false,
  teams,
}: { folder?: string; video?: string; venue?: string; onVenue?: (venueId: string) => void; embedded?: boolean; teams?: { own: string; opp: string } } = {}) {
  const state = useStore();
  const hydrated = useHydrated();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number; duration: number } | null>(null);
  const [fps, setFps] = useState(29.97002997);
  // Where the fps comes from: match.yaml (exact, from ffprobe), typed by hand, or the default guess. Anchors keep the
  // frame number computed with it, so a wrong fps shifts them in time (24 frames at 13 min of a 30 fps video).
  const [fpsFrom, setFpsFrom] = useState<"yaml" | "manual" | "default">("default");
  const [time, setTime] = useState(0);
  const [matchId, setMatchId] = useState(folder || "partido_2026_09_25");
  // Shirt colours of the match, taken from this video before processing (the tracking uses them for the teams).
  const kits = useKits(matchId);
  const [pickKit, setPickKit] = useState<JerseyKey | null>(null);
  const [kitMsg, setKitMsg] = useState<string | null>(null);
  const [videoId, setVideoId] = useState(video || "v1");
  // Inside a match the venue is the match's (chosen in its settings); on its own route it is chosen here.
  const [venueIdState, setVenueIdState] = useState(venueInit || VENUES[0].venue_id);
  const venueId = embedded ? venueInit || VENUES[0].venue_id : venueIdState;
  const noVenue = embedded && !venueInit;
  const setVenueId = (id: string) => {
    if (embedded) return;
    setVenueIdState(id);
    onVenue?.(id);
  };
  // Two modes: mark anchors (calibrate) or look at what was computed from them (verify).
  const mode = usePref("calib:mode", "calibrar") === "verificar" ? "verificar" : "calibrar";
  const setMode = (m: "calibrar" | "verificar") => setPref("calib:mode", m);
  // In verify, a processed part shows its players or only its calibration.
  const [show, setShow] = useState<"players" | "calib">("players");
  const [help, setHelp] = useState(false);
  const sideW = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Number(usePref("calib:sideW", String(SIDE_DEFAULT))) || SIDE_DEFAULT));
  // Everything fits the window (no page scroll): the video as large as fits above its controls and the Ajuste panel,
  // the side panel as tall as the window. Measured on wide screens only.
  const fitRef = useRef<HTMLDivElement>(null);
  const [fitH, setFitH] = useState<number | null>(null);
  const [colEl, setColEl] = useState<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [colH, setColH] = useState(0);
  // Crop of the frame (less sky): shared with Tracking, kept per video. While choosing it the whole frame is shown.
  const [cropping, setCropping] = useState(false);
  const [cropDraft, setCropDraft] = useState<[number, number] | null>(null);
  const cropKey = `correction:crop:${folder ?? matchId}:${videoId}`;
  const [cropTopPref, cropBottomPref] = usePref(cropKey, "0,0").split(",").map((v) => Math.min(0.45, Math.max(0, Number(v) || 0)));
  const cropTop = cropping ? 0 : cropTopPref;
  const cropBottom = cropping ? 0 : cropBottomPref;
  const [stageH, setStageH] = useState(0);
  useEffect(() => {
    const measure = () => {
      const el = fitRef.current;
      if (!el || window.innerWidth < 1280) return setFitH(null);
      setFitH(Math.max(420, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 16)));
    };
    const raf = requestAnimationFrame(measure);
    const late = window.setTimeout(measure, 320);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    if (!colEl || !stageEl) return;
    const ro = new ResizeObserver(() => {
      setColH(Math.round(colEl.getBoundingClientRect().height));
      setStageH(Math.round(stageEl.getBoundingClientRect().height));
    });
    ro.observe(colEl);
    ro.observe(stageEl);
    return () => ro.disconnect();
  }, [colEl, stageEl]);
  const [shown, setShown] = useState<Record<Landmark["group"], boolean>>({ football: true, hash: false, soccer: true });

  const [points, setPoints] = useState<AnchorPoint[]>([]);
  // Lines of the pitch marked on the frame (calibration by lines), the tool in use and the line being marked: its
  // clicks on the video and the line of the model it is.
  const [lines, setLines] = useState<ImageLine[]>([]);
  const [tool, setTool] = useState<"points" | "lines" | "arcs">("points");
  // Clicks along circles of the pitch, and the circle being marked.
  const [arcs, setArcs] = useState<{ arc_id: ArcId; pts: Pt[] }[]>([]);
  const [arcId, setArcId] = useState<ArcId>("center");
  const [lineDraft, setLineDraft] = useState<{ px: Pt[]; id: string | null }>({ px: [], id: null });
  // A marked line chosen for the fine adjustment: one of its two clicks, or the whole line (moved or turned).
  const [selLine, setSelLine] = useState<{ id: string; end: "a" | "b" | "both" } | null>(null);
  const [pointsFrame, setPointsFrame] = useState<number | null>(null);
  const [pendingPx, setPendingPx] = useState<Pt | null>(null);
  const [pendingLm, setPendingLm] = useState<string | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [rate, setRate] = useState(1);
  // Marked point selected for pixel-level adjustment.
  const [sel, setSel] = useState<string | null>(null);
  const [step, setStep] = useState(1);
  const [goTo, setGoTo] = useState("");
  const [playing, setPlaying] = useState(false);
  const [dets, setDets] = useState<Detections | null>(null);
  const [detsMsg, setDetsMsg] = useState("");
  const [track, setTrack] = useState<CalibTrack | null>(null);
  const [trackMsg, setTrackMsg] = useState("");

  const venues = useMemo(() => allVenues(state.venues), [state.venues]);
  const venue = venues.find((v) => v.venue_id === venueId) ?? venues[0];
  const modelLines = useMemo(() => namedLines(venue), [venue]);
  // The circles that can be marked: the centre circle and the arcs around each penalty spot (same radius).
  const circles = useMemo(() => {
    const R = venue.spec.circle_r_m ?? 9.15;
    const spot = (t: string) => venue.landmarks.find((l) => l.id === `sc_${t}_ps`);
    const out: Record<ArcId, { c: Pt; r: number } | null> = {
      center: { c: [venue.length_m / 2, venue.width_m / 2], r: R },
      pen_l: spot("l") ? { c: [spot("l")!.x, spot("l")!.y], r: R } : null,
      pen_r: spot("r") ? { c: [spot("r")!.x, spot("r")!.y], r: R } : null,
    };
    return out;
  }, [venue]);
  // The points computed where two marked lines cross, and every landmark by id (computed ones included).
  const derived = useMemo(() => linePoints(venue, lines), [venue, lines]);
  const byId = useMemo(() => {
    const m = new Map(venue.landmarks.map((l) => [l.id, l]));
    for (const d of derived) m.set(d.landmark.id, d.landmark);
    return m;
  }, [venue, derived]);
  // Clicked points and computed ones: what the fit uses and what is saved.
  const allPoints = useMemo(
    () =>
      derived.length === 0 && !points.some((p) => p.landmark_id.startsWith(IX))
        ? points
        : [...points.filter((p) => !p.landmark_id.startsWith(IX)), ...derived.map((d) => ({ landmark_id: d.landmark.id, px: d.px, py: d.py }))],
    [points, derived],
  );
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

  // A new file resets the element's playback rate, so it is applied again.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, fileUrl]);

  // Moves the selected point by a number of steps. Read through a ref by the key handler.
  const selPoint = stale ? null : (points.find((q) => q.landmark_id === sel) ?? null);
  // A chosen point wins over a chosen line (choosing a line clears the point).
  const selLineObj = !stale && selLine && !sel ? (lines.find((l) => l.line_id === selLine.id) ?? null) : null;
  const nudge = (ux: number, uy: number) => {
    if (selLineObj && selLine) {
      const dx = ux * step;
      const dy = uy * step;
      const mv = (q: [number, number]): [number, number] => [q[0] + dx, q[1] + dy];
      return setLines((ls) =>
        ls.map((l) => (l.line_id !== selLine.id ? l : { ...l, a: selLine.end !== "b" ? mv(l.a) : l.a, b: selLine.end !== "a" ? mv(l.b) : l.b })),
      );
    }
    if (!selPoint) return;
    setPoints((ps) => ps.map((q) => (q.landmark_id === sel ? { ...q, px: q.px + ux * step, py: q.py + uy * step } : q)));
  };
  // Turns the selected line around its middle (degrees, clockwise on screen).
  const rotateLine = (deg: number) => {
    if (!selLineObj || !selLine) return;
    const r = (deg * Math.PI) / 180;
    const cx = (selLineObj.a[0] + selLineObj.b[0]) / 2;
    const cy = (selLineObj.a[1] + selLineObj.b[1]) / 2;
    const turn = (q: [number, number]): [number, number] => [cx + (q[0] - cx) * Math.cos(r) - (q[1] - cy) * Math.sin(r), cy + (q[0] - cx) * Math.sin(r) + (q[1] - cy) * Math.cos(r)];
    setLines((ls) => ls.map((l) => (l.line_id !== selLine.id ? l : { ...l, a: turn(l.a), b: turn(l.b) })));
  };
  const pickLine = (id: string, end: "a" | "b" | "both" = "a") => {
    setSelLine({ id, end });
    setSel(null);
  };
  const nudgeRef = useRef(nudge);
  const rotateRef = useRef(rotateLine);
  const endRef = useRef<(end: "a" | "b" | "both") => void>(() => undefined);
  useEffect(() => {
    nudgeRef.current = nudge;
    rotateRef.current = rotateLine;
    endRef.current = (end) => setSelLine((s) => (s ? { ...s, end } : s));
  });

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
      if (isTyping(el)) return;
      const v = videoRef.current;
      if (!v) return;
      const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
      if (e.altKey && dir) {
        e.preventDefault();
        nudgeRef.current(dir[0] * (e.shiftKey ? 10 : 1), dir[1] * (e.shiftKey ? 10 : 1));
        return;
      }
      // Lines: Alt + , / . turn the selected line (a tenth of a degree; with Shift, one degree); Alt + 1 / 2 / 3 choose
      // its first click, its second click or the whole line.
      if (e.altKey && (e.key === "," || e.key === "." || e.code === "Comma" || e.code === "Period")) {
        e.preventDefault();
        rotateRef.current((e.code === "Comma" || e.key === "," ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
        return;
      }
      if (e.altKey && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3")) {
        e.preventDefault();
        endRef.current(e.code === "Digit1" ? "a" : e.code === "Digit2" ? "b" : "both");
        return;
      }
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
        setLineDraft({ px: [], id: null });
        setPickKit(null);
        setCropping(false);
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
    setSel(lm);
  };

  const onVideoClick = (e: React.MouseEvent) => {
    if (pickKit && videoRef.current) {
      const r = sampleShirt(videoRef.current, e.clientX, e.clientY);
      if ("error" in r) return setKitMsg(r.error);
      kits.setColors({ ...kits.colors, [pickKit]: r.hex });
      setPickKit(null);
      setKitMsg(null);
      return;
    }
    const px = toPixels(e);
    if (!px || stale) return;
    videoRef.current?.pause();
    if (tool === "lines") return addLineClick(px);
    if (tool === "arcs") {
      setPointsFrame(frame);
      return setArcs((as) =>
        as.some((a) => a.arc_id === arcId) ? as.map((a) => (a.arc_id === arcId ? { ...a, pts: [...a.pts, px] } : a)) : [...as, { arc_id: arcId, pts: [px] }],
      );
    }
    if (pendingLm) addPair(pendingLm, px);
    else setPendingPx(px);
  };

  // Lines: two clicks on the video along a visible line and the line of the model (in either order).
  const commitLine = (id: string, a: Pt, b: Pt) => {
    setLines((ls) => [...ls.filter((l) => l.line_id !== id), { line_id: id, a, b }]);
    setLineDraft({ px: [], id: null });
  };
  const addLineClick = (px: Pt) => {
    setPointsFrame(frame);
    const clicks = lineDraft.px.length >= 2 ? [px] : [...lineDraft.px, px];
    if (clicks.length === 2 && lineDraft.id) return commitLine(lineDraft.id, clicks[0], clicks[1]);
    setLineDraft({ px: clicks, id: lineDraft.id });
  };
  const onModelLineClick = (id: string) => {
    if (stale) return;
    if (lineDraft.px.length === 2) return commitLine(id, lineDraft.px[0], lineDraft.px[1]);
    setLineDraft((d) => ({ ...d, id: d.id === id ? null : id }));
  };

  const onLandmarkClick = (id: string) => {
    if (stale) return;
    if (pendingPx) addPair(id, pendingPx);
    else setPendingLm(id === pendingLm ? null : id);
  };

  // Worn paint: a view with more contrast and no colour, on the video and in the magnifier, makes pale lines stand out.
  const enhance = usePref("calib:enhance", "0") === "1";
  const enhanceRef = useRef(enhance);
  useEffect(() => {
    enhanceRef.current = enhance;
  }, [enhance]);
  const drawLoupe = useCallback((px: Pt | null, seg: [Pt, Pt] | null = null) => {
    const c = loupeRef.current;
    const v = videoRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !v || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!px) return;
    const sw = c.width / 8;
    const sh = c.height / 8;
    ctx.imageSmoothingEnabled = false;
    ctx.filter = enhanceRef.current ? ENHANCE_FILTER : "none";
    ctx.drawImage(v, px[0] - sw / 2, px[1] - sh / 2, sw, sh, 0, 0, c.width, c.height);
    ctx.filter = "none";
    ctx.strokeStyle = "#f43f5e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c.width / 2, 0);
    ctx.lineTo(c.width / 2, c.height);
    ctx.moveTo(0, c.height / 2);
    ctx.lineTo(c.width, c.height / 2);
    ctx.stroke();
    // The marked line being adjusted, across the whole magnifier, to lay it on the paint.
    if (seg) {
      const to = (q: Pt): Pt => [((q[0] - (px[0] - sw / 2)) * c.width) / sw, ((q[1] - (px[1] - sh / 2)) * c.height) / sh];
      const [a, b] = [to(seg[0]), to(seg[1])];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const k = (c.width + c.height) / len;
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a[0] - dx * k, a[1] - dy * k);
      ctx.lineTo(b[0] + dx * k, b[1] + dy * k);
      ctx.stroke();
      for (const q of [a, b]) {
        ctx.beginPath();
        ctx.arc(q[0], q[1], 4, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
  }, []);

  const selSeg: [Pt, Pt] | null = selLineObj ? [selLineObj.a, selLineObj.b] : null;
  const onVideoMove = (e: React.MouseEvent) => {
    const px = toPixels(e);
    setHover(px);
    drawLoupe(px, selSeg);
  };

  const fit = useMemo(() => {
    const pairs = allPoints.flatMap((p) => {
      const lm = byId.get(p.landmark_id);
      return lm ? [{ p, lm }] : [];
    });
    const src = pairs.map(({ p }) => [p.px, p.py] as Pt);
    const dst = pairs.map(({ lm }) => [lm.x, lm.y] as Pt);
    const plain = fitHomography(src, dst);
    const arcInput: ArcInput[] = arcs.flatMap((a) => (circles[a.arc_id] && a.pts.length >= ARC_MIN ? [{ pts: a.pts, c: circles[a.arc_id]!.c, r: circles[a.arc_id]!.r }] : []));
    if (arcInput.length === 0) {
      const Hinv = plain ? invertFor(plain, dst) : null;
      return { pairs, H: plain, Hinv, quality: plain ? fitQuality(plain, src, dst) : null, hybrid: null };
    }
    // With circles: one fit of the clicked points, every click of the marked lines and every click on the arcs.
    const clicked = pairs.filter(({ p }) => !p.landmark_id.startsWith(IX));
    const lineInput = lines.flatMap((l) => {
      const m = modelLines.find((x) => x.id === l.line_id);
      return m ? [{ pts: [l.a, l.b] as Pt[], ma: m.a, mb: m.b }] : [];
    });
    const hybrid = fitHybrid(
      { points: clicked.map(({ p, lm }) => ({ px: [p.px, p.py] as Pt, m: [lm.x, lm.y] as Pt })), lines: lineInput, arcs: arcInput },
      plain,
    );
    if (!hybrid) return { pairs, H: null, Hinv: null, quality: null, hybrid: null };
    const H = hybrid.H;
    const residuals = pairs.map(({ p, lm }) => {
      const m = apply(H, [p.px, p.py]);
      return m ? Math.hypot(m[0] - lm.x, m[1] - lm.y) : Infinity;
    });
    // How much of each circle the clicks cover (degrees on the model): a short arc fits well and can still be off.
    const spans = arcInput.map((a) => {
      const ang = a.pts.flatMap((q) => {
        const m = apply(H, q);
        return m ? [Math.atan2(m[1] - a.c[1], m[0] - a.c[0])] : [];
      }).sort((x, y) => x - y);
      if (ang.length < 2) return 0;
      let gap = 2 * Math.PI - (ang[ang.length - 1] - ang[0]);
      for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
      return ((2 * Math.PI - gap) * 180) / Math.PI;
    });
    const all = [...dst, ...arcInput.flatMap((a) => [a.c])];
    return {
      pairs,
      H,
      Hinv: invertFor(H, all),
      quality: { residuals, rms: hybrid.rms, leaveOneOut: pairs.map((): number | null => null) },
      hybrid: { ...hybrid, spans, input: { lines: lineInput, arcs: arcInput } },
    };
  }, [allPoints, byId, arcs, circles, lines, modelLines]);
  // What an anchor saves: the points, plus each click of the arcs and lines as a point on its circle or line, so that
  // Python (which only reads points) uses the same fit.
  const anchorPoints = useMemo(() => {
    if (!fit.hybrid || !fit.H) return allPoints;
    const H = fit.H;
    const extra = constraintPoints(H, fit.hybrid.input).map((c, i) => ({
      landmark_id: `${c.kind === "arc" ? "arc" : "ln"}:${c.kind === "arc" ? arcs.filter((a) => a.pts.length >= ARC_MIN)[c.index]?.arc_id : (lines[c.index]?.line_id ?? c.index)}:${i}`,
      px: c.px[0],
      py: c.px[1],
      x_m: c.m[0],
      y_m: c.m[1],
    }));
    return [...allPoints, ...extra];
  }, [fit, allPoints, arcs, lines]);

  const projected = useMemo(
    () => (fit.Hinv && dims ? projectLines(venue, fit.Hinv, dims.w, dims.h) : []),
    [fit.Hinv, dims, venue],
  );

  useEffect(() => {
    if (hover) return;
    if (selLineObj && selLine) {
      const c: Pt =
        selLine.end === "a" ? selLineObj.a : selLine.end === "b" ? selLineObj.b : [(selLineObj.a[0] + selLineObj.b[0]) / 2, (selLineObj.a[1] + selLineObj.b[1]) / 2];
      drawLoupe(c, [selLineObj.a, selLineObj.b]);
    } else if (selPoint) drawLoupe([selPoint.px, selPoint.py]);
  }, [hover, selPoint, selLineObj, selLine, time, drawLoupe]);

  // Propagated calibration of the frame on screen, used wherever this frame has no points of its own. Only some frames
  // are calibrated (1 of every `stride`); in between, the two around it are blended, so the drawing does not blink.
  const trackKeys = useMemo(() => (track ? [...track.frames.keys()].sort((a, b) => a - b) : []), [track]);
  const tf = (() => {
    if (!track) return null;
    const exact = track.frames.get(frame);
    if (exact) return exact;
    let lo = 0;
    let hi = trackKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (trackKeys[mid] < frame) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0 || lo === trackKeys.length) return null;
    const a = track.frames.get(trackKeys[lo - 1]);
    const b = track.frames.get(trackKeys[lo]);
    // More than a second and a half apart: a hole in the calibration, shown as such.
    if (!a?.H || !b?.H || trackKeys[lo] - trackKeys[lo - 1] > fps * 1.5) return null;
    const H = lerpHomography(a.H, b.H, (frame - trackKeys[lo - 1]) / (trackKeys[lo] - trackKeys[lo - 1]));
    const near = frame - trackKeys[lo - 1] <= trackKeys[lo] - frame ? a : b;
    return H ? { ...near, H, dis: a.dis !== null && b.dis !== null ? Math.max(a.dis, b.dis) : (a.dis ?? b.dis) } : null;
  })();
  const trackRaw = (points.length === 0 || stale) && tf?.H ? tf.H : null;
  // Not memoised: while a track is loaded the matrix changes on every frame anyway.
  const trackInv = trackRaw && dims ? invert(trackRaw) : null;
  const trackLines =
    trackInv && dims ? projectLines(venue, orient(trackInv, [[venue.length_m / 2, venue.width_m / 2]]) ?? trackInv, dims.w, dims.h) : [];
  const trackH = trackRaw && dims ? (orient(trackRaw, [[dims.w / 2, dims.h * 0.8]]) ?? trackRaw) : null;
  const posH = !stale && fit.H ? fit.H : trackH;

  // Check of the loaded calibration against hand-marked points: where it puts each marked pixel, compared with where
  // that landmark really is. Works from the first point; it does not need a fit of its own.
  const trackAtPoints = !stale && pointsFrame !== null ? (track?.frames.get(pointsFrame) ?? null) : null;
  const trackCheck =
    trackAtPoints?.H && dims
      ? allPoints.flatMap((q) => {
          const lm = byId.get(q.landmark_id);
          const H = orient(trackAtPoints.H as number[], [[dims.w / 2, dims.h * 0.8]]) ?? (trackAtPoints.H as number[]);
          const m = apply(H, [q.px, q.py]);
          return lm && m ? [{ id: q.landmark_id, label: lm.label, err: Math.hypot(m[0] - lm.x, m[1] - lm.y) }] : [];
        })
      : [];
  const trackCheckMean = trackCheck.length ? trackCheck.reduce((a, c) => a + c.err, 0) / trackCheck.length : null;
  const trackCheckMax = trackCheck.length ? Math.max(...trackCheck.map((c) => c.err)) : null;

  // Boxes of the processed frame nearest to the one on screen (only 1 of every `stride` frames is processed).
  const detFrame = dets ? dets.start + Math.round((frame - dets.start) / dets.stride) * dets.stride : null;
  const boxes = dets && detFrame !== null && Math.abs(detFrame - frame) <= dets.stride ? (dets.frames.get(detFrame) ?? null) : null;

  const onDetsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.kind !== "tracks_px" || !Array.isArray(d.frames)) throw new Error("formato");
      setDets({
        name: f.name,
        start: d.start_frame,
        end: d.end_frame,
        stride: d.stride || 1,
        frames: new Map(d.frames.map((r: { frame: number; boxes: DetBox[] }) => [r.frame, r.boxes])),
        hasPositions: Array.isArray(d.box_columns) && d.box_columns.includes("on_pitch"),
        quality: d.quality ?? {},
      });
      setDetsMsg(d.match_id !== matchId || d.video_id !== videoId ? `Ojo: el archivo es de ${d.match_id} · ${d.video_id}.` : "");
      seekFrame(d.start_frame);
    } catch {
      setDets(null);
      setDetsMsg("Ese archivo no es una parte de detecciones (se espera tracks_<video>_<inicio>_<fin>.json).");
    }
  };

  const onTrackFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      // A part written by `process` holds the calibration of each processed frame next to its detections.
      const fromTracks = d.kind === "tracks_px" && Array.isArray(d.frames) && d.frames.some((r: { H?: unknown }) => Array.isArray(r.H));
      if (!fromTracks && (d.kind !== "calib_track" || !Array.isArray(d.frames))) throw new Error("formato");
      const frames: CalibTrack["frames"] = new Map();
      let sum = 0;
      let n = 0;
      let worst: CalibTrack["worst"] = null;
      for (const r of d.frames) {
        const dis = typeof r.disagreement_m === "number" ? r.disagreement_m : null;
        frames.set(r.frame, { H: Array.isArray(r.H) && r.H.length === 9 ? r.H : null, source: fromTracks ? "library" : String(r.source), dis });
        if (dis !== null && r.source === "propagated") {
          sum += dis;
          n++;
          if (!worst || dis > worst.dis) worst = { frame: r.frame, dis };
        }
      }
      const worstList: CalibTrack["worstList"] = [];
      for (const [fr, v] of [...frames.entries()].filter(([, v]) => v.source === "propagated" && v.dis !== null && v.dis > WARN_M).sort((a, b) => (b[1].dis as number) - (a[1].dis as number))) {
        if (worstList.length >= 6) break;
        if (worstList.every((w) => Math.abs(w.frame - fr) > fps)) worstList.push({ frame: fr, dis: v.dis as number });
      }
      setTrack({ name: f.name, start: d.start_frame, end: d.end_frame, frames, check: Array.isArray(d.check) ? d.check : [], meanDis: n ? sum / n : null, worst, worstList });
      seekFrame(d.start_frame);
      setTrackMsg(
        d.match_id !== matchId || d.video_id !== videoId
          ? `Ojo: el archivo es de ${d.match_id} · ${d.video_id}, y aquí está abierto ${matchId} · ${videoId}.`
          : "",
      );
    } catch {
      setTrack(null);
      setTrackMsg("Ese archivo no trae calibración (se espera un calib_….json, o un tracks_….json escrito por sportsan.tracking.process).");
    }
  };

  const hoverM = hover && posH ? apply(posH, hover) : null;
  const hoverN = hoverM ? toNormalized(venue, hoverM) : null;
  const looValues = fit.quality?.leaveOneOut.filter((v): v is number => v !== null) ?? [];
  const looMax = looValues.length ? Math.max(...looValues) : null;

  const anchors = state.anchors
    .filter((a) => a.match_id === matchId && a.video_id === videoId)
    .sort((a, b) => a.frame - b.frame);

  const reset = () => {
    setPoints([]);
    setLines([]);
    setArcs([]);
    setLineDraft({ px: [], id: null });
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
      points: anchorPoints,
      ...(lines.length ? { lines } : {}),
      ...(arcs.length ? { arcs } : {}),
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
    setPoints(
      a.lines?.length || a.arcs?.length ? a.points.filter((q) => !q.landmark_id.startsWith(IX) && !q.landmark_id.startsWith("arc:") && !q.landmark_id.startsWith("ln:")) : a.points,
    );
    setLines(a.lines ?? []);
    setArcs(a.arcs ?? []);
    setLineDraft({ px: [], id: null });
    setPointsFrame(a.frame);
    setPendingPx(null);
    setPendingLm(null);
    seekFrame(a.frame);
  };

  // Inside a match, its video (and its exact fps, from match.yaml) are read from its folder without asking.
  useEffect(() => {
    if (!embedded || !folder || fileUrl) return;
    let live = true;
    void localVideo(folder, videoId).then((url) => {
      if (live && url) setFileUrl(url);
    });
    return () => {
      live = false;
    };
  }, [embedded, folder, videoId, fileUrl]);
  // The exact fps of the video, from match.yaml, whatever way the video was opened.
  const yamlFolder = folder || matchId;
  useEffect(() => {
    if (!yamlFolder) return;
    let live = true;
    void readLocal(`matches/${yamlFolder}/match.yaml`).then((yaml) => {
      const m = yaml?.match(new RegExp(`video_id:\\s*${videoId}\\b[\\s\\S]*?\\bfps:\\s*([\\d.]+)`));
      if (!live || !m) return;
      setFps(Number(m[1]));
      setFpsFrom("yaml");
    });
    return () => {
      live = false;
    };
  }, [yamlFolder, videoId]);
  // Zones of the image that are neither pitch nor fixed background (scoreboard, channel logo): `mask` of this video in
  // match.yaml. Calibration (library, propagation) and detection do not look there.
  const [maskRects, setMaskRects] = useState<[number, number, number, number][]>([]);
  const [maskEdit, setMaskEdit] = useState(false);
  const [maskDraft, setMaskDraft] = useState<[Pt, Pt] | null>(null);
  const [maskMsg, setMaskMsg] = useState("");
  useEffect(() => {
    if (!yamlFolder) return;
    let live = true;
    void readLocal(`matches/${yamlFolder}/match.yaml`).then((yaml) => {
      if (live && yaml) setMaskRects(readVideoMask(yaml, videoId));
    });
    return () => {
      live = false;
    };
  }, [yamlFolder, videoId]);
  const saveMask = async () => {
    const path = `matches/${yamlFolder}/match.yaml`;
    const yaml = await readLocal(path);
    const next = yaml !== null ? writeVideoMask(yaml, videoId, maskRects) : null;
    if (next === null) return setMaskMsg("No encuentro este video en match.yaml.");
    const ok = await writeLocal(path, next);
    setMaskMsg(ok ? `Guardado en match.yaml (${maskRects.length} zona${maskRects.length === 1 ? "" : "s"}). Reconstruye la biblioteca para que la use.` : "No se pudo escribir match.yaml.");
  };
  // Anchors saved while the fps was another: their frame is taken again from their time (what was on screen), once.
  useEffect(() => {
    if (fpsFrom !== "yaml") return;
    const off = (a: CalibAnchor) => a.match_id === matchId && a.video_id === videoId && Math.abs(Math.round(a.t_video * fps) - a.frame) > 1;
    if (!state.anchors.some(off)) return;
    mutate((s) => ({ ...s, anchors: s.anchors.map((a) => (off(a) ? { ...a, frame: Math.round(a.t_video * fps) } : a)) }));
  }, [fpsFrom, fps, matchId, videoId, state.anchors]);
  const [savedMsg, setSavedMsg] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Anchors go into the match folder, where propagate finds them; a download only if that cannot be written.
  const saveAnchorsFile = (name: string, text: string, mime: string) => {
    void writeLocal(`matches/${matchId}/tracking/${name}`, text).then((ok) => {
      if (!ok) downloadText(name, text, mime);
      setSavedMsg(ok ? `Guardado en matches/${matchId}/tracking/${name}.` : `Descargado: ponlo en matches/${matchId}/tracking/.`);
    });
  };
  const propagateCmd = `python -m sportsan.tracking.propagate --anchors matches/${matchId}/tracking/anchors_${matchId}_${videoId}.json`;

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
  const saved =
    pointsFrame !== null && anchors.some((a) => a.frame === pointsFrame && (a.points === anchorPoints || JSON.stringify(a.points) === JSON.stringify(anchorPoints)));
  const currentAnchor = pointsFrame !== null ? (anchors.find((a) => a.frame === pointsFrame) ?? null) : null;

  // Fit error of a saved anchor (RMS of its own points), for the list.
  const anchorRms = (a: CalibAnchor) => {
    const lms = landmarksWith(venues.find((v) => v.venue_id === a.venue_id) ?? venue, a.lines);
    const pr = a.points.flatMap((q) => {
      if (q.x_m !== undefined && q.y_m !== undefined) return [{ s: [q.px, q.py] as Pt, d: [q.x_m, q.y_m] as Pt }];
      const l = lms.get(q.landmark_id);
      return l ? [{ s: [q.px, q.py] as Pt, d: [l.x, l.y] as Pt }] : [];
    });
    const H = fitHomography(
      pr.map((x) => x.s),
      pr.map((x) => x.d),
    );
    return H
      ? fitQuality(
          H,
          pr.map((x) => x.s),
          pr.map((x) => x.d),
        ).rms
      : null;
  };
  const exportAnchors = () =>
    saveAnchorsFile(
      `anchors_${matchId}_${videoId}.json`,
      JSON.stringify(
        {
          schema_version: 2,
          match_id: matchId,
          video_id: videoId,
          fps,
          venue: { venue_id: venue.venue_id, name: venue.name, length_m: venue.length_m, width_m: venue.width_m },
          anchors: anchors.map((a) => {
            const lms = landmarksWith(venues.find((v) => v.venue_id === a.venue_id) ?? venue, a.lines);
            return {
              ...a,
              points: a.points.flatMap((q) => {
                if (q.x_m !== undefined && q.y_m !== undefined) return [q];
                const l = lms.get(q.landmark_id);
                return l ? [{ ...q, x_m: l.x, y_m: l.y }] : [];
              }),
            };
          }),
        },
        null,
        1,
      ),
      "application/json",
    );

  // One picker for everything computed: a calib_… (calibration only) or a tracks_… (players and their calibration).
  const onPreview = (f: File) => {
    void onTrackFile(asEvent([f]));
    if (f.name.startsWith("tracks_")) {
      void onDetsFile(asEvent([f]));
      setShow("players");
    } else {
      setDets(null);
      setDetsMsg("");
    }
  };
  const clearPreview = () => {
    setTrack(null);
    setDets(null);
    setTrackMsg("");
    setDetsMsg("");
  };
  // Verify → calibrate on the frame on screen: a new anchor where the calibration fails.
  const fixHere = () => {
    videoRef.current?.pause();
    reset();
    setMode("calibrar");
  };

  const dragSide = (e: React.PointerEvent<HTMLElement>) => {
    const x0 = e.clientX;
    const w0 = sideW;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setPref("calib:sideW", String(Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w0 - (ev.clientX - x0))))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // Crop: the edges of the image are dragged on the video while choosing it; kept per video.
  const dragCrop = (e: React.PointerEvent<HTMLElement>, edge: "top" | "bottom") => {
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    const base: [number, number] = [cropTopPref, cropBottomPref];
    const y0 = e.clientY;
    let last = base;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const y = (edge === "top" ? base[0] * box.height : box.height - base[1] * box.height) + (ev.clientY - y0);
      last = edge === "top" ? [Math.min(0.45, Math.max(0, y / box.height)), base[1]] : [base[0], Math.min(0.3, Math.max(0, 1 - y / box.height))];
      setCropDraft(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setPref(cropKey, `${last[0].toFixed(3)},${last[1].toFixed(3)}`);
      setCropDraft(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const selIdx = selPoint ? points.findIndex((q) => q.landmark_id === selPoint.landmark_id) : -1;
  const selErr = (() => {
    const i = fit.pairs.findIndex((x) => x.p.landmark_id === sel);
    return i >= 0 ? fit.quality?.residuals[i] : undefined;
  })();
  const showBoxes = mode === "verificar" && show === "players";
  // Runs of frames of the loaded calibration that read alike, for the strip under the video in Verificar.
  const qRuns = useMemo(() => {
    if (!track) return [];
    const runs: { a: number; b: number; c: QClass }[] = [];
    for (const f of [...track.frames.keys()].sort((x, y) => x - y)) {
      const v = track.frames.get(f);
      if (!v) continue;
      const c: QClass = !v.H ? "none" : v.source === "anchor" ? "anchor" : v.dis === null || v.dis <= WARN_M ? "ok" : v.dis <= 3 ? "warn" : "bad";
      const last = runs[runs.length - 1];
      if (last && last.c === c && f - last.b <= 10) last.b = f + 1;
      else runs.push({ a: f, b: f + 1, c });
    }
    return runs;
  }, [track]);

  if (!hydrated) return null;

  const anchorsMenu = (
    <Dropdown
      label="Anclas guardadas de este video"
      triggerClass="btn"
      panelClass="w-80 !right-auto left-0"
      trigger={
        <span className="inline-flex items-center gap-2">
          <Anchor size={15} />
          {currentAnchor ? <span className="tc">{fmtT(currentAnchor.t_video)}</span> : "Anclas"}
          <span className="tc text-xs text-faint">{anchors.length}</span>
          <CaretDown size={12} className="text-faint" />
        </span>
      }
    >
      {(close) => (
        <div className="p-1.5">
          {anchors.length === 0 ? (
            <p className="px-3 py-2 text-xs text-faint">Aún no hay anclas en este video.</p>
          ) : (
            <ul className="max-h-72 overflow-auto">
              {anchors.map((a) => {
                const r = anchorRms(a);
                const on = a.frame === pointsFrame;
                return (
                  <li key={a.anchor_id} className={`flex items-center rounded-lg pr-1 transition-colors ${on ? "bg-line-strong" : "hover:bg-line-strong"}`}>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-sm"
                      onClick={() => {
                        loadAnchor(a);
                        close();
                      }}
                    >
                      <span className="tc text-ink">{fmtT(a.t_video)}</span>
                      <span className="text-xs text-faint">{a.points.length} puntos</span>
                      <span className={`tc ml-auto text-xs ${r !== null && r > WARN_M ? "text-warn" : "text-ink-2"}`} title="Error de ajuste (RMS)">
                        {r === null ? "—" : `${r.toFixed(2)} m`}
                      </span>
                    </button>
                    <IconButton label="Borrar esta ancla" tone="danger" onClick={() => mutate((s) => ({ ...s, anchors: s.anchors.filter((x) => x.anchor_id !== a.anchor_id) }))}>
                      <Trash size={13} />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-1 border-t border-line pt-1">
            <MenuItem
              icon={<Plus size={14} />}
              onClick={() => {
                reset();
                close();
              }}
            >
              Nueva ancla en este cuadro
            </MenuItem>
            {anchors.length > 0 && (
              <MenuItem
                icon={<DownloadSimple size={14} />}
                onClick={() => {
                  exportAnchors();
                  close();
                }}
              >
                Exportar anclas (para propagar)
              </MenuItem>
            )}
          </div>
        </div>
      )}
    </Dropdown>
  );

  return (
    <>
      {!embedded && (
        <PageHeader
          eyebrow="Calibración de cancha"
          title={
            <>
              {matchId || "Sin partido"} <span className="text-faint">· {videoId || "video"}</span>
            </>
          }
        />
      )}

      {/* One bar: the mode, then what that mode opens (anchors to edit, or a computed file to look at). */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="seg" role="group" aria-label="Modo de la calibración">
          {(
            [
              ["calibrar", "Calibrar", Crosshair],
              ["verificar", "Verificar", CheckCircle],
            ] as const
          ).map(([m, name, Icon]) => (
            <button key={m} type="button" aria-pressed={mode === m} className="seg-opt inline-flex items-center gap-1.5" onClick={() => setMode(m)}>
              <Icon size={14} />
              {name}
            </button>
          ))}
        </div>
        {mode === "calibrar" ? (
          <>
            {anchorsMenu}
            {fpsFrom !== "yaml" && (
              <button
                type="button"
                className="tag tag-warn"
                onClick={() => setShowSettings(true)}
                title="Las anclas guardan el número de cuadro calculado con este fps. Si no es el del video, quedan corridas en el tiempo y la propagación sale mal. Ponlo en match.yaml (ffprobe) o escríbelo en «Video y sede»."
              >
                <Warning size={12} /> {Math.round(fps * 1000) / 1000} fps sin confirmar
              </button>
            )}
            {noVenue && (
              <span className="tag tag-warn inline-flex items-center gap-1.5" title="La sede se elige en los datos del partido (engrane de la barra superior)">
                <Warning size={13} />
                Sin sede: se usa {venue.name}
              </span>
            )}
            {savedMsg && <span className="text-xs text-ok">{savedMsg}</span>}
          </>
        ) : (
          <>
            <FilePicker
              dir={`matches/${matchId}/tracking`}
              pattern={new RegExp(`^(calib|tracks)_${videoId}_\\d+_\\d+\\.json$`)}
              describe={(n) => `${partLabel(n.replace(/^revision\//, ""), fps)} · ${n.startsWith("revision/") ? "revisión de la biblioteca" : n.startsWith("calib_") ? "calibración" : "tracking"}`}
              subdirs={["revision"]}
              label="Previsualizar"
              icon={<Eye size={15} />}
              primary={!track && !dets}
              title="Una calibración (calib_…) o una parte procesada (tracks_…)"
              current={dets?.name ?? track?.name}
              onFile={onPreview}
            />
            {dets && (
              <div className="seg" role="group" aria-label="Qué se ve">
                {(
                  [
                    ["players", "Jugadoras"],
                    ["calib", "Solo calibración"],
                  ] as const
                ).map(([v, name]) => (
                  <button key={v} type="button" aria-pressed={show === v} className="seg-opt" onClick={() => setShow(v)}>
                    {name}
                  </button>
                ))}
              </div>
            )}
            {(track || dets) && (
              <IconButton label="Quitar la previsualización" onClick={clearPreview}>
                <X size={15} />
              </IconButton>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          {!embedded && (
            <IconButton label="Video y sede" onClick={() => setShowSettings(true)}>
              <GearSix size={16} />
            </IconButton>
          )}
          <IconButton label="Comandos de Python" onClick={() => setShowCommands(true)}>
            <TerminalWindow size={16} />
          </IconButton>
        </span>
      </div>
      {mode === "verificar" && (trackMsg || detsMsg) && <p className="mb-3 text-xs text-warn">{trackMsg || detsMsg}</p>}
      {showCommands && (
        <Modal title="Comandos de Python" onClose={() => setShowCommands(false)} wide>
          <div className="space-y-5 text-xs text-pretty text-muted">
            <p>Desde la carpeta <code>demo</code>, con .venv activado.</p>
            <section>
              <h3 className="mb-1 text-sm text-ink">1. Propagar las anclas del barrido</h3>
              <p>Con dos o más anclas guardadas y exportadas. Escribe <code>calib_…json</code> en <code>tracking/</code>: ábrelo en Verificar › Previsualizar; la rejilla punteada es la propagada.</p>
              <Command className="mt-2">{propagateCmd}</Command>
            </section>
            <section>
              <h3 className="mb-1 text-sm text-ink">2. Biblioteca del video</h3>
              <p>Con la calibración del barrido. Sirve de referencia para el resto del video mientras la cámara no cambie de sitio; <code>locate</code> calibra una jugada sin anclas a mano.</p>
              <Command className="mt-2">{`python -m sportsan.tracking.library build --track matches/${matchId}/tracking/calib_${videoId}_<inicio>_<fin>.json
python -m sportsan.tracking.library locate --match ${matchId} --video ${videoId} --start 0:33:20 --end 0:33:35`}</Command>
            </section>
            <section>
              <h3 className="mb-1 text-sm text-ink">3. Detección y posiciones</h3>
              <p>Une la detección con la biblioteca y da la posición en la cancha; reanudable por partes. Cada parte que termina se revisa en Verificar › Previsualizar.</p>
              <Command className="mt-2">{`python -m sportsan.tracking.process --match ${matchId} --video ${videoId} --benchmark
python -m sportsan.tracking.process --match ${matchId} --video ${videoId}`}</Command>
            </section>
            <section>
              <h3 className="mb-1 text-sm text-ink">Todo de una vez, de noche</h3>
              <p>Los tres pasos para todos los videos del partido a los que les falten.</p>
              <Command className="mt-2">{`python -m sportsan.tracking.overnight --plan --match ${matchId}
python -m sportsan.tracking.overnight --match ${matchId}`}</Command>
            </section>
          </div>
        </Modal>
      )}
      {showSettings && !embedded && (
        <Modal title="Video y sede" onClose={() => setShowSettings(false)}>
          <div className="flex flex-col gap-4 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Archivo de video (no sale de esta computadora)</span>
              <span className={`${btn} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
                <FolderOpen size={15} />
                {fileUrl ? "Cambiar archivo" : "Elegir archivo"}
                <input type="file" accept="video/*" onChange={onFile} className="sr-only" />
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Partido (match_id)</span>
              <input className={input} value={matchId} onChange={(e) => setMatchId(e.target.value.trim())} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Video</span>
              <input className={`${input} w-20`} value={videoId} onChange={(e) => setVideoId(e.target.value.trim())} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Cuadros por segundo</span>
              <input
                className={`${input} w-28`}
                type="number"
                step="any"
                min={1}
                value={fps}
                onChange={(e) => {
                  setFps(Math.max(1, Number(e.target.value) || 1));
                  setFpsFrom("manual");
                }}
              />
              <span className={`text-[11px] ${fpsFrom === "yaml" ? "text-faint" : "text-warn"}`}>
                {fpsFrom === "yaml" ? "de match.yaml" : fpsFrom === "manual" ? "escrito a mano" : "sin confirmar: 29.97 por defecto"}
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Sede</span>
              <select className={input} value={venueId} onChange={(e) => setVenueId(e.target.value)}>
                {venues.map((v) => (
                  <option key={v.venue_id} value={v.venue_id}>
                    {v.name} ({v.length_m} x {v.width_m} m)
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Modal>
      )}

      <div ref={fitRef} className="grid gap-5 xl:-mb-12 xl:grid-cols-[minmax(0,1fr)_var(--side-w)]" style={{ "--side-w": `${sideW}px` } as React.CSSProperties}>
        <div ref={setColEl} className="min-w-0 space-y-4 self-start">
          <Card>
            {!fileUrl ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="flex-1 text-sm text-muted">
                  No encontré <code>matches/{matchId}/video/{videoId}.mp4</code>. Aquí hace falta el archivo y no YouTube, para avanzar cuadro por cuadro.
                </p>
                <label className={`${btnPrimary} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
                  <FolderOpen size={15} />
                  Abrir video
                  <input type="file" accept="video/*" onChange={onFile} className="sr-only" />
                </label>
              </div>
            ) : (
              <>
                <div
                  ref={setStageEl}
                  className="relative mx-auto overflow-hidden rounded-2xl bg-black"
                  style={{
                    ...(fitH && colH ? { maxWidth: Math.max(320, Math.floor((fitH - (colH - stageH)) * (dims ? dims.w / (dims.h * (1 - cropTop - cropBottom)) : 16 / 9))) } : {}),
                    ...(dims && (cropTop || cropBottom) ? { aspectRatio: `${dims.w} / ${dims.h * (1 - cropTop - cropBottom)}` } : {}),
                  }}
                >
                  {/* What is shown: the frame less its crop (the image moves up inside the stage). */}
                  <div className="relative" style={dims && cropTop ? { marginTop: `${-cropTop * (dims.h / dims.w) * 100}%` } : undefined}>
                  <video
                    ref={videoRef}
                    src={fileUrl}
                    muted
                    playsInline
                    preload="auto"
                    className="block w-full"
                    style={enhance ? { filter: ENHANCE_FILTER } : undefined}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onLoadedMetadata={(e) => setDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight, duration: e.currentTarget.duration })}
                  />
                  {dims && (
                    <svg
                      ref={overlayRef}
                      viewBox={`0 0 ${dims.w} ${dims.h}`}
                      className={`absolute inset-0 h-full w-full ${pickKit ? "cursor-copy" : mode === "verificar" ? "" : stale ? "cursor-not-allowed" : "cursor-crosshair"}`}
                      onClick={(e) => (maskEdit ? undefined : mode === "calibrar" || pickKit ? onVideoClick(e) : undefined)}
                      onPointerDown={(e) => {
                        if (!maskEdit) return;
                        const p0 = toPixels(e);
                        if (!p0) return;
                        // A click inside a zone takes it away; a drag elsewhere draws a new one.
                        const hit = maskRects.findIndex(([x0, y0, x1, y1]) => p0[0] >= x0 && p0[0] <= x1 && p0[1] >= y0 && p0[1] <= y1);
                        if (hit >= 0) return setMaskRects((rs) => rs.filter((_, i) => i !== hit));
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setMaskDraft([p0, p0]);
                      }}
                      onPointerMove={(e) => {
                        if (!maskEdit || !maskDraft) return;
                        const p1 = toPixels(e);
                        if (p1) setMaskDraft([maskDraft[0], p1]);
                      }}
                      onPointerUp={() => {
                        if (!maskDraft) return;
                        const [[ax, ay], [bx, by]] = maskDraft;
                        if (Math.abs(bx - ax) > 6 && Math.abs(by - ay) > 6) setMaskRects((rs) => [...rs, [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]]);
                        setMaskDraft(null);
                      }}
                      onMouseMove={onVideoMove}
                      onMouseLeave={() => {
                        setHover(null);
                        drawLoupe(null);
                      }}
                    >
                      {mode === "calibrar" && (
                        <g opacity={stale ? 0.25 : 1}>
                          {projected.map((l, i) => (
                            <path key={i} d={l.d} fill="none" stroke={OVERLAY[l.group]} strokeWidth={dotR / 3} opacity={0.9} />
                          ))}
                          {points.map((p) => (
                            <g key={p.landmark_id}>
                              <circle cx={p.px} cy={p.py} r={dotR} fill="none" stroke={p.landmark_id === sel ? "#fde047" : "#f43f5e"} strokeWidth={dotR / 3} />
                              <circle cx={p.px} cy={p.py} r={dotR / 5} fill={p.landmark_id === sel ? "#fde047" : "#f43f5e"} />
                            </g>
                          ))}
                          {lines.map((l) => {
                            const k = 8;
                            const dx = l.b[0] - l.a[0];
                            const dy = l.b[1] - l.a[1];
                            return (
                              <g key={l.line_id} pointerEvents="none">
                                <line x1={l.a[0] - dx * k} y1={l.a[1] - dy * k} x2={l.b[0] + dx * k} y2={l.b[1] + dy * k} stroke="#22d3ee" strokeWidth={dotR / 4} strokeDasharray={`${dotR} ${dotR * 0.8}`} opacity={0.7} />
                                <line x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} stroke={selLine?.id === l.line_id ? "#fde047" : "#22d3ee"} strokeWidth={dotR / 2.5} />
                                {[l.a, l.b].map((q, n) => (
                                  <circle
                                    key={n}
                                    cx={q[0]}
                                    cy={q[1]}
                                    r={selLine?.id === l.line_id && (selLine.end === "both" || selLine.end === (n === 0 ? "a" : "b")) ? dotR * 0.8 : dotR / 2.5}
                                    fill={selLine?.id === l.line_id ? "#fde047" : "#22d3ee"}
                                  />
                                ))}
                              </g>
                            );
                          })}
                          {derived.map((d) => (
                            <g key={d.landmark.id} pointerEvents="none">
                              <title>{d.landmark.label}</title>
                              <rect x={d.px - dotR * 0.7} y={d.py - dotR * 0.7} width={dotR * 1.4} height={dotR * 1.4} transform={`rotate(45 ${d.px} ${d.py})`} fill="none" stroke="#22d3ee" strokeWidth={dotR / 3} />
                            </g>
                          ))}
                          {arcs.flatMap((a) =>
                            a.pts.map((q, n) => <circle key={`arc${a.arc_id}${n}`} cx={q[0]} cy={q[1]} r={dotR * 0.45} fill={a.arc_id === arcId && tool === "arcs" ? "#fde047" : "#e879f9"} pointerEvents="none" />),
                          )}
                          {lineDraft.px.map((q, n) => (
                            <circle key={`ld${n}`} cx={q[0]} cy={q[1]} r={dotR * 0.7} fill="none" stroke="#fde047" strokeWidth={dotR / 3} />
                          ))}
                          {lineDraft.px.length === 2 && (
                            <line x1={lineDraft.px[0][0]} y1={lineDraft.px[0][1]} x2={lineDraft.px[1][0]} y2={lineDraft.px[1][1]} stroke="#fde047" strokeWidth={dotR / 3} />
                          )}
                        </g>
                      )}
                      {/* Computed calibration: dashed, so it is never mistaken for a hand-marked one. */}
                      {trackLines.map((l, i) => (
                        <path key={`t${i}`} d={l.d} fill="none" stroke={OVERLAY[l.group]} strokeWidth={dotR / 3} strokeDasharray={`${dotR * 1.5} ${dotR}`} opacity={0.95} />
                      ))}
                      {showBoxes &&
                        boxes?.map((bx) => (
                          // Whoever is off the pitch (bench, stands) stays faint.
                          <g key={bx[0]} pointerEvents="none" opacity={dets?.hasPositions && !bx[11] ? 0.3 : 1}>
                            <rect x={bx[1]} y={bx[2]} width={bx[3] - bx[1]} height={bx[4] - bx[2]} fill="none" stroke={trackColor(bx[0])} strokeWidth={dotR / 4} />
                            <text x={bx[1]} y={bx[2] - dotR / 2} fontSize={dotR * 2.2} fontFamily="var(--font-mono)" fill={trackColor(bx[0])}>
                              {bx[0]}
                            </text>
                          </g>
                        ))}
                      {mode === "calibrar" && pendingPx && <circle cx={pendingPx[0]} cy={pendingPx[1]} r={dotR} fill="none" stroke="#fde047" strokeWidth={dotR / 3} />}
                      {(maskEdit || maskRects.length > 0) &&
                        [...maskRects, ...(maskDraft ? [[Math.min(maskDraft[0][0], maskDraft[1][0]), Math.min(maskDraft[0][1], maskDraft[1][1]), Math.max(maskDraft[0][0], maskDraft[1][0]), Math.max(maskDraft[0][1], maskDraft[1][1])] as [number, number, number, number]] : [])].map(
                          ([x0, y0, x1, y1], i) => (
                            <rect
                              key={`mask${i}`}
                              x={x0}
                              y={y0}
                              width={x1 - x0}
                              height={y1 - y0}
                              fill={maskEdit ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.25)"}
                              stroke="#f43f5e"
                              strokeWidth={dotR / 4}
                              strokeDasharray={`${dotR} ${dotR * 0.6}`}
                              pointerEvents="none"
                            />
                          ),
                        )}
                    </svg>
                  )}
                  </div>
                  {maskEdit && (
                    <div className="absolute inset-x-0 top-2 z-20 flex justify-center">
                      <div className="flex flex-wrap items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs text-white">
                        <span>Arrastra para tapar el marcador o el logo · clic en una zona la quita · {maskRects.length} zona{maskRects.length === 1 ? "" : "s"}</span>
                        <button type="button" className="rounded-full px-2.5 py-0.5 text-white/80 hover:bg-white/10" onClick={() => setMaskEdit(false)}>
                          Cerrar
                        </button>
                        <button type="button" className="rounded-full bg-white px-2.5 py-0.5 font-medium text-black" onClick={() => void saveMask()}>
                          Guardar en match.yaml
                        </button>
                      </div>
                    </div>
                  )}
                  {cropping && dims && (
                    <div className="absolute inset-0 z-20">
                      {/* The bands that will be hidden, each with its edge to drag. */}
                      <div className="absolute inset-x-0 top-0 bg-black/65" style={{ height: `${(cropDraft?.[0] ?? cropTopPref) * 100}%` }} />
                      <div className="absolute inset-x-0 bottom-0 bg-black/65" style={{ height: `${(cropDraft?.[1] ?? cropBottomPref) * 100}%` }} />
                      {(["top", "bottom"] as const).map((edge) => (
                        <div
                          key={edge}
                          role="slider"
                          aria-label={edge === "top" ? "Borde de arriba del recorte" : "Borde de abajo del recorte"}
                          aria-valuenow={Math.round((edge === "top" ? (cropDraft?.[0] ?? cropTopPref) : (cropDraft?.[1] ?? cropBottomPref)) * 100)}
                          tabIndex={0}
                          className="group absolute inset-x-0 -my-2.5 flex h-5 cursor-row-resize touch-none items-center"
                          style={edge === "top" ? { top: `${(cropDraft?.[0] ?? cropTopPref) * 100}%` } : { bottom: `${(cropDraft?.[1] ?? cropBottomPref) * 100}%` }}
                          onPointerDown={(e) => dragCrop(e, edge)}
                        >
                          <span className="h-0.5 w-full bg-own" />
                          <span className={`absolute left-1/2 h-2 w-12 -translate-x-1/2 rounded-full bg-own shadow-lg transition-transform group-hover:scale-110 ${edge === "top" ? "top-3" : "bottom-3"}`} />
                        </div>
                      ))}
                      <div className="absolute inset-x-0 bottom-3 flex justify-center">
                        <span className="flex items-center gap-2 rounded-full bg-black/75 py-1 pr-1 pl-4 text-sm text-white shadow-lg backdrop-blur">
                          Arrastra los bordes azules
                          <button type="button" className="rounded-full px-3 py-1 text-white/80 hover:bg-white/10 hover:text-white" onClick={() => setPref(cropKey, "0,0")}>
                            Sin recorte
                          </button>
                          <button type="button" className="rounded-full bg-white px-3 py-1 font-medium text-black" onClick={() => setCropping(false)}>
                            Listo
                          </button>
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−1 s (⇧ ←)" aria-label="Retroceder 1 segundo" onClick={() => seekFrame(frame - Math.round(fps))}>
                    <Rewind size={16} />
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−1 cuadro (←)" aria-label="Retroceder 1 cuadro" onClick={() => seekFrame(frame - 1)}>
                    <SkipBack size={16} />
                  </button>
                  <button
                    type="button"
                    className={`${btnPrimary} h-10 w-10 !p-0`}
                    title={playing ? "Pausar (espacio)" : "Reproducir (espacio)"}
                    aria-label={playing ? "Pausar" : "Reproducir"}
                    onClick={() => {
                      const v = videoRef.current;
                      if (!v) return;
                      if (v.paused) void v.play();
                      else v.pause();
                    }}
                  >
                    {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 cuadro (→)" aria-label="Avanzar 1 cuadro" onClick={() => seekFrame(frame + 1)}>
                    <SkipForward size={16} />
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 s (⇧ →)" aria-label="Avanzar 1 segundo" onClick={() => seekFrame(frame + Math.round(fps))}>
                    <FastForward size={16} />
                  </button>
                  <span className="tag tc ml-1">
                    {fmtT(time)} · {frame}
                  </span>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const t = parseHms(goTo);
                      if (t !== null) seekFrame(Math.round(t * fps));
                    }}
                  >
                    <input className={`${input} tc w-20`} placeholder="mm:ss" aria-label="Ir a un tiempo del video (mm:ss u h:mm:ss, Enter)" value={goTo} onChange={(e) => setGoTo(e.target.value)} />
                  </form>
                  {trackRaw && tf && (
                    <span className={`tag ${tf.dis !== null && tf.dis > WARN_M ? "tag-warn" : "tag-accent"}`}>
                      {tf.source === "anchor" ? "Ancla" : tf.source === "library" ? "Biblioteca" : "Propagado"}
                      {tf.source === "propagated" && <span className="tc">{tf.dis === null ? " · sin medida" : ` · ${tf.dis.toFixed(2)} m`}</span>}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    {maskMsg && <span className="max-w-[16rem] truncate text-[11px] text-faint" title={maskMsg}>{maskMsg}</span>}
                    <IconButton
                      label={maskEdit ? "Terminar de tapar zonas" : `Tapar zonas que no son cancha (marcador, logo del canal)${maskRects.length ? ` · ${maskRects.length} tapada(s)` : ""}`}
                      tone={maskEdit || maskRects.length ? "accent" : "default"}
                      onClick={() => (setMaskEdit(!maskEdit), setMaskMsg(""))}
                    >
                      <Selection size={16} weight={maskEdit ? "bold" : "regular"} />
                    </IconButton>
                    <IconButton
                      label={enhance ? "Ver el video normal" : "Realzar las líneas: más contraste y sin color, para pintura gastada"}
                      tone={enhance ? "accent" : "default"}
                      onClick={() => setPref("calib:enhance", enhance ? "0" : "1")}
                    >
                      <CircleHalf size={16} weight={enhance ? "fill" : "regular"} />
                    </IconButton>
                    <IconButton
                      label={cropping ? "Terminar el recorte" : cropTopPref || cropBottomPref ? "Recorte del cuadro (cambiar)" : "Recortar el cuadro: ver menos cielo"}
                      tone={cropping || cropTopPref || cropBottomPref ? "accent" : "default"}
                      onClick={() => setCropping(!cropping)}
                    >
                      <Crop size={16} />
                    </IconButton>
                    <span
                      className="grid h-9 w-9 cursor-help place-items-center text-faint"
                      aria-label="Atajos de teclado"
                      title={"← → un cuadro · ⇧ ← → un segundo\nEspacio reproduce o pausa\nAlt + flechas mueve el punto elegido (⇧: diez pasos)\nEsc cancela el punto pendiente"}
                    >
                      <Keyboard size={17} />
                    </span>
                    <SpeedControl rate={rate} onChange={setRate} />
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
                {mode === "verificar" && track && <QualityStrip runs={qRuns} from={track.start} to={track.end} frame={frame} onSeek={seekFrame} />}
              </>
            )}
          </Card>

          {/* Not an error: an anchor belongs to one frame, and the video has moved on from it. */}
          {mode === "calibrar" && stale && (
            <div className="enter flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-accent-900/60 px-4 py-2.5 text-sm shadow-[inset_0_0_0_1px_rgba(74,114,255,.45)]">
              <Info size={17} className="shrink-0 text-accent-300" />
              <p
                className="min-w-0 flex-1 text-accent-100"
                title="Cada ancla se marca completa sobre un solo cuadro, con el video en pausa: la cámara se mueve y los puntos de un cuadro no sirven en otro."
              >
                {saved ? `Ancla del cuadro ${pointsFrame} guardada.` : `Tus ${points.length} punto(s) son del cuadro ${pointsFrame}.`}
              </p>
              {!saved && (
                <button type="button" className={btnPrimary} onClick={() => pointsFrame !== null && seekFrame(pointsFrame)}>
                  Volver al cuadro {pointsFrame}
                </button>
              )}
              <button type="button" className={saved ? btnPrimary : btn} onClick={reset}>
                {saved ? "Nueva ancla aquí" : "Descartar y empezar aquí"}
              </button>
            </div>
          )}

          {mode === "calibrar" && (
            <Card title="Ajuste" note={fit.pairs.length > 0 ? `${fit.pairs.length} punto(s) · mín. 4` : undefined}>
              {trackCheckMean !== null && trackCheckMax !== null && (
                <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-accent-900/40 px-3 py-2 text-xs shadow-[inset_0_0_0_1px_rgba(74,114,255,.35)]">
                  <span className="text-accent-200" title="Dónde pone la calibración cargada cada punto que marcaste, comparado con dónde está de verdad. Incluye el error de tu propio clic.">
                    Calibración cargada en este cuadro
                  </span>
                  <span className={`tc ${trackCheckMean > WARN_M ? "text-warn" : "text-ink"}`}>media {trackCheckMean.toFixed(2)} m</span>
                  <span className={`tc ${trackCheckMax > WARN_M ? "text-warn" : "text-ink-2"}`}>peor {trackCheckMax.toFixed(2)} m</span>
                </div>
              )}
              {fit.hybrid && (
                <p className="mb-3 text-xs text-muted">
                  Con círculo: puntos {fit.hybrid.points.length}, clics de líneas {fit.hybrid.lines.length}, clics de arcos {fit.hybrid.arcs.length} · error de ajuste{" "}
                  <span className="tc text-ink">{fit.hybrid.rms.toFixed(2)} m</span>
                  {fit.hybrid.spans.some((sp) => sp < 120) && <span className="text-warn"> · arco corto</span>}
                </p>
              )}
              {!fit.hybrid && fit.pairs.length < 4 ? (
                <p className="text-sm text-muted">
                  {fit.pairs.length} de 4 puntos. Mejor 6 o más, repartidos entre la banda lejana y la cercana.
                </p>
              ) : !fit.H || !fit.quality ? (
                <p className="text-sm text-warn">No se puede calcular: los puntos están casi alineados o alguno está mal asignado. Añade uno a otra profundidad.</p>
              ) : (
                (() => {
                  const honest = looMax ?? fit.quality.rms;
                  const v = fitVerdict(honest);
                  return (
                    <>
                      <div className="mb-4 grid grid-cols-3 gap-3">
                        <div className="rounded-xl bg-bg/60 px-3 py-2.5">
                          <div className={`cond text-2xl font-bold uppercase ${v.cls}`}>{v.label}</div>
                          <div className="mt-0.5 text-[11px] text-faint">{looMax === null ? "con 5 puntos se mide mejor" : "según el peor punto dejado fuera"}</div>
                        </div>
                        <div className="rounded-xl bg-bg/60 px-3 py-2.5" title="Error de ajuste (RMS) de todos los puntos">
                          <div className="num text-2xl text-ink">
                            {fit.quality.rms.toFixed(2)} <span className="text-sm text-faint">m</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-faint">error de ajuste</div>
                        </div>
                        <div className="rounded-xl bg-bg/60 px-3 py-2.5" title="Recalcula sin cada punto y mide cuánto se aleja: la estimación honesta del error">
                          <div className={`num text-2xl ${looMax !== null && looMax > WARN_M ? "text-warn" : "text-ink-2"}`}>
                            {looMax === null ? "–" : looMax.toFixed(2)} {looMax !== null && <span className="text-sm text-faint">m</span>}
                          </div>
                          <div className="mt-0.5 text-[11px] text-faint">dejando uno fuera</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_3.5rem_1.75rem] items-center gap-x-3 px-2 pb-1 text-[11px] text-faint">
                        <span>Punto</span>
                        <span>Ajuste</span>
                        <span className="text-right">Fuera</span>
                        <span />
                      </div>
                      <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                        {fit.pairs.map(({ p, lm }, i) => {
                          const r = fit.quality?.residuals[i] ?? 0;
                          const loo = fit.quality?.leaveOneOut[i] ?? null;
                          const bad = (loo ?? r) > WARN_M;
                          const on = p.landmark_id === sel;
                          return (
                            <li
                              key={p.landmark_id}
                              className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_7.5rem_3.5rem_1.75rem] items-center gap-x-3 rounded-lg px-2 py-1 text-xs transition-colors ${
                                on ? "bg-raised shadow-[inset_2px_0_0_var(--color-accent)]" : "hover:bg-raised/60"
                              }`}
                              onClick={() => setSel(p.landmark_id)}
                              title="Clic: ajustarlo píxel a píxel"
                            >
                              <span className="truncate text-ink-2">
                                {lm.label}
                                {!lm.exact && <span className="ml-1.5 rounded bg-warn-900/70 px-1 text-[10px] text-warn">por verificar</span>}
                              </span>
                              <span className="flex items-center gap-2">
                                <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                                  <span className={`absolute inset-y-0 left-0 rounded-full ${r > WARN_M ? "bg-warn" : "bg-ok"}`} style={{ width: `${Math.min(100, (r / 3) * 100)}%` }} />
                                </span>
                                <span className="tc w-9 text-right text-ink-2">{r.toFixed(2)}</span>
                              </span>
                              <span className={`tc text-right ${bad ? "text-warn" : "text-faint"}`}>{loo === null ? "—" : loo.toFixed(2)}</span>
                              <span onClick={(e) => e.stopPropagation()}>
                                {p.landmark_id.startsWith(IX) ? (
                                  <span className="text-[10px] text-faint" title="Calculado con dos líneas: se quita quitando una de ellas">
                                    línea
                                  </span>
                                ) : (
                                  <IconButton label="Quitar este punto" tone="danger" onClick={() => setPoints((ps) => ps.filter((q) => q.landmark_id !== p.landmark_id))}>
                                    <X size={13} />
                                  </IconButton>
                                )}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  );
                })()
              )}
            </Card>
          )}
        </div>

        {/* The side panel: everything used in this mode, with its own scroll; its width is dragged from its edge. */}
        <div className="relative min-w-0 xl:sticky xl:top-4 xl:self-start">
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Ancho del panel (arrastra; doble clic: el de siempre)"
            title="Arrastra para cambiar el ancho del panel · doble clic: el de siempre"
            className="group absolute top-0 -left-3.5 hidden h-full w-2 cursor-col-resize touch-none xl:block"
            onPointerDown={dragSide}
            onDoubleClick={() => setPref("calib:sideW", String(SIDE_DEFAULT))}
          >
            <span className="mx-auto block h-full w-px rounded-full transition-colors group-hover:bg-line-strong" />
          </div>
          {mode === "calibrar" ? (
            <div className="flex flex-col gap-3" style={fitH ? { height: fitH } : undefined}>
              {/* With the height of the window, the drawing of the venue and the magnifier share what is left: no scroll. */}
              <div className={`flex min-h-0 flex-1 flex-col ${fitH ? "gap-3" : "gap-4"}`}>
                <div className="shrink-0">
                  <KitPanel compact kits={kits} picking={pickKit} onPick={setPickKit} teams={teams} />
                  {kitMsg && <p className="mt-1 text-xs text-warn">{kitMsg}</p>}
                </div>
                <Card delay={100} className={fitH ? "flex min-h-0 flex-[2] basis-0 flex-col" : ""}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="seg" role="group" aria-label="Qué se marca">
                      <button type="button" className="seg-opt !py-0.5 text-xs" aria-pressed={tool === "points"} onClick={() => (setTool("points"), setLineDraft({ px: [], id: null }))} title="Clic en un punto visible y en su punto del dibujo">
                        Puntos
                      </button>
                      <button type="button" className="seg-opt !py-0.5 text-xs" aria-pressed={tool === "lines"} onClick={() => (setTool("lines"), setPendingPx(null), setPendingLm(null))} title="Cuando el punto no se ve: dos clics sobre una línea visible y la línea del dibujo; dos líneas que se cruzan dan el punto">
                        Líneas
                      </button>
                      <button
                        type="button"
                        className="seg-opt !py-0.5 text-xs"
                        aria-pressed={tool === "arcs"}
                        onClick={() => (setTool("arcs"), setPendingPx(null), setPendingLm(null), setLineDraft({ px: [], id: null }))}
                        title="Clics a lo largo del círculo central o de un arco del área (5 o más, mejor medio círculo): se ajusta junto con los puntos y las líneas"
                      >
                        Círculo
                      </button>
                    </span>
                    <span className={`tag tc ${fit.pairs.length >= 4 ? "tag-accent" : ""}`} title={derived.length ? `${derived.length} calculado(s) con líneas` : undefined}>
                      {fit.pairs.length} / 4
                    </span>
                    <span className="ml-auto">
                      <IconButton label={help ? "Ocultar la ayuda" : "Cómo marcar"} tone={help ? "accent" : "default"} onClick={() => setHelp(!help)}>
                        <Info size={16} />
                      </IconButton>
                    </span>
                  </div>
                  {help && (
                    <div className="enter mb-3 space-y-1.5 rounded-xl bg-bg/60 p-3 text-xs text-pretty text-muted">
                      <p>Haz clic en el video y luego en el punto del dibujo, o al revés. Con 4 o más se calcula la cancha y se dibuja sobre el video.</p>
                      <p>Vista desde la cámara: la banda cercana queda abajo. En la rejilla de americano, el punto es donde la línea de yarda toca el borde interior de la franja de la banda.</p>
                      <p>Sobre el video, la rejilla va en celeste y las líneas de fútbol en rosa.</p>
                    </div>
                  )}
                  {noVenue && (
                    <p className="mb-3 flex items-center gap-2 rounded-xl bg-warn-900/60 px-3 py-2 text-xs text-warn">
                      <Warning size={14} className="shrink-0" />
                      El partido no tiene sede: se usa {venue.name}. Elígela en los datos del partido.
                    </p>
                  )}
                  {tool === "arcs" && (
                    <div className="enter mb-3 space-y-2 rounded-xl bg-bg/60 px-3 py-2 text-xs text-pretty text-muted">
                      <div className="seg flex w-full" role="group" aria-label="Qué círculo">
                        {(
                          [
                            ["center", "Central"],
                            ["pen_l", "Arco área izq."],
                            ["pen_r", "Arco área der."],
                          ] as const
                        ).map(([id, label]) => (
                          <button key={id} type="button" aria-pressed={arcId === id} className="seg-opt flex-1 !px-1 text-[11px]" onClick={() => setArcId(id)}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="m-0">
                        {(arcs.find((a) => a.arc_id === arcId)?.pts.length ?? 0) < ARC_MIN
                          ? `Clics sobre el arco en el video: ${arcs.find((a) => a.arc_id === arcId)?.pts.length ?? 0} de ${ARC_MIN} como mínimo, repartidos a lo largo de todo lo que se vea.`
                          : "Sigue añadiendo clics si se ve más arco: cuanto más largo, mejor."}
                      </p>
                      {arcs.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {arcs.map((a, i) => (
                            <span key={a.arc_id} className="inline-flex items-center gap-1 rounded-full bg-raised py-0.5 pr-0.5 pl-2 text-[11px] text-ink-2">
                              {a.arc_id === "center" ? "Central" : a.arc_id === "pen_l" ? "Arco izq." : "Arco der."} · {a.pts.length}
                              {fit.hybrid && a.pts.length >= ARC_MIN && (
                                <span className={(fit.hybrid.spans[arcs.filter((x) => x.pts.length >= ARC_MIN).indexOf(a)] ?? 0) < 120 ? "text-warn" : "text-faint"}>
                                  · {Math.round(fit.hybrid.spans[arcs.filter((x) => x.pts.length >= ARC_MIN).indexOf(a)] ?? 0)}°
                                </span>
                              )}
                              <button type="button" className="grid h-4 w-4 place-items-center rounded-full text-faint hover:text-ink" aria-label="Quitar el último clic" title="Quitar el último clic" onClick={() => setArcs((as) => as.map((x, k) => (k === i ? { ...x, pts: x.pts.slice(0, -1) } : x)).filter((x) => x.pts.length > 0))}>
                                <ArrowCounterClockwise size={10} />
                              </button>
                              <button type="button" className="grid h-4 w-4 place-items-center rounded-full text-faint hover:text-danger" aria-label="Quitar este arco" onClick={() => setArcs((as) => as.filter((x) => x.arc_id !== a.arc_id))}>
                                <X size={10} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {fit.hybrid && fit.hybrid.spans.some((sp) => sp < 120) && (
                        <p className="m-0 text-warn">Arco corto (menos de 120°): el ajuste puede quedar bien en los números y aun así irse un metro. Añade clics más lejos sobre el arco o una línea más.</p>
                      )}
                    </div>
                  )}
                  {tool === "lines" && (
                    <div className="enter mb-3 space-y-2 rounded-xl bg-bg/60 px-3 py-2 text-xs text-pretty text-muted">
                      {(lineDraft.px.length > 0 || lineDraft.id) && (
                        <p className="text-warn">
                          {lineDraft.px.length === 2 && !lineDraft.id
                            ? "Ahora elige qué línea es."
                            : `${modelLines.find((l) => l.id === lineDraft.id)?.label}: ${lineDraft.px.length === 0 ? "dos clics" : "un clic más"} sobre ella en el video.`}
                        </p>
                      )}
                      <Select
                        variant="field"
                        label="Línea del dibujo"
                        className="w-full justify-between"
                        placeholder="…o elige la línea por su nombre"
                        value={lineDraft.id}
                        onChange={(v) => v && onModelLineClick(v)}
                        options={modelLines.map((l) => ({
                          value: l.id,
                          label: `${l.label}${l.exact ? "" : " · por verificar"}`,
                          group: l.id.startsWith("r_") ? "De la sede" : l.family === "soccer" ? "Fútbol" : "Americano",
                        })).sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "")).map((o, i, all) => (i > 0 && all[i - 1].group === o.group ? { ...o, group: undefined } : o))}
                      />
                      {lines.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {lines.map((l) => (
                            <span
                              key={l.line_id}
                              className={`inline-flex items-center gap-1 rounded-full py-0.5 pr-0.5 pl-2 text-[11px] ${selLine?.id === l.line_id ? "bg-accent text-white" : "bg-raised text-ink-2"}`}
                            >
                              <button type="button" className="text-left" title="Ajustarla con el teclado (Alt + flechas, Alt + , . para girar)" onClick={() => pickLine(l.line_id)}>
                                {modelLines.find((m) => m.id === l.line_id)?.label ?? l.line_id}
                              </button>
                              <button type="button" className="grid h-4 w-4 place-items-center rounded-full text-faint hover:text-danger" aria-label="Quitar esta línea" onClick={() => setLines((ls) => ls.filter((x) => x.line_id !== l.line_id))}>
                                <X size={10} />
                              </button>
                            </span>
                          ))}
                          <span className="self-center text-[11px] text-faint">· {derived.length} punto(s) calculado(s)</span>
                        </div>
                      )}
                    </div>
                  )}
                  {(pendingPx || pendingLm) && (
                    <p className="enter mb-3 rounded-xl bg-warn-900/50 px-3 py-2 text-xs text-warn">
                      {pendingPx ? "Ahora elige en el dibujo a qué punto corresponde el clic amarillo." : `Ahora haz clic en el video sobre: ${byId.get(pendingLm ?? "")?.label ?? ""}.`}
                    </p>
                  )}
                  <div className={fitH ? "min-h-0 flex-1" : ""}>
                  <svg viewBox={`${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`} className={`w-full rounded-xl bg-pitch select-none ${fitH ? "h-full" : ""}`}>
                    {venue.lines.map((l, i) => (
                      <polyline
                        key={i}
                        points={l.pts.map((p) => p.join(",")).join(" ")}
                        fill="none"
                        stroke={l.group === "football" ? venue.colors.football : venue.colors.soccer}
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
                    {tool === "lines" &&
                      modelLines
                        .filter((l) => shown[l.family])
                        .map((l) => {
                          const used = lines.some((x) => x.line_id === l.id);
                          const active = lineDraft.id === l.id;
                          return (
                            <g key={l.id} className="cursor-pointer" onClick={() => onModelLineClick(l.id)}>
                              <title>{l.label}</title>
                              <line x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} stroke="transparent" strokeWidth={2.4} />
                              <line
                                x1={l.a[0]}
                                y1={l.a[1]}
                                x2={l.b[0]}
                                y2={l.b[1]}
                                stroke={active ? "#fde047" : used ? "#22d3ee" : "transparent"}
                                strokeWidth={active || used ? 0.7 : 0}
                                className="transition-[stroke]"
                              />
                            </g>
                          );
                        })}
                    {tool === "lines" &&
                      derived.map((d) => (
                        <rect key={d.landmark.id} x={d.landmark.x - 0.9} y={d.landmark.y - 0.9} width={1.8} height={1.8} transform={`rotate(45 ${d.landmark.x} ${d.landmark.y})`} fill="#22d3ee">
                          <title>{d.landmark.label}</title>
                        </rect>
                      ))}
                    {tool === "points" && venue.landmarks
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
                              fill={used ? "#f43f5e" : active ? "#fde047" : l.group === "soccer" ? venue.colors.soccer : venue.colors.football}
                              stroke="var(--color-pitch)"
                              strokeWidth={0.2}
                            />
                          </g>
                        );
                      })}
                  </svg>
                  </div>
                  <div className="mt-3 flex shrink-0 flex-wrap gap-1.5">
                    {GROUPS.filter((g) => venue.landmarks.some((l) => l.group === g.id)).map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        aria-pressed={shown[g.id]}
                        title={g.label}
                        onClick={() => setShown((s) => ({ ...s, [g.id]: !s[g.id] }))}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${
                          shown[g.id] ? "bg-raised text-ink shadow-[0_0_0_1px_var(--color-line-strong)]" : "text-faint hover:text-ink-2"
                        }`}
                      >
                        <i className="h-2 w-2 rounded-full" style={{ background: g.id === "soccer" ? venue.colors.soccer : venue.colors.football, opacity: g.id === "hash" ? 0.5 : 1 }} />
                        {g.short}
                        {g.id !== "football" && <span className="text-[10px] text-faint">{g.id === "hash" ? "sin confirmar" : "por verificar"}</span>}
                      </button>
                    ))}
                  </div>
                </Card>
                <Card delay={140} className={fitH ? "flex min-h-0 flex-[3] basis-0 flex-col" : ""}>
                  <div className="mb-3 flex shrink-0 items-center gap-2">
                    <h2 className="text-[15px] text-ink">Ajuste fino</h2>
                    {points.length > 0 && (
                      <span className="ml-auto flex min-w-0 items-center gap-1">
                        <IconButton label="Punto anterior" disabled={points.length < 2 || stale} onClick={() => setSel(points[(Math.max(0, selIdx) - 1 + points.length) % points.length].landmark_id)}>
                          <CaretLeft size={13} />
                        </IconButton>
                        <span className="max-w-[11rem] truncate text-xs text-ink-2">
                          {selLineObj ? (modelLines.find((m) => m.id === selLineObj.line_id)?.label ?? "Línea") : selPoint ? byId.get(selPoint.landmark_id)?.label : "Elige un punto"}
                        </span>
                        <IconButton label="Punto siguiente" disabled={points.length < 2 || stale} onClick={() => setSel(points[(selIdx + 1) % points.length].landmark_id)}>
                          <CaretRight size={13} />
                        </IconButton>
                      </span>
                    )}
                  </div>
                  <div className={`relative overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--color-line)] ${fitH ? "min-h-[4.5rem] flex-1" : ""}`}>
                    <canvas ref={loupeRef} width={640} height={360} className={`block w-full ${fitH ? "h-full object-contain" : "aspect-video"}`} />
                    <span className="tc absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white">×8 {hover ? "cursor" : selPoint ? "punto" : ""}</span>
                    {hover && (
                      <span className="tc absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                        {hover[0].toFixed(0)}, {hover[1].toFixed(0)} px
                        {hoverM && hoverN && ` · ${hoverM[0].toFixed(1)}, ${hoverM[1].toFixed(1)} m · (${hoverN[0].toFixed(1)}, ${hoverN[1].toFixed(1)})`}
                      </span>
                    )}
                    {!hover && !selPoint && <span className="absolute inset-0 grid place-items-center text-xs text-faint">Pasa el cursor sobre el video</span>}
                  </div>
                  {selLineObj && selLine ? (
                    <div className="mt-3 flex shrink-0 items-center gap-4">
                      <div className="grid shrink-0 grid-cols-3 gap-1">
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Girar a la izquierda" title="Alt + , (con Mayús, 1°)" onClick={(e) => rotateLine(e.shiftKey ? -1 : -0.1)}>
                          <ArrowCounterClockwise size={14} />
                        </button>
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Subir un paso" title="Alt + ↑" onClick={() => nudge(0, -1)}>
                          <CaretUp size={14} />
                        </button>
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Girar a la derecha" title="Alt + . (con Mayús, 1°)" onClick={(e) => rotateLine(e.shiftKey ? 1 : 0.1)}>
                          <ArrowClockwise size={14} />
                        </button>
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Izquierda un paso" title="Alt + ←" onClick={() => nudge(-1, 0)}>
                          <CaretLeft size={14} />
                        </button>
                        <span className="tc grid h-8 w-8 place-items-center text-[11px] text-faint">{step}</span>
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Derecha un paso" title="Alt + →" onClick={() => nudge(1, 0)}>
                          <CaretRight size={14} />
                        </button>
                        <span />
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Bajar un paso" title="Alt + ↓" onClick={() => nudge(0, 1)}>
                          <CaretDown size={14} />
                        </button>
                        <span />
                      </div>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="seg flex w-full" role="group" aria-label="Qué se mueve">
                          {(
                            [
                              ["a", "Clic 1", "Alt + 1"],
                              ["b", "Clic 2", "Alt + 2"],
                              ["both", "Toda", "Alt + 3"],
                            ] as const
                          ).map(([end, label, key]) => (
                            <button key={end} type="button" aria-pressed={selLine.end === end} title={key} className="seg-opt flex-1 !px-1 text-xs" onClick={() => setSelLine({ ...selLine, end })}>
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="seg" role="group" aria-label="Paso en píxeles">
                            {NUDGE_STEPS.map((v) => (
                              <button key={v} type="button" aria-pressed={step === v} onClick={() => setStep(v)} className="seg-opt tc !px-2.5">
                                {v}
                              </button>
                            ))}
                          </div>
                          <span className="text-[11px] text-faint">px · giro 0.1° (Mayús 1°)</span>
                          <button type="button" className="link ml-auto text-[11px]" onClick={() => setSelLine(null)}>
                            soltar
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : selPoint ? (
                    <div className="mt-3 flex shrink-0 items-center gap-4">
                      {/* Arrows around the step: the same moves as Alt + arrows. */}
                      <div className="grid shrink-0 grid-cols-3 gap-1">
                        <span />
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Subir un paso" title="Alt + ↑" onClick={() => nudge(0, -1)}>
                          <CaretUp size={14} />
                        </button>
                        <span />
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Izquierda un paso" title="Alt + ←" onClick={() => nudge(-1, 0)}>
                          <CaretLeft size={14} />
                        </button>
                        <span className="tc grid h-8 w-8 place-items-center text-[11px] text-faint">{step}</span>
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Derecha un paso" title="Alt + →" onClick={() => nudge(1, 0)}>
                          <CaretRight size={14} />
                        </button>
                        <span />
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Bajar un paso" title="Alt + ↓" onClick={() => nudge(0, 1)}>
                          <CaretDown size={14} />
                        </button>
                        <span />
                      </div>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex gap-2">
                          {(["px", "py"] as const).map((axis) => (
                            <label key={axis} className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-faint">
                              {axis === "px" ? "X" : "Y"}
                              <input
                                className={`${input} tc w-full min-w-0 !px-2 text-center`}
                                type="number"
                                step={step}
                                value={Number(selPoint[axis].toFixed(2))}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  if (Number.isFinite(v)) setPoints((ps) => ps.map((q) => (q.landmark_id === sel ? { ...q, [axis]: v } : q)));
                                }}
                              />
                            </label>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="seg" role="group" aria-label="Paso en píxeles">
                            {NUDGE_STEPS.map((v) => (
                              <button key={v} type="button" aria-pressed={step === v} onClick={() => setStep(v)} className="seg-opt tc !px-2.5">
                                {v}
                              </button>
                            ))}
                          </div>
                          <span className="text-[11px] text-faint">px</span>
                          {selErr !== undefined && (
                            <span className={`tag tc ml-auto ${selErr > WARN_M ? "tag-warn" : ""}`} title="Error de este punto en el ajuste">
                              {selErr.toFixed(2)} m
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 shrink-0 text-xs text-faint">Elige un punto (aquí o en su fila del Ajuste) o una línea (su nombre en Líneas) para moverla píxel a píxel.</p>
                  )}
                </Card>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className={`${btnPrimary} flex-1 justify-center`} disabled={!fit.H || stale || saved} onClick={saveAnchor}>
                  <Check size={15} />
                  {saved ? "Ancla guardada" : `Guardar ancla · cuadro ${pointsFrame ?? frame}`}
                </button>
                <button type="button" className={btn} disabled={points.length === 0} onClick={reset} title="Borrar los puntos de este cuadro">
                  <Eraser size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:pr-1" style={fitH ? { maxHeight: fitH } : undefined}>
              {!track && !dets && (
                <Card>
                  <p className="text-sm text-muted">
                    Elige en <strong className="text-ink-2">Previsualizar</strong> una calibración (<code>calib_…</code>) o una parte procesada (<code>tracks_…</code>) para ver cómo calza sobre el video.
                  </p>
                </Card>
              )}
              {track && (
                <Card title="Calibración" note={partLabel(track.name, fps)}>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-bg/60 px-3 py-2.5">
                      <div className="num text-2xl text-ink">{track.frames.size}</div>
                      <div className="mt-0.5 text-[11px] text-faint">cuadros calibrados</div>
                    </div>
                    <div className="rounded-xl bg-bg/60 px-3 py-2.5" title={`Compara lo que dice el ancla anterior con lo que dice la siguiente; si pasa de ${WARN_M} m, falta un ancla cerca.`}>
                      <div className={`num text-2xl ${track.meanDis !== null && track.meanDis > WARN_M ? "text-warn" : "text-ink"}`}>
                        {track.meanDis === null ? "–" : track.meanDis.toFixed(2)} {track.meanDis !== null && <span className="text-sm text-faint">m</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-faint">discrepancia media</div>
                    </div>
                  </div>
                  {track.worstList.length > 0 && (
                    <div className="mt-4">
                      <div className="mb-1.5 text-[11px] text-faint">Donde más discrepa</div>
                      <div className="flex flex-wrap gap-1.5">
                        {track.worstList.map((w) => (
                          <button key={w.frame} type="button" className="tag tag-warn tc hover:brightness-125" onClick={() => seekFrame(w.frame)}>
                            {fmtT(w.frame / fps)} · {w.dis.toFixed(1)} m
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {track.check.length > 0 && (
                    <div className="mt-4" title="Se quita un ancla intermedia y se mide a cuántos metros quedan sus puntos (meta: menos de 2 m).">
                      <div className="mb-1.5 text-[11px] text-faint">Anclas de control</div>
                      <ul className="space-y-0.5 text-xs">
                        {track.check.map((c) => (
                          <li key={c.frame}>
                            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left hover:bg-raised" onClick={() => seekFrame(c.frame)}>
                              <span className="tc text-ink-2">{fmtT(c.frame / fps)}</span>
                              <span className={`tc ml-auto ${(c.error_mean_m ?? 0) > WARN_M ? "text-warn" : "text-ink-2"}`}>{c.error_mean_m === null ? "—" : `${c.error_mean_m.toFixed(2)} m`}</span>
                              <span className={`tc w-16 text-right ${(c.error_max_m ?? 0) > 2 ? "text-warn" : "text-faint"}`}>{c.error_max_m === null ? "" : `máx ${c.error_max_m.toFixed(1)}`}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" className={btnPrimary} onClick={fixHere} title="Pasa a Calibrar en este cuadro para marcar un ancla nueva">
                      <Crosshair size={15} />
                      Corregir aquí
                    </button>
                    <button type="button" className={btn} onClick={() => seekFrame(track.start)}>
                      Ir al inicio
                    </button>
                  </div>
                </Card>
              )}
              {dets && (
                <Card title="Tracking" note={partLabel(dets.name, fps)}>
                  {dets.hasPositions && show === "players" && (
                    <Pitch showDirection={false} className="mb-4 rounded-xl">
                      {boxes
                        ?.filter((bx) => bx[11] && bx[9] !== null && bx[10] !== null)
                        .map((bx) => (
                          <g key={bx[0]}>
                            <circle cx={bx[9] as number} cy={bx[10] as number} r={1.5} fill={TEAM_COLORS[bx[12]] ?? trackColor(bx[0])} stroke="var(--color-bg)" strokeWidth={0.3} />
                            <text x={bx[9] as number} y={(bx[10] as number) - 2.2} textAnchor="middle" fontSize={2.4} fontFamily="var(--font-mono)" fill="var(--color-muted)">
                              {bx[0]}
                            </text>
                          </g>
                        ))}
                    </Pitch>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-xl bg-bg/60 px-3 py-2.5">
                      <div className="num text-2xl text-ink">{dets.quality.on_pitch_median ?? dets.quality.people_median ?? "–"}</div>
                      <div className="mt-0.5 text-[11px] text-faint">{dets.hasPositions ? "en la cancha" : "por cuadro"}</div>
                    </div>
                    <div className="rounded-xl bg-bg/60 px-3 py-2.5" title={`${dets.quality.on_pitch_tracks_long ?? dets.quality.tracks_long ?? 0} de principio a fin`}>
                      <div className="num text-2xl text-ink-2">{dets.quality.on_pitch_tracks ?? dets.quality.tracks ?? "–"}</div>
                      <div className="mt-0.5 text-[11px] text-faint">tracks</div>
                    </div>
                    <div className="rounded-xl bg-bg/60 px-3 py-2.5" title="Cerca de 1 es lo ideal: cada número de track sigue a una sola persona">
                      <div className={`num text-2xl ${(dets.quality.on_pitch_tracks_per_person ?? dets.quality.tracks_per_person ?? 0) > 3 ? "text-warn" : "text-ink-2"}`}>
                        {dets.quality.on_pitch_tracks_per_person ?? dets.quality.tracks_per_person ?? "–"}
                      </div>
                      <div className="mt-0.5 text-[11px] text-faint">por persona</div>
                    </div>
                  </div>
                  {(dets.quality.low_visibility?.length ?? 0) > 0 && (
                    <div className="mt-4">
                      <div className="mb-1.5 text-[11px] text-faint">Casi nadie a la vista</div>
                      <div className="flex flex-wrap gap-1.5">
                        {dets.quality.low_visibility?.map(([a0, b0]) => (
                          <button key={a0} type="button" className="tag tc hover:brightness-125" onClick={() => seekFrame(a0)}>
                            {fmtT(a0 / fps)}–{fmtT(b0 / fps)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// How well the loaded calibration holds along its stretch, frame by frame: blue at an anchor, green where it agrees
// (or there is no measure), amber and red where it drifts, red where a frame has none. Click to go there.
type QClass = "anchor" | "ok" | "warn" | "bad" | "none";
const Q_STYLE: Record<QClass, { cls: string; label: string }> = {
  anchor: { cls: "bg-accent", label: "Ancla" },
  ok: { cls: "bg-ok/80", label: "Calza" },
  warn: { cls: "bg-warn/85", label: `Más de ${WARN_M} m` },
  bad: { cls: "bg-danger/80", label: "Más de 3 m" },
  none: { cls: "bg-danger/40", label: "Sin calibración" },
};

function QualityStrip({ runs, from, to, frame, onSeek }: { runs: { a: number; b: number; c: QClass }[]; from: number; to: number; frame: number; onSeek: (f: number) => void }) {
  const span = Math.max(1, to - from);
  const pct = (f: number) => Math.min(100, Math.max(0, ((f - from) / span) * 100));
  return (
    <div className="mt-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
        {(Object.keys(Q_STYLE) as QClass[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <i className={`h-2 w-2 rounded-full ${Q_STYLE[k].cls}`} />
            {Q_STYLE[k].label}
          </span>
        ))}
      </div>
      <div
        className="relative h-3 cursor-pointer overflow-hidden rounded-full bg-line"
        role="presentation"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(Math.round(from + ((e.clientX - r.left) / r.width) * span));
        }}
      >
        {runs.map((r) => (
          <span key={r.a} className={`absolute inset-y-0 ${Q_STYLE[r.c].cls}`} style={{ left: `${pct(r.a)}%`, width: `max(${r.c === "anchor" ? 3 : 1}px, ${pct(r.b) - pct(r.a)}%)` }} title={Q_STYLE[r.c].label} />
        ))}
        {frame >= from && frame <= to && <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${pct(frame)}%` }} />}
      </div>
    </div>
  );
}
