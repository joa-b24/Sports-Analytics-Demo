"use client";

import { DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { downloadText } from "@/lib/format";
import { retrySave, useSaveError, useStore } from "@/lib/store";

// Persistent warning when the browser could not store the work. It stays until a save works again, and offers the
// backup download at once (the state lives in memory in the meantime).
export function StorageNotice() {
  const error = useSaveError();
  const state = useStore();
  if (!error) return null;
  return (
    <div role="alert" className="fixed inset-x-3 bottom-3 z-[100] mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-danger bg-surface p-3 text-sm text-ink shadow-lg print:hidden">
      <WarningCircle size={22} className="shrink-0 text-danger" />
      <p className="m-0 min-w-0 flex-1">
        <strong>No se pudo guardar en el navegador</strong> ({error}). Lo que marques ahora solo está en esta pestaña: no la cierres ni la recargues sin exportar un respaldo
        (también en <Link href="/datos" className="underline">Datos</Link>).
      </p>
      <button
        type="button"
        className="btn inline-flex items-center gap-1.5"
        onClick={() => downloadText(`sportsan_respaldo_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 1), "application/json")}
      >
        <DownloadSimple size={15} />
        Exportar respaldo
      </button>
      <button type="button" className="btn" onClick={retrySave}>
        Reintentar
      </button>
    </div>
  );
}
