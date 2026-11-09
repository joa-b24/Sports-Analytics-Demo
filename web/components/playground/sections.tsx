"use client";

import type { ReactNode } from "react";
import { BallSection } from "./BallSection";
import type { PlaygroundCtx } from "./context";
import { EventsTab } from "./EventsTab";
import { PassesTab } from "./PassesTab";
import { PossessionTab } from "./PossessionTab";

// The sections of the Playground, in order. To add one (e.g. a new detector), add an entry: the shell draws the selector
// and the board around whatever `render` returns. `key` makes the section start over when the folder changes.
export interface PlaygroundSection {
  id: string;
  label: string;
  render: (ctx: PlaygroundCtx, nav: { openBallStep: () => void }) => ReactNode;
}

export const PLAYGROUND_SECTIONS: PlaygroundSection[] = [
  { id: "ball", label: "Balón", render: (c, nav) => <BallSection key={c.folder} match={c.match} folder={c.folder} onOpenBall={nav.openBallStep} /> },
  { id: "possession", label: "Posesión", render: (c) => <PossessionTab ctx={c} /> },
  { id: "passes", label: "Pases", render: (c) => <PassesTab ctx={c} /> },
  { id: "events", label: "Eventos", render: (c) => <EventsTab key={c.folder} match={c.match} folder={c.folder} /> },
];
