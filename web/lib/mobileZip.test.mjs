import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { createFs, memoryStore } from "./mobileFs.ts";
import { applyZipHere, inspectZipHere } from "./mobileZip.ts";

const make = (files) => new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))]);

test("a zip of a match folder is listed, then written under matches/<folder>/ without its top folder", async () => {
  const fs = createFs(memoryStore());
  const zip = make({
    "2026_10_10_a_vs_b/match.yaml": "match_id: 2026_10_10_a_vs_b\nown_team_name: A\n",
    "2026_10_10_a_vs_b/segments.csv": "segment_id,start\n",
    "2026_10_10_a_vs_b/tracking/tracks_fixed_v1_0_900.json": "{}",
    "2026_10_10_a_vs_b/notas.txt": "no",
    "__MACOSX/x": "junk",
  });
  const r = await inspectZipHere(fs, zip);
  assert.equal(r.ok, true);
  const j = r.json;
  assert.equal(j.top, "2026_10_10_a_vs_b/");
  assert.match(j.yaml, /own_team_name: A/);
  assert.deepEqual(j.entries.filter((e) => e.inner).map((e) => e.inner).sort(), ["match.yaml", "segments.csv", "tracking/tracks_fixed_v1_0_900.json"]);
  const a = await applyZipHere(fs, j.token, "2026_10_10_a_vs_b", false);
  assert.equal(a.ok, true);
  assert.equal(a.json.written.length, 3);
  assert.equal(a.json.skipped.length, 1, "notas.txt is not a file of a match folder");
  assert.equal(await fs.readText("matches/2026_10_10_a_vs_b/tracking/tracks_fixed_v1_0_900.json"), "{}");
  assert.equal(await fs.readText("matches/2026_10_10_a_vs_b/match.yaml"), "match_id: 2026_10_10_a_vs_b\nown_team_name: A\n");
});

test("existing files are only replaced when asked, and a used token is gone", async () => {
  const fs = createFs(memoryStore());
  await fs.write("matches/f/segments.csv", "old");
  const zip = make({ "segments.csv": "new", "match.yaml": "match_id: f\n" });
  const first = (await inspectZipHere(fs, zip)).json.token;
  const clash = await applyZipHere(fs, first, "f", false);
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.json.conflicts, ["segments.csv"]);
  assert.equal(await fs.readText("matches/f/segments.csv"), "old", "nothing was written");
  const ok = await applyZipHere(fs, first, "f", true);
  assert.equal(ok.ok, true);
  assert.equal(await fs.readText("matches/f/segments.csv"), "new");
  assert.equal((await applyZipHere(fs, first, "f", true)).status, 410);
});
