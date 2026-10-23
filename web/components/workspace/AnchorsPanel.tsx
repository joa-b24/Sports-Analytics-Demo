"use client";

import { ArrowBendUpRight, ArrowsSplit, CircleDashed, LinkBreak, Question, UserCircleDashed, type Icon } from "@phosphor-icons/react";
import { ArrowClockwise, ArrowCounterClockwise, Check, DownloadSimple, Flask, Lightning, MagicWand, Scissors, Timer, UserSwitch, Warning, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton, Modal } from "@/components/Modal";
import { DoubtCard, boxLabel } from "@/components/workspace/DoubtCard";
import { ResetPart } from "@/components/workspace/ResetPart";
import { answerDoubt, doubtBoxes, DOUBT_TYPES, NOT_PLAYER, stepFrames, type Answer, type RichDoubt } from "@/lib/doubts";
import {
  DEFAULT_DENSITY,
  dropsByReason,
  reasonsText,
  densityCounts,
  DOUBT_LABELS,
  anchorPaths,
  afterResolve,
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
  timingSummary,
  type Anchor,
  type AnchorFocus,
  type AnchorSuggestion,
  type Doubt,
  type LinksFile,
  type SuggestFile,
  type TimedAction,
} from "@/lib/anchors";
import { downloadText, fmtT, isTyping } from "@/lib/format";
import { readLocal, writeLocal } from "@/lib/local";
import { setPref, usePref } from "@/lib/store";
import { phaseName, type RunStatus, type RunTask } from "@/lib/runTask";
import { dropBoxes, editsKey, merge, separateRun, setPerson, type Person, type TracksFile } from "@/lib/tracks";
import type { RosterPlayer, TrackEdits } from "@/lib/types";

// Anchors mode of the correction table: name suggested moments (anchors), have Python fill the rest (links), then go
// through its short list of doubts. The stopwatch keeps how long each action takes, to know the analyst's real time.

const DOUBTS_PER_PAGE = 4;
export const TIMING_KEY = "anchors:timing";
// Clock of the stopwatch, read only in handlers and effects.
function now() {
  return Date.now();
}

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

export type BoxPick = (chosen: { track: number; id: number }, highlighted: { track: number; id: number }[], frame: number) => boolean;

type Undo = { kind: "anchors"; anchors: Anchor[]; skipped: string[] } | { kind: "edits" };

export function AnchorsPanel({
  folder,
  matchId,
  part,
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
  onMsg,
  videoUrl = null,
}: {
  // The video of the part (for the crops of the doubt cards), or null.
  videoUrl?: string | null;
  folder: string;
  matchId: string;
  part: string;
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
  people: Pick<Person, "id" | "player_id" | "done" | "tracks">[];
  onMsg: (text: string) => void;
}) {
  const fps = data.fps;
  const [tab, setTab] = useState<"anchors" | "doubts">("anchors");
  const [example, setExample] = useState(false);
  // The fill is B (links_<part>_exp.json, fewer jumps): the recommended mode.
  const variant = "exp" as const;
  const paths = anchorPaths(folder, part, example, example ? undefined : variant);
  const [suggest, setSuggest] = useState<SuggestFile | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const skippedKey = `anchors:skipped:${folder}:${part}${example ? ":ejemplo" : ""}`;
  const skipped = usePref(skippedKey, "").split(",").filter(Boolean);
  const density = Number(usePref("anchors:density", String(DEFAULT_DENSITY))) || DEFAULT_DENSITY;
  const [chosen, setChosen] = useState<string | null>(null);
  const [links, setLinks] = useState<LinksFile | null>(null);
  const [linksState, setLinksState] = useState<"idle" | "missing" | "applied">("idle");
  const [stack, setStack] = useState<Undo[]>([]);
  const [doubtPage, setDoubtPage] = useState(0);
  const [otherFor, setOtherFor] = useState<string | null>(null);
  // Stopwatch: kept in this browser only (preferences, outside the backup); nothing is sent anywhere.
  const timingRaw = usePref(TIMING_KEY, "[]");
  const timing = useMemo(() => {
    try {
      return JSON.parse(timingRaw) as TimedAction[];
    } catch {
      return [];
    }
  }, [timingRaw]);

  // The files of the part (or of the example).
  const loadKey = `${paths.dir}|${part}|${paths.links}`;
  useEffect(() => {
    let live = true;
    void Promise.all([readLocal(paths.suggest), readLocal(paths.anchors), readLocal(paths.links)]).then(([s, a, l]) => {
      if (!live) return;
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
  const counts = useMemo(() => (suggest ? densityCounts(suggest.suggestions, fps) : []), [suggest, fps]);
  const curCount = counts.find((c) => c.density === density);
  const list = useMemo(() => (suggest ? filterByDensity(suggest.suggestions, density, fps) : []), [suggest, density, fps]);
  const queue = useMemo(() => (suggest ? pendingSuggestions(list, anchors, skipped, suggest.chains, density, fps) : []), [list, anchors, skipped, suggest, density, fps]);
  const cur: AnchorSuggestion | null = queue[0] ?? null;
  const done = list.length - queue.length;

  // When the current moment changes, the video goes there and the stopwatch starts.
  const shownAt = useRef(0);
  const curKey = tab === "anchors" && cur ? suggestionKey(cur) : null;
  useEffect(() => {
    shownAt.current = now();
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

  const record = (kind: TimedAction["kind"]) => {
    const s = (now() - shownAt.current) / 1000;
    shownAt.current = now();
    const next = [...timing, { kind, s: Math.round(s * 10) / 10, at: now(), part }];
    setPref(TIMING_KEY, JSON.stringify(next.slice(-5000)));
  };

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
    record("ancla");
    saveAnchors(setAnchor(anchors, { frame: cur.frame, track: cur.track, player }));
  };
  const skip = () => {
    if (!cur) return;
    setStack((s) => [...s.slice(-199), { kind: "anchors", anchors, skipped }]);
    record("saltar");
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
    const text = await readLocal(paths.links);
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
      `Rellenado (B): ${r.players} jugadora(s), ${r.tracks} trozo(s) con nombre nuevo${r.dropped ? `. B quitó ${r.dropped} caja(s) (${by})` : ""}${r.skipped ? `; ${r.skipped} trozo(s) de jugadoras verificadas o con nombre se dejaron como estaban` : ""}${r.conflicts.length ? `; ${r.conflicts.length} trozo(s) con dos nombres se dejaron como estaban` : ""}. Ctrl + Z lo deshace.`,
    );
  };
  // What a new run of Python rewrites, said before it runs (null: nothing to lose).
  const keptAnchors = anchors.length ? ` Las ${anchors.length} anclas hechas se conservan (anchors_${part}.json no se toca).` : "";
  const warnSuggest = () =>
    suggest || anchors.length ? `${suggest ? `Se reescribe suggest_${part}.json (${suggest.suggestions.length} sugerencias).` : ""}${keptAnchors}` : null;
  const warnFill = () =>
    links
      ? `Se reescribe links_${part}${variant ? "_exp" : ""}.json (relleno B; ${links.doubt_summary?.tasks ?? links.doubts.length} dudas por revisar; las ${(edits.anchorDoubts ?? []).length} resueltas siguen marcadas en la mesa).${keptAnchors} Al terminar se pregunta antes de tocar jugadoras verificadas o con nombre.`
      : null;

  const resolved = edits.anchorDoubts;
  const doubts = useMemo(() => sortDoubts(links?.doubts ?? [], resolved ?? []), [links, resolved]);
  const pages = Math.max(1, Math.ceil(doubts.pending.length / DOUBTS_PER_PAGE));
  const page = Math.min(doubtPage, pages - 1);
  // A doubt's time runs from the previous action (looking at it is part of the work).
  const [ask, setAsk] = useState<null | { kind: "links"; l: LinksFile; prot: ReturnType<typeof linksProtection> } | { kind: "timer" }>(null);
  const [openDoubt, setOpenDoubt] = useState<string | null>(null);
  const [viewFrame, setViewFrame] = useState(0);
  const [legend, setLegend] = useState(false);
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
    record("duda");
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

  // A click on a highlighted box of the open doubt: «this is her» (Correction calls it through pickRef).
  useEffect(() => {
    pickRef.current = (chosen, highlighted, frame) => {
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

  const mine = timing.filter((t) => t.part === part);
  const sum = timingSummary(timing);
  const fmtS = (s: number) => (Number.isFinite(s) ? `${s.toFixed(1)} s` : "—");
  const fmtTotal = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);
  const exportTiming = () =>
    downloadText(`cronometro_anclas_${matchId}.json`, JSON.stringify({ match_id: matchId, exported: new Date().toISOString(), summary: sum, actions: timing }, null, 1), "application/json");

  const shownName = (id: string) => {
    if (id === NOT_PLAYER) return "No es jugadora";
    const r = roster.find((p) => p.player_id === id);
    return r?.number != null ? `${r.number} ${id}` : id;
  };

  const header = (
    <div className="mb-2 flex items-center gap-2">
      <div className="seg flex-1" role="group" aria-label="Paso del modo anclas">
        <button type="button" className="seg-opt flex-1" aria-pressed={tab === "anchors"} onClick={() => setTab("anchors")}>
          Anclas
        </button>
        <button type="button" className="seg-opt flex-1" aria-pressed={tab === "doubts"} onClick={() => setTab("doubts")}>
          Dudas {links ? <span className="tc ml-1 text-faint">{doubts.pending.length}</span> : null}
        </button>
      </div>
      <IconButton label="Tipos de duda: qué es cada una y qué hacer" onClick={() => setLegend(true)}>
        <Question size={15} />
      </IconButton>
      <IconButton label={example ? "Volver a los archivos reales" : "Ver con datos de ejemplo (tracking/auto/ejemplo/)"} tone={example ? "accent" : "default"} onClick={() => setExample((x) => !x)}>
        <Flask size={15} />
      </IconButton>
      <IconButton label="Deshacer (Ctrl + Z)" onClick={undo}>
        <ArrowCounterClockwise size={15} />
      </IconButton>
    </div>
  );

  const exampleTag = example && (
    <p className="mb-2 rounded-lg bg-warn-900/60 px-2.5 py-1.5 text-[11px] text-warn">
      Datos de ejemplo: sugerencias, relleno y dudas inventados a partir de esta parte, no del modelo. Las anclas se guardan aparte (auto/ejemplo/).
    </p>
  );

  let body: React.ReactNode;
  if (loaded !== loadKey) body = <p className="text-xs text-faint">Leyendo la carpeta…</p>;
  else if (tab === "anchors" && !suggest)
    body = (
      <div className="space-y-2 text-xs text-ink-2">
        <p>
          No hay sugerencias de anclas para esta parte. Elige cuántas anclas por minuto quieres y genera las sugerencias (tarda unos
          segundos o minutos).
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink-2">Anclas por minuto</span>
          <div className="seg" role="group" aria-label="Anclas por minuto">
            {[1, 2, 3, 4, 5].map((d) => (
              <button key={d} type="button" className="seg-opt !px-1.5" aria-pressed={density === d} onClick={() => setPref("anchors:density", String(d))}>
                {d}
              </button>
            ))}
          </div>
        </div>
        {example ? (
          <p className="text-faint">Con datos de ejemplo no se ejecuta Python.</p>
        ) : (
          <RunControl match={matchId} part={part} task="suggest" perMin={density} label="Generar sugerencias" icon={<MagicWand size={14} />} warn={warnSuggest} onDone={reloadSuggest} />
        )}
        {!example && (
          <button type="button" className="btn btn-ghost" onClick={() => setExample(true)}>
            <Flask size={14} />
            Probar con datos de ejemplo
          </button>
        )}
      </div>
    );
  else if (tab === "anchors")
    body = (
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="tc text-ink-2">
            {done} hechas · {queue.length} por hacer
          </span>
          <div className="seg" role="group" aria-label="Anclas por minuto">
            {counts.map((c) => (
              <button
                key={c.density}
                type="button"
                className={`seg-opt !px-1.5 ${c.short ? "text-warn" : ""}`}
                aria-pressed={density === c.density}
                title={`${c.density} ancla(s) por minuto de cada trozo: ${c.n} sugerencias${c.short ? ". No hay más sitios sugeridos que en el nivel anterior: hay que pedir más a Python (--per-min)" : ""}`}
                onClick={() => setPref("anchors:density", String(c.density))}
              >
                {c.density}
                <span className="tc ml-0.5 text-[10px] opacity-70">{c.n}</span>
              </button>
            ))}
          </div>
        </div>
        {curCount?.short && (
          <p className="text-[11px] text-warn">
            A {density}/min faltan sitios: hay {curCount.n} sugerencias, las mismas que en el nivel anterior. Genera más a {density}/min:
          </p>
        )}
        {curCount?.short && !example && (
          <RunControl match={matchId} part={part} task="suggest" perMin={density} label="Generar sugerencias" icon={<MagicWand size={14} />} warn={warnSuggest} onDone={reloadSuggest} />
        )}
        <div className="h-1 overflow-hidden rounded-full bg-raised">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${list.length ? (100 * done) / list.length : 0}%` }} />
        </div>
        {cur ? (
          <>
            <p className="text-xs text-ink-2">
              <span className="tc text-ink">{fmtT(cur.frame / fps)}</span> · trozo {String(cur.chain)} · {cur.why} · {Math.round(cur.score * 100)} %. ¿Quién es la caja
              amarilla (con «?»)?
            </p>
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
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary flex-1" disabled={!chosen} onClick={() => confirm()}>
                <Check size={14} />
                Anclar <kbd className="tc opacity-70">Enter</kbd>
              </button>
              <button type="button" className="btn" title="Árbitra, banca, cuerpo técnico: se guarda como ancla «no es jugadora» y Python la deja fuera" onClick={() => confirm(NOT_PLAYER)}>
                No es jugadora <kbd className="tc text-faint">x</kbd>
              </button>
              <button type="button" className="btn" title="Solo oculta esta sugerencia aquí; no cambia el relleno" onClick={skip}>
                Saltar <kbd className="tc text-faint">n</kbd>
              </button>
            </div>
            <p className="text-[10px] text-faint">«Saltar» solo oculta la sugerencia en esta pantalla: no influye en el relleno. «No es jugadora» sí: Python deja ese trozo fuera de las jugadoras.</p>
          </>
        ) : (
          <p className="text-xs text-ok">Sin anclas pendientes a {density}/min. Sube la densidad o pasa a «Rellenar».</p>
        )}
        <div className="border-t border-line pt-2.5">
          <p className="mb-1.5 text-xs text-ink-2">Con las anclas puestas, Python rellena el resto de la parte y deja una lista de dudas.</p>
          {example ? (
            <p className="text-[11px] text-faint">Con datos de ejemplo no se ejecuta Python: carga el relleno de ejemplo.</p>
          ) : (
            <RunControl match={matchId} part={part} task="fill" variant={variant} label="Rellenar" icon={<Lightning size={14} />} warn={warnFill} onDone={reloadLinks} />
          )}
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className="btn btn-ghost !px-2 text-xs" title="Volver a leer links_ de la carpeta y aplicarlo a la mesa" onClick={() => void reloadLinks()}>
              <ArrowClockwise size={13} />
              Volver a cargar el relleno
            </button>
            <span className="text-[11px] text-faint">
              {linksState === "missing" ? "Aún no existe " + paths.links.split("/").pop() : linksState === "applied" ? "Aplicado a la mesa (Ctrl + Z lo deshace)" : ""}
            </span>
          </div>
        </div>
      </div>
    );
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
      {ask?.kind === "timer" && (
        <Modal title="¿Reiniciar el cronómetro?" onClose={() => setAsk(null)}>
          <p className="text-sm text-ink-2">
            Se borran las {timing.length} acciones medidas ({fmtTotal(sum.total_s)}) de todas las partes. No se puede deshacer: si las quieres, expórtalas antes.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn" onClick={exportTiming}>
              <DownloadSimple size={14} /> Exportar
            </button>
            <button type="button" className="btn btn-primary" autoFocus onClick={() => setAsk(null)}>
              Cancelar
            </button>
            <button type="button" className="btn text-danger" onClick={() => (setPref(TIMING_KEY, "[]"), setAsk(null))}>
              Reiniciar
            </button>
          </div>
        </Modal>
      )}
      {legend && (
        <Modal title="Tipos de duda" onClose={() => setLegend(false)}>
          <ul className="space-y-2 text-sm">
            {DOUBT_TYPES.map((t) => (
              <li key={t.kind}>
                <span className="font-bold text-ink">{t.name}</span> <span className={`tag ${t.task ? "" : "opacity-70"}`}>{t.task ? "tarea" : "informativa"}</span>
                <p className="text-xs text-ink-2">{t.what}</p>
                <p className="text-xs text-ink">{t.todo}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">
            Teclas en una duda: <kbd className="kbd">1</kbd>/<kbd className="kbd">A</kbd> y <kbd className="kbd">2</kbd>/<kbd className="kbd">B</kbd> eligen caja, <kbd className="kbd">0</kbd> ninguna,{" "}
            <kbd className="kbd">Enter</kbd> está bien, <kbd className="kbd">D</kbd> es otra, <kbd className="kbd">S</kbd> cortar, <kbd className="kbd">←</kbd>/<kbd className="kbd">→</kbd> cuadros, <kbd className="kbd">Tab</kbd> siguiente. En anclas: <kbd className="kbd">x</kbd> no es jugadora, <kbd className="kbd">n</kbd> saltar (solo la oculta aquí, no influye en el relleno).
          </p>
        </Modal>
      )}
      {header}
      {exampleTag}
      {body}
      {!example && (
        <div className="mt-2">
          <ResetPart folder={folder} part={part} editsKey={editsKey(data)} onMsg={onMsg} />
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-2 text-[11px] text-faint">
        <Timer size={13} />
        <span className="tc flex-1" title={`Todas las partes: ${sum.n} acciones. Una pausa de más de ${sum.cap_s} s cuenta como ${sum.cap_s} s.`}>
          {mine.length} acc. aquí · total {fmtTotal(sum.total_s)} · ancla {fmtS(sum.per.ancla.median_s)} · duda {fmtS(sum.per.duda.median_s)}
        </span>
        <IconButton label="Exportar el cronómetro a JSON" onClick={exportTiming}>
          <DownloadSimple size={13} />
        </IconButton>
        <IconButton label="Reiniciar el cronómetro" onClick={() => setAsk({ kind: "timer" })}>
          <X size={13} />
        </IconButton>
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
    const r = await fetch("/api/run/anchors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, match, part, perMin, variant }) }).catch(() => null);
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
