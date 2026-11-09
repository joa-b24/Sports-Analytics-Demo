"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Card } from "@/components/Shell";
import { useFixedParts } from "@/lib/fixed";
import { possessionIntervals } from "@/lib/possession";
import { segmentsFromMarks, type Segment } from "@/lib/segments";
import { useStore } from "@/lib/store";
import { PARAM_FIELDS } from "@/lib/playgroundPossession";
import { possessionParamsOf, techSummary } from "@/lib/tech";
import { trackingParamsOf } from "@/lib/techTracking";
import type { Match } from "@/lib/types";
import { matchVideos, videoOf } from "@/lib/videos";
import type { PlaygroundCtx } from "./context";
import { HealthBoard } from "./HealthBoard";
import { PLAYGROUND_SECTIONS } from "./sections";

const fmt = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 2 });

// Parameters in force, read only: they are changed in Configuración del partido > Detalles técnicos.
function ParamsReadout({ match, params }: { match: Match; params: ReturnType<typeof possessionParamsOf> }) {
  return (
    <details className="card !p-3 text-xs">
      <summary className="cursor-pointer text-muted">
        <span className="text-ink">Parámetros vigentes.</span> {techSummary(match)}.
      </summary>
      <dl className="m-0 mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
        {PARAM_FIELDS.map((f) => (
          <div key={f.key} className="flex items-baseline justify-between gap-2 border-b border-line-soft py-0.5">
            <dt className="text-faint">{f.label}</dt>
            <dd className="tc m-0 text-ink">
              {fmt(params[f.key] as number)} {f.unit}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 mt-2 text-faint">
        Solo lectura.{" "}
        <Link className="link" href={`/partido?id=${encodeURIComponent(match.match_id)}&detalles=tecnicos`}>
          Cambiarlos en Detalles técnicos
        </Link>
        : lo que cambies ahí cambia también el Informe.
      </p>
    </details>
  );
}

// The evaluation tools of a match (route /partido/playground): where the analyst checks the ball, the possession, the
// passes and the detected events before they feed the report. A board of traffic lights on top says how much can be
// trusted; the sections (sections.tsx) are the tools. Parameters are the match's (lib/tech.ts) and are read only here.
export function Playground({ match }: { match: Match }) {
  const router = useRouter();
  const state = useStore();
  const [section, setSection] = useState(PLAYGROUND_SECTIONS[0].id);
  const [version, setVersion] = useState(0);
  const folder = match.folder;
  const videos = useMemo(() => matchVideos(match), [match]);
  const videoIds = useMemo(() => videos.map((v) => v.video_id), [videos]);
  const fixed = useFixedParts(folder, videoIds);
  const params = useMemo(() => possessionParamsOf(match), [match]);
  const segmentsByVideo = useMemo<Record<string, Segment[]>>(
    () => Object.fromEntries(videos.map((v) => [v.video_id, segmentsFromMarks(state.segments.filter((g) => g.match_id === match.match_id && videoOf(g) === v.video_id))])),
    [videos, state.segments, match.match_id],
  );
  const result = useMemo(() => (fixed && fixed.parts.length > 0 ? possessionIntervals(fixed.parts, segmentsByVideo, params, undefined, trackingParamsOf(match).ballJumpMs) : null), [fixed, segmentsByVideo, params, match]);
  const notifyReview = useCallback(() => setVersion((v) => v + 1), []);

  if (!folder) {
    return (
      <Card title="Falta la carpeta del partido">
        <p className="text-sm text-muted">
          Las herramientas de evaluación trabajan con los archivos de <code>matches/&lt;carpeta&gt;/</code>. Indica la carpeta de este partido en el engrane del partido.
        </p>
      </Card>
    );
  }
  const ctx: PlaygroundCtx = { match, folder, videos, videoIds, fixed, segmentsByVideo, params, result, notifyReview };
  const current = PLAYGROUND_SECTIONS.find((s) => s.id === section) ?? PLAYGROUND_SECTIONS[0];
  return (
    <div className="space-y-4">
      <HealthBoard ctx={ctx} version={version} />
      <ParamsReadout match={match} params={params} />
      <div className="seg w-fit" role="group" aria-label="Herramienta de evaluación">
        {PLAYGROUND_SECTIONS.map((s) => (
          <button key={s.id} type="button" className="seg-opt" aria-pressed={current.id === s.id} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {current.render(ctx, { openBallStep: () => router.push(`/partido?id=${encodeURIComponent(match.match_id)}&modo=captura&paso=ball`) })}
    </div>
  );
}
