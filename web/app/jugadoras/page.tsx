"use client";

import { ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import { Locked, SkBars, SkRadar, SkTiles } from "@/components/Locked";
import { Pitch } from "@/components/Pitch";
import { RosterCard } from "@/components/RosterCard";
import { Reveal } from "@/components/motion";
import { Card, DemoBadge, PageHeader, Section } from "@/components/Shell";
import { useStore } from "@/lib/store";

export default function Page() {
  const { sessions, events } = useStore();

  // The only player data today: ids that appear in sensor rows and in tagged events. Nothing else is known about them.
  const known = new Map<string, { sessions: number; events: number; demo: boolean }>();
  const entry = (id: string) => {
    if (!known.has(id)) known.set(id, { sessions: 0, events: 0, demo: false });
    return known.get(id)!;
  };
  for (const s of sessions) {
    const k = entry(s.player_id);
    k.sessions++;
    if (s.is_demo) k.demo = true;
  }
  for (const e of events) {
    if (!e.player_id) continue;
    const k = entry(e.player_id);
    k.events++;
    if (e.event_id.startsWith("demo_")) k.demo = true;
  }
  const players = [...known.entries()].sort((a, b) => a[0].localeCompare(b[0], "es", { numeric: true }));
  const anyDemo = players.some(([, k]) => k.demo);

  return (
    <>
      <PageHeader
        eyebrow="Análisis individual"
        title="Jugadoras"
        subtitle="La plantilla, lo que ya se sabe de cada jugadora y lo que falta para su perfil."
      />

      <RosterCard />

      <Card
        title="Identificadores con datos"
        note={players.length > 0 ? `${players.length} · salen del CSV de sensores y de los eventos etiquetados` : undefined}
        className="mb-12"
      >
        {players.length === 0 ? (
          <p className="text-sm text-muted">
            Ninguna jugadora tiene datos todavía. Aparecerán aquí cuando subas sesiones de sensores o anotes el número de jugadora al etiquetar
            eventos.
          </p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-2">
              {players.map(([id, k], n) => (
                <Reveal as="li" key={id} delay={Math.min(n, 14) * 30}>
                  <span className="flex items-center gap-3 rounded-full bg-bg/60 py-1.5 pr-4 pl-1.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
                    <span className="tc grid h-8 min-w-8 place-items-center rounded-full bg-accent-900 px-2 text-xs text-accent-200">{id}</span>
                    <span className="text-[11px] leading-tight text-muted">
                      <span className="block">{k.sessions} filas de sensores</span>
                      <span className="block">{k.events} eventos</span>
                    </span>
                  </span>
                </Reveal>
              ))}
            </ul>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              {anyDemo ? <DemoBadge /> : <span />}
              <Link href="/entrenamientos" className="btn btn-ghost">
                Ver evolución por jugadora en Sesiones
                <ArrowRight size={14} />
              </Link>
            </div>
          </>
        )}
      </Card>

      <Section title="En preparación" note="de la propuesta de diseño · todavía no funcionan">
        <div className="grid gap-4 xl:grid-cols-2">
          <Locked
            reason="data"
            title="Perfil de rendimiento"
            why="Ficha de la jugadora (foto, posición, edad, estatura, peso, minutos) con su radar frente al promedio de la plantilla e indicadores físicos, tácticos y biométricos. No hay plantilla cargada: hoy solo existen los identificadores de arriba."
            need="la plantilla de jugadoras (Configuración) y enlazar cada identificador de sensor y dorsal con una persona."
            className="xl:row-span-2"
          >
            <div className="grid items-center gap-5 sm:grid-cols-[auto_1fr]">
              <SkRadar />
              <SkBars rows={6} />
            </div>
            <div className="mt-5">
              <SkTiles n={4} />
            </div>
          </Locked>
          <Locked
            reason="data"
            delay={80}
            title="Comparar jugadoras"
            why="Hasta cuatro jugadoras lado a lado, filtradas por posición, con sus perfiles superpuestos en percentiles. Sin posiciones ni una plantilla completa no hay contra qué calcular el percentil."
            need="plantilla con posición y varias semanas de sesiones de todas las jugadoras."
          >
            <SkTiles n={4} />
          </Locked>
          <Locked
            reason="tracking"
            delay={140}
            title="Mapa de calor y clips por jugadora"
            why="Dónde se mueve cada jugadora y un clic desde cada indicador al momento del video. Requiere seguir a cada jugadora en el video; el tracking se está reescribiendo (pasos A3 y A4) y además ninguna cámara cubre toda la cancha."
          >
            <div className="mx-auto max-w-xs">
              <Pitch showDirection={false} />
            </div>
          </Locked>
        </div>
      </Section>
    </>
  );
}
