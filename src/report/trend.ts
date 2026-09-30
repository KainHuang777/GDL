import type { AnyReport } from "../index.js";
import type { SimulationResult } from "../core/runner.js";
import type { Insights } from "../insights/insights.js";
import { CSS, badge, embedJson, esc, svg, type HtmlLang } from "./html.js";
import { fmtMin, num, pct, signedPct } from "./units.js";

/**
 * Multi-report comparison / trend (docs/dashboard-design.md §8).
 * Reports are grouped by project + policy + mode + time limit, so only comparable runs share a chart;
 * within a group they are ordered by generation time and a change of `modelSha256` is marked.
 * Pure over already-loaded reports; nothing is re-simulated.
 */

export interface TrendInput {
  /** Display name (usually the file path given on the command line). */
  file: string;
  report: AnyReport;
  insights: Insights;
}

export interface TrendNode {
  id: string;
  reachRate: number;
  p10: number | null;
  median: number | null;
  p90: number | null;
}

export interface TrendEntry {
  file: string;
  kind: AnyReport["kind"];
  generatedAt: string;
  modelSha256: string;
  /** True when the model hash differs from the previous entry in the group. */
  modelChanged: boolean;
  runs: number;
  seed: number | null;
  completionRate: number;
  /** Median run length in in-game minutes. */
  medianMinutes: number;
  findings: { critical: number; warning: number; info: number };
  /** `id|subject|scope` keys of every finding, for new/resolved tracking. */
  findingKeys: string[];
  nodes: TrendNode[];
}

export interface TrendDelta {
  id: string;
  first: number | null;
  last: number | null;
  delta: number | null;
  pct: number | null;
}

export interface TrendGroup {
  key: string;
  project: string;
  policy: string;
  mode: string;
  maxMinutes: number;
  entries: TrendEntry[];
  /** First -> last median arrival time per node (only meaningful with 2+ entries). */
  nodeDeltas: TrendDelta[];
  /** Finding keys present in the last entry but not the first, and vice versa. */
  newFindings: string[];
  resolvedFindings: string[];
}

export interface Trend {
  groups: TrendGroup[];
  /** Files that carry no simulation (validate reports, invalid models) and were left out. */
  skipped: { file: string; reason: string }[];
}

function primary(r: AnyReport): SimulationResult | undefined {
  return r.kind === "compare" ? r.baseline : r.kind === "validate" ? undefined : r.simulation;
}

export function buildTrend(inputs: TrendInput[]): Trend {
  const skipped: Trend["skipped"] = [];
  const groups = new Map<string, TrendGroup>();
  const staged = new Map<string, TrendEntry[]>();
  for (const { file, report, insights } of inputs) {
    const sim = primary(report);
    if (!sim) {
      skipped.push({ file, reason: report.kind === "validate" ? "validate report has no simulation" : "report has no simulation (invalid model?)" });
      continue;
    }
    const key = [report.provenance.project.id, sim.policy.id, sim.mode, sim.limits.maxMinutes].join("|");
    if (!groups.has(key)) {
      groups.set(key, { key, project: report.provenance.project.id, policy: sim.policy.id, mode: sim.mode, maxMinutes: sim.limits.maxMinutes, entries: [], nodeDeltas: [], newFindings: [], resolvedFindings: [] });
      staged.set(key, []);
    }
    const f = { critical: 0, warning: 0, info: 0 };
    for (const x of insights.findings) f[x.severity]++;
    staged.get(key)!.push({
      file,
      kind: report.kind,
      generatedAt: report.provenance.generatedAt,
      modelSha256: report.provenance.modelSha256,
      modelChanged: false,
      runs: sim.runs,
      seed: sim.seed,
      completionRate: sim.completionRate,
      medianMinutes: sim.minutes.median,
      findings: f,
      findingKeys: insights.findings.map((x) => `${x.id}|${x.subject ?? ""}|${x.scope}`),
      nodes: sim.nodes.map((n) => ({ id: n.id, reachRate: n.reachRate, p10: n.minute?.p10 ?? null, median: n.minute?.median ?? null, p90: n.minute?.p90 ?? null })),
    });
  }
  for (const [key, g] of groups) {
    const entries = staged.get(key)!.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.file.localeCompare(b.file));
    entries.forEach((e, i) => (e.modelChanged = i > 0 && e.modelSha256 !== entries[i - 1]!.modelSha256));
    g.entries = entries;
    if (entries.length > 1) {
      const first = entries[0]!;
      const last = entries[entries.length - 1]!;
      const ids = [...new Set(entries.flatMap((e) => e.nodes.map((n) => n.id)))];
      g.nodeDeltas = ids.map((id) => {
        const a = first.nodes.find((n) => n.id === id)?.median ?? null;
        const b = last.nodes.find((n) => n.id === id)?.median ?? null;
        const delta = a !== null && b !== null ? b - a : null;
        return { id, first: a, last: b, delta, pct: delta !== null && a ? (delta / a) * 100 : null };
      });
      const fs = new Set(first.findingKeys);
      const ls = new Set(last.findingKeys);
      g.newFindings = [...ls].filter((k) => !fs.has(k)).sort();
      g.resolvedFindings = [...fs].filter((k) => !ls.has(k)).sort();
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)), skipped };
}

// ---------------------------------------------------------------- html

interface TU {
  title: string;
  groupH: (project: string) => string;
  groupMeta: (policy: string, mode: string, limit: string) => string;
  needTwo: string;
  thNum: string;
  thWhen: string;
  thFile: string;
  thModel: string;
  thRuns: string;
  thCompl: string;
  thMedian: string;
  thFindings: string;
  modelChanged: string;
  runLengthH: string;
  completionH: string;
  nodesH: string;
  nodesHint: string;
  deltaH: string;
  thNode: string;
  thFirst: string;
  thLast: string;
  thDelta: string;
  newH: string;
  resolvedH: string;
  none: string;
  skippedH: string;
  footer: (v: string) => string;
  modelLine: string;
}

const EN_T: TU = {
  title: "Trend",
  groupH: (p) => p,
  groupMeta: (p, m, l) => `policy ${p} · ${m} · limit ${l}`,
  needTwo: "Only one comparable report in this group; add more to see a trend.",
  thNum: "#",
  thWhen: "Generated",
  thFile: "File",
  thModel: "Model",
  thRuns: "Runs / seed",
  thCompl: "Completed",
  thMedian: "Median length",
  thFindings: "Findings (C/W/I)",
  modelChanged: "model changed",
  runLengthH: "Median run length",
  completionH: "Completion rate",
  nodesH: "Arrival time per node",
  nodesHint: "median with p10-p90 band; dashed line = model changed",
  deltaH: "First → last",
  thNode: "Node",
  thFirst: "First",
  thLast: "Last",
  thDelta: "Δ",
  newH: "New findings (last vs first)",
  resolvedH: "Resolved findings (last vs first)",
  none: "none",
  skippedH: "Skipped files",
  footer: (v) => `Generated by GDL ${v}. Reports are compared as recorded; nothing was re-simulated.`,
  modelLine: "model",
};

const ZH_T: TU = {
  title: "趨勢",
  groupH: (p) => p,
  groupMeta: (p, m, l) => `策略 ${p} · ${m} · 上限 ${l}`,
  needTwo: "此群組只有一份可比較的報告；再加入報告即可看到趨勢。",
  thNum: "#",
  thWhen: "產生時間",
  thFile: "檔案",
  thModel: "模型",
  thRuns: "執行數 / 種子",
  thCompl: "完成率",
  thMedian: "中位數時長",
  thFindings: "發現 (嚴重/警告/資訊)",
  modelChanged: "模型已變更",
  runLengthH: "執行時長中位數",
  completionH: "完成率",
  nodesH: "各節點到達時間",
  nodesHint: "中位數與 p10-p90 範圍；虛線 = 模型已變更",
  deltaH: "首份 → 末份",
  thNode: "節點",
  thFirst: "首份",
  thLast: "末份",
  thDelta: "Δ",
  newH: "新增的發現（末份相對首份）",
  resolvedH: "已消失的發現（末份相對首份）",
  none: "無",
  skippedH: "略過的檔案",
  footer: (v) => `由 GDL ${v} 產生。報告依原紀錄比較，未重新模擬。`,
  modelLine: "模型",
};

const W = 300;
const H = 90;
const PAD = { l: 8, r: 8, t: 8, b: 16 };

/** Small line chart over entry index. `band` is an optional [lo, hi] range per point. */
function lineChart(vals: (number | null)[], opts: { band?: ([number, number] | null)[]; changed: boolean[]; fmt: (n: number) => string; max?: number; min?: number }): string {
  const nums = vals.filter((v): v is number => v !== null);
  const bandNums = (opts.band ?? []).flatMap((b) => (b ? b : []));
  const all = [...nums, ...bandNums];
  if (!all.length) return `<p class="muted">-</p>`;
  const lo = opts.min ?? Math.min(...all);
  let hi = opts.max ?? Math.max(...all);
  if (hi <= lo) hi = lo + 1;
  const n = vals.length;
  const x = (i: number) => PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const parts: string[] = [];
  opts.changed.forEach((c, i) => c && parts.push(`<line x1="${x(i - 0.5).toFixed(1)}" x2="${x(i - 0.5).toFixed(1)}" y1="${PAD.t}" y2="${H - PAD.b}" class="med"/>`));
  if (opts.band) {
    const pts = opts.band.map((b, i) => (b ? { i, b } : null)).filter((p): p is { i: number; b: [number, number] } => p !== null);
    if (pts.length > 1) {
      const top = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.b[1]).toFixed(1)}`);
      const bot = [...pts].reverse().map((p) => `${x(p.i).toFixed(1)},${y(p.b[0]).toFixed(1)}`);
      parts.push(`<polygon points="${[...top, ...bot].join(" ")}" fill="#4e79a7" opacity="0.2"/>`);
    }
  }
  let d = "";
  vals.forEach((v, i) => {
    if (v === null) return;
    d += `${d && vals[i - 1] !== null && vals[i - 1] !== undefined ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  parts.push(`<path d="${d}" fill="none" stroke="#4e79a7" stroke-width="2"/>`);
  vals.forEach((v, i) => v !== null && parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="#4e79a7"><title>#${i + 1}: ${esc(opts.fmt(v))}</title></circle>`));
  parts.push(`<text x="${PAD.l}" y="${H - 3}" class="muted">${esc(opts.fmt(lo))}</text><text x="${W - PAD.r}" y="${H - 3}" text-anchor="end" class="muted">${esc(opts.fmt(hi))}</text>`);
  return svg(W, H, parts.join(""));
}

export function renderTrendHtml(trend: Trend, opts: { lang?: HtmlLang; gdlVersion: string }): string {
  const t = opts.lang === "zh-TW" ? ZH_T : EN_T;
  const sections = trend.groups.map((g, gi) => groupSection(t, g, gi));
  const skipped = trend.skipped.length ? `<section><h2>${esc(t.skippedH)}</h2><ul>${trend.skipped.map((s) => `<li><code>${esc(s.file)}</code> — ${esc(s.reason)}</li>`).join("")}</ul></section>` : "";
  const nav = trend.groups.map((g, i) => `<a href="#g${i}">${esc(g.project)} · ${esc(g.policy)}</a>`).join("");
  const total = trend.groups.reduce((a, g) => a + g.entries.length, 0);
  return `<!doctype html>
<html lang="${opts.lang === "zh-TW" ? "zh-Hant" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="GDL ${esc(opts.gdlVersion)}">
<title>GDL ${esc(t.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="title"><h1>GDL ${esc(t.title)}</h1><span class="kind">${total} report(s) · ${trend.groups.length} group(s)</span></div>
  <nav>${nav}</nav>
</header>
<main>
${sections.join("\n")}
${skipped}
</main>
<footer><p class="muted">${esc(t.footer(opts.gdlVersion))}</p></footer>
<script type="application/json" id="gdl-trend">${embedJson(trend)}</script>
</body>
</html>
`;
}

function groupSection(t: TU, g: TrendGroup, gi: number): string {
  const es = g.entries;
  const changed = es.map((e) => e.modelChanged);
  const parts: string[] = [`<section id="g${gi}"><h2>${esc(t.groupH(g.project))} <small>${esc(t.groupMeta(g.policy, g.mode, fmtMin(g.maxMinutes)))}</small></h2>`];
  const rows = es.map((e, i) => `<tr><td class="n">${i + 1}</td><td>${esc(e.generatedAt)}</td><td><code>${esc(e.file)}</code></td><td title="${esc(e.modelSha256)}">${esc(e.modelSha256.slice(0, 10))}${e.modelChanged ? " " + badge("warning", t.modelChanged) : ""}</td><td class="n">${e.runs}${e.seed !== null ? ` / ${e.seed}` : ""}</td><td class="n">${pct(e.completionRate)}</td><td class="n">${fmtMin(e.medianMinutes)}</td><td class="n">${e.findings.critical}/${e.findings.warning}/${e.findings.info}</td></tr>`).join("");
  parts.push(`<table><thead><tr><th>${t.thNum}</th><th>${t.thWhen}</th><th>${t.thFile}</th><th>${t.thModel}</th><th>${t.thRuns}</th><th>${t.thCompl}</th><th>${t.thMedian}</th><th>${esc(t.thFindings)}</th></tr></thead><tbody>${rows}</tbody></table>`);
  if (es.length < 2) {
    parts.push(`<p class="muted">${esc(t.needTwo)}</p></section>`);
    return parts.join("");
  }
  parts.push(`<div class="flows"><div><h4>${esc(t.runLengthH)}</h4>${lineChart(es.map((e) => e.medianMinutes), { changed, fmt: fmtMin })}</div><div><h4>${esc(t.completionH)}</h4>${lineChart(es.map((e) => e.completionRate), { changed, fmt: pct, min: 0, max: 1 })}</div></div>`);
  const ids = [...new Set(es.flatMap((e) => e.nodes.map((n) => n.id)))];
  const cells = ids.map((id) => {
    const pts = es.map((e) => e.nodes.find((n) => n.id === id));
    const vals = pts.map((p) => p?.median ?? null);
    const band = pts.map((p): [number, number] | null => (p && p.p10 !== null && p.p90 !== null ? [p.p10, p.p90] : null));
    return `<div><h4>${esc(id)}</h4>${lineChart(vals, { band, changed, fmt: fmtMin })}</div>`;
  });
  parts.push(`<h3>${esc(t.nodesH)} <small>${esc(t.nodesHint)}</small></h3><div class="flows">${cells.join("")}</div>`);
  const drows = g.nodeDeltas.map((d) => `<tr><td>${esc(d.id)}</td><td class="n">${d.first === null ? "-" : fmtMin(d.first)}</td><td class="n">${d.last === null ? "-" : fmtMin(d.last)}</td><td class="n ${d.delta === null ? "" : d.delta > 0 ? "bad" : d.delta < 0 ? "good" : ""}">${d.delta === null ? "-" : (d.delta > 0 ? "+" : "") + num(Math.round(d.delta * 100) / 100) + "m"}</td><td class="n">${signedPct(d.pct)}</td></tr>`).join("");
  parts.push(`<h3>${esc(t.deltaH)}</h3><table><thead><tr><th>${t.thNode}</th><th>${t.thFirst}</th><th>${t.thLast}</th><th>${t.thDelta}</th><th>%</th></tr></thead><tbody>${drows}</tbody></table>`);
  const keyList = (ks: string[]) => (ks.length ? `<ul>${ks.map((k) => `<li><code>${esc(k.replace(/\|/g, " · ").replace(/( · )+$/, ""))}</code></li>`).join("")}</ul>` : `<p class="muted">${esc(t.none)}</p>`);
  parts.push(`<div class="grid2"><div><h3>${esc(t.newH)}</h3>${keyList(g.newFindings)}</div><div><h3>${esc(t.resolvedH)}</h3>${keyList(g.resolvedFindings)}</div></div></section>`);
  return parts.join("");
}

/** Plain-text trend for `gdl inspect a.json b.json ...`. */
export function formatTrend(trend: Trend): string {
  const out: string[] = [];
  for (const g of trend.groups) {
    out.push(`${g.project} · policy ${g.policy} · ${g.mode} · limit ${fmtMin(g.maxMinutes)}`);
    g.entries.forEach((e, i) => out.push(`  ${String(i + 1).padStart(2)}. ${e.generatedAt}  ${e.modelSha256.slice(0, 10)}${e.modelChanged ? "*" : " "}  runs ${e.runs}  completed ${pct(e.completionRate)}  median ${fmtMin(e.medianMinutes)}  findings ${e.findings.critical}/${e.findings.warning}/${e.findings.info}  ${e.file}`));
    if (g.entries.some((e) => e.modelChanged)) out.push("  (* = model changed since the previous report)");
    if (g.entries.length > 1) {
      out.push("  first -> last median arrival:");
      for (const d of g.nodeDeltas) out.push(`    ${d.id.padEnd(24)} ${d.first === null ? "-" : fmtMin(d.first)} -> ${d.last === null ? "-" : fmtMin(d.last)}  ${d.delta === null ? "" : signedPct(d.pct)}`);
      if (g.newFindings.length) out.push(`  new findings: ${g.newFindings.join(", ")}`);
      if (g.resolvedFindings.length) out.push(`  resolved findings: ${g.resolvedFindings.join(", ")}`);
    }
    out.push("");
  }
  for (const s of trend.skipped) out.push(`skipped ${s.file}: ${s.reason}`);
  return out.join("\n") + "\n";
}