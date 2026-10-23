"use client";

import { ArrowClockwise, ArrowCounterClockwise, ArrowsMerge, ArrowsSplit, Broom, Broom as BroomIcon, Check, CheckCircle, Copy, Eraser, Eye, Eyedropper, FastForward, FloppyDisk, FolderOpen, HandPointing, MagicWand, Pause, Play, Prohibit, Rewind, Scissors, SkipBack, SkipForward, SoccerBall, Stack, TShirt, Trash, UsersThree, Warning, X, MagnifyingGlassPlus, Lightning, CircleDashed, GearSix, LineSegment, ArrowsOut, DotsThree, Crop, CircleNotch, Target, FlagCheckered, PushPin, DotsSixVertical, CornersOut, CornersIn, EyeSlash, BoundingBox, Keyboard, Anchor, Table } from "@phosphor-icons/react";
import { Pager } from "@/components/Paged";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BallStrip } from "@/components/BallStrip";
import { ViewShade } from "@/components/ViewShade";
import { COLORS, Pitch, toMeters } from "@/components/Pitch";
import { LABEL_STYLES, PlayerMark, type LabelStyle } from "@/components/PlayerMark";
import { IconButton, Modal } from "@/components/Modal";
import { Select } from "@/components/Select";
import { Command } from "@/components/Command";
import { ProcessPanel } from "@/components/workspace/ProcessPanel";
import { LoadingStage } from "@/components/workspace/LoadingStage";
import { useFocusMode } from "@/components/FocusMode";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { FilePicker, partLabel } from "@/components/LocalPick";
import { PersonTimeline, RANGE_DRAG, type JoinTarget } from "@/components/workspace/PersonTimeline";
import { SpeedControl } from "@/components/SpeedControl";
import { downloadText, fmtT, isTyping } from "@/lib/format";
import { viewPolygon, BALL_FILL_S, autoBall, ballCoverage, ballPath, eventBall, hasCorrections, holdBall, joinParts, manualBall, measuredPaths, metersPerUnit, pitchToPixel, pixelToPitch, type BallAuto, type Part } from "@/lib/parts";
import { anomalyKey, ballAnomalies, playerAnomalies, type Anomaly } from "@/lib/anomalies";
import { applyHint, applyTeamCuts, cutHints, type CutHint } from "@/lib/cuts";
import { candidatesFor, dropRange, personTimeline, rejectSuggestion, separateRange, type Suggestion } from "@/lib/suggestions";
import { buildLabels, labelsName } from "@/lib/labels";
import { localFile, listLocal, localVideo, readLocal, tracksParts, writeLocal } from "@/lib/local";
import { parseHms } from "@/lib/segments";
import { SMOOTH_DEFAULTS, smoothTrack, type SmoothOptions, type SmoothReport, type TrackPoint } from "@/lib/smooth";
import { getPref, mutate, setPref, uid, useHydrated, usePref, useStore } from "@/lib/store";
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
import { type MatchEvent, type RivalPlayer, type TrackEdits } from "@/lib/types";
import { autoEvents, pending as pendingAuto, reviewedStretches, AUTO, type Suggestion as AutoSuggestion } from "@/lib/autoEvents";
import type { FixedFile } from "@/lib/positions";
import { matchVideos } from "@/lib/videos";
import { AutoSuggestions } from "@/components/workspace/AutoSuggestions";
import { AnchorsPanel, type BoxPick } from "@/components/workspace/AnchorsPanel";
import { Notice } from "@/components/workspace/Notice";
import { nextTwice, noneIsHer, pendingTwice, skipTwice } from "@/lib/doubles";
import { dropHalfFrames } from "@/lib/anchors";
import { FOCUS_COLORS, focusBoxes, partOfData, type AnchorFocus } from "@/lib/anchors";
import { NOBODY, PLAYERS_DONE, SAMPLE_S, applyQuick, applyQuickOnto, leftovers, namedCount, nextCheckpoint, partStatus, quickModel, sampleFrames, type QuickLabel } from "@/lib/quick";

const TEAM_LABELS: Record<TeamCode, string> = { own: "Analizado", opp: "Contrario", ref: "Árbitra", unk: "Sin equipo" };
const TEAM_COLORS: Record<TeamCode, string> = { own: COLORS.own, opp: COLORS.opp, ref: "var(--color-warn)", unk: "var(--color-faint)" };
// Boxes of an anchor or a doubt, by their number (1, 2, 3...).
const CHECK_PER_PAGE = 3;
// Players selected at once in the table, and the colours of the second and third (the first is white).
const MAX_SELECTED = 3;
const MULTI_COLORS = ["var(--color-accent-300)", "var(--color-ok)"];
// The ways of working on the players, in the order of the work: anchors or quick review first, then the table (Alt + 1/2/3).
type PlayerView = "players" | "quick" | "anchors";
const PLAYER_VIEWS: { v: PlayerView; name: string; key: string; title: string; Icon: typeof Table }[] = [
  { v: "anchors", name: "Anclas", key: "1", title: "Anclas: nombrar momentos sugeridos, rellenar con Python y revisar sus dudas", Icon: Anchor },
  { v: "quick", name: "Revisión rápida", key: "2", title: "Revisión rápida: nombrar a cada jugadora siguiéndola por la parte", Icon: Lightning },
  { v: "players", name: "Mesa", key: "3", title: "Mesa: corregir cajas, unir y separar a mano", Icon: Table },
];
// Same value as LOOSE_ID in sportsan/tracking/detect.py.
const LOOSE_ID = 1_000_000;
const NO_COLORS: JerseyColors = { own: "", opp: "", ref: "", own_gk: "", opp_gk: "" };
const KIT_LABELS: Record<JerseyKey, string> = { own: "Analizado", own_gk: "Su portera", opp: "Contrario", opp_gk: "Su portera", ref: "Árbitra" };
const KIT_ORDER: JerseyKey[] = ["own", "own_gk", "opp", "opp_gk", "ref"];
const KIT_TEAM: Record<JerseyKey, TeamCode> = { own: "own", own_gk: "own", opp: "opp", opp_gk: "opp", ref: "ref" };

type Mode = null | "merge" | "manual" | "ball";
type WritableHandle = { getFile(): Promise<File>; createWritable(): Promise<{ write(t: string): Promise<void>; close(): Promise<void> }> };

// The handlers below take the event of a file input; a file read from the match folder goes through them too.
// The click that ends a drag between two boxes is not a click on a box.
const afterDrag = { on: false };
const TRACKS_PART = /^tracks_v\d+_\d+_\d+\.json$/;
const asEvent = (files: File[]) => ({ target: { files, value: "" } }) as unknown as React.ChangeEvent<HTMLInputElement>;

// A notice about the selected player: icon and number, the details in its tooltip; a click does the obvious thing.
const BADGE_TONES = {
  plain: "bg-bg/60 text-ink-2 hover:bg-raised",
  warn: "bg-warn-900/50 text-warn hover:bg-warn-900/80",
  danger: "bg-danger/15 text-danger hover:bg-danger/25",
  accent: "bg-accent/15 text-accent-300 hover:bg-accent/25",
  ok: "bg-ok/15 text-ok cursor-default",
};
function Badge({ icon, n, tone, title, onClick }: { icon: React.ReactNode; n?: number; tone: keyof typeof BADGE_TONES; title: string; onClick?: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={`tc inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs transition-colors ${BADGE_TONES[tone]}`}>
      {icon}
      {n !== undefined && <span>{n}</span>}
    </button>
  );
}

// The size of an element, kept up to date (a callback ref and its last width and height).
function useBox() {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

function Head({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  if (embedded) return <div className="mb-5 flex flex-wrap items-center gap-2">{children}</div>;
  return (
    <PageHeader
      title="Quién es quién"
    >
      {children}
    </PageHeader>
  );
}

// Correction table of the tracks of one match. Inside a match (embedded) its folder and the match of the app (for
// the tagged events used as ball positions) come from the match.
// Width of the side column (px), dragged on its edge; the video takes a share of the height of the window, dragged on
// the bar above the timeline.
const SIDE_MIN_PX = 260;
const SIDE_MAX_PX = 640;
const SIDE_DEFAULT_PX = 336;
// The panels that can go beside the video or under it (dragged by their grip).
type ModuleId = "ball" | "pitch" | "quick" | "squad" | "person" | "auto" | "anchors";
const MODULE_NAMES: Record<ModuleId, string> = { ball: "Balón", pitch: "En la cancha", quick: "Revisión rápida", squad: "Plantilla", person: "Jugadora", auto: "Sugerencias", anchors: "Anclas" };
const MODULE_DRAG = "application/x-sportsan-module";
// Held keys: an arrow plays (or rewinds) at this speed; Space held steps one processed frame every CREEP_MS.
const FAST_RATE = 4;
const FAST_TICK_MS = 100;
const HOLD_MS = 260;
const CREEP_MS = 170;
// A person with less than this share of her boxes on the pitch is somebody off it (bench, stands, coaches).
const OFF_PITCH_SHARE = 0.1;
// How long a notice stays on screen (ms).
const MSG_MS = 6000;
// A hole in the middle of the image longer than this (s) is worth a look in the table.
const FIX_GAP_S = 2;

export function Correction({
  folder,
  video = "v1",
  matchAppId,
  embedded = false,
  step,
}: { folder?: string; video?: string; matchAppId?: string; embedded?: boolean; step?: "players" | "ball" } = {}) {
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
  // Up to two more players selected with the first one (Ctrl/Shift + clic): verified together, each with her colour.
  const [multi, setMulti] = useState<number[]>([]);
  const groupColor = (id: number): string | null => (id === sel ? "#ffffff" : multi.includes(id) ? MULTI_COLORS[multi.indexOf(id) % MULTI_COLORS.length] : null);
  const toggleMulti = (id: number) => {
    if (sel === null) return setSel(id);
    if (id === sel) {
      setSel(multi[0] ?? null);
      return setMulti(multi.slice(1));
    }
    if (multi.includes(id)) return setMulti(multi.filter((x) => x !== id));
    if (multi.length >= MAX_SELECTED - 1) return setMsg(`Máximo ${MAX_SELECTED} jugadoras a la vez: quita una (Ctrl + clic sobre ella) antes de añadir otra.`);
    setMulti([...multi, id]);
  };
  const [mode, setMode] = useState<Mode>(null);
  const [goTo, setGoTo] = useState("");
  const [showShort] = useState(false);
  const [teamFilter] = useState<TeamCode | "all">("all");
  const [hideDone] = useState(true);
  // Referees are not useful for the analysis: hidden (and left out of what is exported) unless asked for.
  const [showRefs] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Choosing how much of the top and bottom of the image to hide (the sky, the stands): the whole image shows meanwhile.
  const [cropping, setCropping] = useState(false);
  const [cropDraft, setCropDraft] = useState<[number, number] | null>(null);
  // With a wide window the table fits the screen without scrolling: its height is measured from where it starts; the
  // video takes what is left above the controls (container units), the panels scroll inside.
  const rootEl = useRef<HTMLDivElement | null>(null);
  const [fitH, setFitH] = useState<number | null>(null);
  const [underH, setUnderH] = useState(56);
  // What each part of the table needs: the width of the video column, and the height of the content of the side
  // column, of the modules under the video and of the timeline panel.
  const [colRef, colBox] = useBox();
  const [sideRef, sideBox] = useBox();
  const [pitchBoxRef, pitchBox] = useBox();
  const [belowRef, belowBox] = useBox();
  const [bottomRef, bottomBox] = useBox();
  // Who has a candidate on screen in the badge of suggestions.
  const [candIdx, setCandIdx] = useState(0);
  // A player pinned (one at a time): the selected one, or a stretch of her line, joins her with J or by dragging.
  const [pinned, setPinned] = useState<number | null>(null);
  // Dragging one box onto another on the video (to join them), and what a dragged stretch is over.
  const [dragLine, setDragLine] = useState<{ from: [number, number]; to: [number, number]; target: number | null } | null>(null);
  const [dropOver, setDropOver] = useState<number | null>(null);
  // The impossible jump of the selected player being reviewed (its person and first frame).
  const [anomAt, setAnomAt] = useState<{ person: number; frame: number } | null>(null);
  // The save button tells by itself how the save went; the details of the cleaning go in its tooltip.
  const [save, setSave] = useState<{ state: "idle" | "saving" | "saved" | "downloaded" | "error"; note: string }>({ state: "idle", note: "" });
  useEffect(() => {
    if (save.state !== "saved" && save.state !== "downloaded") return;
    const t = setTimeout(() => setSave((x) => ({ ...x, state: "idle" })), 2400);
    return () => clearTimeout(t);
  }, [save.state]);
  // Kit whose colour is being taken from the video with a click.
  const [pickKit, setPickKit] = useState<JerseyKey | null>(null);
  // Used for the kit colours while no tracks file (which names its match) is loaded.
  const [matchIdText, setMatchIdText] = useState(folder || "partido_2026_09_25");
  // Previous states of the corrections of this part, for undo.
  // Undo history by part.
  const [historyBy, setHistoryBy] = useState<Record<string, TrackEdits[]>>({});
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
  const [view, setView] = useState<"players" | "ball" | "quick" | "anchors">(step === "ball" ? "ball" : "players");
  // Anchors mode: the box being asked about (suggested moment or doubt), highlighted on the video.
  const [anchorFocus, setAnchorFocus] = useState<AnchorFocus | null>(null);
  const [checkPage, setCheckPage] = useState(0);
  // Pending doubts of the anchors mode, as last said by its panel (null: not read yet).
  const [anchorPending, setAnchorPending] = useState<number | null>(null);
  // Set by the anchors panel: a click on a highlighted box of the open doubt resolves it.
  const anchorPick = useRef<BoxPick | null>(null);
  // Inside a match the step chooses players or ball; the quick review is a mode of the players step.
  const [prevStep, setPrevStep] = useState(step);
  if (step !== prevStep) {
    setPrevStep(step);
    if (step) {
      setView((v) => (step === "ball" ? "ball" : v === "quick" ? "quick" : "players"));
      setMode(step === "ball" ? "ball" : null);
    }
  }
  // The ball view is not for players: nobody stays selected (or pinned) in it.
  const [prevView, setPrevView] = useState(view);
  if (view !== prevView) {
    setPrevView(view);
    if (view === "ball") {
      setSel(null);
      setPinned(null);
    }
  }
  // Full screen: the video with its boxes, and one line on top with what matters in each view.
  const stageRef = useRef<HTMLDivElement>(null);
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const on = () => setIsFull(document.fullscreenElement !== null && document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void stageRef.current?.requestFullscreen().catch(() => undefined);
  }, []);
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
  const [qRivalDraft, setQRivalDraft] = useState("");
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
  // How people are marked over the video (box, oval at the feet, arrow over the head); b / o / v switch it.
  const labelStyle = usePref("labelStyle", "oval") as LabelStyle;
  const pitchShow = usePref("correction:pitchShow", "all") as "all" | "named" | "ball";
  // Quick review: the player all of the current one's names are moved to (fixing a mix-up).
  const [qMoveTo, setQMoveTo] = useState("");
  // Secondary work opens in a dialog: kit colours, quick cleaning of short pieces, export.
  const [modal, setModal] = useState<null | "kits" | "cleanup" | "export" | "reset" | "ballEvents" | "applyQuick" | "anomalies">(null);
  // A candidate being checked on the video ("does she go on as …?").
  const [peek, setPeek] = useState<Suggestion | null>(null);
  // Rows of the list drawn (the list of a long part has thousands of pieces).
  
  const [onlyShirt] = useState(false);
  // The list shows the people with a name (the players being corrected) unless asked for everybody.
  const listShow = usePref("correction:listShow", "named") as "named" | "all";
  // Room of each panel: the side column (px) and the share of the window's height the video may take.
  const sideW = Math.min(SIDE_MAX_PX, Math.max(SIDE_MIN_PX, Number(usePref("correction:sideW", String(SIDE_DEFAULT_PX))) || SIDE_DEFAULT_PX));
  // Modules placed under the video (the rest go in the side column).
  const belowPref = usePref("correction:below", "squad");
  const belowSet = new Set(belowPref.split(",").filter(Boolean));
  const [dragMod, setDragMod] = useState<ModuleId | null>(null);
  // Focus mode (sidebar and the match bar hidden until the pointer reaches the edge of the window).
  const focus = useFocusMode();
  // Every person marked, or only the selected one (the rest faint until the pointer is over them); h switches.
  const focusSel = usePref("correction:focus", "all") === "sel";
  // How much of the top (sky) and bottom of the image is hidden, per video; nothing while it is being chosen.
  const cropKey = `correction:crop:${folder ?? matchIdText}:${video}`;
  const [cropTopPref, cropBottomPref] = usePref(cropKey, "0,0").split(",").map((v) => Math.min(0.45, Math.max(0, Number(v) || 0)));
  const cropTop = cropping ? 0 : (cropDraft?.[0] ?? cropTopPref);
  const cropBottom = cropping ? 0 : (cropDraft?.[1] ?? cropBottomPref);

  const fps = data?.fps ?? 29.97002997;
  const frame = Math.round(time * fps);
  const key = data ? editsKey(data) : "";
  const edits = useMemo(() => state.trackEdits.find((e) => e.key === key) ?? emptyEdits(key), [state.trackEdits, key]);
  const mid = data?.match_id ?? matchIdText;
  const colors = state.jerseys[mid] || NO_COLORS;
  const writeEdits = (next: TrackEdits) => mutate((s) => ({ ...s, trackEdits: [...s.trackEdits.filter((e) => e.key !== next.key), next] }));
  const hKey = key;
  // The mode of each part is remembered (the last used; Anclas the first time).
  const modePref = usePref(`correction:mode:${key}`, "anchors");
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    if (key && view !== "ball") setView(PLAYER_VIEWS.some((x) => x.v === modePref) ? (modePref as PlayerView) : "anchors");
  }
  const history = historyBy[hKey] ?? [];
  // Every correction can be undone: the state before it is kept (the last 100).
  const setEdits = (next: TrackEdits) => {
    setHistoryBy((h) => ({ ...h, [hKey]: [...(h[hKey] ?? []).slice(-99), edits] }));
    writeEdits(next);
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistoryBy((h) => ({ ...h, [hKey]: (h[hKey] ?? []).slice(0, -1) }));
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

  // With a part loaded, the video stays inside it: its detections start and end there.
  const lo = data ? data.start_frame : 0;
  const hi = data ? data.end_frame - 1 : Number.POSITIVE_INFINITY;
  const seekFrame = useCallback(
    (f: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      v.currentTime = Math.max(0, (Math.min(hi, Math.max(lo, f)) + 0.5) / fps);
    },
    [fps, lo, hi],
  );
  const stride = data?.stride ?? 3;
  // Play / pause. A second press while play() is still starting must not leave the video in between.
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const rateRef = useRef(rate);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  // Keys held down: an arrow plays fast (or rewinds) until it is let go; Space pressed and let go plays or pauses,
  // held it steps one processed frame at a time.
  const hold = useRef({ dir: 0, timer: 0, space: false, creeping: false, creep: 0 });
  const stopFast = useCallback(() => {
    const h = hold.current;
    if (h.dir === 0) return;
    window.clearInterval(h.timer);
    const v = videoRef.current;
    if (h.dir > 0 && v) {
      v.pause();
      v.playbackRate = rateRef.current;
    }
    h.dir = 0;
  }, []);
  const stopCreep = useCallback(() => {
    const h = hold.current;
    window.clearTimeout(h.creep);
    window.clearInterval(h.creep);
    h.space = false;
    const was = h.creeping;
    h.creeping = false;
    return was;
  }, []);
  useEffect(() => {
    const startFast = (dir: 1 | -1) => {
      const h = hold.current;
      const v = videoRef.current;
      if (!v || h.dir === dir) return;
      stopFast();
      h.dir = dir;
      if (dir > 0) {
        v.playbackRate = FAST_RATE;
        void v.play().catch(() => undefined);
      } else {
        h.timer = window.setInterval(() => {
          const vv = videoRef.current;
          if (vv) seekFrame(Math.round((vv.currentTime - (FAST_RATE * FAST_TICK_MS) / 1000) * fps));
        }, FAST_TICK_MS);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (isTyping(el)) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (e.repeat) return startFast(dir);
        const step = (e.shiftKey ? Math.round(fps) : stride) * dir;
        seekFrame(Math.round(v.currentTime * fps - 0.5) + step);
      } else if (e.key === " ") {
        e.preventDefault();
        const h = hold.current;
        if (e.repeat || h.space) return;
        h.space = true;
        h.creep = window.setTimeout(() => {
          h.creeping = true;
          const tick = () => {
            const vv = videoRef.current;
            if (vv) seekFrame(Math.round(vv.currentTime * fps - 0.5) + stride);
          };
          tick();
          h.creep = window.setInterval(tick, CREEP_MS);
        }, HOLD_MS);
      } else if (e.key === "Escape") {
        setMode((m) => {
          if (m === null) {
            setSel(null);
            setMulti([]);
          }
          return null;
        });
        setPickKit(null);
        setCropping(false);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        undoRef.current();
      }
      else if (e.key === "u" && viewRef.current === "players") setMode((m) => (m === "merge" ? null : "merge"));
      else if (e.key === "p" && viewRef.current === "players") setMode((m) => (m === "manual" ? null : "manual"));
      else if (e.key === "b" && viewRef.current === "players") setMode((m) => (m === "ball" ? null : "ball"));
      else if (e.key === "z") setPref("correction:zoom", String((Number(getPref("correction:zoom", "2")) % 3) + 1));
      else if (e.key === "f") toggleFull();
      else if (e.key === "h" && viewRef.current !== "ball") setPref("correction:focus", getPref("correction:focus", "all") === "sel" ? "all" : "sel");
      else if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && Number.isFinite(hi)) {
        e.preventDefault();
        seekFrame(Math.round(lo + (Number(e.key) / 10) * (hi + 1 - lo)));
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") stopFast();
      else if (e.key === " " && hold.current.space && !stopCreep() && !isTyping(e.target)) togglePlay();
    };
    const onBlur = () => {
      stopFast();
      stopCreep();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      onBlur();
    };
  }, [fps, stride, seekFrame, togglePlay, toggleFull, stopFast, stopCreep, lo, hi]);

  // The processed parts of this video in the folder (null: no access to the folder, as on the web).
  const [partNames, setPartNames] = useState<string[] | null>(null);
  // Until the folder answers, the loading animation shows instead of the «how to start» card.
  const [listing, setListing] = useState(embedded && !!folder);
  // A part being opened (its name), while the file is read.
  const [opening, setOpening] = useState<string | null>(null);
  const relist = useCallback(() => {
    if (!embedded || !folder) return;
    void listLocal(`matches/${folder}/tracking`).then(async (files) => {
      // No tracking/ yet in a folder that exists: nothing processed. No folder at all: no access (the web).
      if (!files) {
        setPartNames((await listLocal(`matches/${folder}`)) ? [] : null);
        return setListing(false);
      }
      const names = tracksParts(files, video).sort((a, b) => Number(a.split("_")[2]) - Number(b.split("_")[2]));
      setPartNames(names);
      setListing(false);
    });
  }, [embedded, folder, video]);
  useEffect(relist, [relist]);

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
      setHistoryBy({});
      setNotice(null);
      setMsg("");
      setBIdx(0);
      // Straight to the start of the new part: seekFrame still holds the limits of the previous one and would clamp
      // the jump to its end (or its start), a frame whose calibration is not this part's.
      const v = videoRef.current;
      if (v) {
        v.pause();
        v.currentTime = (d.start_frame + 0.5) / (d.fps || fps);
      }
    } catch {
      setData(null);
      setMsg("Ese archivo no es una parte de tracking (se espera tracks_<video>_<inicio>_<fin>.json).");
    } finally {
      setOpening(null);
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

  // Opens a part of the folder (a name relative to tracking/) in the table. Called from effects and clicks, after the
  // render that defines onTracks.
  const openRel = (rel: string) => {
    if (!folder) return;
    void localFile(`matches/${folder}/tracking/${rel}`).then((f) => f && void onTracks(asEvent([f])));
  };
  // With parts and nothing open yet, the first part of the folder opens by itself.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || data || !partNames?.length) return;
    autoOpened.current = true;
    openRel(partNames[0]);
    // openRel is a new function each render; the part opens once, when the list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partNames, data]);

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
  // The ball tracker's work on this part (python -m sportsan.tracking.ball run), if it ran: its sure frames and where
  // it asks for a hand mark.
  const [ballAuto, setBallAuto] = useState<BallAuto | null>(null);
  const autoKey = data ? `matches/${matchIdText}/tracking/ball_auto_${data.video_id}_${data.start_frame}_${data.end_frame}.json` : "";
  useEffect(() => {
    if (!autoKey) return;
    let live = true;
    void readLocal(autoKey).then((text) => {
      if (!live) return;
      try {
        const d = text ? (JSON.parse(text) as BallAuto & { kind?: string }) : null;
        setBallAuto(d && d.kind === "ball_auto" && Array.isArray(d.frames) ? { frames: d.frames, ask: d.ask ?? [] } : null);
      } catch {
        setBallAuto(null);
      }
    });
    return () => {
      live = false;
    };
  }, [autoKey]);
  const ballKnown = useMemo(
    () => (data ? [...(attack ? eventBall(data, matchEvents, attack === "right") : []), ...autoBall(data, ballAuto, edits), ...manualBall(data, edits)] : []),
    [data, edits, matchEvents, attack, ballAuto],
  );
  const ball = useMemo(() => (data ? ballPath(ballKnown, data.fps, data.stride, BALL_FILL_S, edits.ballLinks ?? []) : []), [data, ballKnown, edits.ballLinks]);
  // A line by hand: the mark where the ball leaves, waiting for the click where it lands.
  const [ballLinkFrom, setBallLinkFrom] = useState<number | null>(null);
  // Frames where the ball comes from a tagged event or from the ball tracker: they count for the part as the hand marks do.
  const eventBallFrames = ball.filter((x) => x.source === "event" || x.source === "auto").map((x) => x.frame);
  // The tracker's ball in this frame (when no hand mark replaces it), and the frames where it asks for a hand mark that
  // are still without ball.
  const autoHere = pf !== null && !(edits.ball ?? []).some((b) => b.frame === pf) && !(edits.ballRejected ?? []).includes(pf) ? (ballAuto?.frames.find((a) => a.frame === pf) ?? null) : null;
  const asksLeft = (ballAuto?.ask ?? []).filter((f) => !ball.some((b) => b.frame === f && b.source !== "interpolated"));
  // k: the ball stays where it was last marked until this frame (a goal kick or a corner while the taker gets ready).
  const holdHere = () => {
    if (!data || pf === null) return;
    const next = holdBall(data, edits, pf);
    if (!next) return setMsg("Para mantener el balón hace falta una marca tuya antes, y calibración en los dos cuadros.");
    setEdits(next);
    setMsg(`Balón quieto desde la marca anterior hasta ${fmtT(pf / fps)}.`);
  };
  // Impossible movements of this part (lib/anomalies.ts): a player whose name jumped to someone else, a frame whose
  // calibration is off (many jump at once) and a ball that would fly faster than any shot (a mark on a ball in the air).
  const anomalies = useMemo(() => {
    if (!data) return [];
    const ok = new Set(edits.anomalyOk ?? []);
    return [...playerAnomalies(data, edits), ...ballAnomalies(ball, data)].filter((a) => !ok.has(anomalyKey(a)));
  }, [data, edits, ball]);
  const ballOdd = anomalies.filter((a) => a.kind === "ball").sort((a, b) => a.frame - b.frame);
  const goAnomaly = (a: Anomaly) => {
    seekFrame(a.kind === "player" ? a.frame : Math.max(data?.start_frame ?? 0, a.frame - stride));
    if (a.person !== undefined) setSel(a.person);
    if (a.kind === "player" && a.person !== undefined) setAnomAt({ person: a.person, frame: a.frame });
    if (a.kind === "ball" && view !== "ball") {
      setView("ball");
      setMode("ball");
    }
  };
  // a (ball view): the next impossible jump of the ball, from the start again after the last.
  const nextBallAnomaly = () => {
    if (ballOdd.length === 0) return setMsg("El balón no tiene saltos imposibles en esta parte.");
    goAnomaly(ballOdd.find((a) => a.frame > frame + stride) ?? ballOdd[0]);
  };
  // Alt + Q: the hand mark just before this frame goes (in an impossible jump it is often the earlier mark that is wrong).
  const removePrevBall = () => {
    if (pf === null) return;
    const prev = (edits.ball ?? []).filter((b) => b.frame < pf).sort((x, y) => y.frame - x.frame)[0];
    if (!prev) return setMsg("No hay una marca de balón antes de este cuadro.");
    setEdits(removeBall(edits, prev.frame));
    setMsg(`Quitada la marca de balón de ${fmtT(prev.frame / fps)}. Ctrl + Z la recupera.`);
  };
  // Supr: the hand mark of this frame goes; without one, the tracker's ball of this frame is rejected.
  const removeBallHere = () => {
    if (pf === null) return;
    if ((edits.ball ?? []).some((b) => b.frame === pf)) return setEdits(removeBall(edits, pf));
    if (autoHere) setEdits({ ...edits, ballRejected: [...new Set([...(edits.ballRejected ?? []), pf])] });
  };

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "L" || !e.shiftKey || isTyping(e.target) || e.ctrlKey || e.metaKey) return;
      const i = LABEL_STYLES.findIndex((o) => o.id === labelStyle);
      setPref("labelStyle", LABEL_STYLES[(i + 1) % LABEL_STYLES.length].id);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [labelStyle]);
  const bKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    bKeys.current = (e: KeyboardEvent) => {
      if (view !== "ball" || isTyping(e.target) || e.ctrlKey || e.metaKey) return;
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.repeat) return;
      // Arrows: one step (the interval chosen); Alt + arrows: one processed frame; Tab: two steps (Shift + Tab back).
      if (e.key === "Enter") bNotSeen();
      else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.altKey) seekFrame(frame + (e.key === "ArrowRight" ? stride : -stride));
      else if (e.key === "ArrowRight" && !e.shiftKey) bStep(1);
      else if (e.key === "ArrowLeft" && !e.shiftKey) bStep(-1);
      else if (e.key === "Tab") bStep(e.shiftKey ? -2 : 2);
      else if (e.key === "n") nextMissingBall();
      else if (e.key === "i") startBallLine();
      else if (e.key === "k") holdHere();
      else if (e.key === "a" && !e.altKey) nextBallAnomaly();
      else if ((e.key === "q" || e.code === "KeyQ") && e.altKey) removePrevBall();
      else if ((e.key === "Backspace" || e.key === "Delete") && pf !== null) removeBallHere();
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

  // The ball marked at a pixel of this frame (a click on the video, or on the drawing of the pitch taken to the video).
  const markBallAt = (b: [number, number]) => {
    if (pf === null) return;
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
  };
  // A click on the drawing of the pitch in the ball view: the ball there (on the ground), taken to this frame's pixel.
  const pitchSvg = useRef<SVGSVGElement>(null);
  const onPitchClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (view !== "ball" || !data || pf === null || !pitchSvg.current) return;
    const m = toMeters(pitchSvg.current, e);
    const px = pitchToPixel(data, row?.H, m.x, m.y);
    if (!px) return setMsg("Este cuadro no tiene calibración: marca el balón sobre el video.");
    markBallAt([Math.round(px[0] * 10) / 10, Math.round(px[1] * 10) / 10]);
  };

  const onOverlayClick = (e: React.MouseEvent) => {
    if (afterDrag.on) return;
    if (pickKit) return sampleKit(e.clientX, e.clientY);
    if (mode === "ball" && pf !== null) {
      const b = toPixels(e);
      if (b) markBallAt([b[0], b[1]]);
      return;
    }
    if (mode !== "manual" || sel === null || pf === null) return;
    const p = toPixels(e);
    if (!p) return;
    videoRef.current?.pause();
    setEdits(setManual(edits, sel, pf, Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10));
    if (anomCur && pf >= anomCur.frame - stride) {
      const end = anomCur.until ?? anomCur.frame + stride;
      if (pf + stride < end) seekFrame(pf + stride);
      else setMode(null);
    }
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
    if (view === "ball" || afterDrag.on) return;
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
  // translate(t) scale(z) puts a point p at z * p + t: the point goes to the middle of what is shown (the image less
  // its crop), without showing past the edges of the image.
  const zoomTo = (center: [number, number] | null): string | undefined => {
    if (zoom <= 1 || !center || !dims || cropping) return undefined;
    const tx = Math.min(0, Math.max(1 - zoom, 0.5 - (zoom * center[0]) / dims.w)) * 100;
    const ty = Math.min(cropTop, Math.max(1 - cropBottom - zoom, (1 - cropTop - cropBottom) / 2 + cropTop - (zoom * center[1]) / dims.h)) * 100;
    return `translate(${tx}%, ${ty}%) scale(${zoom})`;
  };
  const peekAt = (s: Suggestion) => {
    setPeek(s);
    seekFrame(Math.max(data?.start_frame ?? 0, s.frameFrom - Math.round(fps)));
    videoRef.current?.play().catch(() => undefined);
  };
  // The other person of the candidate being checked (the selected one is the other side).
  const peekOther = peek && sel !== null ? (peek.from === sel ? peek.to : peek.from) : null;
  const candList = [...cand.next.map((x) => ({ verb: "sigue como", x, other: x.to })), ...cand.prev.map((x) => ({ verb: "viene de", x, other: x.from }))];
  // The badge of suggestions shows one: the one being checked, or the one chosen with its arrow.
  const candI = peek && candList.some((c) => c.x === peek) ? candList.findIndex((c) => c.x === peek) : Math.max(0, Math.min(candIdx, candList.length - 1));
  const nextCand = () => {
    const next = (candI + 1) % candList.length;
    setCandIdx(next);
    if (peek) peekAt(candList[next].x);
  };
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

  const workspaceShown = !!data && !!fileUrl;
  useEffect(() => {
    const measure = () => {
      const el = rootEl.current;
      if (!el || window.innerWidth < 1280) return setFitH(null);
      setFitH(Math.max(420, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 16)));
    };
    const raf = requestAnimationFrame(measure);
    // Again once the bars of the focus mode have slid away.
    const late = window.setTimeout(measure, 320);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
      window.removeEventListener("resize", measure);
    };
  }, [workspaceShown, focus]);
  // The controls and notices under the video: the video leaves them their room.
  const underRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setUnderH(Math.round(e.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- joining (pinned player, drag and drop)
  // Two people into one: the one with a name keeps it (the target, when both or neither have one).
  const joinPeople = (from: number, to: number) => {
    if (from === to) return;
    const [into, other] = !personById.get(to)?.player_id && personById.get(from)?.player_id ? [from, to] : [to, from];
    if (!tryMerge(into, other)) return;
    if (sel === other) setSel(into);
    if (pinned === other) setPinned(into);
    setMsg(`Unidas en ${label(personById.get(into), into)}. Ctrl + Z lo deshace.`);
  };
  // A stretch of somebody's line goes to another person: to fill a hole without cutting and joining by hand.
  const joinRange = (person: number, from: number, to: number, target: number) => {
    if (!data || person === target) return;
    const r = separateRange(edits, data, person, from, to);
    if (r.identity === null) return setMsg("No hay cajas suyas en ese tramo.");
    const c = clash(data, r.edits, target, r.identity);
    if (c.apart.length > 0) {
      return setMsg(`No se unió: ${label(personById.get(target), target)} ya está en otro sitio en ${c.apart.length} cuadro(s) de ese tramo.`);
    }
    setEdits(merge(dropBoxes(r.edits, c.drop), target, r.identity));
    setMsg(`${fmtT(from / fps)}–${fmtT((to + stride) / fps)} pasa a ${label(personById.get(target), target)}. Ctrl + Z lo deshace.`);
  };
  const pinnedP = pinned !== null ? (personById.get(pinned) ?? null) : null;
  const pinnedLine = useMemo(() => (data && pinned !== null && pinned !== sel ? personTimeline(data, edits, pinned).map((x) => x.frame) : []), [data, edits, pinned, sel]);
  // k pins (or lets go) the selected player; j joins the selected one to the pinned one.
  const togglePin = () => {
    if (sel === null) return;
    setPinned(pinned === sel ? null : sel);
  };
  const joinToPinned = () => {
    if (sel === null || pinned === null || sel === pinned) return;
    const from = sel;
    joinPeople(from, pinned);
    setSel(null);
  };
  // The box under a point of the video (pixels), other than `except`.
  const boxAt = (pt: [number, number], except?: number): number | null => {
    const pad = dotR;
    const hit = shown.filter(({ b, id }) => id !== except && pt[0] >= b[1] - pad && pt[0] <= b[3] + pad && pt[1] >= b[2] - pad && pt[1] <= b[4] + pad);
    // The nearest feet, if several boxes overlap there.
    hit.sort((u, v) => Math.hypot((u.b[1] + u.b[3]) / 2 - pt[0], u.b[4] - pt[1]) - Math.hypot((v.b[1] + v.b[3]) / 2 - pt[0], v.b[4] - pt[1]));
    return hit[0]?.id ?? null;
  };
  // Pressing on a box and letting go on another joins them.
  const startBoxDrag = (e: React.PointerEvent, id: number, b: (typeof shown)[number]["b"]) => {
    if (e.button !== 0 || mode !== null || pickKit || view !== "players") return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const from: [number, number] = [(b[1] + b[3]) / 2, b[4]];
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
      if (!moved) videoRef.current?.pause();
      moved = true;
      const pt = toPixels(ev);
      if (pt) setDragLine({ from, to: pt, target: boxAt(pt, id) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      setDragLine(null);
      if (!moved) return;
      afterDrag.on = true;
      window.setTimeout(() => (afterDrag.on = false), 0);
      const pt = toPixels(ev);
      const target = pt ? boxAt(pt, id) : null;
      if (target !== null) joinPeople(id, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  // A stretch of the timeline dropped on a person (a box of the video, a row, the pinned one).
  const readRange = (e: React.DragEvent) => {
    try {
      const r = JSON.parse(e.dataTransfer.getData(RANGE_DRAG)) as { person: number; from: number; to: number };
      return Number.isFinite(r.person) && Number.isFinite(r.from) && Number.isFinite(r.to) ? r : null;
    } catch {
      return null;
    }
  };
  const dropOn = (target: number | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (target === null || !e.dataTransfer.types.includes(RANGE_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropOver(target);
    },
    onDragLeave: () => setDropOver(null),
    onDrop: (e: React.DragEvent) => {
      setDropOver(null);
      const r = readRange(e);
      if (!r || target === null) return;
      e.preventDefault();
      joinRange(r.person, r.from, r.to, target);
    },
  });
  // The named people a stretch can go to, in the order of the squad.
  const qOrder = new Map((state.roster ?? []).map((r) => [r.player_id, r.number ?? 999]));
  const joinTargets: JoinTarget[] = ppl
    .filter((p) => p.player_id && !refIds.has(p.id))
    .sort((a, b) => (qOrder.get(a.player_id) ?? 999) - (qOrder.get(b.player_id) ?? 999) || a.player_id.localeCompare(b.player_id))
    .map((p) => ({ id: p.id, label: label(p, p.id), color: TEAM_COLORS[p.team] }));

  // ---------------------------------------------------------------- impossible jumps of the selected player
  // Marked on her line; reviewed one by one: leave the frames out (the box lost her feet: they are filled on save),
  // mark her feet by hand, or say it is fine.
  const selAnoms = sel === null ? [] : anomalies.filter((a) => a.kind === "player" && a.person === sel).sort((a, b) => a.frame - b.frame);
  const anomOn = anomAt !== null && anomAt.person === sel && view === "players";
  const anomCur = anomOn ? (selAnoms.find((a) => a.frame === anomAt.frame) ?? null) : null;
  const anomFrames = (a: Anomaly) => Math.max(1, Math.round(((a.until ?? a.frame + stride) - a.frame) / stride));
  const anomGo = (a: Anomaly) => {
    if (a.person === undefined) return;
    setAnomAt({ person: a.person, frame: a.frame });
    setMode(null);
    seekFrame(a.frame);
  };
  const anomStep = (dir: 1 | -1) => {
    if (selAnoms.length === 0) return setMsg("No le quedan saltos imposibles por revisar.");
    const from = anomOn ? anomAt.frame : frame;
    const next = dir > 0 ? (selAnoms.find((a) => a.frame > from) ?? selAnoms[0]) : ([...selAnoms].reverse().find((a) => a.frame < from) ?? selAnoms[selAnoms.length - 1]);
    anomGo(next);
  };
  // After one is solved, on to her next one (the list still holds the solved one).
  const anomDone = (a: Anomaly, next: TrackEdits) => {
    setEdits(next);
    const rest = selAnoms.filter((x) => x !== a);
    const after = rest.find((x) => x.frame > a.frame) ?? rest[0];
    if (after) anomGo(after);
    else {
      setAnomAt(null);
      setMode(null);
      setMsg("No le quedan saltos imposibles por revisar. Ctrl + Z deshace el último cambio.");
    }
  };
  const anomDrop = (a: Anomaly) => data && a.person !== undefined && anomDone(a, dropRange(edits, data, a.person, a.frame, (a.until ?? a.frame + stride) - 1));
  const anomDropAll = () => {
    if (!data || selAnoms.length === 0) return;
    let next = edits;
    for (const a of selAnoms) if (a.person !== undefined) next = dropRange(next, data, a.person, a.frame, (a.until ?? a.frame + stride) - 1);
    const n = selAnoms.reduce((t, a) => t + anomFrames(a), 0);
    setEdits(next);
    setAnomAt(null);
    setMode(null);
    setMsg(`Quitados ${n} cuadro(s) de ${selAnoms.length} salto(s): se rellenan al guardar. Ctrl + Z lo deshace.`);
  };
  // Alt + Q: the position before the jump goes instead (its box, or her feet marked by hand there).
  const anomDropPrev = (a: Anomaly) => {
    if (!data || a.person === undefined || a.before === undefined) return;
    const hand = edits.manual.some((m) => m.identity === a.person && m.frame === a.before);
    anomDone(a, hand ? removeManual(edits, a.person, a.before) : dropRange(edits, data, a.person, a.before, a.before));
    setMsg(`Quitado el cuadro anterior al salto (${fmtT((a.before ?? 0) / fps)}): se rellena al guardar. Ctrl + Z lo deshace.`);
  };
  const anomOk = (a: Anomaly) => anomDone(a, { ...edits, anomalyOk: [...new Set([...(edits.anomalyOk ?? []), anomalyKey(a)])] });
  const anomFix = (a: Anomaly) => {
    seekFrame(a.frame);
    setMode("manual");
  };
  // While a jump is under review: Q leaves its frames out, Enter says it is fine, A / Shift + A next / previous, Esc
  // closes the review (the player stays selected). P (mark by hand) is the table's own key.
  const anomKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    anomKeys.current = (e: KeyboardEvent) => {
      if (!anomOn || isTyping(e.target) || e.ctrlKey || e.metaKey || peek) return;
      const k = e.key.toLowerCase();
      if ((k === "q" || e.code === "KeyQ") && e.altKey && anomCur) anomDropPrev(anomCur);
      else if (e.altKey) return;
      else if (k === "q" && anomCur) anomDrop(anomCur);
      else if (k === "enter" && anomCur && mode === null) anomOk(anomCur);
      else if (k === "a") anomStep(e.shiftKey ? -1 : 1);
      else if (k === "escape" && mode === null) setAnomAt(null);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => anomKeys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Places where a person is probably two: impossible jumps, short excursions to somebody else, changes of shirt.
  // Measured on the first corrected part: the changes of shirt were real changes of person 5 times out of 6; the big
  // jumps were nearly always the same player with a wrong position (feet hidden), which the export cleans by itself.
  const allCutHints = cutAll.filter((h) => !refIds.has(h.person));
  const hints = allCutHints.filter((h) => h.kind === "team");
  const hintsByPerson = new Map<number, CutHint[]>();
  for (const h of hints) hintsByPerson.set(h.person, [...(hintsByPerson.get(h.person) ?? []), h]);
  // Her changes of shirt, and the one on screen (to cut it).
  const selHints = sel !== null ? (hintsByPerson.get(sel) ?? []) : [];
  const hintHere = selHints.find((h) => Math.abs(h.frame - frame) <= 1.5 * fps) ?? null;
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
  // A few people worth a look without the whole list: named and not yet verified, the longest first.
  const namedToCheck = ppl.filter((p) => p.player_id && !p.done && !refIds.has(p.id)).sort((a, b) => b.frames.length - a.frames.length);
  const checkPages = Math.max(1, Math.ceil(namedToCheck.length / CHECK_PER_PAGE));
  const checkPageNow = Math.min(checkPage, checkPages - 1);

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

  // Dragging a divider: `apply` gets how far the pointer moved (px) since it was pressed.
  const dragBy = (e: React.PointerEvent<HTMLElement>, apply: (dx: number, dy: number) => void) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => apply(ev.clientX - x0, ev.clientY - y0);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const dragSide = (e: React.PointerEvent<HTMLElement>) => {
    const w0 = sideW;
    dragBy(e, (dx) => setPref("correction:sideW", String(Math.round(Math.min(SIDE_MAX_PX, Math.max(SIDE_MIN_PX, w0 - dx))))));
  };
  const moveModule = (m: ModuleId, where: "side" | "below") => {
    const next = new Set(belowSet);
    if (where === "below") next.add(m);
    else next.delete(m);
    setPref("correction:below", [...next].join(","));
  };
  // Crop: the edges of the image are dragged on the video while choosing it; kept per video.
  const dragCrop = (e: React.PointerEvent<HTMLElement>, edge: "top" | "bottom") => {
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    const base: [number, number] = [cropTopPref, cropBottomPref];
    let last = base;
    const el = e.currentTarget;
    dragBy(e, (_dx, dy) => {
      const y = (edge === "top" ? base[0] * box.height : box.height - base[1] * box.height) + dy;
      last = edge === "top" ? [Math.min(0.45, Math.max(0, y / box.height)), base[1]] : [base[0], Math.min(0.3, Math.max(0, 1 - y / box.height))];
      setCropDraft(last);
    });
    el.addEventListener(
      "pointerup",
      () => {
        setPref(cropKey, `${last[0].toFixed(3)},${last[1].toFixed(3)}`);
        setCropDraft(null);
      },
      { once: true },
    );
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
  // Double boxes of the selected one still to look at (the skipped ones are remembered for this part).
  // Of every selected player (up to 3), in one walk ordered by time.
  const group = [selected, ...multi.map((id) => personById.get(id))].filter((p): p is Person => !!p);
  const twiceOf = (e: typeof edits) => group.flatMap((p) => pendingTwice(p.conflicts, p.id, e).map((f) => ({ id: p.id, frame: f }))).sort((a, b) => a.frame - b.frame || a.id - b.id);
  const twiceList = twiceOf(edits);
  const selTwice = twiceList.map((x) => x.frame);
  // The double box being looked at: the one at this frame, or the next.
  const twiceAt = () => twiceList.find((x) => Math.abs(x.frame - frame) <= stride) ?? null;
  const afterTwice = (next: typeof edits, at: { id: number; frame: number }, note: string) => {
    setEdits(next);
    const from = at.frame;
    const left = twiceOf(next).filter((x) => !(x.id === at.id && x.frame === from)).map((x) => x.frame);
    const n = nextTwice(left, from);
    if (n !== null) seekFrame(n);
    setMsg(`${note}${n !== null ? ` Quedan ${left.length}.` : " No quedan cajas dobles de ella."} Ctrl + Z lo deshace.`);
  };
  // e: «Siguiente / saltar» (nothing edited, not shown again); 0: «Ninguna es ella» (both boxes out of her ±0.5 s).
  const twiceSkip = () => {
    const at = twiceAt();
    if (at === null) return nextOf(selTwice);
    afterTwice(skipTwice(edits, at.id, at.frame), at, "Caja doble saltada.");
  };
  const twiceNone = () => {
    const at = twiceAt();
    if (at === null) return setMsg("Ve primero a un cuadro con dos cajas de ella (d).");
    const r = noneIsHer(edits, data!, at.id, at.frame, dropHalfFrames(fps));
    afterTwice(skipTwice(r.edits, at.id, at.frame), at, `Ninguna era ${label(personById.get(at.id), at.id)}: ${r.boxes} caja(s) quitada(s) de ella (±0.5 s).`);
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
  // with two boxes, v verified, m keep one box where her two sit in the same place, Supr not a player.
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
      else if (k === "d") nextOf(selTwice);
      else if (k === "e" && selTwice.length) twiceSkip();
      else if (k === "0" && selTwice.length) twiceNone();
      else if (k === "v") toggleChecked();
      // m: where her two boxes sit in the same place, keep one (the more confident).
      else if (k === "m") unifySelf();
      else if (k === "a") anomStep(e.shiftKey ? -1 : 1);
      else if (k === "k") togglePin();
      else if (k === "j" && pinned !== null) joinToPinned();
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
      // `view`: what the camera saw in each frame, on the pitch (for the shadow of the animations).
      frames: data.frames.map((fr) => {
        const v = viewPolygon(data, fr.H);
        return { frame: fr.frame, positions: byFrameOut.get(fr.frame) ?? [], ...(v ? { view: v } : {}) };
      }),
    };
    const note = smoothOn
      ? `Suavizado: ${totals.outliers} microsalto(s) quitado(s), ${totals.filled} posición(es) rellenada(s), ${totals.openGaps} hueco(s) vacío(s).`
      : "Tal como se midió, sin suavizar ni rellenar.";
    void Promise.all([saveFixed(`tracks_fixed_${data.video_id}_${data.start_frame}_${data.end_frame}.json`, JSON.stringify(out)), saveLabels(data, edits)])
      .then(([ok]) => setSave({ state: ok ? "saved" : "downloaded", note: ok ? `Guardado en matches/${mid}/tracking/. ${note}` : `Descargado (no hay acceso a la carpeta). ${note}` }))
      .catch(() => setSave({ state: "error", note: "No se pudo guardar." }));
  };
  // The spinner shows before the (slow) cleaning of every path starts.
  const saveNow = () => {
    if (!data || save.state === "saving") return;
    setSave({ state: "saving", note: "" });
    window.setTimeout(() => {
      try {
        exportFixed();
      } catch {
        setSave({ state: "error", note: "No se pudo guardar." });
      }
    }, 40);
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
    const mc = multi.includes(p.id) ? groupColor(p.id) : null;
    return (
      <li
        key={p.id}
        onClickCapture={(e) => {
          if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
          e.preventDefault();
          e.stopPropagation();
          toggleMulti(p.id);
        }}
        title="Ctrl/Shift + clic: añadir o quitar de la selección (hasta 3)"
        style={mc ? { boxShadow: `inset 3px 0 0 ${mc}` } : undefined}
        {...dropOn(isSel ? null : p.id)}
        className={`grid grid-cols-[5.5rem_1.15rem_minmax(4rem,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1 transition-colors ${
          dropOver === p.id ? "bg-accent/25" : isSel ? "bg-accent/15 shadow-[inset_0_0_0_1px_rgba(74,114,255,.5)]" : "hover:bg-raised/50"
        } ${p.done && !isSel ? "opacity-55" : ""}`}
      >
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
  const rivalsSaved = useMemo(() => state.rivals?.[mid] ?? [], [state.rivals, mid]);
  const rivalList = useMemo(() => {
    const all = new Map<number, RivalPlayer>(rivalsSaved.map((r) => [r.number, r]));
    for (const l of qLabels) if (/^R\d+$/.test(l.name) && !all.has(Number(l.name.slice(1)))) all.set(Number(l.name.slice(1)), { number: Number(l.name.slice(1)) });
    return [...all.values()].sort((a, b) => a.number - b.number);
  }, [rivalsSaved, qLabels]);
  const qNumber = new Map<string, number | null>([...qRoster.map((r) => [r.player_id, r.number] as const), ...rivalList.map((r) => [`R${r.number}`, r.number] as const)]);
  const isRival = (name: string) => /^R\d+$/.test(name);
  // How a name is shown: dorsal and name (a rival without a name, by her dorsal).
  const qShow = (name: string) => {
    if (!isRival(name)) return `${qNumber.get(name) ?? ""} ${name}`.trim();
    const r = rivalList.find((x) => `R${x.number}` === name);
    return r?.name ? `${r.number} ${r.name}` : name;
  };
  // «7 Pérez» adds (or renames) the rival with dorsal 7.
  const addRival = (text: string): boolean => {
    const m = text.trim().match(/^(\d{1,3})\s*(.*)$/);
    if (!m) {
      setMsg("Escribe su dorsal y, si quieres, su nombre: «7 Pérez».");
      return false;
    }
    const number = Number(m[1]);
    const name = m[2].trim() || undefined;
    mutate((st) => ({ ...st, rivals: { ...(st.rivals ?? {}), [mid]: [...(st.rivals?.[mid] ?? []).filter((r) => r.number !== number), { number, ...(name ? { name } : {}) }] } }));
    return true;
  };
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
  // Mesa / Revisión rápida / Anclas (the segmented control and Alt + 1/2/3).
  const switchView = (v: PlayerView) => {
    if (v === view) return;
    if (key) setPref(`correction:mode:${key}`, v);
    setView(v);
    setMode(null);
    if (v === "anchors") setSel(null);
    if (v === "quick") qGo(qIdx);
  };
  const viewKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    viewKeys.current = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !data || view === "ball" || isTyping(e.target)) return;
      const pv = PLAYER_VIEWS.find((x) => e.code === `Digit${x.key}` || e.key === x.key);
      if (!pv) return;
      e.preventDefault();
      switchView(pv.v);
    };
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => viewKeys.current(e);
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
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
      const team = isRival(pred) ? "opp" : qNumber.has(pred) ? "own" : qTeam;
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
  // The next player of the squad still to do (all done: just the next one).
  const qNextPlayer = (done: string[] = []) => {
    const names = qPlayerTeam === "opp" ? rivalList.map((r) => `R${r.number}`) : qRoster.map((r) => r.player_id);
    if (names.length === 0) return;
    const i = qPlayer ? names.indexOf(qPlayer) : -1;
    const order = names.map((_, k) => names[(i + 1 + k) % names.length]);
    qPickPlayer(order.find((n) => !done.includes(n) && n !== qPlayer) ?? order[0], qPlayerTeam);
  };
  const qDone = edits.quick?.done ?? [];
  // Reviewed to the end of the part: counts for the part to be complete; on to the next one.
  const qMarkDone = () => {
    if (!qPlayer) return;
    const done = [...new Set([...qDone, qPlayer])];
    const r = finishIfComplete({ ...edits, quick: { labels: qLabels, seen: qSeen, done } });
    setEdits(r.edits);
    if (r.note) setMsg(r.note);
    qNextPlayer(done);
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
      // Held arrows: fast-forward of the table (below).
      if ((k === "ArrowRight" || k === "ArrowLeft") && e.repeat) return;
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
        else if (k === "Tab") qNextPlayer(qDone);
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
  // Anchors mode: every box of the suggestion or of the open doubt, numbered; the rest dimmed.
  const anchorHere = view === "anchors" && anchorFocus && pf !== null && Math.abs(pf - anchorFocus.frame) <= stride ? anchorFocus : null;
  const anchorHits = anchorHere ? focusBoxes(anchorHere.marks, shown, (id) => personById.get(id)?.player_id || undefined) : null;
  const anchorTracks = new Set(anchorHits?.found.map((f) => f.b[0]) ?? []);
  const anchorMissing =
    [
      anchorHits?.missing.length ? `No sale en este cuadro: ${anchorHits.missing.map((m) => (m.label === "?" ? m.what : `${m.label} ${m.what}`)).join(", ")}.` : "",
      ...(anchorHits?.same ?? []).map((x) => `${x.mark.label} (${x.mark.what}) es la misma caja que ${x.as.label}.`),
    ]
      .filter(Boolean)
      .join(" ") || null;
  const anchorCenter: [number, number] | null = anchorHits?.found.length
    ? (() => {
        const bs = anchorHits.found.map((f) => f.b);
        return [(Math.min(...bs.map((b) => b[1])) + Math.max(...bs.map((b) => b[3]))) / 2, (Math.min(...bs.map((b) => b[2])) + Math.max(...bs.map((b) => b[4]))) / 2];
      })()
    : null;
  const zoomTransform = zoomTo(view === "players" ? zoomCenter : view === "ball" ? ballCenter : view === "quick" ? quickCenter : view === "anchors" ? anchorCenter : null);

  // ---------------------------------------------------------------- events suggested from the reviewed ball
  // Only in the ball view, on what the ball review went through, with the direction of play said for this video.
  const autoAll = useMemo<AutoSuggestion[]>(() => {
    const seen = edits.ballReview?.seen ?? [];
    if (!data || view !== "ball" || !attack || seen.length === 0) return [];
    const byFrame = new Map<number, FixedFile["frames"][number]["positions"]>();
    for (const [id, pts] of paths)
      for (const q of pts) {
        const list = byFrame.get(q.frame) ?? [];
        list.push({ id, x: q.x, y: q.y, source: q.source });
        byFrame.set(q.frame, list);
      }
    const file: FixedFile = {
      kind: "tracks_fixed",
      match_id: data.match_id,
      video_id: data.video_id,
      fps: data.fps,
      start_frame: data.start_frame,
      end_frame: data.end_frame,
      stride: data.stride,
      venue: data.venue?.length_m && data.venue?.width_m ? { length_m: data.venue.length_m, width_m: data.venue.width_m } : null,
      people: ppl.filter((q) => q.team === "own" || q.team === "opp").map((q) => ({ id: q.id, team: q.team, player_id: q.player_id || null, tracks: q.tracks })),
      ball: ball.map((b) => ({ frame: b.frame, x: b.x, y: b.y, source: b.source })),
      frames: data.frames.map((fr) => ({ frame: fr.frame, positions: byFrame.get(fr.frame) ?? [] })),
    };
    const half = (bEvery * data.fps) / 2;
    return autoEvents({
      file,
      ownRight: attack === "right",
      reviewed: reviewedStretches([...seen, ...(edits.ball ?? []).map((b) => b.frame)], bEvery, data.fps),
      out: seen.filter((f) => !(edits.ball ?? []).some((b) => Math.abs(b.frame - f) <= half)),
      links: edits.ballLinks ?? [],
    });
  }, [data, view, attack, edits.ballReview, bEvery, paths, ppl, ball, edits.ball, edits.ballLinks]);
  const autoList = data ? pendingAuto(autoAll, matchEvents, data.video_id, data.fps, edits.autoRejected ?? []) : [];
  // The suggestion at this moment: the nearest within the duplicate window, the coming one first.
  const autoActive =
    autoList
      .filter((s) => Math.abs(s.frame - frame) <= AUTO.duplicateS * fps)
      .sort((a, b) => Math.abs(a.frame - frame) - Math.abs(b.frame - frame))[0] ?? null;
  const autoBlocked = !attack
    ? "Indica hacia dónde atacamos en este video (engrane del balón) para leer los eventos."
    : bSeen.length === 0
      ? "Aparecen al revisar el balón: solo se leen los tramos ya revisados."
      : undefined;
  const acceptAuto = (s: AutoSuggestion, i: number) => {
    const opt = s.options[i];
    if (!opt || !data) return;
    if (opt.events.length === 0) {
      setEdits({ ...edits, autoRejected: [...new Set([...(edits.autoRejected ?? []), s.id])] });
      return setMsg(`«${opt.label}»: sin eventos.`);
    }
    const m = state.matches.find((x) => x.match_id === eventsMatchId);
    if (!m) return setMsg("Elige el partido de los eventos en el engrane del balón.");
    const vids = matchVideos(m);
    const vi = vids.findIndex((v) => v.video_id === data.video_id);
    const period = vids[vi]?.period ?? (vi <= 0 ? 1 : 2);
    const evs: MatchEvent[] = opt.events.map((e) => ({
      event_id: uid("e"),
      match_id: m.match_id,
      video_id: data.video_id,
      t_video: Math.round((e.frame / data.fps) * 10) / 10,
      period,
      type: e.type,
      team: e.team,
      player_id: e.player_id ?? null,
      x: e.x,
      y: e.y,
      outcome: e.outcome ?? null,
      detail: null,
      note: null,
      ...(e.x_end != null && e.y_end != null ? { x_end: e.x_end, y_end: e.y_end } : {}),
    }));
    mutate((st) => ({ ...st, events: [...st.events, ...evs] }));
    setMsg(`Añadido: ${opt.label}. Se revisa en Eventos.`);
  };
  const rejectAuto = (s: AutoSuggestion) => setEdits({ ...edits, autoRejected: [...new Set([...(edits.autoRejected ?? []), s.id])] });
  // s accepts the suggestion at this moment (its first option), x rejects it. Before the other keys of the ball view.
  const autoKeys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    autoKeys.current = (e: KeyboardEvent) => {
      if (view !== "ball" || !autoActive || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "s") acceptAuto(autoActive, 0);
      else if (e.key === "x") rejectAuto(autoActive);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => autoKeys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const autoPanel = (
    <AutoSuggestions list={autoList} active={autoActive} frame={frame} fps={fps} blocked={autoBlocked} onSeek={seekFrame} onAccept={acceptAuto} onReject={rejectAuto} />
  );

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

  const aspect = dims ? dims.w / (dims.h * (1 - cropTop - cropBottom)) : 16 / 9;

  // The ball has its own view (it is marked on the same video).
  // Ball view: one compact bar (the pitch goes beside the video); the events as ball positions, in a dialog.
  // The same measure as the status of the part and the strip under the video.
  const ballShare = status?.ball ?? 0;
  // Step of the ball review: a small segmented control (in the bar and in the settings).
  const stepSeg = (
    <span className="seg" role="group" aria-label="Paso de la revisión del balón">
      {[0.5, 1, 2].map((v) => (
        <button key={v} type="button" aria-pressed={bEvery === v} className="seg-opt tc !px-2 !py-0.5 text-xs" onClick={() => (setPref("ball:every", String(v)), bGo(0))}>
          {v} s
        </button>
      ))}
    </span>
  );
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
          <EyeSlash size={15} /> <kbd className="kbd">Enter</kbd>
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
          label={ballMarkHere ? "Quitar la marca de este cuadro (Supr)" : autoHere ? "Quitar el balón del tracker en este cuadro (Supr): estaba mal" : "Sin marca en este cuadro"}
          tone="danger"
          disabled={(!ballMarkHere && !autoHere) || pf === null}
          onClick={removeBallHere}
        >
          <Eraser size={15} />
        </IconButton>
        <IconButton label="Mantener el balón quieto desde tu marca anterior hasta aquí (k): saques de meta, de esquina, faltas" onClick={holdHere}>
          <HandPointing size={15} />
        </IconButton>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {ballAuto && (
          <button
            type="button"
            className={`tag ${asksLeft.length ? "tag-warn" : ""}`}
            title={`Tracker de balón: ${ballAuto.frames.length} cuadro(s) seguros (anillo naranja discontinuo)${edits.ballRejected?.length ? `, ${edits.ballRejected.length} quitado(s) a mano` : ""}. ${asksLeft.length ? "n lleva a donde pide marca." : "Ya no pide marcas."}`}
            onClick={nextMissingBall}
          >
            {asksLeft.length ? <>Pide {asksLeft.length} <kbd className="kbd">n</kbd></> : <><Check size={12} weight="bold" /> Tracker</>}
          </button>
        )}
        {ballOdd.length > 0 && (
          <button
            type="button"
            className="tag tag-warn"
            title="Saltos imposibles del balón (más de 35 m/s): casi siempre una marca sobre un balón por alto. Quita esas marcas y traza una recta (i) de donde sale a donde cae."
            onClick={nextBallAnomaly}
          >
            <Warning size={12} /> {ballOdd.length} salto(s) <kbd className="kbd">a</kbd>
          </button>
        )}
        <span
          className="inline-flex cursor-help items-center text-faint"
          title={"Clic en el balón (o en la cancha) marca\n→ paso · Alt → cuadro · Tab dos pasos\nEnter no se ve / fuera · n donde falta\ni recta hasta donde cae · k mantener quieto\na salto imposible · Supr quitar · Alt+Q quitar la marca anterior · h marcas · z zoom\ns acepta la sugerencia · x la descarta"}
          aria-label="Atajos de teclado"
        >
          <Keyboard size={16} />
        </span>
        <span className="ml-auto flex items-center gap-1.5" title="Cada cuánto se detiene la revisión (→ avanza una muestra)">
          <span className="text-faint">Paso</span>
          {stepSeg}
        </span>
        <IconButton label={attack ? "Ajustes del balón…" : "Ajustes del balón: falta indicar hacia dónde atacamos"} tone={attack ? "default" : "accent"} onClick={() => setModal("ballEvents")}>
          <GearSix size={15} />
        </IconButton>
      </div>
    </div>
  );
  // Settings of the ball view: where we attack in this video (events, suggestions and analysis need it), the match whose
  // tagged events give ball positions, and the step of the review.
  const attackOpt = (value: "left" | "right", label: string) => {
    const on = attack === value;
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setPref(`attack:${mid}:${data?.video_id}`, on ? "" : value)}
        className={`group flex flex-1 flex-col items-stretch gap-2 rounded-xl p-2.5 text-left transition-colors ${on ? "bg-own/15 shadow-[inset_0_0_0_1.5px_var(--color-own)]" : "bg-bg/60 shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}
      >
        <svg viewBox="0 0 105 68" className="w-full rounded-md bg-pitch" aria-hidden>
          <rect x="1" y="1" width="103" height="66" fill="none" stroke="currentColor" className="text-white/40" strokeWidth="0.8" />
          <line x1="52.5" y1="1" x2="52.5" y2="67" stroke="currentColor" className="text-white/40" strokeWidth="0.8" />
          <circle cx="52.5" cy="34" r="9" fill="none" stroke="currentColor" className="text-white/40" strokeWidth="0.8" />
          <path
            d={value === "right" ? "M30 34 H72 M64 26 L74 34 L64 42" : "M75 34 H33 M41 26 L31 34 L41 42"}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={on ? "text-own" : "text-white/55"}
          />
        </svg>
        <span className={`text-xs font-medium ${on ? "text-ink" : "text-ink-2"}`}>{label}</span>
      </button>
    );
  };
  const ballEventsPanel = (
    <div className="space-y-5 text-sm">
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="cond m-0 text-[13px] font-bold tracking-wide text-ink uppercase">Hacia dónde atacamos</h3>
          <span className="text-[11px] text-faint">en este video{attack ? "" : " · sin indicar"}</span>
        </div>
        <div className="flex gap-2">
          {attackOpt("left", "Hacia la izquierda")}
          {attackOpt("right", "Hacia la derecha")}
        </div>
        <p className="mt-2 text-[11px] text-pretty text-faint">
          Como se ve en el dibujo de «En la cancha». Lo usan las sugerencias de eventos, el balón desde los eventos y el análisis. Clic otra vez para
          dejarlo sin indicar.
        </p>
      </section>
      <section>
        <h3 className="cond mb-2 text-[13px] font-bold tracking-wide text-ink uppercase">Partido de los eventos</h3>
        <Select
          variant="field"
          label="Partido de la app"
          className="w-full justify-between"
          clearable
          placeholder="Ninguno"
          value={eventsMatchId || null}
          onChange={(v) => setPref(`ballMatch:${mid}`, v ?? "")}
          options={state.matches.map((m) => ({ value: m.match_id, label: m.name }))}
        />
        <p className="mt-2 text-[11px] text-pretty text-faint">
          Ahí entran las sugerencias que aceptes. Sus eventos con posición dan el balón donde no hay una marca tuya a menos de {BALL_FILL_S} s:{" "}
          <span className="text-ink-2">{ballKnown.filter((b) => b.source === "event").length} en esta parte</span>.
        </p>
      </section>
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="cond m-0 text-[13px] font-bold tracking-wide text-ink uppercase">Paso de la revisión</h3>
          <span className="text-[11px] text-faint">→ avanza una muestra</span>
        </div>
        {stepSeg}
      </section>
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
            <g key={b[0]} className={`cursor-pointer ${focusSel && qBoxOfPlayer && !hers ? "mark-dim" : ""}`} opacity={b[11] ? 1 : 0.3} onClick={(e) => (e.stopPropagation(), qf !== null && qLabelPlayer(qf, b[0]))}>
              <rect x={b[1]} y={b[2]} width={b[3] - b[1]} height={b[4] - b[2]} fill="transparent" stroke="none" />
              <PlayerMark
                box={[b[1], b[2], b[3], b[4]]}
                color={c}
                label={hers || name ? (name === NOBODY ? "—" : `${name ? qShow(name) : ""}${hers && !lab ? "?" : ""}`) : undefined}
                style={labelStyle}
                unit={dotR}
                strong={hers}
                dashed={!hers && !lab}
              />
            </g>
          );
        }
        const isSel = qSel === b[0];
        const team = boxTeamOf(b, qRefs);
        const c = isSel ? "#fde047" : lab ? "#ffffff" : name ? TEAM_COLORS[team] : "rgba(255,255,255,.45)";
        const shownName = name === NOBODY ? "—" : name ? qShow(name) : "?";
        return (
          <g key={b[0]} className={`cursor-pointer ${focusSel && qSel !== null && !isSel ? "mark-dim" : ""}`} opacity={b[11] ? 1 : 0.3} onClick={(e) => (e.stopPropagation(), setQPicked(b[0]))}>
            <rect x={b[1]} y={b[2]} width={b[3] - b[1]} height={b[4] - b[2]} fill="transparent" stroke="none" />
            <PlayerMark
              box={[b[1], b[2], b[3], b[4]]}
              color={c}
              label={isSel && qTyped ? `${qTyped}…` : `${shownName}${!lab && name ? "?" : ""}`}
              style={labelStyle}
              unit={dotR}
              strong={isSel}
              dashed={!lab}
            />
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
  // Starts a player again: none of her names, not done, back to the start of the part (Ctrl + Z undoes it).
  const qRemoveAll = (name: string) => {
    setEdits({ ...edits, quick: { labels: qLabels.filter((l) => l.name !== name), seen: qSeen, done: (edits.quick?.done ?? []).filter((n) => n !== name) } });
    setQAfter((data?.start_frame ?? 0) - 1);
    if (data) seekFrame(data.start_frame);
    setMsg(`${name} desde cero: sin nombres ni «hecha». Búscala con ← → y haz clic sobre ella. Ctrl + Z lo deshace.`);
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
  // Where the review of the current player has got to in the part: her next stop, or the end.
  const qProgress = data && qPlayer ? Math.min(1, Math.max(0, ((qCp ? qCp.frame : data.end_frame) - data.start_frame) / span)) : 0;
  // The squad of the team being named: ours from the roster, theirs as they get named here.
  const qSquad = qTeam === "own" ? qRoster.map((r) => ({ id: r.player_id, number: r.number, name: r.player_id })) : rivalList.map((r) => ({ id: `R${r.number}`, number: r.number, name: r.name ?? "" }));
  const qDoneCount = qSquad.filter((r) => qDone.includes(r.id)).length;
  const qShortcuts: [string, string][] = [
    ["número", "elige la jugadora por su dorsal"],
    ["A / S", "plantilla nuestra / rival"],
    ["clic", "esa caja es ella (también para empezar)"],
    ["Enter / X", "es ella / no es ella"],
    ["← →", "1 s atrás o adelante (mantener: rápido)"],
    ["Tab", "siguiente jugadora sin hacer"],
    ["Mayús + Enter", "hecha y siguiente"],
  ];
  const quickPlayerPanel = (
    <section className="rounded-lg bg-surface p-3">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="cond text-sm font-bold tracking-wide text-ink uppercase">Revisión rápida</h2>
        <span className="tc text-xs text-faint">{qLabels.length} nombres dados</span>
      </div>
      {qModeSwitch}
      {qPlayer ? (
        <div key={qPlayer} className="enter mt-3 rounded-lg bg-bg/60 p-3">
          <div className="flex items-center gap-3">
            <span className={`num text-3xl leading-none ${isRival(qPlayer) ? "text-opp" : "text-own"}`}>{qNumber.get(qPlayer) ?? "–"}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{isRival(qPlayer) ? (rivalList.find((r) => `R${r.number}` === qPlayer)?.name ?? qPlayer) : qPlayer}</div>
              <div className="text-[11px] text-faint">{qDone.includes(qPlayer) ? "hecha en esta parte" : `${qPlayerCount(qPlayer)} nombre(s) dados`}</div>
            </div>
            <IconButton
              label={`Reiniciar a ${qPlayer}: quitarle todos sus nombres de la revisión rápida y la marca de hecha (Ctrl + Z lo deshace)`}
              tone="danger"
              disabled={qPlayerCount(qPlayer) === 0 && !qDone.includes(qPlayer)}
              onClick={() => qRemoveAll(qPlayer)}
            >
              <ArrowCounterClockwise size={15} />
            </IconButton>
          </div>
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-line" title="Hasta dónde va su revisión en esta parte">
            <span className="block h-full rounded-full bg-own transition-[width] duration-300" style={{ width: `${qProgress * 100}%` }} />
          </div>
          {qCp ? (
            <>
              <p className="mt-3 text-sm text-pretty text-ink-2">{CP_TEXT[qCp.kind]}</p>
              <div className="tc mt-0.5 text-[11px] text-faint">{fmtT(qCp.frame / fps)}</div>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                <button type="button" className={`${btnPrimary} justify-center`} disabled={!qTarget()} onClick={qConfirmPlayer}>
                  <Check size={14} /> Es ella <kbd className="kbd">Enter</kbd>
                </button>
                <button type="button" className={`${btn} justify-center`} disabled={!qTarget()} onClick={qNotHer}>
                  <X size={14} /> No <kbd className="kbd">X</kbd>
                </button>
                <button type="button" className={`${btn} justify-center`} onClick={() => qNextPlayer(qDone)}>
                  Siguiente <kbd className="kbd">Tab</kbd>
                </button>
                {qDone.includes(qPlayer) ? (
                  <span className="tag tag-accent justify-center">Hecha</span>
                ) : (
                  <button type="button" className={`${btn} justify-center`} onClick={qMarkDone} title="Ya no hay más que revisarle en esta parte (por ejemplo, salió de cuadro y no vuelve): hecha y siguiente (Mayús + Enter)">
                    <Check size={14} /> Hecha
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="mt-3">
              <div className="flex items-center gap-2 text-sm text-ok">
                <FlagCheckered size={16} weight="fill" /> Llegó al final de la parte
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                {qDone.includes(qPlayer) ? (
                  <span className="tag tag-accent justify-center">Hecha</span>
                ) : (
                  <button type="button" className={`${btnPrimary} justify-center`} onClick={qMarkDone}>
                    <Check size={14} /> Hecha <kbd className="kbd">Enter</kbd>
                  </button>
                )}
                <button type="button" className={`${btn} justify-center`} onClick={() => qNextPlayer(qDone)}>
                  Siguiente <kbd className="kbd">Tab</kbd>
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-faint">Elige una jugadora: su dorsal en el teclado o clic en la plantilla.</p>
      )}
      {qPlayer && qMine.length > 0 && (
        <details className="mt-2 rounded-lg bg-bg/40 px-3 py-2 text-xs text-muted">
          <summary className="cursor-pointer text-ink-2">Corregir sus {qMine.length} nombre(s)</summary>
          <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
            {qMine.map((l) => (
              <li key={`${l.frame}:${l.track}`} className="flex items-center gap-2">
                <button type="button" className="tc rounded-md px-1.5 py-0.5 text-ink-2 hover:bg-raised hover:text-ink" title="Ir a ese momento" onClick={() => seekFrame(l.frame)}>
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select className={`${input} min-w-0 flex-1`} value={qMoveTo} aria-label="Pasar todos a otra jugadora" onChange={(e) => setQMoveTo(e.target.value)}>
              <option value="">Pasar todos a…</option>
              {(isRival(qPlayer) ? rivalList.map((r) => ({ id: `R${r.number}`, number: r.number, name: r.name ?? "" })) : qRoster.map((r) => ({ id: r.player_id, number: r.number, name: r.player_id })))
                .filter((r) => r.id !== qPlayer)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number ?? "–"} {r.name}
                  </option>
                ))}
            </select>
            <button type="button" className={btn} disabled={!qMoveTo} onClick={() => qPlayer && qRename(qPlayer, qMoveTo)}>
              <ArrowsMerge size={14} /> Pasar
            </button>
          </div>
        </details>
      )}
      <details className="mt-2 rounded-lg px-3 py-1.5 text-xs text-muted">
        <summary className="cursor-pointer text-faint hover:text-ink-2">Atajos</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          {qShortcuts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="kbd">{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </details>
      <button
        type="button"
        className={`${btnPrimary} mt-3 w-full justify-center`}
        disabled={!qModel || qLabels.length === 0}
        onClick={qApplyAsk}
        title="Lleva los nombres a la mesa. Solo se detiene donde pudo cambiarse de persona: tras un cruce con alguien de su equipo (o uno largo con una rival), cuando reaparece tras perderse y donde el modelo le pasó el nombre a otro trozo. Simulado con dos partes corregidas: 5–8 min por parte, 82–95 % de sus cajas con el nombre correcto, menos del 1 % mal."
      >
        <Check size={15} /> Aplicar a la mesa
      </button>
    </section>
  );
  const qSampleShortcuts: [string, string][] = [
    ["número", "nombra la caja amarilla (dos cifras, o Enter); la siguiente sin nombre se elige sola"],
    ["Enter", "confirma lo que propone el modelo (nombres con «?») y pasa a la siguiente muestra"],
    ["−", "esa caja no es nadie que interese (duplicada, fuera de la cancha)"],
    ["Supr", "quita el nombre de la caja elegida · clic en una caja para elegirla"],
    ["Tab", "la siguiente caja sin nombre"],
    ["A / S", "plantilla nuestra / rival"],
    ["← →", "muestra anterior / siguiente sin confirmar"],
  ];
  const quickSamplesPanel = (
    <section className="rounded-lg bg-surface p-3">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="cond text-sm font-bold tracking-wide text-ink uppercase">Revisión rápida</h2>
        <span className="tc text-xs text-faint">{qFrame !== null ? `muestra ${qIdx + 1}/${qSamples.length} · ${fmtT(qFrame / fps)}` : ""}</span>
      </div>
      {qModeSwitch}
      <div className="rounded-lg bg-bg/60 p-3">
        <div className="h-1 overflow-hidden rounded-full bg-line" title="Muestras revisadas">
          <span className="block h-full rounded-full bg-own transition-[width] duration-300" style={{ width: `${(100 * qSeen.length) / Math.max(1, qSamples.length)}%` }} />
        </div>
        <p className="mt-3 text-sm text-pretty text-ink-2">
          {qSel !== null ? "Nombra la caja amarilla: su dorsal o clic en la plantilla." : "Todas las cajas de este cuadro tienen nombre: confirma y sigue."}
        </p>
        <div className="mt-3 grid grid-cols-[auto_1fr] gap-1.5">
          <button type="button" className={`${btn} justify-center`} disabled={qIdx === 0} onClick={() => qGo(qIdx - 1)} aria-label="Muestra anterior">
            ←
          </button>
          <button type="button" className={`${btnPrimary} justify-center`} onClick={qConfirm} title="Lo que propone el modelo en este cuadro está bien: siguiente muestra">
            <Check size={14} /> Confirmar <kbd className="kbd">Enter</kbd>
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          <span>{qModel ? new Set(qModel.segments.filter((x) => x.name).map((x) => x.name)).size : 0} jugadoras con nombre</span>
          {qModel && qModel.conflicts.length > 0 && <span className="text-warn">{qModel.conflicts.length} choques</span>}
          <label className="ml-auto flex items-center gap-1.5">
            Cada
            <select className={`${input} !py-0.5`} value={qEvery} onChange={(e) => (setPref("quick:every", e.target.value), qGo(0))}>
              {[2, 3, 5].map((v) => (
                <option key={v} value={v}>
                  {v} s
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <details className="mt-2 rounded-lg px-3 py-1.5 text-xs text-muted">
        <summary className="cursor-pointer text-faint hover:text-ink-2">Atajos</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          {qSampleShortcuts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="kbd">{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </details>
      <button
        type="button"
        className={`${btnPrimary} mt-3 w-full justify-center`}
        disabled={!qModel || qLabels.length === 0}
        onClick={qApplyAsk}
        title="Cada nombre se extiende por su track; si un track recibe dos nombres, se corta en el cruce más probable entre las dos muestras. Los trozos con el mismo nombre se unen y los huecos de hasta 3 s se rellenan al guardar. Medido con dos partes corregidas, nombrando cada 3 s: 80–95 % de sus cajas con el nombre correcto, menos del 1 % mal."
      >
        <Check size={15} /> Aplicar a la mesa
      </button>
    </section>
  );
  // The squad as shirt numbers, ours or theirs (A / S). By player: a click picks who is followed (the current one
  // filled, done ones tinted with a tick, started ones with a dot). By samples: a click names the yellow box. Rivals are
  // added here with their dorsal and, if known, their name.
  const squadPanel = (
    <section className="rounded-lg bg-surface p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <div className="seg" role="group" aria-label="Plantilla">
          {(["own", "opp"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={qTeam === t} className="seg-opt inline-flex items-center gap-1.5" onClick={() => setQTeam(t)}>
              <span className={`h-2 w-2 rounded-full ${t === "own" ? "bg-own" : "bg-opp"}`} />
              {t === "own" ? "Nuestras" : "Rivales"} <kbd className="kbd">{t === "own" ? "A" : "S"}</kbd>
            </button>
          ))}
        </div>
        <span className="tc ml-auto text-xs text-faint">{qMode === "player" ? `${qDoneCount}/${qSquad.length} hechas` : qSel !== null ? "clic: nombra la caja amarilla" : ""}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(3.6rem,1fr))] gap-1.5">
        {qSquad.map((r) => {
          const done = qDone.includes(r.id);
          const cur = qMode === "player" && qPlayer === r.id;
          const n = qPlayerCount(r.id);
          const opp = qTeam === "opp";
          return (
            <button
              key={r.id}
              type="button"
              title={`${r.number ?? ""} ${r.name}${done ? " · hecha" : n > 0 ? ` · ${n} nombre(s) dados` : ""}${opp ? " · para cambiar su nombre, vuelve a escribir su dorsal con el nuevo" : ""}`}
              aria-pressed={cur}
              disabled={qMode === "samples" && qSel === null}
              onClick={() => (qMode === "player" ? qPickPlayer(r.id, qTeam) : qGive(r.id))}
              className={`relative flex flex-col items-center rounded-md px-1 pt-1.5 pb-1 transition-[background-color,transform] duration-150 active:scale-95 disabled:opacity-40 ${
                cur ? (opp ? "bg-opp text-black" : "bg-own text-[var(--on-own)]") : done ? (opp ? "bg-opp/15 text-ink" : "bg-own/15 text-ink") : "bg-bg/60 text-ink-2 hover:bg-raised hover:text-ink"
              }`}
            >
              <span className="num text-xl leading-none">{r.number ?? "–"}</span>
              <span className="mt-1 w-full truncate text-center text-[10px] leading-tight opacity-80">{r.name || "—"}</span>
              {done ? (
                <Check size={10} weight="bold" className={`absolute top-1 right-1 ${cur ? "" : "text-ok"}`} />
              ) : (
                n > 0 && <span className={`absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full ${cur ? "bg-current" : opp ? "bg-opp" : "bg-own"}`} />
              )}
            </button>
          );
        })}
        {qTeam === "opp" && (
          <form
            className="col-span-2 flex items-center"
            onSubmit={(e) => {
              e.preventDefault();
              if (addRival(qRivalDraft)) setQRivalDraft("");
            }}
          >
            <input
              className={`${input} h-full w-full text-xs`}
              placeholder="+ 7 Pérez"
              aria-label="Añadir una rival: dorsal y nombre"
              title="Dorsal y, si lo sabes, su nombre (Enter). Su identidad es R y el dorsal; el nombre solo se muestra."
              value={qRivalDraft}
              onChange={(e) => setQRivalDraft(e.target.value)}
            />
          </form>
        )}
      </div>
      {qTeam === "own" && qRoster.length === 0 && <p className="mt-2 text-xs text-faint">Sin plantilla: añádela en Configuración › Plantilla.</p>}
    </section>
  );
  const quickPanel = qMode === "player" ? quickPlayerPanel : quickSamplesPanel;

  const fileLabel = `${btn} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`;

  // What the camera sees in this frame, as a shadow on the drawing of the pitch.
  const viewHere = data && row?.H ? viewPolygon(data, row.H) : null;
  // In the side column the pitch is as large as the window leaves after the other modules there (no page scroll).
  const sideAvail = fitH ? fitH - 16 - (bottomBox.h + 24) : 0;
  const pitchMaxW = fitH && sideBox.h > 0 && pitchBox.h > 0 && !belowSet.has("pitch") ? Math.max(200, Math.floor((sideAvail - (sideBox.h - pitchBox.h)) * (109 / 72))) : null;
  const pitchCard = (
            <Card
              title={<span title="Anillo amarillo: marcada a mano · borde naranja: balón (hueco si es una posición rellenada) · de la seleccionada, 4 s antes y después: gris lo medido, blanco lo que se guardará">En la cancha</span>}
              note="este cuadro"
            >
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
              <div ref={pitchBoxRef} className="mx-auto" style={pitchMaxW ? { maxWidth: pitchMaxW } : undefined}>
              <Pitch showDirection={false} svgRef={pitchSvg} onClick={onPitchClick} className={view === "ball" && pf !== null && row?.H ? "cursor-crosshair" : ""}>
                <ViewShade poly={viewHere} />
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
                        <circle cx={q.x} cy={q.y} r={groupColor(id) ? 2.1 : 1.5} fill={q.source === "interpolated" ? "var(--color-surface)" : TEAM_COLORS[p?.team ?? "unk"]}
                          stroke={groupColor(id) ?? TEAM_COLORS[p?.team ?? "unk"]} strokeWidth={groupColor(id) ? 0.6 : 0.4} />
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
                        <circle cx={b[9] as number} cy={b[10] as number} r={groupColor(id) ? 2.1 : 1.5} fill={TEAM_COLORS[p?.team ?? "unk"]} stroke={groupColor(id) ?? "var(--color-bg)"} strokeWidth={groupColor(id) ? 0.6 : 0.3} />
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
              </div>
              {!row?.H && pitchShow !== "named" && <p className="mt-1 text-[11px] text-warn">Este cuadro no tiene calibración: no hay posiciones.</p>}
            </Card>
  );
  // The panel of the selected player (or the ones to check), with the pinned one under it.
  const personModule = (
    <div className="space-y-3">
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
              {selected ? (
                  <div className="space-y-1.5 rounded-lg bg-surface p-3">
                    <ul>{renderRow(selected)}</ul>
                    {/* Her tools on the left; what is left to check on her, as icon and number, on the right (details on hover). */}
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="flex items-center">
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
                        <IconButton
                          label={pinned === selected.id ? "Soltarla (k)" : "Fijarla (k): luego, con otra seleccionada, J la une a ella; también puedes arrastrarle tramos de la línea"}
                          tone={pinned === selected.id ? "accent" : "default"}
                          onClick={togglePin}
                        >
                          <PushPin size={16} weight={pinned === selected.id ? "fill" : "regular"} />
                        </IconButton>
                        <IconButton label="Soltar la selección (Esc)" onClick={() => setSel(null)}>
                          <X size={16} />
                        </IconButton>
                      </span>
                      <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                        {candList.length > 0 && (
                          <Badge
                            icon={<UsersThree size={13} weight="bold" />}
                            n={candList.length}
                            tone={peek ? "warn" : "plain"}
                            title={`${candList.length} candidata(s) a ser la misma persona («sigue como» / «viene de»): ver la siguiente en el video (n); se une o se descarta en la barra bajo el video`}
                            onClick={() => (peek ? nextCand() : peekAt(candList[0].x))}
                          />
                        )}
                        {selHints.length > 0 && (
                          <Badge
                            icon={<TShirt size={13} weight="fill" />}
                            n={selHints.length}
                            tone="warn"
                            title={`${selHints.length} cambio(s) de camiseta: ir al siguiente (c)`}
                            onClick={() => nextOf(selHints.map((h) => Math.max(data?.start_frame ?? 0, h.frame - Math.round(fps))))}
                          />
                        )}
                        {hintHere && (
                          <Badge icon={<Scissors size={13} />} tone="accent" title={`Cortar aquí (${hintText(hintHere)}): de este punto en adelante es otra persona`} onClick={() => fixHint(hintHere)} />
                        )}
                        {absorbForSel.length > 0 && (
                          <Badge
                            icon={<MagicWand size={13} />}
                            n={absorbForSel.length}
                            tone="accent"
                            title={`${absorbForSel.length} trozo(s) corto(s) suyos${absorbForSel.some((x) => x.adds > 0) ? ` (+${absorbForSel.reduce((t, x) => t + x.adds, 0)} cuadros)` : ""}: añadírselos`}
                            onClick={() => absorb(absorbForSel)}
                          />
                        )}
                        {selTwice.length > 0 && (
                          <Badge
                            icon={<Warning size={13} />}
                            n={selTwice.length}
                            tone="warn"
                            title={`Dos cajas a la vez en ${selTwice.length} cuadro(s) por revisar: ir al siguiente (d) y hacer clic en la que es ella; e salta, 0 ninguna es ella (m deja una donde están en el mismo sitio)`}
                            onClick={() => nextOf(selTwice)}
                          />
                        )}
                        {selAnoms.length > 0 && (
                          <Badge
                            icon={<Warning size={13} weight="fill" />}
                            n={selAnoms.length}
                            tone="danger"
                            title={`${selAnoms.length} salto(s) imposible(s), recuadros rojos en su línea: revisarlos uno a uno (a)`}
                            onClick={() => anomStep(1)}
                          />
                        )}
                        {selAnoms.length > 0 && <Badge icon={<Eraser size={13} />} tone="danger" title="Quitar los cuadros de todos sus saltos imposibles (se rellenan al guardar)" onClick={anomDropAll} />}
                        {selGaps.length > 0 ? (
                          <Badge
                            icon={<CircleDashed size={13} weight="bold" />}
                            n={selGaps.length}
                            tone="danger"
                            title={`${selGaps.length} hueco(s) por revisar en medio de la imagen (el más largo, ${(Math.max(...selGaps.map(([x, y]) => y - x)) / fps).toFixed(1)} s): ir al siguiente (g). Si en el hueco hay otra caja que es ella, únela; si no la vio el detector, márcala a mano (p)`}
                            onClick={nextGap}
                          />
                        ) : (
                          <Badge icon={<Check size={13} weight="bold" />} tone="ok" title="Sin huecos por revisar: los de fuera de cuadro se rellenan al guardar" />
                        )}
                        {selOffCamera.length > 0 && (
                          <Badge icon={<EyeSlash size={13} />} n={selOffCamera.length} tone="plain" title={`${selOffCamera.length} hueco(s) donde salió de cuadro: gris en la línea; se rellenan al guardar`} />
                        )}
                      </span>
                    </div>
                  </div>
              ) : (
                <div className="rounded-lg bg-surface p-3">
                  <p className="text-sm text-ink-2">Clic sobre una jugadora en el video.</p>
                  {namedToCheck.length > 0 && (
                    <>
                      <div className="mt-3 mb-1 text-xs text-faint">Con nombre, por verificar · {namedToCheck.length}</div>
                      <ul className="space-y-0.5">{namedToCheck.slice(checkPageNow * CHECK_PER_PAGE, (checkPageNow + 1) * CHECK_PER_PAGE).map((p) => renderRow(p))}</ul>
                      <Pager page={checkPageNow} pages={checkPages} setPage={setCheckPage} />
                    </>
                  )}
                  {shortIds.length > 0 && (
                    <button type="button" className="btn btn-ghost mt-2 !px-0 text-xs" onClick={() => setModal("cleanup")}>
                      <BroomIcon size={14} />
                      Limpieza rápida · {shortIds.length} trozos de menos de 1 s
                    </button>
                  )}
                </div>
              )}
              {pinnedP && (
        <div
          {...dropOn(pinnedP.id)}
          className={`enter flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${dropOver === pinnedP.id ? "bg-accent/25" : "bg-surface"}`}
        >
          <PushPin size={15} weight="fill" className="shrink-0 text-accent" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-ink hover:underline"
            title="Seleccionarla"
            onClick={() => {
              setSel(pinnedP.id);
              setMode(null);
            }}
          >
            <span className="text-xs text-faint">Fijada · </span>
            {label(pinnedP, pinnedP.id)}
          </button>
          {selected && selected.id !== pinnedP.id && (
            <button type="button" className="btn !px-2 !py-1 text-xs" title={`${label(selected, selected.id)} pasa a ser ${label(pinnedP, pinnedP.id)} (j)`} onClick={joinToPinned}>
              <ArrowsMerge size={13} /> Unir <kbd className="kbd">J</kbd>
            </button>
          )}
          <IconButton label="Soltar la fijada (k sobre ella)" onClick={() => setPinned(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
  // Which modules this view has, where each one goes, and the grip that moves it.
  const viewModules: ModuleId[] = view === "ball" ? ["pitch", "ball", "auto"] : view === "quick" ? ["quick", "squad"] : view === "anchors" ? ["anchors"] : ["pitch", "person"];
  const anchorsPanel =
    view === "anchors" && data ? (
      folder ? (
        <AnchorsPanel
          key={`${folder}|${partOfData(data)}`}
          videoUrl={fileUrl}
          folder={folder}
          matchId={folder}
          part={partOfData(data)}
          data={data}
          roster={state.roster ?? []}
          edits={edits}
          named={new Map(ppl.filter((p) => p.player_id).map((p) => [p.player_id, p.id]))}
          setEdits={setEdits}
          undoEdits={undo}
          onSeek={seekFrame}
          onFocus={setAnchorFocus}
          focusMissing={anchorMissing}
          onPending={setAnchorPending}
          pickRef={anchorPick}
          people={ppl}
          playerOfId={(id) => personById.get(id)?.player_id || undefined}
          onMsg={setMsg}
        />
      ) : (
        <p className="card !p-3 text-xs text-ink-2">El modo anclas lee y escribe la carpeta del partido: ábrelo desde la pestaña del partido.</p>
      )
    ) : null;
  const moduleNode: Record<ModuleId, React.ReactNode> = { ball: ballBar, pitch: pitchCard, quick: quickPanel, squad: squadPanel, person: personModule, auto: autoPanel, anchors: anchorsPanel };
  const sideMods = viewModules.filter((m) => !belowSet.has(m));
  const belowMods = viewModules.filter((m) => belowSet.has(m));
  // With the table fitting the window, the window is a limit, not a size: the video as large as fits above its controls
  // (and the modules under it), each panel as tall as its content, and nothing stretched to fill.
  const hasBelow = belowMods.length > 0 || dragMod !== null;
  const avail = fitH ? fitH - 16 - (bottomBox.h + 24) : 0;
  const belowNeed = hasBelow ? Math.max(belowBox.h, dragMod ? 128 : 0) + 12 : 0;
  const stageW = fitH && colBox.w ? Math.max(240, Math.min(colBox.w, (avail - underH - 12 - belowNeed) * aspect)) : null;
  const zoneDrop = (where: "side" | "below") => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(MODULE_DRAG)) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      const m = e.dataTransfer.getData(MODULE_DRAG) as ModuleId;
      setDragMod(null);
      if (!MODULE_NAMES[m]) return;
      e.preventDefault();
      moveModule(m, where);
    },
  });
  const moduleBox = (m: ModuleId, where: "side" | "below") => (
    <div key={m} className="group/mod relative min-w-0">
      {moduleNode[m]}
      <button
        type="button"
        draggable
        className="absolute -top-2 -right-1 z-10 grid h-6 w-6 cursor-grab place-items-center rounded-full bg-raised text-faint opacity-0 shadow ring-1 ring-line transition-opacity group-hover/mod:opacity-100 hover:text-ink focus-visible:opacity-100 active:cursor-grabbing"
        aria-label={`Mover «${MODULE_NAMES[m]}» ${where === "side" ? "bajo el video" : "al panel lateral"}`}
        title={`Arrastra «${MODULE_NAMES[m]}» ${where === "side" ? "bajo el video" : "al panel lateral"} (o clic para moverlo)`}
        onClick={() => moveModule(m, where === "side" ? "below" : "side")}
        onDragStart={(e) => {
          e.dataTransfer.setData(MODULE_DRAG, m);
          e.dataTransfer.effectAllowed = "move";
          setDragMod(m);
        }}
        onDragEnd={() => setDragMod(null)}
      >
        <DotsSixVertical size={13} weight="bold" />
      </button>
    </div>
  );

  // What the full screen shows on top: in the quick review, who is being named; in the ball view, how much has a ball;
  // in the players view, the warnings of the selected player at this moment, or her tick.
  const fullHud = (() => {
    const pill = (text: string, tone: "plain" | "ok" | "warn" | "danger" = "plain", key?: string) => (
      <span
        key={key ?? text}
        className={`enter rounded-full px-3 py-1 text-sm font-medium shadow-lg backdrop-blur ${
          tone === "ok" ? "bg-ok/25 text-ok" : tone === "warn" ? "bg-warn-900/80 text-warn" : tone === "danger" ? "bg-danger/30 text-danger" : "bg-black/60 text-white"
        }`}
      >
        {text}
      </span>
    );
    const items: React.ReactNode[] = [];
    if (view === "quick") {
      if (qMode === "player" && qPlayer) {
        items.push(pill(qShow(qPlayer), "plain", "who"));
        if (qCp) items.push(pill(CP_TEXT[qCp.kind].split(":")[0].split(".")[0], qCp.kind === "lost" ? "warn" : "plain", "cp"));
      } else if (qMode === "samples") items.push(pill(`Muestra ${Math.min(qIdx + 1, qSamples.length)} de ${qSamples.length}`, "plain", "who"));
      else items.push(pill("Elige una jugadora", "warn", "who"));
    } else if (view === "ball") {
      items.push(pill(`Balón ${Math.round(100 * ballShare)} % del juego`, ballShare >= 0.95 ? "ok" : "plain", "ball"));
    } else if (selected) {
      items.push(pill(label(selected, selected.id), "plain", "who"));
      if (selected.done) items.push(pill("✓ Verificada", "ok", "done"));
      else {
        if (selTwiceHere) items.push(pill("Dos cajas aquí", "warn", "twice"));
        if (selGaps.some(([a, b]) => frame > a && frame < b)) items.push(pill("Hueco por revisar", "danger", "gap"));
        if ((hintsByPerson.get(selected.id) ?? []).some((h) => Math.abs(h.frame - frame) <= 1.5 * fps)) items.push(pill("Cambio de camiseta", "warn", "shirt"));
      }
    }
    return (
      <div className="pointer-events-none absolute inset-x-0 top-3 flex flex-col items-center gap-2">
        <div className="flex flex-wrap justify-center gap-2">{items}</div>
        {msg && <div className="enter max-w-[70%] rounded-2xl bg-accent-900/85 px-4 py-2 text-center text-sm text-accent-100 shadow-lg">{msg}</div>}
      </div>
    );
  })();
  return (
    <>
      <Head embedded={embedded}>
        {(!embedded || !fileUrl) && (
          <label className={fileLabel}>
            <FolderOpen size={15} />
            {fileUrl ? "Cambiar video" : "Abrir video"}
            <input type="file" accept="video/*" className="sr-only" onChange={onVideo} />
          </label>
        )}
        {!(embedded && partNames !== null && partNames.length === 0 && !data) && (
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
          onFile={(f) => {
            setOpening(partLabel(f.name, data?.fps ?? 29.97));
            void onTracks(asEvent([f]));
          }}
        />
        )}
        {data && (
          <>
            {!step && (
              <div className="seg" role="group" aria-label="Qué se corrige">
                {(
                  [
                    ["players", "Jugadoras", UsersThree],
                    ["ball", "Balón", SoccerBall],
                  ] as const
                ).map(([v, name, Icon]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v || (v === "players" && view !== "ball")}
                    className="seg-opt inline-flex items-center gap-1.5"
                    onClick={() => {
                      setView(v);
                      setMode(v === "ball" ? "ball" : null);
                    }}
                  >
                    <Icon size={14} />
                    {name}
                  </button>
                ))}
              </div>
            )}
            {view !== "ball" && (
              <div className="seg" role="group" aria-label="Forma de trabajo con las jugadoras">
                {PLAYER_VIEWS.map(({ v, name, key, title, Icon }) => (
                  <button
                    key={v}
                    type="button"
                    className="seg-opt inline-flex items-center gap-1.5"
                    aria-pressed={view === v}
                    title={`${title} (Alt + ${key})`}
                    onClick={() => switchView(v)}
                  >
                    <Icon size={14} weight={view === v ? "fill" : "regular"} />
                    {name}
                    {v === "anchors" && anchorPending !== null && (
                      <span className={`tc rounded-full px-1.5 text-[10px] ${anchorPending ? "bg-warn-900/70 text-warn" : "text-ok"}`} title="Dudas pendientes del relleno">
                        {anchorPending}
                      </span>
                    )}
                    <kbd className="tc hidden text-[10px] opacity-60 xl:inline">Alt+{key}</kbd>
                  </button>
                ))}
              </div>
            )}
            {status && (
              <span className={`tag ${status.complete ? "tag-accent" : ""}`} title={`Completa con al menos ${PLAYERS_DONE} jugadoras verificadas y balón en el 95 % del tiempo en juego.`}>
                {status.complete ? "✓ Parte completa" : `Verificadas ${status.players} · balón ${Math.round(status.ball * 100)} %`}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <IconButton
                label={focus ? "Salir del modo enfoque" : "Modo enfoque: oculta el menú y la barra del partido (vuelven al llevar el cursor arriba o a la izquierda)"}
                tone={focus ? "accent" : "default"}
                onClick={() => setPref("focus", focus ? "off" : "on")}
              >
                {focus ? <CornersIn size={17} /> : <CornersOut size={17} />}
              </IconButton>
              <button
                type="button"
                className={`${btnPrimary} min-w-[8.5rem] justify-center transition-[background-color,border-color,color] duration-200 ${
                  save.state === "saved" || save.state === "downloaded" ? "!border-ok !bg-ok" : save.state === "error" ? "!border-danger !bg-danger" : ""
                }`}
                aria-live="polite"
                title={save.note || "Guarda lo corregido (tracks_fixed) y las etiquetas en la carpeta del partido; si no se puede, se descargan"}
                disabled={save.state === "saving"}
                onClick={saveNow}
              >
                {save.state === "saving" ? (
                  <CircleNotch size={15} className="animate-spin" />
                ) : save.state === "saved" || save.state === "downloaded" ? (
                  <Check key="ok" size={15} weight="bold" className="save-pop" />
                ) : (
                  <FloppyDisk size={15} />
                )}
                <span key={save.state} className="enter">
                  {save.state === "saving" ? "Guardando…" : save.state === "saved" ? "Guardado" : save.state === "downloaded" ? "Descargado" : save.state === "error" ? "Reintentar" : "Guardar"}
                </span>
              </button>
              <Dropdown
                label="Más acciones"
                panelClass="w-64 p-1.5"
                trigger={
                  <>
                    <DotsThree size={18} weight="bold" />
                    {anomalies.some((a) => a.kind !== "camera") && <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />}
                  </>
                }
              >
                {(close) => (
                  <>
                    <MenuItem icon={<Warning size={15} />} onClick={() => (close(), setModal("anomalies"))}>
                      Movimientos imposibles <span className="tc text-faint">{anomalies.length}</span>
                    </MenuItem>
                    <MenuItem icon={<Stack size={15} />} onClick={() => (close(), setModal("export"))}>
                      Exportar…
                    </MenuItem>
                    <MenuItem icon={<ArrowCounterClockwise size={15} />} onClick={() => (close(), setModal("reset"))}>
                      Restablecer…
                    </MenuItem>
                    <div className="mx-2 my-1 h-px bg-line" />
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-line-strong hover:text-ink">
                      <span className="grid w-4 shrink-0 place-items-center text-muted">
                        <FolderOpen size={15} />
                      </span>
                      Otro archivo de video
                      <input
                        type="file"
                        accept="video/*"
                        className="sr-only"
                        onChange={(e) => {
                          close();
                          onVideo(e);
                        }}
                      />
                    </label>
                  </>
                )}
              </Dropdown>
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
      {modal === "anomalies" && data && (
        <Modal title="Movimientos imposibles" onClose={() => setModal(null)} wide>
          <div className="space-y-3 text-sm">
            <p className="text-[11px] text-pretty text-muted">
              Jugadoras: más de 9 m/s y más de 3 m entre dos posiciones seguidas; casi siempre su nombre pasó a otra persona (un barrido de cámara en
              la revisión rápida, alguien que entra al cuadro). Primero las que tienen nombre. Cámara: muchas saltan a la vez, así que falla la
              calibración de ese cuadro, no las identidades. Balón: más de 35 m/s; una marca sobre un balón por alto o una detección equivocada.
              Clic para ir.
            </p>
            {anomalies.length === 0 ? (
              <p className="text-ok">Nada imposible en esta parte.</p>
            ) : (
              <ul className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
                {anomalies.map((a, i) => (
                  <li key={`${a.kind}_${a.frame}_${a.person ?? i}`}>
                    <button
                      type="button"
                      className="flex w-full items-baseline gap-3 rounded-lg px-2 py-1 text-left text-xs hover:bg-raised"
                      onClick={() => {
                        goAnomaly(a);
                        setModal(null);
                      }}
                    >
                      <span className="tc w-14 shrink-0 text-faint">{fmtT(a.frame / fps)}</span>
                      <span className={`w-20 shrink-0 ${a.kind === "camera" ? "text-muted" : "text-warn"}`}>
                        {a.kind === "player" ? "Jugadora" : a.kind === "camera" ? "Cámara" : "Balón"}
                      </span>
                      <span className="text-ink-2">
                        {a.kind === "player"
                          ? `${a.name ?? `#${a.person}`} salta ${Math.round(a.meters)} m (${Math.round(a.speed)} m/s)`
                          : a.kind === "camera"
                            ? `${a.people} personas saltan ${Math.round(a.meters)} m a la vez: revisa la calibración de este cuadro`
                            : `salta ${Math.round(a.meters)} m (${Math.round(a.speed)} m/s)${a.until !== undefined ? ` y vuelve en ${fmtT(a.until / fps)}` : ""}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Modal>
      )}
      {modal === "ballEvents" && data && (
        <Modal title="Ajustes del balón" onClose={() => setModal(null)}>
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

      {msg && !isFull && (
        <div
          role="status"
          className="enter fixed bottom-5 left-1/2 z-40 flex max-w-xl -translate-x-1/2 items-start gap-3 rounded-xl bg-raised px-4 py-3 text-sm text-ink-2 shadow-[0_0_0_1px_var(--color-line-strong),0_20px_40px_-12px_rgba(0,0,0,.7)]"
        >
          <span className="min-w-0 flex-1 text-pretty">{msg}</span>
          <button type="button" className="text-faint transition-colors hover:text-ink" aria-label="Cerrar el aviso" onClick={() => setMsg("")}>
            <X size={14} />
          </button>
        </div>
      )}

      {embedded && folder && !data && listing ? (
        <LoadingStage label="Buscando las partes procesadas" />
      ) : embedded && folder && !data && partNames !== null && partNames.length === 0 ? (
        <ProcessPanel folder={folder} video={video} onOpen={openRel} onRefresh={relist} />
      ) : embedded && folder && !data && partNames && partNames.length > 0 ? (
        <LoadingStage label={`Abriendo la parte ${partLabel(opening ?? partNames[0], 29.97)}`} />
      ) : fileUrl && !data ? (
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
          <div ref={rootEl} className="enter flex flex-col xl:-mb-12">
          <div
            className={`grid min-h-0 gap-4 ${sideMods.length > 0 || dragMod ? "xl:grid-cols-[minmax(0,1fr)_var(--side-w)]" : ""}`}
            style={{ "--side-w": `${sideW}px` } as React.CSSProperties}
          >
            <div ref={colRef} className="flex min-h-0 min-w-0 flex-col gap-3">
                <div
                  ref={stageRef}
                  className={isFull ? "relative flex h-full w-full items-center justify-center overflow-hidden bg-black" : "relative mx-auto w-full shrink-0 overflow-hidden rounded-2xl bg-black"}
                  style={isFull || !stageW ? undefined : { width: stageW }}
                >
                  {/* What is shown: the image less its crop. The zoom moves the image inside it. */}
                  <div
                    className={`relative overflow-hidden ${dims ? "" : "aspect-video"}`}
                    style={{
                      ...(dims && (cropTop || cropBottom) ? { aspectRatio: `${dims.w} / ${dims.h * (1 - cropTop - cropBottom)}` } : {}),
                      ...(isFull && dims ? { width: `min(100vw, calc(100vh * ${aspect}))` } : {}),
                    }}
                  >
                  <div style={dims && cropTop ? { marginTop: `${-cropTop * (dims.h / dims.w) * 100}%` } : undefined}>
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
                      onDragOver={(e) => {
                        if (view !== "players" || !e.dataTransfer.types.includes(RANGE_DRAG)) return;
                        const pt = toPixels(e);
                        const t = pt ? boxAt(pt) : null;
                        setDropOver(t);
                        if (t !== null) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      }}
                      onDragLeave={() => setDropOver(null)}
                      onDrop={(e) => {
                        setDropOver(null);
                        const r = readRange(e);
                        const pt = toPixels(e);
                        const t = pt ? boxAt(pt, r?.person) : null;
                        if (!r || t === null) return;
                        e.preventDefault();
                        joinRange(r.person, r.from, r.to, t);
                      }}
                    >
                      {view === "quick" && quickOverlay}
                      {anchorHits?.found.map(({ b, mark, index }) => {
                        const c = FOCUS_COLORS[index % FOCUS_COLORS.length];
                        return (
                          <g key={`af${b[0]}`} pointerEvents="none">
                            <rect x={b[1] - 2 * dotR} y={b[2] - 2 * dotR} width={b[3] - b[1] + 4 * dotR} height={b[4] - b[2] + 4 * dotR} rx={dotR} fill="none" stroke={c} strokeWidth={dotR * 0.9} />
                            <circle cx={b[1] - 2 * dotR} cy={b[2] - 2 * dotR} r={dotR * 2.4} fill={c} />
                            <text x={b[1] - 2 * dotR} y={b[2] - 2 * dotR} dy={dotR * 0.9} textAnchor="middle" fontSize={dotR * 2.6} fontWeight={700} fill="var(--color-bg)">
                              {mark.label}
                            </text>
                          </g>
                        );
                      })}
                      {view !== "quick" && (view !== "ball" || ballBoxes) && shown.map(({ b, id }) => {
                        const p = personById.get(id);
                        const isSel = id === sel;
                        const twice = twiceHere.has(id);
                        const gc = groupColor(id);
                        const c = twice ? "#fb7185" : (gc ?? TEAM_COLORS[p?.team ?? "unk"]);
                        return (
                          <g
                            key={b[0]}
                            className={`cursor-pointer ${(anchorHits ? !anchorTracks.has(b[0]) : focusSel && sel !== null && !gc && id !== pinned) ? "mark-dim" : ""}`}
                            opacity={b[11] ? 1 : 0.35}
                            onPointerDown={(e) => startBoxDrag(e, id, b)}
                            onClick={(e) => {
                              if (mode === "manual" || mode === "ball" || pickKit) return;
                              e.stopPropagation();
                              if ((e.ctrlKey || e.metaKey || e.shiftKey) && view === "players") return toggleMulti(id);
                              if (anchorHits && anchorTracks.has(b[0]) && pf !== null && anchorPick.current?.({ track: b[0], id }, anchorHits.found.map((f) => ({ track: f.b[0], id: f.id })), pf)) return;
                              pickBox(id, b[0]);
                            }}
                          >
                            <rect x={b[1]} y={b[2]} width={b[3] - b[1]} height={b[4] - b[2]} fill="transparent" stroke="none" />
                            <PlayerMark
                              box={[b[1], b[2], b[3], b[4]]}
                              color={c}
                              label={label(p, id)}
                              style={labelStyle}
                              unit={dotR}
                              strong={isSel || !!gc || twice}
                              dashed={twice}
                            />
                          </g>
                        );
                      })}
                      {/* The pinned player, and the box a drag would join to. */}
                      {view === "players" &&
                        shown
                          .filter((x) => x.id === pinned || x.id === dragLine?.target || x.id === dropOver)
                          .map(({ b, id }) => (
                            <rect
                              key={`hl${b[0]}`}
                              pointerEvents="none"
                              x={b[1] - dotR}
                              y={b[2] - dotR}
                              width={b[3] - b[1] + 2 * dotR}
                              height={b[4] - b[2] + 2 * dotR}
                              rx={dotR}
                              fill={id === dragLine?.target || id === dropOver ? "rgba(58,102,255,.18)" : "none"}
                              stroke="var(--color-accent)"
                              strokeWidth={dotR / (id === pinned && id !== dragLine?.target && id !== dropOver ? 3 : 2)}
                              strokeDasharray={id === pinned && id !== dragLine?.target && id !== dropOver ? `${dotR} ${dotR * 0.7}` : undefined}
                            />
                          ))}
                      {dragLine && (
                        <g pointerEvents="none">
                          <line x1={dragLine.from[0]} y1={dragLine.from[1]} x2={dragLine.to[0]} y2={dragLine.to[1]} stroke="var(--color-accent)" strokeWidth={dotR / 2.5} strokeDasharray={`${dotR} ${dotR * 0.6}`} />
                          <circle cx={dragLine.to[0]} cy={dragLine.to[1]} r={dotR * 0.9} fill="var(--color-accent)" />
                        </g>
                      )}
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
                      {autoHere && (
                        <circle cx={autoHere.px} cy={autoHere.py} r={dotR * 1.5} fill="none" stroke="#fb923c" strokeWidth={dotR / 4} strokeDasharray={`${dotR * 0.8} ${dotR * 0.5}`} pointerEvents="none" />
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
                  </div>
                  {zoomTransform && (
                    <span className="tc pointer-events-none absolute top-2 right-2 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">×{zoom}</span>
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
                  {!dims && <LoadingStage overlay label="Cargando el video" />}
                  {/* The quick review of a player reached the end of the part: the video goes no further. */}
                  {view === "quick" && qMode === "player" && qPlayer && dims && (!qCp || (partEnd !== null && frame >= partEnd - stride)) && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
                      <span className="enter inline-flex items-center gap-2 rounded-full bg-black/75 px-4 py-1.5 text-sm text-white shadow-lg backdrop-blur">
                        <FlagCheckered size={15} weight="fill" />
                        Fin de la parte ·{" "}
                        {qDone.includes(qPlayer) ? (
                          <>
                            <kbd className="kbd">Tab</kbd> siguiente jugadora
                          </>
                        ) : (
                          <>
                            <kbd className="kbd">Mayús + Enter</kbd> hecha y siguiente
                          </>
                        )}
                      </span>
                    </div>
                  )}
                  </div>
                  {isFull && fullHud}
                </div>

                <div ref={underRef} className="shrink-0 space-y-3">
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
                  <span className="ml-auto flex items-center gap-1">
                    {/* h: in the ball view it shows or hides the players' marks; elsewhere, who is highlighted. */}
                    {view === "ball" ? (
                      <IconButton
                        label={ballBoxes ? "Ocultar las marcas de las jugadoras (h)" : "Mostrar las marcas de las jugadoras (h)"}
                        tone={ballBoxes ? "accent" : "default"}
                        onClick={() => setPref("ball:boxes", ballBoxes ? "0" : "1")}
                      >
                        <BoundingBox size={16} weight={ballBoxes ? "fill" : "regular"} />
                      </IconButton>
                    ) : (
                      <IconButton
                        label={focusSel ? "Solo la seleccionada resaltada (h): las demás se ven al pasar el ratón. Clic: todas" : "Todas resaltadas (h). Clic: solo la seleccionada"}
                        tone={focusSel ? "accent" : "default"}
                        onClick={() => setPref("correction:focus", focusSel ? "all" : "sel")}
                      >
                        <Target size={16} weight={focusSel ? "fill" : "regular"} />
                      </IconButton>
                    )}
                    <IconButton
                      label={cropping ? "Terminar el recorte" : cropTopPref || cropBottomPref ? "Recorte del cuadro (cambiar)" : "Recortar el cuadro: ver menos cielo"}
                      tone={cropping || cropTopPref || cropBottomPref ? "accent" : "default"}
                      onClick={() => setCropping(!cropping)}
                    >
                      <Crop size={16} />
                    </IconButton>
                  </span>
                  <div className="seg" role="group" aria-label="Cómo se marca a cada persona (Mayús + L)">
                    {LABEL_STYLES.map((o) => (
                      <button key={o.id} type="button" className="seg-opt" aria-pressed={labelStyle === o.id} title={`${o.label} (Mayús + L cambia)`} onClick={() => setPref("labelStyle", o.id)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <span>
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
                  <IconButton label="Pantalla completa (f)" onClick={toggleFull}>
                    <ArrowsOut size={16} />
                  </IconButton>
                </div>
                {anomOn && selected && (
                  <Notice
                    tone="danger"
                    icon={<Warning size={16} weight="fill" className="text-danger" />}
                    title={
                      anomCur
                        ? `Salta ${Math.round(anomCur.meters)} m (${Math.round(anomCur.speed)} m/s)${anomCur.until !== undefined ? ` y vuelve en ${((anomCur.until - anomCur.frame) / fps).toFixed(1)} s` : ""} · ${anomCur.until !== undefined ? "casi siempre la caja perdió sus pies" : "si desde aquí es otra persona, parte con S"}`
                        : "Corregido. Siguiente con A."
                    }
                    actions={
                      <>
                        {anomCur && (
                          <>
                            <button type="button" className={btn} onClick={() => anomDrop(anomCur)} title={`Quitar ${anomFrames(anomCur) === 1 ? "el cuadro" : `${anomFrames(anomCur)} cuadros`}: sus cajas de esos cuadros no cuentan; al guardar se rellena con una recta (Q)`}>
                              <Eraser size={14} /> Quitar {anomFrames(anomCur)} <kbd className="kbd">Q</kbd>
                            </button>
                            <button type="button" className={btn} disabled={anomCur.before === undefined} onClick={() => anomCur.before !== undefined && anomDropPrev(anomCur)} title="Quitar el anterior: muchas veces el que está mal es el cuadro de antes del salto (Alt + Q)">
                              <Eraser size={14} /> <span className="hidden min-[1700px]:inline">Anterior</span> <kbd className="kbd">Alt+Q</kbd>
                            </button>
                            <button type="button" className={`btn ${mode === "manual" ? "btn-primary" : ""}`} onClick={() => (mode === "manual" ? setMode(null) : anomFix(anomCur))} title="Marcar sus pies: clic donde están en cada cuadro del salto (P)">
                              <HandPointing size={14} /> <span className="hidden min-[1700px]:inline">Pies</span> <kbd className="kbd">P</kbd>
                            </button>
                            <button type="button" className={btnPrimary} onClick={() => anomOk(anomCur)} title="Está bien así (por ejemplo, una corrida real): no vuelve a marcarse (Enter)">
                              <Check size={14} /> Bien <kbd className="kbd">Enter</kbd>
                            </button>
                          </>
                        )}
                        <button type="button" className="btn btn-ghost !px-2 hover:text-danger" disabled={selAnoms.length < 2} onClick={anomDropAll} title="Quitar todos: los cuadros de todos sus saltos imposibles de una vez (se rellenan al guardar)">
                          Todos
                        </button>
                        <span className="tc w-12 text-center text-xs text-faint">
                          {anomCur ? selAnoms.indexOf(anomCur) + 1 : "–"}/{selAnoms.length}
                        </span>
                        <IconButton label="Anterior (Mayús + A)" onClick={() => anomStep(-1)}>
                          <SkipBack size={14} />
                        </IconButton>
                        <IconButton label="Siguiente (A)" onClick={() => anomStep(1)}>
                          <SkipForward size={14} />
                        </IconButton>
                        <IconButton label="Terminar la revisión de saltos (Esc)" onClick={() => setAnomAt(null)}>
                          <X size={14} />
                        </IconButton>
                      </>
                    }
                  >
                    {anomCur ? (
                      <>
                        Salta <strong className="text-ink">{Math.round(anomCur.meters)} m</strong> ({Math.round(anomCur.speed)} m/s)
                        {anomCur.until !== undefined && ` y vuelve en ${((anomCur.until - anomCur.frame) / fps).toFixed(1)} s`}
                        <span className="text-faint"> · {anomCur.until !== undefined ? "casi siempre la caja perdió sus pies" : "si desde aquí es otra persona, parte con S"}</span>
                      </>
                    ) : (
                      <span className="text-ok">Corregido. Siguiente con A.</span>
                    )}
                  </Notice>
                )}
                {peek && selected && peekOther !== null && (
                  <Notice
                    tone="warn"
                    title={`¿${label(selected, selected.id)} ${peek.from === selected.id ? "sigue como" : "viene de"} ${label(personById.get(peekOther), peekOther)} (recuadro amarillo)? ${peek.gapS.toFixed(1)} s, ${peek.distM.toFixed(1)} m`}
                    actions={
                      <>
                        <button type="button" className={btnPrimary} onClick={() => joinCandidate(peek)}>
                          <Check size={14} /> Unir <kbd className="kbd">Enter</kbd>
                        </button>
                        <button type="button" className={btn} onClick={() => rejectCandidate(peek)}>
                          <X size={14} /> No <kbd className="kbd">X</kbd>
                        </button>
                        <button type="button" className={btn} title="Volver a ver" onClick={() => peekAt(peek)}>
                          <ArrowClockwise size={14} /> <kbd className="kbd">R</kbd>
                        </button>
                        <button type="button" className={btn} title="Siguiente candidata" onClick={() => peekNext(peek)}>
                          Siguiente
                        </button>
                        <IconButton label="Cerrar (Esc)" onClick={() => setPeek(null)}>
                          <X size={14} />
                        </IconButton>
                      </>
                    }
                  >
                    ¿<strong>{label(selected, selected.id)}</strong> {peek.from === selected.id ? "sigue como" : "viene de"} <strong>{label(personById.get(peekOther), peekOther)}</strong> (recuadro amarillo)? {peek.gapS.toFixed(1)} s,{" "}
                    {peek.distM.toFixed(1)} m
                  </Notice>
                )}
                {(selTwiceHere || multi.some((id) => shown.filter((x) => x.id === id).length > 1)) && selected && !mode && !pickKit && (() => {
                  const id = selTwiceHere ? selected.id : (multi.find((m) => shown.filter((x) => x.id === m).length > 1) ?? selected.id);
                  const who = label(personById.get(id), id);
                  return (
                    <Notice
                      tone="warn"
                      icon={<Warning size={17} />}
                      title={`${who} tiene dos cajas en este cuadro (las de trazo rojo). Haz clic en la que sí es ella: la otra se separa como una persona aparte. Se puede deshacer.`}
                      actions={
                        <>
                          <button type="button" className={btn} title="Ninguna de las dos es ella: se le quitan las dos cajas ±0.5 s y pasa a la siguiente (Ctrl + Z deshace)" onClick={twiceNone}>
                            Ninguna es ella <kbd className="kbd">0</kbd>
                          </button>
                          <button type="button" className={btn} title="No cambia nada: no vuelve a avisar de este cuadro y pasa a la siguiente" onClick={twiceSkip}>
                            Saltar <kbd className="kbd">E</kbd>
                          </button>
                        </>
                      }
                    >
                      <strong>{who}</strong>: dos cajas aquí (trazo rojo). Clic en la que <strong>sí</strong> es ella; la otra se separa.
                    </Notice>
                  );
                })()}
                {pickKit && (
                  <Notice tone="accent" title={`Haz clic en el video sobre la camiseta de: ${KIT_LABELS[pickKit]} (${TEAM_LABELS[KIT_TEAM[pickKit]].toLowerCase()}). Esc para cancelar.`}>
                    Haz clic en el video sobre la camiseta de: {KIT_LABELS[pickKit]} ({TEAM_LABELS[KIT_TEAM[pickKit]].toLowerCase()}). Esc para cancelar.
                  </Notice>
                )}
                {mode && (
                  <Notice tone="accent" title={(mode === "merge"
                      ? `Uniendo con ${label(selected ?? undefined, sel ?? 0)}: haz clic en la caja (o en la fila) de la misma jugadora. Puedes moverte por el video. Esc para terminar.`
                      : `Marcando a ${label(selected ?? undefined, sel ?? 0)} a mano: haz clic en el video donde están sus pies en este cuadro. Esc para terminar.`)}>
                    {(mode === "merge"
                      ? `Uniendo con ${label(selected ?? undefined, sel ?? 0)}: haz clic en la caja (o en la fila) de la misma jugadora. Puedes moverte por el video. Esc para terminar.`
                      : `Marcando a ${label(selected ?? undefined, sel ?? 0)} a mano: haz clic en el video donde están sus pies en este cuadro. Esc para terminar.`)}
                  </Notice>
                )}
                </div>
                {hasBelow && (
                  <div {...zoneDrop("below")} className={`rounded-lg ${dragMod ? "outline-2 outline-offset-2 outline-dashed outline-line-strong" : ""}`}>
                    <div ref={belowRef} className="grid auto-rows-min gap-3 [grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))]">
                      {belowMods.map((m) => moduleBox(m, "below"))}
                      {belowMods.length === 0 && <p className="grid h-32 place-items-center text-xs text-faint">Suelta aquí para ponerlo bajo el video</p>}
                    </div>
                  </div>
                )}
            </div>

            {(sideMods.length > 0 || dragMod) && (
            <div className="relative min-h-0 min-w-0">
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Ancho del panel lateral (arrastra; doble clic: el de siempre)"
              title="Arrastra para cambiar el ancho del panel · doble clic: el de siempre"
              className="group absolute top-0 -left-3 hidden h-full w-2 cursor-col-resize touch-none xl:block"
              onPointerDown={dragSide}
              onDoubleClick={() => setPref("correction:sideW", String(SIDE_DEFAULT_PX))}
            >
              <span className="mx-auto block h-full w-px rounded-full transition-colors group-hover:bg-line-strong" />
            </div>
            <div
              className={`rounded-lg ${dragMod ? "outline-2 outline-offset-2 outline-dashed outline-line-strong" : ""}`}
              {...zoneDrop("side")}
            >
              <div ref={sideRef} className="space-y-3">
                {sideMods.map((m) => moduleBox(m, "side"))}
                {sideMods.length === 0 && <p className="grid h-40 place-items-center text-xs text-faint">Suelta aquí para ponerlo al lado</p>}
              </div>
            </div>
            </div>
            )}
          </div>

          {/* The timeline of the part, full width under both columns. */}
          <div className="mt-4 shrink-0 rounded-lg bg-surface p-3">
          <div ref={bottomRef} className="space-y-2">
                {/* Whole part on one bar: click to jump. */}
                <div className="flex items-center gap-3">
                  <span className="tc w-14 text-xs text-faint">{fmtT(data.start_frame / fps)}</span>
                  <div
                    className="relative h-3 flex-1 cursor-pointer rounded-full bg-line"
                    role="presentation"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      seekFrame(Math.round(data.start_frame + ((e.clientX - r.left) / r.width) * span));
                    }}
                  >
                    <span className="absolute inset-y-0 left-0 rounded-full bg-own/70" style={{ width: `${Math.min(100, Math.max(0, pos(frame)))}%` }} />
                    <span className="absolute -inset-y-1 w-0.5 rounded-full bg-ink" style={{ left: `${Math.min(100, Math.max(0, pos(frame)))}%` }} />
                  </div>
                  <span className="tc w-14 text-right text-xs text-faint">{fmtT(data.end_frame / fps)}</span>
                </div>
                {view === "ball" && (
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
                    step={bEvery * fps}
                    links={edits.ballLinks ?? []}
                  />
                )}
            {view === "players" && selected && multi.length > 0 && (
                  <div className="mb-1.5 space-y-1" aria-label="Jugadoras seleccionadas">
                    {group.map((p) => {
                      const c = groupColor(p.id) ?? "#ffffff";
                      const pend = pendingTwice(p.conflicts, p.id, edits);
                      return (
                        <div key={p.id} className="flex items-center gap-2 text-xs">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c }} />
                          <span className="w-24 truncate text-ink">{label(p, p.id)}</span>
                          <span
                            className="relative h-2.5 flex-1 cursor-pointer rounded-full bg-bg/70"
                            role="presentation"
                            onClick={(e) => {
                              const r = e.currentTarget.getBoundingClientRect();
                              seekFrame(Math.round(data.start_frame + ((e.clientX - r.left) / r.width) * span));
                            }}
                          >
                            {runs(p).map(([a, b]) => (
                              <span key={a} className="absolute inset-y-0 rounded-full opacity-80" style={{ left: `${pos(a)}%`, width: `${Math.max(0.6, pos(b) - pos(a))}%`, background: c }} />
                            ))}
                            {pend.map((f) => (
                              <span key={`t${f}`} className="absolute -inset-y-0.5 w-0.5 bg-warn" style={{ left: `${pos(f)}%` }} />
                            ))}
                            <span className="absolute -inset-y-1 w-px bg-ink" style={{ left: `${pos(frame)}%` }} />
                          </span>
                          <span className="tc w-6 text-right text-warn" title="Cajas dobles por revisar">{pend.length || ""}</span>
                          <button
                            type="button"
                            className={`btn !px-1.5 !py-0.5 text-[11px] ${p.done ? "text-ok" : ""}`}
                            aria-pressed={p.done}
                            title={p.done ? "Verificada: clic para volver a revisión" : "Marcar verificada (las demás siguen seleccionadas)"}
                            onClick={() => setEdits(setPerson(edits, p.id, { done: !p.done }))}
                          >
                            <CheckCircle size={13} weight={p.done ? "fill" : "regular"} /> {p.done ? "Verificada" : "Verificar"}
                          </button>
                          <IconButton label="Quitar de la selección" onClick={() => toggleMulti(p.id)}>
                            <X size={12} />
                          </IconButton>
                        </div>
                      );
                    })}
                    <p className="text-[10px] text-faint">D recorre las cajas dobles de las {group.length} por tiempo · E salta · 0 ninguna es ella · Esc limpia la selección</p>
                  </div>
                )}
            {view === "players" && selected && (
                  <PersonTimeline
                    key={selected.id}
                    points={selLine}
                    conflicts={selected.conflicts}
                    hints={hints.filter((h) => h.person === selected.id).map((h) => h.frame)}
                    manual={edits.manual.filter((m) => m.identity === selected.id).map((m) => m.frame)}
                    open={selGaps}
                    offCamera={selOffCamera}
                    anomalies={selAnoms.map((a) => ({ frame: a.frame, until: a.until, current: anomOn && anomAt?.frame === a.frame }))}
                    onAnomaly={(f) => {
                      const a = selAnoms.find((x) => x.frame === f);
                      if (a) anomGo(a);
                    }}
                    start={data.start_frame}
                    end={data.end_frame}
                    frame={frame}
                    fps={fps}
                    stride={stride}
                    teamColors={TEAM_COLORS}
                    onSeek={seekFrame}
                    onDrop={dropStretch}
                    onSeparate={separateStretch}
                    person={selected.id}
                    named={joinTargets}
                    pinned={pinnedP ? { id: pinnedP.id, label: label(pinnedP, pinnedP.id), color: TEAM_COLORS[pinnedP.team] } : null}
                    pinnedPoints={pinnedLine}
                    onJoin={(from, to, target) => joinRange(selected.id, from, to, target)}
                  />
            )}
            {view === "players" && !selected && <p className="text-xs text-faint">La línea de cada jugadora aparece aquí al seleccionarla.</p>}
          </div>
          </div>
          </div>
        </>
      )}
    </>
  );
}
