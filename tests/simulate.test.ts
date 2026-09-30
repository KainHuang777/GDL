import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GameModel } from "../src/schema/types.js";
import { runSimulation } from "../src/core/runner.js";
import { simulateRun } from "../src/core/simulate.js";
import { resolvePolicy } from "../src/core/policy.js";
import { createRng } from "../src/core/rng.js";
import { analyzeReachability } from "../src/core/reachability.js";

const minimal = JSON.parse(readFileSync(new URL("../examples/minimal-idle-game/model.json", import.meta.url), "utf8")) as GameModel;
const limits = { maxMinutes: 24 * 60, maxActions: 100_000 };

function model(partial: Partial<GameModel>): GameModel {
  return { schemaVersion: "0.1", project: { id: "t" }, resources: [], actions: [], progression: [], ...partial };
}

test("rng is deterministic per seed and differs across seeds", () => {
  const seq = (s: number) => Array.from({ length: 5 }, ((r) => () => r.next())(createRng(s)));
  assert.deepEqual(seq(42), seq(42));
  assert.notDeepEqual(seq(42), seq(43));
  for (const v of seq(1)) assert.ok(v >= 0 && v < 1);
});

test("monte carlo is reproducible: same model + params + seed => identical result", () => {
  const opts = { mode: "monte-carlo" as const, runs: 200, seed: 42, limits };
  assert.deepEqual(runSimulation(minimal, opts), runSimulation(minimal, opts));
  const other = runSimulation(minimal, { ...opts, seed: 43 });
  assert.notDeepEqual(runSimulation(minimal, opts).minutes, other.minutes);
});

test("expected mode: exact arithmetic on a hand-checkable model", () => {
  const m = model({
    resources: [{ id: "gold" }],
    actions: [{ id: "work", durationMinutes: 10, outcomes: [{ type: "resource", resource: "gold", amount: { min: 0, max: 20 }, probability: 0.5 }] }],
    progression: [
      { id: "n0", order: 0 },
      { id: "n1", order: 1, requirements: [{ type: "resource", resource: "gold", gte: 50 }] },
    ],
  });
  // Expected yield per action = 10 * 0.5 = 5 gold => 10 actions => 100 minutes.
  const r = runSimulation(m, { mode: "expected", limits });
  assert.equal(r.nodes[1]!.minute!.median, 100);
  assert.equal(r.completionRate, 1);
});

test("time is not double counted and regen + waiting works", () => {
  const m = model({
    resources: [{ id: "stamina", initial: 0, max: 10, regenPerMinute: 1 }, { id: "xp" }],
    actions: [{ id: "fight", durationMinutes: 5, costs: [{ resource: "stamina", amount: 10 }], outcomes: [{ type: "resource", resource: "xp", amount: 1 }] }],
    progression: [
      { id: "s", order: 0 },
      { id: "e", order: 1, requirements: [{ type: "resource", resource: "xp", gte: 2 }] },
    ],
  });
  const { policy } = resolvePolicy(m);
  const r = simulateRun(m, policy, limits, "expected", null);
  // wait 10 -> fight (t=15, stamina regen 5 during fight) -> wait 5 -> fight (t=25)
  assert.equal(r.nodes.e!.minute, 25);
  assert.equal(r.minutesWaiting, 15);
  assert.equal(r.stopReason, "completed");
});

test("stuck is detected with a concrete blocker instead of spinning", () => {
  const m = model({
    resources: [{ id: "gold", initial: 5 }, { id: "key" }],
    actions: [{ id: "buy", durationMinutes: 1, costs: [{ resource: "gold", amount: 10 }], outcomes: [{ type: "resource", resource: "key", amount: 1 }] }],
    progression: [
      { id: "s", order: 0 },
      { id: "door", order: 1, requirements: [{ type: "resource", resource: "key", gte: 1 }] },
    ],
  });
  const r = runSimulation(m, { mode: "expected", limits });
  assert.deepEqual(r.stopReasons, { stuck: 1 });
  assert.ok(r.stuck!.examples.some((b) => b.target === "action:buy" && b.reasons.some((x) => x.includes("gold"))));
  assert.equal(r.stalls[0]!.node, "door");
  // Static analysis agrees: door is unreachable.
  const reach = analyzeReachability(m);
  assert.equal(reach.nodes.find((n) => n.target === "door")!.status, "unreachable");
});

test("maxUses and resource max are enforced; overflow is reported", () => {
  const m = model({
    resources: [{ id: "g", max: 15 }],
    actions: [
      { id: "once", durationMinutes: 1, maxUses: 1, outcomes: [{ type: "resource", resource: "g", amount: 10 }] },
      { id: "rep", durationMinutes: 1, outcomes: [{ type: "resource", resource: "g", amount: 10 }] },
    ],
    progression: [],
  });
  const r = runSimulation(m, { mode: "expected", limits: { maxMinutes: 3, maxActions: 100 } });
  assert.equal(r.actionUsage.find((a) => a.id === "once")!.mean, 1);
  assert.equal(r.resources[0]!.final.median, 15);
  assert.equal(r.resources[0]!.overflow.median, 15);
});

test("weighted table: monte carlo frequency converges to weights", () => {
  const m = model({
    resources: [{ id: "a" }, { id: "b" }],
    actions: [{ id: "roll", durationMinutes: 1, outcomes: [{ type: "table", entries: [{ weight: 3, outcomes: [{ type: "resource", resource: "a", amount: 1 }] }, { weight: 1, outcomes: [{ type: "resource", resource: "b", amount: 1 }] }] }] }],
    progression: [],
  });
  const r = runSimulation(m, { mode: "monte-carlo", runs: 50, seed: 3, limits: { maxMinutes: 400, maxActions: 400 } });
  const a = r.resources.find((x) => x.id === "a")!.final.mean;
  assert.ok(Math.abs(a / 400 - 0.75) < 0.02, `share ${a / 400}`);
  const e = runSimulation(m, { mode: "expected", limits: { maxMinutes: 400, maxActions: 400 } });
  assert.equal(e.resources.find((x) => x.id === "a")!.final.median, 300);
});

test("policy choice changes results (tool vs hand-only)", () => {
  const best = runSimulation(minimal, { mode: "expected", limits });
  const hand = runSimulation(minimal, { mode: "expected", limits, policy: "hand_only" });
  // Hand mining (~36 gold/h) cannot reach "tycoon" (2000 gold) within 24h; the tool policy can.
  assert.ok(best.nodes[1]!.minute!.median < hand.nodes[1]!.minute!.median);
  assert.equal(best.nodes[2]!.reachRate, 1);
  assert.equal(hand.nodes[2]!.reachRate, 0);
});
