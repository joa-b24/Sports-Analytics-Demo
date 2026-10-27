"use client";

import { Warning } from "@phosphor-icons/react";
import { Card } from "@/components/Shell";
import { DETECTED_TYPES, type DetectedType } from "@/lib/eventDetect";
import { TYPE_LABEL, VERDICT_LABEL, coverageTotal, type PartBall, type TypeStats } from "@/lib/eventReview";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(100 * v)} %`);
const VERDICT_CLS = { pass: "tag tag-accent", redefine: "tag tag-warn", few: "tag tag-outline" } as const;
const COLS = "grid-cols-[1fr_2rem_2.2rem_2.6rem_2.6rem_9.6rem]";

// One row per type: how many came out, how many were reviewed, precision on what was reviewed, recall inside the windows
// reviewed in full, and the verdict. Click to work on that type.
export function EventsStatsCard({ stats, active, onPick, minReviews }: { stats: TypeStats[]; active: DetectedType; onPick: (t: DetectedType) => void; minReviews: number }) {
  return (
    <Card title="Por tipo de evento" note={`mínimo ${minReviews} revisiones`} className="flex h-full flex-col !p-3">
      <div className={`grid ${COLS} gap-x-2 border-b border-line-soft pb-1 text-[11px] text-faint`} role="row">
        <span>Tipo</span>
        <span className="text-right" title="Detecciones">Det.</span>
        <span className="text-right" title="Revisadas con la versión actual de la regla">Rev.</span>
        <span className="text-right" title="Correctas sobre lo revisado">Prec.</span>
        <span className="text-right" title="Solo en ventanas revisadas completas">Rec.</span>
        <span>Veredicto</span>
      </div>
      <div className="min-h-0 flex-1">
        {DETECTED_TYPES.map((t) => {
          const s = stats.find((x) => x.type === t) as TypeStats;
          const warn = [s.stale > 0 ? `${s.stale} revisiones de una versión anterior de la regla ya no cuentan` : "", s.orphan > 0 ? `${s.orphan} revisiones son de detecciones que ya no salen con los datos actuales` : ""].filter(Boolean).join("; ");
          return (
            <button
              key={t}
              type="button"
              aria-pressed={active === t}
              onClick={() => onPick(t)}
              className={`grid w-full ${COLS} items-center gap-x-2 border-b border-line-soft px-0 py-1 text-left text-xs hover:bg-raised ${active === t ? "bg-raised" : ""}`}
            >
              <span className="truncate text-ink">
                {TYPE_LABEL[t]}
                {warn && (
                  <span className="ml-1 text-warn" title={warn} aria-label={warn}>
                    ⚠
                  </span>
                )}
              </span>
              <span className="tc text-right text-muted">{s.detected}</span>
              <span className="tc text-right text-muted">{s.reviewed}</span>
              <span className="tc text-right text-ink">{pct(s.precision)}</span>
              <span
                className="tc text-right text-muted"
                title={s.truth > 0 ? `${s.found} de ${s.truth} en ventanas completas${s.windowPending ? `; faltan ${s.windowPending} detecciones por revisar en ellas` : ""}` : "Sin ventanas revisadas con eventos de este tipo"}
              >
                {pct(s.recall)}
                {s.windowPending > 0 ? "*" : ""}
              </span>
              <span className={`${VERDICT_CLS[s.verdict]} justify-self-start whitespace-nowrap`}>{VERDICT_LABEL[s.verdict]}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 shrink-0 text-[10px] text-faint">
        Prec. = correctas / revisadas, no del partido. Rec. = encontradas / (encontradas + añadidas a mano), solo en ventanas completas; * = hay detecciones sin revisar en ellas.
      </p>
    </Card>
  );
}

// What the numbers rest on: the ball measured and the possession reviewed. They are being verified first, so every
// figure of this section depends on them.
export function PrerequisitesBar({
  cover, possession, onDetail,
}: {
  cover: PartBall[];
  possession: { reviewed: number; accuracy: number | null; intervals: number };
  onDetail: () => void;
}) {
  const total = coverageTotal(cover);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line-soft bg-surface px-3 py-1.5 text-xs text-muted" role="note">
      <Warning size={14} className="text-warn" />
      <span className="text-ink">Las cifras dependen de un balón y una posesión aún sin verificar.</span>
      <span>
        Balón medido en <span className="tc text-ink">{pct(total.share)}</span> del juego
      </span>
      <span>
        Posesión revisada: <span className="tc text-ink">{possession.reviewed}</span> de {possession.intervals} intervalos
        {possession.accuracy !== null ? (
          <>
            {" "}
            (acierto <span className="tc text-ink">{pct(possession.accuracy)}</span>)
          </>
        ) : (
          ""
        )}
      </span>
      <button type="button" className="btn btn-ghost !px-2 !py-0.5 text-[11px]" onClick={onDetail}>
        Detalle por parte
      </button>
    </div>
  );
}

export function CoverageDetail({ cover }: { cover: PartBall[] }) {
  const cols = "grid-cols-[4rem_1fr_4.5rem_4.5rem_6rem]";
  return (
    <div className="text-xs">
      <p className="mb-3 text-pretty text-muted">
        Cobertura del balón por parte: el tiempo de juego con una marca medida (a mano o del tracker) a menos de 2 s. Las posiciones interpoladas no cuentan como medidas.
      </p>
      <div className={`grid ${cols} gap-x-3 border-b border-line-soft pb-1 text-faint`}>
        <span>Video</span>
        <span>Parte (cuadros)</span>
        <span className="text-right">Juego</span>
        <span className="text-right">Con balón</span>
        <span className="text-right">A mano / tracker</span>
      </div>
      {cover.map((c) => (
        <div key={`${c.video_id}|${c.start_frame}`} className={`grid ${cols} gap-x-3 border-b border-line-soft py-1`}>
          <span className="text-ink">{c.video_id}</span>
          <span className="tc text-muted">
            {c.start_frame}–{c.end_frame}
          </span>
          <span className="tc text-right text-muted">{Math.round(c.play_s)} s</span>
          <span className="tc text-right text-ink">{pct(c.share)}</span>
          <span className="tc text-right text-muted">
            {c.manual} / {c.auto}
          </span>
        </div>
      ))}
    </div>
  );
}
