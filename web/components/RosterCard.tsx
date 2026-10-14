"use client";

import { Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Card, btn, input } from "@/components/Shell";
import { readLocal, writeLocal } from "@/lib/local";
import { UNKNOWN_FROM, repeatedNumbers, sortRoster } from "@/lib/roster";
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

// Our squad: names (the identifier used in events, tracks and sessions) and usual numbers.
export function RosterCard() {
  const { roster, events } = useStore();
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const list = sortRoster(roster ?? []);
  const repeated = new Set(repeatedNumbers(list));
  const tagged = (id: string) => events.filter((e) => e.player_id === id).length;
  const set = (next: RosterPlayer[]) => void saveRoster(next);
  const free = () => {
    const used = new Set(list.map((p) => p.number));
    let n = UNKNOWN_FROM;
    while (used.has(n)) n--;
    return n;
  };
  const add = () => {
    const id = name.trim();
    if (!id || list.some((p) => p.player_id.toLowerCase() === id.toLowerCase())) return;
    set([...list, { player_id: id, number: number === "" ? free() : Number(number) }]);
    setName("");
    setNumber("");
  };

  return (
    <Card title="Plantilla" note={`${list.length} jugadoras · se guarda en config/roster.json`} className="mb-12">
      {list.length === 0 && <p className="mb-4 text-sm text-muted">Aún no hay plantilla.</p>}
      {list.length > 0 && (
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => (
            <li key={p.player_id} className="flex items-center gap-3 border-b border-line-soft py-1.5">
              <input
                type="number"
                min={0}
                max={999}
                aria-label={`Número de ${p.player_id}`}
                className={`tc num w-14 rounded-lg border bg-transparent px-1.5 py-0.5 text-lg focus:border-accent focus:outline-none ${
                  repeated.has(p.number as number) ? "border-warn text-warn" : "border-transparent hover:border-line"
                } ${(p.number ?? 0) > UNKNOWN_FROM - 10 ? "text-faint" : "text-ink"}`}
                value={p.number ?? ""}
                onChange={(e) => set(list.map((q) => (q.player_id === p.player_id ? { ...q, number: e.target.value === "" ? null : Number(e.target.value) } : q)))}
              />
              <span className="min-w-0 flex-1 truncate text-ink">{p.player_id}</span>
              <span className="tc text-[11px] text-faint" title="Eventos etiquetados con su nombre">
                {tagged(p.player_id)} ev.
              </span>
              <button
                type="button"
                className="text-faint transition-colors hover:text-danger"
                aria-label={`Quitar a ${p.player_id}`}
                onClick={() => set(list.filter((q) => q.player_id !== p.player_id))}
              >
                <Trash size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input className={`${input} tc w-20`} type="number" placeholder="#" aria-label="Número" value={number} onChange={(e) => setNumber(e.target.value)} />
        <input
          className={`${input} w-48`}
          placeholder="Nombre o apodo"
          aria-label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button type="button" className={btn} disabled={!name.trim()} onClick={add}>
          <Plus size={14} />
          Añadir jugadora
        </button>
      </div>
      {repeated.size > 0 && <p className="mt-2 text-xs text-warn">Hay números repetidos: {[...repeated].join(", ")}.</p>}
      <p className="mt-3 text-[11px] text-pretty text-faint">
        El nombre es el identificador de la jugadora en eventos, tracks y sesiones. Los números desde {UNKNOWN_FROM} hacia abajo (en gris) son
        provisionales: cámbialos cuando sepas el real.
      </p>
    </Card>
  );
}
