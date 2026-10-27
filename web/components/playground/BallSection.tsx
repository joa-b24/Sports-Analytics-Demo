"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, Crosshair, EyeSlash, Lightning, MapPin, SoccerBall, Trash, Warning } from "@phosphor-icons/react";
import { RunControl } from "@/components/workspace/AnchorsPanel";
import type { PlayerHandle } from "@/components/VideoPlayer";
import { Card } from "@/components/Shell";
import { Locked } from "@/components/Locked";
import { fmtT } from "@/lib/format";
import { localVideo, readLocal, writeLocalInfo } from "@/lib/local";
import { matchVideos } from "@/lib/videos";
import type { Match } from "@/lib/types";
import {
  SAMPLES_GOAL, addNegative, addSample, emptySamples, metricsPath, parseMetrics, parseSamples, partRange, partVideo, probabilityBands, removeAt,
  sampleStats, samplesPath, setShadow, stepPoint, suggestInstants, type AutoPoint, type BallMetrics,
} from "@/lib/playground";
import { BallSources } from "./BallSources";
import { BallVideo } from "./BallVideo";
import { usePartInfos } from "./usePartInfos";

const NO_POINTS: AutoPoint[] = [];
type Step = "samples" | "train" | "run";
type SaveState = "idle" | "saving" | "saved" | "error";

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
const pctText = (x: number | null) => (x === null ? "—" : `${(100 * x).toLocaleString("es-MX", { maximumFractionDigits: 1 })} %`);

// Playground > Balón: where the report's ball comes from (0), hand samples (1), training (2), run (3) and completing by
// hand in the Balón view (4). Nothing is accepted by itself: the tracker's points are only drawn.
export function BallSection({ match, folder, onOpenBall }: { match: Match; folder: string; onOpenBall: () => void }) {
  const videos = useMemo(() => matchVideos(match), [match]);
  const [videoId, setVideoId] = useState(videos[0].video_id);
  const video = videos.find((v) => v.video_id === videoId) ?? videos[0];
  const [tick, setTick] = useState(0);
  const { parts, meta, error } = usePartInfos(folder, videos.map((v) => v.video_id), tick);
  const vmeta = meta[video.video_id];
  const fps = vmeta?.fps ?? 30;
  const image = useMemo(() => ({ w: vmeta?.image_w ?? 1920, h: vmeta?.image_h ?? 1080 }), [vmeta]);
  const [step, setStep] = useState<Step>("samples");
  const [fileFor, setFileFor] = useState<{ id: string; url: string | null } | null>(null);
  const fileUrl = fileFor?.id === video.video_id ? fileFor.url : undefined;
  const playerRef = useRef<PlayerHandle>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Local copy of the video (any speed, exact frames); without it the YouTube embed is used.
  useEffect(() => {
    let live = true;
    void localVideo(folder, video.video_id).then((u) => live && setFileFor({ id: video.video_id, url: u }));
    return () => {
      live = false;
    };
  }, [folder, video.video_id]);

  // ---- samples of the video, loaded and saved to tracking/ball_samples_<video>.json
  const [samples, setSamples] = useState(() => emptySamples(video.video_id, fps));
  const [loaded, setLoaded] = useState(false);
  const [save, setSave] = useState<{ state: SaveState; error?: string }>({ state: "idle" });
  const dirty = useRef(false);
  useEffect(() => {
    let live = true;
    dirty.current = false;
    void readLocal(samplesPath(folder, video.video_id)).then((t) => {
      if (!live) return;
      setSamples(parseSamples(t, video.video_id, fps));
      setLoaded(true);
      setSave({ state: t ? "saved" : "idle" });
    });
    return () => {
      live = false;
      setLoaded(false);
    };
  }, [folder, video.video_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (f: (s: typeof samples) => typeof samples) => {
    dirty.current = true;
    setSave({ state: "saving" });
    setSamples((s) => ({ ...f(s), fps }));
  };
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const id = window.setTimeout(() => {
      void writeLocalInfo(samplesPath(folder, video.video_id), JSON.stringify(samples, null, 1)).then((r) => {
        dirty.current = false;
        setSave(r.ok ? { state: "saved" } : { state: "error", error: r.error });
      });
    }, 500);
    return () => window.clearTimeout(id);
  }, [samples, loaded, folder, video.video_id]);

  const stats = sampleStats(samples);
  const [aerial, setAerial] = useState(false);
  const [shadowMode, setShadowMode] = useState(false);
  const marking = step === "samples";
  const markAt = (px: [number, number], t: number) => {
    if (shadowMode) {
      change((s) => setShadow(s, s.samples.filter((x) => x.aerial && x.t_video <= t + 0.12).at(-1)?.t_video ?? -9, px));
      setShadowMode(false);
      return;
    }
    playerRef.current?.pause();
    change((s) => addSample(s, t, px, aerial));
  };
  const markNegative = useCallback(() => {
    const t = playerRef.current?.getTime();
    if (t !== undefined) change((s) => addNegative(s, t));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keys while marking: Space plays, arrows move a frame (Shift: one second), A aerial, S shadow, N not visible.
  useEffect(() => {
    if (!marking) return;
    const on = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const pl = playerRef.current;
      if (!pl) return;
      const k = e.key.toLowerCase();
      if (k === " ") pl.toggle();
      else if (k === "arrowleft" || k === "arrowright") {
        pl.pause();
        pl.seek(Math.max(0, pl.getTime() + (k === "arrowright" ? 1 : -1) * (e.shiftKey ? 1 : 1 / fps)));
      } else if (k === "a") setAerial((x) => !x);
      else if (k === "s") setShadowMode((x) => !x);
      else if (k === "n") markNegative();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [marking, fps, markNegative]);

  // ---- suggested moments, spread over the parts of this video
  const spans = useMemo(() => (parts ?? []).flatMap((p) => (p.span ? [p.span] : [])), [parts]);
  const [suggested, setSuggested] = useState<{ part: string; t_video: number }[]>([]);
  const suggest = () => {
    const marked = [...samples.samples, ...samples.negatives];
    setSuggested(suggestInstants(spans, marked, 12, video.video_id));
  };
  const nextSuggestion = suggested.find((s) => !samples.samples.some((x) => Math.abs(x.t_video - s.t_video) < 1) && !samples.negatives.some((x) => Math.abs(x.t_video - s.t_video) < 1));
  const goTo = (t: number) => {
    playerRef.current?.pause();
    playerRef.current?.seek(Math.max(0, t));
  };

  // ---- metrics of the training
  const [metrics, setMetrics] = useState<BallMetrics | null>(null);
  const [metricsRuns, setMetricsRuns] = useState(0);
  useEffect(() => {
    let live = true;
    void readLocal(metricsPath(folder, video.video_id)).then((t) => live && setMetrics(parseMetrics(t)));
    return () => {
      live = false;
    };
  }, [folder, video.video_id, metricsRuns]);

  // ---- run on a part, and its result
  const videoParts = (parts ?? []).filter((p) => p.hasRaw && partVideo(p.part) === video.video_id);
  const [runPart, setRunPart] = useState<string>("");
  const part = videoParts.find((p) => p.part === runPart) ?? videoParts[0];
  const [autoRead, setAutoRead] = useState<{ part: string; points: AutoPoint[]; ask: number } | null>(null);
  const auto = autoRead && autoRead.part === part?.part ? autoRead.points : NO_POINTS;
  const autoInfo = autoRead && autoRead.part === part?.part ? { ask: autoRead.ask } : null;
  const [autoRuns, setAutoRuns] = useState(0);
  useEffect(() => {
    let live = true;
    if (!part?.hasAuto) return;
    const name = part.part;
    void readLocal(`matches/${folder}/tracking/ball_auto_${name}.json`).then((t) => {
      if (!live || !t) return;
      try {
        const d = JSON.parse(t) as { kind?: string; frames?: AutoPoint[]; ask?: number[] };
        if (d.kind === "ball_auto" && Array.isArray(d.frames)) {
          setAutoRead({ part: name, points: d.frames, ask: d.ask?.length ?? 0 });
        }
      } catch {
        // Unreadable file: nothing is drawn.
      }
    });
    return () => {
      live = false;
    };
  }, [folder, part?.part, part?.hasAuto, autoRuns]);
  const bands = probabilityBands(auto);
  const showAuto = step === "run" ? auto : [];
  const selectPart = (k: string) => {
    setRunPart(k);
    const v = partVideo(k);
    if (v !== video.video_id && videos.some((x) => x.video_id === v)) setVideoId(v);
    setStep("run");
    if (v === video.video_id) goTo(partRange(k)[0] / fps);
  };
  const ranOnce = useRef(false);
  useEffect(() => {
    // After a run ends the listing is read again, so «has ball_auto» and the dates are right.
    if (ranOnce.current) setTick((n) => n + 1);
    ranOnce.current = true;
  }, [autoRuns]);

  const trained = metrics !== null;

  return (
    <div className="space-y-6">
      <BallSources parts={parts} error={error} selected={part?.part ?? null} onSelect={selectPart} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="min-w-0 space-y-3">
          {videos.length > 1 && (
            <div className="seg" role="group" aria-label="Video">
              {videos.map((v) => (
                <button key={v.video_id} type="button" className="seg-opt" aria-pressed={v.video_id === video.video_id} onClick={() => setVideoId(v.video_id)}>
                  {v.label || v.video_id}
                </button>
              ))}
            </div>
          )}
          {fileUrl === undefined ? (
            <p className="text-sm text-muted">Buscando el video…</p>
          ) : (
            <BallVideo
              playerRef={playerRef}
              fileUrl={fileUrl ?? undefined}
              youtubeId={fileUrl ? undefined : video.youtube_id || undefined}
              image={image}
              fps={fps}
              time={time}
              playing={playing}
              onTime={setTime}
              onPlaying={setPlaying}
              marking={marking}
              onClickPx={markAt}
              samples={samples}
              auto={showAuto}
              hint={
                !fileUrl
                  ? "Sin el video local, los píxeles se calculan sobre la imagen de YouTube escalada a 16:9 (menos exactos). Pon el archivo en matches/<carpeta>/video/."
                  : marking
                    ? shadowMode
                      ? "Clic en la sombra del balón de la última muestra aérea."
                      : "Clic en el centro del balón. Espacio: reproducir · ← →: un cuadro (Mayús: 1 s) · A: aéreo · S: sombra · N: balón no visible."
                    : undefined
              }
            />
          )}
        </div>

        <div className="space-y-3">
          <StepCard n={1} title="Muestras" active={step === "samples"} onOpen={() => setStep("samples")} summary={`${stats.total} muestras · meta ${SAMPLES_GOAL[0]}-${SAMPLES_GOAL[1]}`} done={stats.reached}>
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex items-baseline justify-between text-xs text-muted">
                  <span className="num text-ink">
                    {stats.total} <span className="text-muted">de {SAMPLES_GOAL[0]}-{SAMPLES_GOAL[1]}</span>
                  </span>
                  <span>
                    suelo {stats.ground} · aéreo {stats.aerial} · no visible {stats.negatives}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={SAMPLES_GOAL[0]} aria-valuenow={Math.min(stats.total, SAMPLES_GOAL[0])} aria-label="Muestras hacia la meta">
                  <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.min(100, stats.progress * 100)}%` }} />
                </div>
                {stats.total > 0 && stats.aerial < Math.min(10, stats.total * 0.1) && <p className="mt-1.5 text-[11px] text-warn">Pocas muestras con el balón en el aire: el entrenamiento no podrá medirlas bien.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={`btn ${aerial ? "btn-primary" : ""}`} aria-pressed={aerial} onClick={() => setAerial((x) => !x)}>
                  <Lightning size={14} />
                  Balón en el aire
                </button>
                <button type="button" className={`btn ${shadowMode ? "btn-primary" : ""}`} aria-pressed={shadowMode} onClick={() => setShadowMode((x) => !x)} title="Opcional: después de una muestra aérea, marca su sombra">
                  <MapPin size={14} />
                  Marcar sombra
                </button>
                <button type="button" className="btn" onClick={markNegative}>
                  <EyeSlash size={14} />
                  Balón no visible
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn" onClick={suggest} disabled={spans.length === 0}>
                  <Crosshair size={14} />
                  Sugerir instantes
                </button>
                {nextSuggestion && (
                  <button type="button" className="btn btn-primary" onClick={() => goTo(nextSuggestion.t_video)}>
                    Ir al siguiente ({fmtT(nextSuggestion.t_video)})
                  </button>
                )}
                {suggested.length > 0 && !nextSuggestion && <span className="text-xs text-muted">Marcaste todos los sugeridos: pide otros.</span>}
              </div>
              <p className="m-0 text-[11px] text-faint">
                Los instantes se reparten entre las partes de este video, donde hay menos muestras. Marca solo donde el balón se vea con claridad.
                {spans.length === 0 && " No hay partes con su índice (tracks_<video>_index.json): no se pueden sugerir."}
              </p>
              <SaveLine save={save} />
              {samples.samples.length + samples.negatives.length > 0 && (
                <ul className="m-0 max-h-44 list-none space-y-0.5 overflow-y-auto p-0 text-xs">
                  {[...samples.samples.map((s) => ({ t: s.t_video, label: s.aerial ? "aéreo" : "suelo", warn: false })), ...samples.negatives.map((n) => ({ t: n.t_video, label: "no visible", warn: true }))]
                    .sort((a, b) => a.t - b.t)
                    .map((r) => (
                      <li key={`${r.t}${r.label}`} className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-raised">
                        <button type="button" className="num text-ink-2 hover:text-ink" onClick={() => goTo(r.t)}>
                          {fmtT(r.t)}
                        </button>
                        <span className={r.warn ? "text-warn" : "text-muted"}>{r.label}</span>
                        <button type="button" className="ml-auto text-faint hover:text-danger" aria-label={`Quitar la muestra de ${fmtT(r.t)}`} onClick={() => change((s) => removeAt(s, r.t))}>
                          <Trash size={13} />
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </StepCard>

          <StepCard n={2} title="Entrenar" active={step === "train"} onOpen={() => setStep("train")} summary={trained ? "entrenado" : "sin entrenar"} done={trained}>
            <div className="space-y-3">
              {stats.total === 0 || save.state !== "saved" ? (
                <p className="m-0 text-sm text-muted">{stats.total === 0 ? "Primero marca muestras en el paso 1." : "Espera a que se guarden las muestras."}</p>
              ) : (
                <RunControl
                  key={`train-${video.video_id}`}
                  match={folder}
                  part={video.video_id}
                  task="train"
                  label="Entrenar con mis muestras"
                  icon={<SoccerBall size={14} />}
                  warn={() =>
                    !stats.reached
                      ? `Hay ${stats.total} muestras y la meta es ${SAMPLES_GOAL[0]}-${SAMPLES_GOAL[1]}. Puedes entrenar, pero las métricas serán poco fiables.`
                      : metrics
                        ? "Ya hay un modelo entrenado con muestras. Entrenar otra vez lo reemplaza."
                        : null
                  }
                  onDone={() => setMetricsRuns((n) => n + 1)}
                />
              )}
              {metrics ? (
                <div className="rounded-lg bg-raised p-3 text-xs">
                  <div className="mb-2 text-muted">
                    Reserva de validación (20 %): {metrics.n_val ?? "—"} de {(metrics.n_train ?? 0) + (metrics.n_val ?? 0) || "—"} muestras{metrics.trained_at ? ` · ${metrics.trained_at}` : ""}
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-faint">
                        <th className="font-medium">Grupo</th>
                        <th className="font-medium">Muestras</th>
                        <th className="font-medium">Precisión</th>
                      </tr>
                    </thead>
                    <tbody className="num text-ink">
                      <tr>
                        <td>Suelo</td>
                        <td>{metrics.ground.n ?? "—"}</td>
                        <td>{pctText(metrics.ground.precision)}</td>
                      </tr>
                      <tr>
                        <td>Aéreo</td>
                        <td>{metrics.aerial.n ?? "—"}</td>
                        <td>{pctText(metrics.aerial.precision)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <Locked reason="dev" title="Métricas de validación" why="Aún no hay métricas: se leen de ball_metrics_<video>.json, que escribe el entrenamiento al terminar." need="Entrena con tus muestras (la opción --samples de sportsan.tracking.ball train debe existir)." />
              )}
            </div>
          </StepCard>

          <StepCard n={3} title="Correr" active={step === "run"} onOpen={() => setStep("run")} summary={part ? (part.hasAuto ? `${part.part}: ${auto.length} puntos` : `${part.part}: sin correr`) : "sin partes"} done={!!part?.hasAuto}>
            <div className="space-y-3">
              {videoParts.length === 0 ? (
                <p className="m-0 text-sm text-muted">Este video no tiene partes procesadas (tracks_{video.video_id}_…).</p>
              ) : (
                <>
                  <label className="block text-xs text-muted">
                    Parte
                    <select className="input mt-1 w-full" value={part?.part ?? ""} onChange={(e) => selectPart(e.target.value)}>
                      {videoParts.map((p) => (
                        <option key={p.part} value={p.part}>
                          {p.part}
                          {p.hasAuto ? " · con ball_auto" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {part && (
                    <RunControl
                      key={`run-${part.part}`}
                      match={folder}
                      part={part.part}
                      task="ball"
                      label="Correr el balón automático"
                      icon={<SoccerBall size={14} />}
                      extra={{ force: part.hasAuto }}
                      warn={() => (part.hasAuto ? "Ya hay balón automático en esta parte (ball_auto). Correr otra vez lo reemplaza; tus marcas a mano no se tocan." : null)}
                      onDone={() => setAutoRuns((n) => n + 1)}
                    />
                  )}
                  {part?.hasAuto && auto.length > 0 ? (
                    <div className="space-y-2 rounded-lg bg-raised p-3 text-xs">
                      <div className="text-ink">
                        <span className="num">{auto.length}</span> puntos en el video · <span className="num">{autoInfo?.ask ?? 0}</span> cuadros donde pide marca a mano
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
                        <span>
                          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-ok" />p ≥ 0,99: {bands.high}
                        </span>
                        <span>
                          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-accent-400" />0,95-0,99: {bands.mid}
                        </span>
                        <span>
                          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-warn" />p &lt; 0,95: {bands.low}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            const q = stepPoint(auto, fps, time, -1);
                            if (q) goTo(q.frame / fps);
                          }}
                        >
                          Punto anterior
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            const q = stepPoint(auto, fps, time, 1);
                            if (q) goTo(q.frame / fps);
                          }}
                        >
                          Punto siguiente
                        </button>
                      </div>
                      <p className="m-0 text-faint">Los puntos se dibujan sobre el video con su probabilidad. Nada se acepta solo: el informe no los usa hasta guardar la parte en la mesa.</p>
                    </div>
                  ) : (
                    <p className="m-0 text-xs text-faint">{part?.hasAuto ? "El archivo ball_auto no se pudo leer." : "Esta parte no tiene balón automático todavía."}</p>
                  )}
                </>
              )}
              {(parts ?? []).length > 0 && videoParts.length === 0 && (
                <p className="m-0 flex items-center gap-1.5 text-xs text-warn">
                  <Warning size={13} />
                  Faltan los tracks de las partes de este video.
                </p>
              )}
            </div>
          </StepCard>

          <StepCard n={4} title="Completar a mano" active={false} onOpen={onOpenBall} summary="vista Balón de la mesa" done={false} link>
            {null}
          </StepCard>
        </div>
      </div>
    </div>
  );
}

function SaveLine({ save }: { save: { state: SaveState; error?: string } }) {
  const text = save.state === "saving" ? "Guardando…" : save.state === "saved" ? "Guardado en tracking/ball_samples" : save.state === "error" ? `No se pudo guardar: ${save.error ?? "error"}` : "Sin muestras guardadas";
  return (
    <p className={`m-0 text-[11px] ${save.state === "error" ? "text-danger" : "text-faint"}`} role="status">
      {text}
    </p>
  );
}

function StepCard({ n, title, summary, active, done, onOpen, link, children }: { n: number; title: string; summary: string; active: boolean; done: boolean; onOpen: () => void; link?: boolean; children: React.ReactNode }) {
  return (
    <Card className="!p-0">
      <button type="button" onClick={onOpen} aria-expanded={link ? undefined : active} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-ok text-bg" : active ? "bg-accent text-bg" : "bg-raised text-muted"}`}>{n}</span>
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        <span className="ml-auto truncate text-xs text-faint">{summary}</span>
        {link && <ArrowSquareOut size={15} className="shrink-0 text-muted" aria-hidden />}
      </button>
      {active && !link && <div className="border-t border-line-soft px-4 py-3">{children}</div>}
    </Card>
  );
}
