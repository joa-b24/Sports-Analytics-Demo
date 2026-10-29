"use client";

import { CloudArrowDown, CloudArrowUp, Cpu, FloppyDisk, Flask, Play, Stop } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Command } from "@/components/Command";
import { MeasuredKits } from "@/components/workspace/MeasuredKits";
import { VideoMissingNotice } from "@/components/match/VideoDownload";
import { videoFileOf } from "@/lib/downloads";
import { fmtT } from "@/lib/format";
import { readVideoFps } from "@/lib/matchYaml";
import { listLocal, readLocal, writeLocal } from "@/lib/local";
import { TRACKING_DEFAULTS } from "@/lib/techTracking";
import { useTrackingTech } from "@/lib/useTech";
import { JOB_COMMAND, useJobs, type JobKind, type JobView } from "@/lib/run";
import { DEFAULT_POST, DETECTORS, POST_WINDOW, detectorLine, postLine, readPost, readSettings, strideAdvice, testVerdict, writePost, writeSettings, type PostSettings, type TestSummary, type TrackingSettings } from "@/lib/trackingSettings";

const fmtDur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`);

// The football-pitch lines behind the empty state, drawn once when it appears.
function PitchLines() {
  return (
    <svg viewBox="0 0 105 68" className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.07]" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <g fill="none" stroke="var(--color-ink)" strokeWidth={0.3} className="draw-in">
        <rect x={1} y={1} width={103} height={66} pathLength={1} />
        <line x1={52.5} y1={1} x2={52.5} y2={67} pathLength={1} />
        <circle cx={52.5} cy={34} r={9.15} pathLength={1} />
        <rect x={1} y={13.84} width={16.5} height={40.32} pathLength={1} />
        <rect x={87.5} y={13.84} width={16.5} height={40.32} pathLength={1} />
      </g>
    </svg>
  );
}

function JobLine({ job, onStop }: { job: JobView; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (job.state !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [job.state]);
  const secs = ((job.ended ?? now) - job.started) / 1000;
  const lines = job.tail ?? (job.last ? [job.last] : []);
  return (
    <div className="mt-3 rounded-lg bg-bg/70 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${job.state === "running" ? "animate-pulse bg-own" : job.state === "done" ? "bg-ok" : "bg-danger"}`}
          aria-hidden
        />
        <span className="text-ink-2">{job.state === "running" ? "Corriendo" : job.state === "done" ? "Terminó" : job.state === "stopped" ? "Detenido" : "Falló"}</span>
        <span className="tc text-faint">{fmtT(secs)}</span>
        {job.state === "running" && (
          <button type="button" className="btn btn-ghost ml-auto !py-0.5 text-xs" onClick={onStop}>
            <Stop size={12} weight="fill" />
            Detener
          </button>
        )}
      </div>
      {lines.length > 0 && <pre className="tc mt-2 max-h-28 overflow-y-auto text-[11px] whitespace-pre-wrap text-muted">{lines.slice(-4).join("\n")}</pre>}
    </div>
  );
}

type Props = {
  folder: string;
  video: string;
  // Opens a tracks file of the folder (relative to tracking/) in the correction table.
  onOpen: (rel: string) => void;
  // The tracking folder may have changed (a run finished): list it again.
  onRefresh: () => void;
};

// What a video without tracking shows: the settings of the detector, a 30-second test that says whether it sees the
// players before spending a night on it, and the processing itself, on this computer or on Kaggle's GPU. With the
// app on this computer each step is a button; on the web, the command to copy.
export function ProcessPanel({ folder, video, onOpen, onRefresh }: Props) {
  const yamlPath = `matches/${folder}/match.yaml`;
  const [yaml, setYaml] = useState<string | null>(null);
  const [settings, setSettings] = useState<TrackingSettings | null>(null);
  const [post, setPost] = useState<PostSettings>(DEFAULT_POST);
  const [saved, setSaved] = useState<string | null>(null);
  const [test, setTest] = useState<TestSummary | null>(null);
  // Processing places each person on the pitch with the calibration: without anchors or a library of this video it
  // cannot run. null until known.
  const [calibrated, setCalibrated] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void listLocal(`matches/${folder}/tracking`).then((files) => {
      if (!live) return;
      const names = (files ?? []).map((f) => f.name);
      setCalibrated(names.includes(`library_${video}.npz`) || names.some((n) => new RegExp(`^anchors_.+_${video}\.json$`).test(n)));
    });
    return () => {
      live = false;
    };
  }, [folder, video]);
  // The file of the video (not YouTube): detection reads its frames. false = missing (it may be downloading, see the
  // notice at the top); null until known or when the folder cannot be read.
  const [videoOk, setVideoOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const look = () =>
      void listLocal(`matches/${folder}/video`).then((files) => {
        if (live) setVideoOk(files ? videoFileOf(files.map((f) => f.name), video) !== null : null);
      });
    look();
    const id = setInterval(look, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [folder, video]);
  const { enabled, start, stop, latest } = useJobs(folder);
  const { params: tech } = useTrackingTech(folder);
  const testJob = latest("test");
  const processJob = latest("process");
  const kaggleJob = latest("kaggle");
  const pullJob = latest("kaggle_pull");

  useEffect(() => {
    let live = true;
    void readLocal(yamlPath).then((t) => {
      if (!live) return;
      setYaml(t);
      setSettings(readSettings(t));
      setPost(readPost(t));
    });
    return () => {
      live = false;
    };
  }, [yamlPath]);
  // The last test of this match (it survives reloads: it is a file of the folder).
  const testDone = testJob?.state === "done" ? testJob.id : "";
  useEffect(() => {
    let live = true;
    void readLocal(`matches/${folder}/tracking/prueba/summary.json`).then((t) => {
      if (!live || !t) return;
      try {
        setTest(JSON.parse(t) as TestSummary);
      } catch {
        // A half-written file: ignored until the next run.
      }
    });
    return () => {
      live = false;
    };
  }, [folder, testDone]);
  const doneKey = `${processJob?.state === "done" ? processJob.id : ""}|${pullJob?.state === "done" ? pullJob.id : ""}`;
  useEffect(() => {
    if (doneKey !== "|") onRefresh();
  }, [doneKey, onRefresh]);

  const s = settings;
  const fps = yaml ? readVideoFps(yaml, video) : null;
  const advice = s ? strideAdvice(fps, s.stride) : null;
  const set = (p: Partial<TrackingSettings>) => {
    setSettings((o) => (o ? { ...o, ...p } : o));
    setSaved(null);
  };
  const save = async () => {
    if (!s) return;
    if (yaml === null) return setSaved("Sin acceso a la carpeta: copia la línea en match.yaml.");
    const next = writePost(writeSettings(yaml, s), post);
    const ok = await writeLocal(yamlPath, next);
    if (ok) setYaml(next);
    setSaved(ok ? "Guardado en match.yaml" : "No se pudo escribir match.yaml");
  };
  const local = enabled === true;
  const verdict = test ? testVerdict(test) : null;

  const action = (kind: JobKind, label: string, icon: React.ReactNode, primary = false) =>
    local ? (
      <button type="button" className={`btn ${primary ? "btn-primary" : ""}`} onClick={() => void start(kind, video, kind === "test" && tech.searchMarginM !== TRACKING_DEFAULTS.searchMarginM ? tech.searchMarginM : undefined)} disabled={latest(kind)?.state === "running" || (videoOk === false && kind !== "kaggle_pull")} title={videoOk === false && kind !== "kaggle_pull" ? "Falta el video: descárgalo primero" : undefined}>
        {icon}
        {label}
      </button>
    ) : (
      <Command className="w-full">{JOB_COMMAND[kind](folder, video)}</Command>
    );

  return (
    <section className="relative overflow-hidden rounded-xl bg-surface">
      <PitchLines />
      <div className="relative p-6 md:p-8">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="sec-tag">Sin tracking</span>
          <h2 className="text-2xl text-ink">Hay que procesar el video {video}</h2>
        </div>
        <VideoMissingNotice folder={folder} video={video} quiet />
        {calibrated === false && (
          <p className="mt-4 max-w-3xl rounded-lg bg-warn-900 px-4 py-3 text-sm text-warn">
            Antes falta calibrar este video: marca anclas en el paso Calibración. Sin calibración el proceso no puede ubicar a las jugadoras en la cancha.
          </p>
        )}

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {/* 1. Settings */}
          <div className="rounded-lg bg-bg/60 p-4">
            <h3 className="cond text-sm font-extrabold text-ink uppercase">Ajustes</h3>
            {!s ? (
              <p className="mt-3 text-sm text-faint">Leyendo match.yaml…</p>
            ) : (
              <div className="mt-3 space-y-3 text-sm">
                <label className="block">
                  <span className="text-xs text-muted">Detector</span>
                  <select className="input mt-1 w-full" value={s.model} onChange={(e) => set({ model: e.target.value })}>
                    {DETECTORS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                    {!DETECTORS.some((d) => d.id === s.model) && <option value={s.model}>{s.model}</option>}
                  </select>
                </label>
                <div>
                  <span className="text-xs text-muted">Cortes a lo ancho</span>
                  <div className="seg mt-1 flex" role="group" aria-label="Cortes a lo ancho">
                    {[1, 2, 3].map((n) => (
                      <button key={n} type="button" className="seg-opt flex-1" aria-pressed={s.tiles === n} onClick={() => set({ tiles: n })}>
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="text-xs text-muted">Dónde busca</span>
                  <div className="seg mt-1 flex" role="group" aria-label="Franja de la imagen">
                    <button type="button" className="seg-opt flex-1" aria-pressed={s.band === "all"} onClick={() => set({ band: "all" })}>
                      Toda la imagen
                    </button>
                    <button type="button" className="seg-opt flex-1" aria-pressed={s.band === "auto"} onClick={() => set({ band: "auto" })}>
                      Solo la cancha
                    </button>
                  </div>
                </div>
                <label className="block">
                  <span className="flex justify-between text-xs text-muted">
                    Confianza mínima <span className="tc text-ink">{s.conf.toFixed(2)}</span>
                  </span>
                  <input type="range" className="mt-1 w-full" min={0.1} max={0.5} step={0.05} value={s.conf} onChange={(e) => set({ conf: Number(e.target.value) })} />
                </label>
                <div>
                  <span className="text-xs text-muted">Procesa 1 de cada</span>
                  <div className="seg mt-1 flex" role="group" aria-label="Cuadros procesados">
                    {[1, 2, 3, 4, 6].map((n) => (
                      <button key={n} type="button" className="seg-opt flex-1" aria-pressed={s.stride === n} onClick={() => set({ stride: n })}>
                        {n}
                      </button>
                    ))}
                  </div>
                  {advice && (
                    <p className="mt-2 rounded-lg bg-warn-900/40 px-3 py-2 text-[11px] text-pretty text-ink-2">
                      Este video va a {fps} fps: con 1 de cada {s.stride} se procesa un cuadro cada {advice.stepS.toFixed(2)} s, {advice.factor.toFixed(1)} veces más seguido que los
                      demás partidos (0.1 s) y tarda lo mismo de veces más.{" "}
                      <button type="button" className="underline hover:text-ink" onClick={() => set({ stride: advice.suggested })}>
                        Usar 1 de cada {advice.suggested}
                      </button>
                    </p>
                  )}
                </div>
                <fieldset className="space-y-2 border-t border-line pt-3">
                  <legend className="text-xs text-muted">Posiciones (se aplican al procesar)</legend>
                  <label className="flex items-center gap-2 text-sm text-ink-2">
                    <input type="checkbox" className="accent-accent" checked={post.feet} onChange={(e) => (setPost((o) => ({ ...o, feet: e.target.checked })), setSaved(null))} />
                    Pies corregidos
                    <span className="text-[11px] text-faint">(por defecto: activado)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink-2">
                    <input type="checkbox" className="accent-accent" checked={post.smoothH} onChange={(e) => (setPost((o) => ({ ...o, smoothH: e.target.checked })), setSaved(null))} />
                    Calibración suavizada en el tiempo
                    <span className="text-[11px] text-faint">(por defecto: activada)</span>
                  </label>
                  <label className={`block ${post.smoothH ? "" : "opacity-50"}`}>
                    <span className="flex justify-between text-xs text-muted">
                      Fuerza del suavizado (ventana) <span className="tc text-ink">{post.smoothWindowS.toFixed(1)} s</span>
                    </span>
                    <input
                      type="range"
                      className="mt-1 w-full"
                      disabled={!post.smoothH}
                      min={POST_WINDOW.min}
                      max={POST_WINDOW.max}
                      step={POST_WINDOW.step}
                      value={post.smoothWindowS}
                      aria-label="Ventana del suavizado de la calibración, en segundos"
                      onChange={(e) => (setPost((o) => ({ ...o, smoothWindowS: Number(e.target.value) })), setSaved(null))}
                    />
                    <span className="text-[11px] text-faint">Por defecto 0.7 s: más alto quita más temblor pero tarda en seguir un giro de cámara.</span>
                  </label>
                </fieldset>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {yaml !== null ? (
                    <button type="button" className="btn" onClick={() => void save()}>
                      <FloppyDisk size={15} />
                      Guardar en match.yaml
                    </button>
                  ) : (
                    <Command className="w-full">{`${detectorLine(s)}
${postLine(post)}`}</Command>
                  )}
                  {saved && <span className="text-xs text-faint">{saved}</span>}
                </div>
              </div>
            )}
          </div>

          {/* 2. Test */}
          <div className="rounded-lg bg-bg/60 p-4">
            <h3 className="cond text-sm font-extrabold text-ink uppercase">Prueba de 30 s</h3>
            <p className="mt-1 text-xs text-muted">Antes de procesar todo: cuántas jugadoras ve el detector con estos ajustes.</p>
            <div className="mt-3">{action("test", "Probar 30 s", <Flask size={15} />)}</div>
            {testJob && <JobLine job={testJob} onStop={() => void stop(testJob.id)} />}
            {test && (
              <div className="mt-4">
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      [Math.round(test.on_pitch_median), "en la cancha"],
                      [`${Math.round(test.calibrated_share * 100)} %`, "calibrado"],
                      [fmtDur(test.estimate_s), "todo el plan"],
                    ] as const
                  ).map(([v, l]) => (
                    <div key={l} className="border-l border-line pl-2">
                      <div className="num text-2xl text-ink">{v}</div>
                      <div className="text-[11px] text-muted">{l}</div>
                    </div>
                  ))}
                </div>
                {verdict && (
                  <p className={`mt-3 text-xs ${verdict.tone === "ok" ? "text-ok" : verdict.tone === "warn" ? "text-warn" : "text-danger"}`}>{verdict.text}</p>
                )}
                <p className="mt-1 text-[11px] text-faint">
                  {test.created} · {test.model}
                  {test.tiles > 1 ? ` · ${test.tiles} cortes` : ""} · confianza {test.conf} · 1 de cada {test.stride}
                </p>
                <button type="button" className="btn btn-ghost mt-2 !px-0" onClick={() => onOpen(`prueba/${test.part}`)}>
                  <Play size={14} />
                  Ver la prueba sobre el video
                </button>
                <MeasuredKits folder={folder} file={`prueba/${test.part}`} />
              </div>
            )}
          </div>

          {/* 3. Process */}
          <div className="rounded-lg bg-bg/60 p-4">
            <h3 className="cond text-sm font-extrabold text-ink uppercase">Procesar</h3>
            <div className="mt-3 space-y-4">
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-sm text-ink-2">
                  <Cpu size={15} />
                  En esta computadora
                  {test && <span className="text-xs text-faint">· ~{fmtDur(test.estimate_s)}</span>}
                </div>
                {action("process", "Procesar todo", <Play size={15} weight="fill" />, true)}
                {processJob && <JobLine job={processJob} onStop={() => void stop(processJob.id)} />}
              </div>
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-sm text-ink-2">
                  <CloudArrowUp size={15} />
                  En Kaggle (GPU)
                </div>
                <div className="flex flex-wrap gap-2">
                  {action("kaggle", "Enviar a Kaggle", <CloudArrowUp size={15} />)}
                  {action("kaggle_pull", "Bajar resultados", <CloudArrowDown size={15} />)}
                </div>
                {kaggleJob && <JobLine job={kaggleJob} onStop={() => void stop(kaggleJob.id)} />}
                {pullJob && <JobLine job={pullJob} onStop={() => void stop(pullJob.id)} />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
