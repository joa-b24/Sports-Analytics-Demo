import assert from "node:assert/strict";
import { test } from "node:test";
import { resetPart } from "./reset.ts";
import { emptyEdits, setPerson, setRemoved } from "./tracks.ts";

const KEY = "m|v1|0_87";
const named = () => setPerson(setPerson(emptyEdits(KEY), 1, { player_id: "Ana" }), 2, { player_id: "Bea" });
const startReview = (key, e) => ({ key, active: "B", base: JSON.parse(JSON.stringify(e)), A: {}, B: {} });

test("resetPart restores the snapshot and forgets the part's stopwatch and comparison only", async () => {
    const base = named();
  const r = startReview(KEY, base);
  const live = { ...setRemoved(base, 2, true), anchorDoubts: ["salto:1:1"] };
  const other = emptyEdits("m|v1|100_200");
  const st = { trackEdits: [live, other], reviews: [r, { ...r, key: "m|v1|100_200" }] };
  const out = resetPart(st, KEY, "v1_0_87", "f", [{ part: "v1_0_87" }, { part: "v1_100_200" }]);
  assert.deepEqual(out.state.trackEdits.find((e) => e.key === KEY), base);
  assert.equal(out.state.trackEdits.find((e) => e.key === other.key), other);
  assert.deepEqual(out.state.reviews.map((x) => x.key), ["m|v1|100_200"]);
  assert.deepEqual(out.timing, [{ part: "v1_100_200" }]);
  assert.deepEqual(out.summary, { review: true, doubts: 1, timing: 1 });
  assert.ok(out.prefKeys.includes("anchors:skipped:f:v1_0_87"));
  // Without a comparison: edits kept, only the resolved doubts go.
  const out2 = resetPart({ trackEdits: [live] }, KEY, "v1_0_87", "f", []);
  assert.equal(out2.state.trackEdits[0].anchorDoubts, undefined);
  assert.deepEqual(out2.state.trackEdits[0].removed, [2]);
});
