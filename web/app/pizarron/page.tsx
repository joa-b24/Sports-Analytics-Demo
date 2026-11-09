"use client";

import { Suspense } from "react";
import { BoardsWorkspace } from "@/components/board/BoardsWorkspace";

export default function Page() {
  return (
    <Suspense>
      <BoardsWorkspace />
    </Suspense>
  );
}
