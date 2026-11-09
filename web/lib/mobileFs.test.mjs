import assert from "node:assert/strict";
import { test } from "node:test";
import { createFs, listDir, memoryStore, safePath } from "./mobileFs.ts";

test("listDir shows files and folders like the server: folders once, with the sum of their sizes", async () => {
  const fs = createFs(memoryStore());
  await fs.write("matches/m1/match.yaml", "match_id: m1\n");
  await fs.write("matches/m1/tracking/tracks_v1_0_900.json", "x".repeat(100));
  await fs.write("matches/m1/tracking/labels_v1_0_900.json", "y".repeat(50));
  const root = await fs.list("matches");
  assert.deepEqual(root?.map((e) => [e.name, e.dir]), [["m1", true]]);
  const m1 = await fs.list("matches/m1");
  assert.deepEqual(m1?.map((e) => [e.name, e.dir]), [["tracking", true], ["match.yaml", false]], "folders first");
  assert.equal(m1?.[0].size, 150);
  const tr = await fs.list("matches/m1/tracking/");
  assert.deepEqual(tr?.map((e) => e.name), ["labels_v1_0_900.json", "tracks_v1_0_900.json"]);
});

test("a folder with nothing under it does not exist, but matches always does", async () => {
  const fs = createFs(memoryStore());
  assert.deepEqual(await fs.list("matches"), []);
  assert.equal(await fs.list("matches/nada"), null);
  assert.equal(listDir([], "matches/nada/video"), null);
});

test("write, read, replace and remove; paths that climb out are refused", async () => {
  const fs = createFs(memoryStore());
  const t = await fs.write("matches/m1/segments.csv", "a,b\n");
  assert.equal(typeof t, "number");
  assert.equal(await fs.readText("matches/m1/segments.csv"), "a,b\n");
  await fs.write("matches/m1/segments.csv", "c\n");
  assert.equal(await fs.readText("matches/m1/segments.csv"), "c\n");
  assert.equal(await fs.exists("matches/m1/segments.csv"), true);
  await fs.remove("matches/m1/segments.csv");
  assert.equal(await fs.read("matches/m1/segments.csv"), null);
  assert.equal(await fs.write("matches/../x", "no"), null);
  assert.equal(safePath("matches/m1/a.json"), true);
  assert.equal(safePath("matches//a"), false);
  assert.equal(safePath(""), false);
});
