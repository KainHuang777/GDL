import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareProject, simulateProject } from "../src/index.js";
import { parseScenario } from "../src/core/scenario.js";
import { buildInsights } from "../src/insights/insights.js";
import { renderHtml } from "../src/report/html.js";
import { main } from "../src/cli/index.js";
import { validateModel } from "../src/schema/validate.js";
import { readReport } from "../src/report/io.js";
import { buildTrend } from "../src/report/trend.js";

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

test("insights: zh-TW localizes finding titles and uses Chinese display names", async () => {
  const r = await simulateProject(ex("dao-real"), { mode: "expected", policy: "smart", limits });
  const zh = buildInsights(r, "zh-TW");
  const en = buildInsights(r);
  const zhOverflow = zh.findings.find((f) => f.id === "overflow")!;
  const enOverflow = en.findings.find((f) => f.id === "overflow")!;
  assert.ok(zhOverflow && enOverflow, JSON.stringify(zh.findings.map((f) => f.id)));
  assert.match(zhOverflow.title, /溢出/);
  assert.match(zhOverflow.title, /」/);
  assert.doesNotMatch(zhOverflow.title, /overflows/);
  assert.match(enOverflow.title, /overflows/);
  assert.equal(zh.findings.length, en.findings.length);
  assert.ok(r.simulation!.resources.some((x) => x.name), "dao-real resources carry Chinese names");
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


test("round-2: wait attribution, strategy waste, kind-aware economy and caveats (dao-real)", async () => {
  const r = await simulateProject(ex("dao-real"), { mode: "expected", policy: "smart", limits });
  const sim = r.simulation!;
  const era4 = sim.nodes.find((n) => n.id === "era_4")!;
  assert.equal(era4.limiters[0]!.resource, "lingli");
  assert.ok(era4.limiters[0]!.share > 0.9);
  const w = sim.waste.find((x) => x.resource === "foundation_pill")!;
  assert.ok(w && w.unusedShare > 0.5, JSON.stringify(sim.waste));
  const ins = buildInsights(r);
  const waste = ins.findings.find((f) => f.id === "strategy-waste" && f.subject === "action:craft_foundation_pill")!;
  assert.equal(waste.category, "policy");
  assert.equal(waste.severity, "warning");
  const wait = ins.findings.find((f) => f.id === "wait-cause" && f.subject === "node:era_4")!;
  assert.ok(wait?.caveats?.length, "lingli finding carries model-gap caveats");
  const noSink = ins.findings.find((f) => f.id === "no-sink");
  assert.ok(!noSink || !/training|skill_/.test(noSink.detail + noSink.title));
  assert.ok(!ins.findings.some((f) => f.id === "overflow" && f.severity === "warning" && f.caveats), "caveated overflow is downgraded");
  const zh = buildInsights(r, "zh-TW");
  assert.match(zh.findings.find((f) => f.id === "strategy-waste")!.detail, /策略效率/);
  assert.ok(!/\$\{|\{\w+\}/.test(JSON.stringify(ins.findings)), "no unfilled templates");
});

test("round-2: scenario with different end times does not compare final resources", async () => {
  const sc = parseScenario(JSON.parse(readFileSync(path.join(ex("dao-real"), "scenarios/lingli-regen-plus-50.json"), "utf8")));
  const r = await compareProject(ex("dao-real"), [sc], { mode: "expected", policy: "smart", limits });
  const view = buildInsights(r).scenarios![0]!;
  assert.equal(view.resourcesComparable, false);
  assert.equal(view.resourceImpact.length, 0);
  assert.ok(view.nodeImpact.some((n) => n.id === "era_4"));
});

test("round-2: resource kind and unsupported.affects are validated", () => {
  const base = JSON.parse(readFileSync(ex("minimal-idle-game/model.json"), "utf8"));
  const bad = structuredClone(base);
  bad.resources[0].kind = "bogus";
  bad.unsupported = [{ feature: "x", reason: "y", affects: ["nope"] }];
  const v = validateModel(bad);
  assert.equal(v.ok, false);
  const codes = v.errors.map((e) => e.code);
  assert.ok(codes.includes("INVALID_FIELD") && codes.includes("REF_NOT_FOUND"), codes.join());
  const good = structuredClone(base);
  good.resources[0].kind = "counter";
  assert.equal(validateModel(good).ok, true);
});
test("insights: threshold overrides change findings and are validated", async () => {
  const r = await simulateProject(ex("dao2-mock"), { mode: "monte-carlo", runs: 200, seed: 1, limits });
  assert.ok(buildInsights(r).findings.some((f) => f.id === "stall"));
  const relaxed = buildInsights(r, "en", { thresholds: { stallShare: 1.5 } });
  assert.ok(!relaxed.findings.some((f) => f.id === "stall"), "stall should be suppressed");
  assert.deepEqual(relaxed.thresholdOverrides, { stallShare: 1.5 });
  assert.throws(() => buildInsights(r, "en", { thresholds: { nope: 1 } as never }), /unknown threshold/);
  assert.throws(() => buildInsights(r, "en", { thresholds: { stallShare: -1 } }), />= 0/);
});

function customProject(extraConfig: Record<string, unknown> = {}, rules = ""): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gdl-custom-"));
  mkdirSync(path.join(dir, ".gdl"), { recursive: true });
  writeFileSync(path.join(dir, "model.json"), readFileSync(ex("minimal-idle-game/model.json")));
  writeFileSync(path.join(dir, ".gdl/config.json"), JSON.stringify({ projectId: "custom", adapter: "./adapter.mjs", ...extraConfig }));
  writeFileSync(
    path.join(dir, ".gdl/adapter.mjs"),
    `export default { id: "custom", version: "1.0.0", load: (ctx) => ctx.readJson("model.json"), insightRules: [${rules}] };\n`,
  );
  return dir;
}

test("insights: adapter rules add findings via CLI; failing rules become rule-error; config thresholds apply", async () => {
  const rules = `
    { id: "always", evaluate: (ctx) => [{ id: "custom-note", severity: "info", category: "data", scope: "", title: "hello " + ctx.report.kind, detail: "runs=" + ctx.sim.runs }] },
    { id: "boom", evaluate: () => { throw new Error("kaput"); } }`;
  const dir = customProject({ insights: { thresholds: { stallShare: 0.5 } } }, rules);
  const out = path.join(dir, "r.json");
  assert.equal(await silence(() => main(["simulate", dir, "--runs", "20", "--out", out, "--format", "json"])), 0);
  const report = JSON.parse(readFileSync(out, "utf8"));
  const insOut = path.join(dir, "ins.json");
  const w = process.stdout.write;
  let buf = "";
  process.stdout.write = ((s: string) => ((buf += s), true)) as typeof process.stdout.write;
  try {
    assert.equal(await main(["inspect", out, "--format", "json", "--threshold", "spikeFactor=9"]), 0);
  } finally {
    process.stdout.write = w;
  }
  void insOut;
  const ins = JSON.parse(buf);
  const note = ins.findings.find((f: { id: string }) => f.id === "custom-note");
  assert.ok(note && note.rule === "always" && note.scope === "simulation" && note.title === "hello simulate", JSON.stringify(ins.findings));
  const err = ins.findings.find((f: { id: string }) => f.id === "rule-error");
  assert.ok(err && err.rule === "boom" && /kaput/.test(err.detail));
  assert.deepEqual(ins.thresholdOverrides, { stallShare: 0.5, spikeFactor: 9 });
  assert.equal(report.kind, "simulate");
});

test("insights: bad config thresholds and --threshold values are rejected", async () => {
  const bad = customProject({ insights: { thresholds: { bogus: 1 } } });
  assert.equal(await silence(() => main(["simulate", bad, "--runs", "5"])), 2);
  const ok = customProject();
  const out = path.join(ok, "r.json");
  assert.equal(await silence(() => main(["simulate", ok, "--runs", "5", "--out", out])), 0);
  assert.equal(await silence(() => main(["inspect", out, "--threshold", "stallShare"])), 2);
  assert.equal(await silence(() => main(["inspect", out, "--threshold", "nope=1"])), 2);
});

test("insights: histograms and timeline appear only with --keep-runs / --trace and render in html", async () => {
  const plain = await simulateProject(ex("dao2-mock"), { mode: "monte-carlo", runs: 50, seed: 1, limits });
  const p = buildInsights(plain);
  assert.equal(p.histograms, undefined);
  assert.equal(p.timeline, undefined);
  assert.ok(!renderHtml(plain, p).includes('id="distributions"'));

  const r = await simulateProject(ex("dao2-mock"), { mode: "monte-carlo", runs: 50, seed: 1, limits, keepRuns: true, trace: true });
  const ins = buildInsights(r);
  assert.ok(ins.histograms && ins.histograms.length > 0);
  for (const h of ins.histograms!) {
    assert.equal(h.bins.reduce((a, b) => a + b, 0), h.count);
    assert.equal(h.count + h.missing, 50);
    assert.ok(h.min <= h.median && h.median <= h.max);
  }
  const tl = ins.timeline!;
  assert.ok(tl.horizon > 0 && tl.series.length > 0 && tl.waitingShare >= 0 && tl.waitingShare <= 1);
  assert.ok(tl.waits.every((w) => w.end > w.start));
  const html = renderHtml(r, ins);
  assert.ok(html.includes('id="distributions"') && html.includes('id="timeline"'));
  const zh = renderHtml(r, buildInsights(r, "zh-TW"), { lang: "zh-TW" });
  assert.ok(zh.includes("到達時間分佈") && zh.includes("時間軸"));
  assert.deepEqual(buildInsights(r), ins);
});

test("trend: groups comparable reports, marks model changes, renders html", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gdl-trend-"));
  const a = path.join(dir, "a.json"), b = path.join(dir, "b.json"), c = path.join(dir, "c.json"), v = path.join(dir, "v.json");
  const sc = path.join(dir, "sc.json");
  writeFileSync(sc, readFileSync(ex("dao2-mock/scenarios/realm-stone-plus-50.json")));
  assert.equal(await silence(() => main(["simulate", ex("dao2-mock"), "--runs", "30", "--out", a, "--format", "json"])), 0);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await silence(() => main(["simulate", ex("dao2-mock"), "--runs", "30", "--seed", "2", "--out", b, "--format", "json"])), 0);
  // Same project but a different (tweaked) model: change a value so modelSha256 differs.
  const tweaked = JSON.parse(readFileSync(ex("minimal-idle-game/model.json"), "utf8"));
  const mp = path.join(dir, "model.json");
  writeFileSync(mp, JSON.stringify(tweaked));
  assert.equal(await silence(() => main(["simulate", mp, "--runs", "30", "--out", c, "--format", "json"])), 0);
  assert.equal(await silence(() => main(["validate", ex("dao2-mock"), "--out", v, "--format", "json"])), 0);

  const trend = buildTrend(await Promise.all([a, b, c, v].map(async (f) => {
    const report = await readReport(f);
    return { file: f, report, insights: buildInsights(report) };
  })));
  assert.equal(trend.groups.length, 2, JSON.stringify(trend.groups.map((g) => g.key)));
  assert.equal(trend.skipped.length, 1);
  const g = trend.groups.find((x) => x.project.includes("dao") || x.entries.length === 2)!;
  assert.equal(g.entries.length, 2);
  assert.ok(g.entries[0]!.generatedAt <= g.entries[1]!.generatedAt);
  assert.equal(g.entries[1]!.modelChanged, false);
  assert.ok(g.nodeDeltas.length > 0);

  const out = path.join(dir, "trend.html");
  assert.equal(await silence(() => main(["report", a, b, "--out", out, "--lang", "zh-TW"])), 0);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes('id="gdl-trend"') && html.includes("<svg") && html.includes("趨勢"));
  assert.ok(!/<script(?![^>]*application\/json)/.test(html), "no executable script");

  let buf = "";
  const w = process.stdout.write;
  process.stdout.write = ((s: string) => ((buf += s), true)) as typeof process.stdout.write;
  try { assert.equal(await main(["inspect", a, b]), 0); } finally { process.stdout.write = w; }
  assert.match(buf, /first -> last median arrival/);
  assert.equal(await silence(() => main(["inspect", a, b, "--focus", "economy"])), 2);
  assert.equal(await silence(() => main(["report", v, v, "--out", out])), 2);
  void sc;
});

test("index: --save refreshes <outputDir>/index.html; gdl index lists reports, skips junk", async () => {
  const dir = customProject({}, "");
  assert.equal(await silence(() => main(["simulate", dir, "--runs", "10", "--save"])), 0);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await silence(() => main(["simulate", dir, "--runs", "10", "--seed", "3", "--save"])), 0);
  const rdir = path.join(dir, ".gdl", "reports");
  const idx = path.join(rdir, "index.html");
  assert.ok(existsSync(idx));
  let html = readFileSync(idx, "utf8");
  assert.equal((html.match(/href="[^"]+\.json"/g) ?? []).length, 2, html.slice(0, 500));
  assert.equal((html.match(/href="[^"]+-simulate\.html"/g) ?? []).length, 2);
  assert.ok(html.includes('id="gdl-index"'));
  assert.ok(!/<script(?![^>]*application\/json)/.test(html), "no executable script");

  writeFileSync(path.join(rdir, "junk.json"), "{not json");
  assert.equal(await silence(() => main(["index", dir, "--lang", "zh-TW"])), 0);
  html = readFileSync(idx, "utf8");
  assert.ok(html.includes("junk.json"));
  const emb = /<script type="application\/json" id="gdl-index">([\s\S]*?)<\/script>/.exec(html)!;
  const data = JSON.parse(emb[1]!);
  assert.equal(data.entries.length, 2);
  assert.equal(data.skipped.length, 1);
  assert.ok(data.entries[0]!.generatedAt >= data.entries[1]!.generatedAt);

  const custom = path.join(dir, "custom-index.html");
  assert.equal(await silence(() => main(["index", rdir, "--out", custom])), 0);
  assert.ok(existsSync(custom));
  assert.equal(await silence(() => main(["index", path.join(dir, "nope")])), 2);
  assert.equal(await silence(() => main(["index", path.join(dir, ".gdl", "config.json")])), 2);
});
