"use client";

import { Warning } from "@phosphor-icons/react";
import { Card } from "@/components/Shell";
import { KIND_LABEL, SRC_LABEL } from "@/lib/playgroundPossession";
import { autoWarning, type BallSrc, type PossessionKind, type PossessionSummary, type TeamSeconds } from "@/lib/possession";

const s1 = (n: number) => `${n.toLocaleString("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
const pctText = (x: number | null) => (x === null ? "—" : `${(100 * x).toLocaleString("es-MX", { maximumFractionDigits: 1 })} %`);

function Table({ title, rows }: { title: string; rows: { label: string; t: TeamSeconds }[] }) {
  return (
    <table className="w-full text-xs">
      <caption className="eyebrow pb-1 text-left">{title}</caption>
      <thead>
        <tr className="text-faint">
          <th className="text-left font-normal" />
          <th className="text-right font-normal">Nuestro</th>
          <th className="text-right font-normal">Rival</th>
          <th className="text-right font-normal">Sin dueño</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-line-soft">
            <td className="py-1 text-muted">{r.label}</td>
            <td className="tc text-right">{s1(r.t.own)}</td>
            <td className="tc text-right">{s1(r.t.opp)}</td>
            <td className="tc text-right">{s1(r.t.none)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Summary of the possession of the video being checked: seconds, by ball source and by kind. Only the time the ball was
// followed counts (as the report does).
export function PossessionSummaryCard({ summary, videoLabel }: { summary: PossessionSummary; videoLabel: string }) {
  const warn = autoWarning(summary);
  const a = summary.seconds;
  return (
    <Card title="Resumen" note={`${videoLabel} · solo con el balón seguido`}>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="eyebrow">Posesión nuestra</div>
          <div className="num text-2xl text-ink">{pctText(summary.pct_own)}</div>
          <div className="text-xs text-faint">de lo asignado ({s1(a.own + a.opp)})</div>
        </div>
        <div>
          <div className="eyebrow">Solo con medidas</div>
          <div className="num text-2xl text-ink">{pctText(summary.pct_own_measured)}</div>
          <div className="text-xs text-faint">sin balón ni jugadoras interpoladas</div>
        </div>
        <div>
          <div className="eyebrow">Sin dueño</div>
          <div className="num text-2xl text-ink">{s1(a.none)}</div>
          <div className="text-xs text-faint">de {s1(summary.total_s)} seguidos</div>
        </div>
      </div>
      <p className="mt-2 text-xs text-faint">
        Cobertura: {pctText(summary.coverage)} del tiempo de juego vivo ({s1(summary.alive_s)}) tiene dueño respaldado por un contacto medido; el contacto medido en sí es {pctText(summary.contact_coverage)} ({s1(summary.contact_s)}). Pausas con el balón no visto (muerto): {s1(summary.restart_s)}. El resto queda sin dueño y fuera del porcentaje.
      </p>
      <p className="mt-2 text-xs text-faint">
        Nuestro equipo {s1(a.own)} · rival {s1(a.opp)}. Asignado sobre balón interpolado: {s1(summary.assigned_ball_interp_s)}; con jugadora interpolada: {s1(summary.assigned_player_interp_s)}.
      </p>
      {warn && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-900 p-2 text-xs text-warn" role="alert">
          <Warning size={14} className="mt-0.5 shrink-0" />
          {warn}
        </p>
      )}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Table title="Por fuente del balón" rows={(Object.keys(summary.by_source) as BallSrc[]).map((k) => ({ label: SRC_LABEL[k], t: summary.by_source[k] }))} />
        <Table title="Por tipo" rows={(Object.keys(summary.by_kind) as PossessionKind[]).map((k) => ({ label: KIND_LABEL[k], t: summary.by_kind[k] }))} />
      </div>
    </Card>
  );
}
