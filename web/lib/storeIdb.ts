// Persistence of the app state in IndexedDB (no practical size cap, unlike the ~5 M characters of localStorage).
// Pure of React and of the global scope: the IndexedDB factory is passed in, so the tests use a small fake.
// The state is kept as one JSON text under one key.

export const DB_NAME = "sportsan";
export const STORE_NAME = "kv";
export const STATE_KEY = "state";

type Factory = Pick<IDBFactory, "open">;

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB: operación fallida"));
  });
}

export function openDb(factory: Factory | undefined | null): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) return reject(new Error("Este navegador no ofrece IndexedDB"));
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, 1);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("No se pudo abrir IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB está bloqueado por otra pestaña"));
  });
}

export async function readText(db: IDBDatabase, key = STATE_KEY): Promise<string | undefined> {
  const v = await wrap(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key));
  return typeof v === "string" ? v : undefined;
}

// The write starts synchronously (so it can be launched from pagehide); the promise resolves when the transaction is
// committed, and rejects on any failure (quota, aborted).
export function writeText(db: IDBDatabase, text: string, key = STATE_KEY): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      // "strict": the browser waits for the data to be on the disk before it reports the write as done. The default
      // ("relaxed" in Chromium) may leave the last writes in the operating system's memory, and a power cut loses them.
      tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("No se pudo escribir en IndexedDB"));
      tx.onabort = () => reject(tx.error ?? new Error("Escritura cancelada (¿cuota llena?)"));
      tx.objectStore(STORE_NAME).put(text, key);
    } catch (e) {
      reject(e);
    }
  });
}

export type Initial = { db: IDBDatabase; text: string | null; migrated: boolean };

// First start: if IndexedDB has the state, that is the truth (localStorage is not even read). If it is empty and the
// old localStorage copy exists, it is copied over (and verified by reading it back); localStorage is never modified.
export async function loadInitial(factory: Factory | undefined | null, readLegacy: () => string | null): Promise<Initial> {
  const db = await openDb(factory);
  const stored = await readText(db);
  if (stored !== undefined) return { db, text: stored, migrated: false };
  let legacy: string | null = null;
  try {
    legacy = readLegacy();
  } catch {
    legacy = null;
  }
  if (!legacy) return { db, text: null, migrated: false };
  await writeText(db, legacy);
  const back = await readText(db);
  if (back !== legacy) throw new Error("La copia a IndexedDB no coincide con la original; se conserva localStorage");
  return { db, text: legacy, migrated: true };
}

// Writes one at a time and always the latest text: while one is in flight, newer requests only replace the pending one.
export function createWriter(getDb: () => IDBDatabase | null, onResult: (error: Error | null) => void) {
  let busy = false;
  let pending: string | null = null;
  const run = (text: string) => {
    const db = getDb();
    if (!db) return onResult(new Error("IndexedDB no está disponible"));
    busy = true;
    writeText(db, text).then(
      () => onResult(null),
      (e) => onResult(e instanceof Error ? e : new Error(String(e))),
    ).finally(() => {
      busy = false;
      if (pending !== null) {
        const next = pending;
        pending = null;
        run(next);
      }
    });
  };
  return (text: string) => {
    if (busy) pending = text;
    else run(text);
  };
}
