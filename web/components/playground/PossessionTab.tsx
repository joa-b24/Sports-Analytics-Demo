"use client";

import { ArrowCounterClockwise, FloppyDisk, ListChecks, Warning } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { Card } from "@/components/Shell";
import { Locked } from "@/components/Locked";
import { readLocal, writeLocal, writeLocalInfo } from "@/lib/local";
import {
  NO_FILTER, ballEnds, emptyReview, filterRows, parseReview, reviewOf, reviewPath, reviewSample, reviewStats, rowId, sceneAt, setVerdict, type RowFilter, type Verdict,
} from "@/lib/playgroundPossession";
import { POSSESSION_DEFAULTS, possessionCsv, possessionPath, summarizePossession, type PossessionParams, type PossessionRow, type Suspect } from "@/lib/possession";
import { useStore } from "@/lib/store";
import type { PlaygroundCtx } from "./context";
import { PossessionScene } from "./PossessionScene";
import { PossessionSummaryCard } from "./PossessionSummary";
import { PossessionSuspects } from "./PossessionSuspects";
import { PossessionTable } from "./PossessionTable";
import { Split, resetSplits } from "./Split";

const SPLIT_KEYS = ["playground:pos:rows", "playground:pos:top", "playground:pos:cols"];

const SAMPLE_N = 30;
type SaveState = { state: "idle" | "saving" | "saved" | "error"; text?: string };

// Playground > Posesión: the possession table (lib/possession.ts) with its parameters in the open, so that the analyst can
// see it, check intervals one by one against the video and decide whether to trust it before it feeds the report.
// The parameters are the match's (Configuración del partido > Detalles técnicos): here they are only read.
export function PossessionTab({ ctx }: { ctx: PlaygroundCtx }) {
  const { match, folder, videos, videoIds, fixed, segmentsByVideo, params, result } = ctx;
  const state = useStore();
  const [videoId, setVideoId] = useState(videos[0].video_id);
  const video = videos.find((v) => v.video_id === videoId) ?? videos[0];
  const rows = useMemo(() => (result?.rows ?? []).filter((r) => r.video_id === video.video_id), [result, video.video_id]);
  const summary = useMemo(() => (result ? summarizePossession(result.samples.filter((s) => s.video_id === video.video_id)) : null), [result, video.video_id]);

  // ---- filters, sample and selection
  const [filter, setFilter] = useState<RowFilter>(NO_FILTER);
  const [sample, setSample] = useState<string[] | null>(null);
  const [sampleOnly, setSampleOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = useMemo(() => {
    const f = filterRows(rows, filter);
    return sampleOnly && sample ? f.filter((r) => sample.includes(rowId(r))) : f;
  }, [rows, filter, sampleOnly, sample]);
  const row = rows.find((r) => rowId(r) === selected) ?? null;
  const scene = useMemo(() => (result && fixed && row ? sceneAt(result, fixed.parts, row) : null), [result, fixed, row]);
  const { show, panel } = useMomentPlayer(match, { bare: true });
  const ends = useMemo(() => (fixed && row ? ballEnds(fixed.parts, row) : null), [fixed, row]);
  const [dialog, setDialog] = useState<"table" | "suspects" | null>(null);
  const pick = (r: PossessionRow) => {
    setSelected(rowId(r));
    show({ video_id: r.video_id, t: r.t_start, t_end: r.t_end, label: `Posesión: ${r.team === "own" ? "nuestro equipo" : r.team === "opp" ? "rival" : "sin dueño"}, ${r.kind}` });
  };

  // ---- verdicts of the video, in matches/<id>/possession_review_<video>.json
  const [review, setReview] = useState(() => emptyReview(video.video_id));
  const [loaded, setLoaded] = useState(false);
  const [rsave, setRsave] = useState<SaveState>({ state: "idle" });
  const dirty = useRef(false);
  useEffect(() => {
    if (!folder) return;
    let live = true;
    dirty.current = false;
    void readLocal(reviewPath(folder, video.video_id)).then((t) => {
      if (!live) return;
      setReview(parseReview(t, video.video_id));
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
      void writeLocalInfo(reviewPath(folder, video.video_id), JSON.stringify(review, null, 1)).then((r) => {
        dirty.current = false;
        setRsave(r.ok ? { state: "saved", text: "Revisiones guardadas." } : { state: "error", text: r.error });
        if (r.ok) ctx.notifyReview();
      });
    }, 400);
    return () => window.clearTimeout(id);
  }, [review, loaded, folder, video.video_id]); // eslint-disable-line react-hooks/exhaustive-deps -- ctx.notifyReview is stable enough: it only bumps a counter
  const reviewMap = useMemo(() => new Map(review.reviews.map((r) => [r.id, r])), [review]);
  const mark = (v: Verdict | null, note: string) => {
    if (!row) return;
    dirty.current = true;
    setRsave({ state: "saving" });
    setReview((f) => setVerdict(f, row, v, note, params));
  };
  const stats = reviewStats(review.reviews, rows);
  const sampleDone = sample ? sample.filter((id) => reviewMap.has(id)).length : 0;
  const draw = () => {
    const s = reviewSample(rows, SAMPLE_N, new Set(review.reviews.map((r) => r.id))).map(rowId);
    setSample(s);
    setSampleOnly(true);
    const first = rows.find((r) => rowId(r) === s[0]);
    if (first) pick(first);
  };
  const nextOfSample = () => {
    const next = rows.find((r) => sample?.includes(rowId(r)) && !reviewMap.has(rowId(r)));
    if (next) pick(next);
  };

  // ---- a suspect box: the interval where it decides, or at least its moment on the video
  const view = (s: Suspect) => {
    const r = rows.find((x) => x.video_id === s.video_id && x.t_start <= s.t + 1e-6 && x.t_end > s.t);
    if (s.video_id !== video.video_id) setVideoId(s.video_id);
    setFilter(NO_FILTER);
    setSampleOnly(false);
    if (r) pick(r);
    else show({ video_id: s.video_id, t: s.t, label: `Caja sospechosa: ${s.name ?? `#${s.person_id}`}` });
  };

  // ---- save the table, one CSV per video
  const [tsave, setTsave] = useState<SaveState>({ state: "idle" });
  const saveTable = async () => {
    if (!folder || !result) return;
    setTsave({ state: "saving" });
    const done: string[] = [];
    for (const v of videoIds) {
      const mine = result.rows.filter((r) => r.video_id === v);
      if (mine.length === 0) continue;
      if (!(await writeLocal(possessionPath(folder, v), possessionCsv(result.rows, v)))) {
        setTsave({ state: "error", text: `No se pudo escribir possession_${v}.csv (la app debe correr en esta computadora).` });
        return;
      }
      done.push(`possession_${v}.csv (${mine.length} intervalos)`);
    }
    setTsave(done.length ? { state: "saved", text: `Guardado ${new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}: ${done.join(", ")} con ${Object.entries(params).filter(([k, v]) => v !== POSSESSION_DEFAULTS[k as keyof PossessionParams]).map(([k, v]) => `${k}=${v}`).join(", ") || "los parámetros por defecto"}.` } : { state: "error", text: "No hay intervalos que guardar." });
  };

  if (!folder) return null;
  if (!fixed) return <p className="text-sm text-faint">Leyendo las posiciones del partido…</p>;
  if (!result || !summary) {
    return (
      <Locked
        reason="tracking"
        title="Posesión"
        why={`${match.name} no tiene partes con posiciones (tracks_fixed o procesadas) en su carpeta${fixed.unoriented.length ? `; ${fixed.unoriented.length} partes no se pudieron orientar` : ""}.`}
        need="Procesa el video en Tracking y revisa el balón; después la posesión se calcula aquí."
      />
    );
  }
  const inferred = fixed.parts.filter((p) => p.dir === "inferred").length;
  const table = (full: boolean) => (
    <PossessionTable
      rows={shown}
      total={rows.length}
      filter={filter}
      onFilter={setFilter}
      selected={selected}
      onSelect={(r) => {
        pick(r);
        setDialog(null);
      }}
      reviews={reviewMap}
      sampleOnly={sampleOnly}
      onSampleOnly={setSampleOnly}
      hasSample={!!sample}
      full={full}
      onFull={() => setDialog("table")}
    />
  );
  return (
    <div className="flex flex-col gap-2" style={{ height: "calc(100dvh - 24rem)", minHeight: 520 }}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        {videos.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Video
            <select className="input" value={video.video_id} onChange={(e) => setVideoId(e.target.value)}>
              {videos.map((v) => (
                <option key={v.video_id} value={v.video_id}>
                  {v.label ?? v.video_id}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn btn-primary" disabled={tsave.state === "saving"} onClick={() => void saveTable()}>
          <FloppyDisk size={14} />
          Guardar tabla
        </button>
        <button type="button" className="btn" onClick={() => setDialog("suspects")}>
          <Warning size={14} />
          Cajas sospechosas
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => resetSplits(SPLIT_KEYS)} title="Devuelve los paneles a su reparto original">
          <ArrowCounterClockwise size={14} />
          Restablecer tamaños
        </button>
        <span className={`text-xs ${tsave.state === "error" ? "text-danger" : "text-faint"}`} aria-live="polite">
          {tsave.state === "saving" ? "Guardando…" : tsave.text}
        </span>
        <span className="text-xs text-faint">
          {fixed.parts.length} partes
          {inferred > 0 ? `; en ${inferred} la dirección de ataque se infirió` : ""}
          {fixed.unoriented.length > 0 ? `; ${fixed.unoriented.length} sin orientar quedan fuera` : ""}. Los intervalos con balón interpolado llevan su bandera.
        </span>
      </div>
      <Split dir="col" prefKey={SPLIT_KEYS[0]} fallback={[0.24, 0.76]} className="min-h-0 flex-1">
        {[
          <div key="s" className="h-full overflow-auto">
            <PossessionSummaryCard summary={summary} videoLabel={video.label ?? video.video_id} />
          </div>,
          <Split key="body" prefKey={SPLIT_KEYS[2]} fallback={[0.4, 0.32, 0.28]} className="h-full">
            {[
              <div key="t" className="flex h-full flex-col gap-2">
                <div className="min-h-0 flex-1">{table(false)}</div>
                <div className="card shrink-0 !p-3 text-xs" aria-live="polite">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn" onClick={draw} disabled={rows.length === 0}>
                      <ListChecks size={14} />
                      Muestra de {SAMPLE_N}
                    </button>
                    {sample && (
                      <button type="button" className="btn" onClick={nextOfSample} disabled={sampleDone >= sample.length}>
                        Siguiente sin revisar
                      </button>
                    )}
                    {sample && (
                      <span className="text-faint">
                        {sampleDone} de {sample.length} revisados
                      </span>
                    )}
                    <span className="text-faint">{rsave.state === "saving" ? "Guardando…" : rsave.state === "error" ? `No se guardó: ${rsave.text}` : rsave.text}</span>
                  </div>
                  <p className="mt-2 text-ink">
                    {stats.accuracy === null
                      ? "Aún no marcas ningún intervalo."
                      : `Acierto sobre lo revisado: ${stats.correct} de ${stats.reviewed} (${Math.round(100 * stats.accuracy)} %), no del partido.`}
                    {stats.reviewed > 0 && stats.current < stats.reviewed ? ` ${stats.reviewed - stats.current} revisiones son de intervalos que ya no existen con estos parámetros.` : ""}
                  </p>
                </div>
              </div>,
              <PossessionScene key="c" row={row} scene={scene} ends={ends} review={row ? reviewOf(review, row) : null} onVerdict={mark} />,
              <Card key="v" title="Video" className="h-full overflow-auto">
                {panel ?? <p className="text-sm text-faint">Elige un intervalo: aquí se reproduce, con la opción de repetirlo en bucle.</p>}
              </Card>,
            ]}
          </Split>,
        ]}
      </Split>
      {dialog === "table" && (
        <Modal title="Tabla completa de intervalos" size="full" onClose={() => setDialog(null)}>
          {table(true)}
        </Modal>
      )}
      {dialog === "suspects" && (
        <Modal title="Cajas sospechosas" wide onClose={() => setDialog(null)}>
          <PossessionSuspects
            parts={fixed.parts}
            segmentsByVideo={segmentsByVideo}
            params={params}
            folder={folder}
            trackEdits={state.trackEdits}
            matchId={match.match_id}
            onView={(x) => {
              setDialog(null);
              view(x);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
