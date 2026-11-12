"use client";

import type { TrackingView } from "@/lib/trackingView";

// Under a time filter, the figures of the tracking follow it when the positions are there. With only the saved summary (the
// lightweight copy of the match) they cannot: they are those of the whole match, and this says so.
export function WindowNote({ view }: { view: TrackingView }) {
  if (!view.windowIgnored) return null;
  return (
    <p className="mb-3 rounded-md bg-warn-900 px-3 py-1.5 text-xs text-warn">
      El filtro de tiempo no aplica a las cifras del tracking en esta copia del partido (solo trae el resumen guardado): se muestran las del partido completo.
    </p>
  );
}
