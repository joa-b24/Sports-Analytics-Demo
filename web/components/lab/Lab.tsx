"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, PageHeader, btn } from "@/components/Shell";
import {
  LAB_LINES,
  SAMPLE_LOG,
  SAMPLE_REPORT_A,
  SAMPLE_REPORT_B,
  compareMetrics,
  experimentOf,
  fmtDuration,
  fmtNum,
  jsonMetrics,
  parseLog,
  parseReport,
  reportMetrics,
  type Experiment,
  type LabLine,
} from "@/lib/lab";
import { listLocal, readLocal } from "@/lib/local";
import { useStore } from "@/lib/store";

// Laboratorio: experiments of the models (uniones, balón, eventos, mediciones) read from the repository through
// app/api/local: reports (matches/*/tracking/revision/*.md), logs with % and ETA, and metrics JSON. Read-only: it does not
// touch the work table. Without the repository (deployed app) only the labelled sample is shown.

const SAMPLES: (Experiment & { text: string })[] = [
  { path: "ejemplo/informe_a.md", name: "informe_a.md", kind: "informe", line: "uniones", match: "", size: 0, mtime: 0, sample: true, text: SAMPLE_REPORT_A },
  { path: "ejemplo/informe_b.md", name: "informe_b.md", kind: "informe", line: "uniones", match: "", size: 0, mtime: 0, sample: true, text: SAMPLE_REPORT_B },
  { path: "ejemplo/progreso.log", name: "progreso.log", kind: "log", line: "balon", match: "", size: 0, mtime: 0, sample: true, text: SAMPLE_LOG },
];

async function scan(): Promise<{ list: Experiment[]; local: boolean; missing: string[] }> {
  const root = await listLocal("matches");
  if (!root) return { list: [], local: false, missing: [] };
  const dirs = ["matches", "docs/informes_agentes"];
  for (const f of root.filter((e) => e.dir)) dirs.push(`matches/${f.name}/tracking`, `matches/${f.name}/tracking/revision`);
  const missing: string[] = [];
  const out: Experiment[] = [];
  await Promise.all(
    dirs.map(async (d) => {
      const l = await listLocal(d);
      if (!l) {
        if (d === "docs/informes_agentes") missing.push(d);
        return;
      }
      for (const e of l) {
        const x = experimentOf(d, e);
        if (x) out.push(x);
      }
    }),
  );
  return { list: out.sort((a, b) => b.mtime - a.mtime), local: true, missing };
}

const ago = (ms: number) => (ms ? new Date(ms).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }) : "—");

function Spark({ v }: { v: number[] }) {
  if (v.length < 2) return null;
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * 100},${30 - (Math.min(100, y) / 100) * 28}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" className="h-8 w-40 text-accent-400" preserveAspectRatio="none" role="img" aria-label="Avance en el tiempo">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function LogView({ text }: { text: string }) {
  const p = parseLog(text);
  if (!p) return <p className="text-sm text-muted">El log está vacío.</p>;
  if (p.pct === null) return <p className="text-sm text-muted">Sin líneas de avance con % y ETA. Última línea: <span className="num">{p.lastLine}</span></p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`tag ${p.finished ? "tag-accent" : "tag-warn"}`}>{p.finished ? "terminado" : "en curso o detenido"}</span>
        <span className="text-sm text-muted">{p.stage}: <span className="num">{p.done}/{p.total}</span></span>
        <Spark v={p.series} />
      </div>
      <div className="h-2 overflow-hidden rounded bg-raised" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent" style={{ width: `${Math.min(100, p.pct)}%` }} />
      </div>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-xs text-faint">Avance</dt><dd className="num text-ink">{p.pct} %</dd></div>
        <div><dt className="text-xs text-faint">Falta (ETA)</dt><dd className="num text-ink">{p.finished ? "—" : fmtDuration(p.etaS)}</dd></div>
        <div><dt className="text-xs text-faint">Tiempo total</dt><dd className="num text-ink">{fmtDuration(p.totalS)}</dd></div>
      </dl>
      {!p.finished && <p className="text-xs text-faint">Si el avance no se mueve, revisa la fecha del archivo en la lista: puede que el proceso ya no corra.</p>}
    </div>
  );
}

function Tables({ text }: { text: string }) {
  const rep = useMemo(() => parseReport(text), [text]);
  return (
    <div className="space-y-5">
      {rep.title && <h3 className="text-base text-ink">{rep.title}</h3>}
      {rep.intro.map((l, i) => <p key={i} className="text-sm text-muted">{l}</p>)}
      {rep.tables.length === 0 && <p className="text-sm text-muted">Este informe no tiene tablas con cifras; ábrelo como texto.</p>}
      {rep.tables.map((t, i) => (
        <div key={i} className="overflow-x-auto">
          {t.section && <div className="mb-1 text-xs text-faint">{t.section}</div>}
          <table className="w-full text-left text-sm">
            <thead><tr>{t.header.map((h, j) => <th key={j} className="border-b border-line px-2 py-1 text-xs font-medium text-faint">{h}</th>)}</tr></thead>
            <tbody>
              {t.rows.map((r, k) => (
                <tr key={k} className="border-b border-line-soft">
                  {r.map((c, j) => <td key={j} className={`px-2 py-1 ${j === 0 ? "text-ink-2" : "num text-ink"}`}>{c || "—"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-xs text-faint">Texto completo</summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-raised p-3 text-xs whitespace-pre-wrap text-muted">{text}</pre>
      </details>
    </div>
  );
}

function metricsOf(x: Experiment, text: string): Map<string, number> {
  if (x.kind === "metricas") {
    try {
      return jsonMetrics(JSON.parse(text));
    } catch {
      return new Map();
    }
  }
  return reportMetrics(parseReport(text));
}

function Compare({ a, b, ta, tb }: { a: Experiment; b: Experiment; ta: string; tb: string }) {
  const rows = useMemo(() => compareMetrics(metricsOf(a, ta), metricsOf(b, tb)), [a, b, ta, tb]);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const shown = onlyDiff ? rows.filter((r) => r.delta === null || r.delta !== 0) : rows;
  return (
    <Card title="Comparar corridas" note={`${rows.length} cifras; las que faltan en un lado salen con —`}>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>A: <span className="text-ink">{a.name}</span>{a.sample && " (ejemplo)"}</span>
        <span>B: <span className="text-ink">{b.name}</span>{b.sample && " (ejemplo)"}</span>
        <label className="ml-auto flex items-center gap-1.5"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Solo lo que cambia</label>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{rows.length ? "Las cifras de las dos corridas son iguales." : "No hay cifras en común para comparar. Las dos deben ser informes con tablas o métricas JSON."}</p>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface"><tr><th className="px-2 py-1 text-xs font-medium text-faint">Cifra</th><th className="px-2 py-1 text-xs font-medium text-faint">A</th><th className="px-2 py-1 text-xs font-medium text-faint">B</th><th className="px-2 py-1 text-xs font-medium text-faint">B − A</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} className="border-b border-line-soft">
                  <td className="px-2 py-1 text-ink-2">{r.key}</td>
                  <td className="num px-2 py-1">{fmtNum(r.a)}</td>
                  <td className="num px-2 py-1">{fmtNum(r.b)}</td>
                  <td className={`num px-2 py-1 ${r.delta === null ? "text-faint" : r.delta === 0 ? "text-muted" : "text-ink"}`}>{r.delta === null ? "—" : `${r.delta > 0 ? "+" : ""}${fmtNum(r.delta)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-faint">Sin interpretar: si subir o bajar es mejor depende de la cifra (pureza sube = bien, trabajo a mano baja = bien).</p>
    </Card>
  );
}

// The evaluation tools live per match (ball, possession, passes, by player, events): one link for each match with a folder.
function EvaluationTools() {
  const { matches } = useStore();
  const withFolder = matches.filter((m) => m.folder);
  return (
    <Card title="Herramientas de evaluación" note="por partido">
      <p className="mb-3 text-sm text-muted">Balón, posesión, pases, pases y sprints por jugadora y eventos detectados, para comprobarlos contra el video. Elige el partido:</p>
      {withFolder.length === 0 ? (
        <p className="text-sm text-faint">Ningún partido tiene carpeta todavía.</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {withFolder.map((m) => (
            <li key={m.match_id}>
              <Link className="btn" href={`/partido/playground?id=${encodeURIComponent(m.match_id)}`}>
                {m.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Lab() {
  const [state, setState] = useState<{ list: Experiment[]; local: boolean | null; missing: string[] }>({ list: [], local: null, missing: [] });
  const [line, setLine] = useState<LabLine | "todas">("todas");
  const [showSample, setShowSample] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [texts, setTexts] = useState<Record<string, string | null>>({});
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    void scan().then((s) => live && setState({ ...s, local: s.local }));
    return () => {
      live = false;
    };
  }, [tick]);

  const all: Experiment[] = useMemo(() => (showSample ? [...SAMPLES, ...state.list] : state.list), [showSample, state.list]);
  const shown = all.filter((x) => line === "todas" || x.line === line);
  const byPath = useMemo(() => new Map(all.map((x) => [x.path, x])), [all]);
  const sel = picked.map((p) => byPath.get(p)).filter((x): x is Experiment => !!x);

  // Text of each picked file; a running log is read again every 5 s.
  const running = sel.some((x) => x.kind === "log" && !x.sample);
  useEffect(() => {
    let live = true;
    const load = async () => {
      for (const x of sel) {
        const sample = SAMPLES.find((s) => s.path === x.path);
        const t = sample ? sample.text : await readLocal(x.path);
        if (live) setTexts((prev) => (prev[x.path] === t ? prev : { ...prev, [x.path]: t }));
      }
    };
    void load();
    const id = running ? setInterval(() => void load(), 5000) : null;
    return () => {
      live = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked.join("|"), running, byPath]);

  const toggle = (p: string) => setPicked((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur.slice(-1), p]));
  const comparable = sel.length === 2 && sel.every((x) => x.kind !== "log") && sel.every((x) => typeof texts[x.path] === "string");

  return (
    <>
      <PageHeader eyebrow="Modelos" title="Laboratorio" subtitle="Experimentos de uniones, balón, eventos y mediciones: sus informes, el avance de los procesos largos y la comparación entre corridas. Solo lectura.">
        <button className={btn} onClick={refresh}>Actualizar</button>
      </PageHeader>

      <div className="mb-4">
        <EvaluationTools />
      </div>

      {state.local === false && (
        <p className="mb-4 rounded border border-line bg-surface p-3 text-sm text-muted">
          No se alcanza el repositorio: el Laboratorio lee los archivos de esta computadora y solo funciona con la app corriendo aquí (<span className="num">npm run dev</span>). Puedes ver cómo se ve con el ejemplo.
        </p>
      )}
      {state.missing.length > 0 && state.local && (
        <p className="mb-4 text-xs text-faint">No se pudo leer <span className="num">docs/informes_agentes</span>: la app solo puede leer <span className="num">matches/</span> (ver propuesta en el informe de L5).</p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="seg" role="group" aria-label="Línea">
          {[{ id: "todas" as const, label: "Todas" }, ...LAB_LINES].map((l) => (
            <button key={l.id} className="seg-opt" aria-pressed={line === l.id} onClick={() => setLine(l.id)}>{l.label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={showSample} onChange={(e) => setShowSample(e.target.checked)} /> Mostrar datos de ejemplo</label>
        <span className="ml-auto text-xs text-faint">Marca hasta dos para compararlas</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card title="Experimentos" note={state.local === null ? "leyendo…" : `${shown.length} archivos`}>
          {shown.length === 0 ? (
            <p className="text-sm text-muted">{state.local === null ? "Leyendo la carpeta…" : "No hay experimentos en esta línea."}</p>
          ) : (
            <ul className="max-h-[36rem] divide-y divide-line-soft overflow-auto">
              {shown.map((x) => (
                <li key={x.path} className="flex items-start gap-2 py-2">
                  <input type="checkbox" className="mt-1" checked={picked.includes(x.path)} onChange={() => toggle(x.path)} aria-label={`Elegir ${x.name}`} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => setPicked((cur) => (cur[cur.length - 1] === x.path ? cur : [...cur.filter((p) => p !== x.path).slice(-1), x.path]))}>
                    <div className="truncate text-sm text-ink">{x.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-faint">
                      {x.sample && <span className="tag tag-warn">ejemplo</span>}
                      <span className="tag">{x.kind === "log" ? "log" : x.kind === "metricas" ? "métricas" : "informe"}</span>
                      <span className="tag tag-outline">{LAB_LINES.find((l) => l.id === x.line)?.label}</span>
                      {x.match && <span className="truncate">{x.match}</span>}
                      <span>{ago(x.mtime)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          {sel.length === 0 && <Card title="Detalle"><p className="text-sm text-muted">Elige un experimento de la lista para ver su informe, su avance o sus cifras.</p></Card>}
          {sel.map((x) => {
            const t = texts[x.path];
            return (
              <Card key={x.path} title={x.name} note={x.sample ? "EJEMPLO, no son datos reales" : x.path}>
                {t === undefined ? <p className="text-sm text-muted">Leyendo…</p>
                  : t === null ? <p className="text-sm text-muted">No se pudo leer el archivo.</p>
                  : x.kind === "log" ? <LogView text={t} />
                  : x.kind === "metricas" ? <MetricsView text={t} />
                  : <Tables text={t} />}
              </Card>
            );
          })}
          {comparable && <Compare a={sel[0]} b={sel[1]} ta={texts[sel[0].path] as string} tb={texts[sel[1].path] as string} />}
          {sel.length === 2 && !comparable && <p className="text-xs text-faint">Para comparar, elige dos informes o dos archivos de métricas (los logs solo muestran avance).</p>}
        </div>
      </div>
    </>
  );
}

function MetricsView({ text }: { text: string }) {
  const m = useMemo(() => {
    try {
      return [...jsonMetrics(JSON.parse(text))];
    } catch {
      return null;
    }
  }, [text]);
  if (!m) return <p className="text-sm text-muted">El archivo no es un JSON válido.</p>;
  return (
    <table className="w-full text-left text-sm">
      <tbody>
        {m.map(([k, v]) => (
          <tr key={k} className="border-b border-line-soft"><td className="px-2 py-1 text-ink-2">{k}</td><td className="num px-2 py-1">{fmtNum(v)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
