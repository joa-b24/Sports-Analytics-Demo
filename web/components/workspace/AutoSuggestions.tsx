"use client";

import { Check, Lightning, X } from "@phosphor-icons/react";
import type { Suggestion } from "@/lib/autoEvents";
import { fmtT } from "@/lib/format";

// The events suggested from the reviewed ball (lib/autoEvents.ts), inside the ball view of the correction table: the
// one at this moment with its options (s accepts the first, x rejects), and the next ones to jump to.

const RULE_LABELS: Record<Suggestion["rule"], string> = {
  out_touchline: "Salida por banda",
  out_goal_line: "Salida por fondo",
  stoppage: "Juego detenido",
  final_third_entry: "Último tercio",
  box_entry: "Área",
  cross: "Centro",
  turnover: "Cambio de posesión",
  duel: "Disputa",
};
const NEXT_SHOWN = 5;

export function AutoSuggestions({
  list,
  active,
  frame,
  fps,
  blocked,
  onSeek,
  onAccept,
  onReject,
}: {
  // Pending suggestions of this part, in time order.
  list: Suggestion[];
  // The one at this moment (near the frame on screen), if any.
  active: Suggestion | null;
  frame: number;
  fps: number;
  // Why there are no suggestions yet (no direction of play, nothing reviewed).
  blocked?: string;
  onSeek: (frame: number) => void;
  onAccept: (s: Suggestion, option: number) => void;
  onReject: (s: Suggestion) => void;
}) {
  const next = list.filter((s) => s !== active && s.frame > frame).slice(0, NEXT_SHOWN);
  const later = list.filter((s) => s.frame > frame).length - next.length - (active && active.frame > frame ? 1 : 0);
  const before = list.filter((s) => s !== active && s.frame <= frame).length;
  return (
    <div className="rounded-2xl bg-surface/70 p-3 text-xs text-muted">
      <div className="flex items-center gap-2">
        <Lightning size={14} weight="fill" className="text-accent-300" />
        <span className="cond text-[13px] font-bold tracking-wide text-ink uppercase">Sugerencias</span>
        <span className="tc text-faint">{list.length}</span>
        {before > 0 && (
          <button type="button" className="link ml-auto" onClick={() => onSeek(list.find((s) => s.frame <= frame)?.frame ?? frame)} title="Ir a la primera sugerencia pendiente que ya quedó atrás">
            {before} atrás
          </button>
        )}
      </div>
      {blocked ? (
        <p className="mt-2 text-pretty text-faint">{blocked}</p>
      ) : (
        <>
          {active ? (
            <div className="mt-2 rounded-xl bg-bg/60 p-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <div className="flex items-center gap-2">
                <span className="tc text-faint">{fmtT(active.frame / fps)}</span>
                <span className="text-faint">· {RULE_LABELS[active.rule]}</span>
                {active.confidence === "medium" && <span className="tag tag-warn ml-auto">revisar</span>}
              </div>
              <p className="mt-1 text-pretty text-ink-2">{active.why}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {active.options.map((o, i) => (
                  <button
                    key={o.label}
                    type="button"
                    className={`btn !py-1 text-xs ${i === 0 ? "!border-accent !bg-accent text-white" : ""}`}
                    onClick={() => onAccept(active, i)}
                    title={o.events.length ? `Añade: ${o.label}` : "No añade eventos"}
                  >
                    {i === 0 && <Check size={12} weight="bold" />}
                    {o.label}
                    {i === 0 && <kbd className="kbd">S</kbd>}
                  </button>
                ))}
                <button type="button" className="btn !py-1 text-xs" onClick={() => onReject(active)} title="No fue ninguna de estas: se descarta">
                  <X size={12} /> No <kbd className="kbd">X</kbd>
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-faint">{list.length ? "Nada en este momento." : "Sin sugerencias pendientes en lo revisado."}</p>
          )}
          {next.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {next.map((s) => (
                <li key={s.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-raised" onClick={() => onSeek(s.frame)}>
                    <span className="tc w-12 shrink-0 text-faint">{fmtT(s.frame / fps)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{s.options[0].label}</span>
                    {s.confidence === "medium" && <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-label="revisar" />}
                  </button>
                </li>
              ))}
              {later > 0 && <li className="px-1.5 pt-0.5 text-faint">y {later} más adelante</li>}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
