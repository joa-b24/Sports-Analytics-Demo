"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { AUTOSAVE_MS, AUTOSAVE_PREF, resultText, saveAll, type Ask, type Choice, type Progress } from "@/lib/saveMatch";
import { useStore, usePref } from "@/lib/store";
import type { Match } from "@/lib/types";

const IDLE_MS = 30_000;

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

// In the match header: no visible status any more (each part shows its own state); Ctrl+S saves what changed, with a bar while it runs and a message at the end.
export function SaveStatus({ match }: { match: Match }) {
  const state = useStore();
  const folder = match.folder;
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);
  const [autoWarn, setAutoWarn] = useState<{ text: string; bad: boolean } | null>(null);
  const [ask, dialog, resetAsk] = useAsk();
  const busy = useRef(false);

  const run = useCallback(
    async (auto = false) => {
      if (busy.current || !folder) return;
      busy.current = true;
      resetAsk();
      setResult(null);
      if (!auto) setAutoWarn(null);
      setProgress({ done: 0, total: 1, label: "" });
      try {
        // An autosave never asks: a file newer on disk is skipped and stays marked as not saved.
        const r = await saveAll(state, match, auto ? async () => "skip" : ask, setProgress);
        // A manual save always says how it went. An autosave stays quiet unless something failed, and then it does not
        // interrupt: a small warning in the bar opens the detail.
        const out = { text: resultText(r), bad: r.errors.length > 0 };
        if (!auto) setResult(out);
        else if (r.errors.length) setAutoWarn(out);
        else setAutoWarn(null);
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

  // Autosave: every AUTOSAVE_MS, and only once nothing has changed for IDLE_MS (saving a part rebuilds its files, which
  // takes a moment: never while she is marking). It saves what changed; a file newer on disk is skipped, not asked.
  // Off with the preference `autosave` = "off".
  const autosave = usePref(AUTOSAVE_PREF, "on") !== "off";
  const lastChange = useRef(0);
  const lastTry = useRef(0);
  useEffect(() => {
    lastTry.current = Date.now();
  }, []);
  useEffect(() => {
    lastChange.current = Date.now();
  }, [state]);
  useEffect(() => {
    if (!autosave || !folder) return;
    const t = setInterval(() => {
      const now = Date.now();
      if (document.visibilityState === "hidden" || now - lastChange.current < IDLE_MS || now - lastTry.current < AUTOSAVE_MS) return;
      lastTry.current = now;
      void runRef.current(true);
    }, 30_000);
    return () => clearInterval(t);
  }, [autosave, folder]);

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

  if (!folder) return null;
  return (
    <div className="flex items-center gap-2">
      {progress && (
        <span className="h-1 w-16 overflow-hidden rounded-full bg-line" aria-hidden>
          <span className="block h-full bg-own transition-[width]" style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
        </span>
      )}
      {dialog}
      {autoWarn && !result && (
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-warn-900 px-2 text-xs text-warn"
          title="El guardado automático tuvo errores: clic para verlos"
          onClick={() => setResult(autoWarn)}
        >
          <WarningCircle size={15} weight="fill" aria-hidden />
          Guardado automático con errores
        </button>
      )}
      {result && (
        <Modal title={result.bad ? "Guardado con errores" : "Guardado"} onClose={() => setResult(null)}>
          <p className={`text-sm ${result.bad ? "text-danger" : "text-ink"}`}>{result.text}</p>
        </Modal>
      )}
    </div>
  );
}
