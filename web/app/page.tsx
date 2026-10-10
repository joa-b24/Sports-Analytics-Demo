"use client";

import Link from "next/link";
import { Card, PageHeader, btnPrimary } from "@/components/Shell";
import { buildDemo } from "@/lib/demo";
import { mutate, useStore } from "@/lib/store";

export default function Home() {
  const { matches, events, plays, sessions } = useStore();
  const rivals = matches.filter((m) => m.kind === "rival");
  const own = matches.filter((m) => m.kind === "own");
  const sections = [
    {
      href: "/rivales",
      title: "Rivales · análisis previo",
      text: "Etiqueta el video de un rival, mira dónde recupera y pierde el balón, arma jugadas y saca el informe para el cuerpo técnico.",
      stat: `${rivals.length} partido(s)`,
    },
    {
      href: "/partidos",
      title: "Nuestros partidos · post-partido",
      text: "El mismo flujo sobre nuestros juegos: eventos, comparación con el rival, jugadas a revisar e informe.",
      stat: `${own.length} partido(s)`,
    },
    {
      href: "/entrenamientos",
      title: "Entrenamientos",
      text: "Carga de trabajo por jugadora a partir del CSV de los sensores: evolución por sesión y comparación con el equipo.",
      stat: `${new Set(sessions.map((s) => s.date)).size} sesión(es)`,
    },
    {
      href: "/datos",
      title: "Datos",
      text: "Formatos esperados, importar y exportar, respaldo y datos de ejemplo.",
      stat: `${events.length} eventos · ${plays.length} jugadas`,
    },
  ];
  const empty = matches.length === 0 && sessions.length === 0;

  return (
    <>
      <PageHeader
        title="Analítica de fútbol"
        subtitle="Una sola herramienta para preparar al rival, revisar nuestros partidos y seguir la carga de entrenamiento."
      />
      {empty && (
        <div className="mb-4 rounded-lg border border-slate-300 bg-white p-4 text-sm text-slate-700">
          <p>Esta app está vacía en este navegador. Puedes verla con datos de ejemplo (sintéticos, marcados como tales) o crear tu primer partido en Rivales.</p>
          <button
            type="button"
            className={`${btnPrimary} mt-3`}
            onClick={() => mutate(() => buildDemo())}
          >
            Cargar datos de ejemplo
          </button>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} className="block rounded-lg border border-slate-200 bg-white p-5 transition-colors hover:border-slate-400">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-900">{s.title}</h2>
              <span className="text-xs whitespace-nowrap text-slate-500">{s.stat}</span>
            </div>
            <p className="mt-2 text-sm text-slate-600">{s.text}</p>
          </Link>
        ))}
      </div>
      <Card title="Cómo se trabaja un partido" className="mt-4">
        <ol className="list-inside list-decimal space-y-1 text-sm text-slate-700">
          <li>Crea el partido y conecta el video (enlace de YouTube o el archivo original en tu computadora).</li>
          <li>Etiqueta eventos mientras lo ves: equipo, clic en la cancha y la tecla del evento.</li>
          <li>Convierte los momentos importantes en jugadas y, si quieres, dibuja su animación con keyframes.</li>
          <li>Revisa los gráficos en Análisis y completa el Informe; se imprime o guarda como PDF.</li>
        </ol>
      </Card>
    </>
  );
}
