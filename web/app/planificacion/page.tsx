"use client";

import { ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import { Locked, LockTag, SkBars } from "@/components/Locked";
import { Pitch } from "@/components/Pitch";
import { Reveal } from "@/components/motion";
import { PageHeader } from "@/components/Shell";

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

export default function Page() {
  return (
    <>
      <PageHeader
        title="Calendario"
      >
        <LockTag reason="dev" />
      </PageHeader>

      <Reveal className="mb-10 max-w-3xl rounded-3xl bg-warn-900/50 p-6 shadow-[inset_0_0_0_1px_rgba(224,164,88,.3)]">
        <h2 className="text-xl text-ink">Por qué no funciona todavía</h2>
        <ul className="mt-3 space-y-2 text-sm text-pretty text-muted">
          <li>
            <span className="text-ink-2">Herramienta en desarrollo.</span> El MVP cubre partidos (etiquetado, jugadas, informe) y la lectura de
            sensores. La planificación no tiene modelo de datos ni pantallas.
          </li>
          <li>
            <span className="text-ink-2">Sin cuentas.</span> La vista de entrenadora y la vista de jugadora necesitan usuarios y una base de
            datos compartida; hoy todo vive en el navegador de cada quien (fase 2 de la arquitectura).
          </li>
          <li>
            <span className="text-ink-2">Sin carga planificada.</span> La carga por bloque (duración × RPE) y el ACWR proyectado dependen del
            RPE de cada sesión. El auxiliar ya lo pregunta al terminar; falta cargarlo en la app.
          </li>
        </ul>
        <Link href="/entrenamientos" className="btn btn-ghost mt-4">
          Lo que sí hay hoy: sesiones medidas con sensores
          <ArrowRight size={14} />
        </Link>
      </Reveal>

      <div className="grid gap-4 xl:grid-cols-2">
        <Locked
          reason="dev"
          title="Semana"
          why="Siete días con el título de la sesión, su carga planificada y los exámenes de la semana."
          className="xl:col-span-2"
        >
          <div className="grid grid-cols-7 gap-2">
            {DAYS.map((d, n) => (
              <div key={d} className="space-y-2 rounded-2xl bg-surface/70 p-3">
                <span className="eyebrow text-[11px] text-faint">{d}</span>
                <span className="sk block h-2.5 w-full" />
                <span className="sk sk-shimmer block h-1.5" style={{ width: `${30 + ((n * 41) % 60)}%` }} />
              </div>
            ))}
          </div>
        </Locked>
        <Locked
          reason="dev"
          title="Bloques de la sesión"
          why="Bloques de campo, gimnasio y acondicionamiento con duración, RPE y carga; total de la sesión y ACWR proyectado."
        >
          <SkBars rows={4} />
        </Locked>
        <Locked
          reason="dev"
          delay={80}
          title="Pizarra de ejercicios"
          why="Dibujar jugadoras, conos y trayectorias sobre la cancha, animarlos y guardarlos como ejercicios reutilizables. La animación por keyframes ya existe dentro de cada partido (pestaña «Jugadas y animación»); falta llevarla a ejercicios."
        >
          <div className="mx-auto max-w-sm">
            <Pitch showDirection={false} />
          </div>
        </Locked>
        <Locked
          reason="dev"
          title="Cuestionario de bienestar"
          why="Los dos cuestionarios del auxiliar: antes de entrenar (sueño, estrés, fatiga y dolor muscular de 1 a 7, horas de sueño, energía de 1 a 10, enfermedad, ciclo menstrual, ánimo y molestias) y después (RPE de 1 a 10, autoevaluación y molestias). Para que cada jugadora responda aquí hacen falta su vista y cuentas."
          className="xl:col-span-2"
        >
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 5 }, (_, n) => (
              <span key={n} className="sk grid h-9 w-9 place-items-center rounded-full" />
            ))}
          </div>
        </Locked>
      </div>
    </>
  );
}
