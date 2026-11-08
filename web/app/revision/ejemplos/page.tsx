"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Card, PageHeader, btn } from "@/components/Shell";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { isTyping } from "@/lib/format";
import { listLocal, localVideo, readLocal, writeLocal } from "@/lib/local";
import {
  GOAL_POSITIVES,
  WHY,
  WHY_LABEL,
  addNegative,
  addPositive,
  addSkipped,
  answered,
  confirmDetection,
  counts,
  nextPending,
  parseExamples,
  removeAnswer,
  trialDetections,
  trialId,
  type ExamplesFile,
  type PlanItem,
  type TrialDet,
  type Why,
} from "@/lib/examples";

// Ejemplos de balón para reentrenar (2026-11-01). Página fuera del menú, pensada también para el celular (botones grandes,
// un toque marca; «toque preciso» acerca la imagen antes de marcar). Dos pestañas:
//   1. Balón bien visible: cuadros muestreados de sus partidos (ejemplos_plan.json, lo escribe `ball_examples plan`);
//      ella toca el balón o dice «no se ve».
//   2. Falsos positivos de la prueba: lo que marcó la prueba corta (ensayo.json, `ball_examples trial`); cada marca es
//      «sí es balón» o «no es» (zapato, cabeza, yarda, otro). Los «no es» entran al reentrenamiento como negativos duros.
// Todo se guarda en matches/<partido>/tracking/revision/balon/ejemplos.json. No sirve para medir modelos (eso es /revision).

type Tab = "positivos" | "falsos";
type Entry = PlanItem & { folder: string };
type Trial = { video_id: string; fps: number; image_w: number; image_h: number; frames: TrialDet[]; trial?: { start_s: number; seconds: number } };

const ZOOM = 3.5;
const dir = (folder: string) => `matches/${folder}/tracking/revision/balon`;

export default function Page() {
  const [tab, setTab] = useState<Tab>("positivos");
  const [plan, setPlan] = useState<Entry[]>([]);
  const [files, setFiles] = useState<Record<string, ExamplesFile>>({});
  const [trials, setTrials] = useState<Record<string, Trial>>({});
  const [status, setStatus] = useState("Buscando los cuadros…");
  const timers = useRef<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      const folders = ((await listLocal("matches")) ?? []).filter((f) => f.dir).map((f) => f.name);
      const items: Entry[] = [];
      const fs: Record<string, ExamplesFile> = {};
      const ts: Record<string, Trial> = {};
      for (const d of folders) {
        const p = await readLocal(`${dir(d)}/ejemplos_plan.json`);
        const e = await readLocal(`${dir(d)}/ejemplos.json`);
        const t = await readLocal(`${dir(d)}/ensayo.json`);
        if (!p && !e && !t) continue;
        fs[d] = parseExamples(e);
        if (p) for (const it of (JSON.parse(p).items ?? []) as PlanItem[]) items.push({ ...it, folder: d });
        if (t) {
          try {
            const j = JSON.parse(t);
            if (j.kind === "ball_trial") ts[d] = j;
          } catch {
            /* ensayo ilegible: se ignora */
          }
        }
      }
      if (!live) return;
      setPlan(items);
      setFiles(fs);
      setTrials(ts);
      setStatus(items.length || Object.keys(ts).length ? "" : "No hay cuadros: corre `python -m sportsan.tracking.ball_examples plan --match <id>`.");
    })();
    return () => {
      live = false;
    };
  }, []);

  const save = (folder: string, next: ExamplesFile) => {
    setFiles((all) => ({ ...all, [folder]: next }));
    window.clearTimeout(timers.current[folder]);
    timers.current[folder] = window.setTimeout(async () => {
      const ok = await writeLocal(`${dir(folder)}/ejemplos.json`, JSON.stringify(next));
      setStatus(ok ? "Guardado" : "No se pudo guardar en la carpeta (¿la app corre en esta computadora?)");
    }, 300);
  };

  const total = useMemo(() => {
    const all = Object.values(files);
    return {
      positives: all.reduce((n, f) => n + f.positives.length, 0),
      skipped: all.reduce((n, f) => n + f.skipped.length, 0),
      negatives: all.reduce((n, f) => n + f.negatives.length, 0),
    };
  }, [files]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <PageHeader title="Ejemplos de balón" />
      <p className="max-w-[90ch] text-sm text-muted">
        Para que el programa aprenda mejor. Primero marca unos {GOAL_POSITIVES} balones bien visibles; luego se corre una prueba corta y aquí mismo marcas qué detectó
        mal (zapatos, cabezas, yardas). Se guarda solo en la carpeta de cada partido, aparte de la verdad de /revision.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="seg" role="group" aria-label="Qué marcar">
          {(
            [
              ["positivos", "Balón bien visible"],
              ["falsos", "Falsos positivos de la prueba"],
            ] as const
          ).map(([k, name]) => (
            <button key={k} type="button" aria-pressed={tab === k} className="seg-opt" onClick={() => setTab(k)}>
              {name}
            </button>
          ))}
        </div>
        <span className="tc text-sm text-ink" data-testid="totals">
          {total.positives} de {GOAL_POSITIVES} balones · {total.skipped} sin verse · {total.negatives} falsos positivos
        </span>
        <span className="ml-auto text-sm text-muted">{status}</span>
      </div>
      {tab === "positivos" ? <Positives plan={plan} files={files} save={save} /> : <Falsos trials={trials} files={files} save={save} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ viewer with taps
// Video paused on a frame, an SVG on top that returns the tapped pixel of the video. «Toque preciso»: the first tap
// zooms around that place, the second one marks.
function Tap({
  folder,
  video,
  t,
  fps,
  marks,
  onTap,
  fine,
  hint,
}: {
  folder: string;
  video: string;
  t: number;
  fps: number;
  marks: { px: [number, number]; color: string; label?: string }[];
  onTap?: (px: [number, number]) => void;
  fine: boolean;
  hint?: string;
}) {
  const ref = useRef<PlayerHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [size, setSize] = useState({ w: 1920, h: 1080 });
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  useEffect(() => {
    let live = true;
    void localVideo(folder, video).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [folder, video]);

  // Once the player can seek, and every time the moment changes: half a frame in, so it shows that frame.
  useEffect(() => {
    if (!url) return;
    const go = () => {
      const p = ref.current;
      const v = box.current?.querySelector("video");
      if (!p || !v || p.getDuration() <= 0) return false;
      if (v.videoWidth) setSize({ w: v.videoWidth, h: v.videoHeight });
      p.pause();
      p.seek((Math.round(t * fps) + 0.5) / fps);
      return true;
    };
    if (go()) return;
    const id = window.setInterval(() => go() && window.clearInterval(id), 120);
    return () => window.clearInterval(id);
  }, [url, t, fps]);

  const [prevT, setPrevT] = useState(t);
  if (prevT !== t) {
    setPrevT(t);
    setZoom(null);
  }

  const toPx = (e: React.MouseEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * size.w, ((e.clientY - r.top) / r.height) * size.h];
  };
  const tap = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onTap) return;
    const px = toPx(e);
    if (fine && !zoom) return setZoom(px);
    setZoom(null);
    onTap(px);
  };

  if (url === undefined) return <p className="text-sm text-faint">Buscando el video…</p>;
  if (url === null) return <p className="text-sm text-faint">No está el video {video} en la carpeta del partido.</p>;
  const r = size.w / 100;
  return (
    <div className="space-y-2">
      <div ref={box} className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
        <div
          className="absolute inset-0 transition-transform duration-200"
          style={zoom ? { transform: `scale(${ZOOM})`, transformOrigin: `${(zoom[0] / size.w) * 100}% ${(zoom[1] / size.h) * 100}%` } : undefined}
        >
          <VideoPlayer ref={ref} fileUrl={url} />
          <svg viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full cursor-crosshair touch-manipulation" onClick={tap} data-testid="tap-area">
            {marks.map((m, i) => (
              <g key={i} pointerEvents="none">
                <circle cx={m.px[0]} cy={m.px[1]} r={(zoom ? 0.18 : 0.6) * r * 2} fill="none" stroke={m.color} strokeWidth={(zoom ? 0.05 : 0.2) * r} />
                {m.label && (
                  <text x={m.px[0]} y={m.px[1] - r * (zoom ? 0.6 : 2)} textAnchor="middle" fontSize={r * (zoom ? 0.5 : 1.6)} fill={m.color} stroke="#000" strokeWidth={r * 0.05} paintOrder="stroke">
                    {m.label}
                  </text>
                )}
              </g>
            ))}
            {zoom && <circle cx={zoom[0]} cy={zoom[1]} r={r * 0.08} fill="#fff" opacity={0.7} pointerEvents="none" />}
          </svg>
        </div>
      </div>
      <p className="text-xs text-muted" data-testid="tap-hint">
        {hint ?? (fine ? (zoom ? "Toca justo sobre el balón." : "Toca donde está el balón: se acerca la imagen y tocas de nuevo para marcarlo bien.") : "Toca el balón.")}
      </p>
    </div>
  );
}

const bigBtn = `${btn} !min-h-12 !px-4 text-base`;

// Whether the device is touch-first (a finger, no mouse).
function useCoarse() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(pointer: coarse)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}

// ------------------------------------------------------------------------------------------------ tab 1: good examples
function Positives({ plan, files, save }: { plan: Entry[]; files: Record<string, ExamplesFile>; save: (folder: string, f: ExamplesFile) => void }) {
  // Until she moves by hand, the frame on screen is the first one without an answer.
  const [pick, setIdx] = useState<number | null>(null);
  const [aerial, setAerial] = useState(false);
  const coarse = useCoarse();
  const [fineOpt, setFineOpt] = useState<boolean | null>(null);
  const fine = fineOpt ?? coarse;
  const firstOpen = plan.findIndex((it) => !answered(files[it.folder] ?? parseExamples(null), it.id));
  const idx = pick ?? Math.max(0, firstOpen);
  const item = plan[Math.min(idx, Math.max(0, plan.length - 1))] ?? null;
  const file = (it: Entry) => files[it.folder] ?? parseExamples(null);

  const next = (from: number, f?: { folder: string; file: ExamplesFile }) => {
    const view = plan.map((it) => ({ id: it.id, folder: it.folder }));
    for (let k = 1; k <= plan.length; k++) {
      const i = (from + k) % plan.length;
      const e = view[i];
      const ff = f && f.folder === e.folder ? f.file : (files[e.folder] ?? parseExamples(null));
      if (!answered(ff, e.id)) return setIdx(i);
    }
    setIdx(from);
  };

  const mark = (px: [number, number]) => {
    if (!item) return;
    const f = addPositive(file(item), item, px, aerial);
    save(item.folder, f);
    setAerial(false);
    next(idx, { folder: item.folder, file: f });
  };
  const skip = () => {
    if (!item) return;
    const f = addSkipped(file(item), item);
    save(item.folder, f);
    next(idx, { folder: item.folder, file: f });
  };
  const undo = () => {
    if (!item) return;
    save(item.folder, removeAnswer(file(item), item.id));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") skip();
      else if (k === "a") setAerial((v) => !v);
      else if (k === "arrowright") setIdx(Math.min(plan.length - 1, idx + 1));
      else if (k === "arrowleft") setIdx(Math.max(0, idx - 1));
      else if (k === "delete" || k === "backspace") undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item) return <p className="text-sm text-faint">No hay cuadros que marcar todavía: corre `python -m sportsan.tracking.ball_examples plan --match &lt;id&gt;`.</p>;
  const f = file(item);
  const state = answered(f, item.id);
  const mine = f.positives.find((p) => p.id === item.id);
  const pending = nextPending(plan, f, 0);
  return (
    <Card title={`Cuadro ${idx + 1} de ${plan.length} · ${item.video_id} · ${Math.floor(item.t_video / 60)}:${String(Math.floor(item.t_video % 60)).padStart(2, "0")}`}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_16rem]">
        <Tap
          folder={item.folder}
          video={item.video_id}
          t={item.t_video}
          fps={item.fps}
          fine={fine}
          onTap={mark}
          marks={mine ? [{ px: mine.px, color: mine.aerial ? "var(--color-warn)" : "var(--color-ok)" }] : []}
          hint={state === "skipped" ? "Marcado: no se ve. Un toque nuevo lo reemplaza." : state === "positive" ? `Marcado${mine?.aerial ? " en el aire" : ""}. Un toque nuevo lo reemplaza.` : undefined}
        />
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
            <button type="button" className={bigBtn} onClick={skip} data-testid="skip">
              No se ve (N)
            </button>
            <button type="button" aria-pressed={aerial} className={`${bigBtn} ${aerial ? "ring-1 ring-warn" : ""}`} onClick={() => setAerial((v) => !v)}>
              En el aire (A): {aerial ? "sí" : "no"}
            </button>
            <button type="button" aria-pressed={fine} className={`${bigBtn} ${fine ? "ring-1 ring-accent" : ""}`} onClick={() => setFineOpt(!fine)} title="Con el dedo: el primer toque acerca la imagen, el segundo marca">
              Toque preciso: {fine ? "sí" : "no"}
            </button>
            <button type="button" className={bigBtn} onClick={undo} disabled={!state}>
              Quitar la respuesta
            </button>
            <button type="button" className={bigBtn} onClick={() => setIdx(Math.max(0, idx - 1))}>
              ← Anterior
            </button>
            <button type="button" className={bigBtn} onClick={() => setIdx(Math.min(plan.length - 1, idx + 1))}>
              Siguiente →
            </button>
          </div>
          <p className="tc text-sm text-ink-2">
            {counts(f).positives} balones · {counts(f).skipped} sin verse
            <br />
            <span className="text-faint">{pending === -1 ? "Ya contestaste todos los cuadros de este partido." : `Faltan ${counts(f).missing} balones para la meta de ${GOAL_POSITIVES}.`}</span>
          </p>
          <p className="text-xs text-faint">Marca solo cuando el balón se vea bien; si dudas, «No se ve». Un balón tapado por un zapato o muy chico no sirve de ejemplo.</p>
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ tab 2: false positives
function Falsos({ trials, files, save }: { trials: Record<string, Trial>; files: Record<string, ExamplesFile>; save: (folder: string, f: ExamplesFile) => void }) {
  const folders = Object.keys(trials);
  const [folder, setFolder] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const coarse = useCoarse();
  const cur = folder ?? folders[0] ?? null;
  const trial = cur ? trials[cur] : null;
  const dets = useMemo(() => trialDetections(trial?.frames), [trial]);
  const file = (cur && files[cur]) || parseExamples(null);
  const d = dets[Math.min(idx, Math.max(0, dets.length - 1))] ?? null;

  const advance = (f: ExamplesFile) => {
    if (!trial) return;
    for (let k = 1; k <= dets.length; k++) {
      const i = (idx + k) % dets.length;
      if (!answered(f, trialId(trial.video_id, dets[i].frame))) return setIdx(i);
    }
  };
  const no = (why: Why) => {
    if (!cur || !trial || !d) return;
    const f = addNegative(file, trial.video_id, trial.fps, d, why);
    save(cur, f);
    advance(f);
  };
  const yes = () => {
    if (!cur || !trial || !d) return;
    const f = confirmDetection(file, trial.video_id, trial.fps, d);
    save(cur, f);
    advance(f);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "s") yes();
      else if (k === "z") no("zapato");
      else if (k === "c") no("cabeza");
      else if (k === "y") no("yarda");
      else if (k === "o") no("otro");
      else if (k === "arrowright") setIdx(Math.min(dets.length - 1, idx + 1));
      else if (k === "arrowleft") setIdx(Math.max(0, idx - 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!cur || !trial || !d) return <p className="text-sm text-faint">Todavía no hay una prueba. Cuando tengas tus balones marcados: `python -m sportsan.tracking.ball_examples trial --match &lt;id&gt; --video v2 --start 12:00 --seconds 45`.</p>;
  const state = answered(file, trialId(trial.video_id, d.frame));
  const pendingN = dets.filter((x) => !answered(file, trialId(trial.video_id, x.frame))).length;
  return (
    <Card title={`Marca ${idx + 1} de ${dets.length} de la prueba · ${trial.video_id} · ${Math.floor(d.frame / trial.fps / 60)}:${String(Math.floor((d.frame / trial.fps) % 60)).padStart(2, "0")}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {folders.length > 1 && (
          <select className="input" value={cur} onChange={(e) => (setFolder(e.target.value), setIdx(0))} aria-label="Partido de la prueba">
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        <span className="text-muted">El círculo naranja es lo que el programa creyó que era el balón. {pendingN} por contestar.</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_16rem]">
        <Tap
          folder={cur}
          video={trial.video_id}
          t={d.frame / trial.fps}
          fps={trial.fps}
          fine={coarse}
          marks={[{ px: [d.px, d.py], color: "#fb923c", label: `p ${d.p.toFixed(2)}` }]}
          hint={state === "negative" ? "Marcado: no es balón." : state === "positive" ? "Marcado: sí es balón." : "¿Es el balón lo que está en el círculo?"}
        />
        <div className="space-y-2">
          <button type="button" className={`${bigBtn} w-full ring-1 ring-ok`} onClick={yes} data-testid="yes">
            Sí es el balón (S)
          </button>
          <p className="pt-1 text-xs text-muted">No es balón, es:</p>
          <div className="grid grid-cols-2 gap-2">
            {WHY.map((w, i) => (
              <button key={w} type="button" className={bigBtn} onClick={() => no(w)} data-testid={`no-${w}`}>
                {WHY_LABEL[w]} ({["Z", "C", "Y", "O"][i]})
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button type="button" className={bigBtn} onClick={() => setIdx(Math.max(0, idx - 1))}>
              ← Anterior
            </button>
            <button type="button" className={bigBtn} onClick={() => setIdx(Math.min(dets.length - 1, idx + 1))}>
              Saltar →
            </button>
          </div>
          <p className="tc text-sm text-ink-2">
            {counts(file).negatives} falsos positivos marcados
            <br />
            <span className="text-faint">
              zapatos {counts(file).byWhy.zapato} · cabezas {counts(file).byWhy.cabeza} · yardas {counts(file).byWhy.yarda} · otros {counts(file).byWhy.otro}
            </span>
          </p>
          <p className="text-xs text-faint">Después: `python -m sportsan.tracking.ball_examples train --match &lt;id&gt;` reentrena con tus balones y estos falsos positivos.</p>
        </div>
      </div>
    </Card>
  );
}
