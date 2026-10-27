"use client";

import { Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { IconButton, Modal } from "@/components/Modal";
import { DETECTED_TYPES, type DetectedType } from "@/lib/eventDetect";
import { TYPE_LABEL, addMissed, addWindow, removeMissed, removeWindow, type EventReviewFile } from "@/lib/eventReview";
import { fmtHms, parseHms } from "@/lib/segments";

type Update = (f: (r: EventReviewFile) => EventReviewFile) => void;

// An event the analyst saw in the video and the rule did not detect. Counts for the recall only inside the windows reviewed in full.
export function MissedDialog({ review, type, atT, onUpdate, onClose }: { review: EventReviewFile; type: DetectedType; atT: number | null; onUpdate: Update; onClose: () => void }) {
  const [kind, setKind] = useState<DetectedType>(type);
  const [time, setTime] = useState(atT !== null ? fmtHms(atT) : "");
  const [note, setNote] = useState("");
  const t = parseHms(time);
  return (
    <Modal title="Añadir evento no detectado" wide onClose={onClose}>
      <p className="mb-3 text-sm text-pretty text-muted">
        Un evento que viste en el video y la regla no marcó. Escribe el tiempo del video (h:mm:ss). Cuenta para el recall solo si cae dentro de una ventana revisada completa.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted">
          Tipo
          <select className="input mt-1 block" value={kind} onChange={(e) => setKind(e.target.value as DetectedType)}>
            {DETECTED_TYPES.map((k) => (
              <option key={k} value={k}>
                {TYPE_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Tiempo del video
          <input className="input tc mt-1 block w-28" value={time} placeholder="0:12:03.5" aria-label="Tiempo del video" onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="min-w-40 flex-1 text-xs text-muted">
          Nota
          <input className="input mt-1 block w-full" value={note} aria-label="Nota" onChange={(e) => setNote(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={t === null}
          onClick={() => {
            if (t === null) return;
            onUpdate((r) => addMissed(r, kind, t, note));
            setNote("");
          }}
        >
          Añadir
        </button>
      </div>
      <div className="mt-4 text-xs">
        {review.missed.length === 0 ? (
          <p className="text-faint">Aún no has añadido ninguno en este video.</p>
        ) : (
          review.missed.map((m) => (
            <div key={m.id} className="flex items-center gap-3 border-b border-line-soft py-1">
              <span className="tc w-24 text-ink">{fmtHms(m.t_video)}</span>
              <span className="w-44 text-muted">{TYPE_LABEL[m.type]}</span>
              <span className="min-w-0 flex-1 truncate text-faint">{m.note}</span>
              <IconButton label="Quitar" onClick={() => onUpdate((r) => removeMissed(r, m.id))}>
                <Trash size={14} />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

// A stretch of the video where the analyst has looked at everything: every event in it is either a detection she
// reviewed or an event she added. Only there is the recall told.
export function WindowsDialog({ review, atT, onUpdate, onClose }: { review: EventReviewFile; atT: number | null; onUpdate: Update; onClose: () => void }) {
  const [t0, setT0] = useState(atT !== null ? fmtHms(Math.max(0, atT - 60)) : "");
  const [t1, setT1] = useState(atT !== null ? fmtHms(atT + 60) : "");
  const a = parseHms(t0);
  const b = parseHms(t1);
  const ok = a !== null && b !== null && b > a;
  return (
    <Modal title="Ventanas revisadas completas" wide onClose={onClose}>
      <p className="mb-3 text-sm text-pretty text-muted">
        Marca un rango del video donde ya viste todo: cada evento de ese rango está revisado en la lista o añadido como no detectado. El recall de cada tipo se calcula solo ahí:
        encontradas / (encontradas + añadidas).
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted">
          Desde
          <input className="input tc mt-1 block w-28" value={t0} placeholder="0:10:00" aria-label="Desde" onChange={(e) => setT0(e.target.value)} />
        </label>
        <label className="text-xs text-muted">
          Hasta
          <input className="input tc mt-1 block w-28" value={t1} placeholder="0:12:00" aria-label="Hasta" onChange={(e) => setT1(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ok}
          onClick={() => {
            if (ok) onUpdate((r) => addWindow(r, a as number, b as number) ?? r);
          }}
        >
          Marcar ventana
        </button>
        {!ok && (t0 !== "" || t1 !== "") && <span className="text-xs text-warn">Escribe dos tiempos válidos y que «Hasta» sea mayor que «Desde».</span>}
      </div>
      <div className="mt-4 text-xs">
        {review.windows.length === 0 ? (
          <p className="text-faint">Sin ventanas: el recall no se calcula.</p>
        ) : (
          review.windows.map((w) => (
            <div key={w.id} className="flex items-center gap-3 border-b border-line-soft py-1">
              <span className="tc text-ink">
                {fmtHms(w.t0)} – {fmtHms(w.t1)}
              </span>
              <span className="tc text-muted">{Math.round(w.t1 - w.t0)} s</span>
              <span className="flex-1" />
              <IconButton label="Quitar" onClick={() => onUpdate((r) => removeWindow(r, w.id))}>
                <Trash size={14} />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
