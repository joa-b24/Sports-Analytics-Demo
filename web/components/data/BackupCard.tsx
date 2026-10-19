"use client";

import { DownloadSimple, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { Card, btnPrimary } from "@/components/Shell";
import { downloadText } from "@/lib/format";
import { EMPTY, mutate, useStore } from "@/lib/store";
import type { State } from "@/lib/types";
import { Confirm, DropZone, NoticeLine, type Notice } from "./DropZone";

const LISTS = ["matches", "events", "plays", "sessions", "anchors", "segments", "venues", "trackEdits", "roster", "passes", "boards", "edits"] as const;

const counts = (s: Partial<State>): [string, number][] => [
  ["partidos", s.matches?.length ?? 0],
  ["eventos", s.events?.length ?? 0],
  ["jugadas", s.plays?.length ?? 0],
  ["cuadros calibrados", s.anchors?.length ?? 0],
  ["jugadoras en la plantilla", s.roster?.length ?? 0],
  ["láminas del pizarrón", s.boards?.length ?? 0],
];

// A backup of this browser's data: everything in one JSON (videos and tracking stay in their folders), and its restore,
// which replaces what is here only after a confirmation that says what is lost and what comes in.
function readBackup(text: string): Partial<State> | null {
  try {
    const data = JSON.parse(text) as Partial<State>;
    if (!data || typeof data !== "object" || !Array.isArray(data.matches) || !Array.isArray(data.events)) return null;
    for (const k of LISTS) if (k in data && !Array.isArray(data[k])) return null;
    if (data.matches.some((m) => !m || typeof m.match_id !== "string" || typeof m.name !== "string")) return null;
    return data;
  } catch {
    return null;
  }
}

export function BackupCard() {
  const state = useStore();
  const [pending, setPending] = useState<{ name: string; data: Partial<State> } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const take = async (f: File) => {
    setConfirmClear(false);
    const data = readBackup(await f.text());
    if (!data) return setNotice({ tone: "bad", text: "Ese archivo no es un respaldo válido de esta app (un .json exportado desde aquí)." });
    setNotice(null);
    setPending({ name: f.name, data });
  };
  const list = (s: Partial<State>) =>
    counts(s)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ") || "nada";

  return (
    <Card title="Respaldo completo" note="todo lo guardado en este navegador, en un JSON">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            {counts(state).map(([k, n]) => (
              <div key={k}>
                <dt className="text-[11px] text-faint">{k}</dt>
                <dd className="num text-xl text-ink">{n}</dd>
              </div>
            ))}
          </dl>
          <button type="button" className={`${btnPrimary} mt-4`} onClick={() => downloadText(`sportsan_respaldo_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 1), "application/json")}>
            <DownloadSimple size={15} />
            Exportar respaldo
          </button>
          <p className="mt-2 text-xs text-faint">Los videos y el tracking no van en el respaldo: viven en matches/.</p>
        </div>
        <div>
          <DropZone accept=".json,application/json" label="Restaurar un respaldo" hint="pide confirmación antes de reemplazar nada" onFiles={(f) => void take(f[0])} />
          {pending && (
            <Confirm
              danger
              yes="Reemplazar todo"
              onYes={() => {
                mutate(() => ({ ...EMPTY, ...pending.data }) as State);
                setNotice({ tone: "ok", text: `Respaldo «${pending.name}» restaurado.` });
                setPending(null);
              }}
              onNo={() => setPending(null)}
            >
              «{pending.name}» trae {list(pending.data)}. Restaurarlo <strong className="text-ink">borra lo que hay ahora en este navegador</strong> ({list(state)}). Exporta
              un respaldo antes si quieres conservarlo.
            </Confirm>
          )}
          {confirmClear && (
            <Confirm
              danger
              yes="Sí, borrar todo"
              onYes={() => {
                mutate(() => EMPTY);
                setConfirmClear(false);
                setNotice({ tone: "ok", text: "Se borró todo lo de este navegador. Los archivos de matches/ no se tocaron." });
              }}
              onNo={() => setConfirmClear(false)}
            >
              ¿Borrar todo lo de este navegador ({list(state)})? Los archivos de matches/ no se tocan.
            </Confirm>
          )}
          <NoticeLine notice={notice} />
          {!confirmClear && !pending && (
            <button type="button" className="mt-3 inline-flex items-center gap-1.5 text-xs text-faint transition-colors hover:text-danger" onClick={() => setConfirmClear(true)}>
              <Trash size={13} />
              Borrar todo
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
