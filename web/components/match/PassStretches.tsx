"use client";

import { useMemo } from "react";
import { Card } from "@/components/Shell";
import { useFixedParts } from "@/lib/fixed";
import { fmtT } from "@/lib/format";
import { PASS_BALL_SHARE, PASS_PLAYERS_SHARE, passStretches } from "@/lib/positions";
import { segmentsFromMarks } from "@/lib/segments";
import { useStore } from "@/lib/store";
import type { Match } from "@/lib/types";
import { matchVideos, videoOf } from "@/lib/videos";

const pct = (v: number) => `${Math.round(v * 100)} %`;

// Passes come from the tracking (players and ball), never tagged by hand: which stretches of play have them.
export function PassStretchesCard({ match }: { match: Match }) {
  const { segments } = useStore();
  const videos = matchVideos(match);
  const fixed = useFixedParts(match.folder, videos.map((v) => v.video_id));
  const byVideo = useMemo(
    () =>
      Object.fromEntries(
        videos.map((v) => [v.video_id, segmentsFromMarks(segments.filter((g) => g.match_id === match.match_id && videoOf(g) === v.video_id))]),
      ),
    [segments, match.match_id, videos],
  );
  const rows = useMemo(() => passStretches(fixed?.parts ?? [], byVideo), [fixed, byVideo]);
  const done = rows.filter((r) => r.done).length;
  const label = (v: string) => (videos.length > 1 ? `${videos.find((x) => x.video_id === v)?.label ?? v} ` : "");

  return (
    <Card
      title="Pases leídos del tracking"
      note={rows.length ? `${done} de ${rows.length} tramos de juego completos` : undefined}
    >
      <p className="mb-3 text-xs text-muted">
        Los pases no se etiquetan a mano: salen del balón seguido y de las jugadoras con tracking (red de pases y pases por zona en el
        Informe). Un tramo queda completo con el equipo analizado seguido en al menos {pct(PASS_PLAYERS_SHARE)} de su tiempo y el balón en
        al menos {pct(PASS_BALL_SHARE)}; el rival seguido es un plus. Sin tracking no hay pases.
      </p>
      {!fixed ? (
        <p className="text-sm text-faint">Leyendo el tracking de la carpeta del partido…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-faint">Marca los tramos de juego (pestaña Tramos) para ver qué partes tienen pases.</p>
      ) : (
        <div>
          <table className="w-full text-xs">
            <thead className="text-left text-faint">
              <tr>
                <th className="py-1 font-normal">Tramo</th>
                <th className="py-1 font-normal">{match.focus_team}</th>
                <th className="py-1 font-normal">{match.other_team}</th>
                <th className="py-1 font-normal">Balón</th>
                <th className="py-1 font-normal">Pases</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.video_id}_${r.segment_id}`} className="border-t border-line-soft">
                  <td className="tc py-1">
                    {label(r.video_id)}
                    {fmtT(r.start)}–{fmtT(r.end)}
                  </td>
                  <td className={r.own >= PASS_PLAYERS_SHARE ? "text-ok" : "text-muted"}>{pct(r.own)}</td>
                  <td className="text-muted">{pct(r.opp)}</td>
                  <td className={r.ball >= PASS_BALL_SHARE ? "text-ok" : "text-muted"}>{pct(r.ball)}</td>
                  <td>{r.done ? <span className="tag tag-accent">completo</span> : <span className="text-faint">falta tracking</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
