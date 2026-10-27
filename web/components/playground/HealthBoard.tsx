"use client";

import { useEffect, useMemo, useState } from "react";
import { readLocal } from "@/lib/local";
import { passItems, parsePassReview, passReviewPath } from "@/lib/playgroundPasses";
import {
  LIGHT_LABEL, ballIndicator, ballMeasuredByVideo, currentReviews, passesIndicator, possessionIndicator, sumReviews, type Indicator, type Light, type ReviewCount,
} from "@/lib/playgroundHealth";
import { parseReview, reviewPath, rowId } from "@/lib/playgroundPossession";
import { summarizePossession } from "@/lib/possession";
import type { PlaygroundCtx } from "./context";

const DOT: Record<Light, string> = { green: "bg-ok", amber: "bg-warn", red: "bg-danger", none: "bg-line-strong" };
const TEXT: Record<Light, string> = { green: "text-ok", amber: "text-warn", red: "text-danger", none: "text-faint" };

// Verdicts of every video of the match, read from matches/<id>/possession_review_<v>.json and passes_review_<v>.json.
// `version` changes when a check saves, so the board follows what the analyst just marked.
function useReviewCounts(ctx: PlaygroundCtx, version: number) {
  const { folder, videoIds, result, fixed, segmentsByVideo } = ctx;
  const [files, setFiles] = useState<{ poss: { id: string; verdict: string }[][]; pass: { id: string; verdict: string }[][] } | null>(null);
  const key = videoIds.join(",");
  useEffect(() => {
    let live = true;
    void (async () => {
      const poss = await Promise.all(videoIds.map(async (v) => parseReview(await readLocal(reviewPath(folder, v)), v).reviews));
      const pass = await Promise.all(videoIds.map(async (v) => parsePassReview(await readLocal(passReviewPath(folder, v)), v).reviews));
      if (live) setFiles({ poss, pass });
    })();
    return () => {
      live = false;
    };
  }, [folder, key, version]); // eslint-disable-line react-hooks/exhaustive-deps -- videoIds follows key
  return useMemo(() => {
    if (!files) return null;
    const rowIds = new Set((result?.rows ?? []).map(rowId));
    const items = fixed ? new Set(passItems(fixed.parts, segmentsByVideo).map((p) => p.id)) : new Set<string>();
    const poss: ReviewCount = sumReviews(files.poss.map((r) => currentReviews(r, rowIds)));
    const pass: ReviewCount = sumReviews(files.pass.map((r) => currentReviews(r, items)));
    return { poss, pass };
  }, [files, result, fixed, segmentsByVideo]);
}

function IndicatorCard({ ind }: { ind: Indicator }) {
  return (
    <section className="card !p-3" aria-label={ind.title}>
      <h3 className="m-0 text-sm font-semibold text-ink">{ind.title}</h3>
      <ul className="m-0 mt-2 list-none space-y-1.5 p-0">
        {ind.metrics.map((m) => (
          <li key={m.label} className="flex items-start gap-2 text-xs">
            <i className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[m.light]}`} aria-hidden />
            <span className="min-w-0">
              <span className="text-muted">{m.label}: </span>
              <span className="text-ink">{m.text}</span>
              <span className={`ml-1.5 font-medium ${TEXT[m.light]}`}>{LIGHT_LABEL[m.light]}</span>
              {m.note && <span className="block text-[11px] text-faint">{m.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-2 border-t border-line-soft pt-1.5 text-[11px] text-faint">{ind.rule}</p>
    </section>
  );
}

// The board at the top of the Playground: ball, possession and passes with a colour and the rule of the colour in words.
export function HealthBoard({ ctx, version }: { ctx: PlaygroundCtx; version: number }) {
  const counts = useReviewCounts(ctx, version);
  const indicators = useMemo(() => {
    const samples = ctx.result?.samples ?? [];
    const summary = ctx.result ? summarizePossession(samples) : null;
    const none: ReviewCount = { reviewed: 0, correct: 0 };
    return [
      ballIndicator(ballMeasuredByVideo(samples, (v) => ctx.videos.find((x) => x.video_id === v)?.label || v)),
      possessionIndicator(summary, counts?.poss ?? none),
      passesIndicator(counts?.pass ?? none),
    ];
  }, [ctx.result, ctx.videos, counts]);
  return (
    <div className="grid gap-3 lg:grid-cols-3" aria-label="Indicadores de confianza">
      {ctx.fixed === null ? <p className="text-sm text-faint lg:col-span-3">Leyendo las posiciones del partido…</p> : indicators.map((i) => <IndicatorCard key={i.id} ind={i} />)}
    </div>
  );
}
