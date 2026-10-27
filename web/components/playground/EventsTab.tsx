"use client";

import { ArrowCounterClockwise, FloppyDisk } from "@phosphor-icons/react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { Card } from "@/components/Shell";
import { Locked } from "@/components/Locked";
import { detectEvents, type DetectedEvent, type DetectedType, type EventParams } from "@/lib/eventDetect";
import {
  NO_EVENT_FILTER, TYPE_LABEL, allTypeStats, ballCoverage, emptyEventReview, eventMoment, eventSample, eventsAutoFile, eventsAutoPath, eventReviewPath, filterEvents, isReviewed, parseEventReview,
  sceneOfEvent, setEventVerdict, type EventFilter, type EventVerdict,
} from "@/lib/eventReview";
import { useFixedParts } from "@/lib/fixed";
import { readLocal, writeLocal, writeLocalInfo } from "@/lib/local";
import { parseReview, reviewPath, reviewStats } from "@/lib/playgroundPossession";
import { possessionIntervals } from "@/lib/possession";
import { autoEventsOf, eventParamsOf, possessionParamsOf } from "@/lib/tech";
import { trackingParamsOf } from "@/lib/techTracking";
import { segmentsFromMarks, type Segment } from "@/lib/segments";
import { useStore } from "@/lib/store";
import type { Match } from "@/lib/types";
import { matchVideos, videoOf } from "@/lib/videos";
import { MissedDialog, WindowsDialog } from "./EventsDialogs";
import { EventsList } from "./EventsList";
import { EventsParamsCard } from "./EventsParams";
import { EventsScene } from "./EventsScene";
import { CoverageDetail, EventsStatsCard, PrerequisitesBar } from "./EventsStats";
import { Split, resetSplits } from "./Split";

const SPLIT_KEYS = ["playground:ev:cols", "playground:ev:a", "playground:ev:c"];
type SaveState = { state: "idle" | "saving" | "saved" | "error"; text?: string };

// Playground > Eventos: the events detected from positions (lib/eventDetect.ts) with the rule of each type in the open, to be
// checked one by one against the video. The only truth is the analyst's review; nothing here reads the events tagged by hand.
export function EventsTab({ match, folder }: { match: Match; folder: string | undefined }) {
  const state = useStore();
  const videos = useMemo(() => matchVideos(match), [match]);
  const videoIds = useMemo(() => videos.map((v) => v.video_id), [videos]);
  const [videoId, setVideoId] = useState(videos[0].video_id);
  const video = videos.find((v) => v.video_id === videoId) ?? videos[0];
  const fixed = useFixedParts(folder, videoIds);
  // The rules are the match's (lib/tech.ts, Detalles técnicos): read only here.
  const params = useMemo<EventParams>(() => eventParamsOf(match), [match]);
  const deferred = useDeferredValue(params);
  const [type, setType] = useState<DetectedType>("throw_in");
  const segmentsByVideo = useMemo<Record<string, Segment[]>>(
    () => Object.fromEntries(videos.map((v) => [v.video_id, segmentsFromMarks(state.segments.filter((g) => g.match_id === match.match_id && videoOf(g) === v.video_id))])),
    [videos, state.segments, match.match_id],
  );
  const parts = useMemo(() => (fixed ? fixed.parts.filter((p) => p.file.video_id === video.video_id) : []), [fixed, video.video_id]);
  const possession = useMemo(() => (parts.length > 0 ? possessionIntervals(parts, segmentsByVideo, possessionParamsOf(match), undefined, trackingParamsOf(match).ballJumpMs) : null), [parts, segmentsByVideo, match]);
  const dets = useMemo(() => (possession ? detectEvents(parts, segmentsByVideo, possession.rows, deferred) : []), [possession, parts, segmentsByVideo, deferred]);
  const cover = useMemo(() => ballCoverage(parts, segmentsByVideo), [parts, segmentsByVideo]);

  // ---- verdicts of the video, in matches/<id>/events_review_<video>.json
  const [review, setReview] = useState(() => emptyEventReview(video.video_id));
  const [loaded, setLoaded] = useState(false);
  const [rsave, setRsave] = useState<SaveState>({ state: "idle" });
  const dirty = useRef(false);
  useEffect(() => {
    if (!folder) return;
    let live = true;
    dirty.current = false;
    void readLocal(eventReviewPath(folder, video.video_id)).then((t) => {
      if (!live) return;
      setReview(parseEventReview(t, video.video_id));
      setLoaded(true);
      setRsave({ state: t ? "saved" : "idle" });
    });
    return () => {
      live = false;
      setLoaded(false);
    };
  }, [folder, video.video_id]);
  useEffect(() => {
    if (!folder || !loaded || !dirty.current) return;
    const id = window.setTimeout(() => {
      void writeLocalInfo(eventReviewPath(folder, video.video_id), JSON.stringify(review, null, 1)).then((r) => {
        dirty.current = false;
        setRsave(r.ok ? { state: "saved", text: "Revisiones guardadas." } : { state: "error", text: r.error });
      });
    }, 400);
    return () => window.clearTimeout(id);
  }, [review, loaded, folder, video.video_id]);
  const update = (f: (r: typeof review) => typeof review) => {
    dirty.current = true;
    setRsave({ state: "saving" });
    setReview(f);
  };

  // ---- the possession review of the same video (a prerequisite: what the losses and entries rest on)
  const [possReview, setPossReview] = useState<{ reviewed: number; accuracy: number | null } | null>(null);
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void readLocal(reviewPath(folder, video.video_id)).then((t) => {
      if (live) setPossReview(t ? (({ reviewed, accuracy }) => ({ reviewed, accuracy }))(reviewStats(parseReview(t, video.video_id).reviews, [])) : { reviewed: 0, accuracy: null });
    });
    return () => {
      live = false;
    };
  }, [folder, video.video_id]);

  // ---- list, filters, sample and selection
  const [filter, setFilter] = useState<EventFilter>(NO_EVENT_FILTER);
  const [sample, setSample] = useState<string[] | null>(null);
  const [sampleOnly, setSampleOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const mine = useMemo(() => dets.filter((e) => e.type === type), [dets, type]);
  const shown = useMemo(() => {
    const f = filterEvents(mine, filter, review);
    return sampleOnly && sample ? f.filter((e) => sample.includes(e.id)) : f;
  }, [mine, filter, review, sampleOnly, sample]);
  const ev = dets.find((e) => e.id === selected) ?? null;
  const scene = useMemo(() => (ev ? sceneOfEvent(parts, ev) : null), [ev, parts]);
  const { show, panel } = useMomentPlayer(match, { bare: true });
  const pick = (e: DetectedEvent) => {
    setSelected(e.id);
    const m = eventMoment(e);
    show({ video_id: e.video_id, t: m.t, t_end: m.t_end, label: `${TYPE_LABEL[e.type]}: ${e.team === "own" ? "nuestro equipo" : e.team === "opp" ? "rival" : "sin equipo"}` });
  };
  const pickType = (t: DetectedType) => {
    setType(t);
    setFilter(NO_EVENT_FILTER);
    setSampleOnly(false);
  };
  const mark = (v: EventVerdict | null, note: string) => {
    if (!ev) return;
    update((r) => setEventVerdict(r, ev, v, note));
  };
  const draw = () => {
    const s = eventSample(dets, review);
    setSample(s.map((e) => e.id));
    setSampleOnly(true);
    if (s[0]) {
      setType(s[0].type);
      pick(s[0]);
    }
  };
  const nextOfSample = () => {
    const next = dets.find((e) => sample?.includes(e.id) && !isReviewed(review, e));
    if (next) {
      setType(next.type);
      pick(next);
    }
  };

  // ---- save the detections of the video
  const [dsave, setDsave] = useState<SaveState>({ state: "idle" });
  const saveDets = async () => {
    if (!folder) return;
    setDsave({ state: "saving" });
    const ok = await writeLocal(eventsAutoPath(folder, video.video_id), JSON.stringify(eventsAutoFile(video.video_id, dets), null, 1));
    setDsave(ok ? { state: "saved", text: `Guardado ${new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}: events_auto_${video.video_id}.json (${dets.length} detecciones).` } : { state: "error", text: "No se pudo escribir (la app debe correr en esta computadora)." });
  };
  const [dialog, setDialog] = useState<"missed" | "windows" | "cover" | null>(null);

  if (!folder) return null;
  if (!fixed) return <p className="text-sm text-faint">Leyendo las posiciones del partido…</p>;
  if (!possession) {
    return (
      <Locked
        reason="tracking"
        title="Eventos"
        why={`${match.name} no tiene partes con posiciones en la carpeta de este video${fixed.unoriented.length ? `; ${fixed.unoriented.length} partes no se pudieron orientar` : ""}.`}
        need="Procesa el video en Tracking y revisa el balón; después los eventos se detectan aquí."
      />
    );
  }
  const stats = allTypeStats(dets, review);
  const autoEvents = autoEventsOf(match);
  const busy = deferred !== params;
  const inferred = parts.filter((p) => p.dir === "inferred").length;
  const atT = ev?.t_video ?? null;
  return (
    <div className="flex flex-col gap-2" style={{ height: "max(46rem, calc(100dvh - 5rem))" }}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        {videos.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Video
            <select className="input" value={video.video_id} onChange={(e) => { setVideoId(e.target.value); setSelected(null); setSample(null); setSampleOnly(false); }}>
              {videos.map((v) => (
                <option key={v.video_id} value={v.video_id}>
                  {v.label ?? v.video_id}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn btn-primary" disabled={dsave.state === "saving" || dets.length === 0} onClick={() => void saveDets()}>
          <FloppyDisk size={14} />
          Guardar detecciones
        </button>
        <label className="flex items-center gap-2 text-xs text-muted" title="Revisiones por tipo antes de dar un veredicto">
          Mínimo por tipo
          <input
            type="number"
            min={1}
            max={500}
            className="input tc w-16 !py-1"
            aria-label="Mínimo de revisiones por tipo"
            value={review.min_reviews}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1) update((r) => ({ ...r, min_reviews: Math.min(500, n) }));
            }}
          />
        </label>
        <button type="button" className="btn btn-ghost" onClick={() => resetSplits(SPLIT_KEYS)} title="Devuelve los paneles a su reparto original">
          <ArrowCounterClockwise size={14} />
          Restablecer tamaños
        </button>
        <span className={`text-xs ${dsave.state === "error" || rsave.state === "error" ? "text-danger" : "text-faint"}`} aria-live="polite">
          {rsave.state === "error" ? `No se guardaron las revisiones: ${rsave.text}` : dsave.state === "saving" || rsave.state === "saving" ? "Guardando…" : (dsave.text ?? rsave.text)}
        </span>
        <span className="text-xs text-faint">
          {parts.length} partes{inferred > 0 ? `; en ${inferred} la dirección de ataque se infirió` : ""}. Los segmentos de juego se unen para detectar.
        </span>
      </div>
      <PrerequisitesBar cover={cover} possession={{ reviewed: possReview?.reviewed ?? 0, accuracy: possReview?.accuracy ?? null, intervals: possession.rows.filter((r) => r.kind === "control").length }} onDetail={() => setDialog("cover")} />
      <Split dir="row" prefKey={SPLIT_KEYS[0]} fallback={[0.29, 0.4, 0.31]} className="min-h-0 flex-1">
        {[
          <Split key="a" dir="col" prefKey={SPLIT_KEYS[1]} fallback={[0.56, 0.44]} className="h-full">
            {[
              <EventsStatsCard key="s" stats={stats} active={type} onPick={pickType} minReviews={review.min_reviews} auto={autoEvents} />,
              <EventsParamsCard key="p" type={type} params={params} matchId={match.match_id} busy={busy} />,
            ]}
          </Split>,
          <EventsList
            key="l"
            title={TYPE_LABEL[type]}
            auto={autoEvents.includes(type)}
            events={shown}
            total={mine.length}
            filter={filter}
            onFilter={setFilter}
            selected={selected}
            onSelect={pick}
            review={review}
            sampleOnly={sampleOnly}
            onSampleOnly={setSampleOnly}
            hasSample={!!sample}
            onSample={draw}
            onNext={nextOfSample}
            onMissed={() => setDialog("missed")}
            onWindows={() => setDialog("windows")}
          />,
          <Split key="c" dir="col" prefKey={SPLIT_KEYS[2]} fallback={[0.6, 0.4]} className="h-full">
            {[
              <EventsScene
                key="e"
                ev={ev}
                scene={scene}
                review={ev ? (review.reviews.find((r) => r.id === ev.id) ?? null) : null}
                stale={!!ev && !!review.reviews.find((r) => r.id === ev.id) && !isReviewed(review, ev)}
                onVerdict={mark}
              />,
              <Card key="v" title="Video" className="h-full !p-3">
                {panel ?? <p className="text-sm text-faint">Elige una detección: aquí se reproduce, con la opción de repetirla en bucle.</p>}
              </Card>,
            ]}
          </Split>,
        ]}
      </Split>
      {dialog === "missed" && <MissedDialog review={review} type={type} atT={atT} onUpdate={update} onClose={() => setDialog(null)} />}
      {dialog === "windows" && <WindowsDialog review={review} atT={atT} onUpdate={update} onClose={() => setDialog(null)} />}
      {dialog === "cover" && (
        <Modal title="Cobertura del balón por parte" wide onClose={() => setDialog(null)}>
          <CoverageDetail cover={cover} />
        </Modal>
      )}
    </div>
  );
}
