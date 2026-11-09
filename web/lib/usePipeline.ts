"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineArgs, PipelineCommand, PipelineView } from "./runTask";

// One of the general commands of sportsan.tracking.pipeline seen from the panel. The truth is the state file that Python
// writes (read through /api/run/pipeline, which also checks the pid), so a reload of the page or a restart of the app's
// server simply finds the run again. Polls every few seconds while something runs; a failed request keeps the last view.
export interface PipelineHook {
  // null until the first answer; "off" when the app does not run on this computer.
  view: PipelineView | null;
  log: string[];
  available: boolean | null;
  offline: boolean;
  error: string | null;
  busy: boolean;
  plan: (extra?: Partial<PipelineArgs>) => Promise<{ code: number | null; text: string } | null>;
  start: (extra?: Partial<PipelineArgs>) => Promise<boolean>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 3000;

export function usePipeline(command: PipelineCommand, match: string | undefined, base: Partial<PipelineArgs> = {}): PipelineHook {
  const [view, setView] = useState<PipelineView | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const baseRef = useRef(base);
  useEffect(() => {
    baseRef.current = base;
  });

  const refresh = useCallback(async () => {
    if (!match) return;
    try {
      const r = await fetch(`/api/run/pipeline?match=${encodeURIComponent(match)}&command=${command}`, { cache: "no-store" });
      if (r.status === 403 || r.status === 404) {
        setAvailable(false);
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { view: PipelineView; log: string[] };
      setAvailable(true);
      setOffline(false);
      setView(d.view);
      setLog(d.log);
    } catch {
      // The server restarting looks like this; the next poll finds the run again.
      setOffline(true);
    }
  }, [match, command]);

  const running = view?.state === "running";
  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const id = running || offline ? window.setInterval(() => void refresh(), POLL_MS) : undefined;
    return () => {
      window.clearTimeout(first);
      if (id) window.clearInterval(id);
    };
  }, [refresh, running, offline]);

  const post = async (extra: Partial<PipelineArgs>) => {
    const r = await fetch("/api/run/pipeline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, match, ...baseRef.current, ...extra }) });
    const d = (await r.json().catch(() => ({}))) as { error?: string; text?: string; code?: number | null };
    return { ok: r.ok, d };
  };
  const plan: PipelineHook["plan"] = async (extra = {}) => {
    if (!match) return null;
    setBusy(true);
    setError(null);
    try {
      const { ok, d } = await post({ ...extra, plan: true });
      if (!ok) {
        setError(d.error ?? "No se pudo pedir el plan.");
        return null;
      }
      return { code: d.code ?? null, text: d.text ?? "" };
    } catch {
      setError("No se pudo hablar con la app (¿está corriendo en esta computadora?).");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const start: PipelineHook["start"] = async (extra = {}) => {
    if (!match) return false;
    setBusy(true);
    setError(null);
    try {
      const { ok, d } = await post(extra);
      if (!ok) {
        setError(d.error ?? "No se pudo lanzar.");
        return false;
      }
      await refresh();
      return true;
    } catch {
      setError("No se pudo hablar con la app (¿está corriendo en esta computadora?).");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!match) return;
    setBusy(true);
    try {
      await fetch(`/api/run/pipeline?match=${encodeURIComponent(match)}&command=${command}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return { view, log, available, offline, error, busy, plan, start, stop, refresh };
}
