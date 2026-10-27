"use client";

import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { matchItems, statusText } from "@/lib/saveAll";
import { AUTOSAVE_MS, AUTOSAVE_PREF, attackOf, resultText, saveAll, useSaveLog, type Ask, type Choice, type Progress } from "@/lib/saveMatch";
import { getPref, setPref, usePref, useStore } from "@/lib/store";
import type { Match } from "@/lib/types";

// A file of the folder newer than the last save: asked one by one (or the same answer for the rest of this save).
export function useAsk(): [Ask, React.ReactNode, () => void] {
  const [q, setQ] = useState<{ path: string; why: string; done: (c: Choice) => void } | null>(null);
  const [all, setAll] = useState(false);
  const sticky = useRef<Choice | null>(null);
  const ask: Ask = useCallback(
    (path, why) =>
      sticky.current
        ? Promise.resolve(sticky.current)
        : new Promise<Choice>((done) => {
            setAll(false);
            setQ({ path, why, done });
          }),
    [],
  );
  const reset = useCallback(() => {
    sticky.current = null;
  }, []);
  const answer = (c: Choice) => {
    if (!q) return;
    if (all && c !== "cancel") sticky.current = c;
    q.done(c);
    setQ(null);
  };
  const dialog = q ? (
    <Modal title="Archivo más nuevo en la carpeta" onClose={() => answer("cancel")}>
      <p className="tc mb-2 rounded bg-surface px-2 py-1 text-xs break-all text-ink">{q.path}</p>
      <p className="mb-4 text-sm text-muted">{q.why}</p>
      <label className="mb-4 flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" className="accent-accent" checked={all} onChange={(e) => setAll(e.target.checked)} />
        Lo mismo con los demás archivos de este guardado
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => answer("cancel")}>
          Cancelar
        </button>
        <button type="button" className="btn" onClick={() => answer("skip")}>
          Saltar este
        </button>
        <button type="button" className="btn btn-primary" onClick={() => answer("overwrite")}>
          Guardar de todos modos
        </button>
      </div>
    </Modal>
  ) : null;
  return [ask, dialog, reset];
}

// In the match header: whether everything is on disk (no button: each part shows its own state), Ctrl+S saves what changed and the optional autosave.
export function SaveStatus({ match }: { match: Match }) {
  const state = useStore();
  const folder = match.folder;
  const log = useSaveLog(folder);
  const items = useMemo(() => (folder ? matchItems(state, match, attackOf(folder)) : []), [state, match, folder]);
  const status = statusText(items, log);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);
  const [ask, dialog, resetAsk] = useAsk();
  const autosave = usePref(AUTOSAVE_PREF, "") === "1";
  const busy = useRef(false);

  const run = useCallback(
    async (auto = false) => {
      if (busy.current || !folder) return;
      busy.current = true;
      resetAsk();
      setResult(null);
      setProgress({ done: 0, total: 1, label: "" });
      try {
        // An autosave never asks: a file newer on disk is skipped and stays marked as not saved.
        const r = await saveAll(state, match, auto ? async () => "skip" : ask, setProgress);
        if (!auto || r.errors.length) setResult({ text: resultText(r), bad: r.errors.length > 0 });
      } finally {
        busy.current = false;
        setProgress(null);
      }
    },
    [folder, state, match, ask, resetAsk],
  );
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // Ctrl+S: before any other key handler (the table's «s» accepts a suggestion), and instead of the browser's save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void runRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const dirtyNow = status.dirty > 0;
  useEffect(() => {
    if (!autosave || !folder) return;
    const id = window.setInterval(() => {
      if (getPref(AUTOSAVE_PREF, "") === "1") void runRef.current(true);
    }, AUTOSAVE_MS);
    return () => window.clearInterval(id);
  }, [autosave, folder]);

  if (!folder) return null;
  const title = [status.text, ...status.detail, "", "Ctrl+S guarda todas las partes con cambios, el balón, los eventos y un respaldo del partido."].join("\n");
  return (
    <div className="flex items-center gap-2">
      <span title={title} className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${dirtyNow ? "text-warn" : "text-faint"}`} aria-live="polite" data-save-status>
        {dirtyNow ? <WarningCircle size={14} aria-hidden /> : <CheckCircle size={14} className="text-ok" aria-hidden />}
        {progress ? `Guardando${progress.label ? ` · ${progress.label}` : ""} (${progress.done}/${progress.total})` : status.text}
      </span>
      {progress && (
        <span className="h-1 w-16 overflow-hidden rounded-full bg-line" aria-hidden>
          <span className="block h-full bg-own transition-[width]" style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
        </span>
      )}
      <label className="flex items-center gap-1 text-[11px] whitespace-nowrap text-faint" title="Cada 5 minutos, si hay cambios (sin preguntar: un archivo más nuevo en la carpeta se salta)">
        <input type="checkbox" className="accent-accent" checked={autosave} onChange={(e) => setPref(AUTOSAVE_PREF, e.target.checked ? "1" : "")} />
        Auto
      </label>
      {dialog}
      {result && (
        <Modal title={result.bad ? "Guardado con errores" : "Guardado"} onClose={() => setResult(null)}>
          <p className={`text-sm ${result.bad ? "text-danger" : "text-ink"}`}>{result.text}</p>
        </Modal>
      )}
    </div>
  );
}
