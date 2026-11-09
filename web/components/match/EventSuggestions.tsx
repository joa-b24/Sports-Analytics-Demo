"use client";

import { Check, Play, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/Shell";
import { TYPE_LABEL } from "@/lib/eventReview";
import { fmtT } from "@/lib/format";
import { readLocal, writeLocalInfo } from "@/lib/local";
import { decide, emptySuggest, eventOfDetection, parseSuggest, pendingSuggestions, suggestPath, type Decision } from "@/lib/processes";
import { mutate, uid } from "@/lib/store";
import type { Match, MatchEvent } from "@/lib/types";

const SHOWN = 5;

// Review pass: the detections of «Procesos del partido > Eventos» whose type is not automatic wait here to be accepted or
// rejected (events_suggest_<video>.json). Accepting creates a normal event (not «automático»); rejecting hides it for good.
export function EventSuggestions({
  match,
  videoId,
  events,
  defaultPeriod,
  periodAt,
  playClip,
}: {
  match: Match;
  videoId: string;
  events: MatchEvent[];
  defaultPeriod: 1 | 2;
  periodAt?: (t: number) => 1 | 2;
  playClip: (t0: number, t1: number) => void;
}) {
  const folder = match.folder;
  const [file, setFile] = useState(() => emptySuggest(videoId));
  const [all, setAll] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (!folder) return;
    let live = true;
    loaded.current = false;
    void readLocal(suggestPath(folder, videoId)).then((t) => {
      if (!live) return;
      setFile(parseSuggest(t, videoId));
      loaded.current = true;
    });
    return () => {
      live = false;
    };
  }, [folder, videoId]);

  const list = useMemo(() => pendingSuggestions(file, events), [file, events]);
  if (!folder || list.length === 0) return null;

  const save = async (next: typeof file) => {
    setFile(next);
    const w = await writeLocalInfo(suggestPath(folder, videoId), JSON.stringify(next, null, 1));
    setMsg(w.ok ? null : "No se pudo guardar tu respuesta en la carpeta: se perderá al recargar.");
  };
  const answer = (id: string, d: Decision) => void save(decide(file, id, d));
  const accept = (idx: number, team?: "own" | "opp") => {
    const d = list[idx];
    const ev = eventOfDetection({ ...d, team: team ?? d.team }, match.match_id, periodAt ? periodAt(d.t_video) : defaultPeriod, uid("e"), false);
    if (!ev) return;
    mutate((s) => ({ ...s, events: [...s.events, ev] }));
    answer(d.id, "accepted");
  };
  const rows = all ? list : list.slice(0, SHOWN);
  return (
    <Card className="shrink-0" title="Sugerencias de eventos" note={<span className="tc">{list.length} por responder</span>}>
      <p className="mb-2 text-xs text-pretty text-muted">Detectados desde las posiciones; no son eventos hasta que los aceptes. Rechazar los quita de esta lista.</p>
      <ul className="space-y-1.5">
        {rows.map((d) => {
          const idx = list.indexOf(d);
          const known = d.team === "own" || d.team === "opp";
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-raised/60 px-2.5 py-1.5 text-xs">
              <button type="button" className="btn btn-ghost !px-1.5 !py-1" onClick={() => playClip(Math.max(0, d.t_video - 3), d.t_video + 2)} aria-label={`Ver ${TYPE_LABEL[d.type]} en ${fmtT(d.t_video)}`} title="Ver el momento">
                <Play size={13} />
              </button>
              <span className="tc text-faint">{fmtT(d.t_video)}</span>
              <span className="text-ink">{TYPE_LABEL[d.type]}</span>
              <span className="text-muted">{d.team === "own" ? match.focus_team : d.team === "opp" ? match.other_team : "equipo sin definir"}</span>
              <span className="ml-auto flex items-center gap-1">
                {known ? (
                  <button type="button" className="btn !px-2 !py-1" onClick={() => accept(idx)}>
                    <Check size={13} /> Aceptar
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn !px-2 !py-1" onClick={() => accept(idx, "own")}>
                      <Check size={13} /> {match.focus_team}
                    </button>
                    <button type="button" className="btn !px-2 !py-1" onClick={() => accept(idx, "opp")}>
                      <Check size={13} /> {match.other_team}
                    </button>
                  </>
                )}
                <button type="button" className="btn btn-ghost !px-2 !py-1" onClick={() => answer(d.id, "rejected")}>
                  <X size={13} /> Rechazar
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {list.length > SHOWN && (
        <button type="button" className="btn btn-ghost mt-2 text-faint" onClick={() => setAll((v) => !v)}>
          {all ? "Mostrar menos" : `Mostrar las ${list.length}`}
        </button>
      )}
      {msg && <p className="mt-2 text-xs text-warn">{msg}</p>}
    </Card>
  );
}
