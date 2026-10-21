"use client";

import { nextCard } from "@/lib/tagging";

// The card of a foul as one small button: an empty card; a click makes it yellow, another red, another takes it away.
export function CardToggle({ value, onChange }: { value: string | null | undefined; onChange: (v: "yellow" | "red" | null) => void }) {
  const label = value === "yellow" ? "Amarilla" : value === "red" ? "Roja" : "Sin tarjeta";
  return (
    <button
      type="button"
      onClick={() => onChange(nextCard(value))}
      title={`${label} · clic: ${value === "yellow" ? "roja" : value === "red" ? "sin tarjeta" : "amarilla"}`}
      aria-label={`Tarjeta: ${label}`}
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-raised"
    >
      <span
        className={`inline-block h-4 w-3 rounded-[2px] ${value === "yellow" ? "bg-[#facc15]" : value === "red" ? "bg-[#ef4444]" : "border border-dashed border-line-strong"}`}
        aria-hidden
      />
      {value ? label : ""}
    </button>
  );
}
