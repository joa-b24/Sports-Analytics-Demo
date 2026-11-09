import assert from "node:assert/strict";
import { test } from "node:test";
import { endedLevel, shootoutScore, shootoutText } from "./shootout.ts";

test("tanda de penales: marcador, texto y solo se pregunta tras un empate", () => {
  const kicks = [
    { team: "own", player_id: null, result: "goal" },
    { team: "opp", player_id: null, result: "saved" },
    { team: "own", player_id: "Ana", result: "missed" },
    { team: "opp", player_id: null, result: "goal" },
    { team: "own", player_id: null, result: "goal" },
  ];
  assert.deepEqual(shootoutScore(kicks), { own: 2, opp: 1 });
  assert.equal(shootoutText(kicks), "2–1 pen.");
  assert.equal(shootoutScore([]), null);
  assert.equal(endedLevel([{ type: "goal", team: "own" }, { type: "goal", team: "opp" }]), true);
  assert.equal(endedLevel([{ type: "goal", team: "own" }]), false);
  assert.equal(endedLevel([{ type: "shot", team: "own" }]), true);
  assert.equal(endedLevel([]), false);
});
