"use client";

import { ArrowClockwise, ArrowCounterClockwise, CheckCircle, Circle, ListChecks, Play, Stop, Timer, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { detectEvents, DETECTED_TYPES, type DetectedEvent } from "@/lib/eventDetect";
import { TYPE_LABEL } from "@/lib/eventReview";
import { fmtT } from "@/lib/format";
import { useFixedParts } from "@/lib/fixed";
import { listLocal, readLocal, writeLocalInfo } from "@/lib/local";
import { possessionIntervals } from "@/lib/possession";
import {
  NO_DETECTOR, fillBallBlockers, fillBallChecks, fmtEta, lastAutoRun, newStamp, parseQuickSummary, parseSuggest, planLines, quickIsCurrent, quickVerdict, runAutoEvents, suggestPath,
  withoutRun, countSamples, ballModels, type Check, type AutoRunResult, type QuickSummary,
} from "@/lib/processes";
import { isQuickStage, pipelinePaths, stageName, type PipelineArgs } from "@/lib/runTask";
import { segmentsFromMarks, type Segment } from "@/lib/segments";
import { mutate, setPref, usePref, useStore } from "@/lib/store";
import { autoEventsOf, eventParamsOf, possessionParamsOf } from "@/lib/tech";
import { TRACKING_DEFAULTS, ballRequestOf, fillRequestOf, trackingParamsOf } from "@/lib/techTracking";
import type { Match } from "@/lib/types";
import { usePipeline, type PipelineHook } from "@/lib/usePipeline";
import { matchVideos, periodAt, videoOf } from "@/lib/videos";

// «Procesos del partido»: the three general commands of the match, one card each. The two Python ones (tracking and
// fill + ball) are launched from the app and read back from the state file Python writes; the third (events) runs here.
export function ProcessesPanel({ match }: { match: Match }) {
  const folder = match.folder;
  const videos = useMemo(() => matchVideos(match), [match]);
  const [video, setVideo] = useState<string>("");
  if (!folder) {
    return <p className="text-sm text-muted">Este partido todavía no tiene carpeta en el repositorio: crea o elige la carpeta en su engrane y vuelve aquí.</p>;
  }
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-pretty text-muted">
        Tres comandos que llevan el partido de video a eventos. Se pueden dejar corriendo: si recargas la página o se reinicia la app, esto vuelve a leer en qué van.
      </p>
      {videos.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-muted">
          Video
          <select className="input" value={video} onChange={(e) => setVideo(e.target.value)}>
            <option value="">Todos los del partido</option>
            {videos.map((v) => (
              <option key={v.video_id} value={v.video_id}>
                {v.label ?? v.video_id}
              </option>
            ))}
          </select>
        </label>
      )}
      <TrackingCard match={match} folder={folder} video={video} />
      <FillBallCard match={match} folder={folder} video={video} />
      <EventsCard match={match} folder={folder} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------- shared pieces
function CardShell({ n, title, lead, children }: { n: number; title: string; lead: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby={`proc-${n}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tc text-xs text-faint">{n}</span>
        <h3 id={`proc-${n}`} className="text-[15px] text-ink">
          {title}
        </h3>
      </div>
      <p className="mt-1 max-w-3xl text-xs text-pretty text-muted">{lead}</p>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Progress({ hook }: { hook: PipelineHook }) {
  const v = hook.view;
  if (!v) return null;
  const eta = fmtEta(v.eta_s);
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="text-ink">
          {stageName(v.stage) || "Arrancando…"}
          {v.video ? ` · ${v.video}` : ""}
          {v.part ? ` · ${v.part}` : ""}
        </span>
        <span className="tc text-muted">
          {Math.round(v.pct)} %{eta ? ` · quedan ${eta}` : ""}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.pct)} aria-label="Avance">
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${v.pct}%` }} />
      </div>
      {v.message && <p className="text-xs text-faint">{v.message}</p>}
    </div>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  const cls = tone === "ok" ? "bg-raised text-ink-2" : tone === "warn" ? "bg-warn-900 text-warn" : "bg-raised text-danger";
  return (
    <p className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs text-pretty ${cls}`} role={tone === "ok" ? "status" : "alert"}>
      {tone === "ok" ? <CheckCircle size={14} className="mt-px shrink-0" /> : <WarningCircle size={14} className="mt-px shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

function PlanBox({ text }: { text: string }) {
  const { lines, estimate } = planLines(text);
  return (
    <div className="rounded-lg bg-bg/60 p-3">
      <pre className="tc max-h-56 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{lines.join("\n")}</pre>
      {estimate && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink">
          <Timer size={13} /> Estimado: {estimate}
        </p>
      )}
    </div>
  );
}

function Offline({ cmd }: { cmd: string }) {
  return (
    <div className="space-y-1 text-xs text-muted">
      <p>Estos procesos solo se lanzan desde la computadora donde corre la app. Desde aquí, copia el comando en una terminal (con .venv activo, en la raíz del repositorio):</p>
      <pre className="tc overflow-auto rounded-lg bg-bg/60 p-2 text-[11px] text-ink-2">{cmd}</pre>
    </div>
  );
}

function LogTail({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <details className="text-xs text-faint">
      <summary className="cursor-pointer">Últimas líneas del registro</summary>
      <pre className="tc mt-1 max-h-40 overflow-auto rounded-lg bg-bg/60 p-2 text-[11px] whitespace-pre-wrap text-ink-2">{lines.join("\n")}</pre>
    </details>
  );
}

// What every card shows once something ran, ran and failed or is running.
function RunState({ hook, resumeArgs, doneText }: { hook: PipelineHook; resumeArgs: Partial<PipelineArgs>; doneText: string }) {
  const v = hook.view;
  if (!v) return null;
  if (v.state === "running")
    return (
      <div className="space-y-2">
        <Progress hook={hook} />
        <button type="button" className="btn" disabled={hook.busy} onClick={() => void hook.stop()}>
          <Stop size={14} /> Detener
        </button>
      </div>
    );
  if (v.state === "error")
    return (
      <div className="space-y-2">
        <Notice tone="bad">{v.message || "Se detuvo con un error."}</Notice>
        <div className="flex flex-wrap items-center gap-2">
          {v.resumable && (
            <button type="button" className="btn btn-primary" disabled={hook.busy} onClick={() => void hook.start({ ...resumeArgs, resume: true })}>
              <ArrowClockwise size={14} /> Reanudar
            </button>
          )}
          <span className="text-xs text-faint">Reanudar salta lo que ya está hecho.</span>
        </div>
        <LogTail lines={hook.log} />
      </div>
    );
  if (v.state === "done")
    return (
      <div className="space-y-2">
        <Notice tone="ok">
          {doneText} {v.message}
        </Notice>
        <LogTail lines={hook.log} />
      </div>
    );
  return null;
}

// ------------------------------------------------------------------------------------------------- 1. all the tracking
function TrackingCard({ match, folder, video }: { match: Match; folder: string; video: string }) {
  const tech = trackingParamsOf(match);
  // Only what differs from the default goes as a flag, so a better default of the Python side reaches this match.
  const base: Partial<PipelineArgs> = { ...(video ? { video } : {}), ...(tech.searchMarginM !== TRACKING_DEFAULTS.searchMarginM ? { bandMarginM: tech.searchMarginM } : {}) };
  const hook = usePipeline("tracking", folder, base);
  const [plan, setPlan] = useState<string | null>(null);
  const [report, setReport] = useState<QuickSummary | null>(null);
  const answered = usePref(`procQuick:${folder}`, "");
  const v = hook.view;
  const quickStage = v ? isQuickStage(v.stage) : false;

  // The report of the quick test, once it finished (or whenever the state says «done» for a quick stage).
  const ready = v?.state === "done";
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void readLocal(`${pipelinePaths(folder, "tracking").quick}/summary.json`).then((t) => {
      if (live) setReport(parseQuickSummary(t));
    });
    return () => {
      live = false;
    };
  }, [ready, folder, v?.ended]);
  const showReport = !!report && ready && (quickStage || quickIsCurrent(report, v?.started ?? null)) && answered !== report.created;

  if (hook.available === false) return <CardShell n={1} title="Todo el tracking" lead="Propaga las anclas, arma la biblioteca, detecta y calibra, y deja las uniones sugeridas."><Offline cmd={`python -m sportsan.tracking.pipeline tracking --match ${folder} --quick`} /></CardShell>;

  const idle = !v || v.state === "idle";
  const running = v?.state === "running";
  const askPlan = async () => {
    const r = await hook.plan();
    setPlan(r ? r.text : null);
  };
  return (
    <CardShell n={1} title="Todo el tracking" lead="Propaga las anclas, arma la biblioteca de calibración, detecta y calibra todo el juego y deja las uniones sugeridas. Primero una prueba rápida de un minuto; si sale bien, corre completo.">
      {hook.offline && <Notice tone="warn">Sin respuesta de la app (¿se está reiniciando?). Sigue intentando; lo que corre no se detiene.</Notice>}
      {hook.error && <Notice tone="bad">{hook.error}</Notice>}
      {!running && !showReport && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" disabled={hook.busy} onClick={() => void askPlan()}>
            <ListChecks size={14} /> Ver plan
          </button>
          <button type="button" className="btn btn-primary" disabled={hook.busy} onClick={() => void hook.start({ quick: true })}>
            <Play size={14} /> Prueba rápida
          </button>
          {!idle && v?.state === "done" && !quickStage && <span className="text-xs text-faint">Corre de nuevo para completar lo que falte (salta lo hecho).</span>}
        </div>
      )}
      {plan !== null && !running && <PlanBox text={plan} />}
      {plan !== null && !running && !showReport && (
        <button type="button" className="btn btn-ghost text-faint" disabled={hook.busy} onClick={() => void hook.start({ resume: true })} title="Sin prueba previa: salta lo que ya está hecho">
          <Play size={14} /> Correr completo sin prueba
        </button>
      )}
      {showReport && report && <QuickReport report={report} busy={hook.busy} onYes={() => { setPref(`procQuick:${folder}`, report.created); void hook.start({ resume: true }); }} onNo={() => setPref(`procQuick:${folder}`, report.created)} />}
      {!showReport && <RunState hook={hook} resumeArgs={quickStage ? { quick: true } : {}} doneText={quickStage ? "La prueba rápida terminó." : "El tracking terminó."} />}
    </CardShell>
  );
}

function QuickReport({ report: q, busy, onYes, onNo }: { report: QuickSummary; busy: boolean; onYes: () => void; onNo: () => void }) {
  const verdict = quickVerdict(q);
  const pct = (x: number | null) => (x === null ? "sin dato" : `${Math.round(x * 100)} %`);
  const n = (x: number | null, d = 0) => (x === null ? "sin dato" : x.toFixed(d).replace(".", ","));
  const figs: [string, string][] = [
    ["Cuadros calibrados", pct(q.calibratedShare)],
    ["Personas en la cancha (mediana)", n(q.onPitchMedian)],
    ["Personas detectadas (mediana)", n(q.boxesMedian)],
    ["Identidades", n(q.identities)],
    ["Milisegundos por cuadro", n(q.msPerFrame)],
    ["Cadenas / uniones sugeridas", q.suggest ? `${q.suggest.chains} / ${q.suggest.suggestions}` : q.linkModel ? "sin dato" : "sin modelo de uniones"],
  ];
  return (
    <div className="space-y-3 rounded-lg bg-bg/60 p-3">
      <p className="text-sm text-ink">
        Informe de la prueba rápida{q.videoId ? ` · ${q.videoId}` : ""}
        <span className="text-faint">
          {" "}
          · {Math.round(q.startS)}–{Math.round(q.endS)} s
        </span>
      </p>
      <Notice tone={verdict.tone}>{verdict.text}</Notice>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        {figs.map(([k, val]) => (
          <div key={k}>
            <dt className="text-faint">{k}</dt>
            <dd className="tc text-ink">{val}</dd>
          </div>
        ))}
      </dl>
      {q.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="pb-1 text-left text-faint">
              Cuadros de calibración revisados: {q.samples} tramos, {q.toReview} por revisar
            </caption>
            <thead className="text-faint">
              <tr>
                <th className="py-1 pr-3 font-normal">Tramo (min:s)</th>
                <th className="pr-3 font-normal">Ubicadas</th>
                <th className="pr-3 font-normal" title="Cuadros que la biblioteca ubicó pero no cuadraban con el movimiento de la cámara">Descartadas</th>
                <th className="pr-3 font-normal">Vecinas (m)</th>
                <th className="pr-3 font-normal">Referencias (m)</th>
                <th className="pr-3 font-normal">Sin calibrar</th>
                <th className="font-normal">Estado</th>
              </tr>
            </thead>
            <tbody className="tc">
              {q.rows.map((r, i) => (
                <tr key={i} className="border-t border-line-soft">
                  <td className="py-1 pr-3">
                    {i + 1}
                    {q.fps ? <span className="text-faint"> · {fmtT(r.start / q.fps)}</span> : null}
                  </td>
                  <td className="pr-3">
                    {r.found}/{r.wanted}
                  </td>
                  <td className="pr-3">{r.dropped}</td>
                  <td className="pr-3">{r.neighboursM === null ? "sin dato" : r.neighboursM.toFixed(2)}</td>
                  <td className="pr-3">{r.refsM === null ? "sin dato" : r.refsM.toFixed(2)}</td>
                  <td className="pr-3">{r.missing === null ? "sin dato" : `${r.missing}/${r.frames ?? 0}`}</td>
                  <td className={r.ok ? "text-ok" : "text-warn"}>{r.ok ? "bien" : "revisar"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.calibFiles.length > 0 && (
        <p className="text-xs text-faint">
          Para verlos sobre el video: Calibración › Verificar, y carga cada calib_… de <span className="tc">tracking/revision/quick/</span> ({q.calibFiles.length} archivos) para comprobar que la rejilla calce.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3">
        <span className="text-sm text-ink">¿Todo bien?</span>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onYes}>
          <Play size={14} /> Sí, correr completo
        </button>
        <button type="button" className="btn" onClick={onNo}>
          No
        </button>
        <span className="text-xs text-faint">«No» no hace nada: el informe queda en la carpeta.</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------- 2. fill + ball
function FillBallCard({ match, folder, video }: { match: Match; folder: string; video: string }) {
  const req = fillRequestOf(match);
  const ball = ballRequestOf(match);
  const [model, setModel] = useState("");
  const base: Partial<PipelineArgs> = { ...(video ? { video } : {}), ...ball, ...(req.unnamedCost !== undefined ? { unnamedCost: req.unnamedCost } : {}), ...(req.seg ? { seg: req.seg } : {}), ...(model ? { model } : {}) };
  const hook = usePipeline("fill-ball", folder, base);
  const videos = useMemo(() => matchVideos(match).map((x) => x.video_id), [match]);
  const asked = useMemo(() => (video ? [video] : videos), [video, videos]);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [plan, setPlan] = useState<string | null>(null);
  const running = hook.view?.state === "running";
  const doneKey = hook.view?.state === "done" ? String(hook.view.ended) : "";

  // The prerequisites, read from the folder (again when a run ends: it may have changed them).
  useEffect(() => {
    let live = true;
    void (async () => {
      const [tracking, auto, weights] = await Promise.all([listLocal(`matches/${folder}/tracking`), listLocal(`matches/${folder}/tracking/auto`), listLocal("weights")]);
      const samples: Record<string, number | null> = {};
      for (const v of asked) samples[v] = countSamples(await readLocal(`matches/${folder}/tracking/ball_samples_${v}.json`));
      if (!live) return;
      const names = (l: typeof tracking) => (l ?? []).filter((e) => !e.dir).map((e) => e.name);
      const w = names(weights);
      setModels(ballModels(w));
      setChecks(fillBallChecks({ tracking: names(tracking), auto: names(auto), weights: w, samples, videos: asked }));
    })();
    return () => {
      live = false;
    };
  }, [folder, asked, doneKey, running]);

  if (hook.available === false) return <CardShell n={2} title="Relleno y balón automático" lead="Da nombre a los trozos de track a partir de las anclas y marca el balón con el modelo entrenado."><Offline cmd={`python -m sportsan.tracking.pipeline fill-ball --match ${folder}`} /></CardShell>;
  const blockers = checks ? fillBallBlockers(checks) : [];
  const askPlan = async () => {
    const r = await hook.plan();
    setPlan(r ? r.text : null);
  };
  const changed: string[] = [`confianza del balón ${String(ball.accept).replace(".", ",")}`];
  if (req.unnamedCost !== undefined) changed.push(`costo de dejar sin nombre ${String(req.unnamedCost).replace(".", ",")}`);
  if (req.seg) changed.push("umbrales del relleno de Detalles técnicos");
  return (
    <CardShell n={2} title="Relleno y balón automático" lead="Por cada parte con anclas tuyas: rellena las identidades (variante B, por tramos) y después marca el balón con el modelo entrenado. No pisa balones ya detectados.">
      {hook.offline && <Notice tone="warn">Sin respuesta de la app (¿se está reiniciando?). Sigue intentando; lo que corre no se detiene.</Notice>}
      {hook.error && <Notice tone="bad">{hook.error}</Notice>}
      <div>
        <p className="text-xs text-muted">Antes de correr</p>
        {!checks ? (
          <p className="mt-1 text-xs text-faint">Leyendo la carpeta…</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                {c.ok ? <CheckCircle size={14} weight="fill" className="mt-px shrink-0 text-ok" aria-label="Listo" /> : <Circle size={14} className="mt-px shrink-0 text-warn" aria-label="Falta" />}
                <span>
                  <span className="text-ink">{c.label}</span> <span className="text-faint">· {c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-faint">Parámetros de Detalles técnicos que se envían: {changed.join(", ")}.</p>
      {models.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-muted">
          Modelo de balón
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">El más reciente</option>
            {models.map((m) => (
              <option key={m} value={`weights/${m}`}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}
      {!running && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" disabled={hook.busy} onClick={() => void askPlan()}>
            <ListChecks size={14} /> Ver plan
          </button>
          <button type="button" className="btn btn-primary" disabled={hook.busy || blockers.length > 0} onClick={() => void hook.start({ resume: true })} title={blockers.length ? blockers.join(" ") : undefined}>
            <Play size={14} /> Correr
          </button>
          {blockers.length > 0 && <span className="text-xs text-warn">Falta algo de la lista: no se puede correr todavía.</span>}
        </div>
      )}
      {plan !== null && !running && <PlanBox text={plan} />}
      <RunState hook={hook} resumeArgs={{}} doneText="El relleno y el balón terminaron." />
    </CardShell>
  );
}

// ------------------------------------------------------------------------------------------------- 3. events
function EventsCard({ match, folder }: { match: Match; folder: string }) {
  const state = useStore();
  const auto = autoEventsOf(match);
  const mine = useMemo(() => state.events.filter((e) => e.match_id === match.match_id), [state.events, match.match_id]);
  const last = useMemo(() => lastAutoRun(mine), [mine]);
  const [job, setJob] = useState(false);
  const [result, setResult] = useState<{ r: AutoRunResult; saved: boolean; skipped: string[] } | null>(null);
  return (
    <CardShell n={3} title="Eventos" lead="Detecta eventos desde las posiciones, aquí mismo, con la posesión y las reglas vigentes. Los tipos que autorizaste se crean marcados «automático»; los demás quedan como sugerencias en la pasada de revisión. Nunca toca ni borra lo que etiquetaste a mano.">
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {DETECTED_TYPES.map((t) => (
          <p key={t} className="flex items-baseline justify-between gap-2 border-b border-line-soft py-1 text-xs">
            <span className="text-ink">{TYPE_LABEL[t]}</span>
            <span className={auto.includes(t) ? "text-ok" : "text-faint"}>{auto.includes(t) ? "automático" : "sugerencia"}</span>
          </p>
        ))}
        {NO_DETECTOR.map((t) => (
          <p key={t.type} className="flex items-baseline justify-between gap-2 border-b border-line-soft py-1 text-xs">
            <span className="text-ink">{t.label}</span>
            <span className="text-faint">sin detector todavía</span>
          </p>
        ))}
      </div>
      <p className="text-xs text-faint">Qué tipos son automáticos se elige en Detalles técnicos. Los que no tienen detector no se inventan: se etiquetan a mano.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={job} onClick={() => { setResult(null); setJob(true); }}>
          <Play size={14} /> Detectar eventos
        </button>
        {last && (
          <button
            type="button"
            className="btn"
            disabled={job}
            onClick={() => {
              mutate((s) => ({ ...s, events: withoutRun(s.events, last.stamp) }));
              setResult(null);
            }}
            title="Quita los eventos automáticos de la última corrida; no toca nada más"
          >
            <ArrowCounterClockwise size={14} /> Deshacer esta corrida ({last.ids.length})
          </button>
        )}
        {last && <span className="text-xs text-faint">Última corrida: {new Date(last.at).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })}</span>}
      </div>
      {job && (
        <EventsJob
          match={match}
          folder={folder}
          onDone={(r, saved, skipped) => {
            setJob(false);
            setResult({ r, saved, skipped });
          }}
        />
      )}
      {job && <p className="text-xs text-muted" role="status">Detectando… puede tardar unos segundos con un partido completo.</p>}
      {result && (
        <div className="space-y-1.5">
          <Notice tone="ok">
            Creó {result.r.stats.created} eventos automáticos, dejó {result.r.stats.suggestions} sugerencias para revisar y omitió {result.r.stats.duplicates} por duplicado (mismo tipo y equipo a menos de 3 s de otro evento).
            {result.r.stats.suggestions > 0 && " Las sugerencias están en el etiquetado, pasada «Revisar»."}
          </Notice>
          {result.skipped.length > 0 && <Notice tone="warn">Sin posiciones para: {result.skipped.join(", ")}. No se inventó nada para esos videos.</Notice>}
          {!result.saved && <Notice tone="warn">No se pudieron guardar las sugerencias en la carpeta del partido (la app debe correr en esta computadora). Los eventos sí se crearon.</Notice>}
        </div>
      )}
    </CardShell>
  );
}

// Mounted only while a run goes (it loads the positions of the match, which is the heavy part).
function EventsJob({ match, folder, onDone }: { match: Match; folder: string; onDone: (r: AutoRunResult, saved: boolean, skipped: string[]) => void }) {
  const state = useStore();
  const videos = useMemo(() => matchVideos(match), [match]);
  const videoIds = useMemo(() => videos.map((v) => v.video_id), [videos]);
  const fixed = useFixedParts(folder, videoIds);
  const started = useRef(false);
  const latest = useRef({ state, match, videos, done: onDone });
  useEffect(() => {
    latest.current = { state, match, videos, done: onDone };
  });
  useEffect(() => {
    if (!fixed || started.current) return;
    const id = window.setTimeout(() => {
      if (started.current) return;
      started.current = true;
      void (async () => {
        const { state: s, match: m, videos: vs, done } = latest.current;
        const segmentsByVideo: Record<string, Segment[]> = Object.fromEntries(vs.map((v) => [v.video_id, segmentsFromMarks(s.segments.filter((g) => g.match_id === m.match_id && videoOf(g) === v.video_id))]));
        const params = eventParamsOf(m);
        const dets: DetectedEvent[] = [];
        const skipped: string[] = [];
        for (const v of vs) {
          const parts = fixed.parts.filter((p) => p.file.video_id === v.video_id);
          if (parts.length === 0) {
            skipped.push(v.label ?? v.video_id);
            continue;
          }
          const poss = possessionIntervals(parts, segmentsByVideo, possessionParamsOf(m), undefined, trackingParamsOf(m).ballJumpMs);
          dets.push(...detectEvents(parts, segmentsByVideo, poss.rows, params));
        }
        const prior: Record<string, ReturnType<typeof parseSuggest>> = {};
        for (const v of vs) prior[v.video_id] = parseSuggest(await readLocal(suggestPath(folder, v.video_id)), v.video_id);
        const r = runAutoEvents({
          dets,
          existing: s.events.filter((e) => e.match_id === m.match_id),
          auto: autoEventsOf(m),
          matchId: m.match_id,
          periodOf: (vid, t) => {
            const i = Math.max(0, vs.findIndex((x) => x.video_id === vid));
            return periodAt(vs[i], i, t);
          },
          stamp: newStamp(),
          prior,
        });
        if (r.created.length) mutate((st) => ({ ...st, events: [...st.events, ...r.created] }));
        let saved = true;
        for (const [vid, f] of Object.entries(r.suggest)) {
          const w = await writeLocalInfo(suggestPath(folder, vid), JSON.stringify(f, null, 1));
          if (!w.ok) saved = false;
        }
        done(r, saved, skipped);
      })();
    }, 30);
    return () => window.clearTimeout(id);
  }, [fixed, folder]);
  return null;
}
