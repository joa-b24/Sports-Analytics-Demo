"use client";

import { ArrowRight, Barbell, Sparkle, Strategy, VideoCamera } from "@phosphor-icons/react";
import Link from "next/link";
import { AcwrChart, MiniBars } from "@/components/charts";
import { Locked, SkBars } from "@/components/Locked";
import { CountUp, Reveal } from "@/components/motion";
import { Card, DemoBadge, PageHeader, Section, btnPrimary } from "@/components/Shell";
import { buildDemo } from "@/lib/demo";
import { fmtNum } from "@/lib/format";
import { SAFE_ACWR, acwr, sessionLoads } from "@/lib/load";
import { countByType, mean, shotsOf } from "@/lib/stats";
import { mutate, useStore } from "@/lib/store";

const STEPS = [
  { t: "Conecta el video", d: "Crea el partido y pega el enlace de YouTube o abre el archivo original en tu computadora." },
  { t: "Etiqueta eventos", d: "Mientras lo ves: equipo, clic en la cancha y la tecla del evento." },
  { t: "Arma jugadas", d: "Convierte los momentos importantes en clips y dibuja su animación con keyframes." },
  { t: "Saca el informe", d: "Revisa los gráficos en Análisis y completa el Informe; se imprime o guarda como PDF." },
];

// Metric used for the training-load trend, in order of preference.
const LOAD_METRICS: [string, string][] = [
  ["player_load", "Carga (player load)"],
  ["total_distance_m", "Distancia total (m)"],
];

export default function Home() {
  const { matches, events, plays, sessions, anchors } = useStore();
  const rivals = matches.filter((m) => m.kind === "rival");
  const own = matches.filter((m) => m.kind === "own");
  const dates = [...new Set(sessions.map((s) => s.date))].sort();
  const empty = matches.length === 0 && sessions.length === 0;

  const kpis = [
    { label: "Partidos de rival", value: rivals.length, href: "/partidos" },
    { label: "Partidos propios", value: own.length, href: "/partidos" },
    { label: "Eventos etiquetados", value: events.length },
    { label: "Jugadas", value: plays.length },
    { label: "Sesiones con sensores", value: dates.length, href: "/entrenamientos" },
    { label: "Cuadros calibrados", value: anchors.length, href: "/calibracion" },
  ];

  // Most recent match by date; matches without date go last.
  const last = [...matches].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
  const lastEvents = last ? events.filter((e) => e.match_id === last.match_id) : [];
  const lastCounts = countByType(lastEvents, "own");

  const metricKeys = new Set(sessions.flatMap((s) => Object.keys(s.metrics)));
  const load = LOAD_METRICS.find(([k]) => metricKeys.has(k));
  const loadByDate = load ? dates.map((d) => mean(sessions.filter((s) => s.date === d).map((s) => s.metrics[load[0]] ?? null))) : [];
  const sessionsDemo = sessions.some((s) => s.is_demo);
  const ratio = acwr(sessionLoads(sessions));
  const hasRatio = ratio.players.some((p) => p.ratio !== null);
  const outOfBand = ratio.players.filter((p) => p.ratio !== null && (p.ratio < SAFE_ACWR[0] || p.ratio > SAFE_ACWR[1]));

  return (
    <>
      <PageHeader
        eyebrow="Inicio"
        title="Resumen del equipo"
        subtitle="Una sola herramienta para preparar al rival, revisar nuestros partidos y seguir la carga de entrenamiento."
      />

      {empty && (
        <Card tone="hero" className="mb-10">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="max-w-xl">
              <div className="eyebrow">Primer paso</div>
              <h2 className="mt-1 text-2xl text-ink">Esta app está vacía en este navegador</h2>
              <p className="mt-2 text-sm text-muted">
                Puedes verla con datos de ejemplo (sintéticos, marcados como tales) o crear tu primer partido en Rivales.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} onClick={() => mutate(() => buildDemo())}>
                <Sparkle size={15} />
                Cargar datos de ejemplo
              </button>
              <Link href="/partidos" className="btn">
                Crear un partido
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </Card>
      )}

      {/* Headline figures straight on the page: no boxes, the size carries the hierarchy. */}
      <Reveal className="mb-12 grid grid-cols-2 items-end gap-x-6 gap-y-7 sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k, n) => {
          const body = (
            <>
              <div className={`num ${n < 2 ? "text-7xl text-ink" : "text-6xl text-ink-2"}`}>
                <CountUp value={k.value} />
              </div>
              <div className="mt-2 flex items-center gap-1 text-xs text-muted">
                {k.label}
                {k.href && <ArrowRight size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />}
              </div>
            </>
          );
          return k.href ? (
            <Link key={k.label} href={k.href} className="group border-l border-line-soft pl-4 transition-colors hover:border-accent">
              {body}
            </Link>
          ) : (
            <div key={k.label} className="border-l border-line-soft pl-4">
              {body}
            </div>
          );
        })}
      </Reveal>

      <div className="mb-12 grid gap-5 xl:grid-cols-12">
        <Card tone="hero" className="xl:col-span-7">
          {last ? (
            <div className="flex h-full flex-col gap-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="eyebrow">Partido más reciente · {last.kind === "rival" ? "rival" : last.kind === "reference" ? "referencia" : "propio"}</span>
                  {last.is_demo && <DemoBadge />}
                </div>
                <h2 className="mt-1 text-3xl leading-tight text-ink">{last.name}</h2>
                <p className="mt-1 text-sm text-muted">
                  {last.date || "Sin fecha"} · equipo analizado: {last.focus_team}
                </p>
              </div>
              <div className="flex flex-wrap gap-x-9 gap-y-4">
                {[
                  ["Eventos", lastEvents.length],
                  ["Tiros", shotsOf(lastEvents, "own").length],
                  ["Recuperaciones", lastCounts.recovery],
                  ["Pérdidas", lastCounts.loss],
                ].map(([label, v]) => (
                  <div key={label}>
                    <div className="num text-4xl text-accent-200">
                      <CountUp value={v as number} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted">{label}</div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-faint">Tiros, recuperaciones y pérdidas de {last.focus_team}, según lo etiquetado a mano.</p>
              <div className="mt-auto">
                <Link href={`/partido?id=${last.match_id}`} className={btnPrimary}>
                  <Strategy size={15} />
                  Abrir partido
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-start gap-3">
              <span className="eyebrow">Partido más reciente</span>
              <p className="text-sm text-muted">Todavía no hay partidos. Crea el primero para empezar a etiquetar.</p>
              <Link href="/partidos" className={btnPrimary}>
                <VideoCamera size={15} />
                Crear un partido
              </Link>
            </div>
          )}
        </Card>

        <Card
          title="Carga de entrenamiento"
          note={load ? `${load[1]} · promedio del equipo por sesión` : undefined}
          className="xl:col-span-5"
          delay={90}
        >
          {load && dates.length > 0 ? (
            <>
              <MiniBars values={loadByDate} labels={dates} fmt={(v) => fmtNum(v)} />
              <div className="tc mt-2 flex justify-between text-[10px] text-faint">
                <span>{dates[0]}</span>
                <span>{dates[dates.length - 1]}</span>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                {sessionsDemo ? <DemoBadge /> : <span />}
                <Link href="/entrenamientos" className="btn btn-ghost">
                  Ver por jugadora
                  <ArrowRight size={14} />
                </Link>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">
                {sessions.length === 0
                  ? "Aún no hay sesiones. Sube el CSV de los sensores para ver la carga por sesión."
                  : "El CSV cargado no trae una columna de carga ni de distancia total para resumir."}
              </p>
              <Link href="/datos" className="btn">
                <Barbell size={15} />
                Subir CSV de sensores
              </Link>
            </div>
          )}
        </Card>
      </div>

      {hasRatio && (
        <div className="mb-12 grid gap-5 xl:grid-cols-12">
          <Card title="Carga aguda : crónica" note={`al ${ratio.asOf} · franja de referencia ${SAFE_ACWR[0]} – ${SAFE_ACWR[1]}`} className="xl:col-span-7">
            <AcwrChart players={ratio.players} band={SAFE_ACWR} />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {sessionsDemo ? <DemoBadge /> : <span />}
              <Link href="/entrenamientos" className="btn btn-ghost">
                Ver el detalle en Sesiones
                <ArrowRight size={14} />
              </Link>
            </div>
          </Card>
          <Card title="Para conversar esta semana" note="carga fuera de la franja" className="xl:col-span-5" delay={90}>
            {outOfBand.length === 0 ? (
              <p className="text-sm text-muted">Nadie está fuera de la franja de referencia.</p>
            ) : (
              <ul className="space-y-2">
                {outOfBand.map((p) => (
                  <li key={p.player_id} className="flex items-center gap-3 rounded-2xl bg-bg/60 px-3 py-2">
                    <span className="tc grid h-8 min-w-8 place-items-center rounded-full bg-warn-900 px-2 text-xs text-warn">{p.player_id}</span>
                    <span className="flex-1 text-xs text-muted">
                      {(p.ratio as number) > SAFE_ACWR[1] ? "Subió la carga respecto a sus últimas cuatro semanas" : "Bajó la carga respecto a sus últimas cuatro semanas"}
                    </span>
                    <span className="tc text-xs text-warn">{(p.ratio as number).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-pretty text-faint">
              Es una señal para preguntar, no un diagnóstico: sale solo del RPE y los minutos de cada sesión.
            </p>
          </Card>
        </div>
      )}

      <Section title="Cómo se trabaja un partido" className="mb-12">
        <ol className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((s, n) => (
            <Reveal as="li" key={s.t} delay={n * 80} className="flex gap-3">
              <span className="num text-5xl text-accent/70">{n + 1}</span>
              <span>
                <span className="block font-display text-base text-ink">{s.t}</span>
                <span className="mt-1 block text-[13px] text-pretty text-muted">{s.d}</span>
              </span>
            </Reveal>
          ))}
        </ol>
      </Section>

      <Section title="En preparación" note="de la propuesta de diseño · todavía no funcionan">
        <div className="grid gap-4 lg:grid-cols-2">
{!hasRatio && (
            <Locked
              reason="data"
              title="Carga aguda : crónica (ACWR)"
              why="Compara la carga de la última semana con la de las cuatro anteriores, por jugadora. La carga por sesión saldría del cuestionario posterior al entrenamiento que ya usa el auxiliar (RPE × minutos), pero esas respuestas todavía no se cargan en la app."
              need="subir el RPE y la duración de cada sesión en el CSV de entrenamientos durante al menos 28 días, y construir el cálculo."
            >
              <SkBars rows={5} />
            </Locked>
          )}
          <Locked
            reason="dev"
            delay={80}
            title="Bienestar y carga académica"
            why="El cuestionario previo al entrenamiento del auxiliar: sueño, estrés, fatiga y dolor muscular (1 a 7), horas de sueño, energía (1 a 10), enfermedad, ciclo menstrual, ánimo y molestias. Son datos de salud de cada jugadora y la app no tiene cuentas ni permisos para guardarlos con cuidado; la carga académica tampoco se recoge."
            need="cuentas por jugadora y base de datos (fase 2 de la arquitectura), y acordar quién ve cada respuesta."
          >
            <SkBars rows={4} />
          </Locked>
<Locked
            reason="data"
            title="Alertas de bienestar"
            why="Avisos por jugadora que cruzan la carga con el cuestionario previo (dos días seguidos con fatiga alta, dolor que sube mientras sube la carga) y con la semana de exámenes. Hoy solo existe la señal de carga de arriba, cuando hay RPE."
            need="varias semanas de respuestas reales para fijar con el cuerpo técnico qué combinación merece un aviso."
          />
          <Locked
            reason="dev"
            delay={80}
            title="Semana y próximo partido"
            why="Calendario de la semana con la carga planificada por día y la ficha del próximo rival. La planificación de sesiones y el calendario de partidos están en desarrollo."
          />
        </div>
      </Section>
    </>
  );
}
