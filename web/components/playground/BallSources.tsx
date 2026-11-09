"use client";

import { Warning } from "@phosphor-icons/react";
import { Card } from "@/components/Shell";
import { SOURCE_LABEL, mainSource, partNotes, pct, totalShares, type BallSourceKey } from "@/lib/playground";
import type { PartRow } from "./usePartInfos";

// Segments of the bar, in this order. Colours are tokens: hand = ok, tracker = accent, events = ink, interpolated = warn.
const SEGS: { key: BallSourceKey; cls: string }[] = [
  { key: "manual", cls: "bg-ok" },
  { key: "auto", cls: "bg-accent-400" },
  { key: "event", cls: "bg-ink-2" },
  { key: "interpolated", cls: "bg-warn" },
  { key: "none", cls: "bg-line-strong" },
];

const fmtDate = (ms: number) => new Date(ms).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const f1 = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function Bar({ counts, total }: { counts: Record<BallSourceKey, number>; total: number }) {
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line" role="img" aria-label={SEGS.map((s) => `${SOURCE_LABEL[s.key]} ${f1(pct(counts[s.key], total))} %`).join(", ")}>
      {SEGS.map((s) => (counts[s.key] > 0 ? <span key={s.key} className={s.cls} style={{ width: `${pct(counts[s.key], total)}%` }} /> : null))}
    </div>
  );
}

// Step 0: which ball the report uses TODAY in each part. It reads tracks_fixed_*.json (what lib/positions.ts reads) and
// counts, frame by frame, the source of its ball; the date of ball_auto_* says whether the tracker's file is newer.
export function BallSources({ parts, error, selected, onSelect }: { parts: PartRow[] | null; error: string | null; selected: string | null; onSelect: (part: string) => void }) {
  if (error) {
    return (
      <Card title="0 · Fuente del balón por parte">
        <p className="text-sm text-muted">{error}</p>
      </Card>
    );
  }
  if (!parts) {
    return (
      <Card title="0 · Fuente del balón por parte">
        <p className="text-sm text-muted">Leyendo las partes…</p>
      </Card>
    );
  }
  const all = totalShares(parts);
  return (
    <Card title="0 · Fuente del balón por parte" note="Lo que lee hoy el informe (tracks_fixed), % de los cuadros muestreados de cada parte">
      {parts.length === 0 ? (
        <p className="text-sm text-muted">Este partido no tiene partes procesadas en su carpeta.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted" aria-hidden>
            {SEGS.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <i className={`h-2 w-2 rounded-full ${s.cls}`} />
                {SOURCE_LABEL[s.key]}
              </span>
            ))}
          </div>
          <ul className="m-0 grid list-none gap-1 p-0">
            {parts.map((p) => {
              const notes = partNotes(p);
              const main = p.shares ? mainSource(p.shares) : "none";
              return (
                <li key={p.part}>
                  <button
                    type="button"
                    onClick={() => onSelect(p.part)}
                    aria-pressed={selected === p.part}
                    className={`grid w-full gap-x-4 gap-y-1 rounded-lg px-3 py-1 text-left transition-colors md:grid-cols-[8.5rem_13rem_minmax(0,1fr)_21rem] md:items-center ${selected === p.part ? "bg-raised" : "hover:bg-raised/60"}`}
                  >
                    <span className="num text-[13px] text-ink">{p.part}</span>
                    <span className={`tag w-fit whitespace-nowrap ${main === "manual" ? "" : main === "none" || main === "interpolated" ? "tag-warn" : "tag-accent"}`}>
                      {!p.hasFixed ? "Sin tracks_fixed" : p.shares && p.shares.counts.interpolated > p.shares.counts[main as "manual"] && main !== "interpolated" && main !== "none" ? `${SOURCE_LABEL[main]} + interpolado` : SOURCE_LABEL[main]}
                    </span>
                    {p.shares ? <Bar counts={p.shares.counts} total={p.shares.total} /> : <span className="text-xs text-faint">{p.hasRaw ? "Sin balón: el informe usa la parte sin corregir" : "—"}</span>}
                    <span className="text-[11px] text-faint">
                      {p.shares
                        ? SEGS.filter((s) => p.shares!.counts[s.key] > 0)
                            .map((s) => `${SOURCE_LABEL[s.key].split(" ").pop()} ${f1(pct(p.shares!.counts[s.key], p.shares!.total))} %`)
                            .join(" · ")
                        : ""}
                      {p.autoMtime !== null ? `${p.shares ? " · " : ""}ball_auto ${fmtDate(p.autoMtime)}` : p.shares ? " · sin ball_auto" : ""}
                    </span>
                    {notes.map((n) => (
                      <span key={n} className="flex items-start gap-1.5 text-[11px] text-warn md:col-span-4">
                        <Warning size={13} className="mt-px shrink-0" aria-hidden />
                        {n}
                      </span>
                    ))}
                  </button>
                </li>
              );
            })}
          </ul>
          {all.total > 0 && (
            <div className="mt-3 border-t border-line-soft pt-3">
              <div className="mb-1.5 text-[11px] text-muted">Todo el partido (partes con tracks_fixed, {all.total} cuadros)</div>
              <Bar counts={all.counts} total={all.total} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
