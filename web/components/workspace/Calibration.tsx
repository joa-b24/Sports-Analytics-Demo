"use client";

import { Check, Crosshair, DownloadSimple, FastForward, FolderOpen, Info, Minus, Path, Pause, Play, Plus, Rewind, SkipBack, SkipForward, Trash, UsersThree, X } from "@phosphor-icons/react";
import { IconButton } from "@/components/Modal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLORS, Pitch } from "@/components/Pitch";
import { LocalPick } from "@/components/LocalPick";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { localVideo, readLocal, writeLocal } from "@/lib/local";
import { SpeedControl } from "@/components/SpeedControl";
import { downloadText, fmtT } from "@/lib/format";
import { parseHms } from "@/lib/segments";
import { apply, fitHomography, fitQuality, invert, invertFor, orient, type Pt } from "@/lib/homography";
import { mutate, uid, useHydrated, useStore } from "@/lib/store";
import type { AnchorPoint, CalibAnchor } from "@/lib/types";
import { VENUES, allVenues, toNormalized, type Landmark, type Venue } from "@/lib/venue";

const GROUPS: { id: Landmark["group"]; label: string }[] = [
  { id: "football", label: "Rejilla de americano (exacta)" },
  { id: "hash", label: "Marcas interiores (posición sin confirmar, no usar aún)" },
  { id: "soccer", label: "Líneas de fútbol (por verificar)" },
];
const OVERLAY = { football: "#22d3ee", soccer: "#f0abfc" };
// Reprojection error above this (meters) is flagged in the table.
const WARN_M = 1.5;
const NUDGE_STEPS = [0.25, 1, 5];

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

interface CalibTrack {
  name: string;
  start: number;
  end: number;
  frames: Map<number, { H: number[] | null; source: string; dis: number | null }>;
  check: { frame: number; error_mean_m: number | null; error_max_m: number | null }[];
  meanDis: number | null;
  worst: { frame: number; dis: number } | null;
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
}: { folder?: string; video?: string; venue?: string; onVenue?: (venueId: string) => void; embedded?: boolean } = {}) {
  const state = useStore();
  const hydrated = useHydrated();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number; duration: number } | null>(null);
  const [fps, setFps] = useState(29.97002997);
  const [time, setTime] = useState(0);
  const [matchId, setMatchId] = useState(folder || "partido_2026_09_25");
  const [videoId, setVideoId] = useState(video || "v1");
  const [venueId, setVenueIdState] = useState(venueInit || VENUES[0].venue_id);
  const setVenueId = (id: string) => {
    setVenueIdState(id);
    onVenue?.(id);
  };
  const [shown, setShown] = useState<Record<Landmark["group"], boolean>>({ football: true, hash: false, soccer: true });

  const [points, setPoints] = useState<AnchorPoint[]>([]);
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

  // A new file resets the element's playback rate, so it is applied again.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, fileUrl]);

  // Moves the selected point by a number of steps. Read through a ref by the key handler.
  const selPoint = stale ? null : (points.find((q) => q.landmark_id === sel) ?? null);
  const nudge = (ux: number, uy: number) => {
    if (!selPoint) return;
    setPoints((ps) => ps.map((q) => (q.landmark_id === sel ? { ...q, px: q.px + ux * step, py: q.py + uy * step } : q)));
  };
  const nudgeRef = useRef(nudge);
  useEffect(() => {
    nudgeRef.current = nudge;
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
      if (el && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return;
      const v = videoRef.current;
      if (!v) return;
      const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
      if (e.altKey && dir) {
        e.preventDefault();
        nudgeRef.current(dir[0] * (e.shiftKey ? 10 : 1), dir[1] * (e.shiftKey ? 10 : 1));
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

  const drawLoupe = useCallback((px: Pt | null) => {
    const c = loupeRef.current;
    const v = videoRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !v || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!px) return;
    const sw = c.width / 8;
    const sh = c.height / 8;
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
  }, []);

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

  useEffect(() => {
    if (!hover && selPoint) drawLoupe([selPoint.px, selPoint.py]);
  }, [hover, selPoint, time, drawLoupe]);

  // Propagated calibration of the frame on screen, used wherever this frame has no points of its own.
  const tf = track?.frames.get(frame) ?? null;
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
      ? points.flatMap((q) => {
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
      setTrack({ name: f.name, start: d.start_frame, end: d.end_frame, frames, check: Array.isArray(d.check) ? d.check : [], meanDis: n ? sum / n : null, worst });
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

  // Inside a match, its video (and its exact fps, from match.yaml) are read from its folder without asking.
  useEffect(() => {
    if (!embedded || !folder || fileUrl) return;
    let live = true;
    void localVideo(folder, videoId).then((url) => {
      if (live && url) setFileUrl(url);
    });
    void readLocal(`matches/${folder}/match.yaml`).then((yaml) => {
      const m = yaml?.match(new RegExp(`video_id:\\s*${videoId}\\b[\\s\\S]*?\\bfps:\\s*([\\d.]+)`));
      if (live && m) setFps(Number(m[1]));
    });
    return () => {
      live = false;
    };
  }, [embedded, folder, videoId, fileUrl]);
  const [savedMsg, setSavedMsg] = useState("");
  const saveAnchorsFile = (name: string, text: string, mime: string) => {
    downloadText(name, text, mime);
    void writeLocal(`matches/${matchId}/tracking/${name}`, text).then((ok) => setSavedMsg(ok ? `Guardado también en matches/${matchId}/tracking/${name}.` : ""));
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

  const steps = [
    { t: "Video y sede", done: fileUrl !== null && fileUrl !== "" },
    { t: "Marcar puntos", done: fit.pairs.length >= 4 },
    { t: "Ajuste", done: Boolean(fit.H && fit.quality) },
    { t: "Guardar ancla", done: saved },
  ];

  if (!hydrated) return null;

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
          subtitle="Marca en un frame del video puntos cuya posición real se conoce. Con cuatro o más se calcula la relación entre la imagen y la cancha, y la cancha se dibuja encima del video para comprobar que calza."
        />
      )}

      {/* Progress through the four steps, read from the real state of the screen. */}
      <ol className="enter mb-6 flex flex-wrap gap-2" style={{ "--d": "200ms" } as React.CSSProperties}>
        {steps.map((st, n) => (
          <li
            key={st.t}
            className={`flex items-center gap-2 rounded-full py-1.5 pr-4 pl-1.5 text-xs transition-colors duration-300 ${
              st.done ? "bg-accent-900 text-accent-200" : "bg-surface text-muted"
            }`}
          >
            <span
              className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${
                st.done ? "bg-accent text-accent-100" : "border border-line-strong"
              }`}
            >
              {st.done ? <Check size={11} weight="bold" /> : n + 1}
            </span>
            {st.t}
          </li>
        ))}
      </ol>

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Archivo de video (no sale de esta computadora)</span>
            <span className={`${btn} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
              <FolderOpen size={15} />
              {fileUrl ? "Cambiar archivo" : "Elegir archivo"}
              <input type="file" accept="video/*" onChange={onFile} className="sr-only" />
            </span>
          </label>
          {!embedded && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Partido (match_id)</span>
                <input className={input} value={matchId} onChange={(e) => setMatchId(e.target.value.trim())} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Video</span>
                <input className={`${input} w-20`} value={videoId} onChange={(e) => setVideoId(e.target.value.trim())} />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Cuadros por segundo</span>
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
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-5">
          <Card>
            {!fileUrl ? (
              <p className="text-sm text-muted">
                Elige el archivo del video (por ejemplo <code>matches/{matchId}/video/v1.mp4</code>). Aquí hace falta el
                archivo y no YouTube, porque hay que avanzar cuadro por cuadro.
              </p>
            ) : (
              <>
                <div className="relative overflow-hidden rounded-2xl bg-black">
                  <video
                    ref={videoRef}
                    src={fileUrl}
                    muted
                    playsInline
                    preload="auto"
                    className="block w-full"
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
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
                            <circle cx={p.px} cy={p.py} r={dotR} fill="none" stroke={p.landmark_id === sel ? "#fde047" : "#f43f5e"} strokeWidth={dotR / 3} />
                            <circle cx={p.px} cy={p.py} r={dotR / 5} fill={p.landmark_id === sel ? "#fde047" : "#f43f5e"} />
                          </g>
                        ))}
                      </g>
                      {/* Propagated calibration: dashed, so it is never mistaken for a hand-marked one. */}
                      {trackLines.map((l, i) => (
                        <path key={`t${i}`} d={l.d} fill="none" stroke={OVERLAY[l.group]} strokeWidth={dotR / 3} strokeDasharray={`${dotR * 1.5} ${dotR}`} opacity={0.95} />
                      ))}
                      {boxes?.map((b) => (
                        // Whoever is off the pitch (bench, stands) stays faint.
                        <g key={b[0]} pointerEvents="none" opacity={dets?.hasPositions && !b[11] ? 0.3 : 1}>
                          <rect x={b[1]} y={b[2]} width={b[3] - b[1]} height={b[4] - b[2]} fill="none" stroke={trackColor(b[0])} strokeWidth={dotR / 4} />
                          <text x={b[1]} y={b[2] - dotR / 2} fontSize={dotR * 2.2} fontFamily="var(--font-mono)" fill={trackColor(b[0])}>
                            {b[0]}
                          </text>
                        </g>
                      ))}
                      {pendingPx && (
                        <circle cx={pendingPx[0]} cy={pendingPx[1]} r={dotR} fill="none" stroke="#fde047" strokeWidth={dotR / 3} />
                      )}
                    </svg>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−1 s" aria-label="Retroceder 1 segundo" onClick={() => seekFrame(frame - Math.round(fps))}>
                    <Rewind size={16} />
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−1 cuadro" aria-label="Retroceder 1 cuadro" onClick={() => seekFrame(frame - 1)}>
                    <SkipBack size={16} />
                  </button>
                  <button
                    type="button"
                    className={`${btnPrimary} h-10 w-10 !p-0`}
                    title={playing ? "Pausar" : "Reproducir"}
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
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 cuadro" aria-label="Avanzar 1 cuadro" onClick={() => seekFrame(frame + 1)}>
                    <SkipForward size={16} />
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 s" aria-label="Avanzar 1 segundo" onClick={() => seekFrame(frame + Math.round(fps))}>
                    <FastForward size={16} />
                  </button>
                  <span className="tag tc ml-2">
                    {fmtT(time)} · cuadro {frame}
                  </span>
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const t = parseHms(goTo);
                      if (t !== null) seekFrame(Math.round(t * fps));
                    }}
                  >
                    <input
                      className={`${input} tc w-24`}
                      placeholder="mm:ss"
                      aria-label="Ir a un tiempo del video (mm:ss u h:mm:ss)"
                      value={goTo}
                      onChange={(e) => setGoTo(e.target.value)}
                    />
                    <button type="submit" className={btn} disabled={parseHms(goTo) === null}>
                      Ir
                    </button>
                  </form>
                  {trackRaw && tf && (
                    <span className={`tag ${tf.dis !== null && tf.dis > WARN_M ? "tag-warn" : "tag-accent"}`}>
                      {tf.source === "anchor" ? "Ancla" : tf.source === "library" ? "Ubicado con la biblioteca" : "Propagado"}
                      {tf.source === "propagated" && <span className="tc">{tf.dis === null ? " · sin medida" : ` · ${tf.dis.toFixed(2)} m`}</span>}
                    </span>
                  )}

                  <div className="ml-auto">
                    <SpeedControl rate={rate} onChange={setRate} />
                  </div>
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
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-faint">
                  <span className="flex items-center gap-1.5">
                    <kbd className="kbd">← →</kbd> un cuadro
                  </span>
                  <span className="flex items-center gap-1.5">
                    <kbd className="kbd">⇧ ← →</kbd> un segundo
                  </span>
                  <span className="flex items-center gap-1.5">
                    <kbd className="kbd">Espacio</kbd> reproduce o pausa
                  </span>
                  <span className="flex items-center gap-1.5">
                    <kbd className="kbd">Esc</kbd> cancela el punto pendiente
                  </span>
                </div>
              </>
            )}
          </Card>

          {/* Not an error: an anchor belongs to one frame, and the video has moved on from it. */}
          {stale && (
            <div className="enter flex flex-wrap items-start gap-x-4 gap-y-3 rounded-2xl bg-accent-900/60 px-4 py-3 text-sm shadow-[inset_0_0_0_1px_rgba(74,114,255,.45)]">
              <Info size={18} className="mt-0.5 shrink-0 text-accent-300" />
              <div className="min-w-0 flex-1 basis-72">
                <p className="text-accent-100">
                  {saved
                    ? `El ancla del cuadro ${pointsFrame} ya está guardada. El video está ahora en el cuadro ${frame}.`
                    : `Tus ${points.length} punto(s) son del cuadro ${pointsFrame}; el video está ahora en el cuadro ${frame}.`}
                </p>
                <p className="mt-1 text-xs text-pretty text-muted">
                  Cada ancla se marca completa sobre un solo cuadro, con el video en pausa: la cámara se mueve y los puntos de un cuadro no
                  sirven en otro. No hace falta marcar todos los cuadros, solo unos pocos por jugada.
                  {!saved && " Si avanzaste sin querer, vuelve al cuadro para seguir marcando."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!saved && (
                  <button type="button" className={btnPrimary} onClick={() => pointsFrame !== null && seekFrame(pointsFrame)}>
                    Volver al cuadro {pointsFrame}
                  </button>
                )}
                <button type="button" className={saved ? btnPrimary : btn} onClick={reset}>
                  {saved ? "Marcar un ancla nueva aquí" : "Descartar y empezar aquí"}
                </button>
                {saved && (
                  <button type="button" className={btn} onClick={() => pointsFrame !== null && seekFrame(pointsFrame)}>
                    Ver el ancla guardada
                  </button>
                )}
              </div>
            </div>
          )}

          <Card title="Ajuste">
            {trackCheckMean !== null && trackCheckMax !== null && (
              <div className="mb-5 rounded-2xl bg-accent-900/40 p-4 shadow-[inset_0_0_0_1px_rgba(74,114,255,.35)]">
                <div className="text-xs text-accent-200">
                  Comprobación de la calibración cargada ({trackAtPoints?.source === "library" ? "biblioteca" : trackAtPoints?.source === "anchor" ? "ancla" : "propagada"})
                  contra tus puntos de este cuadro
                </div>
                <div className="mt-3 flex flex-wrap gap-x-10 gap-y-3">
                  <div>
                    <div className={`num text-5xl ${trackCheckMean > WARN_M ? "text-warn" : "text-accent-200"}`}>
                      {trackCheckMean.toFixed(2)} <span className="text-xl text-faint">m</span>
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted">error medio · {trackCheck.length} punto(s)</div>
                  </div>
                  <div className="border-l border-line-soft pl-4">
                    <div className={`num text-5xl ${trackCheckMax > WARN_M ? "text-warn" : "text-ink-2"}`}>
                      {trackCheckMax.toFixed(2)} <span className="text-xl text-faint">m</span>
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted">peor punto</div>
                  </div>
                </div>
                <ul className="mt-3 space-y-0.5 text-xs text-muted">
                  {trackCheck.map((c) => (
                    <li key={c.id} className="flex justify-between gap-3">
                      <span className="truncate">{c.label}</span>
                      <span className={`tc ${c.err > WARN_M ? "text-warn" : "text-ink-2"}`}>{c.err.toFixed(2)} m</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[11px] text-pretty text-faint">
                  Cada punto que marcas se compara con dónde lo coloca la calibración cargada. Incluye el error de tu propio clic (ajústalo
                  con el ajuste fino). No guardes este cuadro como ancla si solo lo usas para comprobar.
                </p>
              </div>
            )}
            {fit.pairs.length < 4 ? (
              <p className="text-sm text-muted">
                {fit.pairs.length} de 4 puntos como mínimo. Conviene marcar 6 o más, repartidos entre la banda lejana y la
                cercana: con puntos de una sola línea no se puede calcular.
              </p>
            ) : !fit.H || !fit.quality ? (
              <p className="text-sm text-warn">
                No se puede calcular con estos puntos: están casi alineados o alguno está asignado a un punto equivocado.
                Añade uno a otra profundidad de la cancha.
              </p>
            ) : (
              <>
                <div className="mb-5 flex flex-wrap gap-x-10 gap-y-4">
                  <div>
                    <div className="num text-5xl text-ink">{fit.pairs.length}</div>
                    <div className="mt-1.5 text-[11px] text-muted">puntos usados · mín. 4</div>
                  </div>
                  <div className="border-l border-line-soft pl-4">
                    <div className="num text-5xl text-accent-200">
                      {fit.quality.rms.toFixed(2)} <span className="text-xl text-faint">m</span>
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted">error de ajuste (RMS)</div>
                  </div>
                  <div className="border-l border-line-soft pl-4">
                    <div className="num text-5xl text-ink-2">
                      {looMax === null ? "–" : looMax.toFixed(2)} {looMax !== null && <span className="text-xl text-faint">m</span>}
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted">
                      {looMax === null ? "peor error dejando uno fuera: hacen falta 5 puntos" : "peor error dejando un punto fuera"}
                    </div>
                  </div>
                </div>
                <table className="table-nocturne w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="pb-1">Punto</th>
                      <th className="pb-1">Ajuste (m)</th>
                      <th className="pb-1">Dejándolo fuera (m)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {fit.pairs.map(({ p, lm }, i) => {
                      const loo = fit.quality?.leaveOneOut[i] ?? null;
                      const bad = (loo ?? fit.quality?.residuals[i] ?? 0) > WARN_M;
                      return (
                        <tr key={p.landmark_id} className={`border-t border-line-soft ${bad ? "bg-warn-900" : ""} ${p.landmark_id === sel ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""}`}>
                          <td className="py-1">
                            {lm.label}
                            {!lm.exact && <span className="text-faint"> (por verificar)</span>}
                          </td>
                          <td className="tc">{fit.quality?.residuals[i].toFixed(2)}</td>
                          <td className="tc">{loo === null ? "—" : loo.toFixed(2)}</td>
                          <td className="text-right whitespace-nowrap">
                            <IconButton label="Ajustar este punto" tone={p.landmark_id === sel ? "accent" : "default"} onClick={() => setSel(p.landmark_id)}>
                              <Crosshair size={14} />
                            </IconButton>
                            <IconButton label="Quitar este punto" tone="danger" onClick={() => setPoints((ps) => ps.filter((q) => q.landmark_id !== p.landmark_id))}>
                              <X size={14} />
                            </IconButton>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-faint">
                  «Dejándolo fuera» recalcula sin ese punto y mide cuánto se aleja: es la estimación honesta del error. Una
                  fila resaltada (más de {WARN_M} m) suele ser un clic impreciso o un punto mal asignado.
                </p>
              </>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} disabled={!fit.H || stale || saved} onClick={saveAnchor}>
                <Check size={15} />
                {saved ? "Ancla guardada" : `Guardar ancla del cuadro ${pointsFrame ?? frame}`}
              </button>
              <button type="button" className={btn} disabled={points.length === 0} onClick={reset}>
                Borrar puntos
              </button>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Lupa y posición" delay={90}>
            <div className="flex items-start gap-3">
              <canvas ref={loupeRef} width={240} height={135} className="rounded-xl bg-bg shadow-[0_0_0_1px_var(--color-line)]" />
              <div className="tc text-xs text-ink-2">
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
                      <div className="mt-1 text-faint">Sin calibración todavía.</div>
                    )}
                  </>
                ) : (
                  <span className="text-faint">Pasa el cursor sobre el video.</span>
                )}
              </div>
            </div>
          </Card>

          <Card title="Ajuste fino" note={selPoint ? "lupa ×8 centrada en el punto" : undefined} delay={110}>
            {!selPoint ? (
              <p className="text-sm text-muted">
                Marca un punto, o pulsa «ajustar» en la tabla de Ajuste, para moverlo píxel a píxel sin volver a hacer clic.
              </p>
            ) : (
              <>
                <p className="mb-3 text-sm text-ink-2">{byId.get(selPoint.landmark_id)?.label}</p>
                <div className="flex flex-wrap items-end gap-4">
                  {(["px", "py"] as const).map((axis) => (
                    <label key={axis} className="flex flex-col gap-1 text-[11px] text-faint">
                      {axis === "px" ? "X (px)" : "Y (px)"}
                      <span className="flex items-center gap-1">
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Restar un paso" onClick={() => nudge(axis === "px" ? -1 : 0, axis === "py" ? -1 : 0)}>
                          <Minus size={13} />
                        </button>
                        <input
                          className={`${input} tc w-24 text-center`}
                          type="number"
                          step={step}
                          value={Number(selPoint[axis].toFixed(2))}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v)) setPoints((ps) => ps.map((q) => (q.landmark_id === sel ? { ...q, [axis]: v } : q)));
                          }}
                        />
                        <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Sumar un paso" onClick={() => nudge(axis === "px" ? 1 : 0, axis === "py" ? 1 : 0)}>
                          <Plus size={13} />
                        </button>
                      </span>
                    </label>
                  ))}
                  <div className="flex flex-col gap-1 text-[11px] text-faint">
                    Paso (px)
                    <div className="seg">
                      {NUDGE_STEPS.map((v) => (
                        <button key={v} type="button" aria-pressed={step === v} onClick={() => setStep(v)} className="seg-opt tc !px-3">
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-faint">
                  {(() => {
                    const i = fit.pairs.findIndex((x) => x.p.landmark_id === sel);
                    const r = i >= 0 ? fit.quality?.residuals[i] : undefined;
                    return r === undefined ? null : (
                      <span>
                        Error de este punto <span className={`tc ${r > WARN_M ? "text-warn" : "text-ink-2"}`}>{r.toFixed(2)} m</span>
                      </span>
                    );
                  })()}
                  <span className="flex items-center gap-1.5">
                    <kbd className="kbd">Alt + ← ↑ → ↓</kbd> un paso
                  </span>
                  <span className="flex items-center gap-1.5">
                    <kbd className="kbd">+ ⇧</kbd> diez
                  </span>
                </div>
              </>
            )}
          </Card>

          <Card title="Puntos de referencia de la sede" note="banda cercana abajo" delay={140}>
            <p className="mb-2 text-xs text-muted">
              {pendingPx
                ? "Ahora elige aquí a qué punto corresponde el clic amarillo."
                : pendingLm
                  ? `Ahora haz clic en el video sobre: ${byId.get(pendingLm)?.label ?? ""}.`
                  : "Haz clic en el video y luego aquí, o al revés. Vista desde la cámara: la banda cercana queda abajo."}
            </p>
            <svg viewBox={`${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0}`} className="w-full rounded-2xl bg-pitch select-none">
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
                        fill={used ? "#f43f5e" : active ? "#fde047" : l.group === "soccer" ? venue.colors.soccer : venue.colors.football}
                        stroke="var(--color-pitch)"
                        strokeWidth={0.2}
                      />
                    </g>
                  );
                })}
            </svg>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              {GROUPS.filter((g) => venue.landmarks.some((l) => l.group === g.id)).map((g) => (
                <label key={g.id} className="flex items-center gap-1.5">
                  <input type="checkbox" className="accent-accent" checked={shown[g.id]} onChange={(e) => setShown((s) => ({ ...s, [g.id]: e.target.checked }))} />
                  {g.label}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-faint">
              En la rejilla de americano, el punto es donde la línea de yarda toca el borde interior de la franja blanca de
              la banda. Sobre el video, la rejilla se dibuja en celeste y las líneas de fútbol en rosa.
            </p>
          </Card>

          <Card title="Anclas guardadas" note={`${anchors.length} en este partido y video`} delay={190}>
            {anchors.length === 0 ? (
              <p className="text-sm text-muted">Todavía no hay anclas para este partido y video.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {anchors.map((a) => (
                  <li key={a.anchor_id} className="flex items-center justify-between gap-2 border-t border-line-soft pt-1">
                    <span className="tc text-ink">
                      {fmtT(a.t_video)} · cuadro {a.frame} · {a.points.length} puntos
                    </span>
                    <span className="flex gap-1 text-xs">
                      <IconButton label="Abrir esta ancla" onClick={() => loadAnchor(a)}>
                        <FolderOpen size={14} />
                      </IconButton>
                      <IconButton
                        label="Borrar esta ancla"
                        tone="danger"
                        onClick={() => mutate((s) => ({ ...s, anchors: s.anchors.filter((x) => x.anchor_id !== a.anchor_id) }))}
                      >
                        <Trash size={14} />
                      </IconButton>
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
                        const lms = new Map((venues.find((v) => v.venue_id === a.venue_id) ?? venue).landmarks.map((l) => [l.id, l]));
                        return {
                          ...a,
                          points: a.points.flatMap((q) => {
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
                )
              }
            >
              <DownloadSimple size={15} />
              Exportar anclas (JSON)
            </button>
            {savedMsg && <p className="mt-2 text-xs text-ok">{savedMsg}</p>}
          </Card>

<Card title="Detección y posiciones" note="pasos A4 y A6 · calculadas en Python" delay={200}>
            <p className="text-xs text-pretty text-muted">
              El proceso corre por partes de un minuto y es reanudable. Cada parte que termina se puede revisar aquí mientras siguen las
              demás:
            </p>
            <pre className="tc mt-2 overflow-x-auto rounded-xl bg-bg/70 p-3 text-[11px] text-ink-2">{`python -m sportsan.tracking.process --benchmark
python -m sportsan.tracking.process --start 0:33:20 --end 0:34:20`}</pre>
            <p className="mt-2 text-xs text-pretty text-faint">
              <code>process</code> une la detección con la biblioteca de calibración y da también la posición en la cancha.{" "}
              <code>detect</code> hace solo las cajas, sin biblioteca.
            </p>
            <label className={`${btn} relative mt-3 cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
              <UsersThree size={15} />
              {dets ? "Cargar otra parte" : "Cargar detecciones (JSON)"}
              <input type="file" accept=".json" className="sr-only" onChange={onDetsFile} />
            </label>
            <span className="mt-3 ml-2 inline-block">
              <LocalPick dir={`matches/${matchId}/tracking`} pattern={/^tracks_v\d+_\d+_\d+\.json$/} label="De la carpeta" current={dets?.name} onFile={(f) => void onDetsFile(asEvent([f]))} />
            </span>
            {detsMsg && <p className="mt-2 text-xs text-warn">{detsMsg}</p>}
            {dets && (
              <div className="mt-4 border-t border-line-soft pt-4">
                {dets.hasPositions && (
                  <div className="mb-4">
                    <Pitch showDirection={false} className="rounded-xl">
                      {boxes
                        ?.filter((b) => b[11] && b[9] !== null && b[10] !== null)
                        .map((b) => (
                          <g key={b[0]}>
                            <circle cx={b[9] as number} cy={b[10] as number} r={1.5} fill={TEAM_COLORS[b[12]] ?? trackColor(b[0])} stroke="var(--color-bg)" strokeWidth={0.3} />
                            <text x={b[9] as number} y={(b[10] as number) - 2.2} textAnchor="middle" fontSize={2.4} fontFamily="var(--font-mono)" fill="var(--color-muted)">
                              {b[0]}
                            </text>
                          </g>
                        ))}
                    </Pitch>
                    <p className="mt-1 text-[11px] text-faint">
                      Posición de cada caja en la cancha (el pie, pasado por la calibración). Si no hay equipos asignados, el color es el del
                      track.
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap gap-x-8 gap-y-3">
                  <div>
                    <div className="num text-4xl text-ink">{dets.quality.on_pitch_median ?? dets.quality.people_median ?? "–"}</div>
                    <div className="mt-1 text-[11px] text-muted">{dets.hasPositions ? "personas en la cancha (mediana)" : "personas por cuadro (mediana)"}</div>
                  </div>
                  <div className="border-l border-line-soft pl-4">
                    <div className="num text-4xl text-ink-2">{dets.quality.on_pitch_tracks ?? dets.quality.tracks ?? "–"}</div>
                    <div className="mt-1 text-[11px] text-muted">
                      tracks · {dets.quality.on_pitch_tracks_long ?? dets.quality.tracks_long ?? 0} de principio a fin
                      {dets.quality.on_pitch_tracks_short !== undefined && ` · ${dets.quality.on_pitch_tracks_short} de menos de 1.5 s`}
                    </div>
                  </div>
                  <div className="border-l border-line-soft pl-4">
                    <div className={`num text-4xl ${(dets.quality.on_pitch_tracks_per_person ?? dets.quality.tracks_per_person ?? 0) > 3 ? "text-warn" : "text-accent-200"}`}>
                      {dets.quality.on_pitch_tracks_per_person ?? dets.quality.tracks_per_person ?? "–"}
                    </div>
                    <div className="mt-1 text-[11px] text-muted">tracks por persona</div>
                  </div>
                  {dets.quality.calibrated_share !== undefined && (
                    <div className="border-l border-line-soft pl-4">
                      <div className="num text-4xl text-ink-2">{Math.round(dets.quality.calibrated_share * 100)} %</div>
                      <div className="mt-1 text-[11px] text-muted">cuadros calibrados</div>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" className={btn} onClick={() => seekFrame(dets.start)}>
                    Ir al inicio de la parte
                  </button>
                  <span className="tc text-[11px] text-faint">
                    cuadros {dets.start} a {dets.end} · 1 de cada {dets.stride}
                  </span>
                  <button type="button" className="btn btn-ghost ml-auto" onClick={() => setDets(null)}>
                    Quitar
                  </button>
                </div>
                {(dets.quality.low_visibility?.length ?? 0) > 0 && (
                  <div className="mt-3 text-xs text-muted">
                    Subtramos con casi nadie a la vista:{" "}
                    {dets.quality.low_visibility?.map(([a0, b0]) => (
                      <button key={a0} type="button" className="tc link mr-2" onClick={() => seekFrame(a0)}>
                        {fmtT(a0 / fps)}–{fmtT(b0 / fps)}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-xs text-pretty text-faint">
                  Cada caja lleva el número de su track, con un color fijo. Si una jugadora cambia de número a mitad de la parte, el
                  seguimiento se rompió ahí: eso es lo que se arreglará en la mesa de corrección. «Tracks por persona» cerca de 1 es lo
                  ideal; incluye a la gente de la banca y la grada, que se descarta al pasar a metros.
                </p>
              </div>
            )}
          </Card>

          <Card title="Propagación entre anclas" note="calculada en Python" delay={220}>
            <ol className="space-y-1.5 text-xs text-pretty text-muted">
              <li>1. Guarda dos o más anclas dentro de una jugada (una al inicio y otra al final; mejor una tercera en medio).</li>
              <li>2. Exporta las anclas (botón de arriba) y ejecuta en la carpeta del proyecto:</li>
            </ol>
            <pre className="tc mt-2 overflow-x-auto rounded-xl bg-bg/70 p-3 text-[11px] text-ink-2">python -m sportsan.tracking.propagate --anchors anchors_{matchId}_{videoId}.json</pre>
            <p className="mt-2 text-xs text-pretty text-muted">
              3. Carga aquí el archivo <code>calib_…json</code> que escribe en <code>tracking/</code> y recorre el tramo: la rejilla
              punteada es la calibración propagada.
            </p>
            <details className="mt-3 text-xs text-pretty text-muted">
              <summary className="link cursor-pointer">Biblioteca: calibrar una vez y ubicar cualquier jugada</summary>
              <p className="mt-2">
                Si el tramo calibrado es un barrido de lado a lado (antes del partido o una jugada que cruza la cancha), sirve de
                referencia para el resto del video mientras la cámara no cambie de sitio:
              </p>
              <pre className="tc mt-2 overflow-x-auto rounded-xl bg-bg/70 p-3 text-[11px] text-ink-2">{`python -m sportsan.tracking.library build --track <calib del barrido>.json
python -m sportsan.tracking.library locate --match ${matchId} --start 0:33:20 --end 0:33:35`}</pre>
              <p className="mt-2">
                <code>locate</code> escribe otro <code>calib_…json</code>, sin anclas a mano: se carga aquí igual. En la tabla, cada fila es
                un ancla automática comparada con sus vecinas.
              </p>
            </details>
            <label className={`${btn} relative mt-3 cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
              <Path size={15} />
              {track ? "Cargar otra calibración" : "Cargar calibración (calib_… o tracks_…)"}
              <input type="file" accept=".json" className="sr-only" onChange={onTrackFile} />
            </label>
            <span className="mt-3 ml-2 inline-block">
              <LocalPick
                dir={`matches/${matchId}/tracking`}
                pattern={/^(calib_v\d+_\d+_\d+|tracks_v\d+_\d+_\d+)\.json$/}
                label="De la carpeta"
                current={track?.name}
                onFile={(f) => void onTrackFile(asEvent([f]))}
              />
            </span>
            {trackMsg && <p className="mt-2 text-xs text-warn">{trackMsg}</p>}

            {track && (
              <div className="mt-4 border-t border-line-soft pt-4">
                <div className="flex flex-wrap gap-x-8 gap-y-3">
                  <div>
                    <div className="num text-4xl text-ink">{track.end - track.start + 1}</div>
                    <div className="mt-1 text-[11px] text-muted">
                      cuadros · {track.start} a {track.end}
                    </div>
                  </div>
                  <div className="border-l border-line-soft pl-4">
                    <div className={`num text-4xl ${track.meanDis !== null && track.meanDis > WARN_M ? "text-warn" : "text-accent-200"}`}>
                      {track.meanDis === null ? "–" : track.meanDis.toFixed(2)} <span className="text-lg text-faint">m</span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted">discrepancia media adelante / atrás</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={btn} onClick={() => seekFrame(track.start)}>
                    Ir al inicio del tramo
                  </button>
                  {track.worst && (
                    <button type="button" className={btn} onClick={() => track.worst && seekFrame(track.worst.frame)}>
                      Ir al peor cuadro <span className="tc">({track.worst.dis.toFixed(2)} m)</span>
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => setTrack(null)}>
                    Quitar
                  </button>
                </div>
                {track.check.length > 0 && (
                  <table className="table-nocturne mt-4 w-full text-left text-xs">
                    <thead>
                      <tr>
                        <th className="pb-1">Ancla comprobada</th>
                        <th className="pb-1">Error medio (m)</th>
                        <th className="pb-1">Máximo (m)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {track.check.map((c) => (
                        <tr key={c.frame} className={`border-t border-line-soft ${(c.error_max_m ?? 0) > 2 ? "bg-warn-900" : ""}`}>
                          <td className="py-1">
                            <button type="button" className="tc link" onClick={() => seekFrame(c.frame)}>
                              cuadro {c.frame}
                            </button>
                          </td>
                          <td className="tc">{c.error_mean_m === null ? "—" : c.error_mean_m.toFixed(2)}</td>
                          <td className="tc">{c.error_max_m === null ? "—" : c.error_max_m.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-3 text-xs text-pretty text-faint">
                  Cómo leerlo: la discrepancia compara lo que dice el ancla anterior con lo que dice la siguiente; si pasa de {WARN_M} m,
                  falta un ancla cerca de ese cuadro. El ancla de control es la prueba real: se quita un ancla intermedia y se mide a
                  cuántos metros quedan sus puntos (meta: menos de 2 m). Aparece con tres o más anclas.
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
