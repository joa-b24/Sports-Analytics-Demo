"use client";

import { ArrowLeft } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Playground } from "@/components/playground/Playground";
import { Card, PageHeader } from "@/components/Shell";
import { setPref, useHydrated, useStore } from "@/lib/store";

// Herramientas de evaluación de un partido (/partido/playground?id=...): fuera de la franja de pasos y de Captura. Se llega
// desde el engrane del partido.
function PlaygroundPage() {
  const id = useSearchParams().get("id");
  const state = useStore();
  const hydrated = useHydrated();
  const match = state.matches.find((m) => m.match_id === id);
  useEffect(() => {
    if (id) setPref("currentMatch", id);
  }, [id]);
  if (!hydrated) return null;
  if (!match) {
    return (
      <Card>
        <p className="text-sm text-muted">
          No encuentro ese partido en este navegador.{" "}
          <Link href="/partidos" className="link">
            Volver a la lista
          </Link>
        </p>
      </Card>
    );
  }
  return (
    <div>
      <PageHeader eyebrow={match.name} title="Herramientas de evaluación" subtitle="Comprueba el balón, la posesión, los pases y los eventos detectados antes de que lleguen al informe.">
        <Link href={`/partido?id=${encodeURIComponent(match.match_id)}`} className="btn">
          <ArrowLeft size={14} />
          Volver al partido
        </Link>
      </PageHeader>
      <Playground match={match} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <PlaygroundPage />
    </Suspense>
  );
}
