"use client";

import { ArrowsLeftRight } from "@phosphor-icons/react";
import { COLORS } from "@/components/Pitch";
import type { Match } from "@/lib/types";

// The team of an event as ONE button: it shows the team it is for, and a click passes it to the other. Instead of a list
// or two buttons side by side, so changing team is always one click on the same place.
export function TeamSwap({ match, value, onChange, hint, className = "" }: { match: Match; value: "own" | "opp"; onChange: (t: "own" | "opp") => void; hint?: string; className?: string }) {
  const name = value === "own" ? match.focus_team : match.other_team;
  const other = value === "own" ? match.other_team : match.focus_team;
  return (
    <button
      type="button"
      onClick={() => onChange(value === "own" ? "opp" : "own")}
      title={`Cambiar a ${other}`}
      aria-label={`Equipo: ${name}. Cambiar a ${other}`}
      className={`flex items-center justify-center gap-2.5 rounded-full border border-line-strong bg-raised px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface ${className}`}
    >
      <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: value === "own" ? COLORS.own : COLORS.opp }} />
      <span className="truncate">{name}</span>
      <ArrowsLeftRight size={15} className="shrink-0 text-faint" aria-hidden />
      {hint && <kbd className="kbd">{hint}</kbd>}
    </button>
  );
}
