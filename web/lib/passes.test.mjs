import assert from "node:assert/strict";
import { test } from "node:test";
import { lost, networkFromPasses, passStats, touch } from "./passes.ts";

const base = { match_id: "m", video_id: "v1", period: 1, team: "own" };

test("typing the players in order makes the passes; lost closes the chain", () => {
  let h = null;
  const out = [];
  for (const [who, t] of [["Ana", 10], ["Bea", 12], ["Bea", 13], ["Cris", 15]]) {
    const r = touch(h, who, t, base, `p${t}`);
    if (r.pass) out.push(r.pass);
    h = r.holder;
  }
  out.push(lost(h, base, "pl"));
  assert.deepEqual(out.map((p) => [p.from_id, p.to_id, p.outcome, p.t_video]), [
    ["Ana", "Bea", "complete", 10],
    ["Bea", "Cris", "complete", 13],
    ["Cris", null, "incomplete", 15],
  ]);
});

const P = (from, to, team = "own") => ({ ...base, team, pass_id: `${from}${to}`, t_video: 0, from_id: from, to_id: to, outcome: to ? "complete" : "incomplete" });

test("per player: attempted, completed, received and partners", () => {
  const s = passStats([P("Ana", "Bea"), P("Ana", "Bea"), P("Ana", null), P("Bea", "Ana")]);
  const ana = s.find((p) => p.player_id === "Ana");
  assert.deepEqual([ana.attempted, ana.completed, ana.received], [3, 2, 1]);
  assert.deepEqual(ana.partners, [{ player_id: "Bea", count: 2 }]);
});

test("network: both directions in one edge, placed at the average of her events, the rest on a ring", () => {
  const ev = (player_id, x, y) => ({ event_id: player_id + x, match_id: "m", t_video: 0, period: 1, type: "loss", team: "own", player_id, x, y, outcome: null, note: null });
  const net = networkFromPasses([P("Ana", "Bea"), P("Bea", "Ana"), P("Bea", "Cris"), P("#9", "#11", "opp")], [ev("Ana", 20, 30), ev("Ana", 30, 40)], "own");
  assert.deepEqual(net.edges.sort((a, b) => b.count - a.count), [{ a: "Ana", b: "Bea", count: 2 }, { a: "Bea", b: "Cris", count: 1 }]);
  const ana = net.nodes.find((n) => n.key === "Ana");
  assert.deepEqual([ana.x, ana.y, ana.placed], [25, 35, "events"]);
  assert.equal(net.nodes.find((n) => n.key === "Cris").placed, "ring");
  assert.equal(net.passes, 3);
});
