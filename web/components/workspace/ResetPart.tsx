"use client";

import { ArrowCounterClockwise, DownloadSimple, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { downloadText } from "@/lib/format";
import { resetPart } from "@/lib/reset";
import { mutate, setPref, usePref, useStore } from "@/lib/store";

// «Empezar de cero esta parte»: deletes the anchors and fills of the part (files, through DELETE /api/run/anchors with
// its whitelist) and what the browser keeps of it; the table goes back to the snapshot of «Empezar la comparación».
// The suggestions, tracks and labels are never touched.
export function ResetPart({
  folder,
  part,
  editsKey,
  onMsg,
}: {
  folder: string;
  part: string;
  editsKey: string;
  onMsg: (text: string) => void;
}) {
  const [open, setOpen] = useState<null | { files: { path: string; bytes: number }[]; error?: string }>(null);
  const skipped = usePref(`anchors:skipped:${folder}:${part}`, "").split(",").filter(Boolean).length;
  const state = useStore();
  // Data of the old comparison tab (State.reviews) may still be in this browser: it goes too.
  const review = (state.reviews ?? []).find((r) => r.key === editsKey);
  const doubts = (state.trackEdits.find((e) => e.key === editsKey)?.anchorDoubts ?? []).length;
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
    downloadText(`antes_de_borrar_${part}.json`, JSON.stringify({ match_id: folder, part, exported: new Date().toISOString(), resolved_doubts: doubts }, null, 1), "application/json");
  const run = async () => {
    const r = await call(false);
    if (!r.ok) return onMsg(r.body.error ?? "No se pudieron borrar los archivos.");
    let prefKeys: string[] = [];
    mutate((s) => {
      const out = resetPart(s, editsKey, part, folder, []);
      prefKeys = out.prefKeys;
      return out.state;
    });
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
              <li>{doubts} duda(s) resuelta(s) en la mesa (la mesa se queda como está, salvo eso)</li>
              {review && <li>Una comparación A/B guardada de antes: la mesa vuelve a como estaba al empezarla</li>}
            </ul>
            <p className="text-xs text-ok">Se conservan: suggest_{part}.json, los tracks y labels, y las demás ediciones de la mesa (uniones, nombres, cajas quitadas a mano).</p>
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
