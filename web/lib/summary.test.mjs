import assert from "node:assert/strict";
import { test } from "node:test";
import { firstSentence, matchSummary } from "./summary.ts";
import { suggestFolder } from "./local.ts";
import { EMPTY_REPORT } from "./types.ts";

// Synthetic data only.
let n = 0;
const ev = (t_video, type, team, extra = {}) => ({
  event_id: `e${n++}`, match_id: "m1", video_id: "v1", t_video, period: 1, type, team, player_id: null, x: 50, y: 30, outcome: null, detail: null, note: null, ...extra,
});
const match = (resumen = "") => ({ report: { ...EMPTY_REPORT, resumen } });

test("sin eventos: sin comparaciones y «sin etiquetar»", () => {
  const s = matchSummary(match(), []);
  assert.deepEqual(s.comparisons, []);
  assert.equal(s.status.state, "empty");
  assert.equal(s.lead, null);
});

test("compara solo lo que tiene datos, con el equipo analizado primero", () => {
  const s = matchSummary(match(), [
    ev(10, "shot", "own", { outcome: "on_target" }),
    ev(60, "shot", "own", { outcome: "off_target" }),
    ev(90, "shot", "opp", { outcome: "blocked" }),
    ev(120, "corner", "opp"),
  ]);
  assert.deepEqual(
    s.comparisons.map((c) => [c.label, c.own, c.opp]),
    [["Tiros", 2, 1], ["A puerta", 1, 0], ["Córners", 0, 1]],
  );
});

test("un gol con su tiro cuenta un tiro a puerta, no dos", () => {
  const s = matchSummary(match(), [ev(10, "shot", "own"), ev(12, "goal", "own")]);
  assert.deepEqual(s.comparisons.find((c) => c.label === "A puerta"), { label: "A puerta", own: 1, opp: 0 });
  assert.equal(s.comparisons.find((c) => c.label === "Tiros").own, 1);
});

test("la frase sale del resumen del informe: solo la primera oración", () => {
  assert.equal(matchSummary(match("  Presionamos alto y ganamos el medio.  Luego bajamos. "), []).lead, "Presionamos alto y ganamos el medio.");
  assert.equal(firstSentence(""), null);
  assert.equal(firstSentence("Sin punto final"), "Sin punto final");
  const long = firstSentence("palabra ".repeat(60));
  assert.ok(long.length <= 161 && long.endsWith("…"));
});

test("posesión: reparto del tiempo con dueño, primero y en porcentaje", () => {
  const s = matchSummary({ ...match(), possession: { own: 650, opp: 350, followed_s: 1200 } }, []);
  assert.deepEqual(s.comparisons[0], { label: "Posesión", own: 65, opp: 35, unit: "%" });
  assert.equal(matchSummary({ ...match(), possession: { own: 0, opp: 0, followed_s: 0 } }, []).comparisons.length, 0);
});

test("carpeta sugerida: fecha, local y visitante en minúsculas y sin acentos", () => {
  assert.equal(suggestFolder("2026-09-25", "Tec CCM", "Anáhuac"), "2026_09_25_tec_ccm_vs_anahuac");
  assert.equal(suggestFolder("", "Tec CCM", "UP"), "");
  assert.equal(suggestFolder("2026-09-25", "Tec CCM", " "), "");
});
