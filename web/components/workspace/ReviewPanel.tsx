"use client";

import { ArrowCounterClockwise, Trash, ArrowClockwise, CheckCircle, Circle, DownloadSimple, Flask, Lightning, MagicWand, Play, Scales } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { RunControl, TIMING_KEY } from "@/components/workspace/AnchorsPanel";
import { anchorPaths, DOUBT_LABELS, editsFromLinks, linksProtection, type LinksFile, type TimedAction } from "@/lib/anchors";
import {
  autoResolve,
  comparisonMarkdown,
  countEdits,
  exampleExpPath,
  exampleExp,
  resetPart,
  REASON_LABELS,
  startReview,
  switchVersion,
  versionEdits,
  versionMetrics,
  type VersionMetrics,
} from "@/lib/compare";
import { downloadText } from "@/lib/format";
import { readLocal, writeLocal } from "@/lib/local";
import { mutate, setPref, usePref } from "@/lib/store";
import { people as peopleOf, type Person, type TracksFile } from "@/lib/tracks";
import type { PartReview, ReviewVersion, ReviewVersionId, TrackEdits } from "@/lib/types";

// Revisión tab of the correction table: version A (links_<part>.json) against version B (the experiment,
// links_<part>_exp.json) on the same part. Each version keeps its own edits (lib/compare.ts); this panel switches
// between them, loads each fill, resolves automatically, and measures the work done by hand in each one.

const VERIFY_PER_PAGE = 5;
const VERSIONS: ReviewVersionId[] = ["A", "B"];

export function ReviewPanel({
  folder,
  part,
  data,
  edits,
  review,
  people,
  named,
  setEdits,
  onMsg,
}: {
  folder: string;
  part: string;
  data: TracksFile;
  edits: TrackEdits;
  review: PartReview | undefined;
  people: Pick<Person, "id" | "player_id" | "done" | "tracks">[];
  named: Map<string, number>;
  // Undoable change of the open version's edits (Ctrl + Z goes back inside that version only).
  setEdits: (next: TrackEdits) => void;
  onMsg: (text: string) => void;
}) {
  const pathA = anchorPaths(folder, part).links;
  const pathB = anchorPaths(folder, part, false, "exp").links;
  const pathEx = exampleExpPath(folder, part);
  const [links, setLinks] = useState<Record<ReviewVersionId, LinksFile | null>>({ A: null, B: null });
  const [bExists, setBExists] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);
  const exampleB = !!review?.B.example;
  useEffect(() => {
    let live = true;
    void Promise.all([readLocal(pathA), readLocal(pathB), readLocal(pathEx)]).then(([a, b, ex]) => {
      if (!live) return;
      const parse = (t: string | null) => {
        try {
          return t ? (JSON.parse(t) as LinksFile) : null;
        } catch {
          return null;
        }
      };
      setBExists(!!b);
      setLinks({ A: parse(a), B: exampleB ? parse(ex) : parse(b) });
    });
    return () => {
      live = false;
    };
  }, [pathA, pathB, pathEx, exampleB, nonce]);

  const timingRaw = usePref(TIMING_KEY, "[]");
  const timing = useMemo(() => {
    try {
      return (JSON.parse(timingRaw) as TimedAction[]).filter((t) => t.part === part);
    } catch {
      return [];
    }
  }, [timingRaw, part]);

  const saveReview = (r: PartReview, nextEdits?: TrackEdits) =>
    mutate((s) => ({
      ...s,
      reviews: [...(s.reviews ?? []).filter((x) => x.key !== r.key), r],
      ...(nextEdits ? { trackEdits: [...s.trackEdits.filter((e) => e.key !== nextEdits.key), nextEdits] } : {}),
    }));
  const patchVersion = (v: ReviewVersionId, patch: Partial<ReviewVersion>) => review && saveReview({ ...review, [v]: { ...review[v], ...patch } });

  const metrics = useMemo<VersionMetrics[] | null>(() => {
    if (!review) return null;
    return VERSIONS.map((v) =>
      versionMetrics(
        data,
        versionEdits(review, v, edits),
        links[v],
        review[v],
        v,
        timing.filter((t) => t.version === v),
      ),
    );
  }, [review, data, edits, links, timing]);

  const [ask, setAsk] = useState<null | { l: LinksFile; prot: ReturnType<typeof linksProtection> }>(null);
  const [vPage, setVPage] = useState(0);
  // The breakdown rows (by kind of doubt, by reason, by kind of edit) only when asked: the panel fits the window.
  const [detail, setDetail] = useState(false);

  if (!review) {
    const loaded = (edits.anchorDoubts ?? []).length > 0 || Object.keys(edits.identity).length > 0;
    return (
      <section className="card space-y-2 !p-3 text-xs text-ink-2">
        <h2 className="cond flex items-center gap-1.5 text-sm font-bold tracking-wide text-ink uppercase">
          <Scales size={15} /> Revisión A vs B
        </h2>
        <p>
          Compara en esta parte el relleno actual (A, <span className="tc">links_{part}.json</span>) con el experimento (B,{" "}
          <span className="tc">links_{part}_exp.json</span>). Cada versión guarda sus propias ediciones de la mesa; nunca se mezclan.
        </p>
        <p>Al empezar se guarda una instantánea de cómo está la mesa ahora: las dos versiones parten de ella.</p>
        {loaded && <p className="rounded-lg bg-warn-900/60 px-2.5 py-1.5 text-[11px] text-warn">La mesa ya tiene cambios en esta parte: la instantánea los incluye. Para una comparación limpia, empieza antes de cargar ningún relleno.</p>}
        <button type="button" className="btn btn-primary w-full justify-center" onClick={() => saveReview(startReview(edits.key, edits))}>
          <Play size={14} /> Empezar la comparación
        </button>
        <ResetPart folder={folder} part={part} editsKey={edits.key} review={review} metrics={null} onMsg={onMsg} />
      </section>
    );
  }

  const active = review.active;
  const cur = review[active];
  const curLinks = links[active];
  const go = (v: ReviewVersionId) => {
    if (v === active) return;
    const r = switchVersion(review, edits, v);
    saveReview(r.review, r.edits);
    onMsg(`Ahora estás en la versión ${v}. Ctrl + Z deshace solo dentro de esta versión.`);
  };

  // Loading a fill into the open version: the same warning as in Anclas before touching named or verified players.
  // B is loaded without its drops: they are applied by «Resolver automático», so they can be counted.
  const loadFill = () => {
    if (!curLinks) return onMsg(`No hay relleno para ${active}: ${active === "A" ? `links_${part}.json` : `links_${part}_exp.json`} no existe.`);
    const l = active === "B" ? { ...curLinks, drops: [] } : curLinks;
    const prot = linksProtection(people);
    if (prot.list.length) return setAsk({ l, prot });
    applyFill(l);
  };
  const applyFill = (l: LinksFile, protect?: { ids: Set<number>; tracks: Set<number> }) => {
    setAsk(null);
    const r = editsFromLinks(edits, data, l, named, protect);
    setEdits(r.edits);
    patchVersion(active, { loaded: active === "B" && exampleB ? "ejemplo (app)" : (active === "A" ? pathA : pathB).split("/").pop() });
    onMsg(`Versión ${active} cargada: ${r.players} jugadora(s), ${r.tracks} trozo(s)${r.dropped ? `, ${r.dropped} caja(s) doble(s) quitada(s)` : ""}. Ctrl + Z lo deshace.`);
  };

  const resolveAuto = () => {
    const r = autoResolve(edits, data, curLinks, active);
    setEdits(r.edits);
    // Summing with an earlier run of the button in this version.
    const byReason = { ...(cur.auto?.byReason ?? {}) };
    for (const [k, x] of Object.entries(r.byReason)) byReason[k] = { boxes: (byReason[k]?.boxes ?? 0) + x.boxes, doubts: (byReason[k]?.doubts ?? 0) + x.doubts };
    patchVersion(active, { auto: { doubts: [...new Set([...(cur.auto?.doubts ?? []), ...r.doubts])], byReason }, checkpoint: r.edits });
    const parts = Object.entries(r.byReason).map(([k, x]) => `${REASON_LABELS[k] ?? k}: ${x.boxes} caja(s), ${x.doubts} duda(s)`);
    onMsg(parts.length ? `Resuelto automático en ${active}: ${parts.join(" · ")}. Desde aquí se cuentan tus ediciones.` : `Nada que resolver automáticamente en ${active}. Desde aquí se cuentan tus ediciones.`);
  };

  const makeExample = async () => {
    if (!links.A) return onMsg(`El ejemplo de B se hace a partir de A: falta links_${part}.json.`);
    const ex = exampleExp(links.A, data, review.base);
    const ok = await writeLocal(pathEx, JSON.stringify(ex, null, 1));
    if (!ok) return onMsg("No se pudo escribir el ejemplo en la carpeta del partido (¿la app corre en esta computadora?).");
    patchVersion("B", { example: true });
    setNonce((n) => n + 1);
    onMsg("Versión B de EJEMPLO generada en la app (no es el experimento de Python).");
  };
  const useRealB = () => {
    patchVersion("B", { example: false });
    setNonce((n) => n + 1);
  };

  // Verification by hand: the players named in either version.
  const names = [...new Set(VERSIONS.flatMap((v) => peopleOf(data, versionEdits(review, v, edits)).map((p) => p.player_id)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const perPlayer = Object.fromEntries(VERSIONS.map((v) => [v, review[v].checkpoint ? countEdits(review[v].checkpoint!, versionEdits(review, v, edits)).byPlayer : null])) as Record<ReviewVersionId, Record<string, number> | null>;
  const vPages = Math.max(1, Math.ceil(names.length / VERIFY_PER_PAGE));
  const page = Math.min(vPage, vPages - 1);
  const toggleVerified = (v: ReviewVersionId, name: string) => {
    const set = new Set(review[v].verified ?? []);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    patchVersion(v, { verified: [...set].sort() });
  };

  const exportJson = () =>
    downloadText(
      `comparacion_${part}.json`,
      JSON.stringify({ match_id: data.match_id, part, exported: new Date().toISOString(), example_b: exampleB, versions: metrics }, null, 1),
      "application/json",
    );
  const exportMd = () => metrics && downloadText(`comparacion_${part}.md`, comparisonMarkdown(data.match_id, part, metrics), "text/markdown");

  const m = metrics!;
  const kinds = [...new Set(m.flatMap((x) => Object.keys(x.pending)))];
  const reasons = [...new Set(m.flatMap((x) => Object.keys(x.auto_boxes)))];
  const row = (label: string, a: React.ReactNode, b: React.ReactNode, sub = false) => (
    <tr key={label} className={sub ? "text-faint" : ""} hidden={sub && !detail}>
      <td className={`py-0.5 pr-2 ${sub ? "pl-2" : ""}`}>{label}</td>
      <td className={`tc py-0.5 text-right ${active === "A" ? "text-ink" : ""}`}>{a}</td>
      <td className={`tc py-0.5 text-right ${active === "B" ? "text-ink" : ""}`}>{b}</td>
    </tr>
  );
  const fmtS = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

  return (
    <section className="card space-y-2.5 !p-3 text-xs">
      {ask && (
        <Modal title="El relleno toca jugadoras de la mesa" onClose={() => setAsk(null)}>
          <p className="text-sm text-ink-2">
            En la versión {active} hay {ask.prot.list.filter((x) => x.done).length} jugadora(s) verificada(s) y {ask.prot.list.filter((x) => !x.done).length} con nombre sin verificar. El relleno puede cambiarles trozos.
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setAsk(null)}>
              Cancelar
            </button>
            <button type="button" className="btn" onClick={() => applyFill(ask.l)}>
              Sobreescribir todo
            </button>
            <button type="button" className="btn btn-primary" autoFocus onClick={() => applyFill(ask.l, ask.prot)}>
              Aplicar solo a las demás
            </button>
          </div>
        </Modal>
      )}
      <div className="flex items-center gap-2">
        <h2 className="cond flex flex-1 items-center gap-1.5 text-sm font-bold tracking-wide text-ink uppercase">
          <Scales size={15} /> Revisión A vs B
        </h2>
        <div className="seg" role="group" aria-label="Versión abierta">
          {VERSIONS.map((v) => (
            <button key={v} type="button" className="seg-opt !px-3 font-bold" aria-pressed={active === v} title={v === "A" ? "A: relleno actual" : "B: experimento"} onClick={() => go(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>
      <p className={`rounded-lg px-2.5 py-1.5 text-[11px] ${active === "A" ? "bg-accent-900/60 text-accent-100" : "bg-warn-900/60 text-warn"}`}>
        Estás en la versión <b>{active}</b> ({active === "A" ? "relleno actual" : "experimento"}): la mesa, Anclas y Dudas trabajan sobre {active}; Ctrl + Z deshace solo aquí.
      </p>
      {active === "B" && exampleB && (
        <p className="rounded-lg bg-warn-900/60 px-2.5 py-1.5 text-[11px] text-warn">
          <Flask size={12} className="mr-1 inline" />
          B es de EJEMPLO: generado en la app a partir de A (cajas dobles y saltos como «drops»), no el experimento de Python.{" "}
          {bExists && (
            <button type="button" className="underline" onClick={useRealB}>
              Usar el real
            </button>
          )}
        </p>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" className="btn btn-primary justify-center" disabled={!curLinks} title={curLinks ? undefined : "Aún no existe el archivo de relleno de esta versión"} onClick={loadFill}>
          <ArrowClockwise size={14} /> Cargar {active}
        </button>
        <button type="button" className="btn justify-center" disabled={!curLinks && active === "B"} onClick={resolveAuto} title={active === "A" ? "Quita los saltos de ida y vuelta de 0.8 s o menos" : "Aplica los drops del experimento (exclusión, ruta, ambas, salto)"}>
          <MagicWand size={14} /> Resolver automático
        </button>
      </div>
      {cur.loaded && <p className="text-[11px] text-faint">Cargado: {cur.loaded}</p>}
      {active === "B" && (
        <div className="space-y-1.5 border-t border-line pt-2">
          <RunControl
            match={folder}
            part={part}
            task="fill"
            variant="exp"
            label="Rellenar B (experimento)"
            icon={<Lightning size={14} />}
            warn={() => (bExists ? `Se reescribe links_${part}_exp.json. La versión A y sus ediciones no se tocan.` : null)}
            onDone={() => {
              patchVersion("B", { example: false });
              setNonce((n) => n + 1);
            }}
          />
          {bExists === false && !exampleB && (
            <button type="button" className="btn btn-ghost w-full justify-center" onClick={() => void makeExample()}>
              <Flask size={14} /> Mientras tanto: B de ejemplo
            </button>
          )}
        </div>
      )}
      {!cur.checkpoint && cur.loaded && (
        <button type="button" className="btn btn-ghost w-full justify-center text-[11px]" onClick={() => patchVersion(active, { checkpoint: edits })}>
          Contar mis ediciones desde aquí (sin resolver automático)
        </button>
      )}

      <table className="w-full border-t border-line pt-1">
        <thead>
          <tr className="text-faint">
            <th className="py-1 text-left font-normal">
              <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-ink" aria-expanded={detail} onClick={() => setDetail((d) => !d)}>
                {detail ? "Ocultar el detalle" : "Ver el detalle"}
              </button>
            </th>
            <th className="w-14 text-right font-bold">A</th>
            <th className="w-14 text-right font-bold">B{exampleB ? "*" : ""}</th>
          </tr>
        </thead>
        <tbody>
          {row("Tareas pendientes", m[0].pending_total, m[1].pending_total)}
          {kinds.map((k) => row(DOUBT_LABELS[k] ?? k, m[0].pending[k] ?? 0, m[1].pending[k] ?? 0, true))}
          {row("Dudas resueltas por ti", m[0].resolved_by_hand, m[1].resolved_by_hand)}
          {row("Dudas autoresueltas", m[0].auto_doubts, m[1].auto_doubts)}
          {reasons.map((k) => row(`Cajas quitadas · ${REASON_LABELS[k] ?? k}`, m[0].auto_boxes[k] ?? 0, m[1].auto_boxes[k] ?? 0, true))}
          {row("Cajas dobles que quedan", m[0].double_boxes, m[1].double_boxes)}
          {row("Saltos imposibles que quedan", m[0].impossible_jumps, m[1].impossible_jumps)}
          {row("Ediciones manuales", m[0].manual?.total ?? "—", m[1].manual?.total ?? "—")}
          {row(
            "unir · partir · quitar · renombrar",
            m[0].manual ? `${m[0].manual.merge}·${m[0].manual.split}·${m[0].manual.drop + m[0].manual.remove}·${m[0].manual.rename}` : "—",
            m[1].manual ? `${m[1].manual.merge}·${m[1].manual.split}·${m[1].manual.drop + m[1].manual.remove}·${m[1].manual.rename}` : "—",
            true,
          )}
          {row("Cronómetro", fmtS(m[0].seconds), fmtS(m[1].seconds))}
        </tbody>
      </table>
      {exampleB && <p className="text-[11px] text-warn">* B con datos de ejemplo.</p>}
      <div className="flex gap-1.5">
        <button type="button" className="btn btn-ghost flex-1 justify-center" onClick={exportJson}>
          <DownloadSimple size={13} /> JSON
        </button>
        <button type="button" className="btn btn-ghost flex-1 justify-center" onClick={exportMd}>
          <DownloadSimple size={13} /> Markdown
        </button>
      </div>

      <ResetPart folder={folder} part={part} editsKey={edits.key} review={review} metrics={metrics} exampleB={exampleB} onMsg={onMsg} />
      <div className="border-t border-line pt-2">
        <p className="mb-1 flex items-baseline justify-between text-ink-2">
          <span>Verificación de identidades</span>
          <span className="tc text-[11px] text-faint">✓ · correcciones</span>
        </p>
        {names.length === 0 ? (
          <p className="text-faint">Aún no hay jugadoras con nombre en ninguna versión.</p>
        ) : (
          <ul className="space-y-0.5">
            {names.slice(page * VERIFY_PER_PAGE, (page + 1) * VERIFY_PER_PAGE).map((n) => (
              <li key={n} className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-ink">{n}</span>
                {VERSIONS.map((v) => {
                  const ok = (review[v].verified ?? []).includes(n);
                  const c = perPlayer[v]?.[n];
                  return (
                    <button
                      key={v}
                      type="button"
                      className={`inline-flex w-16 items-center justify-end gap-1 rounded px-1 ${ok ? "text-ok" : "text-faint"} ${active === v ? "bg-raised" : ""}`}
                      aria-pressed={ok}
                      title={`${n} en ${v}: ${ok ? "verificada" : "sin verificar"} · ${c ?? 0} corrección(es) a mano`}
                      onClick={() => toggleVerified(v, n)}
                    >
                      <span className="text-[10px] font-bold">{v}</span>
                      {ok ? <CheckCircle size={13} weight="fill" /> : <Circle size={13} />}
                      <span className="tc w-4 text-right">{perPlayer[v] ? (c ?? 0) : "—"}</span>
                    </button>
                  );
                })}
              </li>
            ))}
          </ul>
        )}
        {vPages > 1 && (
          <div className="mt-1 flex items-center justify-center gap-2 text-faint">
            <button type="button" className="btn btn-ghost !px-2 !py-0.5" disabled={page === 0} onClick={() => setVPage(page - 1)}>
              ‹
            </button>
            <span className="tc">
              {page + 1} / {vPages}
            </span>
            <button type="button" className="btn btn-ghost !px-2 !py-0.5" disabled={page >= vPages - 1} onClick={() => setVPage(page + 1)}>
              ›
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// «Empezar de cero esta parte»: deletes the anchors and fills of the part (files, through DELETE /api/run/anchors with
// its whitelist) and what the browser keeps of it; the table goes back to the snapshot of «Empezar la comparación».
// The suggestions, tracks and labels are never touched.
function ResetPart({
  folder,
  part,
  editsKey,
  review,
  metrics,
  exampleB = false,
  onMsg,
}: {
  folder: string;
  part: string;
  editsKey: string;
  review: PartReview | undefined;
  metrics: VersionMetrics[] | null;
  exampleB?: boolean;
  onMsg: (text: string) => void;
}) {
  const [open, setOpen] = useState<null | { files: { path: string; bytes: number }[]; error?: string }>(null);
  const timingRaw = usePref(TIMING_KEY, "[]");
  const skipped = usePref(`anchors:skipped:${folder}:${part}`, "").split(",").filter(Boolean).length;
  const timing = (() => {
    try {
      return JSON.parse(timingRaw) as TimedAction[];
    } catch {
      return [];
    }
  })();
  const mine = timing.filter((t) => t.part === part);
  const doubts = new Set([...(review?.A.edits?.anchorDoubts ?? []), ...(review?.B.edits?.anchorDoubts ?? [])]).size;
  type Res = { files?: { path: string; bytes: number }[]; deleted?: unknown[]; failed?: string[]; error?: string };
  const call = (dry: boolean): Promise<{ ok: boolean; body: Res }> =>
    fetch("/api/run/anchors", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ match: folder, part, dry }) })
      .then(async (r) => ({ ok: r.ok, body: (await r.json().catch(() => ({}))) as Res }))
      .catch(() => ({ ok: false, body: { error: "No se pudo hablar con la app (¿corre en esta computadora?)." } }));
  const ask = async () => {
    const r = await call(true);
    setOpen({ files: r.body.files ?? [], error: r.ok ? undefined : (r.body.error ?? "Solo funciona con la app abierta en esta computadora.") });
  };
  const exportFirst = () =>
    downloadText(`antes_de_borrar_${part}.json`, JSON.stringify({ match_id: folder, part, exported: new Date().toISOString(), example_b: exampleB, comparison: metrics, review, timing: mine }, null, 1), "application/json");
  const run = async () => {
    const r = await call(false);
    if (!r.ok) return onMsg(r.body.error ?? "No se pudieron borrar los archivos.");
    let prefKeys: string[] = [];
    let kept: unknown[] = timing;
    mutate((s) => {
      const out = resetPart(s, editsKey, part, folder, timing);
      prefKeys = out.prefKeys;
      kept = out.timing;
      return out.state;
    });
    setPref(TIMING_KEY, JSON.stringify(kept));
    for (const k of prefKeys) setPref(k, "");
    setOpen(null);
    const failed = r.body.failed ?? [];
    onMsg(`Parte en cero: ${(r.body.deleted ?? []).length} archivo(s) borrado(s)${failed.length ? `; no se pudieron borrar ${failed.length}` : ""}. La mesa volvió a como estaba antes de la comparación. No se puede deshacer.`);
  };
  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <>
      <button type="button" className="btn btn-ghost w-full justify-center text-danger" onClick={() => void ask()}>
        <Trash size={14} /> Empezar de cero esta parte
      </button>
      {open && (
        <Modal title="Empezar de cero esta parte" onClose={() => setOpen(null)}>
          <div className="space-y-2 text-sm text-ink-2">
            <p>Se borra todo el trabajo de anclas y revisión de la parte {part}. No se puede deshacer.</p>
            <p className="text-xs font-bold text-ink">Archivos de la carpeta del partido</p>
            {open.error ? (
              <p className="text-xs text-warn">{open.error} Sin esto no se borra nada.</p>
            ) : open.files.length ? (
              <ul className="tc text-xs">
                {open.files.map((f) => (
                  <li key={f.path}>
                    {f.path.split("/").slice(-2).join("/")} <span className="text-faint">({kb(f.bytes)})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">Ninguno.</p>
            )}
            <p className="text-xs font-bold text-ink">En este navegador</p>
            <ul className="list-disc pl-4 text-xs">
              <li>{skipped} ancla(s) saltada(s)</li>
              <li>{doubts} duda(s) resuelta(s) guardadas en la comparación, y las de la mesa</li>
              <li>{review ? "La comparación A/B: sus dos versiones, instantáneas y verificaciones; la mesa vuelve a la instantánea inicial" : "Sin comparación empezada: la mesa se queda como está, salvo las dudas resueltas"}</li>
              <li>{mine.length} acción(es) del cronómetro de esta parte</li>
            </ul>
            <p className="text-xs text-ok">Se conservan: suggest_{part}.json, los tracks y labels, y las ediciones de la mesa anteriores a «Empezar la comparación».</p>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn" onClick={exportFirst}>
              <DownloadSimple size={14} /> Exportar antes
            </button>
            <button type="button" className="btn btn-primary" autoFocus onClick={() => setOpen(null)}>
              <ArrowCounterClockwise size={14} /> Cancelar
            </button>
            <button type="button" className="btn text-danger" disabled={!!open.error} onClick={() => void run()}>
              <Trash size={14} /> Borrar y empezar de cero
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
