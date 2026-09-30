import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GameModel, Policy } from "../src/schema/types.js";
import { validateModel } from "../src/schema/validate.js";
import { runSimulation } from "../src/core/runner.js";

const minimal = JSON.parse(readFileSync(new URL("../examples/minimal-idle-game/model.json", import.meta.url), "utf8")) as GameModel;
const limits = { maxMinutes: 8 * 60, maxActions: 100_000 };

function withPolicy(p: Partial<Policy> & { id: string }): GameModel {
  return { ...minimal, policies: [...(minimal.policies ?? []), { type: "adaptive", ...p } as Policy] };
}

function usage(r: ReturnType<typeof runSimulation>, id: string): number {
  return r.actionUsage.find((a) => a.id === id)?.mean ?? 0;
}

test("validation accepts adaptive policies and rejects bad parameters", () => {
  assert.equal(validateModel(withPolicy({ id: "a" })).ok, true);
  assert.equal(validateModel(withPolicy({ id: "a", actions: ["mine_by_hand"], temperature: 0.3, lookaheadMinutes: 0 })).ok, true);

  const codes = (m: GameModel) => validateModel(m).errors.map((e) => `${e.code}@${e.path}`);
  assert.ok(codes(withPolicy({ id: "a", temperature: -1 })).some((c) => c.startsWith("INVALID_NUMBER@") && c.endsWith(".temperature")));
  assert.ok(codes(withPolicy({ id: "a", lookaheadMinutes: -5 })).some((c) => c.endsWith(".lookaheadMinutes")));
  assert.ok(codes(withPolicy({ id: "a", objective: "fun" as never })).some((c) => c.startsWith("INVALID_FIELD@") && c.endsWith(".objective")));
  assert.ok(codes(withPolicy({ id: "a", actions: ["nope"] })).some((c) => c.startsWith("REF_NOT_FOUND@")));
  assert.ok(codes(withPolicy({ id: "a", actions: [] })).some((c) => c.startsWith("MISSING_FIELD@")));
});

test("adaptive with look-ahead invests in the pickaxe and beats hand-only mining", () => {
  const m = withPolicy({ id: "smart2", lookaheadMinutes: 120 });
  const opts = { mode: "expected" as const, limits };
  const smart = runSimulation(m, { ...opts, policy: "smart2" });
  const hand = runSimulation(m, { ...opts, policy: "hand_only" });
  assert.equal(smart.policy.type, "adaptive");
  assert.equal(smart.policy.adaptive?.lookaheadMinutes, 120);
  assert.equal(usage(smart, "buy_pickaxe"), 1);
  const gold = (r: typeof smart) => r.resources.find((x) => x.id === "gold")!.final.mean;
  assert.ok(gold(smart) > gold(hand) * 2, `smart ${gold(smart)} vs hand ${gold(hand)}`);
});

test("adaptive without look-ahead is purely greedy and never invests", () => {
  const r = runSimulation(withPolicy({ id: "greedy", lookaheadMinutes: 0 }), { mode: "expected", limits, policy: "greedy" });
  assert.equal(usage(r, "buy_pickaxe"), 0);
});

test("adaptive is deterministic and reproducible for a seed, and temperature is ignored in expected mode", () => {
  const m = withPolicy({ id: "warm", temperature: 0.5 });
  const mc = { mode: "monte-carlo" as const, runs: 30, seed: 7, limits, policy: "warm" };
  assert.deepEqual(runSimulation(m, mc), runSimulation(m, mc));
  const cold = withPolicy({ id: "warm", temperature: 0 });
  const ex = { mode: "expected" as const, limits, policy: "warm" };
  assert.deepEqual(runSimulation(m, ex).nodes, runSimulation(cold, ex).nodes);
});
