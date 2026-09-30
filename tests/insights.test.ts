import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareProject, simulateProject } from "../src/index.js";
import { parseScenario } from "../src/core/scenario.js";
import { buildInsights } from "../src/insights/insights.js";
import { renderHtml } from "../src/report/html.js";
import { main } from "../src/cli/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ex = (p: string) => path.join(root, "examples", p);
const limits = { maxMinutes: 24 * 60, maxActions: 100_000 };

const silence = async <T>(fn: () => Promise<T>): Promise<T> => {
  const w1 = process.stdout.write, w2 = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await fn(); } finally { process.stdout.write = w1; process.stderr.write = w2; }
};

test("insights: dao2 24h reports a stall at realm_foundation limited by spirit_stone with an ETA", async () => {
  const r = await simulateProject(ex("dao2-mock"), { mode: "monte-carlo", runs: 200, seed: 1, limits });
  const ins = buildInsights(r);
  const stall = ins.findings.find((f) => f.id === "stall" && f.subject === "node:realm_foundation");
  assert.ok(stall, JSON.stringify(ins.findings.map((f) => [f.id, f.subject])));
  assert.match(stall.detail, /spirit_stone/);
  const view = ins.pacing!.stalls.find((s) => s.node === "realm_foundation")!;
  const lim = view.limits.find((l) => l.resource === "spirit_stone")!;
  assert.ok(lim && lim.gap > 0 && lim.etaMinutes !== null && lim.etaMinutes > 0, JSON.stringify(view));
});

test("insights: dao2 scenario realm-stone-plus-50 top impact is realm_qi_refining", async () => {
  const sc = parseScenario(JSON.parse(readFileSync(ex("dao2-mock/scenarios/realm-stone-plus-50.json"), "utf8")));
  const r = await compareProject(ex("dao2-mock"), [sc], { mode: "monte-carlo", runs: 200, seed: 1, limits });
  const ins = buildInsights(r);
  const view = ins.scenarios![0]!;
  assert.equal(view.valid, true);
  assert.equal(view.nodeImpact[0]!.id, "realm_qi_refining");
  assert.ok(ins.findings.some((f) => f.id === "scenario-impact" && f.category === "scenario"));
});

test("insights are deterministic and findings sorted by severity", async () => {
  const opts = { mode: "monte-carlo" as const, runs: 100, seed: 7, limits };
  const a = buildInsights(await simulateProject(ex("godtower-mock"), opts));
  const b = buildInsights(await simulateProject(ex("godtower-mock"), opts));
  assert.deepEqual(a, b);
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  const ranks = a.findings.map((f) => rank[f.severity]);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
});

test("html: self-contained, escaped, embedded JSON round-trips", async () => {
  const r = await simulateProject(ex("minimal-idle-game/model.json"), { mode: "expected", limits });
  r.provenance.project.id = "</script><img src=x onerror=alert(1)>";
  const html = renderHtml(r, buildInsights(r));
  assert.ok(html.startsWith("<!doctype html>") || html.startsWith("<!DOCTYPE html>"));
  assert.doesNotMatch(html, /<(script|link|img)[^>]+(src|href)=["']?https?:/i, "no external resources");
  assert.doesNotMatch(html, /<img src=x/, "user strings must be escaped");
  const m = /<script type="application\/json" id="gdl-report">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "embedded report present");
  assert.deepEqual(JSON.parse(m[1]!), JSON.parse(JSON.stringify(r)));
});

test("cli: inspect/report read saved reports; non-report input is a usage error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gdl-test-"));
  const json = path.join(dir, "r.json");
  const code = await silence(() => main(["simulate", ex("minimal-idle-game/model.json"), "--mode", "expected", "--hours", "2", "--out", json]));
  assert.equal(code, 0);
  assert.equal(await silence(() => main(["inspect", json])), 0);
  assert.equal(await silence(() => main(["inspect", json, "--format", "json"])), 0);
  assert.equal(await silence(() => main(["report", json])), 0);
  assert.ok(existsSync(path.join(dir, "r.html")));

  const bogus = path.join(dir, "bogus.json");
  writeFileSync(bogus, JSON.stringify({ hello: 1 }));
  assert.equal(await silence(() => main(["inspect", bogus])), 2);
  assert.equal(await silence(() => main(["report", bogus])), 2);
  assert.equal(await silence(() => main(["inspect", path.join(dir, "missing.json")])), 2);
});
