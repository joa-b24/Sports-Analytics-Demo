"use client";

import Link from "next/link";
import { Card } from "@/components/Shell";
import { EVENT_DEFAULTS, ruleVersion, type DetectedType, type EventParams } from "@/lib/eventDetect";
import { TYPE_HELP, TYPE_LABEL, changedKeys, fieldsOfType } from "@/lib/eventReview";

const fmt = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 2 });

// Rule of one type with the match's parameters in force, READ ONLY (they live in Configuración del partido > Detalles
// técnicos, lib/tech.ts). A rule that changes gets a new version, and the reviews given to the old one stop counting.
export function EventsParamsCard({ type, params, matchId, busy }: { type: DetectedType; params: EventParams; matchId: string; busy: boolean }) {
  const fields = fieldsOfType(type);
  const changed = changedKeys(params, type);
  return (
    <Card title={`Regla: ${TYPE_LABEL[type]}`} note={busy ? "Recalculando…" : `versión ${ruleVersion(type, params)}`} className="flex h-full flex-col !p-3">
      <p className="mb-2 text-[11px] text-pretty text-muted">{TYPE_HELP[type]}</p>
      <dl className="m-0 grid min-h-0 flex-1 grid-cols-2 content-start gap-x-4 gap-y-0.5 text-[11px]">
        {fields.map((f) => (
          <div key={f.key} className="flex items-baseline justify-between gap-2 border-b border-line-soft py-0.5" title={f.help}>
            <dt className="truncate text-faint">{f.label}</dt>
            <dd className="tc m-0 whitespace-nowrap text-ink">
              {fmt(params[f.key] as number)} {f.unit}
              {params[f.key] !== EVENT_DEFAULTS[f.key] && <span className="ml-1 text-accent">*</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 mt-2 text-[11px] text-faint">
        Solo lectura{changed.length ? `; * = distinto del defecto (${changed.length})` : "; valores por defecto"}.{" "}
        <Link className="link" href={`/partido?id=${encodeURIComponent(matchId)}&detalles=tecnicos`}>
          Cambiarlos en Detalles técnicos
        </Link>
      </p>
    </Card>
  );
}
