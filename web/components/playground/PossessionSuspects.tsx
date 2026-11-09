"use client";

import Link from "next/link";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useState } from "react";
import { Card } from "@/components/Shell";
import { Pager, usePaged } from "@/components/Paged";
import { fmtT } from "@/lib/format";
import { readLocal } from "@/lib/local";
import { SUSPECT_LABEL, effectText, medianLab } from "@/lib/playgroundPossession";
import type { Oriented } from "@/lib/positions";
import { labIndex, suspectBoxes, type Lab, type PossessionParams, type Suspect } from "@/lib/possession";
import type { Segment } from "@/lib/segments";
import { editsKey, emptyEdits, fileTeamRefs, people, type TracksFile } from "@/lib/tracks";
import type { TrackEdits } from "@/lib/types";

const ROW_H = 92;
const TEAM_NAME: Record<string, string> = { own: "nuestro equipo", opp: "rival", ref: "árbitro", unk: "sin equipo" };

interface Found {
  list: Suspect[];
  // Whether the shirt colours could be read (without them the colour reasons are not checked).
  colours: boolean;
  parts: number;
}

// Queue of the boxes that decide the possession and may be wrong. The shirt colour of each person comes from the raw
// processed parts (tracks_<video>_<a>_<b>.json), which the corrected files do not carry: read when the button is pressed.
export function PossessionSuspects({
  parts, segmentsByVideo, params, folder, trackEdits, matchId, onView,
}: {
  parts: (Oriented & { dir: string })[];
  segmentsByVideo: Record<string, Segment[]>;
  params: PossessionParams;
  folder: string;
  trackEdits: TrackEdits[];
  matchId: string;
  onView: (s: Suspect) => void;
}) {
  const [state, setState] = useState<"idle" | "reading" | "computing">("idle");
  const [found, setFound] = useState<Found | null>(null);
  const [stale, setStale] = useState(false);
  const [lastParams, setLastParams] = useState<PossessionParams | null>(null);
  const { boxRef, rows, page, pages, setPage } = usePaged(found?.list ?? [], ROW_H, null, 2);
  if (found && !stale && lastParams && lastParams !== params) setStale(true);

  const run = async () => {
    setState("reading");
    const raws: TracksFile[] = [];
    for (const o of parts) {
      if (o.file.auto) continue; // ids of a part nobody corrected are the program's: its colours do not match them
      const f = o.file;
      const txt = await readLocal(`matches/${folder}/tracking/tracks_${f.video_id}_${f.start_frame}_${f.end_frame}.json`);
      try {
        const t = JSON.parse(txt ?? "null") as TracksFile | null;
        if (t && Array.isArray(t.frames)) raws.push(t);
      } catch {
        // A part that cannot be read leaves its people without colour.
      }
    }
    setState("computing");
    await new Promise((r) => setTimeout(r, 20));
    const entries = raws.map((t) => {
      const edits = trackEdits.find((e) => e.key === editsKey(t)) ?? emptyEdits(editsKey(t));
      return { video_id: t.video_id, part: t.start_frame, people: people(t, edits).map((p) => ({ id: p.id, lab: p.lab })) };
    });
    const refs = raws.map((t) => fileTeamRefs(t));
    const own = medianLab(refs.map((r) => (r.own as Lab | undefined) ?? null));
    const opp = medianLab(refs.map((r) => (r.opp as Lab | undefined) ?? null));
    const list = suspectBoxes(parts, segmentsByVideo, { params, teamLab: { ...(own ? { own } : {}), ...(opp ? { opp } : {}) }, labOf: labIndex(entries), top: 30 });
    setFound({ list, colours: !!own && !!opp, parts: raws.length });
    setLastParams(params);
    setStale(false);
    setState("idle");
  };

  const href = `/partido?id=${encodeURIComponent(matchId)}&modo=captura&paso=tracking`;
  return (
    <Card title="Cajas sospechosas" note="Ordenadas por los segundos de posesión que deciden">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={state !== "idle" || parts.length === 0} onClick={() => void run()}>
          <MagnifyingGlass size={14} />
          {found ? "Buscar de nuevo" : "Buscar cajas sospechosas"}
        </button>
        <span className="text-xs text-faint" aria-live="polite">
          {state === "reading" ? "Leyendo los colores de camiseta de las partes…" : state === "computing" ? "Calculando el efecto de cada caja…" : stale ? "Los parámetros cambiaron: busca de nuevo para actualizar la lista." : ""}
        </span>
      </div>
      {found && (
        <>
          {!found.colours && (
            <p className="mt-2 text-xs text-warn">
              No se pudo leer el color de camiseta de ambos equipos ({found.parts} partes con color): no se revisa «rival que se viste como nosotras». Solo se listan cajas sin equipo y las pegadas a la banda.
            </p>
          )}
          <div ref={boxRef} className="mt-3 overflow-hidden" style={{ height: ROW_H * 4 }}>
            {found.list.length === 0 ? (
              <p className="text-sm text-faint">Ninguna caja decide más de medio segundo de posesión con estas señales. Eso no prueba que todas estén bien.</p>
            ) : (
              rows.map((s) => (
                <div key={`${s.key}|${s.reason}`} className="flex items-start gap-3 border-b border-line-soft py-2" style={{ height: ROW_H }}>
                  <div className="min-w-0 flex-1 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tag tag-warn">{SUSPECT_LABEL[s.reason]}</span>
                      <span className="text-ink">
                        {s.reason === "contested_pair" && s.box && s.other
                          ? `#${s.box.id} (${TEAM_NAME[s.box.team] ?? s.box.team}, ${s.box.d.toFixed(2)} m) y #${s.other.id} (${TEAM_NAME[s.other.team] ?? s.other.team}, ${s.other.d.toFixed(2)} m)`
                          : (s.name ?? `Caja #${s.person_id}`)}
                      </span>
                      {s.reason !== "contested_pair" && <span className="text-faint">marcada: {TEAM_NAME[s.team] ?? s.team}</span>}
                      <span className="tc text-faint">
                        {s.video_id} · {fmtT(s.t)} · {s.influence_s.toLocaleString("es-MX", { maximumFractionDigits: 1 })} s
                      </span>
                    </div>
                    <p className="mt-1 text-muted">{s.note}</p>
                    {effectText(s.effect_if, s.reason).map((t) => (
                      <p key={t} className="tc truncate text-faint">
                        {t}
                      </p>
                    ))}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <button type="button" className="btn" onClick={() => onView(s)}>
                      Ver el cuadro
                    </button>
                    <Link className="link text-xs" href={href} title={`Abre Tracking; busca a ${s.name ?? `la caja #${s.person_id}`} cerca de ${fmtT(s.t)}`}>
                      Corregir en la mesa
                    </Link>
                  </div>
                </div>
              ))
            )}
          </div>
          <Pager page={page} pages={pages} setPage={setPage} />
          <p className="mt-2 text-xs text-faint">
            Cambiar el equipo de una caja se hace en la mesa de corrección y se vuelve a exportar; aquí solo se estima el efecto sobre la posesión.
          </p>
        </>
      )}
    </Card>
  );
}
