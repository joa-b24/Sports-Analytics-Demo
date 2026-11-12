import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutCovered } from "./fixedCover.ts";

const f = (name, mtime) => ({ name, mtime });

test("las partes que quedan dentro de un archivo unido más nuevo no se cuentan dos veces", () => {
  const list = [f("tracks_fixed_v1_100_200.json", 1), f("tracks_fixed_v1_300_400.json", 1), f("tracks_fixed_v1_100_900.json", 5), f("tracks_fixed_v1_950_999.json", 1)];
  assert.deepEqual(withoutCovered(list).map((x) => x.name), ["tracks_fixed_v1_100_900.json", "tracks_fixed_v1_950_999.json"]);
});

test("una parte corregida después del archivo unido se conserva; los traslapes parciales no se tocan", () => {
  const newer = [f("tracks_fixed_v1_100_200.json", 9), f("tracks_fixed_v1_100_900.json", 5)];
  assert.equal(withoutCovered(newer).length, 2);
  const partial = [f("tracks_fixed_v1_100_500.json", 1), f("tracks_fixed_v1_400_900.json", 1)];
  assert.equal(withoutCovered(partial).length, 2);
});
