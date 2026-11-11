// The zip of a match to take to another copy of the app (the one on Vercel): what the folder of the match holds that the
// import of a zip accepts (match.yaml, segments.csv, tracking, edits, report), without the video, plus the events as the
// browser has them now. Built in the browser from the files the local app serves.
import { zipSync } from "fflate";
import { listLocal, localUrl } from "./local.ts";
import { eventsCsv } from "./saveAll.ts";
import { innerKind } from "./uploads.ts";
import type { MatchEvent } from "./types.ts";

export interface ZipProgress {
  done: number;
  total: number;
  name: string;
}

// Paths (inside the folder) of every file that goes in: the accepted kinds but the video and the events CSV on disk (the
// events come from the browser).
// `light`: only what is needed to read the match (no tracking but the aggregates): a few MB, for the phone.
export type ZipMode = "full" | "light";
export const isLightPath = (rel: string) => !rel.startsWith("tracking/") || /^tracking\/aggregates_/.test(rel);

export async function matchZipPaths(folder: string, mode: ZipMode = "full"): Promise<string[]> {
  const out: string[] = [];
  const walk = async (inner: string, depth: number) => {
    const list = await listLocal(`matches/${folder}${inner ? `/${inner}` : ""}`);
    for (const e of list ?? []) {
      const rel = inner ? `${inner}/${e.name}` : e.name;
      if (e.dir) {
        if (depth < 2 && ["tracking", "edits"].includes(rel.split("/")[0])) await walk(rel, depth + 1);
        continue;
      }
      const kind = innerKind(rel);
      if (!kind || kind === "video" || /^(events\/)?events_[\w.-]+\.csv$/.test(rel)) continue;
      if (mode === "light" && !isLightPath(rel)) continue;
      out.push(rel);
    }
  };
  await walk("", 0);
  return out;
}

// The zip as bytes. The files are read one by one (a tracking part is tens of MB); a file that cannot be read is listed
// in `failed` and the zip is still made with the rest.
export async function buildMatchZip(folder: string, events: MatchEvent[], onProgress: (p: ZipProgress) => void, mode: ZipMode = "full"): Promise<{ bytes: Uint8Array; files: number; failed: string[] }> {
  const paths = await matchZipPaths(folder, mode);
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const failed: string[] = [];
  let done = 0;
  for (const p of paths) {
    onProgress({ done, total: paths.length, name: p });
    try {
      const r = await fetch(localUrl(`matches/${folder}/${p}`), { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const data = new Uint8Array(await r.arrayBuffer());
      files[`${folder}/${p}`] = /\.(npz|parquet)$/.test(p) ? [data, { level: 0 }] : data;
    } catch {
      failed.push(p);
    }
    done++;
  }
  onProgress({ done, total: paths.length, name: "events" });
  files[`${folder}/events_${folder}.csv`] = new TextEncoder().encode(eventsCsv(events));
  return { bytes: zipSync(files, { level: 3 }), files: Object.keys(files).length, failed };
}
