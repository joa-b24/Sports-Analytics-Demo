"use client";

import { Clock, FunnelSimple, X } from "@phosphor-icons/react";
import { Dropdown } from "@/components/Dropdown";

export type Period = 0 | 1 | 2;
// Minutes of play (or of video since the first event when the stretches are not marked): from and to.
export type MinuteRange = [number, number] | null;

const PERIODS: { id: Period; label: string }[] = [
  { id: 0, label: "Todo el partido" },
  { id: 1, label: "1.er tiempo" },
  { id: 2, label: "2.º tiempo" },
];

export const filterLabel = (period: Period, range: MinuteRange) => (range ? `Min ${range[0]}–${range[1]}` : (PERIODS.find((p) => p.id === period)?.label ?? "Todo el partido"));

// What part of the match the dashboard looks at: all of it, a half, or any stretch of minutes. It lives in the top bar of
// the match, next to the tabs of the dashboard. Choosing a half clears the minutes and the other way round.
export function AnalysisFilter({ period, onPeriod, range, onRange, lastMin }: { period: Period; onPeriod: (p: Period) => void; range: MinuteRange; onRange: (r: MinuteRange) => void; lastMin: number }) {
  const active = period !== 0 || range !== null;
  const end = Math.max(5, Math.ceil(lastMin / 5) * 5);
  const presets: [number, number][] = [];
  for (let m = 0; m < end; m += 15) presets.push([m, Math.min(m + 15, end)]);
  const [from, to] = range ?? [0, end];
  const set = (a: number, b: number) => {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.max(a, b, lo + 1);
    onPeriod(0);
    onRange([lo, hi]);
  };
  return (
    <Dropdown
      label="Qué parte del partido se analiza"
      triggerClass={`inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${active ? "bg-own/15 text-own" : "bg-surface text-ink-2 hover:text-ink"}`}
      panelClass="w-72 p-3"
      trigger={
        <>
          <FunnelSimple size={15} weight={active ? "fill" : "regular"} aria-hidden />
          {filterLabel(period, range)}
        </>
      }
    >
      {(close) => (
        <div className="space-y-4 text-xs">
          <div>
            <div className="eyebrow mb-1.5">Tiempo</div>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label="Tiempo del partido">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={range === null && period === p.id}
                  onClick={() => {
                    onRange(null);
                    onPeriod(p.id);
                    close();
                  }}
                  className={`rounded-md px-2 py-1.5 text-center transition-colors ${range === null && period === p.id ? "bg-line-strong text-ink" : "bg-bg/60 text-muted hover:text-ink"}`}
                >
                  {p.id === 0 ? "Todo" : p.id === 1 ? "1.er T" : "2.º T"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow mb-1.5 flex items-center gap-1.5">
              <Clock size={12} aria-hidden />
              Por minutos
            </div>
            <div className="flex flex-wrap gap-1">
              {presets.map(([a, b]) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={range?.[0] === a && range?.[1] === b}
                  onClick={() => set(a, b)}
                  className={`tc rounded-full px-2.5 py-1 transition-colors ${range?.[0] === a && range?.[1] === b ? "bg-own text-[var(--on-own)]" : "bg-bg/60 text-muted hover:text-ink"}`}
                >
                  {a}–{b}′
                </button>
              ))}
            </div>
            <div className="mt-2.5 flex items-center gap-2 text-muted">
              <label className="flex items-center gap-1.5">
                Desde
                <input type="number" min={0} max={end} className="input !h-8 !w-16 !px-2 text-center" value={from} onChange={(e) => set(Number(e.target.value) || 0, to)} aria-label="Minuto de inicio" />
              </label>
              <label className="flex items-center gap-1.5">
                a
                <input type="number" min={1} max={end} className="input !h-8 !w-16 !px-2 text-center" value={to} onChange={(e) => set(from, Number(e.target.value) || end)} aria-label="Minuto final" />
              </label>
              <span className="text-faint">min</span>
            </div>
          </div>
          {active && (
            <button
              type="button"
              className="btn w-full justify-center"
              onClick={() => {
                onRange(null);
                onPeriod(0);
                close();
              }}
            >
              <X size={13} />
              Quitar el filtro
            </button>
          )}
        </div>
      )}
    </Dropdown>
  );
}
