"use client";

import { ClipboardText, Plus, Trash, Warning, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Card } from "@/components/Shell";
import { readLocal, writeLocal } from "@/lib/local";
import { UNKNOWN_FROM, parseRoster, repeatedNumbers, sortRoster } from "@/lib/roster";
import { mutate, useStore } from "@/lib/store";
import type { RosterPlayer } from "@/lib/types";

// The squad lives in config/roster.json next to the app (out of git: it holds the players' names) and is copied into
// the browser, so it also works where that file cannot be read. Every change is written to both.
const FILE = "config/roster.json";

async function saveRoster(players: RosterPlayer[]) {
  mutate((s) => ({ ...s, roster: players }));
  await writeLocal(FILE, JSON.stringify({ schema_version: 1, team: "Tec CCM", players }, null, 1));
}

// Loads the squad from its file once per session, when the app runs next to the repository.
let loaded = false;
export function useRosterFromFile() {
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void readLocal(FILE).then((text) => {
      if (!text) return;
      try {
        const players = (JSON.parse(text) as { players?: RosterPlayer[] }).players;
        if (Array.isArray(players)) mutate((s) => ({ ...s, roster: players }));
      } catch {
        // A broken file is left alone; the copy in the browser stays.
      }
    });
  }, []);
}

// Numbers from here up are the provisional ones given by parseRoster (99, 98, ...).
const provisional = (n: number | null) => n !== null && n > UNKNOWN_FROM - 10;

// Our squad: names (the identifier used in events, tracks and sessions) and usual numbers.
export function RosterCard() {
  const { roster, events } = useStore();
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [paste, setPaste] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const list = sortRoster(roster ?? []);
  const repeated = new Set(repeatedNumbers(list));
  const tagged = new Map<string, number>();
  for (const e of events) if (e.player_id) tagged.set(e.player_id, (tagged.get(e.player_id) ?? 0) + 1);
  const set = (next: RosterPlayer[]) => void saveRoster(next);
  const exists = (id: string) => list.some((p) => p.player_id.toLowerCase() === id.trim().toLowerCase());
  const add = () => {
    const id = name.trim();
    if (!id || exists(id)) return;
    // parseRoster gives a free provisional number when none is typed.
    set(parseRoster(number === "" ? id : `${number} ${id}`, list));
    setName("");
    setNumber("");
  };
  const parsed = paste.trim() ? parseRoster(paste, list) : null;
  const added = parsed ? parsed.length - list.length : 0;
  const renumbered = parsed ? parsed.filter((p) => list.some((q) => q.player_id === p.player_id && q.number !== p.number)).length : 0;
  const provisionalCount = list.filter((p) => provisional(p.number)).length;
  const remove = (id: string) => {
    set(list.filter((q) => q.player_id !== id));
    setConfirm(null);
  };

  return (
    <Card title="Plantilla" className="mb-12">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex items-end gap-6">
          <div>
            <div className="num text-5xl text-ink">{list.length}</div>
            <div className="mt-1 text-[11px] text-muted">jugadoras</div>
          </div>
          <div>
            <div className={`num text-5xl ${provisionalCount ? "text-ink-2" : "text-faint"}`}>{provisionalCount}</div>
            <div className="mt-1 text-[11px] text-muted">con dorsal provisional</div>
          </div>
          {repeated.size > 0 && (
            <div>
              <div className="num text-5xl text-warn">{repeated.size}</div>
              <div className="mt-1 text-[11px] text-warn">dorsales repetidos</div>
            </div>
          )}
        </div>
        <span className="text-xs text-faint">
          se guarda en <code>{FILE}</code>
        </span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div>
          {list.length === 0 ? (
            <div className="grid min-h-48 place-items-center rounded-[10px] border border-dashed border-line-strong p-6 text-center text-sm text-muted">
              Aún no hay plantilla. Añade jugadoras a la derecha o pega la lista completa.
            </div>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-2">
              {list.map((p) => {
                const dup = repeated.has(p.number as number);
                const prov = provisional(p.number);
                const n = tagged.get(p.player_id) ?? 0;
                return (
                  <li
                    key={p.player_id}
                    className={`group relative flex items-center gap-3 rounded-[10px] bg-raised/60 py-2 pr-2 pl-1 transition-colors hover:bg-raised ${dup ? "shadow-[inset_0_0_0_1px_var(--color-warn)]" : ""}`}
                  >
                    <input
                      type="number"
                      min={0}
                      max={999}
                      aria-label={`Dorsal de ${p.player_id}`}
                      title={prov ? "Dorsal provisional: cámbialo cuando sepas el real" : dup ? "Dorsal repetido" : "Dorsal"}
                      className={`num w-16 shrink-0 rounded-md border border-transparent bg-transparent py-0.5 text-center text-[2.1rem] [appearance:textfield] hover:border-line-strong focus:border-accent focus:outline-none [&::-webkit-inner-spin-button]:appearance-none ${
                        dup ? "text-warn" : prov ? "text-faint" : "text-ink"
                      }`}
                      value={p.number ?? ""}
                      onChange={(e) => set(list.map((q) => (q.player_id === p.player_id ? { ...q, number: e.target.value === "" ? null : Number(e.target.value) } : q)))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink" title={p.player_id}>
                        {p.player_id}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-faint">
                        {n > 0 ? `${n} evento${n === 1 ? "" : "s"}` : "sin eventos"}
                        {dup && (
                          <span className="text-warn">
                            {" · "}
                            <Warning size={11} className="inline align-[-1px]" /> repetido
                          </span>
                        )}
                      </div>
                    </div>
                    {confirm === p.player_id ? (
                      <span className="absolute inset-0 flex items-center justify-between gap-2 rounded-[10px] bg-raised px-3 text-xs text-ink-2">
                        <span className="min-w-0">
                          {n > 0 ? `Tiene ${n} evento${n === 1 ? "" : "s"}: quedarán sin plantilla.` : `¿Quitar a ${p.player_id}?`}
                        </span>
                        <span className="flex shrink-0 gap-1">
                          <button type="button" className="btn h-7 !border-danger/60 !px-2 text-danger" onClick={() => remove(p.player_id)}>
                            Quitar
                          </button>
                          <button type="button" className="btn btn-ghost h-7 w-7 !p-0" aria-label="Cancelar" onClick={() => setConfirm(null)}>
                            <X size={13} />
                          </button>
                        </span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-faint opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                        aria-label={`Quitar a ${p.player_id}`}
                        onClick={() => (n > 0 ? setConfirm(p.player_id) : remove(p.player_id))}
                      >
                        <Trash size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-pretty text-faint">
            El nombre es el identificador de la jugadora en eventos, tracks y sesiones; para cambiarlo, quítala y vuelve a añadirla. Los dorsales
            desde {UNKNOWN_FROM} hacia abajo (en gris) son provisionales.
          </p>
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-[10px] bg-bg/50 p-3">
            <h3 className="tc mb-2.5 text-[11px] tracking-[0.08em] text-faint uppercase">Añadir jugadora</h3>
            <div className="flex gap-2">
              <input className="input tc w-16 text-center" type="number" placeholder="#" aria-label="Dorsal" value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
              <input
                className="input min-w-0 flex-1"
                placeholder="Nombre o apodo"
                aria-label="Nombre"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-faint">{name.trim() && exists(name) ? <span className="text-warn">Ya está en la plantilla.</span> : "Enter para añadir"}</span>
              <button type="button" className="btn" disabled={!name.trim() || exists(name)} onClick={add}>
                <Plus size={14} />
                Añadir
              </button>
            </div>
          </section>

          <section className="rounded-[10px] bg-bg/50 p-3">
            <h3 className="tc mb-2.5 text-[11px] tracking-[0.08em] text-faint uppercase">Pegar lista</h3>
            <textarea
              className="input h-28 w-full resize-none font-mono text-xs leading-relaxed"
              placeholder={"Una por línea:\n10 Sama\n#7 Ivonne\nPaola"}
              aria-label="Lista de jugadoras, una por línea"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-faint">
                {parsed ? (added || renumbered ? `${added} nueva${added === 1 ? "" : "s"} · ${renumbered} dorsal${renumbered === 1 ? "" : "es"} cambiado${renumbered === 1 ? "" : "s"}` : "Nada nuevo") : "Sin dorsal: se pone uno provisional."}
              </span>
              <button
                type="button"
                className="btn"
                disabled={!parsed || (!added && !renumbered)}
                onClick={() => {
                  if (!parsed) return;
                  set(parsed);
                  setPaste("");
                }}
              >
                <ClipboardText size={14} />
                Añadir
              </button>
            </div>
          </section>
        </aside>
      </div>
    </Card>
  );
}
