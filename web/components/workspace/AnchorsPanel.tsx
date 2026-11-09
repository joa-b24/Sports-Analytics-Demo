"use client";

import { ArrowBendUpRight, ArrowsSplit, CircleDashed, LinkBreak, Question, UserCircleDashed, type Icon } from "@phosphor-icons/react";
import { ArrowClockwise, ArrowCounterClockwise, CaretDown, Check, FastForward, Keyboard, Lightning, LinkSimple, MagicWand, Scissors, ShieldCheck, UserSwitch, Warning, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton, Modal } from "@/components/Modal";
import { DoubtCard, boxLabel } from "@/components/workspace/DoubtCard";
import { ResetPart } from "@/components/workspace/ResetPart";
import { answerDoubt, doubtBoxes, DOUBT_TYPES, NOT_PLAYER, staleTwoPlaces, stepFrames, type Answer, type RichDoubt } from "@/lib/doubts";
import {
  DEFAULT_DENSITY,
  densityChoices,
  generatedDensity,
  dropsByReason,
  reasonsText,
  DOUBT_LABELS,
  anchorPaths,
  acceptTramo,
  afterResolve,
  chainIndex,
  chainLookup,
  chainOverlaps,
  pendingTramos,
  resolveOverlap,
  tramoKey,
  doubtFocus,
  linksProtection,
  PLAYER_KEYS,
  DROP_HALF_S,
  dropHalfFrames,
  pickInDoubt,
  stepDoubt,
  FOCUS_COLORS,
  doubtKey,
  editsFromLinks,
  filterByDensity,
  pendingSuggestions,
  runAround,
  setAnchor,
  sortDoubts,
  suggestionFocus,
  suggestionKey,
  type Anchor,
  type AnchorFocus,
  type AnchorSuggestion,
  type ChainOverlap,
  type Doubt,
  type TramoSuggestion,
  type LinksFile,
  type SuggestFile,
} from "@/lib/anchors";
import { AUTO_REASON_NAMES, AUTO_MAX_COST, autoLabel, planAutoAccept, revertAuto, type AutoReason } from "@/lib/autoAccept";
import { findSamples, nameInSample, sampleBoxes, sampleFocus, sampleProgress } from "@/lib/samples";
import { fmtT, isTyping } from "@/lib/format";
import { listLocal, readLocal, writeLocal } from "@/lib/local";
import { linkModelNotice, linkModelStatus, type LinkModelStatus } from "@/lib/linkModel";
import { setPref, usePref } from "@/lib/store";
import { fillRequestOf } from "@/lib/techTracking";
import { useTrackingTech } from "@/lib/useTech";
import { LINKMODEL_PART, phaseName, type RunStatus, type RunTask } from "@/lib/runTask";
import { applyQuickJoin, holeKey, quickHoles, quickProgress, type QuickCandidate, type QuickHole } from "@/lib/quickJoin";
import type { FeetFile } from "@/lib/feetFix";
import { dropBoxes, editsKey, merge, separateRun, setPerson, type Person, type TracksFile } from "@/lib/tracks";
import type { AutoAccepted, RosterPlayer, TrackEdits } from "@/lib/types";

// Anchors mode of the correction table: name suggested moments (anchors), have Python fill the rest (links), then go
// through its short list of doubts. (The stopwatch of the session was removed on 2026-10-27.)

const DOUBTS_PER_PAGE = 4;
// Preference the stopwatch used to keep; cleared once so it does not stay in the browser.
const OLD_TIMING_KEY = "anchors:timing";

// One icon per kind of doubt, in the list.
const DOUBT_ICONS: Record<string, Icon> = { dos_sitios: ArrowsSplit, salto: ArrowBendUpRight, union_dudosa: LinkBreak, hueco_largo: CircleDashed, sin_nombre: UserCircleDashed };
// What the click and the keys do, by kind of doubt (under the open one).
const CUT = `S: cortar ±${DROP_HALF_S} s del trozo.`;
const DOUBT_HELP: Record<string, string> = {
  dos_sitios: `Clic en la caja que es ella: las otras se separan de ella y pasa a la siguiente. Enter: está bien. D: el trozo es otra. ${CUT}`,
  salto: `Clic en la caja que es ella (las otras resaltadas se separan). Enter: el salto está bien. D: desde aquí es otra. ${CUT}`,
  union_dudosa: `Clic en la caja que es ella. Enter: la unión está bien. D: el trozo es otra jugadora. ${CUT}`,
  hueco_largo: `Enter: el hueco está bien (se rellena al guardar). D: el trozo es otra. ${CUT}`,
  sin_nombre: `Clic en la caja si es la jugadora de la duda. D: elegir quién es. Enter: dejar sin nombre. ${CUT}`,
  default: `Clic en la caja que es ella. Enter: está bien. D: es otra. ${CUT}`,
};

// Keys of each tab, for the legend and the line under the panel. Keys of the table while a doubt is open (Q, Alt+Q, [ ])
// are listed in "Mesa".
const SHORTCUTS: { tab: string; title: string; keys: [string, string][] }[] = [
  {
    tab: "anchors",
    title: "Anclas",
    keys: [
      ["1 2 3 …", "elige jugadora"],
      ["Shift", "ninguna"],
      ["Enter", "anclar"],
      ["x", "no es jugadora"],
      ["n", "saltar (solo la oculta)"],
      ["Ctrl Z", "deshacer"],
    ],
  },
  {
    tab: "doubts",
    title: "Dudas",
    keys: [
      ["1 A", "caja 1"],
      ["2 B", "caja 2"],
      ["0", "ninguna"],
      ["Enter", "está bien"],
      ["D", "es otra"],
      ["S", "cortar"],
      ["← →", "cuadros"],
      ["Tab", "siguiente"],
      ["Enter X N", "uniones sugeridas: acepta, rechaza, siguiente"],
    ],
  },
  {
    tab: "samples",
    title: "Muestras",
    keys: [
      ["clic + 1 2 3 …", "clic en la caja y tecla de la jugadora (o al revés)"],
      ["x", "no es jugadora"],
      ["n", "siguiente muestra"],
      ["Shift n", "muestra anterior"],
      ["Esc Supr", "deshace la última"],
    ],
  },
  {
    tab: "quick",
    title: "Unión rápida",
    keys: [
      ["1 2 3 4", "une esa pieza"],
      ["Enter", "une la 1"],
      ["N", "salta"],
      ["B", "vuelve"],
    ],
  },
  {
    tab: "table",
    title: "Mesa",
    keys: [
      ["Q", "quita el cuadro siguiente del salto"],
      ["Alt Q", "quita el previo"],
      ["[ ]", "quitan su tramo anterior / siguiente"],
    ],
  },
];

// The links of the part: the file by stretches (links_<part>_exp_tramos.json) and, when it does not exist yet, the one
// Python used to write (links_<part>_exp.json).
async function readLinksFile(paths: { links: string; linksOld: string | null }): Promise<string | null> {
  return (await readLocal(paths.links)) ?? (paths.linksOld ? await readLocal(paths.linksOld) : null);
}

export type BoxPick = (chosen: { track: number; id: number }, highlighted: { track: number; id: number }[], frame: number) => boolean;

type Undo = { kind: "anchors"; anchors: Anchor[]; skipped: string[] } | { kind: "edits" };

export function AnchorsPanel({
  folder,
  matchId,
  part,
  feet,
  data,
  roster,
  edits,
  named,
  setEdits,
  undoEdits,
  onSeek,
  onFocus,
  focusMissing,
  onPending,
  pickRef,
  playerOfId,
  people,
  selectedId = null,
  onMsg,
  videoUrl = null,
}: {
  // The video of the part (for the crops of the doubt cards), or null.
  videoUrl?: string | null;
  folder: string;
  matchId: string;
  part: string;
  // Feet recalculated by Python, drawn on the thumbnails of the doubt cards (null: none).
  feet?: FeetFile | null;
  data: TracksFile;
  roster: RosterPlayer[];
  edits: TrackEdits;
  // Name -> identity of the people of the table that already have one.
  named: Map<string, number>;
  setEdits: (next: TrackEdits) => void;
  undoEdits: () => void;
  onSeek: (frame: number) => void;
  onFocus: (f: AnchorFocus | null) => void;
  // What of the highlighted is not in the frame shown (one line), or null.
  focusMissing: string | null;
  onPending: (n: number | null) => void;
  // Set by this panel: what a click on a highlighted box does (true when it was used).
  pickRef: React.RefObject<BoxPick | null>;
  playerOfId: (id: number) => string | undefined;
  // The people of the table (who is verified or named: the fill asks before touching them).
  people: Person[];
  // The person selected in the table (the quick join starts with her, if she has a name).
  selectedId?: number | null;
  onMsg: (text: string) => void;
}) {
  const fps = data.fps;
  // Detalles técnicos of the match of this folder (green gaps, doubtful-join floor, fill thresholds).
  const { match: techMatch, params: tech } = useTrackingTech(folder);
  const [tab, setTab] = useState<"anchors" | "doubts" | "quick" | "samples">("anchors");
  // The fill is B (links_<part>_exp.json, fewer jumps): the recommended mode.
  const variant = "exp" as const;
  const paths = anchorPaths(folder, part, false, variant);
  const [suggest, setSuggest] = useState<SuggestFile | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  // The link model of the match (null: the folder could not be listed, so nothing is blocked).
  const [model, setModel] = useState<LinkModelStatus | null>(null);
  const reloadModel = async () => {
    const l = await listLocal(`matches/${folder}/tracking`);
    setModel(l ? linkModelStatus(l) : null);
  };
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const skippedKey = `anchors:skipped:${folder}:${part}`;
  const skippedRaw = usePref(skippedKey, "");
  // Same array while the preference text is the same: the queue below depends on it (a new array each render recomputed it on every render).
  const skipped = useMemo(() => skippedRaw.split(",").filter(Boolean), [skippedRaw]);
  // Density asked of Python the next time it generates suggestions (the one of the file is read from the file).
  const askDensity = Number(usePref("anchors:density", String(DEFAULT_DENSITY))) || DEFAULT_DENSITY;
  const [chosen, setChosen] = useState<string | null>(null);
  const [links, setLinks] = useState<LinksFile | null>(null);
  const [linksState, setLinksState] = useState<"idle" | "missing" | "applied">("idle");
  const [stack, setStack] = useState<Undo[]>([]);
  const [doubtPage, setDoubtPage] = useState(0);
  const [otherFor, setOtherFor] = useState<string | null>(null);
  // A-3: warning when an anchor lands on a chain that overlaps in time with another chain of the same player.
  const [overlapWarn, setOverlapWarn] = useState<{ player: string; items: ChainOverlap[] } | null>(null);
  // A-2: the suggestion of a free piece being looked at, and the page of the list.
  const [sugOpen, setSugOpen] = useState<string | null>(null);
  const [sugPage, setSugPage] = useState(0);
  // A-5: quick join. The player (name), the frame it is at, the holes already skipped and the seconds to cover at the start.
  const [quickPlayer, setQuickPlayer] = useState<string | null>(null);
  const [quickCursor, setQuickCursor] = useState(0);
  const [quickSkipped, setQuickSkipped] = useState<string[]>([]);
  const [quickBase, setQuickBase] = useState<{ player: string; totalS: number; n: number } | null>(null);
  // The files of the part.
  const loadKey = `${paths.dir}|${part}|${paths.links}`;
  useEffect(() => {
    let live = true;
    void Promise.all([readLocal(paths.suggest), readLocal(paths.anchors), readLinksFile(paths), listLocal(`matches/${folder}/tracking`)]).then(([s, a, l, dirList]) => {
      if (!live) return;
      setModel(dirList ? linkModelStatus(dirList) : null);
      try {
        setSuggest(s ? (JSON.parse(s) as SuggestFile) : null);
      } catch {
        setSuggest(null);
      }
      try {
        setAnchors(a ? ((JSON.parse(a) as { anchors: Anchor[] }).anchors ?? []) : []);
      } catch {
        setAnchors([]);
      }
      try {
        setLinks(l ? (JSON.parse(l) as LinksFile) : null);
      } catch {
        setLinks(null);
      }
      setLinksState("idle");
      setStack([]);
      setLoaded(loadKey);
    });
    return () => {
      live = false;
    };
    // paths are derived from loadKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const roster10 = useMemo(() => [...roster].sort((a, b) => (a.number ?? 999) - (b.number ?? 999)), [roster]);
  const chainIdx = useMemo(() => (suggest ? chainIndex(suggest.chains) : new Map<string, number | string>()), [suggest]);
  const chainLook = useMemo(() => (suggest ? chainLookup(suggest.chains) : new Map()), [suggest]);
  // The density is a choice made when Python generates the suggestions; the one of this file is read from the file.
  const density = suggest ? (generatedDensity(suggest) ?? DEFAULT_DENSITY) : DEFAULT_DENSITY;
  const choices = useMemo(() => (suggest ? densityChoices(suggest) : []), [suggest]);
  const list = useMemo(() => (suggest ? filterByDensity(suggest.suggestions, density, fps) : []), [suggest, density, fps]);
  const queue = useMemo(() => (suggest ? pendingSuggestions(list, anchors, skipped, suggest.chains, density, fps, chainIdx) : []), [list, anchors, skipped, suggest, density, fps, chainIdx]);
  const cur: AnchorSuggestion | null = queue[0] ?? null;
  const done = list.length - queue.length;
  // A-3, before confirming: does the chain of this moment overlap with another one already anchored to the chosen player?
  const liveOverlap = useMemo(() => (cur && chosen ? chainOverlaps(chainLook, chainIdx, anchors, { frame: cur.frame, track: cur.track, player: chosen }) : []), [cur, chosen, chainLook, chainIdx, anchors]);

  // When the current moment changes, the video goes there.
  const curKey = tab === "anchors" && cur ? suggestionKey(cur) : null;
  useEffect(() => {
    if (!cur || tab !== "anchors") return;
    onSeek(cur.frame);
    onFocus(suggestionFocus(cur));
    // Only when the moment changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey]);
  const [prevCur, setPrevCur] = useState(curKey);
  if (prevCur !== curKey) {
    setPrevCur(curKey);
    setChosen(null);
  }

  // The stopwatch's old record in this browser goes once.
  const oldTiming = usePref(OLD_TIMING_KEY, "");
  useEffect(() => {
    if (oldTiming) setPref(OLD_TIMING_KEY, "");
  }, [oldTiming]);

  const saveAnchors = (next: Anchor[]) => {
    setAnchors(next);
    void writeLocal(paths.anchors, JSON.stringify({ anchors: next }, null, 1)).then((ok) => {
      if (!ok) onMsg("No se pudo guardar anchors en la carpeta del partido (¿la app corre en esta computadora?).");
    });
  };
  const confirm = (player = chosen) => {
    if (!cur) return;
    if (!player) return onMsg("Elige la jugadora (su tecla o la lista) o pulsa «No sé».");
    setStack((s) => [...s.slice(-199), { kind: "anchors", anchors, skipped }]);
    // A-3: the anchor is saved anyway (nothing is blocked); the warning stays until it is answered.
    const ov = chainOverlaps(chainLook, chainIdx, anchors, { frame: cur.frame, track: cur.track, player });
    setOverlapWarn(ov.length ? { player, items: ov } : null);
    saveAnchors(setAnchor(anchors, { frame: cur.frame, track: cur.track, player }));
  };
  // The overlap of the chain just anchored (or of the other one) leaves its person (partir) or its boxes are left out
  // (descartar). One action for the undo.
  const fixOverlap = (o: ChainOverlap, which: "esta" | "otra", how: "partir" | "descartar") => {
    const chain = chainLook.get(String(which === "esta" ? o.chain : o.other));
    if (!chain) return;
    const r = resolveOverlap(edits, data, chain, o.from, o.to, how);
    if (r.boxes === 0) return onMsg("No hay cajas de esa cadena en el solape.");
    editsChange(r.edits);
    onMsg(`${how === "partir" ? `Solape partido: ${r.boxes} tramo(s) quedan como personas aparte` : `Solape descartado: ${r.boxes} caja(s) fuera`} (cadena ${String(which === "esta" ? o.chain : o.other)}, ${fmtT(o.from / fps)}–${fmtT(o.to / fps)}). Ctrl + Z lo deshace.`);
    setOverlapWarn((w) => (w ? { ...w, items: w.items.filter((x) => x !== o) } : w));
  };
  const skip = () => {
    if (!cur) return;
    setStack((s) => [...s.slice(-199), { kind: "anchors", anchors, skipped }]);
    setPref(skippedKey, [...skipped, suggestionKey(cur)].join(","));
  };
  const editsChange = (next: TrackEdits) => {
    setStack((s) => [...s.slice(-199), { kind: "edits" }]);
    setEdits(next);
  };
  const undo = () => {
    const last = stack[stack.length - 1];
    if (!last) return undoEdits();
    setStack((s) => s.slice(0, -1));
    if (last.kind === "edits") return undoEdits();
    if (last.anchors !== anchors) saveAnchors(last.anchors);
    setPref(skippedKey, last.skipped.join(","));
  };

  // Links: Python's identities as ordinary edits of the table (Ctrl + Z undoes them in one step).
  const reloadLinks = async () => {
    const text = await readLinksFile(paths);
    if (!text) {
      setLinks(null);
      return setLinksState("missing");
    }
    let l: LinksFile;
    try {
      l = JSON.parse(text) as LinksFile;
    } catch {
      return onMsg("links no es un JSON válido.");
    }
    setLinks(l);
    // Work done by hand in the table is never overwritten without asking.
    const prot = linksProtection(people);
    if (prot.list.length) return setAsk({ kind: "links", l, prot });
    applyLinks(l);
  };
  const applyLinks = (l: LinksFile, protect?: { ids: Set<number>; tracks: Set<number> }) => {
    setAsk(null);
    const r = editsFromLinks(edits, data, l, named, protect);
    editsChange(r.edits);
    setLinksState("applied");
    const by = reasonsText(r.droppedBy);
    onMsg(
      `Rellenado (B): ${r.players} jugadora(s), ${r.tracks} trozo(s) con nombre nuevo${r.dropped ? `. B quitó ${r.dropped} caja(s) (${by})` : ""}${r.skipped ? `; ${r.skipped} trozo(s) de jugadoras verificadas o con nombre se dejaron como estaban` : ""}${r.stretches ? `; ${r.stretches} tramo(s) en ${r.cutTracks} trozo(s) partidos (${Object.entries(r.stretchSeconds).map(([p, s]) => `${p} ${Math.round(s)} s`).join(", ")})` : ""}${r.conflicts.length ? `; ${r.conflicts.length} trozo(s) con dos nombres se dejaron como estaban` : ""}. Ctrl + Z lo deshace.`,
    );
  };
  // What a new run of Python rewrites, said before it runs (null: nothing to lose).
  const keptAnchors = anchors.length ? ` Las ${anchors.length} anclas hechas se conservan (anchors_${part}.json no se toca).` : "";
  const warnSuggest = () =>
    suggest || anchors.length ? `${suggest ? `Se reescribe suggest_${part}.json (${suggest.suggestions.length} sugerencias).` : ""}${keptAnchors}` : null;
  const warnFill = () =>
    links
      ? `Se reescribe links_${part}${variant ? "_exp_tramos" : ""}.json (relleno B por tramos; ${links.doubt_summary?.tasks ?? links.doubts.length} dudas por revisar; las ${(edits.anchorDoubts ?? []).length} resueltas siguen marcadas en la mesa).${keptAnchors} Al terminar se pregunta antes de tocar jugadoras verificadas o con nombre.`
      : null;

  const resolved = edits.anchorDoubts;
  // «En dos sitios» that a fill by stretches already settled (the two boxes are now two people) are not asked again.
  const settled = useMemo(() => staleTwoPlaces(links?.doubts ?? [], data, edits), [links, data, edits]);
  const doubts = useMemo(() => sortDoubts(links?.doubts ?? [], [...(resolved ?? []), ...settled]), [links, resolved, settled]);
  const pages = Math.max(1, Math.ceil(doubts.pending.length / DOUBTS_PER_PAGE));
  const page = Math.min(doubtPage, pages - 1);
  // A doubt's time runs from the previous action (looking at it is part of the work).
  const [ask, setAsk] = useState<null | { kind: "links"; l: LinksFile; prot: ReturnType<typeof linksProtection> } >(null);
  const [openDoubt, setOpenDoubt] = useState<string | null>(null);
  const [viewFrame, setViewFrame] = useState(0);
  const [legend, setLegend] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Only the boxes of the doubt, each by its own track (A/B or 1/2): the ones not in the frame shown are said so.
  const focusOf = (d: Doubt, frame: number) => {
    const { boxes } = doubtBoxes(d as RichDoubt, data, edits);
    if (!boxes.length) return doubtFocus(d);
    return { frame, marks: boxes.slice(0, 2).map((b, i) => ({ track: b.track, label: boxLabel(d.kind, i), what: `${boxLabel(d.kind, i)} (trozo ${b.track})` })) };
  };
  const showFrame = (d: Doubt, frame: number) => {
    setViewFrame(frame);
    onSeek(frame);
    onFocus(focusOf(d, frame));
  };
  const goDoubt = (d: Doubt) => {
    showFrame(d, d.frame);
    setOpenDoubt(doubtKey(d));
    setOtherFor(null);
    const i = doubts.pending.findIndex((x) => doubtKey(x) === doubtKey(d));
    if (i >= 0) setDoubtPage(Math.floor(i / DOUBTS_PER_PAGE));
  };
  const openD = doubts.pending.find((d) => doubtKey(d) === openDoubt) ?? null;
  // After resolving `d`, the next doubt opens (or the highlight goes, when none is left).
  const advance = (d: Doubt) => {
    const n = afterResolve(doubts.pending, doubtKey(d));
    if (n) goDoubt(n);
    else {
      setOpenDoubt(null);
      onFocus(null);
    }
  };
  // The count of pending doubts goes to the view switch of the table.
  const pendingN = links ? doubts.pending.length : null;
  useEffect(() => {
    onPending(pendingN);
    // onPending is a state setter of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingN]);

  // Reload only the file a Python run wrote.
  const reloadSuggest = async () => {
    const s = await readLocal(paths.suggest);
    try {
      setSuggest(s ? (JSON.parse(s) as SuggestFile) : null);
    } catch {
      onMsg("suggest no es un JSON válido.");
    }
  };
  const resolve = (d: Doubt, next: TrackEdits) => {
    editsChange({ ...next, anchorDoubts: [...(next.anchorDoubts ?? []), doubtKey(d)] });
  };
  const doubtOk = (d: Doubt) => (resolve(d, edits), advance(d));
  const doubtOther = (d: Doubt, player: string) => {
    setOtherFor(null);
    const sep = separateRun(edits, data, d.track, d.frame);
    if (!sep) return onMsg("No hay caja de ese trozo en ese cuadro.");
    const into = named.get(player);
    resolve(d, into !== undefined ? merge(sep.edits, into, sep.identity) : setPerson(sep.edits, sep.identity, { player_id: player }));
    advance(d);
  };
  const answer = (d: Doubt, a: Answer, i = 0) => {
    const { boxes } = doubtBoxes(d as RichDoubt, data, edits);
    const r = answerDoubt(edits, data, boxes, a, i);
    resolve(d, r.edits);
    advance(d);
  };
  const steps = openD ? stepFrames(data, openD.frame) : [];
  const step = (dir: 1 | -1) => {
    if (!openD || !steps.length) return;
    const i = steps.indexOf(viewFrame);
    const j = i < 0 ? steps.findIndex((f) => f >= viewFrame) : Math.min(steps.length - 1, Math.max(0, i + dir));
    showFrame(openD, steps[Math.max(0, j)]);
  };
  const doubtDrop = (d: Doubt) => {
    const frames = runAround(data, d.track, d.frame, data.stride * 2, dropHalfFrames(fps));
    resolve(d, dropBoxes(edits, frames.map((frame) => ({ track: d.track, frame }))));
    advance(d);
  };

  // A-2: free pure pieces that Python found likely (union_dudosa with p >= 0.8): accept / reject, one click, best p first.
  const tramos = useMemo(() => pendingTramos(links, resolved, { p: tech.doubtMinP, maxCost: tech.doubtMaxCost }), [links, resolved, tech]);
  const tramoSecs = (t: TramoSuggestion) => ((t.frame_fin - t.frame_ini) / fps + data.stride / fps).toFixed(1);
  const showTramo = (t: TramoSuggestion) => {
    setSugOpen(tramoKey(t));
    setViewFrame(t.frame_ini);
    onSeek(t.frame_ini);
    onFocus({ frame: t.frame_ini, marks: [{ track: t.track, label: "?", what: `trozo ${t.track}` }] });
    const i = tramos.findIndex((x) => tramoKey(x) === tramoKey(t));
    if (i >= 0) setSugPage(Math.floor(i / DOUBTS_PER_PAGE));
  };
  // After answering one, the next one opens (or the highlight goes).
  const nextTramo = (t: TramoSuggestion) => {
    const rest = tramos.filter((x) => tramoKey(x) !== tramoKey(t));
    const i = tramos.findIndex((x) => tramoKey(x) === tramoKey(t));
    const n = rest[Math.min(Math.max(i, 0), rest.length - 1)];
    if (n) showTramo(n);
    else {
      setSugOpen(null);
      onFocus(null);
    }
  };
  const tramoAccept = (t: TramoSuggestion) => {
    const r = acceptTramo(edits, data, t, named);
    if (r.status === "empty") return onMsg("Ese trozo ya no tiene cajas en el tramo.");
    if (r.status === "overlap") return onMsg(`No se asignó: ${t.person} ya tiene ${r.overlap} cuadro(s) con otra caja en ese tramo. Rechaza la unión o arréglalo en la mesa.`);
    editsChange({ ...r.edits, anchorDoubts: [...(r.edits.anchorDoubts ?? []), tramoKey(t)] });
    onMsg(r.status === "same" ? `${t.person}: ese tramo ya era suyo.` : `${t.person}: +${tramoSecs(t)} s del trozo ${t.track}. Ctrl + Z lo deshace.`);
    nextTramo(t);
  };
  const tramoReject = (t: TramoSuggestion) => {
    editsChange({ ...edits, anchorDoubts: [...(edits.anchorDoubts ?? []), tramoKey(t)] });
    nextTramo(t);
  };
  const openTramo = tramos.find((t) => tramoKey(t) === sugOpen) ?? null;

  // «Aceptar las seguras» (lib/autoAccept.ts): the suggestions that are trivial, all in one edit. Those the analyst took out
  // of the automatic list (autoSkip) are not taken again; she can still accept them one by one.
  const namedMap = useMemo(() => new Map(people.filter((p) => p.player_id).map((p) => [p.player_id, p.id])), [people]);
  const autoSkipKey = `anchors:autoSkip:${folder}:${part}`;
  const autoSkipRaw = usePref(autoSkipKey, "");
  const autoSkip = useMemo(() => new Set(autoSkipRaw.split(",").filter(Boolean)), [autoSkipRaw]);
  const plan = useMemo(
    () => (links && tramos.length > 0 ? planAutoAccept({ file: data, edits, ppl: people, named: namedMap, doubts: doubts.pending }, tramos, tech.autoAcceptP, autoSkip) : null),
    [links, tramos, data, edits, people, namedMap, doubts.pending, tech.autoAcceptP, autoSkip],
  );
  const autoList = edits.autoAccepted ?? [];
  // The batch just applied (for the notice with «Deshacer»).
  const [autoNote, setAutoNote] = useState<AutoAccepted[] | null>(null);
  const sugText = (n: number) => `${n} sugerencia${n === 1 ? "" : "s"} segura${n === 1 ? "" : "s"}`;
  const applyAuto = (byItself: boolean) => {
    if (!plan || plan.accepted.length === 0) return;
    editsChange(plan.edits);
    setAutoNote(plan.accepted);
    onMsg(`Se ${plan.accepted.length === 1 ? "aceptó" : "aceptaron"} ${sugText(plan.accepted.length)}${byItself ? " al abrir la parte" : ""}${plan.refused ? ` (${plan.refused} se rechazaron al aplicar por chocar entre ellas)` : ""}. Ctrl + Z deshace el lote entero.`);
  };
  // With the switch on (Detalles técnicos), the batch is applied once for each links file loaded, when the part opens.
  const autoRan = useRef<LinksFile | null>(null);
  useEffect(() => {
    if (!tech.autoAcceptOn || !links || loaded !== loadKey || ask || autoRan.current === links) return;
    autoRan.current = links;
    applyAuto(true);
  });
  // Takes acceptances out: the stretch goes back to what it was, the suggestion is pending again and is not taken again
  // by the batch.
  const removeAuto = (recs: AutoAccepted[]) => {
    const r = revertAuto(edits, data, recs, namedMap);
    editsChange(r.edits);
    setPref(autoSkipKey, [...autoSkip, ...recs.map((x) => x.key)].join(","));
    onMsg(`${r.reverted} unión(es) vuelven a como estaban${r.changed ? `; ${r.changed} ya habían cambiado a mano y se dejaron` : ""}. Ctrl + Z lo deshace.`);
  };
  const showAuto = (a: AutoAccepted) => {
    setViewFrame(a.frame_ini);
    onSeek(a.frame_ini);
    onFocus({ frame: a.frame_ini, marks: [{ track: a.track, label: "✓", what: `trozo ${a.track} (${a.person})` }] });
  };
  const unsafeText = plan
    ? (Object.entries(plan.unsafe) as [AutoReason, number][])
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${n} ${AUTO_REASON_NAMES[r]}`)
        .join(", ")
    : "";

  // A-5: quick join. Her holes, the pieces that fit each one, and where we are.
  const quickNames = useMemo(() => {
    const order = new Map(roster.map((r) => [r.player_id, r.number ?? 999]));
    return [...new Set(people.filter((p) => p.player_id).map((p) => p.player_id))].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b));
  }, [people, roster]);
  const qName = quickPlayer ?? people.find((p) => p.id === selectedId)?.player_id ?? "";
  const qPerson = qName ? people.find((p) => p.player_id === qName) : undefined;
  const qHoles = useMemo(() => (tab === "quick" && qPerson ? quickHoles(data, edits, people, qPerson.id, [tech.greenMinS, tech.greenMaxS]) : []), [tab, data, edits, people, qPerson, tech]);
  const qSkip = useMemo(() => new Set(quickSkipped), [quickSkipped]);
  const qNav = qHoles.filter((h) => !h.green);
  const qTodo = qNav.filter((h) => !qSkip.has(holeKey(h)));
  const qCur: QuickHole | null = qTodo.find((h) => h.a >= quickCursor) ?? qTodo[0] ?? null;
  const qProg = quickProgress(qHoles, qSkip);
  const qTotalS = qNav.reduce((t, h) => t + h.seconds, 0);
  // The seconds to cover when she was chosen (during render: a new player starts a new count).
  if (tab === "quick" && qPerson && quickBase?.player !== qName) setQuickBase({ player: qName, totalS: qTotalS, n: qNav.length });
  const qCovered = quickBase && quickBase.player === qName ? Math.max(0, quickBase.totalS - qTotalS) : 0;
  const qCurKey = qCur ? holeKey(qCur) : null;
  useEffect(() => {
    if (tab !== "quick") return;
    if (!qCur) return onFocus(null);
    const c = qCur.candidates[0];
    const at = c ? c.a : qCur.a;
    onSeek(at);
    onFocus({ frame: at, marks: qCur.candidates.map((x, i) => ({ track: x.track, label: String(i + 1), what: `pieza ${i + 1} (trozo ${x.track})` })) });
    // Only when the hole changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qCurKey, tab]);
  const quickJoin = (c: QuickCandidate) => {
    if (!qPerson) return;
    const r = applyQuickJoin(data, edits, people, qPerson.id, c);
    if (!r) return onMsg("No se unió: ella ya tiene otra caja en esos cuadros.");
    editsChange(r.edits);
    onMsg(`${qName}: +${c.seconds.toFixed(1)} s${c.name ? ` de ${c.name}${r.cut ? " (ella conserva el resto)" : ""}` : ""}. Ctrl + Z lo deshace.`);
  };
  const quickSkip = () => {
    if (!qCur) return;
    setQuickSkipped((k) => [...k, holeKey(qCur)]);
    setQuickCursor(qCur.a + 1);
  };
  const quickBack = () => {
    if (!qCur) return;
    const prev = [...qNav].reverse().find((h) => h.a < qCur.a);
    if (!prev) return;
    setQuickSkipped((k) => k.filter((x) => x !== holeKey(prev)));
    setQuickCursor(prev.a);
  };

  // «Muestras»: frames where many of our players are in view, named box by box with the player keys of «Anclas».
  const sampleMin = Math.round(tech.sampleMinPlayers);
  const samples = useMemo(() => (tab === "samples" ? findSamples(data, tech.sampleGapS, sampleMin) : []), [tab, data, tech.sampleGapS, sampleMin]);
  const [sampleIdx, setSampleIdx] = useState(0);
  const [sChosen, setSChosen] = useState<string | null>(null);
  const [selTrack, setSelTrack] = useState<number | null>(null);
  const nameOfId = useMemo(() => new Map(people.filter((p) => p.player_id).map((p) => [p.id, p.player_id])), [people]);
  const sample = samples[Math.min(sampleIdx, samples.length - 1)] ?? null;
  const sBoxes = useMemo(() => (sample ? sampleBoxes(data, edits, sample.frame, anchors, nameOfId) : []), [sample, data, edits, anchors, nameOfId]);
  const sProg = sampleProgress(sBoxes);
  // The circle of a box shows the shirt number of the player, else the start of her name.
  const sLabel = (name: string) => {
    const n = roster.find((r) => r.player_id === name)?.number;
    return n != null ? String(n) : name.slice(0, 2);
  };
  // Entering the tab (or new parameters): start at the first sample that still has boxes to name.
  const sampleStart = useRef<unknown>(null);
  useEffect(() => {
    if (tab !== "samples" || samples.length === 0 || sampleStart.current === samples) return;
    sampleStart.current = samples;
    const first = samples.findIndex((x) => {
      const p = sampleProgress(sampleBoxes(data, edits, x.frame, anchors, nameOfId));
      return p.named < p.total;
    });
    setSampleIdx(first < 0 ? 0 : first);
    setSChosen(null);
    setSelTrack(null);
    // Only when the list of samples changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, samples]);
  const sFrame = tab === "samples" && sample ? sample.frame : null;
  useEffect(() => {
    if (sFrame !== null) onSeek(sFrame);
    // Only when the sample changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sFrame]);
  useEffect(() => {
    if (tab !== "samples" || !sample) return;
    onFocus(sampleFocus(sample.frame, sBoxes, selTrack, sLabel));
    // The marks follow the boxes and the selected one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sample, sBoxes, selTrack]);
  const moveSample = (dir: 1 | -1) => {
    if (samples.length === 0) return;
    setSampleIdx((i) => (Math.min(i, samples.length - 1) + dir + samples.length) % samples.length);
    setSChosen(null);
    setSelTrack(null);
  };
  // Naming one box: an ordinary anchor, as in «Anclas» (the same warning when her chain overlaps another of hers).
  const sampleName = (track: number, player: string) => {
    if (!sample) return;
    setStack((st) => [...st.slice(-199), { kind: "anchors", anchors, skipped }]);
    const a = { frame: sample.frame, track, player };
    const ov = chainOverlaps(chainLook, chainIdx, anchors, a);
    setOverlapWarn(ov.length ? { player, items: ov } : null);
    saveAnchors(nameInSample(anchors, a));
    setSChosen(null);
    setSelTrack(null);
  };
  // A key (or a click on the list) with a box already selected names it; otherwise the player waits for the click.
  const samplePlayer = (player: string) => {
    if (selTrack !== null) sampleName(selTrack, player);
    else setSChosen((c) => (c === player ? null : player));
  };
  // Esc: first drops what is half done; Supr: undoes the last anchor.
  const sampleUndo = () => {
    const last = stack[stack.length - 1];
    if (!last || last.kind !== "anchors") return onMsg("No hay un ancla reciente que deshacer (Ctrl + Z deshace también las ediciones).");
    undo();
  };

  // A click on a highlighted box of the open doubt: «this is her» (Correction calls it through pickRef).
  useEffect(() => {
    pickRef.current = (chosen, highlighted, frame) => {
      if (tab === "samples") {
        if (!sample || !sBoxes.some((b) => b.track === chosen.track)) return false;
        if (sChosen) sampleName(chosen.track, sChosen);
        else setSelTrack((t) => (t === chosen.track ? null : chosen.track));
        return true;
      }
      if (tab !== "doubts" || !openD) return false;
      const r = pickInDoubt(edits, data, frame, chosen, highlighted, (id) => playerOfId(id), named, openD.players);
      resolve(openD, r.edits);
      onMsg(`${r.player ?? "Esa caja"}: confirmada${r.cut ? `; ${r.cut} caja(s) separada(s) de ella` : ""}. Ctrl + Z lo deshace.`);
      advance(openD);
      return true;
    };
  });

  // Keys of this mode go before those of the table (capture), only while it is shown.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.altKey || ask || document.querySelector('[role="dialog"]')) return;
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") return stop(), undo();
      if (e.ctrlKey || e.metaKey) return;
      if (tab === "doubts") {
        // Only while the doubts are shown: Tab / Enter / D / S of the table do not reach it.
        if (e.key === "Tab") {
          const n = stepDoubt(doubts.pending, openDoubt, e.shiftKey ? -1 : 1);
          if (n) goDoubt(n);
          return stop();
        }
        if (!openD && openTramo) {
          const k0 = e.key.toLowerCase();
          if (e.key === "Enter") return stop(), tramoAccept(openTramo);
          if (k0 === "x") return stop(), tramoReject(openTramo);
          if (k0 === "n") return stop(), nextTramo(openTramo);
        }
        if (!openD) return;
        if (otherFor !== null) {
          if (e.key === "Escape") return stop(), setOtherFor(null);
          if (/^[0-9]$/.test(e.key)) {
            const p = roster10[(Number(e.key) + 9) % 10];
            if (p) doubtOther(openD, p.player_id);
            return stop();
          }
          return;
        }
        const k = e.key.toLowerCase();
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") return stop(), step(e.key === "ArrowRight" ? 1 : -1);
        const union = openD.kind === "union_dudosa";
        if (k === "1" || (k === "a" && !union)) return stop(), union ? answer(openD, "join") : answer(openD, "pick", 0);
        if (k === "2" || (k === "b" && !union)) return stop(), union ? answer(openD, "nojoin") : answer(openD, "pick", 1);
        if (k === "0" && !union) return stop(), answer(openD, "none");
        if (e.key === "Enter") return stop(), openD.kind === "dos_sitios" ? answer(openD, "both") : doubtOk(openD);
        if (k === "d") return stop(), setOtherFor(doubtKey(openD));
        if (k === "s") return stop(), doubtDrop(openD);
        return;
      }
      if (tab === "samples") {
        const k = e.key.toLowerCase();
        if (k === "n") return stop(), moveSample(e.shiftKey ? -1 : 1);
        if (e.key === "Escape") {
          if (sChosen !== null || selTrack !== null) {
            setSChosen(null);
            setSelTrack(null);
          } else sampleUndo();
          return stop();
        }
        if (e.key === "Delete" || e.key === "Backspace") return stop(), sampleUndo();
        if (!sample || e.shiftKey) return;
        if (k === "x") return stop(), samplePlayer(NOT_PLAYER);
        const pk = PLAYER_KEYS.indexOf(k);
        if (pk >= 0 && pk < roster10.length) return stop(), samplePlayer(roster10[pk].player_id);
        return;
      }
      if (tab === "quick") {
        const k1 = e.key.toLowerCase();
        if (!qCur) return;
        if (/^[1-4]$/.test(k1)) {
          const c = qCur.candidates[Number(k1) - 1];
          stop();
          if (c) quickJoin(c);
          return;
        }
        if (e.key === "Enter") return stop(), qCur.candidates[0] ? quickJoin(qCur.candidates[0]) : quickSkip();
        if (k1 === "n") return stop(), quickSkip();
        if (k1 === "b") return stop(), quickBack();
        return;
      }
      if (tab !== "anchors") return;
      const pk = e.shiftKey ? -1 : PLAYER_KEYS.indexOf(e.key.toLowerCase());
      if (cur && pk >= 0 && pk < roster10.length) {
        setChosen(roster10[pk].player_id);
        return stop();
      }
      if (e.key === "Enter" || e.key === " ") return stop(), confirm();
      if (e.key === "n") return stop(), skip();
      if (e.key === "x" && cur) return stop(), confirm(NOT_PLAYER);
    };
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on, true);
    return () => {
      window.removeEventListener("keydown", on, true);
      onFocus(null);
    };
    // onFocus is stable enough: it only clears the highlight on leaving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shownName = (id: string) => {
    if (id === NOT_PLAYER) return "No es jugadora";
    const r = roster.find((p) => p.player_id === id);
    return r?.number != null ? `${r.number} ${id}` : id;
  };

  const header = (
    <div className="mb-3 flex items-center gap-1.5">
      <div className="seg min-w-0 flex-1" role="group" aria-label="Paso del modo anclas">
        <button type="button" className="seg-opt flex-1 !px-2" aria-pressed={tab === "anchors"} onClick={() => setTab("anchors")}>
          Anclas
          {suggest && queue.length > 0 && <span className="tc ml-1 text-faint">{queue.length}</span>}
        </button>
        <button type="button" className="seg-opt flex-1 !px-2" aria-pressed={tab === "doubts"} onClick={() => setTab("doubts")}>
          Dudas
          {links ? <span className="tc ml-1 text-faint">{doubts.pending.length}</span> : null}
          {tramos.length > 0 && <span className="tc ml-1 text-accent-100" title={`${tramos.length} unión(es) sugerida(s) por aceptar`}>+{tramos.length}</span>}
        </button>
        <button type="button" className="seg-opt flex-1 !px-2" aria-pressed={tab === "quick"} title="Unión rápida: recorre los huecos de una jugadora y une la pieza que cabe, con una tecla" onClick={() => setTab("quick")}>
          Unión
        </button>
        <button type="button" className="seg-opt flex-1 !px-2" aria-pressed={tab === "samples"} title="Muestras: cuadros con muchas de nuestras jugadoras a la vista; se nombran varias cajas de una vez" onClick={() => setTab("samples")}>
          Muestras
        </button>
      </div>
      <IconButton label="Tipos de duda y atajos de teclado" onClick={() => setLegend(true)}>
        <Question size={15} />
      </IconButton>
      <IconButton label="Deshacer (Ctrl + Z)" onClick={undo}>
        <ArrowCounterClockwise size={15} />
      </IconButton>
    </div>
  );

  // A-5: the quick join of one player.
  const quickBody = (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-ink-2">Jugadora</span>
        <select
          className="input h-8 min-w-0 flex-1 py-0 text-xs"
          value={qName}
          aria-label="Jugadora cuyos huecos se recorren"
          onChange={(e) => {
            setQuickPlayer(e.target.value);
            setQuickCursor(0);
            setQuickSkipped([]);
            e.currentTarget.blur();
          }}
        >
          <option value="">Elegir…</option>
          {quickNames.map((n) => (
            <option key={n} value={n}>
              {shownName(n)}
            </option>
          ))}
        </select>
      </div>
      {!qPerson ? (
        <p className="text-ink-2">Elige una jugadora con nombre en la mesa: se recorren sus huecos en orden y se une la pieza que cabe en cada uno.</p>
      ) : (
        <>
          <div className="space-y-1">
            <div className="h-1 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${quickBase && quickBase.totalS > 0 ? Math.min(100, (100 * qCovered) / quickBase.totalS) : 0}%` }} />
            </div>
            <p className="tc text-ink-2" title="Huecos que faltan por revisar (sin los verdes ni los saltados) y segundos de hueco que se han cubierto desde que elegiste a la jugadora">
              {qProg.left} hueco(s) por revisar ({qProg.leftS.toFixed(0)} s) · {qCovered.toFixed(0)} s cubiertos
              {qProg.green > 0 && <span className="text-ok"> · {qProg.green} verde(s)</span>}
            </p>
          </div>
          {qCur ? (
            <div className="space-y-1.5">
              <p className="text-ink-2">
                Hueco <span className="tc text-ink">{fmtT(qCur.a / fps)}–{fmtT(qCur.b / fps)}</span> ({qCur.seconds.toFixed(1)} s)
                {qCur.offCamera && <span className="text-faint"> · salió de cuadro</span>}
              </p>
              {qCur.candidates.length === 0 ? (
                <p className="rounded-lg bg-raised/60 px-2 py-1.5 text-faint">Ninguna pieza cabe en este hueco (tiempo y distancia a los dos lados). Si es corto se rellena al guardar; si no, márcala a mano en la mesa (p). Salta con N.</p>
              ) : (
                qCur.candidates.map((c, i) => (
                  <button
                    key={`${c.from}:${c.a}`}
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded-lg bg-raised/60 px-2 py-1 text-left hover:bg-raised"
                    onClick={() => quickJoin(c)}
                    title={`Unir: la pieza ${fmtT(c.a / fps)}–${fmtT(c.b / fps)} pasa a ${qName}. Suma de distancias a los dos extremos del hueco: ${c.cost} m`}
                  >
                    <span className="tc grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-bg" style={{ background: FOCUS_COLORS[i % FOCUS_COLORS.length] }}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-ink">{c.name || "sin nombre"}</span>
                      <span className="text-faint"> · trozo {c.track} · {c.seconds.toFixed(1)} s · {c.cost} m</span>
                      {c.twoSides && c.name && <span className="text-warn"> · se corta de {c.name} (conserva el resto)</span>}
                      {c.verified && <span className="text-warn"> · verificada</span>}
                    </span>
                    <kbd className="kbd">{i + 1}</kbd>
                  </button>
                ))
              )}
              <div className="flex gap-1.5">
                <button type="button" className="btn btn-primary flex-1 !gap-1 !px-2 !py-1 text-[11px]" disabled={qCur.candidates.length === 0} onClick={() => qCur.candidates[0] && quickJoin(qCur.candidates[0])}>
                  <LinkSimple size={13} /> Unir la 1 <kbd className="tc opacity-70">Enter</kbd>
                </button>
                <button type="button" className="btn !gap-1 !px-2 !py-1 text-[11px]" title="No unir nada aquí y pasar al siguiente hueco" onClick={quickSkip}>
                  <FastForward size={13} /> Saltar <kbd className="tc text-faint">N</kbd>
                </button>
                <button type="button" className="btn btn-ghost !gap-1 !px-2 !py-1 text-[11px]" title="Volver al hueco anterior" onClick={quickBack}>
                  <ArrowCounterClockwise size={13} /> <kbd className="tc text-faint">B</kbd>
                </button>
              </div>
            </div>
          ) : (
            <p className="text-ok">Sin huecos por revisar para {qName}. Los verdes (de {tech.greenMinS} a {tech.greenMaxS} s fuera de la cámara) no hace falta rellenarlos.</p>
          )}
          <p className="text-[10px] text-faint">
            Aquí no se pregunta «está en dos sitios»: la pieza se corta de quien la tiene (ella conserva lo anterior y lo posterior) y pasa a {qName}. Nada se une solo; cada unión se deshace con Ctrl + Z.
            <kbd className="kbd">1</kbd>–<kbd className="kbd">4</kbd> unir esa pieza · <kbd className="kbd">Enter</kbd> la 1 · <kbd className="kbd">N</kbd> saltar · <kbd className="kbd">B</kbd> anterior.
          </p>
        </>
      )}
    </div>
  );

  // Density chooser for the next generation (counts shown when the current file says how many each would give).
  const askDensityControl = (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-2">Anclas por minuto</span>
      <div className="seg" role="group" aria-label="Anclas por minuto al generar">
        {[1, 2, 3, 4, 5].map((d) => {
          const n = choices.find((c) => c.density === d)?.n;
          return (
            <button key={d} type="button" className="seg-opt !px-1.5" aria-pressed={askDensity === d} title={n != null ? `${n} sugerencias a ${d} por minuto` : `${d} por minuto`} onClick={() => setPref("anchors:density", String(d))}>
              {d}
              {n != null && <span className="tc ml-0.5 text-[10px] opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );

  const overlapNode =
    overlapWarn && overlapWarn.items.length > 0 ? (
    <div className="space-y-1.5 rounded-lg bg-warn-900/60 p-2 text-[11px] text-warn" role="alert">
      {overlapWarn.items.map((o) => (
        <div key={`${o.chain}:${o.other}`} className="space-y-1">
          <p className="flex items-start gap-1.5">
            <Warning size={13} className="mt-px shrink-0" />
            <span>
              Esta cadena ({String(o.chain)}) se solapa con otra de {overlapWarn.player} ({String(o.other)}) entre {fmtT(o.from / fps)} y {fmtT(o.to / fps)} ({((o.to - o.from) / fps).toFixed(1)} s): en el solape una de las dos es otra
              persona. El ancla se guardó igual.
            </span>
          </p>
          <div className="flex flex-wrap gap-1">
            <button type="button" className="btn !px-1.5 !py-0.5 text-[11px]" title="La cadena que acabas de anclar pierde el solape: sus tramos ahí quedan como personas aparte, sin nombre" onClick={() => fixOverlap(o, "esta", "partir")}>
              <Scissors size={12} /> Partir (esta)
            </button>
            <button type="button" className="btn !px-1.5 !py-0.5 text-[11px]" title="Las cajas de la cadena que acabas de anclar en el solape no cuentan" onClick={() => fixOverlap(o, "esta", "descartar")}>
              <X size={12} /> Descartar (esta)
            </button>
            <button type="button" className="btn btn-ghost !px-1.5 !py-0.5 text-[11px]" title="La otra cadena (ya anclada a ella) pierde el solape: sus tramos ahí quedan como personas aparte" onClick={() => fixOverlap(o, "otra", "partir")}>
              <Scissors size={12} /> Partir (la otra)
            </button>
            <button type="button" className="btn btn-ghost !px-1.5 !py-0.5 text-[11px]" title="Las cajas de la otra cadena en el solape no cuentan" onClick={() => fixOverlap(o, "otra", "descartar")}>
              <X size={12} /> Descartar (la otra)
            </button>
            <button type="button" className="btn btn-ghost !px-1.5 !py-0.5 text-[11px]" onClick={() => setOverlapWarn((w) => (w ? { ...w, items: w.items.filter((x) => x !== o) } : w))}>
              Dejar así
            </button>
          </div>
        </div>
      ))}
      <p className="text-faint">«Descartar» es definitivo para el relleno; «Partir» se puede reemplazar si vuelves a rellenar por tramos. Ctrl + Z deshace cualquiera.</p>
    </div>
  ) : null;

  // «Muestras»: the sample being shown, its boxes and the roster to name them with.
  const samplesBody = (
    <div className="space-y-2.5 text-xs">
      {samples.length === 0 || !sample ? (
        <p className="rounded-lg bg-raised/60 px-2 py-1.5 text-ink-2">
          Ningún cuadro de esta parte tiene {sampleMin} o más de nuestras jugadoras a la vista (por color de uniforme), con {tech.sampleGapS} s entre muestras. Baja el mínimo o la separación en Configuración › Detalles técnicos.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-bold text-ink">Muestras</h3>
            <span className="tc text-ink-2" title="Muestra actual y cuántas de nuestras cajas de ese cuadro ya tienen nombre (ancla de este cuadro o nombre en la mesa)">
              muestra <span className="text-ink">{Math.min(sampleIdx, samples.length - 1) + 1}</span>/{samples.length} · <span className="text-ink">{sProg.named}</span> de {sProg.total} nombradas
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={sProg.total} aria-valuenow={sProg.named} aria-label="Cajas nombradas en esta muestra">
            <div className="h-full bg-ok transition-[width] duration-300" style={{ width: `${sProg.total ? (100 * sProg.named) / sProg.total : 0}%` }} />
          </div>
          {overlapNode}
          <div className="space-y-2 rounded-xl bg-raised/50 p-2.5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
              <span className="tc text-base text-ink">{fmtT(sample.frame / fps)}</span>
              <span className="tag">{sample.own} propias a la vista</span>
              <span className="tc ml-auto text-faint">verde = con nombre · amarillo = falta</span>
            </p>
            {focusMissing && <p className="text-[11px] text-warn">{focusMissing}</p>}
            <p className="text-ink">
              {sChosen
                ? `Elegiste a ${sChosen === NOT_PLAYER ? "«No es jugadora»" : sChosen}: haz clic en su caja.`
                : selTrack !== null
                  ? `Caja del trozo ${selTrack} elegida: pulsa la tecla de la jugadora.`
                  : "Clic en una caja y la tecla de la jugadora (o la tecla y luego el clic)."}
            </p>
            <div className="grid grid-cols-4 gap-0.5">
              {roster10.map((p, i) => {
                const inFrame = sBoxes.some((b) => b.name === p.player_id);
                return (
                  <button
                    key={p.player_id}
                    type="button"
                    className={`btn !justify-start !gap-1 !px-1.5 !py-0.5 text-[11px] ${sChosen === p.player_id ? "btn-primary" : "btn-ghost"} ${inFrame && sChosen !== p.player_id ? "!text-ok" : ""}`}
                    aria-pressed={sChosen === p.player_id}
                    title={inFrame ? `${p.player_id} ya tiene caja en este cuadro (si la nombras en otra, se mueve)` : undefined}
                    onClick={() => samplePlayer(p.player_id)}
                  >
                    {PLAYER_KEYS[i] && <kbd className="tc w-2.5 shrink-0 text-faint uppercase">{PLAYER_KEYS[i]}</kbd>}
                    <span className="truncate">{shownName(p.player_id)}</span>
                    {inFrame && <Check size={11} weight="bold" className="ml-auto shrink-0" aria-hidden />}
                  </button>
                );
              })}
            </div>
            {roster10.length === 0 && <p className="text-warn">Sin plantilla: añádela en Configuración para nombrar cajas.</p>}
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-1">
              <button type="button" className="btn btn-ghost !px-1.5 text-xs" title="Muestra anterior (Shift + N)" onClick={() => moveSample(-1)}>
                ‹ <kbd className="tc text-faint">Shift n</kbd>
              </button>
              <button type="button" className="btn btn-primary justify-center !px-1.5 text-xs" title="Pasa a la siguiente muestra (las cajas sin nombre se quedan sin nombre)" onClick={() => moveSample(1)}>
                <FastForward size={14} />
                {sProg.named < sProg.total ? "Saltar muestra" : "Siguiente muestra"} <kbd className="tc opacity-70">n</kbd>
              </button>
              <button type="button" className="btn !px-1.5 text-xs" title="Árbitra, banca, cuerpo técnico: la caja elegida se guarda como «no es jugadora»" disabled={selTrack === null && sChosen === null} onClick={() => samplePlayer(NOT_PLAYER)}>
                No es jugadora <kbd className="tc text-faint">x</kbd>
              </button>
              <button type="button" className="btn !px-1.5 text-xs" title="Deshace el último ancla (Esc o Supr)" onClick={sampleUndo}>
                <ArrowCounterClockwise size={13} />
              </button>
            </div>
          </div>
          <p className="text-[10px] text-faint">
            Cada nombre es un ancla igual que en «Anclas» (mismo archivo anchors_{part}.json); después «Rellenar» conecta el resto. Las muestras salen de cuántas cajas nuestras se ven (por color), no del seguimiento: una caja de otro equipo mal leída por el color no aparece aquí.
          </p>
        </>
      )}
    </div>
  );

  // «Aceptar las seguras» and the list of what was accepted by itself.
  const autoNode =
    links && (plan || autoList.length > 0 || autoNote) ? (
      <div className="mb-3 space-y-1.5 rounded-lg bg-accent-900/30 p-2 text-[11px]">
        {autoNote && autoNote.length > 0 && (
          <p className="flex items-center gap-1.5 text-accent-100" role="status">
            <ShieldCheck size={13} aria-hidden />
            <span>Se {autoNote.length === 1 ? "aceptó" : "aceptaron"} {sugText(autoNote.length)}</span>
            <button
              type="button"
              className="btn !ml-auto !px-1.5 !py-0.5 text-[11px]"
              onClick={() => {
                removeAuto(autoNote);
                setAutoNote(null);
              }}
            >
              <ArrowCounterClockwise size={12} /> Deshacer
            </button>
          </p>
        )}
        {plan && (
          <div className="space-y-1">
            {plan.accepted.length > 0 ? (
              <button
                type="button"
                className="btn btn-primary w-full justify-center !gap-1 !px-2 !py-1 text-[11px]"
                title={`${plan.accepted.length} de ${plan.judged} sugerencias pendientes cumplen todo: p ≥ ${(tech.autoAcceptP * 100).toFixed(1)} %, costo ≤ ${AUTO_MAX_COST}, sin choque de equipo, solape, salto ni duda. Se aplican como UNA edición (Ctrl + Z la deshace entera).`}
                onClick={() => applyAuto(false)}
              >
                <ShieldCheck size={13} /> {autoLabel(plan.accepted.length)}
              </button>
            ) : (
              <p className="text-ink-2">Ninguna de las {plan.judged} sugerencias pendientes es segura todavía.</p>
            )}
            <p className="text-faint" title="Por qué las demás no son seguras (una sugerencia puede tener varios motivos)">
              {plan.accepted.length} de {plan.judged} cumplen p ≥ {(tech.autoAcceptP * 100).toFixed(1)} % y costo ≤ {AUTO_MAX_COST} sin choques{unsafeText ? ` · no: ${unsafeText}` : ""}.
            </p>
          </div>
        )}
        {autoList.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-accent-100 hover:text-ink">
              <CaretDown size={11} className="transition-transform group-open:rotate-180" aria-hidden /> Aceptadas automáticamente ({autoList.length})
            </summary>
            <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
              {autoList.map((a) => (
                <li key={a.key} className="flex items-center gap-1 rounded bg-raised/60 px-1.5 py-0.5">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => showAuto(a)} title={`Trozo ${a.track}, cuadros ${a.frame_ini}–${a.frame_fin}: clic para ir al cuadro`}>
                    <span className="tc text-ink">{fmtT(a.frame_ini / fps)}</span>
                    <span className="truncate text-ink">{a.person}</span>
                    <span className="tc shrink-0 text-faint">
                      {((a.frame_fin - a.frame_ini) / fps + data.stride / fps).toFixed(1)} s · {Math.round(a.p * 1000) / 10} % · {a.cost.toFixed(2)}
                    </span>
                  </button>
                  <IconButton label={`Quitar: el trozo ${a.track} deja de ser de ${a.person} y la sugerencia no se acepta sola otra vez`} onClick={() => removeAuto([a])}>
                    <X size={12} />
                  </IconButton>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10px] text-faint">Aceptadas por el lote, no a mano. Quitar una la devuelve a las uniones sugeridas, sin aceptar.</p>
          </details>
        )}
      </div>
    ) : null;

  // Suggest and fill need the link model of the match: without it they are replaced by the notice to train it.
  const modelNotice = model ? linkModelNotice(model) : null;
  const modelMissing = modelNotice != null && modelNotice.kind !== "stale";
  const modelNode = modelNotice ? (
    <div className={`space-y-2 rounded-xl p-2.5 text-xs ${modelNotice.kind === "stale" ? "bg-raised/50 text-ink-2" : "bg-warn-900/60 text-warn"}`} role="status">
      <p className="flex items-start gap-1.5">
        {modelNotice.kind !== "stale" && <Warning size={13} className="mt-px shrink-0" aria-hidden />}
        <span>{modelNotice.text}</span>
      </p>
      {modelNotice.canTrain && model && (
        <RunControl
          match={matchId}
          part={LINKMODEL_PART}
          task="linkmodel"
          label="Entrenar modelo de uniones"
          icon={<Lightning size={14} />}
          extra={model.videos.length ? { videos: model.videos } : undefined}
          onDone={reloadModel}
        />
      )}
    </div>
  ) : null;

  let body: React.ReactNode;
  if (loaded !== loadKey) body = <p className="text-xs text-faint">Leyendo la carpeta…</p>;
  else if (tab === "anchors" && !suggest)
    body = (
      <div className="space-y-3 text-xs text-ink-2">
        <p>
          No hay sugerencias de anclas para esta parte. Elige cuántas anclas por minuto quieres y genera las sugerencias (tarda unos segundos o
          minutos).
        </p>
        {modelNode}
        {!modelMissing && askDensityControl}
        {!modelMissing && <RunControl match={matchId} part={part} task="suggest" perMin={askDensity} label="Generar sugerencias" icon={<MagicWand size={14} />} warn={warnSuggest} onDone={reloadSuggest} />}
      </div>
    );
  else if (tab === "anchors")
    body = (
      <div className="space-y-3">
        <section aria-label="Anclas por nombrar" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-bold text-ink">Nombrar anclas</h3>
            <span className="tc text-xs text-ink-2" title={`Sugerencias generadas a ${density} por minuto`}>
              <span className="text-ink">{done}</span> de {list.length} · {queue.length} por hacer
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={done} aria-label="Anclas hechas">
            <div className="h-full bg-ok transition-[width] duration-300" style={{ width: `${list.length ? (100 * done) / list.length : 0}%` }} />
          </div>
        {overlapNode}
          {cur ? (
            <div className="space-y-2 rounded-xl bg-raised/50 p-2.5">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                <span className="tc text-base text-ink">{fmtT(cur.frame / fps)}</span>
                <span className="tag">trozo {String(cur.chain)}</span>
                <span className={`tag ${cur.why === "incierta" ? "tag-warn" : ""}`}>{cur.why}</span>
                <span className="tc ml-auto text-faint" title="Puntaje de la sugerencia: más alto = trozo más largo y aislado, más fácil de nombrar">puntaje {cur.score.toFixed(2)}</span>
              </p>
              <p className="text-xs text-ink">¿Quién es la caja amarilla (con «?»)?</p>
              {focusMissing && <p className="text-[11px] text-warn">{focusMissing}</p>}
              <div className="grid grid-cols-4 gap-0.5">
                {roster10.map((p, i) => (
                  <button
                    key={p.player_id}
                    type="button"
                    className={`btn !justify-start !gap-1 !px-1.5 !py-0.5 text-[11px] ${chosen === p.player_id ? "btn-primary" : "btn-ghost"}`}
                    aria-pressed={chosen === p.player_id}
                    onClick={() => setChosen(p.player_id)}
                    onDoubleClick={() => confirm(p.player_id)}
                  >
                    {PLAYER_KEYS[i] && <kbd className="tc w-2.5 shrink-0 text-faint uppercase">{PLAYER_KEYS[i]}</kbd>}
                    <span className="truncate">{shownName(p.player_id)}</span>
                  </button>
                ))}
              </div>
              {roster10.length === 0 && <p className="text-xs text-warn">Sin plantilla: añádela en Configuración para nombrar anclas.</p>}
              {chosen && liveOverlap.length > 0 && (
                <p className="flex items-start gap-1.5 text-[11px] text-warn" role="status">
                  <Warning size={13} className="mt-px shrink-0" />
                  <span>
                    Ojo: esta cadena se solapa con otra de {chosen} ({liveOverlap.map((o) => `${fmtT(o.from / fps)}–${fmtT(o.to / fps)}`).join(", ")}). Puedes anclar igual: después se ofrece partir o descartar el solape.
                  </span>
                </p>
              )}
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1">
                <button type="button" className="btn btn-primary justify-center !px-1.5 text-xs" disabled={!chosen} onClick={() => confirm()}>
                  <Check size={14} />
                  Anclar <kbd className="tc opacity-70">Enter</kbd>
                </button>
                <button type="button" className="btn !px-1.5 text-xs" title="Árbitra, banca, cuerpo técnico: se guarda como ancla «no es jugadora» y Python la deja fuera" onClick={() => confirm(NOT_PLAYER)}>
                  No es jugadora <kbd className="tc text-faint">x</kbd>
                </button>
                <button type="button" className="btn !px-1.5 text-xs" title="Solo oculta esta sugerencia aquí; no cambia el relleno" onClick={skip}>
                  Saltar <kbd className="tc text-faint">n</kbd>
                </button>
              </div>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 rounded-xl bg-raised/50 p-2.5 text-xs text-ok">
              <Check size={14} weight="bold" aria-hidden /> Sin anclas pendientes. Pasa a «Rellenar».
            </p>
          )}
          <details className="group text-[11px] text-faint">
            <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-ink-2">
              <CaretDown size={11} className="transition-transform group-open:rotate-180" aria-hidden /> Pedir más o menos sugerencias
            </summary>
            <div className="mt-1.5 space-y-1.5">
              <p>
                Este archivo trae {suggest?.suggestions.length} sugerencias{suggest && generatedDensity(suggest) ? `, generadas a ${density} por minuto` : ""}. El número se decide al generar, no aquí: Python escribe otro archivo.
              </p>
              {modelMissing ? <p className="text-warn">Para generar sugerencias nuevas falta el modelo de uniones (ver el aviso en «Relleno»).</p> : (
                <>
                  {askDensityControl}
                  <RunControl match={matchId} part={part} task="suggest" perMin={askDensity} label="Generar sugerencias" icon={<MagicWand size={14} />} warn={warnSuggest} onDone={reloadSuggest} />
                </>
              )}
            </div>
          </details>
        </section>
        <section aria-label="Relleno" className="space-y-1.5 border-t border-line pt-3">
          <h3 className="text-[13px] font-bold text-ink">Relleno</h3>
          <p className="text-[11px] text-ink-2">Con las anclas puestas, Python rellena el resto de la parte y deja una lista de dudas.</p>
          {modelNode}
          {!modelMissing && <RunControl match={matchId} part={part} task="fill" variant={variant} label="Rellenar" icon={<Lightning size={14} />} warn={warnFill} extra={{ ...fillRequestOf(techMatch) }} onDone={reloadLinks} />}
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost !px-2 text-xs" title="Volver a leer links_ de la carpeta y aplicarlo a la mesa" onClick={() => void reloadLinks()}>
              <ArrowClockwise size={13} />
              Volver a cargar el relleno
            </button>
            <span className="text-[11px] text-faint">
              {linksState === "missing" ? "Aún no existe " + paths.links.split("/").pop() : linksState === "applied" ? "Aplicado a la mesa (Ctrl + Z lo deshace)" : ""}
            </span>
          </div>
        </section>
      </div>
    );
  else if (tab === "samples") body = samplesBody;
  else if (tab === "quick") body = quickBody;
  else if (!links)
    body = <p className="text-xs text-ink-2">Las dudas salen de links_{part}.json. Pulsa «Rellenar» en Anclas.</p>;
  else if (openD) {
    const card = doubtBoxes(openD as RichDoubt, data, edits);
    const idx = doubts.pending.findIndex((d) => doubtKey(d) === openDoubt);
    body = (
      <>
        {focusMissing && !focusMissing.includes("misma caja") && <p className="mb-1 text-[11px] text-warn">{focusMissing} — clic en su miniatura para ir a su cuadro.</p>}
        {otherFor === openDoubt ? (
          <div className="grid grid-cols-4 gap-0.5">
            {roster10.map((p, i) => (
              <button key={p.player_id} type="button" className="btn btn-ghost !justify-start !gap-1 !px-1.5 !py-0.5 text-[11px]" onClick={() => doubtOther(openD, p.player_id)}>
                {i < 10 && <kbd className="tc text-faint">{(i + 1) % 10}</kbd>}
                <span className="truncate">{shownName(p.player_id)}</span>
              </button>
            ))}
            <button type="button" className="btn btn-ghost !px-1.5 !py-0.5 text-[11px]" onClick={() => setOtherFor(null)}>
              <X size={12} /> Cancelar <kbd className="tc text-faint">Esc</kbd>
            </button>
          </div>
        ) : (
          <DoubtCard
            d={openD as RichDoubt}
            boxes={card.boxes}
            derived={card.derived}
            file={data}
            feet={feet ?? null}
            videoUrl={videoUrl}
            viewFrame={viewFrame}
            steps={steps}
            index={idx}
            total={doubts.pending.length}
            onStep={step}
            onGo={(f) => showFrame(openD, f)}
            onAnswer={(a, i) => answer(openD, a, i)}
            onOther={() => setOtherFor(openDoubt)}
            onCut={() => doubtDrop(openD)}
            onPrev={() => {
              const n = stepDoubt(doubts.pending, openDoubt, -1);
              if (n) goDoubt(n);
            }}
            onNext={() => {
              const n = stepDoubt(doubts.pending, openDoubt, 1);
              if (n) goDoubt(n);
            }}
            onClose={() => {
              setOpenDoubt(null);
              onFocus(null);
            }}
          />
        )}
      </>
    );
  } else {
    const rows = doubts.pending.slice(page * DOUBTS_PER_PAGE, page * DOUBTS_PER_PAGE + DOUBTS_PER_PAGE);
    body = (
      <div className="space-y-1.5">
        <p className={`tc text-xs ${doubts.pending.length < 100 ? "text-ok" : "text-warn"}`}>
          {doubts.pending.length} pendientes · {doubts.done.length} resueltas · meta &lt; 100
        </p>
        {doubts.info.length > 0 && (
          <details className="text-[11px] text-faint">
            <summary className="cursor-pointer">Huecos y cadenas sin nombre: {doubts.info.length} (no hay que revisarlas)</summary>
            <ul className="mt-1 space-y-0.5 pl-3">
              {Object.entries(doubts.info.reduce<Record<string, number>>((m, d) => ({ ...m, [d.kind]: (m[d.kind] ?? 0) + 1 }), {})).map(([kind, n]) => (
                <li key={kind}>
                  {DOUBT_LABELS[kind] ?? kind}: {n}
                </li>
              ))}
              {(links.doubt_summary?.auto_resolved?.dos_sitios ?? 0) > 0 && <li>En dos sitios resueltas solas (por ancla o duración): {links.doubt_summary?.auto_resolved?.dos_sitios}</li>}
            </ul>
          </details>
        )}
        {tramos.length > 0 && (
          <div className="space-y-1 rounded-lg bg-accent-900/30 p-1.5">
            <p className="flex items-center gap-1 text-[11px] text-accent-100">
              <LinkSimple size={13} aria-hidden />
              <span>
                {tramos.length} unión(es) sugerida(s) · p ≥ 80 %, costo ≤ 1.0 · nada se asigna solo
              </span>
            </p>
            {tramos.slice(sugPage * DOUBTS_PER_PAGE, sugPage * DOUBTS_PER_PAGE + DOUBTS_PER_PAGE).map((t) => {
              const tk = tramoKey(t);
              const open = sugOpen === tk;
              return (
                <div key={tk} className={`flex items-center gap-1 rounded-lg px-2 py-1 ${open ? "bg-raised ring-1 ring-accent/60" : "bg-raised/60"}`}>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs" onClick={() => showTramo(t)} title={`Trozo ${t.track}, cuadros ${t.frame_ini}–${t.frame_fin}: clic para ir al cuadro`}>
                    <span className="tc text-ink">{fmtT(t.frame_ini / fps)}</span>
                    <span className="truncate text-ink">{t.person}</span>
                    <span className="tc shrink-0 text-faint">
                      {tramoSecs(t)} s · {Math.round(t.p * 100)} % · {t.cost.toFixed(2)}
                    </span>
                  </button>
                  <IconButton label={`Aceptar: el trozo ${t.track} pasa a ${t.person}${open ? " (Enter)" : ""}`} tone="accent" onClick={() => tramoAccept(t)}>
                    <Check size={13} />
                  </IconButton>
                  <IconButton label={`Rechazar${open ? " (X)" : ""}`} onClick={() => tramoReject(t)}>
                    <X size={13} />
                  </IconButton>
                </div>
              );
            })}
            {tramos.length > DOUBTS_PER_PAGE && (
              <div className="flex items-center justify-center gap-2 text-xs text-faint">
                <button type="button" className="btn btn-ghost !px-2 !py-0.5" disabled={sugPage === 0} onClick={() => setSugPage(sugPage - 1)}>
                  ‹
                </button>
                <span className="tc">
                  {sugPage + 1} / {Math.ceil(tramos.length / DOUBTS_PER_PAGE)}
                </span>
                <button type="button" className="btn btn-ghost !px-2 !py-0.5" disabled={(sugPage + 1) * DOUBTS_PER_PAGE >= tramos.length} onClick={() => setSugPage(sugPage + 1)}>
                  ›
                </button>
              </div>
            )}
            <p className="text-[10px] text-faint">
              Clic en la fila: ir al cuadro (el trozo sale con «?»). <kbd className="kbd">Enter</kbd> acepta · <kbd className="kbd">X</kbd> rechaza · <kbd className="kbd">N</kbd> siguiente. Aceptar se deshace con Ctrl + Z.
            </p>
          </div>
        )}
        <p className="text-[11px] text-faint">
          <kbd className="kbd">Tab</kbd> siguiente · <kbd className="kbd">Shift</kbd>+<kbd className="kbd">Tab</kbd> anterior
        </p>
        {rows.map((d) => {
          const k = doubtKey(d);
          const open = openDoubt === k;
          const Icon = DOUBT_ICONS[d.kind] ?? Question;
          return (
            <div key={k} className={`flex flex-wrap items-center gap-x-1 rounded-lg px-2 py-1 ${open ? "bg-raised ring-1 ring-accent/60" : "bg-raised/60"}`}>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs" onClick={() => goDoubt(d)} title={`${d.note} (clic: ir al cuadro)`}>
                <span className="tc text-ink">{fmtT(d.frame / fps)}</span>
                <span className="inline-flex items-center gap-1 text-warn">
                  <Icon size={14} weight="bold" aria-hidden />
                  {DOUBT_LABELS[d.kind] ?? d.kind}
                </span>
                <span className="truncate text-faint">{d.players.join(", ") || `trozo ${d.track}`}</span>
              </button>
              {open && (
                <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 pb-0.5 text-[11px] text-ink-2">
                  {doubtFocus(d).marks.map((m, i) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      <span className="tc grid h-4 w-4 place-items-center rounded-full text-[10px] font-bold text-bg" style={{ background: FOCUS_COLORS[i % FOCUS_COLORS.length] }}>
                        {m.label}
                      </span>
                      {m.what}
                    </span>
                  ))}
                  {focusMissing && <span className="w-full text-warn">{focusMissing}</span>}
                  <span className="w-full text-ink-2">{DOUBT_HELP[d.kind] ?? DOUBT_HELP.default}</span>
                </div>
              )}
              {otherFor === k ? (
                <div className="mt-1 grid w-full grid-cols-4 gap-0.5">
                  {roster10.map((p, i) => (
                    <button key={p.player_id} type="button" className="btn btn-ghost !justify-start !gap-1 !px-1.5 !py-0.5 text-[11px]" onClick={() => doubtOther(d, p.player_id)}>
                      {i < 10 && <kbd className="tc text-faint">{(i + 1) % 10}</kbd>}
                      <span className="truncate">{shownName(p.player_id)}</span>
                    </button>
                  ))}
                  <button type="button" className="btn btn-ghost !px-1.5 !py-0.5 text-[11px]" onClick={() => setOtherFor(null)}>
                    <X size={12} /> Cancelar <kbd className="tc text-faint">Esc</kbd>
                  </button>
                </div>
              ) : open ? (
                <div className="mt-1 grid w-full grid-cols-3 gap-1">
                  <button type="button" className="btn btn-primary !gap-1 !px-1.5 !py-0.5 text-[11px]" title="Está bien: se marca resuelta y pasa a la siguiente" onClick={() => doubtOk(d)}>
                    <Check size={13} /> Bien <kbd className="tc opacity-70">Enter</kbd>
                  </button>
                  <button type="button" className="btn !gap-1 !px-1.5 !py-0.5 text-[11px]" title="Es otra: elegir la jugadora del trozo" onClick={() => setOtherFor(k)}>
                    <UserSwitch size={13} /> Es otra <kbd className="tc text-faint">D</kbd>
                  </button>
                  <button type="button" className="btn !gap-1 !px-1.5 !py-0.5 text-[11px]" title={`Cortar: quitar las cajas de ese trozo ±${DROP_HALF_S} s alrededor (se rellenan al guardar)`} onClick={() => doubtDrop(d)}>
                    <Scissors size={13} /> Cortar <kbd className="tc text-faint">S</kbd>
                  </button>
                </div>
              ) : (
                <span className="flex shrink-0">
                  <IconButton label="Está bien" onClick={() => (goDoubt(d), doubtOk(d))}>
                    <Check size={13} />
                  </IconButton>
                  <IconButton label="Es otra: elegir jugadora" onClick={() => (goDoubt(d), setOtherFor(k))}>
                    <UserSwitch size={13} />
                  </IconButton>
                  <IconButton label={`Cortar: las cajas de ese trozo ±${DROP_HALF_S} s alrededor (se rellenan al guardar)`} onClick={() => doubtDrop(d)}>
                    <Scissors size={13} />
                  </IconButton>
                </span>
              )}
            </div>
          );
        })}
        {pages > 1 && (
          <div className="flex items-center justify-center gap-2 text-xs text-faint">
            <button type="button" className="btn btn-ghost !px-2 !py-0.5" disabled={page === 0} onClick={() => setDoubtPage(page - 1)}>
              ‹
            </button>
            <span className="tc">
              {page + 1} / {pages}
            </span>
            <button type="button" className="btn btn-ghost !px-2 !py-0.5" disabled={page >= pages - 1} onClick={() => setDoubtPage(page + 1)}>
              ›
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="card !p-3">
      {ask?.kind === "links" && (
        <Modal title="El relleno toca jugadoras de la mesa" onClose={() => setAsk(null)}>
          <p className="text-sm text-ink-2">
            En esta parte hay {ask.prot.list.filter((x) => x.done).length} jugadora(s) verificada(s) y {ask.prot.list.filter((x) => !x.done).length} con nombre sin verificar. El
            relleno B puede cambiarles trozos.
          </p>
          {(() => {
            const by = dropsByReason(ask.l);
            const n = Object.values(by).reduce((a, b) => a + b, 0);
            return n > 0 ? (
              <p className="mt-2 text-sm text-ink-2">
                Además quita hasta <b className="text-ink">{n}</b> caja(s) dobles o fuera de ruta: {reasonsText(by)}. Ctrl + Z deshace todo el relleno en un paso.
              </p>
            ) : (
              <p className="mt-2 text-xs text-faint">Este relleno no trae cajas que quitar. Ctrl + Z lo deshace.</p>
            );
          })()}
          <p className="mt-2 text-xs text-ink-2">
            {ask.prot.list.slice(0, 24).map((x, i) => (
              <span key={i} className={`mr-1.5 inline-block ${x.done ? "text-ok" : ""}`}>
                {x.done ? "✓ " : ""}
                {x.name}
              </span>
            ))}
            {ask.prot.list.length > 24 && <span className="text-faint">y {ask.prot.list.length - 24} más</span>}
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setAsk(null)}>
              Cancelar
            </button>
            <button type="button" className="btn" onClick={() => applyLinks(ask.l)}>
              Sobreescribir todo
            </button>
            <button type="button" className="btn btn-primary" autoFocus onClick={() => applyLinks(ask.l, ask.prot)}>
              Aplicar solo a las demás
            </button>
          </div>
          <p className="mt-2 text-right text-[11px] text-faint">«Aplicar solo a las demás» deja intactas las verificadas y las que ya tienen nombre. Ctrl + Z deshace cualquiera.</p>
        </Modal>
      )}
      {legend && (
        <Modal title="Tipos de duda y atajos" onClose={() => setLegend(false)}>
          <ul className="space-y-2 text-sm">
            {DOUBT_TYPES.map((t) => (
              <li key={t.kind}>
                <span className="font-bold text-ink">{t.name}</span> <span className={`tag ${t.task ? "" : "opacity-70"}`}>{t.task ? "tarea" : "informativa"}</span>
                <p className="text-xs text-ink-2">{t.what}</p>
                <p className="text-xs text-ink">{t.todo}</p>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-sm font-bold text-ink">Atajos de teclado</h3>
          <dl className="mt-1 space-y-1.5 text-xs text-ink-2">
            {SHORTCUTS.map((g) => (
              <div key={g.title} className="grid grid-cols-[6.5rem_1fr] gap-2">
                <dt className="font-bold text-ink">{g.title}</dt>
                <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {g.keys.map(([k, what]) => (
                    <span key={what} className="inline-flex items-center gap-1">
                      {k.split(" ").map((x) => (
                        <kbd key={x} className="kbd">
                          {x}
                        </kbd>
                      ))}
                      {what}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
      {header}
      {autoNode}
      {body}
      <details className="group mt-3 border-t border-line pt-2 text-[11px] text-faint" open={shortcutsOpen} onToggle={(e) => setShortcutsOpen(e.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-ink-2">
          <Keyboard size={13} aria-hidden /> Atajos de {SHORTCUTS.find((g) => g.tab === tab)?.title.toLowerCase()}
          <CaretDown size={11} className="ml-auto transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {(SHORTCUTS.find((g) => g.tab === tab)?.keys ?? []).map(([k, what]) => (
            <span key={what} className="inline-flex items-center gap-1">
              {k.split(" ").map((x) => (
                <kbd key={x} className="kbd">
                  {x}
                </kbd>
              ))}
              {what}
            </span>
          ))}
        </p>
      </details>
      <div className="mt-2">
        <ResetPart folder={folder} part={part} editsKey={editsKey(data)} onMsg={onMsg} />
      </div>
    </section>
  );
}

// A Python task of the anchors mode (app/api/run/anchors): a button, then its progress (phase, %, time left), its
// error with «Reintentar», and on success `onDone` (which reloads the file it wrote). One run per part at a time: a
// run already going (opened from another tab, or before a reload) is picked up.
const POLL_MS = 1000;
export function RunControl({
  match,
  part,
  task,
  variant,
  perMin,
  label,
  icon,
  onDone,
  warn,
  extra,
}: {
  match: string;
  part: string;
  task: RunTask;
  variant?: "exp";
  perMin?: number;
  label: string;
  icon: React.ReactNode;
  onDone: () => void | Promise<void>;
  // What the run would overwrite (asked before starting), or null.
  warn?: () => string | null;
  // More fields of the request (the ball task: force when it overwrites a ball_auto).
  extra?: Record<string, unknown>;
}) {
  const [st, setSt] = useState<(RunStatus & { log?: string | null }) | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const url = `/api/run/anchors?match=${encodeURIComponent(match)}&part=${encodeURIComponent(part)}&task=${task}${variant ? `&variant=${variant}` : ""}`;
  const doneRef = useRef(onDone);
  // Set when this button starts a run: a run that ends before the first look still reloads its file.
  const startedHere = useRef(false);
  useEffect(() => {
    doneRef.current = onDone;
  });

  // What the server says now; a run that ends while being watched reloads its file.
  useEffect(() => {
    let live = true;
    let timer = 0;
    let wasRunning = false;
    const tick = async () => {
      const r = await fetch(url, { cache: "no-store" }).catch(() => null);
      if (!live) return;
      if (!r || !r.ok) {
        setSt(null);
        return;
      }
      const s = (await r.json()) as RunStatus & { log?: string | null };
      if (!live) return;
      setSt(s);
      if (s.state === "running") {
        wasRunning = true;
        timer = window.setTimeout(() => void tick(), POLL_MS);
      } else {
        if ((wasRunning || startedHere.current) && s.state === "done") void doneRef.current();
        startedHere.current = false;
        setPolling(false);
      }
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [url, polling]);

  const [asking, setAsking] = useState<string | null>(null);
  const ask = () => {
    const w = warn?.() ?? null;
    if (w) setAsking(w);
    else void start();
  };
  const start = async () => {
    setAsking(null);
    setStartError(null);
    const r = await fetch("/api/run/anchors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, match, part, perMin, variant, ...extra }) }).catch(() => null);
    if (!r) return setStartError("No se pudo hablar con la app (¿corre en esta computadora?).");
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      return setStartError(body?.error ?? (r.status === 403 || r.status === 404 ? "Solo funciona con la app abierta en esta computadora (localhost)." : "No se pudo iniciar."));
    }
    startedHere.current = true;
    setSt({ state: "running", phase: "", done: 0, total: 0, pct: 0, eta_s: null, message: "" });
    setPolling(true);
  };

  const running = st?.state === "running";
  const eta = st?.eta_s;
  const fmtEta = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);
  return (
    <div className="space-y-1.5">
      {asking && (
        <Modal title={`${label}: se reescribe un archivo`} onClose={() => setAsking(null)}>
          <p className="text-sm text-ink-2">{asking}</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn btn-primary" autoFocus onClick={() => setAsking(null)}>
              Cancelar
            </button>
            <button type="button" className="btn" onClick={() => void start()}>
              {icon}
              {label} de todos modos
            </button>
          </div>
        </Modal>
      )}
      {!running && (
        <button type="button" className={`btn ${st?.state === "error" || startError ? "" : "btn-primary"} w-full justify-center`} onClick={ask}>
          {st?.state === "error" || startError ? <ArrowClockwise size={14} /> : icon}
          {st?.state === "error" || startError ? `Reintentar: ${label.toLowerCase()}` : st?.state === "done" ? `${label} otra vez` : label}
        </button>
      )}
      {running && (
        <div className="space-y-1" role="status" aria-live="polite">
          <div className="flex items-baseline justify-between gap-2 text-[11px] text-ink-2">
            <span className="truncate">
              {label}… {st.phase ? `${phaseName(st.phase)}${st.total > 1 ? ` ${st.done}/${st.total}` : ""}` : "empezando"}
            </span>
            <span className="tc shrink-0">
              {st.pct} %{eta != null && eta > 0 ? ` · quedan ${fmtEta(eta)}` : ""}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(3, st.pct)}%` }} />
          </div>
        </div>
      )}
      {st?.state === "done" && <p className="text-[11px] text-ok">Listo: archivo actualizado.</p>}
      {(startError || st?.state === "error") && (
        <p className="flex items-start gap-1.5 rounded-lg bg-warn-900/60 px-2 py-1.5 text-[11px] text-warn">
          <Warning size={13} className="mt-px shrink-0" />
          <span>
            {startError ?? st?.message}
            {!startError && st?.log && (
              <>
                {" "}
                <a className="underline" href={`/api/local/${st.log}`} target="_blank" rel="noreferrer">
                  Ver el detalle
                </a>
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
