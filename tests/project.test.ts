import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeProject, compareProject, simulateProject, validateProject } from "../src/index.js";
import { applyScenario, parseScenario } from "../src/core/scenario.js";
import type { GameModel } from "../src/schema/types.js";
import { main } from "../src/cli/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ex = (p: string) => path.join(root, "examples", p);
const limits = { maxMinutes: 48 * 60, maxActions: 100_000 };

test("cross-project: both mock adapters pass the same validation and produce common analyses", async () => {
  for (const p of ["dao2-mock", "godtower-mock"]) {
    const v = await validateProject(ex(p));
    assert.equal(v.validation.ok, true, `${p}: ${JSON.stringify(v.validation.errors)}`);
    assert.equal(v.provenance.sources.length, 2, `${p} should record 2 source files`);
    assert.ok(v.provenance.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256)));
    assert.ok(v.unsupported.length > 0, `${p} should declare unsupported features`);

    const a = await analyzeProject(ex(p), { limits });
    assert.ok(a.reachability && a.simulation);
    assert.ok(a.simulation.nodes.filter((n) => n.reachRate > 0).length >= 2, `${p}: at least 2 nodes reached`);
    assert.ok(a.simulation.resources.length >= 2);
  }
});

test("reproducible: same project + params + seed => identical simulation (except timestamp)", async () => {
  const opts = { mode: "monte-carlo" as const, runs: 100, seed: 42, limits };
  const a = await simulateProject(ex("dao2-mock"), opts);
  const b = await simulateProject(ex("dao2-mock"), opts);
  assert.deepEqual(a.simulation, b.simulation);
  assert.equal(a.provenance.modelSha256, b.provenance.modelSha256);
  assert.deepEqual(a.provenance.sources, b.provenance.sources);
});

test("scenario is applied to a copy and never touches the source", () => {
  const src = JSON.parse(readFileSync(ex("minimal-idle-game/model.json"), "utf8")) as GameModel;
  const before = JSON.stringify(src);
  const sc = parseScenario(JSON.parse(readFileSync(ex("minimal-idle-game/scenarios/pickaxe-cheaper.json"), "utf8")));
  const { model, applied } = applyScenario(src, sc);
  assert.equal(JSON.stringify(src), before);
  assert.equal(model.actions[0]!.costs![0]!.amount, 30);
  assert.deepEqual(applied[0]!.matches, [{ path: "actions[0].costs[0].amount", before: 50, after: 30 }]);
});

test("scenario with a target that matches nothing is an error, not a silent no-op", () => {
  const src = JSON.parse(readFileSync(ex("minimal-idle-game/model.json"), "utf8")) as GameModel;
  assert.throws(() => applyScenario(src, { id: "typo", changes: [{ target: "actions[buy_pickax].durationMinutes", op: "set", value: 1 }] }), /matched nothing/);
});

test("compare: cheaper pickaxe makes the first node faster; source files unchanged", async () => {
  const file = ex("minimal-idle-game/model.json");
  const mtime = statSync(file).mtimeMs;
  const sc = parseScenario(JSON.parse(readFileSync(ex("minimal-idle-game/scenarios/pickaxe-cheaper.json"), "utf8")));
  const r = await compareProject(file, [sc], { mode: "expected", limits });
  const d = r.scenarios[0]!.diff!;
  const rich = d.nodes.find((n) => n.id === "rich")!;
  assert.ok(rich.medianMinute.delta! < 0, JSON.stringify(rich));
  assert.equal(statSync(file).mtimeMs, mtime);
});

test("cli exit codes: 0 ok, 1 invalid data, 2 usage error", async () => {
  const silence = <T>(fn: () => Promise<T>) => async () => {
    const w1 = process.stdout.write, w2 = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { return await fn(); } finally { process.stdout.write = w1; process.stderr.write = w2; }
  };
  assert.equal(await silence(() => main(["validate", ex("minimal-idle-game/model.json")]))(), 0);
  assert.equal(await silence(() => main(["validate", ex("invalid/model.json")]))(), 1);
  assert.equal(await silence(() => main(["validate", ex("does-not-exist")]))(), 2);
  assert.equal(await silence(() => main(["simulate", ex("minimal-idle-game/model.json"), "--runs", "0"]))(), 2);
  assert.equal(await silence(() => main(["bogus"]))(), 2);
});
