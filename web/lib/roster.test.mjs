import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoster, repeatedNumbers, sortRoster } from "./roster.ts";

test("a pasted list becomes the squad; players without a number get 99, 98...", () => {
  const list = parseRoster("#1 Zoe S.\n#31 Sama\n14 Zoe\n\nIvonne\nIta\nLelo #11\n");
  assert.deepEqual(list, [
    { player_id: "Zoe S.", number: 1 },
    { player_id: "Sama", number: 31 },
    { player_id: "Zoe", number: 14 },
    { player_id: "Ivonne", number: 99 },
    { player_id: "Ita", number: 98 },
    { player_id: "Lelo", number: 11 },
  ]);
  assert.deepEqual(sortRoster(list).map((p) => p.number), [1, 11, 14, 31, 98, 99]);
});

test("pasting again updates numbers and skips taken ones", () => {
  const first = parseRoster("Ivonne\nIta");
  const again = parseRoster("#5 ivonne\nKari", first);
  assert.deepEqual(again, [
    { player_id: "Ivonne", number: 5 },
    { player_id: "Ita", number: 98 },
    { player_id: "Kari", number: 99 },
  ]);
  assert.deepEqual(repeatedNumbers([...again, { player_id: "X", number: 98 }]), [98]);
});
