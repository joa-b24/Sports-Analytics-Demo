// The files of the match folders in the phone / tablet build: the same paths the laptop's server gives (matches/<folder>/
// tracking/tracks_v1_0_900.json, ...), kept in the browser's IndexedDB as Blobs. lib/local.ts uses it when the app is built
// for mobile (lib/mobile.ts); it never touches the network. Pure of React and of the global scope: the store is passed in, so
// the tests use one in memory.
import type { LocalEntry } from "./local.ts";

export interface FsMeta {
  path: string;
  size: number;
  mtime: number;
}
export interface FsStore {
  meta(): Promise<FsMeta[]>;
  get(path: string): Promise<{ blob: Blob; mtime: number } | undefined>;
  put(path: string, blob: Blob, mtime: number): Promise<void>;
  del(path: string): Promise<void>;
}

const clean = (rel: string) => rel.replace(/^\/+|\/+$/g, "");
export const safePath = (rel: string) => {
  const p = clean(rel);
  return p !== "" && !p.split("/").some((s) => s === "" || s === "." || s === "..");
};

// What a folder holds, like the server's listing: files with their size and time, folders once. null when the folder does not
// exist (nothing under it); "matches" always exists.
export function listDir(meta: FsMeta[], rel: string): LocalEntry[] | null {
  const dir = clean(rel);
  const prefix = dir === "" ? "" : `${dir}/`;
  const out = new Map<string, LocalEntry>();
  for (const m of meta) {
    if (!m.path.startsWith(prefix)) continue;
    const rest = m.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) out.set(rest, { name: rest, dir: false, size: m.size, mtime: m.mtime });
    else {
      const name = rest.slice(0, slash);
      const prev = out.get(name);
      out.set(name, { name, dir: true, size: (prev?.size ?? 0) + m.size, mtime: Math.max(prev?.mtime ?? 0, m.mtime) });
    }
  }
  if (out.size === 0 && dir !== "matches" && dir !== "") return null;
  return [...out.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export function createFs(store: FsStore) {
  return {
    list: async (rel: string) => listDir(await store.meta(), rel),
    exists: async (rel: string) => (await store.get(clean(rel))) !== undefined,
    read: async (rel: string): Promise<Blob | null> => (await store.get(clean(rel)))?.blob ?? null,
    readText: async (rel: string): Promise<string | null> => {
      const e = await store.get(clean(rel));
      return e ? e.blob.text() : null;
    },
    write: async (rel: string, data: Blob | string): Promise<number | null> => {
      if (!safePath(rel)) return null;
      const mtime = Date.now();
      await store.put(clean(rel), typeof data === "string" ? new Blob([data], { type: "text/plain" }) : data, mtime);
      return mtime;
    },
    remove: async (rel: string) => {
      await store.del(clean(rel));
    },
    mtimeOf: async (rel: string) => (await store.get(clean(rel)))?.mtime ?? null,
  };
}
export type Fs = ReturnType<typeof createFs>;

// ---- the stores
export function memoryStore(): FsStore {
  const files = new Map<string, { blob: Blob; mtime: number }>();
  return {
    meta: async () => [...files].map(([path, v]) => ({ path, size: v.blob.size, mtime: v.mtime })),
    get: async (p) => files.get(p),
    put: async (p, blob, mtime) => void files.set(p, { blob, mtime }),
    del: async (p) => void files.delete(p),
  };
}

const DB_NAME = "sportsan-files";
const STORE = "files";
const wrap = <T>(req: IDBRequest<T>) => new Promise<T>((ok, bad) => ((req.onsuccess = () => ok(req.result)), (req.onerror = () => bad(req.error ?? new Error("IndexedDB")))));

export function idbStore(factory: Pick<IDBFactory, "open">): FsStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () =>
    (opened ??= new Promise((ok, bad) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => bad(req.error ?? new Error("No se pudo abrir IndexedDB"));
    }));
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined).objectStore(STORE);
  return {
    meta: async () => {
      const store = await tx("readonly");
      return new Promise<FsMeta[]>((ok, bad) => {
        const out: FsMeta[] = [];
        const cur = store.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return ok(out);
          const v = c.value as { blob: Blob; mtime: number };
          out.push({ path: String(c.key), size: v.blob.size, mtime: v.mtime });
          c.continue();
        };
        cur.onerror = () => bad(cur.error ?? new Error("IndexedDB"));
      });
    },
    get: async (p) => (await wrap((await tx("readonly")).get(p))) as { blob: Blob; mtime: number } | undefined,
    put: async (p, blob, mtime) => void (await wrap((await tx("readwrite")).put({ blob, mtime }, p))),
    del: async (p) => void (await wrap((await tx("readwrite")).delete(p))),
  };
}

let shared: Fs | null = null;
// The browser's file store (created on first use).
export function browserFs(): Fs {
  return (shared ??= createFs(idbStore(window.indexedDB)));
}
