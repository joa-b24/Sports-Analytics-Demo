"use client";

import { fmtT } from "@/lib/format";
import type { Rating } from "@/lib/rating";

// The rating of a player (0-10) is IN REVIEW: weights and discounts are a proposal (docs/propuesta_calificacion_jugadora.md).
// Wherever it shows it carries that mark, and without a score it says why (never a made-up number).
export const RATING_NOTE = "En revisión: los pesos y descuentos son una propuesta que el cuerpo técnico aún no aprueba.";

const tone = (v: number) => (v >= 7 ? "var(--color-ok)" : v >= 5 ? "var(--color-ink)" : "var(--color-danger)");

export function RatingBadge({ rating, big = false, mark = true }: { rating: Rating | undefined; big?: boolean; mark?: boolean }) {
  if (!rating || rating.score === null)
    return (
      <span className="text-faint" title={rating?.reason ? `Sin calificación: ${rating.reason}` : "Sin calificación"}>
        —
      </span>
    );
  // Gray when few metrics entered: the score rests on little.
  const weak = rating.used < 6;
  return (
    <span className="inline-flex items-baseline gap-1.5" title={`${RATING_NOTE} Entraron ${rating.used} de ${rating.total} métricas.`}>
      <span className={`num ${big ? "text-3xl" : "text-sm"}`} style={{ color: weak ? "var(--color-muted)" : tone(rating.score) }}>
        {rating.score.toFixed(1)}
      </span>
      {mark && <span className="tag !px-1 !py-0 text-[9px] text-warn">en revisión</span>}
    </span>
  );
}

// The breakdown: each metric with her figure, the group's average and what it adds, then the discounts and bonuses with
// their minute (a click opens the moment in the video).
export function RatingDetail({ rating, onPick }: { rating: Rating | undefined; onPick?: (a: { video_id: string; t: number; label: string }) => void }) {
  if (!rating) return null;
  if (rating.score === null) return <p className="text-sm text-faint">Sin calificación: {rating.reason}.</p>;
  const sign = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <RatingBadge rating={rating} big />
        <span className="text-xs text-muted">
          base {rating.base?.toFixed(1)} · acciones con consecuencia {sign(rating.adjust)} · {rating.used} de {rating.total} métricas
        </span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-faint">
            <th className="pb-1 font-normal">Métrica</th>
            <th className="pb-1 text-right font-normal">Ella</th>
            <th className="pb-1 text-right font-normal" title="Promedio de su equipo en este partido">Equipo</th>
            <th className="pb-1 text-right font-normal">Aporta</th>
          </tr>
        </thead>
        <tbody>
          {rating.components.map((c) => (
            <tr key={c.key} className="border-t border-line-soft">
              <td className="py-1 text-ink-2">{c.label}</td>
              <td className="tc py-1 text-right text-ink">{c.value}</td>
              <td className="tc py-1 text-right text-faint">{c.mean}</td>
              <td className="tc py-1 text-right" style={{ color: c.points >= 0 ? "var(--color-ok)" : "var(--color-danger)" }}>
                {sign(c.points)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rating.adjustments.length > 0 && (
        <div>
          <div className="eyebrow mb-1">Acciones con consecuencia</div>
          <ul className="m-0 list-none divide-y divide-line-soft p-0 text-xs">
            {rating.adjustments.map((a) => (
              <li key={`${a.event_id}-${a.label}`}>
                <button type="button" disabled={!onPick} onClick={() => onPick?.({ video_id: a.video_id, t: a.t, label: a.label })} className="grid w-full grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2 py-1.5 text-left hover:bg-raised disabled:hover:bg-transparent">
                  <span className="tc text-faint">{fmtT(a.t)}</span>
                  <span className="truncate text-ink-2">{a.label}</span>
                  <span className="tc" style={{ color: a.delta >= 0 ? "var(--color-ok)" : "var(--color-danger)" }}>
                    {sign(a.delta)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="m-0 text-[11px] text-pretty text-faint">
        {RATING_NOTE} 6 es una jugadora normal de su equipo en este partido; cada cifra se compara por 90 minutos. Las acciones con consecuencia tienen tope de −3 y +2 por partido.
      </p>
    </div>
  );
}
