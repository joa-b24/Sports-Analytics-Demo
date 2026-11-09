import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_KEY, createWriter, loadInitial, readText, writeText } from "./storeIdb.ts";

// Minimal fake of the IndexedDB parts the module uses. `data` is shared so a "second start" sees the first one's writes.
function fakeFactory(data = new Map(), opts = {}) {
  const defer = (fn) => setTimeout(fn, 0);
  const request = (run) => {
    const req = {};
    defer(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (e) {
        req.error = e;
        req.onerror?.();
      }
    });
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const tx = {
        objectStore: () => ({
          get: (k) => request(() => data.get(k)),
          put: (v, k) => {
            if (opts.failWrites) {
              defer(() => {
                tx.error = new Error("QuotaExceededError");
                tx.onabort?.();
              });
              return {};
            }
            data.set(k, v);
            defer(() => tx.oncomplete?.());
            return {};
          },
        }),
      };
      return tx;
    },
  };
  return {
    data,
    open() {
      const req = {};
      defer(() => {
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const big = JSON.stringify({ matches: [{ match_id: "a" }], events: Array.from({ length: 50 }, (_, i) => ({ i })) });

test("migrates localStorage into an empty IndexedDB, once", async () => {
  const f = fakeFactory();
  let reads = 0;
  const r = await loadInitial(f, () => (reads++, big));
  assert.equal(r.migrated, true);
  assert.equal(r.text, big);
  assert.equal(f.data.get(STATE_KEY), big);
  // second start: IndexedDB wins and localStorage is not read again
  const r2 = await loadInitial(f, () => (reads++, "OTRO"));
  assert.equal(r2.migrated, false);
  assert.equal(r2.text, big);
  assert.equal(reads, 1);
});

test("when both differ, IndexedDB is used", async () => {
  const f = fakeFactory(new Map([[STATE_KEY, '{"matches":[],"events":[]}']]));
  const r = await loadInitial(f, () => big);
  assert.equal(r.text, '{"matches":[],"events":[]}');
});

test("nothing anywhere gives null; a throwing localStorage is tolerated", async () => {
  const r = await loadInitial(fakeFactory(), () => {
    throw new Error("blocked");
  });
  assert.equal(r.text, null);
});

test("no IndexedDB rejects", async () => {
  await assert.rejects(loadInitial(undefined, () => big));
});

test("write failure rejects and the writer reports it, then recovers", async () => {
  const bad = fakeFactory(new Map(), { failWrites: true });
  const db = (await loadInitial(bad, () => null)).db;
  await assert.rejects(writeText(db, "x"), /Quota/);

  const good = fakeFactory();
  const gdb = (await loadInitial(good, () => null)).db;
  const results = [];
  const write = createWriter(() => gdb, (e) => results.push(e));
  write("1");
  write("2");
  write("3"); // 2 is replaced by 3 while 1 is in flight
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await readText(gdb), "3");
  assert.deepEqual(results, [null, null]);

  const errs = [];
  const w2 = createWriter(() => null, (e) => errs.push(e?.message));
  w2("x");
  assert.equal(errs.length, 1);
});
