"use client";

import { CircleNotch } from "@phosphor-icons/react";
import { SkBars } from "@/components/Locked";

// What a panel shows while the positions of the tracking are being read from the folder of the match, instead of «no hay
// datos»: a spinner, a sentence and the grey bars of the panel shimmering. When the reading ends, the panel shows its data
// or its real reason for having none.
export function TrackingLoading({ what = "el tracking" }: { what?: string }) {
  return (
    <div className="space-y-4 py-1" role="status" aria-live="polite">
      <div className="flex items-center gap-2.5 text-sm text-muted">
        <CircleNotch size={18} className="animate-spin text-own" aria-hidden />
        Leyendo {what} del partido…
      </div>
      <SkBars rows={4} />
    </div>
  );
}
