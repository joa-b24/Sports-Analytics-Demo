import assert from "node:assert/strict";
import { test } from "node:test";
import { readYamlMeta, writeYamlMeta, yamlDiff } from "./matchYaml.ts";

const YAML = `match_id: partido_x
kind: own                       # own = partido nuestro
date: "REEMPLAZAR"              # falta la fecha
own_team_name: "Tec CCM"
other_team_name: "UP"         # jornada 2
analysis_stride: 3

venue:
  name: "REEMPLAZAR"

# Un partido puede venir en varios videos.
videos:
  - video_id: v1
    fps: 30
`;

test("lee los datos del partido de match.yaml", () => {
  assert.deepEqual(readYamlMeta(YAML), { kind: "own", date: "REEMPLAZAR", own_team_name: "Tec CCM", other_team_name: "UP", venue: { name: "REEMPLAZAR" } });
});

test("escribe solo esas líneas y conserva los comentarios y el resto", () => {
  const out = writeYamlMeta(YAML, { date: "2026-10-11", other_team_name: "UP", venue: { name: "Estadio ITESM CCM", pitch_length_m: 101.7, pitch_width_m: 67.6 } });
  assert.match(out, /^date: "2026-10-11"              # falta la fecha$/m);
  assert.match(out, /^other_team_name: "UP"         # jornada 2$/m);
  assert.match(out, /^venue:\n  name: "Estadio ITESM CCM"\n  pitch_length_m: 101.7\n  pitch_width_m: 67.6\n\n# Un partido/m);
  assert.ok(out.endsWith("videos:\n  - video_id: v1\n    fps: 30\n"));
  assert.deepEqual(yamlDiff(out, { date: "2026-10-11", venue: { name: "Estadio ITESM CCM", pitch_length_m: 101.7 } }), []);
});

test("lo que falta se añade; lo vacío no borra", () => {
  const out = writeYamlMeta("match_id: m\nvideos: []\n", { date: "2026-01-02", kind: "rival", venue: { name: "Sede" }, own_team_name: "" });
  assert.equal(out, 'match_id: m\ndate: "2026-01-02"\nkind: rival\nvenue:\n  name: "Sede"\n\nvideos: []\n');
  assert.deepEqual(yamlDiff(out, { date: "", venue: { name: "Sede" } }), []);
});

test("un # dentro de comillas es texto, no comentario", () => {
  const out = writeYamlMeta('match_id: m\nown_team_name: "Club #1"   # nota\n', { own_team_name: "Club #2" });
  assert.equal(out, 'match_id: m\nown_team_name: "Club #2"   # nota\n');
});

test("la máscara de un video: se lee, se escribe en su bloque y se quita", async () => {
  const { readVideoMask, writeVideoMask } = await import("./matchYaml.ts");
  const y = `match_id: m
videos:
  - video_id: v1
    fps: 30
  - video_id: v2
    fps: 30   # otro
jersey_colors: {}
`;
  const w = writeVideoMask(y, "v1", [[20, 25, 670.4, 78], [1138, 36, 1247, 130]]);
  assert.match(w, /  - video_id: v1\n    fps: 30\n    mask: \[\[20, 25, 670, 78\], \[1138, 36, 1247, 130\]\]\n  - video_id: v2/);
  assert.deepEqual(readVideoMask(w, "v1"), [[20, 25, 670, 78], [1138, 36, 1247, 130]]);
  assert.deepEqual(readVideoMask(w, "v2"), []);
  assert.equal(writeVideoMask(w, "v1", []), y);
  assert.equal(writeVideoMask(y, "v9", []), null);
});
