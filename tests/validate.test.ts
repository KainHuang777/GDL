import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateModel } from "../src/schema/validate.js";

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("minimal example is valid with no warnings", () => {
  const r = validateModel(load("../examples/minimal-idle-game/model.json"));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
});

test("invalid example reports each class of problem with a path", () => {
  const r = validateModel(load("../examples/invalid/model.json"));
  assert.equal(r.ok, false);
  const codes = (sev: "errors" | "warnings") => r[sev].map((i) => `${i.code}@${i.path}`);
  const errs = codes("errors");
  assert.ok(errs.includes("DUPLICATE_ID@resources[2].id"), errs.join("\n"));
  assert.ok(errs.includes("INVALID_PROBABILITY@actions[0].outcomes[0].probability"));
  assert.ok(errs.includes("REF_NOT_FOUND@actions[0].outcomes[1].resource"));
  assert.ok(errs.includes("INVALID_NUMBER@actions[1].durationMinutes"));
  assert.ok(errs.includes("CYCLIC_DEPENDENCY@progression[1].requirements[0].node"));
  assert.ok(codes("warnings").includes("TIME_AS_RESOURCE@resources[1].id"));
});

test("unknown schema version and non-object input are errors, never throws", () => {
  assert.equal(validateModel(null).ok, false);
  assert.equal(validateModel([]).ok, false);
  const r = validateModel({ schemaVersion: "9.9", project: { id: "x" }, resources: [], actions: [], progression: [] });
  assert.ok(r.errors.some((e) => e.code === "UNKNOWN_SCHEMA_VERSION"));
});

test("typo in a reference suggests the closest id", () => {
  const r = validateModel({
    schemaVersion: "0.1",
    project: { id: "x" },
    resources: [{ id: "gold" }],
    actions: [{ id: "a", durationMinutes: 1, outcomes: [{ type: "resource", resource: "gld", amount: 1 }] }],
    progression: [],
  });
  const e = r.errors.find((x) => x.code === "REF_NOT_FOUND");
  assert.match(e?.hint ?? "", /Did you mean: gold/);
});

test("resource required but never produced is flagged", () => {
  const r = validateModel({
    schemaVersion: "0.1",
    project: { id: "x" },
    resources: [{ id: "gold" }, { id: "key" }],
    actions: [{ id: "a", durationMinutes: 1, outcomes: [{ type: "resource", resource: "gold", amount: 1 }] }],
    progression: [{ id: "n", order: 1, requirements: [{ type: "resource", resource: "key", gte: 1 }] }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === "RESOURCE_NEVER_PRODUCED"));
});

test("validation issues carry the adapter's source reference", () => {
  const r = validateModel({
    schemaVersion: "0.1",
    project: { id: "x" },
    resources: [{ id: "gold" }],
    actions: [{ id: "a", durationMinutes: 1, source: { file: "data/a.csv", path: "row 3" }, outcomes: [{ type: "resource", resource: "gold", amount: -1 }] }],
    progression: [],
  });
  assert.deepEqual(r.errors[0]?.source, { file: "data/a.csv", path: "row 3" });
});
