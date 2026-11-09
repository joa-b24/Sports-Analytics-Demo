"use client";

import { CheckCircle, FloppyDisk, ListChecks, XCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Locked } from "@/components/Locked";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { Pager, usePaged } from "@/components/Paged";
import { Card } from "@/components/Shell";
import { fmtT } from "@/lib/format";
import { readLocal, writeLocalInfo } from "@/lib/local";
import {
  NO_PASS_FILTER, emptyPassReview, filterPasses, isPassFiltered, parsePassReview, passCounts, passItems, passReviewOf, passReviewPath, passReviewStats, passSample, passScene, setPassVerdict,
  type PassFilter, type PassItem,
} from "@/lib/playgroundPasses";
import { fmtTd, type Verdict } from "@/lib/playgroundPossession";
import { PASS_SOURCE_LABEL } from "@/lib/passSources";
import { useStore } from "@/lib/store";
import type { PlaygroundCtx } from "./context";
import { SceneView } from "./PossessionScene";
import { Split, resetSplits } from "./Split";

const SPLIT_KEYS = ["playground:pass:cols"];
const SAMPLE_N = 30;
const ROW_H = 36;
const COLS = "grid-cols-[4.2rem_3rem_5.5rem_1fr_5.5rem_1.2rem]";
type SaveState = { state: "idle" | "saving" | "saved" | "error"; text?: string };

const name = (n: string | null, id: number | null) => (n ? n : id === null ? "—" : `#${id}`);
const sideLabel = (t: PassItem["team"], ctx: PlaygroundCtx) => (t === "own" ? ctx.match.focus_team : ctx.match.other_team);

// Playground > Pases: the passes read from the tracking (ball + players, what the report counts), one by one against the
// video, like the possession check. The ones tagged by hand are counted apart and never added to these.
export function PassesTab({ ctx }: { ctx: PlaygroundCtx }) {
  const { match, folder, videos, fixed, segmentsByVideo } = ctx;
  const state = useStore();
  const [videoId, setVideoId] = useState(videos[0].video_id);
  const video = videos.find((v) => v.video_id === videoId) ?? videos[0];
  const parts = useMemo(() => fixed?.parts ?? [], [fixed]);
  const all = useMemo(() => passItems(parts, segmentsByVideo), [parts, segmentsByVideo]);
  const items = useMemo(() => all.filter((p) => p.video_id === video.video_id), [all, video.video_id]);
  const handCount = useMemo(() => (state.passes ?? []).filter((p) => p.match_id === match.match_id).length, [state.passes, match.match_id]);

  // ---- filters, sample and selection
  const [filter, setFilter] = useState<PassFilter>(NO_PASS_FILTER);
  const [sample, setSample] = useState<string[] | null>(null);
  const [sampleOnly, setSampleOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // ---- verdicts of the video, in matches/<id>/passes_review_<video>.json
  const [review, setReview] = useState(() => emptyPassReview(video.video_id));
  const [loaded, setLoaded] = useState(false);
  const [rsave, setRsave] = useState<SaveState>({ state: "idle" });
  const dirty = useRef(false);
  useEffect(() => {
    let live = true;
    dirty.current = false;
    void readLocal(passReviewPath(folder, video.video_id)).then((t) => {
      if (!live) return;
      setReview(parsePassReview(t, video.video_id));
      setLoaded(true);
      setRsave({ state: t ? "saved" : "idle" });
    });
    return () => {
      live = false;
      setLoaded(false);
    };
  }, [folder, video.video_id]);
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const id = window.setTimeout(() => {
      void writeLocalInfo(passReviewPath(folder, video.video_id), JSON.stringify(review, null, 1)).then((r) => {
        dirty.current = false;
        setRsave(r.ok ? { state: "saved", text: "Revisiones guardadas." } : { state: "error", text: r.error });
        if (r.ok) ctx.notifyReview();
      });
    }, 400);
    return () => window.clearTimeout(id);
  }, [review, loaded, folder, video.video_id]); // eslint-disable-line react-hooks/exhaustive-deps -- ctx.notifyReview only bumps a counter
  const reviewMap = useMemo(() => new Map(review.reviews.map((r) => [r.id, r])), [review]);
  const reviewedIds = useMemo(() => new Set(reviewMap.keys()), [reviewMap]);

  const shown = useMemo(() => {
    const f = filterPasses(items, filter, reviewedIds);
    return sampleOnly && sample ? f.filter((p) => sample.includes(p.id)) : f;
  }, [items, filter, reviewedIds, sampleOnly, sample]);
  const row = items.find((p) => p.id === selected) ?? null;
  const scene = useMemo(() => (row ? passScene(parts, row) : null), [parts, row]);
  const { show, panel } = useMomentPlayer(match, { bare: true });
  const pick = (p: PassItem) => {
    setSelected(p.id);
    show({ video_id: p.video_id, t: p.t_start, t_end: p.t_end, label: `Pase ${p.completed ? "completado" : "cortado"}: ${sideLabel(p.team, ctx)}` });
  };
  const mark = (v: Verdict | null, note: string) => {
    if (!row) return;
    dirty.current = true;
    setRsave({ state: "saving" });
    setReview((f) => setPassVerdict(f, row, v, note));
  };
  const stats = passReviewStats(review.reviews, items);
  const sampleDone = sample ? sample.filter((id) => reviewMap.has(id)).length : 0;
  const draw = () => {
    const s = passSample(items, SAMPLE_N, reviewedIds).map((p) => p.id);
    setSample(s);
    setSampleOnly(true);
    const first = items.find((p) => p.id === s[0]);
    if (first) pick(first);
  };
  const nextOfSample = () => {
    const next = items.find((p) => sample?.includes(p.id) && !reviewMap.has(p.id));
    if (next) pick(next);
  };

  const idx = selected ? shown.findIndex((p) => p.id === selected) : -1;
  const { boxRef, rows: page, page: pg, pages, setPage } = usePaged(shown, ROW_H, idx >= 0 ? idx : null);
  const [draft, setDraft] = useState<{ id: string; note: string } | null>(null);

  if (!fixed) return <p className="text-sm text-faint">Leyendo las posiciones del partido…</p>;
  if (all.length === 0) {
    return (
      <div className="space-y-3">
        <Locked
          reason="tracking"
          title="Pases del tracking"
          why={`${match.name} no tiene pases leídos del tracking: hacen falta partes con posiciones y el balón seguido (a mano, del tracker o de eventos).`}
          need="Procesa el video en Tracking y revisa el balón; los pases se leen de ahí."
        />
        <HandNote count={handCount} />
      </div>
    );
  }
  const note = draft?.id === row?.id ? draft?.note : (row ? (passReviewOf(review, row)?.note ?? "") : "");
  const rv = row ? passReviewOf(review, row) : null;
  const counts = { own: passCounts(items, "own"), opp: passCounts(items, "opp") };
  return (
    <div className="flex flex-col gap-2" style={{ height: "calc(100dvh - 24rem)", minHeight: 520 }}>
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
        <span className="text-xs text-muted">
          {PASS_SOURCE_LABEL.tracking}, este video:{" "}
          {(["own", "opp"] as const).map((t) => `${sideLabel(t, ctx)} ${counts[t].completed} completados y ${counts[t].cut} cortados${counts[t].approx > 0 ? ` (${counts[t].approx} aprox.)` : ""}`).join(" · ")}
        </span>
        <button type="button" className="btn btn-ghost" onClick={() => resetSplits(SPLIT_KEYS)} title="Devuelve los paneles a su reparto original">
          Restablecer tamaños
        </button>
        <HandNote count={handCount} inline />
      </div>
      <Split prefKey={SPLIT_KEYS[0]} fallback={[0.42, 0.3, 0.28]} className="min-h-0 flex-1">
        {[
          <div key="t" className="flex h-full flex-col gap-2">
            <Card title="Pases" note={`${shown.length} de ${items.length}`} className="flex min-h-0 flex-1 flex-col !p-3">
              <div className="mb-2 flex flex-wrap items-end gap-x-2 gap-y-1 text-[11px] text-muted">
                <label>
                  Equipo
                  <select className="input mt-0.5 block !py-1 text-xs" value={filter.team} onChange={(e) => setFilter({ ...filter, team: e.target.value as PassFilter["team"] })}>
                    <option value="all">Todos</option>
                    <option value="own">{match.focus_team}</option>
                    <option value="opp">{match.other_team}</option>
                  </select>
                </label>
                <label>
                  Resultado
                  <select className="input mt-0.5 block !py-1 text-xs" value={filter.result} onChange={(e) => setFilter({ ...filter, result: e.target.value as PassFilter["result"] })}>
                    <option value="all">Todos</option>
                    <option value="completed">Completados</option>
                    <option value="cut">Cortados</option>
                  </select>
                </label>
                <label>
                  Revisión
                  <select className="input mt-0.5 block !py-1 text-xs" value={filter.review} onChange={(e) => setFilter({ ...filter, review: e.target.value as PassFilter["review"] })}>
                    <option value="all">Todos</option>
                    <option value="pending">Sin revisar</option>
                    <option value="reviewed">Revisados</option>
                  </select>
                </label>
                {sample && (
                  <label className="flex items-center gap-1.5 pb-2">
                    <input type="checkbox" checked={sampleOnly} onChange={(e) => setSampleOnly(e.target.checked)} />
                    Solo la muestra
                  </label>
                )}
                {(isPassFiltered(filter) || sampleOnly) && (
                  <button type="button" className="btn btn-ghost !px-2 !py-1 text-[11px]" onClick={() => { setFilter(NO_PASS_FILTER); setSampleOnly(false); }}>
                    Quitar filtros
                  </button>
                )}
              </div>
              <div className={`grid ${COLS} gap-x-2 border-b border-line-soft pb-1 text-[11px] text-faint`} role="row">
                <span>Inicio</span>
                <span className="text-right">Dur.</span>
                <span>Equipo</span>
                <span>De → a</span>
                <span>Resultado</span>
                <span />
              </div>
              <div ref={boxRef} className="min-h-0 flex-1 overflow-hidden">
                {shown.length === 0 ? (
                  <p className="pt-3 text-sm text-faint">Ningún pase con estos filtros.</p>
                ) : (
                  page.map((p) => {
                    const r = reviewMap.get(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => pick(p)}
                        aria-pressed={selected === p.id}
                        title={`Reproducir este pase (${fmtTd(p.t_start)} – ${fmtTd(p.t_end)})`}
                        className={`grid w-full ${COLS} items-center gap-x-2 border-b border-line-soft px-0 text-left text-xs hover:bg-raised ${selected === p.id ? "bg-raised" : ""}`}
                        style={{ height: ROW_H }}
                      >
                        <span className="tc text-ink">{fmtT(p.t_start)}</span>
                        <span className="tc text-right text-muted">{(p.t_end - p.t_start).toFixed(1)} s</span>
                        <span>
                          <span className={p.team === "own" ? "tag tag-accent" : "tag"}>{p.team === "own" ? "Nuestro" : "Rival"}</span>
                        </span>
                        <span className="truncate text-muted">
                          {name(p.from_name, p.from)} → {p.completed ? name(p.to_name, p.to) : "rival"}
                          {p.approx && <span className="ml-1 text-faint">aprox.</span>}
                        </span>
                        <span className={p.completed ? "text-ink" : "text-warn"}>{p.completed ? "Completado" : "Cortado"}</span>
                        <span className={r ? (r.verdict === "correct" ? "text-ok" : "text-danger") : "text-faint"} title={r ? (r.verdict === "correct" ? "Revisado: correcto" : "Revisado: incorrecto") : "Sin revisar"}>
                          {r ? (r.verdict === "correct" ? "✓" : "✗") : "·"}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              <Pager page={pg} pages={pages} setPage={setPage} />
            </Card>
            <div className="card shrink-0 !p-3 text-xs" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn" onClick={draw} disabled={items.length === 0}>
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
                <span className="inline-flex items-center gap-1 text-faint">
                  <FloppyDisk size={12} />
                  {rsave.state === "saving" ? "Guardando…" : rsave.state === "error" ? `No se guardó: ${rsave.text}` : (rsave.text ?? "Se guarda solo")}
                </span>
              </div>
              <p className="mt-2 text-ink">
                {stats.accuracy === null
                  ? "Aún no marcas ningún pase."
                  : `Acierto sobre lo revisado: ${stats.correct} de ${stats.reviewed} (${Math.round(100 * stats.accuracy)} %), no del partido.`}
                {stats.reviewed > 0 && stats.current < stats.reviewed ? ` ${stats.reviewed - stats.current} revisiones son de pases que ya no existen con los datos actuales.` : ""}
              </p>
            </div>
          </div>,
          <Card key="c" title="Verificación" className="h-full overflow-auto">
            {!row ? (
              <p className="text-sm text-faint">Elige un pase de la lista: aquí se ve la cancha en el último toque de quien pasa, adónde fue el balón y el video.</p>
            ) : (
              <>
                <p className="tc mb-1 text-sm text-ink">
                  {fmtTd(row.t_start)} – {fmtTd(row.t_end)} <span className="text-muted">({(row.t_end - row.t_start).toFixed(1)} s)</span>
                </p>
                <p className="mb-2 text-xs text-muted">
                  <span className="text-ink">{sideLabel(row.team, ctx)}</span> · {row.completed ? "pase completado" : "pase cortado (el otro equipo tuvo el balón después)"} ·{" "}
                  {name(row.from_name, row.from)}
                  {row.completed ? ` → ${name(row.to_name, row.to)}` : ""}
                  {row.approx ? " · sin nombres en esta parte: aproximado" : ""}
                </p>
                {scene ? (
                  <>
                    <SceneView scene={scene.scene} ends={scene.ends} />
                    <p className="mt-1 text-xs text-muted">
                      Balón al inicio: {scene.ends.start ? `${scene.ends.start[0].toFixed(1)}, ${scene.ends.start[1].toFixed(1)} m` : "sin medir"} · al final:{" "}
                      {scene.ends.end ? `${scene.ends.end[0].toFixed(1)}, ${scene.ends.end[1].toFixed(1)} m` : "sin medir"}.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-faint">Ninguna parte procesada tiene posiciones en este instante: no se puede dibujar la cancha.</p>
                )}
                <div className="mt-3 border-t border-line-soft pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={`btn ${rv?.verdict === "correct" ? "btn-primary" : ""}`} aria-pressed={rv?.verdict === "correct"} onClick={() => mark(rv?.verdict === "correct" ? null : "correct", note ?? "")}>
                      <CheckCircle size={15} />
                      Correcto
                    </button>
                    <button type="button" className={`btn ${rv?.verdict === "incorrect" ? "btn-primary" : ""}`} aria-pressed={rv?.verdict === "incorrect"} onClick={() => mark(rv?.verdict === "incorrect" ? null : "incorrect", note ?? "")}>
                      <XCircle size={15} />
                      Incorrecto
                    </button>
                    <input
                      className="input min-w-40 flex-1"
                      placeholder="Nota opcional"
                      aria-label="Nota del pase"
                      value={note ?? ""}
                      onChange={(e) => setDraft({ id: row.id, note: e.target.value })}
                      onBlur={() => rv && (note ?? "") !== rv.note && mark(rv.verdict, note ?? "")}
                    />
                  </div>
                  {!rv && <p className="mt-1 text-xs text-faint">Sin revisar. La nota se guarda junto con el veredicto.</p>}
                </div>
              </>
            )}
          </Card>,
          <Card key="v" title="Video" className="h-full overflow-auto">
            {panel ?? <p className="text-sm text-faint">Elige un pase: aquí se reproduce, con la opción de repetirlo en bucle.</p>}
          </Card>,
        ]}
      </Split>
    </div>
  );
}

// The passes tagged by hand are another source: counted apart, never added to the tracking's.
function HandNote({ count, inline = false }: { count: number; inline?: boolean }) {
  const text = `${PASS_SOURCE_LABEL.hand}: ${count === 0 ? "ninguno" : count}. Se muestran aparte en Análisis y nunca se suman a los del tracking.`;
  return inline ? <span className="text-xs text-faint">{text}</span> : <p className="m-0 text-xs text-faint">{text}</p>;
}
