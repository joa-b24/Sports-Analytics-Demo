"use client";

import { UploadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { AcwrChart, LineChart } from "@/components/charts";
import { Locked, SkBars } from "@/components/Locked";
import { CountUp, Reveal } from "@/components/motion";
import { COLORS } from "@/components/Pitch";
import { Card, DemoBadge, PageHeader, Section, btnPrimary, input } from "@/components/Shell";
import { fmtNum } from "@/lib/format";
import { LOAD_LABELS, SAFE_ACWR, WELLNESS, acwr, loadMethod, sessionLoads } from "@/lib/load";
import { mean } from "@/lib/stats";
import { useStore } from "@/lib/store";
import type { SessionRow } from "@/lib/types";

const METRIC_LABELS: Record<string, string> = {
  duration_min: "Duración (min)",
  total_distance_m: "Distancia total (m)",
  hsr_distance_m: "Distancia a alta velocidad (m)",
  sprints: "Sprints",
  max_speed_kmh: "Velocidad máxima (km/h)",
  player_load: "Carga (player load)",
  hr_avg: "FC media (lpm)",
  hr_max: "FC máxima (lpm)",
  // Computed here, not a column of the CSV.
  session_load: "Carga de la sesión",
  relative_effort: "Esfuerzo relativo (Strava)",
  football: "Sesión de fútbol (1 = sí)",
  // Questionnaire columns, when the staff adds them to the same CSV (docs/preguntas_cuerpo_tecnico.md).
  rpe: "Esfuerzo percibido (RPE, 1–10)",
  sleep_hours: "Horas de sueño",
  sleep_q: "Sueño (1–7)",
  stress: "Estrés (1–7)",
  fatigue: "Fatiga (1–7)",
  soreness: "Dolor muscular (1–7)",
  energy: "Energía (1–10)",
};
const label = (m: string) => METRIC_LABELS[m] ?? m;

const EYEBROW = "Entrenamiento · sensores";
const SUBTITLE = "Carga de trabajo por jugadora a partir de los datos de sensores (GPS, frecuencia cardiaca).";

export default function Page() {
  const { sessions: stored } = useStore();
  // Session load comes from RPE x minutes or, without RPE, from Strava's relative effort. Every session counts for the
  // load (a run too); the charts of the other metrics only show football sessions when the file says which they are.
  const method = loadMethod(stored);
  const loads = sessionLoads(stored, method ?? "rpe");
  const hasRpe = method !== null;
  const withLoad: SessionRow[] = hasRpe ? stored.map((s, i) => ({ ...s, metrics: { ...s.metrics, session_load: loads[i].load } })) : stored;
  const sessions = withLoad.some((s) => s.metrics.football != null) ? withLoad.filter((s) => s.metrics.football !== 0) : withLoad;
  const ratio = acwr(loads);
  const borrowed = loads.filter((l) => l.load !== null && l.durationFrom === "session").length;
  const wellness = WELLNESS.filter((w) => stored.some((s) => s.metrics[w.key] !== null && s.metrics[w.key] !== undefined));
  const metrics = [...new Set(sessions.flatMap((s) => Object.keys(s.metrics)))];
  const players = [...new Set(sessions.map((s) => s.player_id))].sort();
  const dates = [...new Set(sessions.map((s) => s.date))].sort();
  const [metricSel, setMetric] = useState("");
  const [playerSel, setPlayer] = useState("");
  const metric = metrics.includes(metricSel) ? metricSel : (metrics.find((m) => m === "total_distance_m") ?? metrics[0]);
  const player = players.includes(playerSel) ? playerSel : players[0];

  if (sessions.length === 0) {
    return (
      <>
        <PageHeader eyebrow={EYEBROW} title="Sesiones" subtitle={SUBTITLE} />
        <Card tone="hero" className="max-w-2xl">
          <h2 className="text-2xl text-ink">Aún no hay sesiones</h2>
          <p className="mt-2 text-sm text-muted">
            Sube el CSV exportado de los sensores en Carga de datos (ahí está el formato esperado) o carga los datos de ejemplo.
          </p>
          <Link href="/datos" className={`${btnPrimary} mt-4`}>
            <UploadSimple size={15} />
            Ir a Carga de datos
          </Link>
        </Card>
      </>
    );
  }

  const digits = metric === "max_speed_kmh" ? 1 : 0;
  // One value per player and date: mean if the player has several rows that day.
  const value = (p: string, d: string) => mean(sessions.filter((s) => s.player_id === p && s.date === d).map((s) => s.metrics[metric] ?? null));
  const perPlayer = players
    .map((p) => ({ p, v: mean(sessions.filter((s) => s.player_id === p).map((s) => s.metrics[metric] ?? null)) }))
    .sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
  const max = Math.max(1, ...perPlayer.map((x) => x.v ?? 0));
  const teamMean = mean(perPlayer.map((x) => x.v));
  const isDemo = sessions.some((s) => s.is_demo);
  const lastWellness =
    [...stored]
      .filter((s) => s.player_id === player && wellness.some((w) => s.metrics[w.key] !== null && s.metrics[w.key] !== undefined))
      .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;

  return (
    <>
      <PageHeader eyebrow={EYEBROW} title="Sesiones" subtitle={SUBTITLE}>
        {isDemo && <DemoBadge />}
        <label className="flex items-center gap-2 text-xs text-muted">
          Métrica
          <select className={input} value={metric} onChange={(e) => setMetric(e.target.value)}>
            {metrics.map((m) => (
              <option key={m} value={m}>
                {label(m)}
              </option>
            ))}
          </select>
        </label>
      </PageHeader>

      <Reveal className="mb-10 flex flex-wrap items-end gap-x-12 gap-y-6">
        <div>
          <div className="num text-7xl text-ink">{teamMean === null ? "–" : <CountUp value={teamMean} digits={digits} />}</div>
          <div className="mt-2 text-xs text-muted">{label(metric)} · promedio del equipo por sesión</div>
        </div>
        <div className="border-l border-line-soft pl-4">
          <div className="num text-5xl text-ink-2">
            <CountUp value={dates.length} />
          </div>
          <div className="mt-2 text-xs text-muted">sesiones</div>
        </div>
        <div className="border-l border-line-soft pl-4">
          <div className="num text-5xl text-ink-2">
            <CountUp value={players.length} />
          </div>
          <div className="mt-2 text-xs text-muted">jugadoras</div>
        </div>
        <div className="tc pb-1 text-xs text-faint">
          {dates[0]} → {dates[dates.length - 1]}
        </div>
      </Reveal>

      <div className="grid gap-5 xl:grid-cols-12">
        <Card title="Por jugadora" note="promedio por sesión · clic para ver su evolución" className="xl:col-span-5">
          <div className="space-y-0.5">
            {perPlayer.map(({ p, v }, n) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlayer(p)}
                aria-pressed={p === player}
                title={`${p}: ${fmtNum(v, digits)}`}
                className={`grid w-full grid-cols-[3.5rem_1fr] items-center gap-3 rounded-full px-3 py-1.5 text-left transition-colors ${
                  p === player ? "bg-accent/15 shadow-[inset_0_0_0_1px_rgba(74,114,255,.5)]" : "hover:bg-raised/60"
                }`}
              >
                <span className={`tc text-xs ${p === player ? "text-accent-100" : "text-ink-2"}`}>{p}</span>
                <span className="flex items-center gap-2">
                  <span
                    className={`a-bar h-2 rounded-full ${p === player ? "" : "saturate-50"}`}
                    style={{ width: `${((v ?? 0) / max) * 78}%`, background: COLORS.own, "--i": n } as React.CSSProperties}
                  />
                  <span className="tc text-[11px] text-muted">{fmtNum(v, digits)}</span>
                </span>
              </button>
            ))}
          </div>
        </Card>

        <Card
          title={
            <>
              <span className="tc text-accent-200">{player}</span> · evolución
            </>
          }
          note={label(metric)}
          className="xl:col-span-7"
          delay={90}
        >
          <LineChart
            key={`${player}-${metric}`}
            labels={dates}
            series={dates.map((d) => value(player, d))}
            reference={dates.map((d) => mean(players.map((p) => value(p, d))))}
            seriesLabel={player}
            referenceLabel="Promedio del equipo"
            fmt={(v) => fmtNum(v, digits)}
          />
        </Card>

        <Card title="Tabla por sesión" note={label(metric)} className="xl:col-span-12">
          <div className="max-h-80 overflow-auto">
            <table className="table-nocturne w-full text-left text-xs">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  <th className="py-1.5 pr-3">Jugadora</th>
                  {dates.map((d) => (
                    <th key={d} className="py-1.5 pr-3 whitespace-nowrap">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p} className="border-t border-line-soft">
                    <td className="tc py-1.5 pr-3 text-ink">{p}</td>
                    {dates.map((d) => (
                      <td key={d} className="tc py-1.5 pr-3 text-ink-2">
                        {fmtNum(value(p, d), digits)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {(hasRpe || wellness.length > 0) && (
        <Section title="Cuestionarios" note="lo que responde cada jugadora antes y después de entrenar" className="mt-12">
          <div className="grid gap-5 xl:grid-cols-2">
            {hasRpe && (
              <Card title="Carga aguda : crónica" note={ratio.asOf ? `al ${ratio.asOf} · franja de referencia ${SAFE_ACWR[0]} – ${SAFE_ACWR[1]}` : undefined}>
                <AcwrChart players={ratio.players} band={SAFE_ACWR} onPick={setPlayer} />
                <p className="mt-4 text-xs text-pretty text-faint">
                  Carga de la sesión = {method ? LOAD_LABELS[method] : ""}{method === "relative_effort" ? " (sale del tiempo en cada zona de frecuencia cardiaca; Strava no publica la fórmula)" : ""}. La razón compara los últimos 7 días con la media semanal de los últimos 28. La franja
                  es una referencia habitual para conversar con la jugadora, no un límite médico.
                  {borrowed > 0 &&
                    ` En ${borrowed} fila(s) sin duración propia se usó la de la sesión (mediana de quienes sí la registraron).`}
                </p>
              </Card>
            )}
            {wellness.length > 0 && (
              <Card
                title={
                  <>
                    <span className="tc text-accent-200">{player}</span> · cómo llegó
                  </>
                }
                note={`última sesión con respuesta · ${lastWellness?.date ?? "sin respuestas"}`}
                delay={90}
              >
                {!lastWellness ? (
                  <p className="text-sm text-faint">Esta jugadora no tiene respuestas del cuestionario previo.</p>
                ) : (
                  <div className="space-y-3">
                    {wellness.map((w, n) => {
                      const v = lastWellness.metrics[w.key] ?? null;
                      const team = mean(stored.filter((s) => s.date === lastWellness.date).map((s) => s.metrics[w.key] ?? null));
                      // Worst third of the scale, in whichever direction is worse for that question.
                      const poor = v !== null && (w.worseHigh ? v > (w.max * 2) / 3 : v <= w.max / 3);
                      return (
                        <div key={w.key} className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-3" title={`${w.label}: ${v ?? "sin respuesta"} de ${w.max}`}>
                          <span className="text-xs text-ink-2">{w.label}</span>
                          <span className="relative h-2 rounded-full bg-bg/70">
                            {v !== null && (
                              <span
                                className="a-bar absolute inset-y-0 left-0 rounded-full"
                                style={{ width: `${(v / w.max) * 100}%`, background: poor ? "var(--color-warn)" : "var(--color-own)", "--i": n } as React.CSSProperties}
                              />
                            )}
                            {team !== null && <span className="absolute -top-1 -bottom-1 w-0.5 bg-ink-2" style={{ left: `${(team / w.max) * 100}%` }} />}
                          </span>
                          <span className={`tc text-right text-xs ${poor ? "text-warn" : "text-muted"}`}>{v === null ? "–" : `${v} / ${w.max}`}</span>
                        </div>
                      );
                    })}
                    {lastWellness.metrics.sleep_hours != null && (
                      <p className="text-xs text-muted">
                        Durmió <span className="tc text-ink-2">{lastWellness.metrics.sleep_hours} h</span>.
                      </p>
                    )}
                  </div>
                )}
                <p className="mt-4 text-xs text-pretty text-faint">
                  Escalas del cuestionario del auxiliar: en sueño, estrés, fatiga y dolor muscular 1 es lo mejor y 7 lo peor; en energía, 10
                  es lo mejor. La marca vertical es la media del equipo ese día; en ámbar, el tercio peor de la escala. Enfermedad, periodo
                  menstrual, ánimo y molestias no se cargan en la app.
                </p>
              </Card>
            )}
          </div>
        </Section>
      )}

      <Section title="En preparación" note="de la propuesta de diseño · todavía no funcionan" className="mt-12">
        <div className="grid gap-4 lg:grid-cols-2">
          <Locked
            reason="data"
            title="Tiempo en zonas de FC e intensidad por minuto"
            why="El CSV de sensores trae un valor por jugadora y sesión, no la serie minuto a minuto. Sin la serie no se puede repartir el tiempo por zona de frecuencia cardiaca ni dibujar la intensidad a lo largo de la sesión."
            need="exportar del sensor la serie temporal (FIT o CSV por segundo) y la FC máxima de cada jugadora."
          >
            <SkBars rows={5} />
          </Locked>
{!hasRpe && (
            <Locked
              reason="data"
              delay={80}
              title="Carga aguda : crónica y alertas"
              why="La carga de cada sesión sale del cuestionario posterior al entrenamiento (RPE × minutos) o del esfuerzo relativo de Strava. Este CSV no trae ni rpe ni relative_effort, así que no hay con qué calcularla."
              need="añadir las columnas rpe y duration_min (o relative_effort, que trae el sessions.csv de Strava); la razón aparece con cuatro semanas de historial."
            >
              <SkBars rows={5} />
            </Locked>
          )}
        </div>
      </Section>
    </>
  );
}
