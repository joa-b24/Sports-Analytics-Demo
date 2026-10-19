"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { BackupCard } from "@/components/data/BackupCard";
import { FolderList, MatchFiles } from "@/components/data/MatchFiles";
import { ZipCard } from "@/components/data/ZipCard";
import { PageHeader, Section } from "@/components/Shell";
import { listLocal } from "@/lib/local";

// Datos: load the files of a match (events, video, tracking, or the whole folder as a .zip) and the full backup of this
// browser. Videos and tracking are written into matches/<folder>/ through app/api/local and app/api/unzip, so they only
// work with the app running on this computer; deployed, those uploads say so and stay off.
export default function Page() {
  // null while checking; false when the repository is not reachable.
  const [local, setLocal] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    void listLocal("matches").then((l) => {
      if (!live) return;
      setLocal(l !== null);
      setFolders((l ?? []).filter((f) => f.dir).map((f) => f.name));
    });
    return () => {
      live = false;
    };
  }, [tick]);

  return (
    <>
      <PageHeader title="Datos" />
      <FolderList folders={folders} />

      <Section title="Cargar datos de un partido" note={local ? "se guardan en matches/ de esta computadora" : undefined}>
        {local === false && (
          <p className="mb-4 flex items-start gap-2 rounded-xl border border-warn/50 bg-warn-900/60 px-3 py-2.5 text-xs text-pretty text-ink-2">
            <WarningCircle size={15} className="mt-px shrink-0 text-warn" />
            Subir video, tracking o un .zip solo funciona con la app abierta en la laptop del proyecto (npm run dev o la app de escritorio): aquí no hay carpeta matches/
            donde guardarlos. Los eventos CSV sí se pueden importar y exportar.
          </p>
        )}
        <div className="grid gap-5">
          <ZipCard local={local} folders={folders} onFolders={refresh} />
          <MatchFiles local={local} folders={folders} onFolders={refresh} />
        </div>
      </Section>

      <Section title="Respaldo" className="mt-10">
        <BackupCard />
      </Section>
    </>
  );
}
