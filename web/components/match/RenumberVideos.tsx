"use client";

import { ArrowsDownUp } from "@phosphor-icons/react";
import { useState } from "react";
import { MOBILE } from "@/lib/mobile";
import { mapText, renumberPlan, renumberState, type VideoMap } from "@/lib/renumber";
import { mutate, renumberPrefs } from "@/lib/store";
import type { Match } from "@/lib/types";
import { matchVideos } from "@/lib/videos";

// «Renumerar videos»: when the videos are not numbered in the order of the match (v1 is the second half and v2 the first), puts
// v1 on the first one. Everything of the match moves with its video: the files of the folder (video, tracking, anchors...) through
// app/api/renumber, and the events, plays, stretches, anchors, corrections and preferences kept in the browser.
export function RenumberVideos({ match, onDone }: { match: Match; onDone: (map: VideoMap) => void }) {
  const plan = renumberPlan(matchVideos(match));
  const [step, setStep] = useState<"idle" | "ask" | "busy">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  if (!plan || MOBILE) return null;
  const folder = match.folder;

  const run = async () => {
    setStep("busy");
    setMsg(null);
    try {
      if (folder) {
        const r = await fetch("/api/renumber", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder, map: plan }) }).catch(() => null);
        const d = r ? ((await r.json().catch(() => null)) as { ok?: boolean; text?: string } | null) : null;
        if (!r || !d?.ok) {
          setStep("ask");
          return setMsg(`No se cambió nada: ${d?.text ?? "la app no responde (¿corre en esta computadora?)"}`);
        }
      }
      // The files are done: now what the browser keeps.
      mutate((s) => renumberState(s, match.match_id, folder, plan));
      renumberPrefs([match.match_id, ...(folder ? [folder] : [])], plan);
      onDone(plan);
      setStep("idle");
      setMsg("Listo: los videos quedaron numerados en el orden del partido.");
    } catch (e) {
      setStep("ask");
      setMsg(`Falló: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="mb-3 rounded-lg bg-bg/60 p-3 text-xs text-pretty text-muted" role="group" aria-label="Renumerar videos">
      <p className="m-0 text-ink-2">
        Los videos no están numerados en el orden del partido. Se puede poner v1 en el primer tiempo ({mapText(plan).replaceAll(",", ", ").replaceAll("=", " → ")}).
      </p>
      {step === "idle" && (
        <button type="button" className="btn mt-2" onClick={() => setStep("ask")}>
          <ArrowsDownUp size={14} />
          Renumerar según el orden del partido
        </button>
      )}
      {step !== "idle" && (
        <div className="mt-2 space-y-2">
          <p className="m-0">
            Cada dato se queda con su video: se renombran los archivos de la carpeta (video, tracking, anclas, calibración, tramos) y cambian de número los eventos, jugadas, tramos, anclas y correcciones del navegador. Si algo sale mal se deshace repitiendo el mismo cambio. <strong className="text-ink">Haz antes Datos › Exportar respaldo</strong> y cierra el video si lo tienes abierto en otro programa.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={step === "busy"} onClick={() => void run()}>
              {step === "busy" ? "Renumerando…" : "Sí, renumerar"}
            </button>
            <button type="button" className="btn" disabled={step === "busy"} onClick={() => setStep("idle")}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p className="m-0 mt-2 text-ink-2" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}
