"use client";

import { CaretDown } from "@phosphor-icons/react";
import { usePref, setPref } from "@/lib/store";

// «Más detalle»: what supports the headline of a section, folded by default so the page starts with what matters. The
// choice (open or closed) is remembered per fold.
export function Fold({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  const open = usePref(`fold:${id}`, "closed") === "open";
  return (
    <section className="rounded-lg bg-surface/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPref(`fold:${id}`, open ? "closed" : "open")}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/60"
      >
        <span className="text-sm font-medium text-ink">{title}</span>
        {note && <span className="min-w-0 flex-1 truncate text-xs text-faint">{note}</span>}
        <CaretDown size={14} className={`ml-auto shrink-0 text-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && <div className="space-y-5 border-t border-line-soft p-4">{children}</div>}
    </section>
  );
}
