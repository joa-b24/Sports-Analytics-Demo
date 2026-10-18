"use client";

import { ArrowClockwise, ArrowCounterClockwise, ArrowsMerge, ArrowsSplit, Broom, Broom as BroomIcon, Check, CheckCircle, Copy, Eraser, Eye, Eyedropper, FastForward, FloppyDisk, FolderOpen, HandPointing, MagicWand, Palette, Pause, Play, Plus, Prohibit, Rewind, Scissors, SkipBack, SkipForward, SoccerBall, Stack, TShirt, Trash, UsersThree, Warning, X, MagnifyingGlassPlus, Lightning, CircleDashed, GearSix, LineSegment } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BallStrip } from "@/components/BallStrip";
import { COLORS, Pitch } from "@/components/Pitch";
import { IconButton, Modal } from "@/components/Modal";
import { Command } from "@/components/Command";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { FilePicker, partLabel } from "@/components/LocalPick";
import { PersonTimeline } from "@/components/workspace/PersonTimeline";
import { SpeedControl } from "@/components/SpeedControl";
import { CountUp, Reveal } from "@/components/motion";
import { downloadText, fmtT, isTyping } from "@/lib/format";
import { BALL_FILL_S, ballCoverage, ballPath, eventBall, hasCorrections, joinParts, manualBall, measuredPaths, metersPerUnit, pixelToPitch, type Part } from "@/lib/parts";
import { applyHint, applyTeamCuts, cutHints, type CutHint } from "@/lib/cuts";
import { candidatesFor, dropRange, personTimeline, rejectSuggestion, separateRange, type Suggestion } from "@/lib/suggestions";
import { buildLabels, labelsName } from "@/lib/labels";
import { localFile, listLocal, localVideo, readLocal, writeLocal } from "@/lib/local";
import { parseHms } from "@/lib/segments";
import { SMOOTH_DEFAULTS, smoothTrack, type SmoothOptions, type SmoothReport, type TrackPoint } from "@/lib/smooth";
import { getPref, mutate, setPref, useHydrated, usePref, useStore } from "@/lib/store";
import {
  applyAbsorb,
  clash,
  dropBoxes,
  droppedSet,
  duplicatesAmong,
  boxTeamOf,
  editsKey,
  emptyEdits,
  fileTeamRefs,
  hexToLab,
  identityOf,
  isDropped,
  linkBall,
  labToHex,
  merge,
  nearestFrame,
  overlap,
  people,
  removeBall,
  removeManual,
  offCamera,
  separateRun,
  withoutReferees,
  setBall,
  setManual,
  setPerson,
  setRemoved,
  setRemovedMany,
  splitPerson,
  suggestAbsorb,
  type JerseyColors,
  type JerseyKey,
  type Person,
  type TeamCode,
  type TracksFile,
} from "@/lib/tracks";
import { type TrackEdits } from "@/lib/types";
import { NOBODY, PLAYERS_DONE, SAMPLE_S, applyQuick, applyQuickOnto, leftovers, namedCount, nextCheckpoint, partStatus, quickModel, sampleFrames, type QuickLabel } from "@/lib/quick";

const TEAM_LABELS: Record<TeamCode, string> = { own: "Analizado", opp: "Contrario", ref: "Árbitra", unk: "Sin equipo" };
const TEAM_COLORS: Record<TeamCode, string> = { own: COLORS.own, opp: COLORS.opp, ref: "var(--color-warn)", unk: "var(--color-faint)" };
// Same value as LOOSE_ID in sportsan/tracking/detect.py.
const LOOSE_ID = 1_000_000;
const NO_COLORS: JerseyColors = { own: "", opp: "", ref: "", own_gk: "", opp_gk: "" };
const KIT_LABELS: Record<JerseyKey, string> = { own: "Analizado", own_gk: "Su portera", opp: "Contrario", opp_gk: "Su portera", ref: "Árbitra" };
const KIT_ORDER: JerseyKey[] = ["own", "own_gk", "opp", "opp_gk", "ref"];
const KIT_TEAM: Record<JerseyKey, TeamCode> = { own: "own", own_gk: "own", opp: "opp", opp_gk: "opp", ref: "ref" };

type Mode = null | "merge" | "manual" | "ball";
type WritableHandle = { getFile(): Promise<File>; createWritable(): Promise<{ write(t: string): Promise<void>; close(): Promise<void> }> };

// The handlers below take the event of a file input; a file read from the match folder goes through them too.
const TRACKS_PART = /^tracks_v\d+_\d+_\d+\.json$/;
const asEvent = (files: File[]) => ({ target: { files, value: "" } }) as unknown as React.ChangeEvent<HTMLInputElement>;

function Head({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  if (embedded) return <div className="mb-5 flex flex-wrap items-center gap-2">{children}</div>;
  return (
    <PageHeader
      eyebrow="Tracking · mesa de corrección"
      title="Quién es quién"
      subtitle="El programa detecta a las jugadoras y propone identidades; aquí se revisa: unir los trozos de una misma jugadora, separar dos que se confundieron, poner equipo y dorsal, y marcar a mano donde se perdió."
    >
      {children}
    </PageHeader>
  );
}

// Correction table of the tracks of one match. Inside a match (embedded) its folder and the match of the app (for
// the tagged events used as ball positions) come from the match.
// Width of the people column (px): dragged on the divider, within these limits; the video never gets narrower than VIDEO_MIN_PX.
const LIST_MIN_PX = 352;
// A person with less than this share of her boxes on the pitch is somebody off it (bench, stands, coaches).
const OFF_PITCH_SHARE = 0.1;
// How long a notice stays on screen (ms).
const MSG_MS = 6000;
// A hole in the middle of the image longer than this (s) is worth a look in the table.
const FIX_GAP_S = 2;
const LIST_MAX_PX = 900;
const VIDEO_MIN_PX = 520;

export function Correction({
  folder,
  video = "v1",
  matchAppId,
  embedded = false,
}: { folder?: string; video?: string; matchAppId?: string; embedded?: boolean } = {}) {
  const state = useStore();
  const hydrated = useHydrated();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [data, setData] = useState<TracksFile | null>(null);
  const [msg, setMsg] = useState("");
  // Notices go away by themselves after a few seconds.
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), MSG_MS);
    return () => clearTimeout(t);
  }, [msg]);
  const [sel, setSel] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [goTo, setGoTo] = useState("");
  const [showShort, setShowShort] = useState(false);
  const [teamFilter, setTeamFilter] = useState<TeamCode | "all">("all");
  const [hideDone, setHideDone] = useState(true);
  // Referees are not useful for the analysis: hidden (and left out of what is exported) unless asked for.
  const [showRefs, setShowRefs] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Kit whose colour is being taken from the video with a click.
  const [pickKit, setPickKit] = useState<JerseyKey | null>(null);
  // Used for the kit colours while no tracks file (which names its match) is loaded.
  const [matchIdText, setMatchIdText] = useState(folder || "partido_2026_09_25");
  // Previous states of the corrections of this part, for undo.
  const [history, setHistory] = useState<TrackEdits[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // A merge that was stopped because the two people appear at the same time.
  // Cleaning applied to each person's path when exporting (lib/smooth.ts).
  const [smoothOn, setSmoothOn] = useState(true);
  // Every hole is filled on export (a straight line, marked as filled): players mostly go back to their place, and the
  // distance run needs the whole path. A limit can still be set in the export dialog.
  const [smoothCfg, setSmoothCfg] = useState({ ...SMOOTH_DEFAULTS, maxFillS: Number.POSITIVE_INFINITY });
  // Other parts of the same video, loaded only to export them together with their corrections.
  const [extra, setExtra] = useState<TracksFile[]>([]);
  const [blocked, setBlocked] = useState<{ into: number; from: number; frames: number[]; same: number } | null>(null);
  // Players or ball: two views of the same part.
  const [view, setView] = useState<"players" | "ball" | "quick">("players");
  // The view as the keyboard handler (set up once) sees it.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // Quick review: which sample, which box is being named, digits typed, and for which team.
  const [qIdx, setQIdx] = useState(0);
  const [qPicked, setQPicked] = useState<number | null>(null);
  const [qTyped, setQTyped] = useState("");
  const [qTeam, setQTeam] = useState<"own" | "opp">("own");
  const qEvery = Number(usePref("quick:every", String(SAMPLE_S))) || SAMPLE_S;
  // One player at a time (stops only where she could have been swapped) or every player on sample frames.
  const qMode = usePref("quick:mode", "player") as "player" | "samples";
  const [qPlayer, setQPlayer] = useState<string | null>(null);
  const [qPlayerTeam, setQPlayerTeam] = useState<"own" | "opp">("own");
  // The last frame reviewed for that player: the next stop is searched from there.
  const [qAfter, setQAfter] = useState(0);
  // Ball review by samples: which one, and every how many seconds.
  const [bIdx, setBIdx] = useState(0);
  const bEvery = Number(usePref("ball:every", "1")) || 1;
  // Boxes over the video in the ball view (they get in the way of clicking the ball), and what the pitch below shows.
  const ballBoxes = usePref("ball:boxes", "0") === "1";
  const pitchShow = usePref("correction:pitchShow", "all") as "all" | "named" | "ball";
  // Quick review: the player all of the current one's names are moved to (fixing a mix-up).
  const [qMoveTo, setQMoveTo] = useState("");
  // Secondary work opens in a dialog: kit colours, quick cleaning of short pieces, export.
  const [modal, setModal] = useState<null | "kits" | "cleanup" | "export" | "reset" | "ballEvents" | "applyQuick">(null);
  // A candidate being checked on the video ("does she go on as …?").
  const [peek, setPeek] = useState<Suggestion | null>(null);
  // Rows of the list drawn (the list of a long part has thousands of pieces).
  const [listLimit, setListLimit] = useState(80);
  const [onlyShirt, setOnlyShirt] = useState(false);
  // The list shows the people with a name (the players being corrected) unless asked for everybody.
  const listShow = usePref("correction:listShow", "named") as "named" | "all";

  const fps = data?.fps ?? 29.97002997;
  const frame = Math.round(time * fps);
  const key = data ? editsKey(data) : "";
  const edits = useMemo(() => state.trackEdits.find((e) => e.key === key) ?? emptyEdits(key), [state.trackEdits, key]);
  const mid = data?.match_id ?? matchIdText;
  const colors = state.jerseys[mid] || NO_COLORS;
  const writeEdits = (next: TrackEdits) => mutate((s) => ({ ...s, trackEdits: [...s.trackEdits.filter((e) => e.key !== next.key), next] }));
  // Every correction can be undone: the state before it is kept (the last 100).
  const setEdits = (next: TrackEdits) => {
    setHistory((h) => [...h.slice(-99), edits]);
    writeEdits(next);
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    writeEdits(prev);
    setNotice(null);
  };
  const undoRef = useRef(undo);
  useEffect(() => {
    undoRef.current = undo;
  });
  const setColors = (next: JerseyColors) => mid && mutate((s) => ({ ...s, jerseys: { ...s.jerseys, [mid]: next } }));

  const byFrame = useMemo(() => new Map((data?.frames ?? []).map((f) => [f.frame, f])), [data]);
  const ppl = useMemo(() => (data ? people(data, edits, colors) : []), [data, edits, colors]);
  const personById = useMemo(() => new Map(ppl.map((p) => [p.id, p])), [ppl]);
  const selected = sel !== null ? (personById.get(sel) ?? null) : null;

  const ready = fileUrl !== null;
  // Frame-accurate clock, as in Calibración.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !fileUrl) return;
    let handle = 0;
    let alive = true;
    const onFrame: VideoFrameRequestCallback = (_n, meta) => {
      if (!alive) return;
      setTime(meta.mediaTime);
      handle = v.requestVideoFrameCallback(onFrame);
    };
    handle = v.requestVideoFrameCallback(onFrame);
    return () => {
      alive = false;
      v.cancelVideoFrameCallback(handle);
    };
    // The <video> element is a different one before and after a tracks file is loaded.
  }, [fileUrl, ready, data]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, fileUrl, ready]);

  const seekFrame = useCallback(
    (f: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      v.currentTime = Math.max(0, (f + 0.5) / fps);
    },
    [fps],
  );
  const stride = data?.stride ?? 3;
  // Play / pause. A second press while play() is still starting must not leave the video in between.
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (isTyping(el)) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const step = (e.shiftKey ? Math.round(fps) : stride) * (e.key === "ArrowRight" ? 1 : -1);
        seekFrame(Math.round(v.currentTime * fps - 0.5) + step);
      } else if (e.key === " ") {
        e.preventDefault();
        if (e.repeat) return;
        togglePlay();
      } else if (e.key === "Escape") {
        setMode((m) => {
          if (m === null) setSel(null);
          return null;
        });
        setPickKit(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        undoRef.current();
      }
      else if (e.key === "u" && viewRef.current === "players") setMode((m) => (m === "merge" ? null : "merge"));
      else if (e.key === "p" && viewRef.current === "players") setMode((m) => (m === "manual" ? null : "manual"));
      else if (e.key === "b" && viewRef.current === "players") setMode((m) => (m === "ball" ? null : "ball"));
      else if (e.key === "z") setPref("correction:zoom", String((Number(getPref("correction:zoom", "2")) % 3) + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fps, stride, seekFrame, togglePlay]);

  // Inside a match, its video is opened from its folder without asking.
  useEffect(() => {
    if (!embedded || !folder || fileUrl) return;
    let live = true;
    void localVideo(folder, video).then((url) => {
      if (live && url) setFileUrl(url);
    });
    return () => {
      live = false;
    };
  }, [embedded, folder, video, fileUrl]);

  const onVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    setFileUrl(URL.createObjectURL(f));
    setDims(null);
  };
  const onTracks = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.kind !== "tracks_px" || !Array.isArray(d.frames)) throw new Error("formato");
      if (!Array.isArray(d.box_columns) || !d.box_columns.includes("identity")) {
        setData(null);
        return setMsg("Ese archivo no trae posiciones ni identidades propuestas. Vuelve a generarlo con python -m sportsan.tracking.process.");
      }
      setData(d as TracksFile);
      setSel(null);
      setMode(null);
      setHistory([]);
      setNotice(null);
      setMsg("");
      seekFrame(d.start_frame);
    } catch {
      setData(null);
      setMsg("Ese archivo no es una parte de tracking (se espera tracks_<video>_<inicio>_<fin>.json).");
    }
  };

  // Detections of the processed frame nearest to the one on screen.
  const inRange = data !== null && frame >= data.start_frame - stride && frame <= data.end_frame + stride;
  const pf = data && inRange ? nearestFrame(data, frame) : null;
  const row = pf !== null ? (byFrame.get(pf) ?? null) : null;
  // Hidden (and left out of what is saved) unless asked for: referees, and people almost never on the pitch (bench,
  // stands, coaches) that nobody named.
  const offPitch = (p: Person) => p.onPitchShare < OFF_PITCH_SHARE && !p.player_id && !p.teamByHand;
  const refIds = new Set(showRefs ? [] : ppl.filter((p) => (p.team === "ref" && !p.teamByHand) || offPitch(p)).map((p) => p.id));
  const removed = new Set([...edits.removed, ...refIds]);
  const droppedBoxes = useMemo(() => droppedSet(edits), [edits]);
  const shown = (row?.boxes ?? [])
    .filter((b) => !isDropped(droppedBoxes, b, pf as number))
    .map((b) => ({ b, id: identityOf(b, pf as number, edits) }))
    .filter((x) => !removed.has(x.id));
  const manualHere = pf !== null ? edits.manual.filter((m) => m.frame === pf && !removed.has(m.identity)) : [];
  const dotR = dims ? dims.w / 260 : 6;

  // The detections end with the part: playback stops there instead of running on without boxes.
  const partEnd = data ? data.end_frame - 1 : null;
  useEffect(() => {
    const v = videoRef.current;
    if (partEnd !== null && v && !v.paused && frame >= partEnd) v.pause();
  }, [frame, partEnd]);

  // Colour of a kit taken from the video: median of the 9 x 9 pixels around the click.
  const sampleKit = (clientX: number, clientY: number) => {
    const v = videoRef.current;
    if (!v || !pickKit) return;
    const r = v.getBoundingClientRect();
    const x = Math.round(((clientX - r.left) / r.width) * v.videoWidth);
    const y = Math.round(((clientY - r.top) / r.height) * v.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 9;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, x - 4, y - 4, 9, 9, 0, 0, 9, 9);
    const px = ctx.getImageData(0, 0, 9, 9).data;
    const med = [0, 1, 2].map((c) => Array.from({ length: 81 }, (_, i) => px[i * 4 + c]).sort((a, b) => a - b)[40]);
    const hex = `#${med.map((v2) => v2.toString(16).padStart(2, "0")).join("")}`;
    // A click that lands on the pitch instead of the shirt would make everybody "of that team".
    const lab = hexToLab(hex);
    if (lab && lab[1] < 120 && lab[2] > 132) {
      return setMsg("Ese punto parece césped, no una camiseta. Acerca el clic al centro del torso (pausa el video antes).");
    }
    setMsg("");
    setColors({ ...colors, [pickKit]: hex });
    setPickKit(null);
  };

  // Hand-marked feet -> pitch, through the calibration stored for that frame.
  const toPitch = (px: number, py: number, H: number[] | null | undefined): [number, number] | null => (data ? pixelToPitch(data, H, px, py) : null);

  const toPixels = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const ctm = overlayRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  };
  // Ball: marked by hand in this part, plus the tagged events of the chosen match that fall inside it.
  const eventMatch = usePref(`ballMatch:${mid}`, "");
  const attack = usePref(`attack:${mid}:${data?.video_id ?? "v1"}`, "");
  const eventsMatchId = eventMatch || matchAppId || (state.matches.find((m) => m.match_id === mid)?.match_id ?? "");
  const matchEvents = useMemo(() => state.events.filter((e) => e.match_id === eventsMatchId), [state.events, eventsMatchId]);
  const ballKnown = useMemo(
    () => (data ? [...(attack ? eventBall(data, matchEvents, attack === "right") : []), ...manualBall(data, edits)] : []),
    [data, edits, matchEvents, attack],
  );
  const ball = useMemo(() => (data ? ballPath(ballKnown, data.fps, data.stride, BALL_FILL_S, edits.ballLinks ?? []) : []), [data, ballKnown, edits.ballLinks]);
  // A line by hand: the mark where the ball leaves, waiting for the click where it lands.
  const [ballLinkFrom, setBallLinkFrom] = useState<number | null>(null);
  // Frames where the ball comes from a tagged event: they count for the part as the hand marks do.
  const eventBallFrames = ball.filter((x) => x.source === "event").map((x) => x.frame);

  // ---------------------------------------------------------------- ball review by samples
  const bSamples = useMemo(() => (data ? sampleFrames(data, bEvery) : []), [data, bEvery]);
  // Samples gone through in the ball review, whatever interval was used.
  const bSeen = edits.ballReview?.seen ?? [];
  const bGo = (i: number) => {
    const j = Math.max(0, Math.min(bSamples.length - 1, i));
    setBIdx(j);
    if (bSamples[j] !== undefined) seekFrame(bSamples[j]);
  };
  // Once the part is complete (and the quick review applied: our players have their names in the table), what is
  // left over is discarded. Returns the edits to write and a message.
  const finishIfComplete = (next: TrackEdits): { edits: TrackEdits; note: string } => {
    if (!data) return { edits: next, note: "" };
    const before = partStatus(edits, { start_frame: data.start_frame, end_frame: data.end_frame, fps: data.fps, stride: data.stride }, eventBallFrames).complete;
    if (before || !partStatus(next, { start_frame: data.start_frame, end_frame: data.end_frame, fps: data.fps, stride: data.stride }, eventBallFrames).complete) return { edits: next, note: "" };
    const ppl2 = people(data, next, colors);
    if (namedCount(ppl2) < PLAYERS_DONE) return { edits: next, note: "" };
    const extra = leftovers(ppl2, data.fps, data.stride).filter((id) => !next.removed.includes(id));
    return {
      edits: extra.length ? setRemovedMany(next, extra) : next,
      note: `✓ Parte completa: descartadas ${extra.length} personas sin nombre (nuestras, rivales de menos de 1 s, árbitras y sin equipo). Ctrl + Z las recupera.`,
    };
  };
  const bStep = (n: number) => {
    if (bSamples.length === 0) return;
    const after = bSamples.findIndex((f) => f > frame + stride / 2);
    const before = after === -1 ? bSamples.length - 1 : after - 1;
    const atSample = bSamples.indexOf(frame) >= 0 ? bSamples.indexOf(frame) : null;
    const base = atSample ?? (n > 0 ? before : after === -1 ? bSamples.length : after);
    bGo(base + n);
  };
  // The next stretch in play without a ball (from the start again after the last).
  const nextMissingBall = () => {
    if (!data) return;
    const half = (bEvery * fps) / 2;
    // The whole path (marks, automatic lines and lines by hand), as the strip counts it.
    const marks = ball.map((b) => b.frame);
    const outs = bSeen.filter((f) => !(edits.ball ?? []).some((m) => Math.abs(m.frame - f) <= half));
    const { missing } = ballCoverage({ marks, out: outs, from: data.start_frame, to: data.end_frame, fps, stride, outHalf: half });
    if (missing.length === 0) return setMsg("No faltan marcas de balón en el tiempo en juego.");
    const next = missing.find(([a]) => a > frame + stride) ?? missing[0];
    seekFrame(Math.round(next[0] / stride) * stride);
  };
  // i: the ball leaves from the mark on screen (or the last one before); the next click, where it lands, draws the line.
  const startBallLine = () => {
    if (ballLinkFrom !== null) {
      setBallLinkFrom(null);
      return setMsg("Recta cancelada.");
    }
    if (pf === null) return;
    const from = (edits.ball ?? []).filter((m) => m.frame <= pf).sort((x, y) => y.frame - x.frame)[0];
    if (!from) return setMsg("Primero marca dónde sale el balón.");
    setBallLinkFrom(from.frame);
    setMsg(`Recta desde ${fmtT(from.frame / fps)}: avanza y haz clic donde cae (i otra vez para cancelar).`);
  };
  const bNotSeen = () => {
    const f = bSamples[bIdx];
    if (f === undefined) return;
    const r = finishIfComplete({ ...edits, ballReview: { every: bEvery, seen: [...new Set([...bSeen, f])] } });
    setEdits(r.edits);
    if (r.note) setMsg(r.note);
    bGo(bIdx + 1);
  };
  const bKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    bKeys.current = (e: KeyboardEvent) => {
      if (view !== "ball" || isTyping(e.target) || e.ctrlKey || e.metaKey) return;
      // Arrows: one step (the interval chosen); Alt + arrows: one processed frame; Tab: two steps (Shift + Tab back).
      if (e.key === "Enter") bNotSeen();
      else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.altKey) seekFrame(frame + (e.key === "ArrowRight" ? stride : -stride));
      else if (e.key === "ArrowRight" && !e.shiftKey) bStep(1);
      else if (e.key === "ArrowLeft" && !e.shiftKey) bStep(-1);
      else if (e.key === "Tab") bStep(e.shiftKey ? -2 : 2);
      else if (e.key === "n") nextMissingBall();
      else if (e.key === "i") startBallLine();
      else if ((e.key === "Backspace" || e.key === "Delete") && pf !== null) setEdits(removeBall(edits, pf));
      else if (e.key === "h") setPref("ball:boxes", ballBoxes ? "0" : "1");
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => bKeys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const status = data ? partStatus(edits, { start_frame: data.start_frame, end_frame: data.end_frame, fps: data.fps, stride: data.stride }, eventBallFrames) : null;

  const onOverlayClick = (e: React.MouseEvent) => {
    if (pickKit) return sampleKit(e.clientX, e.clientY);
    if (mode === "ball" && pf !== null) {
      const b = toPixels(e);
      if (!b) return;
      videoRef.current?.pause();
      let marked = setBall(edits, pf, Math.round(b[0] * 10) / 10, Math.round(b[1] * 10) / 10);
      if (ballLinkFrom !== null && pf !== ballLinkFrom) {
        marked = linkBall(marked, ballLinkFrom, pf);
        setBallLinkFrom(null);
        setMsg("Recta trazada: de donde salió a donde cae, sin marcas en medio.");
      }
      // In the ball review the sample counts as gone through and the next one comes.
      if (view === "ball" && bSamples.includes(pf)) {
        const r = finishIfComplete({ ...marked, ballReview: { every: bEvery, seen: [...new Set([...bSeen, pf])] } });
        setEdits(r.edits);
        if (r.note) setMsg(r.note);
        return bGo(bIdx + 1);
      }
      return setEdits(marked);
    }
    if (mode !== "manual" || sel === null || pf === null) return;
    const p = toPixels(e);
    if (!p) return;
    videoRef.current?.pause();
    setEdits(setManual(edits, sel, pf, Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10));
  };
  const selTwiceHere = sel !== null && shown.filter((x) => x.id === sel).length > 1;
  // Identities drawn more than once in this frame, whoever is selected.
  const twiceHere = new Set(shown.map((x) => x.id).filter((id, i, all) => all.indexOf(id) !== i));
  // Joins `from` into `into`, unless they appear together in some frame: one person cannot be in two places.
  // Where the two share a frame there are two cases. If the boxes are in the same place it is one player detected
  // twice: one box is left out and the two are joined without asking. If they are apart, they are two people on the
  // pitch at once, and the join is stopped (it can still be forced).
  const tryMerge = (into: number, from: number, force = false): boolean => {
    const a = personById.get(into);
    const b = personById.get(from);
    const c = data && a && b && overlap(a, b).length > 0 ? clash(data, edits, into, from) : { same: [], apart: [], drop: [] };
    if (c.apart.length > 0 && !force) {
      setBlocked({ into, from, frames: c.apart, same: c.same.length });
      setNotice(null);
      return false;
    }
    setBlocked(null);
    setEdits(merge(dropBoxes(edits, c.drop), into, from));
    if (c.same.length > 0) {
      setMsg(`Unidas. En ${c.same.length} cuadro(s) había dos cajas sobre la misma jugadora: se dejó una (la de más confianza). Ctrl + Z lo deshace.`);
    }
    return true;
  };
  // The selected person has two boxes in some frames. Where both are in the same place, keep one.
  const unifySelf = () => {
    if (!data || sel === null) return;
    const c = clash(data, edits, sel, sel);
    if (c.drop.length === 0) return setMsg("En esos cuadros las dos cajas están separadas: elige en el video cuál es ella.");
    setEdits(dropBoxes(edits, c.drop));
    setMsg(`Se dejó una sola caja en ${c.same.length} cuadro(s).${c.apart.length ? ` Quedan ${c.apart.length} donde están separadas: elige en el video cuál es ella.` : ""}`);
  };
  // The selected person has two boxes in this frame: clicking the right one sends the other tracks away.
  const keepOnly = (track: number) => {
    if (sel === null || !data) return;
    let next = edits;
    // Only the stretch of each other box around this frame goes; the rest of its track (and the cuts made) stays.
    for (const x of shown) if (x.id === sel && x.b[0] !== track && pf !== null) next = separateRun(next, data, x.b[0], pf)?.edits ?? next;
    setEdits(next);
  };
  const pickBox = (id: number, track?: number) => {
    // In the ball view a click is for the ball, never for a player.
    if (view === "ball") return;
    if (track !== undefined && id === sel && selTwiceHere && mode === null) return keepOnly(track);
    if (mode === "merge" && sel !== null && id !== sel) {
      tryMerge(sel, id);
      return;
    }
    setSel(id);
    setMode(null);
    setBlocked(null);
  };
  // Works on any frame between her first and last appearance, also where she has no box: a wrong join usually sits
  // right at a small hole, when the tracker lost her and picked up somebody else.
  const canSplit = selected !== null && pf !== null && pf > selected.first && pf <= selected.last;
  // Splits the selected person at this frame. The second stretch is selected (s), or the first stays (Shift + S).
  const splitHere = (keepFirst = false) => {
    if (!data || sel === null || pf === null) return;
    const r = splitPerson(edits, sel, pf, data);
    if (!r) return;
    setEdits(r.edits);
    if (!keepFirst) setSel(r.identity);
  };

  // Identities that start from a loose detection carry a very large number: shown as s1, s2... to keep them short.
  const label = (p: Person | undefined, id: number) => `${p?.player_id ? p.player_id : id >= LOOSE_ID ? `s${id - LOOSE_ID}` : `#${id}`}${p?.keeper ? " P" : ""}`;
  const span = data ? Math.max(1, data.end_frame - data.start_frame) : 1;
  const pos = (f: number) => (data ? ((f - data.start_frame) / span) * 100 : 0);
  // Runs of consecutive presence, for the coverage bar of each person.
  const runs = (p: Person) => {
    const out: [number, number][] = [];
    let a = p.frames[0];
    let prev = a;
    for (const f of p.frames.slice(1)) {
      if (f - prev > stride * 1.5) {
        out.push([a, prev]);
        a = f;
      }
      prev = f;
    }
    out.push([a, prev]);
    return out;
  };

  // A name identifies a person: giving somebody a name that another already has joins the two.
  const rename = (person: Person, name: string) => {
    const other = name ? ppl.find((q) => q.id !== person.id && q.player_id.toLowerCase() === name.toLowerCase()) : undefined;
    if (!other) return setEdits(setPerson(edits, person.id, { player_id: name }));
    // Same name = same person, but only if they never appear together.
    if (!tryMerge(other.id, person.id)) return;
    setSel(other.id);
    setNotice(`«${name}» ya existía: se unieron.`);
  };

  const minFrames = Math.round(fps / stride); // one second of presence
  const cutAll = useMemo(() => (data ? cutHints(data, edits) : []), [data, edits]);
  const shirtHintPeople = cutAll.filter((h) => h.kind === "team").map((h) => h.person);
  // The selected person goes first, so she is easy to find after clicking her box on the video; then by time on screen.
  const shirtPeople = new Set(shirtHintPeople);
  const listedAll = [...ppl]
    // Named people first, then by time seen.
    .sort((a, b) => Number(!!b.player_id) - Number(!!a.player_id) || b.frames.length - a.frames.length)
    .filter(
      (p) =>
        p.id !== sel &&
        (listShow === "all" || !!p.player_id) &&
        (!onlyShirt || shirtPeople.has(p.id)) &&
        ((showShort || p.frames.length >= minFrames) && (teamFilter === "all" || p.team === teamFilter) && !(hideDone && p.done) && !refIds.has(p.id)),
    );
  // For the selected person: who she could go on as, and who she could come from. Nothing is applied by itself.
  const cand = useMemo(
    () => (data && sel !== null ? candidatesFor(data, edits, ppl.filter((p) => !refIds.has(p.id) || p.id === sel), sel) : { next: [], prev: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refIds is rebuilt on every render from ppl
    [data, edits, ppl, sel],
  );
  const selLine = useMemo(() => (data && sel !== null ? personTimeline(data, edits, sel) : []), [data, edits, sel]);
  // Zoom on the selected person: 1 (off), 2 or 3. Only a CSS transform of the video, so playback is not slower.
  const zoom = Number(usePref("correction:zoom", "2")) || 1;
  // Where the zoom looks: her box in the processed frame on screen, or in the nearest one where she has a box (while
  // she is lost the view stays where she was last seen).
  const zoomCenter = ((): [number, number] | null => {
    if (!data || sel === null || selLine.length === 0 || pf === null) return null;
    let lo = 0;
    let hi = selLine.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (selLine[mid].frame < pf) lo = mid + 1;
      else hi = mid;
    }
    const near = [selLine[lo], selLine[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a.frame - pf) - Math.abs(b.frame - pf))[0];
    const box = byFrame.get(near.frame)?.boxes.find((b) => identityOf(b, near.frame, edits) === sel);
    return box ? [(box[1] + box[3]) / 2, (box[2] + box[4]) / 2] : null;
  })();
  // In the ball view the zoom looks where the ball was last marked (up to 3 s before).
  const ballCenter = ((): [number, number] | null => {
    if (pf === null) return null;
    const prev = (edits.ball ?? []).filter((b) => b.frame <= pf && pf - b.frame <= 3 * fps).sort((a, b) => b.frame - a.frame)[0];
    return prev ? [prev.px, prev.py] : null;
  })();
  // translate(t) scale(z) puts a point p at z * p + t: the point goes to the middle, without showing past the edges.
  const zoomTo = (center: [number, number] | null): string | undefined => {
    if (zoom <= 1 || !center || !dims) return undefined;
    const clamp = (v: number) => Math.min(0, Math.max((1 - zoom) * 100, v));
    const tx = clamp((0.5 - (zoom * center[0]) / dims.w) * 100);
    const ty = clamp((0.5 - (zoom * center[1]) / dims.h) * 100);
    return `translate(${tx}%, ${ty}%) scale(${zoom})`;
  };
  const peekAt = (s: Suggestion) => {
    setPeek(s);
    seekFrame(Math.max(data?.start_frame ?? 0, s.frameFrom - Math.round(fps)));
    videoRef.current?.play().catch(() => undefined);
  };
  // The other person of the candidate being checked (the selected one is the other side).
  const peekOther = peek && sel !== null ? (peek.from === sel ? peek.to : peek.from) : null;
  const peekNext = (after: Suggestion) => {
    const list = [...cand.next, ...cand.prev].filter((x) => x !== after);
    setPeek(null);
    if (list[0]) peekAt(list[0]);
  };
  const joinCandidate = (s: Suggestion) => {
    if (sel === null) return;
    tryMerge(sel, s.from === sel ? s.to : s.from);
    setPeek(null);
  };
  const rejectCandidate = (s: Suggestion) => {
    setEdits(rejectSuggestion(edits, s));
    setMsg("Anotado: no son la misma persona (no vuelve a proponerse y queda en las etiquetas).");
    if (peek === s) setPeek(null);
  };
  const removeSelected = () => {
    if (sel === null) return;
    setEdits(setRemoved(edits, sel, true));
    setSel(null);
  };
  // Enter accepts the notice of a name that already existed (Ctrl + Z undoes it).
  useEffect(() => {
    if (!notice) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Enter" || isTyping(el) || el?.tagName === "BUTTON") return;
      e.preventDefault();
      setNotice(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notice]);
  // While a candidate is being checked: Enter joins, X says no, R plays it again, Esc closes.
  const peekKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    peekKeys.current = (e: KeyboardEvent) => {
      if (!peek) return;
      const el = e.target as HTMLElement | null;
      if (isTyping(el)) return;
      const k = e.key.toLowerCase();
      if (k === "enter") joinCandidate(peek);
      else if (k === "x") rejectCandidate(peek);
      else if (k === "r") peekAt(peek);
      else if (k === "escape") setPeek(null);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => peekKeys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const dropStretch = (from: number, to: number) => {
    if (!data || sel === null) return;
    setEdits(dropRange(edits, data, sel, from, to));
    setMsg("Cajas quitadas de su línea: no cuentan ni se exportan. Ctrl + Z lo deshace.");
  };
  const separateStretch = (from: number, to: number) => {
    if (!data || sel === null) return;
    const r = separateRange(edits, data, sel, from, to);
    if (r.identity === null) return setMsg("No hay nada que separar en ese tramo.");
    setEdits(r.edits);
    setMsg("El tramo es ahora otra persona; ella sigue igual antes y después. Ctrl + Z lo deshace.");
  };
  const splitAt = (f: number) => {
    if (!data || sel === null) return;
    const r = splitPerson(edits, sel, f, data);
    if (!r) return setMsg("Para partir hace falta que tenga algo antes y después de ese punto.");
    setEdits(r.edits);
  };

  // Places where a person is probably two: impossible jumps, short excursions to somebody else, changes of shirt.
  // Measured on the first corrected part: the changes of shirt were real changes of person 5 times out of 6; the big
  // jumps were nearly always the same player with a wrong position (feet hidden), which the export cleans by itself.
  const allCutHints = cutAll.filter((h) => !refIds.has(h.person));
  const hints = allCutHints.filter((h) => h.kind === "team");
  const hintsByPerson = new Map<number, CutHint[]>();
  for (const h of hints) hintsByPerson.set(h.person, [...(hintsByPerson.get(h.person) ?? []), h]);
  const listed = listedAll.slice(0, listLimit);
  const hintText = (h: CutHint) =>
    h.kind === "excursion"
      ? `se va ${h.seconds?.toFixed(1)} s a ${h.meters?.toFixed(0)} m y vuelve`
      : h.kind === "jump"
        ? `salta ${h.meters?.toFixed(0)} m de golpe${h.from ? ` y pasa de ${TEAM_LABELS[h.from].toLowerCase()} a ${TEAM_LABELS[h.to as TeamCode].toLowerCase()}` : ""}`
        : `su camiseta pasa de ${TEAM_LABELS[h.from as TeamCode].toLowerCase()} a ${TEAM_LABELS[h.to as TeamCode].toLowerCase()}`;
  const fixHint = (h: CutHint) => {
    if (!data) return;
    setEdits(applyHint(edits, data, h));
    setMsg(h.kind === "excursion" ? "Trozo separado: ahora es otra persona, y ella sigue igual antes y después. Ctrl + Z lo deshace." : "Cortada en ese punto. Ctrl + Z lo deshace.");
  };
  const doneCount = ppl.filter((p) => p.done).length;
  // Fragments of under a second that nobody has named: candidates to throw away in one go.
  const shortIds = ppl.filter((p) => p.frames.length < minFrames && !p.player_id && !p.done).map((p) => p.id);
  const shortDuplicates = useMemo(
    () => (data && modal === "cleanup" ? duplicatesAmong(data, edits, new Set(shortIds)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortIds is rebuilt on every render from data and edits
    [data, edits, colors, modal],
  );
  // Short pieces that sit where another person is, or where she would be while she is lost.
  // Worked out only when the cleaning dialog is open (all the short pieces against everybody is slow on a long part);
  // for the selected person, only her own.
  const absorbable = useMemo(
    () => (data && modal === "cleanup" ? suggestAbsorb(data, edits, ppl, new Set(shortIds)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortIds is rebuilt on every render from ppl
    [data, edits, ppl, modal],
  );
  const absorbFills = absorbable.filter((a) => a.adds > 0);
  const absorbForSel = useMemo(() => {
    if (!data || !selected) return [];
    const shortPeople = ppl.filter((p) => p.frames.length < minFrames && !p.player_id && !p.done);
    return suggestAbsorb(data, edits, [...shortPeople, selected], new Set(shortPeople.map((p) => p.id))).filter((a) => a.into === selected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- minFrames follows data
  }, [data, edits, ppl, selected]);
  const absorb = (list: typeof absorbable) => {
    if (!data || list.length === 0) return;
    const done = applyAbsorb(data, edits, list);
    setEdits(done.edits);
    if (sel !== null && list.some((a) => a.from === sel)) setSel(null);
    const left = list.length - done.joined;
    setMsg(
      `${done.joined} trozo(s) añadidos a su jugadora: ${done.frames} cuadro(s) recuperados.${left ? ` ${left} se quedaron fuera porque otro trozo ya ocupaba ese cuadro.` : ""} Ctrl + Z lo deshace.`,
    );
  };
  const discard = (ids: number[], what: string) => {
    if (ids.length === 0) return;
    setEdits(setRemovedMany(edits, ids));
    if (sel !== null && ids.includes(sel)) setSel(null);
    setMsg(`${ids.length} ${what} descartados. Se puede deshacer con Ctrl + Z.`);
  };
  const hiddenShort = ppl.length - ppl.filter((p) => p.frames.length >= minFrames).length;
  const count = (t: TeamCode) => ppl.filter((p) => p.team === t).length;
  const withConflicts = ppl.filter((p) => p.conflicts.length > 0).length;

  // Only the kits that have a colour: an empty one would be read as a colour by nobody.
  const defaultLabel = (id: number) => (id >= LOOSE_ID ? `s${id - LOOSE_ID}` : `#${id}`);
  const yamlLine = `jersey_colors: {${KIT_ORDER.filter((k) => colors[k]).map((k) => `${k}: "${colors[k]}"`).join(", ")}}`;
  // Written straight into match.yaml of the folder when the app runs next to the repository; otherwise through a file
  // dialog. The line replaces the jersey_colors already there (inside the video, if that is where it was).
  const putColors = (text: string) => {
    const line = /^([ \t]*)jersey_colors:.*$/m;
    return line.test(text)
      ? text.replace(line, (_all, indent: string) => indent + yamlLine)
      : `${text.replace(/\s*$/, "")}\n\n# Colores de camiseta para asignar equipos en el tracking (elegidos en la app)\n${yamlLine}\n`;
  };
  const writeYaml = async () => {
    const local = await readLocal(`matches/${mid}/match.yaml`);
    if (local !== null) {
      if (!new RegExp(`^match_id:\\s*["']?${mid}["']?\\s*(#.*)?$`, "m").test(local)) return setMsg(`El match.yaml de la carpeta no es de ${mid}; no lo toqué.`);
      const ok = await writeLocal(`matches/${mid}/match.yaml`, putColors(local));
      return setMsg(ok ? `Colores escritos en matches/${mid}/match.yaml. Las próximas corridas de process los usarán.` : "No se pudo escribir match.yaml.");
    }
    const picker = (window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<WritableHandle[]> }).showOpenFilePicker;
    if (!picker) return setMsg("Este navegador no deja escribir archivos desde la página. Copia la línea y pégala en match.yaml.");
    try {
      const [h] = await picker({ types: [{ description: "match.yaml", accept: { "text/yaml": [".yaml", ".yml"] } }] });
      const text = await (await h.getFile()).text();
      if (!new RegExp(`^match_id:\\s*["']?${mid}["']?\\s*(#.*)?$`, "m").test(text)) {
        return setMsg(`Ese archivo no es el match.yaml de ${mid}; no lo toqué.`);
      }
      const next = putColors(text);
      const w = await h.createWritable();
      await w.write(next);
      await w.close();
      setMsg("Colores escritos en match.yaml. Las próximas corridas de process los usarán.");
    } catch {
      // Picker cancelled: nothing to do.
    }
  };

  // Path of every person on the pitch, as measured: detections inside the pitch plus hand marks.
  const paths = useMemo(() => (data ? measuredPaths(data, edits) : new Map<number, TrackPoint[]>()), [data, edits]);

  const listW = Math.min(LIST_MAX_PX, Math.max(LIST_MIN_PX, Number(usePref("correction:listW", "496")) || 496));
  const layoutRef = useRef<HTMLDivElement>(null);
  const dragDivider = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = layoutRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      // The video keeps at least VIDEO_MIN_PX; the list between LIST_MIN_PX and LIST_MAX_PX.
      const w = Math.round(box.right - ev.clientX);
      setPref("correction:listW", String(Math.min(LIST_MAX_PX, box.width - VIDEO_MIN_PX, Math.max(LIST_MIN_PX, w))));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const ballHere = pf !== null ? (ball.find((b) => b.frame === pf) ?? null) : null;
  const ballMarkHere = pf !== null ? ((edits.ball ?? []).find((b) => b.frame === pf) ?? null) : null;

  const smoothOpt: SmoothOptions | null = data
    ? {
        fps: data.fps,
        stride: data.stride,
        // Speeds are judged in real meters, not in units of the normalised pitch.
        metersPerUnit: metersPerUnit(data),
        ...smoothCfg,
      }
    : null;
  // Cleaning every person is slow on a long part: done when the export dialog is open (for its totals) and on export.
  const cleanAll = () => {
    const out = new Map<number, { points: TrackPoint[]; report: SmoothReport }>();
    if (!smoothOpt) return out;
    for (const [id, pts] of paths) out.set(id, smoothTrack(pts, smoothOpt));
    return out;
  };
  const cleaned = useMemo(
    () => (modal === "export" ? cleanAll() : new Map<number, { points: TrackPoint[]; report: SmoothReport }>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- smoothOpt is rebuilt on every render from these values
    [paths, data, smoothCfg, modal],
  );
  const selCleaned = useMemo(
    () => (smoothOpt && sel !== null && paths.get(sel) ? smoothTrack(paths.get(sel) as TrackPoint[], smoothOpt) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- smoothOpt is rebuilt on every render from these values
    [paths, data, smoothCfg, sel],
  );
  // The players with a name, cleaned as they will be saved: what the pitch shows in «Con nombre». Only theirs (a
  // dozen paths), so it is quick to work out.
  const namedSmooth = useMemo(() => {
    const out = new Map<number, Map<number, TrackPoint>>();
    if (pitchShow !== "named") return out;
    for (const p of ppl) {
      const pts = p.player_id ? paths.get(p.id) : undefined;
      if (!pts) continue;
      const clean = smoothOpt && smoothOn ? smoothTrack(pts, smoothOpt).points : pts;
      out.set(p.id, new Map(clean.map((q) => [q.frame, q])));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- smoothOpt is rebuilt on every render from these values
  }, [pitchShow, ppl, paths, data, smoothCfg, smoothOn]);
  const totals = [...cleaned.values()].reduce(
    (t, c) => ({ outliers: t.outliers + c.report.outliers, filled: t.filled + c.report.filled, openGaps: t.openGaps + c.report.openGaps }),
    { outliers: 0, filled: 0, openGaps: 0 },
  );

  // Holes that the export will leave empty (shorter ones are filled by the smoothing): what is worth fixing by hand.
  // Holes worth a look: where she was lost in the middle of the image, for more than FIX_GAP_S or reappearing too far
  // to have got there. Holes at the edge of the image (she left the frame) are off camera: nothing to fix there.
  const gapsOf = (p: Person) => (data ? p.gaps.filter((g) => (g[1] - g[0]) / fps > FIX_GAP_S && !offCamera(data, edits, p.id, g)) : []);
  const selGaps = selected ? gapsOf(selected) : [];
  const selOffCamera = selected && data ? selected.gaps.filter((g) => (g[1] - g[0]) / fps >= 0.5 && offCamera(data, edits, selected.id, g)) : [];
  const withGaps = ppl.filter((p) => p.frames.length >= minFrames && p.gaps.length > 0 && gapsOf(p).length > 0).length;
  // The next open hole of the selected person after the current frame (from the start again after the last one).
  // g: inside a hole, one second further; otherwise one second into the next hole (from the start again after the
  // last). Lands where she should be: join the box that is her there, or mark her feet by hand (p).
  const nextGap = () => {
    const gaps = selGaps;
    if (gaps.length === 0) return;
    const sec = Math.round(fps);
    const inside = gaps.find(([a, b]) => frame >= a && frame < b - stride);
    if (inside && frame + sec < inside[1]) return seekFrame(frame + sec);
    const next = gaps.find(([a]) => a > frame + stride && (!inside || a >= inside[1])) ?? gaps[0];
    seekFrame(Math.min(next[0] + sec, next[1] - stride));
  };
  // c: the next change of shirt of the selected person; d: the next frame where she has two boxes.
  const nextOf = (frames: number[]) => {
    if (frames.length === 0) return;
    const f = frames.find((x) => x > frame + stride) ?? frames[0];
    seekFrame(f);
  };
  // What is left to check on a person, and the first place where it is.
  const problemsOf = (p: Person) => ({ gaps: gapsOf(p), conflicts: p.conflicts, hints: hintsByPerson.get(p.id) ?? [] });
  const firstProblem = (p: Person): number | null => {
    const pr = problemsOf(p);
    const sec = Math.round(fps);
    const at = [
      ...pr.gaps.map(([a, b]) => Math.min(a + sec, b - stride)),
      ...pr.conflicts,
      ...pr.hints.map((h) => Math.max(data?.start_frame ?? 0, h.frame - sec)),
    ];
    return at.length ? Math.min(...at) : null;
  };
  const goToPerson = (p: Person) => {
    setSel(p.id);
    setMode(null);
    const f = firstProblem(p);
    seekFrame(f ?? p.first);
  };
  // After verifying one: the next in the list that still needs work, ours with a name and something to check first.
  const goToNextToReview = (except: number) => {
    const open = listedAll.filter((p) => !p.done && p.id !== except);
    const has = (p: Person) => firstProblem(p) !== null;
    const next =
      open.find((p) => p.player_id && p.team === "own" && has(p)) ??
      open.find((p) => p.player_id && has(p)) ??
      open.find((p) => p.player_id && p.team === "own") ??
      open[0];
    if (next) goToPerson(next);
    else setSel(null);
    return next;
  };
  const toggleChecked = () => {
    if (!selected) return;
    const r = finishIfComplete(setPerson(edits, selected.id, { done: !selected.done }));
    setEdits(r.edits);
    const who = label(selected, selected.id);
    if (selected.done) return setMsg(r.note || `${who}: vuelve a revisión.`);
    const next = goToNextToReview(selected.id);
    setMsg(
      r.note ||
        `${who} verificada.${selected.player_id ? "" : " Sin nombre no cuenta para la parte."}${next ? ` Sigue ${label(next, next.id)}.` : " No queda nadie por revisar en la lista."}`,
    );
  };
  // Keys for the selected person: s split here, n next candidate, g next hole, c next change of shirt, d next frame
  // with two boxes, v verified, Supr not a player.
  const selKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    selKeys.current = (e: KeyboardEvent) => {
      if (!selected || view !== "players" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (isTyping(el)) return;
      const k = e.key.toLowerCase();
      if (k === "s" && canSplit) splitHere(e.shiftKey);
      else if (k === "n") {
        const list = [...cand.next, ...cand.prev];
        if (list.length === 0) return;
        peekAt(list[(peek ? list.indexOf(peek) + 1 : 0) % list.length]);
      } else if (k === "g") nextGap();
      else if (k === "c") nextOf((hintsByPerson.get(selected.id) ?? []).map((h) => Math.max(data?.start_frame ?? 0, h.frame - Math.round(fps))));
      else if (k === "d") nextOf(selected.conflicts);
      else if (k === "v") toggleChecked();
      else if (e.key === "Delete") removeSelected();
      else return;
      e.preventDefault();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => selKeys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pieces near the selected person: who she could go on as or come from, and pieces without a name of her team (or
  // without team) that are seen during her holes to check. The ones worth joining.
  const nearSel = (() => {
    if (!selected) return [] as Person[];
    const ids = new Set([...cand.next.map((x) => x.to), ...cand.prev.map((x) => x.from)]);
    for (const [a, b] of selGaps)
      for (const p of ppl)
        if (!p.player_id && p.id !== selected.id && (p.team === selected.team || p.team === "unk") && p.first < b && p.last > a && !refIds.has(p.id)) ids.add(p.id);
    return [...ids].flatMap((id) => (personById.get(id) ? [personById.get(id) as Person] : [])).slice(0, 12);
  })();

  const exportFixed = () => {
    if (!data) return;
    const cleaned = smoothOn ? cleanAll() : new Map<number, { points: TrackPoint[]; report: SmoothReport }>();
    const totals = [...cleaned.values()].reduce(
      (t, c) => ({ outliers: t.outliers + c.report.outliers, filled: t.filled + c.report.filled, openGaps: t.openGaps + c.report.openGaps }),
      { outliers: 0, filled: 0, openGaps: 0 },
    );
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const byFrameOut = new Map<number, { id: number; x: number; y: number; source: string; raw?: [number, number] }[]>();
    for (const id of paths.keys()) {
      if (refIds.has(id)) continue;
      const pts = smoothOn ? (cleaned.get(id)?.points ?? []) : [...(paths.get(id) ?? [])].sort((u, v) => u.frame - v.frame);
      for (const q of pts) {
        const row = { id, x: r2(q.x), y: r2(q.y), source: q.source, ...(q.raw ? { raw: [r2(q.raw[0]), r2(q.raw[1])] as [number, number] } : {}) };
        const list = byFrameOut.get(q.frame);
        if (list) list.push(row);
        else byFrameOut.set(q.frame, [row]);
      }
    }
    const out = {
      schema_version: 2,
      kind: "tracks_fixed",
      match_id: data.match_id,
      video_id: data.video_id,
      fps: data.fps,
      // Real size of the venue: positions are normalised to 105 x 68, distances are measured in these meters.
      venue: data.venue?.length_m && data.venue?.width_m ? { length_m: data.venue.length_m, width_m: data.venue.width_m } : null,
      start_frame: data.start_frame,
      end_frame: data.end_frame,
      stride: data.stride,
      // How the paths were cleaned; null when exported as measured.
      // max_fill_s null: every hole filled, whatever its length.
      smoothing: smoothOn ? { max_speed_ms: smoothCfg.maxSpeedMs, max_fill_s: Number.isFinite(smoothCfg.maxFillS) ? smoothCfg.maxFillS : null, window_s: smoothCfg.windowS, ...totals } : null,
      people: ppl.filter((q) => !refIds.has(q.id)).map((q) => ({ id: q.id, team: q.team, player_id: q.player_id || null, tracks: q.tracks })),
      // Ball on the pitch: "manual" (clicked on the video), "event" (a tagged event) or "interpolated". Never detected.
      ball: ball.map((b) => ({ frame: b.frame, x: r2(b.x), y: r2(b.y), source: b.source })),
      // Positions in the normalised pitch. source: "auto" (detected), "manual" (feet marked by hand) or "interpolated"
      // (filled inside a short hole; never a measurement). `raw` is the measured position when smoothing moved it.
      frames: data.frames.map((fr) => ({ frame: fr.frame, positions: byFrameOut.get(fr.frame) ?? [] })),
    };
    void saveFixed(`tracks_fixed_${data.video_id}_${data.start_frame}_${data.end_frame}.json`, JSON.stringify(out)).then(
      (ok) => ok && setMsg((m) => `${m} Guardado también en matches/${mid}/tracking/.`),
    );
    void saveLabels(data, edits);
    setMsg(
      smoothOn
        ? `Guardado con suavizado: ${totals.outliers} microsalto(s) quitado(s), ${totals.filled} posición(es) rellenada(s) en huecos cortos y ${totals.openGaps} hueco(s) dejado(s) vacío(s).`
        : "Guardado tal como se midió, sin suavizar ni rellenar.",
    );
  };

  // Several parts of the video in one file: this one plus the ones loaded for it, each with its own corrections.
  const editsOf = (f: TracksFile) => state.trackEdits.find((e) => e.key === editsKey(f));
  const allParts: Part[] = data ? [data, ...extra.filter((f) => editsKey(f) !== key && f.match_id === data.match_id && f.video_id === data.video_id)].map((file) => ({ file, edits: editsOf(file) })) : [];
  const onExtra = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!data || files.length === 0) return;
    const read: TracksFile[] = [];
    let skipped = 0;
    for (const f of files) {
      try {
        const d = JSON.parse(await f.text()) as TracksFile;
        if (Array.isArray(d.frames) && d.match_id === data.match_id && d.video_id === data.video_id && d.stride === data.stride) read.push(d);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    setExtra((cur) => {
      const byKey = new Map([...cur, ...read].map((f) => [editsKey(f), f]));
      return [...byKey.values()].sort((a, b) => a.start_frame - b.start_frame);
    });
    setMsg(`${read.length} parte(s) añadida(s).${skipped ? ` ${skipped} archivo(s) no eran partes de este video (o se procesaron con otro salto de cuadros).` : ""}`);
  };
  const addFolderParts = async () => {
    if (!data) return;
    const names = (await listLocal(`matches/${mid}/tracking`))?.filter((f) => TRACKS_PART.test(f.name) && f.name.startsWith(`tracks_${data.video_id}_`)).map((f) => f.name);
    if (!names) return setMsg("No se puede leer la carpeta del partido desde aquí: añade las partes a mano.");
    const files = (await Promise.all(names.map((n) => localFile(`matches/${mid}/tracking/${n}`)))).filter((f): f is File => f !== null);
    await onExtra(asEvent(files));
  };
  // Besides the download, the corrected file is written to the tracking folder of the match when it can be.
  const saveFixed = async (name: string, text: string) => {
    const ok = await writeLocal(`matches/${mid}/tracking/${name}`, text);
    if (!ok) downloadText(name, text, "application/json");
    return ok;
  };
  // The corrections as labels (labels_<video>_<start>_<end>.json), for sportsan.tracking.evaluate. Into the tracking
  // folder when it can be written; downloaded otherwise.
  const saveLabels = async (file: TracksFile, e: TrackEdits | undefined) => {
    const name = labelsName(file);
    const text = JSON.stringify(buildLabels(file, e ?? emptyEdits(editsKey(file)), colors));
    const ok = await writeLocal(`matches/${mid}/tracking/${name}`, text);
    if (!ok) downloadText(name, text, "application/json");
    return ok;
  };
  const exportJoined = () => {
    if (!data || allParts.length < 2) return;
    try {
      const eventsBall = attack ? allParts.flatMap((p) => eventBall(p.file, matchEvents, attack === "right")) : [];
      // Referees out of every part (unless shown), as in the table.
      const parts = showRefs ? allParts : allParts.map((p) => ({ ...p, edits: withoutReferees(p.file, p.edits ?? emptyEdits(editsKey(p.file)), colors) }));
      const out = joinParts(parts, { colors, smooth: smoothOn ? smoothCfg : null, ball: eventsBall });
      void saveFixed(`tracks_fixed_${out.video_id}_${out.start_frame}_${out.end_frame}.json`, JSON.stringify(out)).then(
        (ok) => ok && setMsg((m) => `${m} Guardado también en matches/${mid}/tracking/.`),
      );
      for (const p of allParts) void saveLabels(p.file, p.edits);
      const linked = out.parts.reduce((n, p) => n + p.linked_to_previous, 0);
      setMsg(
        `Exportadas ${out.parts.length} partes en un archivo: ${out.people.length} personas (${out.people.filter((p) => p.player_id).length} con nombre), ${linked} enlazadas entre partes por posición y ${out.ball.length} posiciones de balón.`,
      );
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "No se pudieron unir las partes.");
    }
  };

  // Path of the selected person around the current frame, measured and cleaned, to see what the cleaning does.
  const trail = (pts: TrackPoint[] | undefined) => (pts ?? []).filter((q) => Math.abs(q.frame - frame) <= fps * 4);
  const selRaw = sel !== null ? trail(paths.get(sel)) : [];
  const selClean = sel !== null && smoothOn ? trail(selCleaned?.points) : [];
  const selReport = selCleaned?.report;
  // Unbroken pieces of a path, for drawing lines that do not cross the holes left open.
  const pieces = (pts: TrackPoint[]) => {
    const out: TrackPoint[][] = [];
    for (const q of pts) {
      const last = out[out.length - 1];
      if (last && q.frame - last[last.length - 1].frame <= stride * 1.5) last.push(q);
      else out.push([q]);
    }
    return out.filter((piece) => piece.length > 1);
  };

  // One person of the list (also the selected one, in her own panel above the list).
  const renderRow = (p: Person) => {
    const isSel = p.id === sel;
    return (
      <li
        key={p.id}
        className={`grid grid-cols-[0.9rem_5.5rem_1.15rem_minmax(4rem,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1 transition-colors ${
          isSel ? "bg-accent/15 shadow-[inset_0_0_0_1px_rgba(74,114,255,.5)]" : "hover:bg-raised/50"
        } ${p.done && !isSel ? "opacity-55" : ""}`}
      >
        <button
          type="button"
          aria-label={`Seleccionar a ${label(p, p.id)}`}
          className="h-3.5 w-3.5 rounded-sm shadow-[inset_0_0_0_1px_rgba(255,255,255,.25)]"
          style={{ background: labToHex(p.lab) }}
          title={`Color medido de su camiseta · tracks ${p.tracks.slice(0, 8).join(", ")}${p.tracks.length > 8 ? "…" : ""} · clic para seleccionar`}
          onClick={() => pickBox(p.id)}
        />
        {/* The name is typed here and is the person's id from then on. Enter or leaving the field saves it. */}
        <input
          key={`${p.id}:${p.player_id}`}
          className="tc w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs text-ink placeholder:text-faint hover:border-line focus:border-accent focus:bg-bg focus:outline-none"
          aria-label="Nombre o número de esta persona"
          title="Escribe su número o nombre. Si ya lo tiene otra persona, se unen."
          defaultValue={p.player_id}
          placeholder={`${defaultLabel(p.id)}${p.keeper ? " P" : ""}`}
          onFocus={() => setSel(p.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = p.player_id;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v !== p.player_id) rename(p, v);
          }}
        />
        <select
          className="dot-select"
          aria-label={`Equipo: ${TEAM_LABELS[p.team]}${p.teamByHand ? " (puesto a mano)" : " (por el color de la camiseta)"}`}
          title={`${TEAM_LABELS[p.team]}${p.teamByHand ? " · puesto a mano" : " · por el color de la camiseta"}`}
          data-hand={p.teamByHand ? "" : undefined}
          value={p.teamByHand ? p.team : ""}
          onChange={(e) => setEdits(setPerson(edits, p.id, { team: e.target.value === "" ? null : (e.target.value as TeamCode) }))}
          style={{ backgroundColor: TEAM_COLORS[p.team] }}
        >
          <option value="">Por el color de la camiseta</option>
          {(["own", "opp", "ref", "unk"] as const).map((t) => (
            <option key={t} value={t}>
              {TEAM_LABELS[t]}
            </option>
          ))}
        </select>
        <span
          className="relative h-3 cursor-pointer rounded-full bg-bg/70"
          role="presentation"
          title={gapsOf(p).length ? `${gapsOf(p).length} hueco(s) que quedarán vacíos: clic para ir` : "Sin huecos que queden vacíos"}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setSel(p.id);
            seekFrame(Math.round((data?.start_frame ?? 0) + ((e.clientX - r.left) / r.width) * span));
          }}
        >
          {runs(p).map(([a, b]) => (
            <span key={a} className="absolute inset-y-0 rounded-full" style={{ left: `${pos(a)}%`, width: `${Math.max(0.6, pos(b) - pos(a))}%`, background: TEAM_COLORS[p.team] }} />
          ))}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-faint">
          <span className="tc">{((p.frames.length * stride) / fps).toFixed(1)} s</span>
          {(() => {
            const g = gapsOf(p);
            return g.length > 0 ? (
              <button
                type="button"
                className="tc inline-flex items-center gap-0.5 rounded-md bg-danger/15 px-1 text-danger"
                aria-label={`${g.length} hueco(s) por revisar: ir al primero`}
                title={`${g.length} hueco(s) por revisar (en medio de la imagen, más de ${FIX_GAP_S} s): clic para ir al primero`}
                onClick={() => {
                  setSel(p.id);
                  setMode(null);
                  seekFrame(Math.min(g[0][0] + Math.round(fps), g[0][1] - stride));
                }}
              >
                <CircleDashed size={11} weight="bold" />
                {g.length}
              </button>
            ) : null;
          })()}
          {p.conflicts.length > 0 && (
            <button
              type="button"
              className="tc inline-flex items-center gap-0.5 rounded-md bg-warn/15 px-1 text-warn"
              aria-label={`Dos cajas a la vez en ${p.conflicts.length} cuadro(s): ir al primero`}
              title={`Tiene dos cajas a la vez en ${p.conflicts.length} cuadro(s): clic para ir al primero y elegir la buena`}
              onClick={() => {
                setSel(p.id);
                setMode(null);
                seekFrame(p.conflicts[0]);
              }}
            >
              <Warning size={11} weight="fill" />
              {p.conflicts.length}
            </button>
          )}
          <button
            type="button"
            aria-pressed={p.done}
            aria-label={p.done ? "Completa: clic para volver a revisarla" : "Marcar como completa"}
            title={p.done ? "Completa: clic para volver a revisarla" : "Marcar como completa: ya no hay nada que corregirle"}
            className={`transition-colors ${p.done ? "text-ok" : "text-faint hover:text-ink"}`}
            onClick={() => {
              const r = finishIfComplete(setPerson(edits, p.id, { done: !p.done }));
              setEdits(r.edits);
              if (r.note) setMsg(r.note);
              else if (!p.done && !p.player_id) setMsg("Marcada como completa, pero sin nombre: para que cuente en la parte, ponle su nombre.");
              if (!p.done && hideDone && p.id === sel) setSel(null);
            }}
          >
            <CheckCircle size={15} weight={p.done ? "fill" : "regular"} />
          </button>
          {hintsByPerson.has(p.id) && (
            <IconButton
              label={`Su camiseta cambia de equipo (${hintsByPerson.get(p.id)?.length}): ver dónde`}
              tone="accent"
              onClick={() => {
                setSel(p.id);
                setMode(null);
                seekFrame(Math.max(data?.start_frame ?? 0, (hintsByPerson.get(p.id)?.[0].frame ?? p.first) - Math.round(fps)));
              }}
            >
              <TShirt size={14} weight="fill" className="text-warn" />
            </IconButton>
          )}
          {sel !== null && !isSel && (
            <IconButton label={`Es la misma que ${label(selected ?? undefined, sel)}: unir`} onClick={() => tryMerge(sel, p.id)}>
              <ArrowsMerge size={14} />
            </IconButton>
          )}
        </span>
      </li>
    );
  };

  // ---------------------------------------------------------------- quick review
  // Names on a few frames (one every few seconds) spread to the whole part by the model of lib/quick.ts. The model
  // always starts from the program's proposal (with the ball and the boxes left out kept), so it can be run again.
  const qSamples = useMemo(() => (data ? sampleFrames(data, qEvery) : []), [data, qEvery]);
  const qLabels: QuickLabel[] = useMemo(() => edits.quick?.labels ?? [], [edits.quick]);
  const qSeen = useMemo(() => edits.quick?.seen ?? [], [edits.quick]);
  const qBase = useMemo(() => ({ ...emptyEdits(key), ball: edits.ball, dropped: edits.dropped }), [key, edits.ball, edits.dropped]);
  const qModel = useMemo(() => (data && view === "quick" ? quickModel(data, qBase, qLabels, qSeen) : null), [data, view, qBase, qLabels, qSeen]);
  const qFrame = qSamples[Math.min(qIdx, qSamples.length - 1)] ?? null;
  const qf = qMode === "player" ? pf : qFrame;
  const qRefs = useMemo(() => (data ? fileTeamRefs(data) : {}), [data]);
  const qRoster = useMemo(() => [...(state.roster ?? [])].sort((a, b) => (a.number ?? 999) - (b.number ?? 999)), [state.roster]);
  const qNumber = new Map(qRoster.map((r) => [r.player_id, r.number]));
  const qBoxes = qf !== null ? (byFrame.get(qf)?.boxes ?? []).filter((b) => !isDropped(droppedBoxes, b, qf)) : [];
  const qLabelAt = (track: number) => qLabels.find((l) => l.frame === qf && l.track === track);
  const qPred = (track: number) => (qf !== null ? qModel?.nameOf.get(`${qf}:${track}`) : undefined);
  // Boxes of the chosen team on the pitch that still have no name here: the ones the analyst types, left to right.
  const qNeeding = (labels = qLabels) =>
    qBoxes
      .filter((b) => b[11] && !labels.some((l) => l.frame === qf && l.track === b[0]) && !qPred(b[0]))
      .filter((b) => {
        const t = boxTeamOf(b, qRefs);
        return t === qTeam || t === "unk";
      })
      .sort((a, b) => a[1] - b[1]);
  // The box being named: the one clicked, or else the first one still without a name.
  const qSel = qPicked ?? qNeeding()[0]?.[0] ?? null;
  const qSetLabels = (labels: QuickLabel[], seen = qSeen) => setEdits({ ...edits, quick: { labels, seen, done: edits.quick?.done } });
  const qGo = (i: number) => {
    const j = Math.max(0, Math.min(qSamples.length - 1, i));
    setQIdx(j);
    setQTyped("");
    setQPicked(null);
    if (qSamples[j] !== undefined) seekFrame(qSamples[j]);
  };
  const qName = (n: number) => (qTeam === "own" ? (qRoster.find((r) => r.number === n)?.player_id ?? `#${n}`) : `R${n}`);
  const qGive = (name: string, track = qSel) => {
    if (qFrame === null || track === null) return;
    const team = name === NOBODY ? undefined : qTeam;
    const labels = [...qLabels.filter((l) => !(l.frame === qFrame && l.track === track)), { frame: qFrame, track, name, ...(team ? { team } : {}) }];
    qSetLabels(labels);
    setQPicked(qNeeding(labels).find((b) => b[0] !== track)?.[0] ?? null);
  };
  // Enter: what the model proposes in this frame is right; on to the next sample.
  const qConfirm = () => {
    if (qFrame === null) return;
    const add: QuickLabel[] = qBoxes.flatMap((b) => {
      const pred = qPred(b[0]);
      if (!pred || qLabelAt(b[0])) return [];
      const team = qNumber.has(pred) ? "own" : pred.startsWith("R") ? "opp" : qTeam;
      return [{ frame: qFrame, track: b[0], name: pred, team }];
    });
    qSetLabels([...qLabels, ...add], [...new Set([...qSeen, qFrame])]);
    qGo(qIdx + 1);
  };
  // ---- one player at a time
  const qCp = useMemo(
    () =>
      data && qModel && qMode === "player" && qPlayer
        ? nextCheckpoint(data, qBase, qModel, qPlayer, (b) => boxTeamOf(b, qRefs), qPlayerTeam, qAfter)
        : null,
    [data, qModel, qMode, qPlayer, qBase, qRefs, qPlayerTeam, qAfter],
  );
  // The video goes to each stop by itself.
  useEffect(() => {
    if (view === "quick" && qCp) seekFrame(qCp.frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the stop changes
  }, [view, qCp?.frame, qCp?.kind, qPlayer]);
  const qPickPlayer = (name: string, team: "own" | "opp") => {
    setQPlayer(name);
    setQPlayerTeam(team);
    const mine = qLabels.filter((l) => l.name === name).map((l) => l.frame);
    setQAfter(mine.length ? Math.max(...mine) : (data?.start_frame ?? 0) - 1);
  };
  const qLabelPlayer = (frame: number, track: number, name = qPlayer) => {
    if (!name) return;
    const team = name === NOBODY ? undefined : qPlayerTeam;
    qSetLabels([...qLabels.filter((l) => !(l.frame === frame && l.track === track)), { frame, track, name, ...(team ? { team } : {}) }]);
    setQAfter(frame);
  };
  const qBoxOfPlayer = qPlayer ? qBoxes.find((b) => (qLabelAt(b[0])?.name ?? qPred(b[0])) === qPlayer) : undefined;
  // Enter and X answer for the yellow box on screen (also after moving with the arrows); without one, for the stop.
  const qTarget = (): { frame: number; track: number } | null => {
    if (qf !== null && qBoxOfPlayer) return { frame: qf, track: qBoxOfPlayer[0] };
    return qCp && qCp.track !== null ? { frame: qCp.frame, track: qCp.track } : null;
  };
  const qConfirmPlayer = () => {
    const t = qTarget();
    if (t) qLabelPlayer(t.frame, t.track);
  };
  const qNotHer = () => {
    const t = qTarget();
    if (t) qLabelPlayer(t.frame, t.track, NOBODY);
  };
  const qNextPlayer = () => {
    const names = qRoster.map((r) => r.player_id);
    const i = qPlayer ? names.indexOf(qPlayer) : -1;
    if (names.length) qPickPlayer(names[(i + 1) % names.length], "own");
  };
  const qDone = edits.quick?.done ?? [];
  // Reviewed to the end of the part: counts for the part to be complete; on to the next one.
  const qMarkDone = () => {
    if (!qPlayer) return;
    const r = finishIfComplete({ ...edits, quick: { labels: qLabels, seen: qSeen, done: [...new Set([...qDone, qPlayer])] } });
    setEdits(r.edits);
    if (r.note) setMsg(r.note);
    qNextPlayer();
  };

  // Keys of the quick review (before the table's own: digits, Enter and the arrows mean something else here).
  const qKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    qKeys.current = (e: KeyboardEvent) => {
      if (view !== "quick") return;
      const el = e.target as HTMLElement | null;
      if (isTyping(el)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (qMode === "player") {
        if (/^\d$/.test(k)) setQTyped((t) => (t + k).slice(-2));
        else if (k === "Enter" && e.shiftKey && qPlayer) qMarkDone();
        else if (k === "Enter") {
          if (qTyped) {
            qPickPlayer(qName(Number(qTyped)), qTeam);
            setQTyped("");
          } else if (!qCp && qPlayer) qMarkDone();
          else qConfirmPlayer();
        } else if (k === "x" || k === "X") qNotHer();
        else if (k === "ArrowRight") seekFrame(frame + Math.round(fps));
        else if (k === "ArrowLeft") seekFrame(frame - Math.round(fps));
        else if (k === "Tab") qNextPlayer();
        else if (k === "a" || k === "s") setQTeam(k === "a" ? "own" : "opp");
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (/^\d$/.test(k)) setQTyped((t) => (t + k).slice(-2));
      else if (k === "Enter") {
        if (qTyped) {
          qGive(qName(Number(qTyped)));
          setQTyped("");
        } else qConfirm();
      } else if (k === "ArrowRight") qGo(qIdx + 1);
      else if (k === "ArrowLeft") qGo(qIdx - 1);
      else if (k === "-") qGive(NOBODY);
      else if (k === "Backspace" || k === "Delete") {
        if (qSel !== null) qSetLabels(qLabels.filter((l) => !(l.frame === qFrame && l.track === qSel)));
      } else if (k === "Tab") {
        const need = qNeeding();
        const i = need.findIndex((b) => b[0] === qSel);
        setQPicked(need[(i + 1) % Math.max(1, need.length)]?.[0] ?? null);
      } else if (k === "a" || k === "s") setQTeam(k === "a" ? "own" : "opp");
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => qKeys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Two digits wait a moment for each other; one alone is taken after the pause.
  useEffect(() => {
    if (!qTyped) return;
    const t = setTimeout(() => {
      if (qMode === "player") qPickPlayer(qName(Number(qTyped)), qTeam);
      else qGive(qName(Number(qTyped)));
      setQTyped("");
    }, 650);
    return () => clearTimeout(t);
  });
  // People checked (ticked) in the table now: adding the review leaves them exactly as they are.
  const checkedIds = new Set(Object.entries(edits.people).flatMap(([id, m]) => (m.done ? [Number(id)] : [])));
  // "add": the review is added to the table as it is (the checked players are not touched). "replace": the table is
  // rebuilt from the program's proposal and the review (the ticks of the checked players are kept by name).
  const qApply = (how: "add" | "replace") => {
    if (!data || !qModel) return;
    let applied: TrackEdits;
    let note: string;
    if (how === "add") {
      const r = applyQuickOnto(data, edits, qBase, qModel, checkedIds);
      applied = r.edits;
      note = `Revisión rápida agregada: ${r.moved} tramo(s) pasaron a su jugadora${r.kept ? `; ${r.kept} de jugadoras verificadas se dejaron como estaban` : ""}`;
    } else {
      applied = { ...applyQuick(data, qBase, qModel), quick: edits.quick, ballReview: edits.ballReview, ball: edits.ball, ballLinks: edits.ballLinks };
      // Players already checked in the table keep their tick (by name) when the review is applied again.
      const names = new Set(Object.values(edits.people).flatMap((m) => (m.done && m.player_id ? [m.player_id] : [])));
      for (const [id, m] of Object.entries(applied.people)) if (m.player_id && names.has(m.player_id)) applied = setPerson(applied, Number(id), { done: true });
      note = `Revisión rápida aplicada desde cero: ${new Set(qModel.segments.filter((x) => x.name).map((x) => x.name)).size} jugadoras con nombre`;
    }
    // A complete part: what is left over goes too.
    const st = partStatus(applied, { start_frame: data.start_frame, end_frame: data.end_frame, fps: data.fps, stride: data.stride }, eventBallFrames);
    const ppl2 = st.complete ? people(data, applied, colors) : [];
    const extra = st.complete && namedCount(ppl2) >= PLAYERS_DONE ? leftovers(ppl2, data.fps, data.stride) : [];
    setEdits(extra.length ? setRemovedMany(applied, extra) : applied);
    // Every hole is filled on export.
    setSmoothCfg({ ...smoothCfg, maxFillS: Number.POSITIVE_INFINITY });
    setView("players");
    setMode(null);
    setModal(null);
    setMsg(`${note}${extra.length ? `; parte completa, descartadas ${extra.length} personas sin nombre` : ""}. Ctrl + Z lo deshace.`);
  };
  // With players already checked, the button asks; otherwise the table is built from the review.
  const qApplyAsk = () => (checkedIds.size > 0 ? setModal("applyQuick") : qApply("replace"));


  // The zoom follows: the selected person (Jugadoras), where the ball was (Balón), or in the quick review the player of
  // the yellow ring (one at a time) or the box being named (samples). Without any, the whole video.
  const quickBox = view === "quick" ? (qMode === "player" ? qBoxOfPlayer : qBoxes.find((b) => b[0] === qSel)) : undefined;
  const quickCenter: [number, number] | null = quickBox ? [(quickBox[1] + quickBox[3]) / 2, (quickBox[2] + quickBox[4]) / 2] : null;
  const zoomTransform = zoomTo(view === "players" ? zoomCenter : view === "ball" ? ballCenter : view === "quick" ? quickCenter : null);

  if (!hydrated) return null;

  const kitsCard = (
    <Card title="Uniformes" note={mid} delay={120}>
      <div className="space-y-2.5">
        {KIT_ORDER.map((t) => (
          <div key={t} className={`flex flex-wrap items-center gap-2 ${t.endsWith("_gk") ? "pl-5" : ""}`}>
            <input
              type="color"
              aria-label={`Color de ${KIT_LABELS[t]}`}
              className="h-8 w-10 shrink-0 cursor-pointer rounded-lg bg-transparent"
              value={colors[t] || "#808080"}
              onChange={(e) => setColors({ ...colors, [t]: e.target.value })}
            />
            <span className="w-20 text-xs" style={{ color: TEAM_COLORS[KIT_TEAM[t]] }}>
              {KIT_LABELS[t]}
            </span>
            <span className="tc flex-1 text-[11px] text-faint">{colors[t] || "sin elegir"}</span>
            <button
              type="button"
              className={`btn !px-2 ${pickKit === t ? "btn-primary" : "btn-ghost"}`}
              aria-pressed={pickKit === t}
              title="Tomar el color con un clic sobre su camiseta en el video"
              onClick={() => setPickKit(pickKit === t ? null : t)}
            >
              <Eyedropper size={14} />
              del video
            </button>
            {selected && (
              <button
                type="button"
                className="btn btn-ghost !px-2"
                title="Usar el color que el programa midió en la camiseta de la persona seleccionada"
                onClick={() => setColors({ ...colors, [t]: labToHex(selected.lab) })}
              >
                de la seleccionada
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-pretty text-faint">
        Pulsa «del video» y haz clic sobre la camiseta de una jugadora de ese equipo (pausa antes, en un cuadro donde se vea bien y sin
        sombra). Con una parte cargada también puedes usar el color que el programa midió en la persona seleccionada. Los equipos de la
        lista cambian al momento; para que la unión automática los respete hay que escribirlos en match.yaml antes de procesar.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={KIT_ORDER.every((k) => !colors[k])} onClick={writeYaml}>
          <FloppyDisk size={15} />
          Escribir en match.yaml
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(yamlLine).then(() => setMsg("Línea copiada: pégala en match.yaml."))}>
          <Copy size={14} />
          Copiar la línea
        </button>
      </div>
    </Card>
  );

  // The ball has its own view (it is marked on the same video).
  // Ball view: one compact bar (the pitch goes beside the video); the events as ball positions, in a dialog.
  // The same measure as the status of the part and the strip under the video.
  const ballShare = status?.ball ?? 0;
  const ballBar = (
    <div className="rounded-2xl bg-surface/70 p-3 text-xs text-muted">
      <div className="flex items-center gap-2">
        <span className="tc min-w-[4.5rem] whitespace-nowrap text-ink-2">
          {Math.min(bIdx + 1, bSamples.length)}/{bSamples.length}
        </span>
        <div className="relative h-2 flex-1 rounded-full bg-bg/70" title={`Balón en el ${Math.round(100 * ballShare)} % del tiempo en juego (lo marcado como fuera no cuenta): la misma medida que la barra bajo el video y el estado de la parte`}>
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent/60" style={{ width: `${100 * ballShare}%` }} />
        </div>
        <span className="tc min-w-[2.75rem] text-right text-ink-2">{Math.round(100 * ballShare)} %</span>
        <button type="button" className={btn} onClick={bNotSeen} title="El balón no se ve o está fuera de juego: siguiente muestra (no cuenta como faltante)">
          No se ve / fuera <kbd className="kbd">Enter</kbd>
        </button>
        <IconButton
          label={ballLinkFrom !== null ? "Recta en curso: clic donde cae (i para cancelar)" : "Recta a mano (i): desde la última marca hasta donde cae, para pases largos o balones por alto"}
          tone={ballLinkFrom !== null ? "accent" : "default"}
          onClick={startBallLine}
        >
          <LineSegment size={15} weight={ballLinkFrom !== null ? "bold" : "regular"} />
        </IconButton>
        {/* Always in its place (disabled without a mark here), so the bar beside it does not move. */}
        <IconButton
          label={ballMarkHere ? "Quitar la marca de este cuadro (Supr)" : "Sin marca en este cuadro"}
          tone="danger"
          disabled={!ballMarkHere || pf === null}
          onClick={() => pf !== null && setEdits(removeBall(edits, pf))}
        >
          <Eraser size={15} />
        </IconButton>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          Clic en el balón · <kbd className="kbd">→</kbd> paso · <kbd className="kbd">Alt →</kbd> cuadro · <kbd className="kbd">Tab</kbd> dos pasos ·{" "}
          <kbd className="kbd">n</kbd> donde falta · <kbd className="kbd">i</kbd> recta hasta donde cae ·{" "}
          <kbd className="kbd">z</kbd> zoom
        </span>
        <label className="flex items-center gap-1.5" title="Las cajas de las jugadoras sobre el video (tecla h)">
          <input type="checkbox" className="accent-accent" checked={ballBoxes} onChange={(e) => setPref("ball:boxes", e.target.checked ? "1" : "0")} />
          Cajas <kbd className="kbd">h</kbd>
        </label>
        <label className="ml-auto flex items-center gap-1.5">
          Paso
          <select className={input} value={bEvery} onChange={(e) => (setPref("ball:every", e.target.value), bGo(0))}>
            {[0.5, 1, 2].map((v) => (
              <option key={v} value={v}>
                {v} s
              </option>
            ))}
          </select>
        </label>
        <IconButton label="Balón desde los eventos etiquetados…" onClick={() => setModal("ballEvents")}>
          <GearSix size={15} />
        </IconButton>
      </div>
    </div>
  );
  const ballEventsPanel = (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-muted">
          Partido de la app
          <select className={`${input} mt-1 w-full`} value={eventsMatchId} onChange={(e) => setPref(`ballMatch:${mid}`, e.target.value)}>
            <option value="">(ninguno)</option>
            {state.matches.map((m) => (
              <option key={m.match_id} value={m.match_id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-muted">
          En este video, el equipo analizado ataca hacia
          <select className={`${input} mt-1 w-full`} value={attack} onChange={(e) => setPref(`attack:${mid}:${data?.video_id}`, e.target.value)}>
            <option value="">(sin indicar: no se usan)</option>
            <option value="right">la derecha del dibujo (x = 105)</option>
            <option value="left">la izquierda del dibujo (x = 0)</option>
          </select>
        </label>
      </div>
      <p className="text-[11px] text-pretty text-faint">
        Los eventos etiquetados con posición dan el balón donde no hay una marca tuya a menos de {BALL_FILL_S} s. En esta parte:{" "}
        {ballKnown.filter((b) => b.source === "event").length} evento(s) con posición. La dirección de ataque también orienta el análisis.
      </p>
    </div>
  );
  // Short pieces, all at once.
  const cleanupPanel = (
                  <div className="text-xs text-muted">
                    {hints.length > 0 && (
                      <div className="mb-4 rounded-xl bg-warn-900/40 px-3 py-2">
                        <p className="text-[11px] text-pretty text-ink-2">
                          {hints.length} cambio(s) de camiseta sostenidos en {new Set(hints.map((h) => h.person)).size} persona(s): casi siempre son
                          dos personas unidas (en las partes corregidas, 5 de cada 6). Cortarlos todos deja cada trozo con un solo equipo; luego solo
                          hay que unir.
                        </p>
                        <button
                          type="button"
                          className={`${btn} mt-2`}
                          onClick={() => {
                            if (!data) return;
                            const r = applyTeamCuts(edits, data, hints);
                            setEdits(r.edits);
                            setMsg(`${r.cuts} corte(s) por cambio de camiseta. Ctrl + Z los deshace todos.`);
                          }}
                        >
                          <Scissors size={14} />
                          Cortar los {hints.length} cambios de camiseta
                        </button>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 text-ink-2">
                      <Broom size={14} />
                      {shortIds.length} trozos de menos de un segundo, sin nombre
                    </div>
                    <p className="mt-1 text-[11px] text-pretty text-faint">
                      {shortDuplicates.length} son una segunda caja sobre alguien que ya tiene la suya (siempre a menos de 1.5 m de otra
                      persona). Los otros {shortIds.length - shortDuplicates.length} aparecieron solos: una jugadora vista un instante, o una
                      detección falsa.
                    </p>
                    {absorbable.length > 0 && (
                      <div className="mt-2 rounded-xl bg-accent-900/40 px-3 py-2">
                        <p className="text-[11px] text-pretty text-ink-2">
                          {absorbable.length} encajan con una sola persona: {absorbFills.length} caen donde ella se pierde (le completan{" "}
                          {absorbFills.reduce((n, a) => n + a.adds, 0)} cuadros) y {absorbable.length - absorbFills.length} repiten una caja que
                          ya tiene.
                        </p>
                        <button type="button" className={`${btn} mt-2`} onClick={() => absorb(absorbable)}>
                          <MagicWand size={14} />
                          Añadir los {absorbable.length} a su jugadora
                        </button>
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className={btn} disabled={shortDuplicates.length === 0} onClick={() => discard(shortDuplicates, "duplicados")}>
                        Descartar los {shortDuplicates.length} duplicados
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => discard(shortIds, "trozos cortos")}>
                        Descartar los {shortIds.length}
                      </button>
                    </div>
                  </div>
  );
  const exportPanel = (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm text-ink">Suavizado</h3>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" className="accent-accent" checked={smoothOn} onChange={(e) => setSmoothOn(e.target.checked)} />
                Limpiar las trayectorias antes de exportar
              </label>
              <div className={`mt-4 space-y-4 ${smoothOn ? "" : "pointer-events-none opacity-40"}`}>
                {(
                  [
                    ["maxSpeedMs", "Velocidad máxima creíble", "m/s", 6, 12, 0.5, "Un punto que exigiría más que esto para llegar y para irse es un microsalto y se quita. Tampoco se rellena un hueco que exigiría más."],
                    ["maxFillS", "Hueco más largo que se rellena", "s", 0, 30, 0.5, "Entre dos posiciones conocidas se traza una recta, marcada como rellenada. Al tope (30) se rellenan todos, por largos que sean: sirve para la distancia total (las jugadoras suelen volver a su sitio)."],
                    ["windowS", "Ventana de suavizado", "s", 0, 1.5, 0.1, "Promedio centrado para quitar el temblor de la detección. 0 = sin suavizar."],
                  ] as const
                ).map(([k, name, unit, min, max, step, help]) => (
                  <label key={k} className="block text-xs text-muted">
                    <span className="flex items-baseline justify-between">
                      {name}
                      <span className="tc text-ink-2">
                        {Number.isFinite(smoothCfg[k]) ? `${smoothCfg[k]} ${unit}` : "todos"}
                      </span>
                    </span>
                    <input type="range" className="mt-1 w-full" min={min} max={max} step={step} value={Number.isFinite(smoothCfg[k]) ? smoothCfg[k] : max}
                      onChange={(e) => setSmoothCfg({ ...smoothCfg, [k]: k === "maxFillS" && Number(e.target.value) >= max ? Number.POSITIVE_INFINITY : Number(e.target.value) })} />
                    <span className="mt-0.5 block text-[11px] text-pretty text-faint">{help}</span>
                  </label>
                ))}
                <IconButton label="Volver a los valores recomendados" onClick={() => setSmoothCfg({ ...SMOOTH_DEFAULTS, maxFillS: Number.POSITIVE_INFINITY })}>
                  <ArrowCounterClockwise size={14} />
                </IconButton>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line-soft pt-4">
                {(
                  [
                    ["microsaltos quitados", totals.outliers, selReport?.outliers],
                    ["posiciones rellenadas", totals.filled, selReport?.filled],
                    ["huecos sin rellenar", totals.openGaps, selReport?.openGaps],
                  ] as const
                ).map(([name, all, one]) => (
                  <div key={name}>
                    <div className="num text-3xl text-ink-2">{smoothOn ? all : "–"}</div>
                    <div className="mt-1 text-[11px] text-muted">{name}</div>
                    {smoothOn && one !== undefined && <div className="tc mt-0.5 text-[11px] text-faint">{one} en la seleccionada</div>}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-pretty text-faint">
                En el archivo exportado cada posición dice de dónde sale: detectada, marcada a mano o rellenada. Una posición rellenada es
                una suposición razonable, no una medición. Las correcciones y el archivo de tracks no cambian: solo cambia lo que se
                exporta.
              </p>
      </section>
      <section className="border-t border-line-soft pt-5">
        <h3 className="mb-2 text-sm text-ink">Varias partes en un archivo</h3>
              <p className="text-xs text-pretty text-muted">
                Para una jugada o un tramo que cruza varias partes. Cada parte lleva las correcciones que ya le hiciste; las que no has
                tocado entran con sus identidades automáticas. Las personas con el mismo nombre son una sola en todo el archivo; las sin
                nombre se enlazan entre partes seguidas cuando está claro quién es quién. El suavizado se aplica después de unir.
              </p>
              <ul className="mt-3 space-y-1 text-xs">
                {allParts.map((p) => (
                  <li key={editsKey(p.file)} className="flex items-center gap-2">
                    <span className="tc text-ink-2">
                      {fmtT(p.file.start_frame / p.file.fps)} – {fmtT(p.file.end_frame / p.file.fps)}
                    </span>
                    <span className={hasCorrections(p.edits) ? "text-ok" : "text-faint"}>{hasCorrections(p.edits) ? "corregida" : "sin corregir"}</span>
                    {p.file === data ? (
                      <span className="ml-auto text-faint">la que está abierta</span>
                    ) : (
                      <span className="ml-auto">
                        <IconButton label="Quitar de la lista" onClick={() => setExtra(extra.filter((f) => f !== p.file))}>
                          <X size={14} />
                        </IconButton>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <label className={`${btn} cursor-pointer`}>
                  <FolderOpen size={15} />
                  Añadir partes
                  <input type="file" accept=".json" multiple className="sr-only" onChange={onExtra} />
                </label>
                <button type="button" className={btn} onClick={() => void addFolderParts()} title="Añade todas las partes de este video que hay en la carpeta del partido">
                  <Stack size={15} />
                  Todas las de la carpeta
                </button>
                <button type="button" className={btnPrimary} disabled={allParts.length < 2} onClick={exportJoined}>
                  <Stack size={15} />
                  Exportar {allParts.length} partes unidas
                </button>
              </div>
      </section>
    </div>
  );


  // A ring at her feet and the name under it (a frame around the box covers the head, which is what tells players
  // apart). The box itself stays, invisible, to be clicked.
  const footRing = (b: (typeof qBoxes)[number], color: string, strong: boolean, dashed: boolean) => {
    const w = b[3] - b[1];
    const rx = Math.max(dotR * 1.5, w * 0.7);
    return (
      <ellipse cx={(b[1] + b[3]) / 2} cy={b[4]} rx={rx} ry={rx * 0.32} fill={strong ? "rgba(253,224,71,.18)" : "none"} stroke={color}
        strokeWidth={strong ? dotR / 1.7 : dotR / 4.5} strokeDasharray={dashed ? `${dotR} ${dotR / 2}` : undefined} pointerEvents="none" />
    );
  };
  const nameUnder = (b: (typeof qBoxes)[number], text: string, color: string, size: number, bold: boolean) => {
    const rx = Math.max(dotR * 1.5, (b[3] - b[1]) * 0.7);
    return (
      <text x={(b[1] + b[3]) / 2} y={b[4] + rx * 0.32 + size} textAnchor="middle" fontSize={size} fontFamily="var(--font-mono)" fontWeight={bold ? 700 : 400}
        fill={color} stroke="#000" strokeWidth={dotR / 10} paintOrder="stroke" pointerEvents="none">
        {text}
      </text>
    );
  };
  const quickOverlay = qf === null ? null : (
    <g>
      {qBoxes.map((b) => {
        const lab = qLabelAt(b[0]);
        const pred = qPred(b[0]);
        const name = lab?.name ?? pred ?? null;
        if (qMode === "player") {
          const hers = qBoxOfPlayer === b;
          const c = hers ? "#fde047" : name ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.3)";
          return (
            <g key={b[0]} className="cursor-pointer" opacity={b[11] ? 1 : 0.3} onClick={(e) => (e.stopPropagation(), qf !== null && qLabelPlayer(qf, b[0]))}>
              <rect x={b[1]} y={b[2]} width={b[3] - b[1]} height={b[4] - b[2]} fill="transparent" stroke="none" />
              {footRing(b, c, hers, !hers && !lab)}
              {(hers || name) &&
                nameUnder(b, name === NOBODY ? "—" : `${name ? `${qNumber.get(name) ?? ""} ${name}` : ""}${hers && !lab ? "?" : ""}`, c, dotR * (hers ? 2.6 : 2), hers)}
            </g>
          );
        }
        const isSel = qSel === b[0];
        const team = boxTeamOf(b, qRefs);
        const c = isSel ? "#fde047" : lab ? "#ffffff" : name ? TEAM_COLORS[team] : "rgba(255,255,255,.45)";
        const shownName = name === NOBODY ? "—" : name ? `${qNumber.get(name) ?? ""}${qNumber.has(name) ? " " : ""}${name}` : "?";
        return (
          <g key={b[0]} className="cursor-pointer" opacity={b[11] ? 1 : 0.3} onClick={(e) => (e.stopPropagation(), setQPicked(b[0]))}>
            <rect x={b[1]} y={b[2]} width={b[3] - b[1]} height={b[4] - b[2]} fill="transparent" stroke="none" />
            {footRing(b, c, isSel, !lab)}
            {nameUnder(b, isSel && qTyped ? `${qTyped}…` : `${shownName}${!lab && name ? "?" : ""}`, c, dotR * 2.4, Boolean(lab) || isSel)}
          </g>
        );
      })}
    </g>
  );

  const CP_TEXT: Record<string, string> = {
    crossing: "Acaba de cruzarse con alguien: ¿la del círculo amarillo sigue siendo ella?",
    reappears: "Reaparece tras perderse más de 1 s: ¿es ella?",
    passed_on: "El modelo le pasó el nombre a un trozo nuevo: ¿es ella?",
    lost: "Se perdió. Búscala con ← → (1 s) y haz clic sobre ella; si no sale, cambia de jugadora.",
  };
  const qModeSwitch = (
    <div className="seg mb-3 w-full" role="group" aria-label="Cómo se revisa">
      {(
        [
          ["player", "Por jugadora"],
          ["samples", "Por muestras"],
        ] as const
      ).map(([m, label]) => (
        <button key={m} type="button" aria-pressed={qMode === m} className="seg-opt flex-1" onClick={() => setPref("quick:mode", m)}>
          {label}
        </button>
      ))}
    </div>
  );
  const qPlayerCount = (name: string) => qLabels.filter((l) => l.name === name).length;
  // Fixing names given by mistake: one by one, all of a player, or all of them over to another player.
  const qMine = qPlayer ? qLabels.filter((l) => l.name === qPlayer).sort((a, b) => a.frame - b.frame) : [];
  const qRemoveLabel = (l: QuickLabel) => qSetLabels(qLabels.filter((x) => x !== l));
  const qRemoveAll = (name: string) => {
    qSetLabels(qLabels.filter((l) => l.name !== name));
    setQAfter((data?.start_frame ?? 0) - 1);
    setMsg(`Quitados todos los nombres de ${name}. Ctrl + Z los recupera.`);
  };
  const qRename = (from: string, to: string) => {
    if (!to || to === from) return;
    // A box that already had the other name keeps one label, not two.
    const taken = new Set(qLabels.filter((l) => l.name === to).map((l) => `${l.frame}:${l.track}`));
    qSetLabels(qLabels.flatMap((l) => (l.name !== from ? [l] : taken.has(`${l.frame}:${l.track}`) ? [] : [{ ...l, name: to }])));
    setQMoveTo("");
    qPickPlayer(to, qPlayerTeam);
    setMsg(`Los nombres de ${from} pasan a ${to}. Ctrl + Z lo deshace. Si ya habías aplicado, vuelve a «Aplicar a la mesa».`);
  };
  const quickPlayerPanel = (
    <Card title="Revisión rápida" note={qPlayer ? `${qNumber.get(qPlayer) ?? ""} ${qPlayer}` : "elige una jugadora"}>
      {qModeSwitch}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1.5">
        {qRoster.map((r) => (
          <button key={r.player_id} type="button" onClick={() => qPickPlayer(r.player_id, "own")}
            className={`flex items-center gap-1.5 rounded-xl border px-2 py-1 text-left text-xs transition-colors hover:border-accent ${qPlayer === r.player_id ? "border-accent bg-accent/20 text-accent-100" : "border-line text-ink-2"}`}>
            <span className="tc w-5 text-right text-faint">{r.number ?? "–"}</span>
            <span className="min-w-0 flex-1 truncate">{r.player_id}</span>
            {qDone.includes(r.player_id) ? <Check size={11} weight="bold" className="text-ok" /> : qPlayerCount(r.player_id) > 0 && <span className="tc text-[10px] text-faint">{qPlayerCount(r.player_id)}</span>}
          </button>
        ))}
      </div>
      {qPlayer && qMine.length > 0 && (
        <details className="mt-3 rounded-2xl bg-bg/40 p-3 text-xs text-muted">
          <summary className="cursor-pointer text-ink-2">
            {qMine.length} nombre(s) dados a {qPlayer} · revisar o corregir
          </summary>
          <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
            {qMine.map((l) => (
              <li key={`${l.frame}:${l.track}`} className="flex items-center gap-2">
                <button type="button" className="tc rounded-lg px-1.5 py-0.5 text-ink-2 hover:bg-raised hover:text-ink" title="Ir a ese momento" onClick={() => seekFrame(l.frame)}>
                  {fmtT(l.frame / fps)}
                </button>
                <span className="tc text-faint">caja {l.track}</span>
                <span className="ml-auto">
                  <IconButton label="Quitar este nombre" tone="danger" onClick={() => qRemoveLabel(l)}>
                    <Trash size={13} />
                  </IconButton>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className={input} value={qMoveTo} aria-label="Pasar todos a otra jugadora" onChange={(e) => setQMoveTo(e.target.value)}>
              <option value="">Pasar todos a…</option>
              {qRoster
                .filter((r) => r.player_id !== qPlayer)
                .map((r) => (
                  <option key={r.player_id} value={r.player_id}>
                    {r.number ?? "–"} {r.player_id}
                  </option>
                ))}
            </select>
            <button type="button" className={btn} disabled={!qMoveTo} onClick={() => qPlayer && qRename(qPlayer, qMoveTo)}>
              <ArrowsMerge size={14} /> Pasar
            </button>
            <button type="button" className={`${btn} ml-auto`} onClick={() => qPlayer && qRemoveAll(qPlayer)}>
              <Trash size={14} /> Quitarle todos
            </button>
          </div>
          <p className="mt-2 text-[11px] text-pretty text-faint">
            Para cambiar solo una caja: elige a la jugadora correcta, ve a ese momento y haz clic en la caja. Ctrl + Z deshace el último cambio.
          </p>
        </details>
      )}
      {qPlayer && (
        <div className="mt-3 rounded-2xl bg-bg/60 p-3 text-sm">
          {qCp ? (
            <>
              <div className="text-ink-2">{CP_TEXT[qCp.kind]}</div>
              <div className="tc mt-1 text-[11px] text-faint">{fmtT(qCp.frame / fps)}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={btnPrimary} disabled={!qTarget()} onClick={qConfirmPlayer}>
                  <Check size={14} /> Es ella <kbd className="kbd">Enter</kbd>
                </button>
                <button type="button" className={btn} disabled={!qTarget()} onClick={qNotHer}>
                  <X size={14} /> No es ella <kbd className="kbd">X</kbd>
                </button>
                <button type="button" className={btn} onClick={qNextPlayer}>
                  Siguiente jugadora <kbd className="kbd">Tab</kbd>
                </button>
                {qDone.includes(qPlayer) ? (
                  <span className="tag tag-accent">Revisión rápida hecha</span>
                ) : (
                  <button type="button" className={btn} onClick={qMarkDone} title="Ya no hay más que revisarle en esta parte (por ejemplo, salió de cuadro y no vuelve)">
                    <Check size={14} /> Hecha <kbd className="kbd">Mayús + Enter</kbd>
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] text-pretty text-faint">
                Si la del círculo amarillo no es ella pero la ves, haz clic sobre ella. Si ya no vuelve a salir en esta parte, márcala como hecha.
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-ok">
              Llegó al final de la parte.
              {qDone.includes(qPlayer) ? (
                <span className="tag tag-accent">Revisada</span>
              ) : (
                <button type="button" className={btnPrimary} onClick={qMarkDone}>
                  <Check size={14} /> Revisión rápida hecha <kbd className="kbd">Enter</kbd>
                </button>
              )}
              <button type="button" className={btn} onClick={qNextPlayer}>
                Siguiente jugadora <kbd className="kbd">Tab</kbd>
              </button>
            </div>
          )}
        </div>
      )}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted">
        {[
          ["número", "elige la jugadora por su dorsal (o clic en la lista)"],
          ["clic", "esa caja es ella (también para empezar)"],
          ["Enter / X", "es ella / no es ella"],
          ["← →", "1 s atrás o adelante, para buscarla"],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt><kbd className="kbd">{k}</kbd></dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className={`${btnPrimary} mt-4 w-full`} disabled={!qModel || qLabels.length === 0} onClick={qApplyAsk}>
        <Check size={15} /> Aplicar a la mesa
      </button>
      <p className="mt-2 text-[11px] text-pretty text-faint">
        Solo se detiene donde pudo cambiarse de persona: tras un cruce con alguien de su equipo (o uno largo con una rival), cuando
        reaparece tras perderse y donde el modelo le pasó el nombre a otro trozo. Los cruces rápidos con rivales se saltan. Simulado con tus
        dos partes corregidas: 5–8 min de trabajo por parte, 82–95 % de sus cajas con el nombre correcto, menos del 1 % mal.
      </p>
    </Card>
  );
  const quickSamplesPanel = (
    <Card title="Revisión rápida" note={qFrame !== null ? `muestra ${qIdx + 1} de ${qSamples.length} · ${fmtT(qFrame / fps)}` : undefined}>
      {qModeSwitch}
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={qIdx === 0} onClick={() => qGo(qIdx - 1)}>
          ← <kbd className="kbd">←</kbd>
        </button>
        <div className="relative h-2 flex-1 rounded-full bg-surface">
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent/60" style={{ width: `${(100 * qSeen.length) / Math.max(1, qSamples.length)}%` }} />
        </div>
        <button type="button" className={btnPrimary} onClick={qConfirm} title="Lo que propone el modelo en este cuadro está bien: siguiente muestra">
          Confirmar <kbd className="kbd">Enter</kbd>
        </button>
      </div>
      <div className="mt-3 seg w-full" role="group" aria-label="Equipo que se nombra">
        {(["own", "opp"] as const).map((t) => (
          <button key={t} type="button" aria-pressed={qTeam === t} className="seg-opt flex-1" onClick={() => setQTeam(t)}>
            {t === "own" ? "Analizado" : "Contrario"} <kbd className="kbd ml-1">{t === "own" ? "A" : "S"}</kbd>
          </button>
        ))}
      </div>
      {qTeam === "own" && qRoster.length > 0 && (
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1.5">
          {qRoster.map((r) => (
            <button key={r.player_id} type="button" disabled={qSel === null} onClick={() => qGive(r.player_id)}
              className="flex items-center gap-1.5 rounded-xl border border-line px-2 py-1 text-left text-xs text-ink-2 transition-colors hover:border-accent disabled:opacity-40">
              <span className="tc w-5 text-right text-faint">{r.number ?? "–"}</span>
              <span className="min-w-0 flex-1 truncate">{r.player_id}</span>
            </button>
          ))}
        </div>
      )}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted">
        {[
          ["número", "nombra la caja amarilla (dos cifras seguidas, o Enter); la siguiente sin nombre se elige sola"],
          ["Enter", "confirma lo que propone el modelo (nombres con «?») y pasa a la siguiente muestra"],
          ["−", "esa caja no es nadie que interese (duplicada, fuera de la cancha)"],
          ["Supr", "quita el nombre de la caja elegida · clic en una caja para elegirla · Tab: la siguiente sin nombre"],
          ["← →", "muestra anterior / siguiente sin confirmar"],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt><kbd className="kbd">{k}</kbd></dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>{qLabels.length} nombres dados</span>
        <span>{qModel ? new Set(qModel.segments.filter((x) => x.name).map((x) => x.name)).size : 0} jugadoras</span>
        {qModel && qModel.conflicts.length > 0 && <span className="text-warn">{qModel.conflicts.length} choques (un nombre en dos sitios)</span>}
        <label className="ml-auto flex items-center gap-1.5">
          Cada
          <select className={input} value={qEvery} onChange={(e) => (setPref("quick:every", e.target.value), qGo(0))}>
            {[2, 3, 5].map((v) => (
              <option key={v} value={v}>{v} s</option>
            ))}
          </select>
        </label>
      </div>
      <button type="button" className={`${btnPrimary} mt-4 w-full`} disabled={!qModel || qLabels.length === 0} onClick={qApplyAsk}>
        <Check size={15} /> Aplicar a la mesa
      </button>
      <p className="mt-2 text-[11px] text-pretty text-faint">
        Cada nombre se extiende por su track. Si un track recibe dos nombres, se corta en el cruce más probable entre las dos muestras; si
        sigue a la vista en una muestra y no se confirmó, también. Los trozos con el mismo nombre se unen y los huecos de hasta 3 s se
        rellenan al guardar. Medido con tus dos partes corregidas, nombrando solo a las nuestras cada 3 s: 40–70 números por minuto de
        video, el 80–95 % de sus cajas con el nombre correcto, menos del 1 % mal (el resto sin nombre). Aplicar reemplaza las
        correcciones de esta parte (Ctrl + Z las recupera).
      </p>
    </Card>
  );
  const quickPanel = qMode === "player" ? quickPlayerPanel : quickSamplesPanel;

  const fileLabel = `${btn} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`;

  const pitchCard = (
            <Card title="En la cancha" note="este cuadro" delay={60}>
              <div className="seg mb-3" role="group" aria-label="Qué se ve en la cancha">
                {(
                  [
                    ["all", "Todas"],
                    ["named", "Con nombre"],
                    ["ball", "Solo balón"],
                  ] as const
                ).map(([k, name]) => (
                  <button key={k} type="button" aria-pressed={pitchShow === k} className="seg-opt" onClick={() => setPref("correction:pitchShow", k)}>
                    {name}
                  </button>
                ))}
              </div>
              <Pitch showDirection={false}>
                {pitchShow !== "ball" && pieces([...selRaw].sort((u, v) => u.frame - v.frame)).map((piece) => (
                  <polyline key={`r${piece[0].frame}`} points={piece.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="var(--color-faint)" strokeWidth={0.25} opacity={0.7} />
                ))}
                {pitchShow !== "ball" && pieces(selClean).map((piece) => (
                  <polyline key={`c${piece[0].frame}`} points={piece.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="#ffffff" strokeWidth={0.45} strokeLinejoin="round" />
                ))}
                {selClean
                  .filter((q) => pitchShow !== "ball" && q.source === "interpolated")
                  .map((q) => (
                    <circle key={`i${q.frame}`} cx={q.x} cy={q.y} r={0.5} fill="var(--color-surface)" stroke="#fde047" strokeWidth={0.2} />
                  ))}
                {pitchShow === "named" &&
                  pf !== null &&
                  [...namedSmooth].map(([id, pts]) => {
                    const q = pts.get(pf);
                    if (!q) return null;
                    const p = personById.get(id);
                    return (
                      <g key={`n${id}`} className={view === "ball" ? "" : "cursor-pointer"} onClick={() => view !== "ball" && pickBox(id)}>
                        <circle cx={q.x} cy={q.y} r={id === sel ? 2.1 : 1.5} fill={q.source === "interpolated" ? "var(--color-surface)" : TEAM_COLORS[p?.team ?? "unk"]}
                          stroke={id === sel ? "#ffffff" : TEAM_COLORS[p?.team ?? "unk"]} strokeWidth={id === sel ? 0.6 : 0.4} />
                        <text x={q.x} y={q.y - 2.4} textAnchor="middle" fontSize={2.4} fontFamily="var(--font-mono)" fill="var(--color-muted)">
                          {label(p, id)}
                        </text>
                      </g>
                    );
                  })}
                {shown
                  .filter(({ b }) => b[11] && b[9] !== null && b[10] !== null)
                  .filter(() => pitchShow === "all")
                  .map(({ b, id }) => {
                    const p = personById.get(id);
                    return (
                      <g key={b[0]} className={view === "ball" ? "" : "cursor-pointer"} onClick={() => view !== "ball" && pickBox(id)}>
                        <circle cx={b[9] as number} cy={b[10] as number} r={id === sel ? 2.1 : 1.5} fill={TEAM_COLORS[p?.team ?? "unk"]} stroke={id === sel ? "#ffffff" : "var(--color-bg)"} strokeWidth={id === sel ? 0.6 : 0.3} />
                        <text x={b[9] as number} y={(b[10] as number) - 2.4} textAnchor="middle" fontSize={2.4} fontFamily="var(--font-mono)" fill="var(--color-muted)">
                          {label(p, id)}
                        </text>
                      </g>
                    );
                  })}
                {ballHere && (
                  <circle cx={ballHere.x} cy={ballHere.y} r={1} fill={ballHere.source === "interpolated" ? "var(--color-surface)" : "#ffffff"} stroke="#fb923c" strokeWidth={0.4} />
                )}
                {manualHere.filter(() => pitchShow !== "ball").map((m) => {
                  const p = toPitch(m.px, m.py, row?.H);
                  return p ? <circle key={`m${m.identity}`} cx={p[0]} cy={p[1]} r={1.5} fill="none" stroke="#fde047" strokeWidth={0.5} /> : null;
                })}
              </Pitch>
              <p className="mt-1 text-[11px] text-faint">
                {pitchShow === "named"
                  ? `Con nombre: las posiciones ${smoothOn ? "suavizadas, como se guardarán (hueca: rellenada en un hueco)" : "medidas (el suavizado está apagado)"}.`
                  : row?.H
                    ? "Posiciones por la calibración de este cuadro."
                    : "Este cuadro no tiene calibración: no hay posiciones."}{" "}
                Anillo amarillo: marcada a mano. Punto con borde naranja: balón (hueco si es una posición rellenada).
                {sel !== null && " De la seleccionada, 4 s antes y después: línea gris, lo medido; línea blanca, lo que se exportará; puntos amarillos pequeños, posiciones rellenadas."}
              </p>
            </Card>
  );
  return (
    <>
      <Head embedded={embedded}>
        <label className={fileLabel}>
          <FolderOpen size={15} />
          {fileUrl ? "Cambiar video" : "Abrir video"}
          <input type="file" accept="video/*" className="sr-only" onChange={onVideo} />
        </label>
        <FilePicker
          dir={`matches/${matchIdText}/tracking`}
          pattern={new RegExp(`^tracks_${data?.video_id ?? video}_\\d+_\\d+\\.json$`)}
          label={data ? "Otra parte" : "Abrir una parte"}
          icon={<UsersThree size={15} />}
          primary={!data}
          current={data ? `tracks_${data.video_id}_${data.start_frame}_${data.end_frame}.json` : null}
          describe={(n) => {
            const m = n.match(/^tracks_(v\d+)_(\d+)_(\d+)\.json$/);
            const e = m ? state.trackEdits.find((x) => x.key === `${mid}|${m[1]}|${m[2]}_${m[3]}`) : undefined;
            const st = e && m ? partStatus(e, { start_frame: Number(m[2]), end_frame: Number(m[3]), fps: data?.fps ?? 29.97, stride: data?.stride ?? 3 }) : null;
            const mark = st?.complete ? " ✓ completa" : st && (st.quick > 0 || st.players > 0 || st.ball > 0) ? ` · verificadas ${st.players} · balón ${Math.round(st.ball * 100)} %` : "";
            return `${partLabel(n, data?.fps ?? 29.97)}${mark}`;
          }}
          onFile={(f) => void onTracks(asEvent([f]))}
        />
        {data && (
          <>
            <div className="seg" role="group" aria-label="Qué se corrige">
              {(
                [
                  ["players", "Jugadoras", UsersThree],
                  ["ball", "Balón", SoccerBall],
                  ["quick", "Revisión rápida", Lightning],
                ] as const
              ).map(([v, name, Icon]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  className="seg-opt inline-flex items-center gap-1.5"
                  onClick={() => {
                    setView(v);
                    setMode(v === "ball" ? "ball" : null);
                    if (v === "quick") qGo(qIdx);
                  }}
                >
                  <Icon size={14} />
                  {name}
                </button>
              ))}
            </div>
            {status && (
              <span
                className={`tag ${status.complete ? "tag-accent" : ""} ${!status.complete && status.players >= PLAYERS_DONE ? "text-ok" : ""}`}
                title={`Completa con al menos ${PLAYERS_DONE} jugadoras verificadas en la mesa (con nombre y ✓; pueden ser más por los cambios) y balón en el 95 % del tiempo en juego (lo marcado como fuera no cuenta). Es la misma medida que la barra del balón bajo el video.`}
              >
                {status.complete
                  ? "✓ Parte completa"
                  : `Verificadas ${status.players} · balón ${Math.round(status.ball * 100)} % del juego`}
              </span>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" className={btn} onClick={() => setModal("reset")} title="Volver a la propuesta del programa en esta parte">
                <ArrowCounterClockwise size={15} />
                Restablecer…
              </button>
              <button type="button" className={btn} onClick={() => setModal("kits")}>
                <Palette size={15} />
                Uniformes
              </button>
              <button type="button" className={btn} onClick={() => setModal("export")}>
                <Stack size={15} />
                Exportar…
              </button>
              <button
                type="button"
                className={btnPrimary}
                title="Guarda lo corregido (tracks_fixed) y las etiquetas en la carpeta del partido; si no se puede, se descargan"
                onClick={exportFixed}
              >
                <FloppyDisk size={15} />
                Guardar
              </button>
            </span>
          </>
        )}
      </Head>
      {modal === "kits" && (
        <Modal title="Uniformes" onClose={() => setModal(null)} wide>
          {kitsCard}
        </Modal>
      )}
      {modal === "cleanup" && data && (
        <Modal title="Limpieza rápida" onClose={() => setModal(null)}>
          {cleanupPanel}
        </Modal>
      )}
      {modal === "applyQuick" && data && (
        <Modal title="Aplicar la revisión rápida" onClose={() => setModal(null)}>
          <div className="space-y-3 text-sm text-muted">
            <p className="text-pretty">Ya hay {checkedIds.size} jugadora(s) verificadas en la mesa.</p>
            <button type="button" className={`${btnPrimary} w-full !justify-start`} onClick={() => qApply("add")}>
              <Check size={15} />
              Agregar lo nuevo: las verificadas se quedan como están
            </button>
            <p className="-mt-1 text-[11px] text-pretty text-faint">
              Los tramos que la revisión rápida da a cada jugadora pasan a ella, salvo los de las verificadas, que no se tocan (ni se les quita ni se
              les agrega nada). Tus cortes, uniones y marcas a mano se conservan.
            </p>
            <button type="button" className={`${btn} w-full !justify-start hover:text-danger`} onClick={() => qApply("replace")}>
              <ArrowCounterClockwise size={15} />
              Todo desde cero: rehace la mesa con la revisión rápida
            </button>
            <p className="-mt-1 text-[11px] text-pretty text-faint">
              Se pierden las correcciones hechas en «Jugadoras» después de la revisión (vuelven huecos y dobles cajas). Solo se conservan las palomitas,
              por nombre. Ctrl + Z lo deshace.
            </p>
          </div>
        </Modal>
      )}
      {modal === "ballEvents" && data && (
        <Modal title="Balón desde los eventos" onClose={() => setModal(null)}>
          {ballEventsPanel}
        </Modal>
      )}
      {modal === "reset" && data && (
        <Modal title="Restablecer esta parte" onClose={() => setModal(null)}>
          <div className="space-y-3 text-sm text-muted">
            <p className="text-pretty">Vuelve a la propuesta del programa en esta parte. Se puede deshacer con Ctrl + Z.</p>
            <button
              type="button"
              className={`${btn} w-full !justify-start`}
              onClick={() => {
                setEdits({ ...emptyEdits(key), quick: edits.quick, ball: edits.ball, ballReview: edits.ballReview });
                setSel(null);
                setMode(null);
                setModal(null);
                setMsg("Mesa restablecida; los nombres de la revisión rápida y el balón se conservan (vuelve a «Aplicar a la mesa»).");
              }}
            >
              <ArrowCounterClockwise size={15} />
              Solo la mesa: cortes, uniones, nombres y descartes
            </button>
            <button
              type="button"
              className={`${btn} w-full !justify-start hover:text-danger`}
              onClick={() => {
                setEdits(emptyEdits(key));
                setSel(null);
                setMode(null);
                setModal(null);
                setMsg("Parte restablecida por completo (también la revisión rápida y el balón). Ctrl + Z lo deshace.");
              }}
            >
              <Trash size={15} />
              Todo: también los nombres de la revisión rápida y las marcas del balón
            </button>
          </div>
        </Modal>
      )}
      {modal === "export" && data && (
        <Modal title="Exportar" onClose={() => setModal(null)} wide>
          {exportPanel}
        </Modal>
      )}

      {msg && (
        <div role="status" className="enter mb-5 rounded-2xl bg-accent-900/60 px-4 py-3 text-sm text-accent-100 shadow-[inset_0_0_0_1px_rgba(74,114,255,.45)]">
          {msg}
        </div>
      )}

      {fileUrl && !data ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_27rem]">
          <div className="min-w-0 space-y-3">
            <div className="relative overflow-hidden rounded-2xl bg-black">
              <video ref={videoRef} src={fileUrl} controls muted playsInline preload="auto" className="block w-full" />
              {pickKit && <div className="absolute inset-0 cursor-crosshair" role="presentation" onClick={(e) => sampleKit(e.clientX, e.clientY)} />}
            </div>
            {pickKit ? (
              <div className="enter rounded-2xl bg-accent-900/70 px-4 py-2.5 text-sm text-accent-100 shadow-[inset_0_0_0_1px_rgba(74,114,255,.5)]">
                Haz clic en el video sobre la camiseta de: {KIT_LABELS[pickKit]} ({TEAM_LABELS[KIT_TEAM[pickKit]].toLowerCase()}). Esc para cancelar.
              </div>
            ) : (
              <p className="text-xs text-pretty text-faint">
                Todavía sin tracks: aquí puedes elegir los colores de los uniformes antes de procesar. Busca un cuadro donde se vean bien
                las dos camisetas, pausa, y usa «del video» en cada fila.
              </p>
            )}
          </div>
          <div className="space-y-5">
            <Card title="Antes de procesar" note="los colores primero">
              {!embedded && (
                <label className="flex flex-col gap-1 text-[11px] text-faint">
                  Partido (match_id, el nombre de su carpeta)
                  <input className={`${input} tc`} value={matchIdText} onChange={(e) => setMatchIdText(e.target.value.trim())} />
                </label>
              )}
              <ol className="mt-3 space-y-1.5 text-xs text-pretty text-muted">
                <li>1. Elige abajo el color de cada uniforme y pulsa «Escribir en match.yaml».</li>
                <li>
                  2. Procesa el tramo en la terminal:
                  <Command className="mt-1.5">{`python -m sportsan.tracking.process --match ${matchIdText} --chunk 300`}</Command>
                  <span className="mt-1 block text-[11px] text-faint">
                    Desde la carpeta del repo, con .venv activado. Sin --start/--end procesa los tramos de juego de segments.csv, en partes de 5 min.
                  </span>
                </li>
                <li>3. Carga aquí cada <code>tracks_…json</code> con «Cargar tracks».</li>
              </ol>
            </Card>
            {kitsCard}
          </div>
        </div>
      ) : !data || !fileUrl ? (
        <Card tone="hero" className="max-w-3xl">
          <h2 className="text-2xl text-ink">Para empezar</h2>
          <ol className="mt-3 space-y-2 text-sm text-pretty text-muted">
            <li>
              <span className="num mr-2 text-lg text-accent-400">1</span>Abre el video original con «Abrir video» y elige los colores de los uniformes
              haciendo clic sobre las camisetas. Escríbelos en <code>match.yaml</code>.
            </li>
            <li>
              <span className="num mr-2 text-lg text-accent-400">2</span>Procesa un tramo corto en la terminal:
              <Command className="mt-2">python -m sportsan.tracking.process --start 0:33:20 --end 0:36:20 --force</Command>
            </li>
            <li>
              <span className="num mr-2 text-lg text-accent-400">3</span>Carga un <code>tracks_…json</code> de la carpeta <code>tracking/</code> del partido y revisa a cada
              jugadora. Las correcciones se guardan solas en este navegador y se pueden deshacer.
            </li>
          </ol>
        </Card>
      ) : (
        <>
          <Reveal className="mb-7 flex flex-wrap items-end gap-x-10 gap-y-4">
            <div>
              <div className="num text-6xl text-ink">
                <CountUp value={ppl.length} />
              </div>
              <div className="mt-1.5 text-xs text-muted">identidades por revisar</div>
            </div>
            {(["own", "opp", "ref", "unk"] as const).map((t) => (
              <div key={t} className="border-l border-line-soft pl-4">
                <div className="num text-4xl" style={{ color: TEAM_COLORS[t] }}>
                  <CountUp value={count(t)} />
                </div>
                <div className="mt-1.5 text-xs text-muted">{TEAM_LABELS[t].toLowerCase()}</div>
              </div>
            ))}
            <div className="border-l border-line-soft pl-4">
              <div className={`num text-4xl ${withGaps ? "text-warn" : "text-ink-2"}`}>
                <CountUp value={withGaps} />
              </div>
              <div className="mt-1.5 text-xs text-muted">con huecos (se perdió y volvió)</div>
            </div>
            {withConflicts > 0 && (
              <div className="border-l border-line-soft pl-4">
                <div className="num text-4xl text-warn">
                  <CountUp value={withConflicts} />
                </div>
                <div className="mt-1.5 text-xs text-muted">con dos cajas a la vez</div>
              </div>
            )}
          </Reveal>

          <div ref={layoutRef} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_0.5rem_var(--list-w)] xl:gap-2" style={{ "--list-w": `${listW}px` } as React.CSSProperties}>
            <div className="min-w-0">
              <div className="space-y-3 xl:sticky xl:top-4">
                <div className={`relative mx-auto w-full overflow-hidden rounded-2xl bg-black ${selected ? "xl:max-w-[calc((100vh-19rem)*16/9)]" : "xl:max-w-[calc((100vh-11rem)*16/9)]"}`}>
                  <div
                    className="relative origin-top-left transition-transform duration-300 ease-out will-change-transform"
                    style={{ transform: zoomTransform }}
                  >
                  <video
                    ref={videoRef}
                    src={fileUrl}
                    muted
                    playsInline
                    preload="auto"
                    className="block w-full"
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onLoadedMetadata={(e) => {
                      setDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
                      e.currentTarget.currentTime = (data.start_frame + 0.5) / fps;
                    }}
                  />
                  {dims && (
                    <svg
                      ref={overlayRef}
                      viewBox={`0 0 ${dims.w} ${dims.h}`}
                      className={`absolute inset-0 h-full w-full ${mode === "manual" || mode === "ball" || pickKit ? "cursor-crosshair" : ""}`}
                      onClick={onOverlayClick}
                    >
                      {view === "quick" && quickOverlay}
                      {view !== "quick" && (view !== "ball" || ballBoxes) && shown.map(({ b, id }) => {
                        const p = personById.get(id);
                        const isSel = id === sel;
                        const twice = twiceHere.has(id);
                        const c = twice ? "#fb7185" : isSel ? "#ffffff" : TEAM_COLORS[p?.team ?? "unk"];
                        return (
                          <g key={b[0]} className="cursor-pointer" opacity={b[11] ? 1 : 0.35} onClick={(e) => (mode === "manual" || mode === "ball" || pickKit ? undefined : (e.stopPropagation(), pickBox(id, b[0])))}>
                            <rect
                              x={b[1]}
                              y={b[2]}
                              width={b[3] - b[1]}
                              height={b[4] - b[2]}
                              fill="transparent"
                              stroke={c}
                              strokeWidth={isSel || twice ? dotR / 2 : dotR / 4}
                              strokeDasharray={twice ? `${dotR} ${dotR / 2}` : undefined}
                            />
                            <text x={(b[1] + b[3]) / 2} y={b[2] - dotR / 2} textAnchor="middle" fontSize={dotR * 2.4} fontFamily="var(--font-mono)" fontWeight={isSel ? 700 : 400} fill={c} stroke="#000" strokeWidth={dotR / 10} paintOrder="stroke">
                              {label(p, id)}
                            </text>
                          </g>
                        );
                      })}
                      {peekOther !== null &&
                        shown
                          .filter((x) => x.id === peekOther)
                          .map(({ b }) => (
                            <rect key={`peek${b[0]}`} pointerEvents="none" x={b[1] - dotR} y={b[2] - dotR} width={b[3] - b[1] + 2 * dotR} height={b[4] - b[2] + 2 * dotR}
                              fill="none" stroke="#fde047" strokeWidth={dotR / 2} strokeDasharray={`${dotR * 1.5} ${dotR}`} />
                          ))}
                      {ballMarkHere && (
                        <g pointerEvents="none">
                          <circle cx={ballMarkHere.px} cy={ballMarkHere.py} r={dotR * 0.9} fill="none" stroke="#ffffff" strokeWidth={dotR / 3} />
                          <circle cx={ballMarkHere.px} cy={ballMarkHere.py} r={dotR * 1.5} fill="none" stroke="#fb923c" strokeWidth={dotR / 4} />
                        </g>
                      )}
                      {manualHere.map((m) => (
                        <g key={`m${m.identity}`} pointerEvents="none">
                          <circle cx={m.px} cy={m.py} r={dotR * 1.2} fill="none" stroke={m.identity === sel ? "#ffffff" : "#fde047"} strokeWidth={dotR / 3} />
                          <text x={m.px} y={m.py - dotR * 1.8} textAnchor="middle" fontSize={dotR * 2.4} fontFamily="var(--font-mono)" fill="#fde047" stroke="#000" strokeWidth={dotR / 10} paintOrder="stroke">
                            {label(personById.get(m.identity), m.identity)}
                          </text>
                        </g>
                      ))}
                    </svg>
                  )}
                  </div>
                  {zoomTransform && (
                    <span className="tc pointer-events-none absolute top-2 right-2 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">×{zoom}</span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-bg/85 py-1 backdrop-blur-sm">
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−1 s" aria-label="Retroceder 1 segundo" onClick={() => seekFrame(frame - Math.round(fps))}>
                    <Rewind size={16} />
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="Cuadro anterior con detecciones" aria-label="Cuadro anterior" onClick={() => seekFrame(frame - stride)}>
                    <SkipBack size={16} />
                  </button>
                  <button
                    type="button"
                    className={`${btnPrimary} h-10 w-10 !p-0`}
                    title={playing ? "Pausar" : "Reproducir"}
                    aria-label={playing ? "Pausar" : "Reproducir"}
                    onClick={(e) => {
                      e.currentTarget.blur(); // si no, la barra espaciadora lo pulsaría otra vez
                      togglePlay();
                    }}
                  >
                    {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="Cuadro siguiente con detecciones" aria-label="Cuadro siguiente" onClick={() => seekFrame(frame + stride)}>
                    <SkipForward size={16} />
                  </button>
                  <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 s" aria-label="Avanzar 1 segundo" onClick={() => seekFrame(frame + Math.round(fps))}>
                    <FastForward size={16} />
                  </button>
                  <span className="tag tc ml-1">
                    {fmtT(time)} · cuadro {frame}
                  </span>
                  {!inRange && <span className="tag tag-warn">fuera de la parte cargada</span>}
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const t = parseHms(goTo);
                      if (t !== null) seekFrame(Math.round(t * fps));
                    }}
                  >
                    <input className={`${input} tc w-20`} placeholder="mm:ss" aria-label="Ir a un tiempo del video" value={goTo} onChange={(e) => setGoTo(e.target.value)} />
                  </form>
                  <span className="ml-auto">
                    <SpeedControl rate={rate} onChange={setRate} />
                  </span>
                  <button
                    type="button"
                    className={`${btn} h-9 !px-2.5`}
                    title="Acercar a la seleccionada (z): ×1, ×2, ×3"
                    aria-label={`Zoom ×${zoom}; cambiar (z)`}
                    onClick={(e) => {
                      e.currentTarget.blur();
                      setPref("correction:zoom", String((zoom % 3) + 1));
                    }}
                  >
                    <MagnifyingGlassPlus size={15} />
                    <span className="tc text-xs">×{zoom}</span>
                  </button>
                </div>
                {/* Whole part on one bar: click to jump. */}
                <div
                  className="relative h-2 cursor-pointer rounded-full bg-surface"
                  role="presentation"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    seekFrame(Math.round(data.start_frame + ((e.clientX - r.left) / r.width) * span));
                  }}
                >
                  <span className="absolute inset-y-0 left-0 rounded-full bg-accent/60" style={{ width: `${Math.min(100, Math.max(0, pos(frame)))}%` }} />
                </div>
                {view !== "quick" && (
                  <BallStrip
                    points={ball}
                    from={data.start_frame}
                    to={data.end_frame}
                    frame={frame}
                    stride={stride}
                    fps={fps}
                    onSeek={seekFrame}
                    out={bSeen.filter((f) => !(edits.ball ?? []).some((b) => Math.abs(b.frame - f) <= (bEvery * fps) / 2))}
                    outHalf={(bEvery * fps) / 2}
                  />
                )}
                {!selected && view === "players" && (
                  <p className="rounded-2xl bg-surface/60 px-4 py-3 text-sm text-muted">
                    Haz clic en una caja del video o en una fila de la lista para corregirla. Atajos: <kbd className="kbd">u</kbd> unir,{" "}
                    <kbd className="kbd">s</kbd> partir aquí (<kbd className="kbd">Shift S</kbd> se queda en el primer tramo), <kbd className="kbd">p</kbd> marcar a mano, <kbd className="kbd">n</kbd> ver la
                    siguiente candidata, <kbd className="kbd">g</kbd> hueco (1 s más cada vez), <kbd className="kbd">c</kbd> cambio de camiseta, <kbd className="kbd">d</kbd> dos cajas,{" "}
                    <kbd className="kbd">v</kbd> verificada (y pasa a la siguiente por revisar), <kbd className="kbd">Supr</kbd> no es jugadora.
                  </p>
                )}
                {selected && (
                  <div className="space-y-2 rounded-2xl bg-surface/60 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <ul className="min-w-0 flex-1 basis-72">{renderRow(selected)}</ul>
                      <span className="flex items-center gap-1">
                        <IconButton label="Unir con… (u): clic en la caja o fila de la misma jugadora" tone={mode === "merge" ? "accent" : "default"} onClick={() => setMode(mode === "merge" ? null : "merge")}>
                          <ArrowsMerge size={16} />
                        </IconButton>
                        <IconButton
                          label={
                            canSplit
                              ? "Partir aquí: desde este cuadro es otra persona. s selecciona el segundo tramo; Shift + S deja seleccionado el primero"
                              : "Partir aquí (s): colócate entre su primera y su última aparición"
                          }
                          disabled={!canSplit}
                          onClick={() => splitHere()}
                        >
                          <ArrowsSplit size={16} />
                        </IconButton>
                        <IconButton label="Marcar a mano (p): clic en sus pies" tone={mode === "manual" ? "accent" : "default"} onClick={() => setMode(mode === "manual" ? null : "manual")}>
                          <HandPointing size={16} />
                        </IconButton>
                        {manualHere.some((m) => m.identity === selected.id) && pf !== null && (
                          <IconButton label="Quitar la marca a mano de este cuadro" onClick={() => setEdits(removeManual(edits, selected.id, pf))}>
                            <Eraser size={16} />
                          </IconButton>
                        )}
                        <IconButton label="No es jugadora (Supr)" tone="danger" onClick={removeSelected}>
                          <Prohibit size={16} />
                        </IconButton>
                        <IconButton label="Soltar la selección (Esc)" onClick={() => setSel(null)}>
                          <X size={16} />
                        </IconButton>
                      </span>
                    </div>
                  <PersonTimeline
                    key={selected.id}
                    points={selLine}
                    conflicts={selected.conflicts}
                    hints={hints.filter((h) => h.person === selected.id).map((h) => h.frame)}
                    manual={edits.manual.filter((m) => m.identity === selected.id).map((m) => m.frame)}
                    open={selGaps}
                    offCamera={selOffCamera}
                    start={data.start_frame}
                    end={data.end_frame}
                    frame={frame}
                    fps={fps}
                    stride={stride}
                    teamColors={TEAM_COLORS}
                    onSeek={seekFrame}
                    onDrop={dropStretch}
                    onSeparate={separateStretch}
                    onSplit={splitAt}
                  />
                    {/* Notices about her, in one row of chips. */}
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {[...cand.next.map((x) => ["sigue como", x, x.to] as const), ...cand.prev.map((x) => ["viene de", x, x.from] as const)].map(([verb, x, other]) => (
                        <span
                          key={`${x.from}-${x.to}`}
                          className={`inline-flex items-center gap-1 rounded-xl py-0.5 pr-0.5 pl-2 ${peek === x ? "bg-warn-900/70 text-warn" : "bg-bg/60 text-ink-2"}`}
                          title={`¿${verb} ${label(personById.get(other), other)}? Ordenadas por dónde debería estar según cómo se movía; la primera acierta un tercio de las veces.`}
                        >
                          <span className="text-faint">{verb}</span>
                          <span className="h-2 w-2 rounded-full" style={{ background: TEAM_COLORS[personById.get(other)?.team ?? "unk"] }} />
                          <span className="tc">{label(personById.get(other), other)}</span>
                          <span className="tc text-faint">
                            {x.gapS.toFixed(1)} s · {x.distM.toFixed(0)} m
                          </span>
                          <IconButton label="Ver en el video (n)" tone={peek === x ? "accent" : "default"} onClick={() => peekAt(x)}>
                            <Eye size={13} />
                          </IconButton>
                          <IconButton label="Es ella: unir" onClick={() => joinCandidate(x)}>
                            <Check size={13} />
                          </IconButton>
                          <IconButton label="No es ella (no se vuelve a proponer)" tone="danger" onClick={() => rejectCandidate(x)}>
                            <X size={13} />
                          </IconButton>
                        </span>
                      ))}
                      {(() => {
                        // One badge for all her changes of shirt: c goes from one to the next; the scissors cut the one on screen.
                        const hs = hintsByPerson.get(selected.id) ?? [];
                        if (hs.length === 0) return null;
                        const here = hs.find((h) => Math.abs(h.frame - frame) <= 1.5 * fps);
                        return (
                          <span className="inline-flex items-center gap-1 rounded-xl bg-warn-900/50 py-0.5 pr-0.5 pl-2 text-warn" title={here ? hintText(here) : "Cambios de camiseta: c va al siguiente"}>
                            <TShirt size={13} weight="fill" />
                            {hs.length} cambio(s) de camiseta
                            <IconButton label="Ir al siguiente (c)" onClick={() => nextOf(hs.map((h) => Math.max(data.start_frame, h.frame - Math.round(fps))))}>
                              <SkipForward size={13} />
                            </IconButton>
                            <IconButton label={here ? "Cortar aquí: de este punto en adelante es otra persona" : "Ve a un cambio (c) para cortarlo"} tone="accent" disabled={!here} onClick={() => here && fixHint(here)}>
                              <Scissors size={13} />
                            </IconButton>
                          </span>
                        );
                      })()}
                      {absorbForSel.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-xl bg-accent-900/40 py-0.5 pr-0.5 pl-2 text-ink-2">
                          <MagicWand size={13} />
                          {absorbForSel.length} trozo(s) corto(s) suyos
                          {absorbForSel.some((a) => a.adds > 0) && ` (+${absorbForSel.reduce((n, a) => n + a.adds, 0)} cuadros)`}
                          <IconButton label="Añadírselos" tone="accent" onClick={() => absorb(absorbForSel)}>
                            <Plus size={13} />
                          </IconButton>
                        </span>
                      )}
                      {selected.conflicts.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-xl bg-warn-900/60 py-0.5 pr-0.5 pl-2 text-warn" title="Haz clic en la caja que sí es ella en esos cuadros, o deja una donde están en el mismo sitio">
                          <Warning size={13} />
                          dos cajas en {selected.conflicts.length} cuadro(s)
                          <IconButton label="Ir al primero" onClick={() => seekFrame(selected.conflicts[0])}>
                            <Eye size={13} />
                          </IconButton>
                          <IconButton label="Dejar una donde están en el mismo sitio" tone="accent" onClick={unifySelf}>
                            <MagicWand size={13} />
                          </IconButton>
                        </span>
                      )}
                      {selGaps.length > 0 ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-xl bg-danger/15 py-0.5 pr-0.5 pl-2 text-danger"
                          title={`Huecos por revisar (rojo en la línea): se perdió en medio de la imagen durante más de ${FIX_GAP_S} s. Con «g» vas a 1 s de donde se perdió y avanzas de segundo en segundo. Si en el hueco hay otra caja que es ella, únela; si el detector no la vio, márcala a mano (p). Los huecos donde salió de cuadro no cuentan: al guardar se rellenan con una recta.`}
                        >
                          {selGaps.length} hueco(s) por revisar · el más largo {(Math.max(...selGaps.map(([a, b]) => b - a)) / fps).toFixed(1)} s
                          <IconButton label="Ir al siguiente hueco (g)" onClick={nextGap}>
                            <SkipForward size={13} />
                          </IconButton>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-xl bg-ok/15 px-2 py-0.5 text-ok" title="No le quedan huecos en medio de la imagen; los de fuera de cuadro se rellenan al guardar">
                          <Check size={13} weight="bold" /> Sin huecos por revisar
                        </span>
                      )}
                      {selOffCamera.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-xl bg-bg/60 px-2 py-0.5 text-faint" title="Huecos donde salió de cuadro (estaba en el borde de la imagen al perderla o al encontrarla): gris en la línea; se rellenan al guardar">
                          {selOffCamera.length} fuera de cuadro
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {peek && selected && peekOther !== null && (
                  <div className="enter flex flex-wrap items-center gap-2 rounded-2xl bg-warn-900/70 px-4 py-2.5 text-sm text-warn shadow-[inset_0_0_0_1px_rgba(224,164,88,.45)]">
                    <span className="min-w-0 flex-1">
                      ¿<strong>{label(selected, selected.id)}</strong> {peek.from === selected.id ? "sigue como" : "viene de"}{" "}
                      <strong>{label(personById.get(peekOther), peekOther)}</strong> (recuadro amarillo)? {peek.gapS.toFixed(1)} s, {peek.distM.toFixed(1)} m
                    </span>
                    <button type="button" className={btnPrimary} onClick={() => joinCandidate(peek)}>
                      <Check size={14} /> Unir <kbd className="kbd">Enter</kbd>
                    </button>
                    <button type="button" className={btn} onClick={() => rejectCandidate(peek)}>
                      <X size={14} /> No <kbd className="kbd">X</kbd>
                    </button>
                    <button type="button" className={btn} onClick={() => peekAt(peek)}>
                      <ArrowClockwise size={14} /> <kbd className="kbd">R</kbd>
                    </button>
                    <button type="button" className={btn} title="Siguiente candidata" onClick={() => peekNext(peek)}>
                      Siguiente
                    </button>
                    <IconButton label="Cerrar (Esc)" onClick={() => setPeek(null)}>
                      <X size={14} />
                    </IconButton>
                  </div>
                )}
                {selTwiceHere && selected && !mode && !pickKit && (
                  <div className="enter flex items-start gap-2.5 rounded-2xl bg-warn-900/80 px-4 py-2.5 text-sm text-warn shadow-[inset_0_0_0_1px_rgba(224,164,88,.45)]">
                    <Warning size={17} className="mt-0.5 shrink-0" />
                    <span>
                      {label(selected, selected.id)} tiene dos cajas en este cuadro (las de trazo rojo). Haz clic en la que <strong>sí</strong> es ella: la
                      otra se separa como una persona aparte. Se puede deshacer.
                    </span>
                  </div>
                )}
                {pickKit && (
                  <div className="enter rounded-2xl bg-accent-900/70 px-4 py-2.5 text-sm text-accent-100 shadow-[inset_0_0_0_1px_rgba(74,114,255,.5)]">
                    Haz clic en el video sobre la camiseta de: {KIT_LABELS[pickKit]} ({TEAM_LABELS[KIT_TEAM[pickKit]].toLowerCase()}). Esc para cancelar.
                  </div>
                )}
                {mode && (
                  <div className="enter rounded-2xl bg-accent-900/70 px-4 py-2.5 text-sm text-accent-100 shadow-[inset_0_0_0_1px_rgba(74,114,255,.5)]">
                    {mode === "merge"
                      ? `Uniendo con ${label(selected ?? undefined, sel ?? 0)}: haz clic en la caja (o en la fila) de la misma jugadora. Puedes moverte por el video. Esc para terminar.`
                      : `Marcando a ${label(selected ?? undefined, sel ?? 0)} a mano: haz clic en el video donde están sus pies en este cuadro. Esc para terminar.`}
                  </div>
                )}
              </div>

            </div>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Ancho de la lista (arrastra; doble clic para el ancho normal)"
              title="Arrastra para cambiar el ancho; doble clic para el ancho normal"
              className="group hidden cursor-col-resize touch-none justify-center xl:flex"
              onPointerDown={dragDivider}
              onDoubleClick={() => setPref("correction:listW", "496")}
            >
              <span className="h-full w-px bg-line-soft transition-colors group-hover:w-0.5 group-hover:bg-accent" />
            </div>
            {view === "ball" ? (
              <div className="space-y-3 xl:sticky xl:top-4">
                {ballBar}
                {pitchCard}
              </div>
            ) : view === "quick" ? (
              <div className="space-y-4 xl:sticky xl:top-4">{quickPanel}</div>
            ) : (
            <div className="flex flex-col xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)]">


              <Card
                title="Personas"
                note={`${status?.players ?? 0} verificadas · ${ppl.filter((p) => p.player_id && !refIds.has(p.id)).reduce((n, p) => n + gapsOf(p).length, 0)} huecos por revisar · ${listedAll.length} en la lista`}
                delay={60}
                className="flex min-h-[22rem] flex-1 flex-col"
              >
                {blocked && (
                  <div role="alert" className="enter mb-3 rounded-2xl bg-warn-900/70 px-3 py-2.5 text-xs text-warn">
                    <div className="flex items-start gap-2">
                      <Warning size={14} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        No las uní: {label(personById.get(blocked.into), blocked.into)} y {label(personById.get(blocked.from), blocked.from)} aparecen a la
                        vez y en sitios distintos en {blocked.frames.length} cuadro(s), así que no pueden ser la misma persona.
                        {blocked.same > 0 && ` (En otros ${blocked.same} sí coinciden en el mismo sitio.)`}
                      </span>
                    </div>
                    <div className="mt-1 flex gap-1 pl-5">
                      <IconButton label="Ver el primer cuadro donde coinciden" onClick={() => seekFrame(blocked.frames[0])}>
                        <Eye size={14} />
                      </IconButton>
                      <IconButton
                        label="Unir de todos modos: donde están separadas quedarán dos cajas y habrá que elegir cuál es ella"
                        tone="accent"
                        onClick={() => tryMerge(blocked.into, blocked.from, true)}
                      >
                        <ArrowsMerge size={14} />
                      </IconButton>
                      <IconButton label="Cancelar" onClick={() => setBlocked(null)}>
                        <X size={14} />
                      </IconButton>
                    </div>
                  </div>
                )}
                {notice && (
                  <div role="status" className="enter mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-warn-900/70 px-3 py-2 text-xs text-warn">
                    <span className="min-w-0 flex-1">{notice}</span>
                    <IconButton label="Deshacer (Ctrl + Z)" onClick={undo}>
                      <ArrowCounterClockwise size={14} />
                    </IconButton>
                    <IconButton label="Está bien (Enter)" tone="accent" onClick={() => setNotice(null)}>
                      <Check size={14} />
                    </IconButton>
                  </div>
                )}
                <div className="seg mb-2 w-full" role="group" aria-label="Qué personas se listan">
                  {(
                    [
                      ["named", "Con nombre"],
                      ["all", "Todas"],
                    ] as const
                  ).map(([k, name]) => (
                    <button key={k} type="button" aria-pressed={listShow === k} className="seg-opt flex-1" onClick={() => setPref("correction:listShow", k)}>
                      {name}
                    </button>
                  ))}
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  {(["all", "own", "opp", "ref", "unk"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={teamFilter === t}
                      onClick={() => setTeamFilter(t)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                        teamFilter === t ? "bg-accent/20 text-accent-100 shadow-[inset_0_0_0_1px_var(--color-accent)]" : "bg-bg/60 text-muted hover:text-ink"
                      }`}
                    >
                      {t !== "all" && <span className="h-2 w-2 rounded-full" style={{ background: TEAM_COLORS[t] }} />}
                      {t === "all" ? "Todas" : TEAM_LABELS[t]}
                      <span className="tc text-faint">{t === "all" ? ppl.length : count(t)}</span>
                    </button>
                  ))}
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" className="accent-accent" checked={showShort} onChange={(e) => setShowShort(e.target.checked)} />
                    Mostrar los {hiddenShort} trozos de menos de un segundo
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" className="accent-accent" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
                    Ocultar las {doneCount} completas
                  </label>
                  <label className="flex items-center gap-1.5" title="Líneas cuya camiseta pasa de un equipo al otro: casi siempre son dos personas">
                    <input type="checkbox" className="accent-accent" checked={onlyShirt} onChange={(e) => setOnlyShirt(e.target.checked)} />
                    <TShirt size={12} className="text-warn" /> Solo con cambio de camiseta ({new Set(hints.map((h) => h.person)).size})
                  </label>
                  <label className="flex items-center gap-1.5" title="No se usan en el análisis: ocultas, fuera de la lista y de lo que se guarda. Fuera de la cancha = menos del 10 % de sus cajas dentro">
                    <input type="checkbox" className="accent-accent" checked={showRefs} onChange={(e) => setShowRefs(e.target.checked)} />
                    Mostrar árbitras ({ppl.filter((p) => p.team === "ref" && !p.teamByHand).length}) y fuera de la cancha ({ppl.filter(offPitch).length})
                  </label>
                  <span className="ml-auto flex items-center gap-1">
                    <IconButton label="Deshacer (Ctrl + Z)" disabled={history.length === 0} onClick={undo}>
                      <ArrowCounterClockwise size={14} />
                    </IconButton>
                    <IconButton
                      label="Restablecer esta parte: quita todas sus correcciones y vuelve a la propuesta del programa (se puede deshacer)"
                      tone="danger"
                      onClick={() => {
                        setEdits(emptyEdits(key));
                        setSel(null);
                        setMode(null);
                      }}
                    >
                      <Trash size={14} />
                    </IconButton>
                  </span>
                </div>
                {(teamFilter === "ref" || teamFilter === "unk") && listedAll.some((p) => !p.player_id) && (
                  <button
                    type="button"
                    className={`${btn} mb-2 w-full !justify-start hover:text-danger`}
                    title="Descarta las personas sin nombre que muestra este filtro: no se usan ni se guardan. Ctrl + Z las recupera."
                    onClick={() => {
                      const ids = listedAll.filter((p) => !p.player_id).map((p) => p.id);
                      setEdits(setRemovedMany(edits, ids));
                      setMsg(`${ids.length} descartadas (${teamFilter === "ref" ? "árbitras" : "sin equipo"}). Ctrl + Z las recupera.`);
                    }}
                  >
                    <Trash size={14} />
                    Descartar las {listedAll.filter((p) => !p.player_id).length} {teamFilter === "ref" ? "árbitras" : "sin equipo"} que se ven
                  </button>
                )}
                <ul className="-mr-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-2">
                  {selected && nearSel.length > 0 && (
                    <li className="mb-2 rounded-xl bg-accent-900/30 p-2">
                      <div className="mb-1 text-[11px] text-accent-200">Cerca de {label(selected, selected.id)}: candidatas y trozos en sus huecos</div>
                      <ul className="space-y-1">{nearSel.map((p) => renderRow(p))}</ul>
                    </li>
                  )}
                  {listed.map((p) => renderRow(p))}
                  {listedAll.length > listed.length && (
                    <li className="py-2 text-center">
                      <button type="button" className={btn} onClick={() => setListLimit(listLimit + 100)}>
                        Mostrar {Math.min(100, listedAll.length - listed.length)} más ({listedAll.length - listed.length} sin mostrar)
                      </button>
                    </li>
                  )}
                </ul>
                {shortIds.length > 0 && (
                  <button type="button" className={`${btn} mt-3 w-full !justify-start`} onClick={() => setModal("cleanup")}>
                    <BroomIcon size={15} />
                    Limpieza rápida · {shortIds.length} trozos de menos de 1 s
                  </button>
                )}
                {edits.removed.length > 0 && (
                  <p className="mt-3 text-xs text-faint">
                    {edits.removed.length} descartadas.{" "}
                    {edits.removed.length <= 12 ? (
                      edits.removed.map((id) => (
                        <button key={id} type="button" className="tc mr-1 inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 hover:bg-raised hover:text-ink" title="Recuperar" onClick={() => setEdits(setRemoved(edits, id, false))}>
                          <ArrowCounterClockwise size={11} />
                          {defaultLabel(id)}
                        </button>
                      ))
                    ) : (
                      <IconButton label="Recuperarlas todas" onClick={() => setEdits({ ...edits, removed: [] })}>
                        <ArrowCounterClockwise size={13} />
                      </IconButton>
                    )}
                  </p>
                )}
              </Card>
            </div>
            )}
          </div>

          {/* Under both columns, so the video never covers them. */}
          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            {view !== "ball" && pitchCard}
          </div>
        </>
      )}
    </>
  );
}
