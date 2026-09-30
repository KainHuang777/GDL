import type { AnyReport, CompareReport } from "../index.js";
import type { SimulationResult } from "../core/runner.js";
import type { ValidationIssue } from "../schema/validate.js";
import { fmtDeltaMin, type EconomyRow, type Finding, type FlowShare, type Insights, type PacingView, type ScenarioView } from "../insights/insights.js";
import { fmtMin, num, pct, signedPct } from "./units.js";

/**
 * Self-contained static dashboard (docs/dashboard-design.md §6).
 * No JavaScript, no external assets: inline CSS + server-rendered SVG.
 * The source report is embedded as JSON in <script type="application/json" id="gdl-report">.
 * UI strings are localised via `lang` ("en" | "zh-TW"); data-derived text stays as-is.
 */
export type HtmlLang = "en" | "zh-TW";

interface U {
  titleKind: Record<string, string>;
  navFindings: string;
  navPacing: string;
  navEconomy: string;
  navScenarios: string;
  navValidation: string;
  badgeValid: string;
  badgeInvalid: string;
  kAdapter: string;
  kModel: string;
  kSources: string;
  kRun: string;
  kPolicy: string;
  kGenerated: string;
  implicit: string;
  adaptivePolicy: (actions: string, lookahead: string, temperature: string) => string;
  findingsH: (critical: string, warning: string, info: string) => string;
  noFindings: string;
  pacingH: string;
  arrivalH: string;
  arrivalHint: string;
  expectedValue: string;
  segmentH: string;
  segmentHint: string;
  runsEndedH: string;
  stopsH: string;
  stopTimeout: string;
  thNext: string;
  thRuns: string;
  thBlockedBy: string;
  thLimiting: string;
  thGap: string;
  thNetPerHour: string;
  thEta: string;
  doesNotClose: string;
  noLimits: string;
  notReached: string;
  economyH: string;
  meansPerRun: string;
  thResource: string;
  thProduced: string;
  thConsumed: string;
  thFinal: string;
  thOverflow: string;
  flowsH: string;
  flowIn: string;
  flowOut: string;
  none: string;
  actionUsageH: string;
  meanUsesPerRun: string;
  scenarioH: string;
  scenarioHint: string;
  valuesChanged: (n: string) => string;
  thOp: string;
  thPath: string;
  thBefore: string;
  thAfter: string;
  scenarioInvalid: string;
  completionRate: string;
  medianArrivalH: string;
  thNodeImpact: string;
  thMedian: string;
  thReach: string;
  thResImpact: string;
  thBaselineFinal: string;
  thScenarioFinal: string;
  thChange: string;
  noChange: string;
  navPolicy: string;
  policyH: string;
  policyHint: string;
  thAction: string;
  thMade: string;
  thUnused: string;
  thWasted: string;
  waitH: string;
  waitHint: string;
  thNode: string;
  caveatNote: string;
  resNotComparable: string;
  limiterShiftH: string;
  validationH: (errors: string, warnings: string) => string;
  validationOk: string;
  thCode: string;
  thMessage: string;
  thSource: string;
  notModelledH: string;
  footer: (version: string) => string;
  chartRangeTitle: (a: string, b: string) => string;
  chartMedianTitle: (m: string) => string;
  chartBaselineTitle: (m: string) => string;
  chartScenarioTitle: (m: string) => string;
  dumbbellLegend: string;
}

const EN: U = {
  titleKind: { validate: "validate", analyze: "analyze", simulate: "simulate", compare: "compare" },
  navFindings: "Findings",
  navPacing: "Pacing",
  navEconomy: "Economy",
  navScenarios: "Scenarios",
  navValidation: "Validation",
  badgeValid: "valid",
  badgeInvalid: "INVALID",
  kAdapter: "adapter",
  kModel: "model",
  kSources: "sources",
  kRun: "run",
  kPolicy: "policy",
  kGenerated: "generated",
  implicit: "implicit",
  adaptivePolicy: (actions, lookahead, temperature) => `adaptive: ${actions} (lookahead ${lookahead} min, temperature ${temperature})`,
  findingsH: (critical, warning, info) => `Findings <small>${critical} critical · ${warning} warning · ${info} info</small>`,
  noFindings: "No findings.",
  pacingH: "Pacing &amp; bottlenecks",
  arrivalH: "Arrival time per node",
  arrivalHint: "bar = p10–p90, dot = median",
  expectedValue: "expected value",
  segmentH: "Segment length",
  segmentHint: "median time since previous node",
  runsEndedH: "How runs ended",
  stopsH: "Where progress stopped",
  stopTimeout: "ran out of time/actions",
  thNext: "next node",
  thRuns: "runs",
  thBlockedBy: "blocked by",
  thLimiting: "limiting resource",
  thGap: "gap",
  thNetPerHour: "net/h",
  thEta: "est. more play",
  doesNotClose: "does not close",
  noLimits: "-",
  notReached: "not reached",
  economyH: "Resource economy",
  meansPerRun: "means per run",
  thResource: "resource",
  thProduced: "produced",
  thConsumed: "consumed",
  thFinal: "final (median)",
  thOverflow: "overflow",
  flowsH: "Where each resource comes from and goes to",
  flowIn: "in",
  flowOut: "out",
  none: "none",
  actionUsageH: "Action usage",
  meanUsesPerRun: "mean uses per run",
  scenarioH: "Scenario comparison",
  scenarioHint: "same seed as baseline (common random numbers)",
  valuesChanged: (n) => `${n} value(s) changed`,
  thOp: "op",
  thPath: "path",
  thBefore: "before",
  thAfter: "after",
  scenarioInvalid: "Scenario model is invalid; not simulated.",
  completionRate: "Completion rate",
  medianArrivalH: "Median arrival: baseline vs scenario",
  thNodeImpact: "node (by impact)",
  thMedian: "median time",
  thReach: "reach rate",
  thResImpact: "resource (by impact)",
  thBaselineFinal: "baseline final",
  thScenarioFinal: "scenario final",
  thChange: "change",
  noChange: "No measurable change.",
  navPolicy: "Policy",
  policyH: "Strategy waste",
  policyHint: "crafted goods made but never used (a policy effect, not a game bottleneck)",
  thAction: "action",
  thMade: "made / run",
  thUnused: "unused",
  thWasted: "wasted inputs",
  waitH: "Where the waiting goes",
  waitHint: "share of each node's waiting time by limiting resource",
  thNode: "node",
  caveatNote: "Numbers may be unreliable; not modelled:",
  resNotComparable: "The two runs ended at different times, so final resource amounts are not compared.",
  limiterShiftH: "Limiting resource changes",
  validationH: (errors, warnings) => `Validation <small>${errors} error(s) · ${warnings} warning(s)</small>`,
  validationOk: "Model passed schema and reference checks.",
  thCode: "code",
  thMessage: "message",
  thSource: "source / hint",
  notModelledH: "Not modelled — results do not cover these (declared by adapter)",
  footer: (version) => `Generated by GDL ${version}. Findings are deterministic rules (docs/dashboard-design.md §5), not recommendations.`,
  chartRangeTitle: (a, b) => `p10 ${a} – p90 ${b}`,
  chartMedianTitle: (m) => `median ${m}`,
  chartBaselineTitle: (m) => `baseline ${m}`,
  chartScenarioTitle: (m) => `scenario ${m}`,
  dumbbellLegend: "● grey = baseline   ● blue = scenario",
};

const ZH: U = {
  titleKind: { validate: "驗證", analyze: "分析", simulate: "模擬", compare: "情境比較" },
  navFindings: "發現",
  navPacing: "進度與瓶頸",
  navEconomy: "資源經濟",
  navScenarios: "情境比較",
  navValidation: "驗證",
  badgeValid: "有效",
  badgeInvalid: "無效",
  kAdapter: "介接器",
  kModel: "模型",
  kSources: "來源",
  kRun: "執行",
  kPolicy: "策略",
  kGenerated: "產生時間",
  implicit: "隱含",
  adaptivePolicy: (actions, lookahead, temperature) => `自適應：${actions}（前瞻 ${lookahead} 分，temperature ${temperature}）`,
  findingsH: (critical, warning, info) => `發現 <small>${critical} 重大 · ${warning} 警告 · ${info} 資訊</small>`,
  noFindings: "沒有發現任何問題。",
  pacingH: "進度與瓶頸",
  arrivalH: "各節點到達時間",
  arrivalHint: "條 = p10–p90，點 = 中位數",
  expectedValue: "期望值",
  segmentH: "分段耗時",
  segmentHint: "距上一節點的中位數時間",
  runsEndedH: "執行結束原因",
  stopsH: "進度卡住位置",
  stopTimeout: "時間/動作次數耗盡",
  thNext: "下一節點",
  thRuns: "次數",
  thBlockedBy: "受阻原因",
  thLimiting: "瓶頸資源",
  thGap: "缺口",
  thNetPerHour: "淨收入/時",
  thEta: "預估再玩多久",
  doesNotClose: "無法補齊",
  noLimits: "-",
  notReached: "未到達",
  economyH: "資源經濟",
  meansPerRun: "每次執行平均",
  thResource: "資源",
  thProduced: "產出",
  thConsumed: "消耗",
  thFinal: "最終（中位數）",
  thOverflow: "溢出",
  flowsH: "各資源的來源與去向",
  flowIn: "入",
  flowOut: "出",
  none: "無",
  actionUsageH: "動作使用次數",
  meanUsesPerRun: "每次執行平均使用次數",
  scenarioH: "情境比較",
  scenarioHint: "與基線同 seed（共同亂數）",
  valuesChanged: (n) => `共 ${n} 項數值被修改`,
  thOp: "操作",
  thPath: "路徑",
  thBefore: "修改前",
  thAfter: "修改後",
  scenarioInvalid: "情境模型無效，未執行模擬。",
  completionRate: "完成率",
  medianArrivalH: "中位數到達時間：基線 vs 情境",
  thNodeImpact: "節點（依影響排序）",
  thMedian: "中位數時間",
  thReach: "到達率",
  thResImpact: "資源（依影響排序）",
  thBaselineFinal: "基線最終",
  thScenarioFinal: "情境最終",
  thChange: "變化",
  noChange: "無可量測的變化。",
  navPolicy: "策略",
  policyH: "策略浪費",
  policyHint: "製作後從未使用的成品（屬於策略效應，而非遊戲瓶頸）",
  thAction: "動作",
  thMade: "每場製作",
  thUnused: "未使用",
  thWasted: "浪費的投入",
  waitH: "等待都花在哪",
  waitHint: "各節點等待時間依限制資源的占比",
  thNode: "節點",
  caveatNote: "數值可能不可靠，未建模：",
  resNotComparable: "兩次執行結束時間不同，因此不比較期末資源。",
  limiterShiftH: "限制資源改變",
  validationH: (errors, warnings) => `驗證 <small>${errors} 個錯誤 · ${warnings} 個警告</small>`,
  validationOk: "模型通過結構與參照檢查。",
  thCode: "代碼",
  thMessage: "訊息",
  thSource: "來源 / 提示",
  notModelledH: "未模擬項目 — 結果不涵蓋下列內容（由介接器宣告）",
  footer: (version) => `由 GDL ${version} 產生。發現為確定性規則（docs/dashboard-design.md §5），非建議。`,
  chartRangeTitle: (a, b) => `p10 ${a} – p90 ${b}`,
  chartMedianTitle: (m) => `中位數 ${m}`,
  chartBaselineTitle: (m) => `基線 ${m}`,
  chartScenarioTitle: (m) => `情境 ${m}`,
  dumbbellLegend: "● 灰 = 基線   ● 藍 = 情境",
};

export function renderHtml(report: AnyReport, ins: Insights, opts?: { lang?: HtmlLang }): string {
  const t = opts?.lang === "zh-TW" ? ZH : EN;
  const p = report.provenance;
  const sim = primarySim(report);
  const sections: string[] = [];
  const nav: [string, string][] = [["findings", t.navFindings]];

  sections.push(findingsSection(t, ins.findings));
  if (ins.pacing && sim) {
    nav.push(["pacing", t.navPacing]);
    sections.push(pacingSection(t, ins.pacing, sim));
  }
  if (ins.waste?.length) {
    nav.push(["policy", t.navPolicy]);
    sections.push(policySection(t, ins.waste));
  }
  if (ins.economy && sim) {
    nav.push(["economy", t.navEconomy]);
    sections.push(economySection(t, ins.economy, ins.actionUsage ?? []));
  }
  if (report.kind === "compare" && ins.scenarios) {
    nav.push(["scenarios", t.navScenarios]);
    sections.push(scenarioSection(t, report, ins.scenarios));
  }
  nav.push(["validation", t.navValidation]);
  sections.push(validationSection(t, report));

  const title = `GDL ${t.titleKind[report.kind] ?? report.kind} — ${p.project.id}`;
  return `<!doctype html>
<html lang="${opts?.lang === "zh-TW" ? "zh-Hant" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="GDL ${esc(p.gdlVersion)}">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="title"><h1>${esc(p.project.id)}</h1><span class="kind">${esc(t.titleKind[report.kind] ?? report.kind)}</span>${badge(report.validation.ok ? "ok" : "critical", report.validation.ok ? t.badgeValid : t.badgeInvalid)}</div>
  <dl class="prov">
    ${dt(t.kAdapter, `${p.adapter.id}@${p.adapter.version} (api ${p.adapter.apiVersion})`)}
    ${dt(t.kModel, p.modelSha256.slice(0, 16) + "…", p.modelSha256)}
    ${dt(t.kSources, p.sources.map((s) => s.path).join(", ") || "-")}
    ${sim ? dt(t.kRun, `${sim.mode}${sim.seed !== null ? ` · ${sim.runs} runs · seed ${sim.seed}` : ""} · limit ${fmtMin(sim.limits.maxMinutes)} / ${sim.limits.maxActions} actions`) : ""}
    ${sim ? dt(t.kPolicy, `${sim.policy.id}${sim.policy.implicit ? ` (${t.implicit})` : ""}`, sim.policy.adaptive ? t.adaptivePolicy(sim.policy.actions.join(", "), fmtMin(sim.policy.adaptive.lookaheadMinutes), String(sim.policy.adaptive.temperature)) : sim.policy.actions.join(" > ")) : ""}
    ${dt(t.kGenerated, `${p.generatedAt} · GDL ${p.gdlVersion} · report ${p.reportVersion}`)}
  </dl>
  <nav>${nav.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
</header>
<main>
${sections.join("\n")}
</main>
<footer>
${report.unsupported.length ? `<h3>${esc(t.notModelledH)}</h3><ul>${report.unsupported.map((u) => `<li><b>${esc(u.feature)}</b>: ${esc(u.reason)}</li>`).join("")}</ul>` : ""}
<p class="muted">${esc(t.footer(p.gdlVersion))}</p>
</footer>
<script type="application/json" id="gdl-report">${embedJson(report)}</script>
</body>
</html>
`;
}

function primarySim(r: AnyReport): SimulationResult | undefined {
  if (r.kind === "compare") return r.baseline;
  if (r.kind === "validate") return undefined;
  return r.simulation;
}

// ---------------------------------------------------------------- sections

function findingsSection(t: U, fs: Finding[]): string {
  const c = { critical: 0, warning: 0, info: 0 };
  for (const f of fs) c[f.severity]++;
  const cards = fs.length
    ? fs.map((f) => `<div class="card ${f.severity}"><div class="card-h">${badge(f.severity, f.severity)}<span class="cat">${esc(f.category)}</span><span class="scope">${esc(f.scope)}</span></div><div class="card-t">${esc(f.title)}</div><div class="card-d">${esc(f.detail)}</div>${f.caveats?.length ? `<div class="card-c">${esc(t.caveatNote)} ${esc(f.caveats.join(", "))}</div>` : ""}</div>`).join("")
    : `<p class="muted">${esc(t.noFindings)}</p>`;
  return `<section id="findings"><h2>${t.findingsH(String(c.critical), String(c.warning), String(c.info))}</h2><div class="cards">${cards}</div></section>`;
}

function pacingSection(t: U, p: PacingView, s: SimulationResult): string {
  const parts: string[] = [`<section id="pacing"><h2>${t.pacingH}</h2>`];
  parts.push(`<div class="grid2"><div><h3>${esc(t.arrivalH)} <small>${esc(s.mode === "monte-carlo" ? t.arrivalHint : t.expectedValue)}</small></h3>${rangeChart(t, p)}</div>`);
  parts.push(`<div><h3>${esc(t.segmentH)} <small>${esc(t.segmentHint)}</small></h3>${segmentChart(t, p)}</div></div>`);
  const waits = p.nodes.filter((n) => n.limiters.length && p.segments.some((sg) => sg.to === n.id));
  if (waits.length) {
    parts.push(`<h3>${esc(t.waitH)} <small>${esc(t.waitHint)}</small></h3><div class="flows">`);
    for (const n of waits) parts.push(`<div class="flow"><h4>${esc(n.id)}</h4>${stackBar(t, n.limiters.map((l) => ({ key: l.resource, share: l.share, mean: l.minutes })))}</div>`);
    parts.push(`</div>`);
  }
  parts.push(`<h3>${esc(t.runsEndedH)}</h3>${stackBar(t, p.stops.map((x) => ({ key: x.reason, share: x.share, mean: x.share })), STOP_COLORS)}`);
  if (p.stalls.length) {
    parts.push(`<h3>${esc(t.stopsH)}</h3><table><thead><tr><th>${t.thNext}</th><th>${t.thRuns}</th><th>${t.thBlockedBy}</th><th>${t.thLimiting}</th><th>${t.thGap}</th><th>${t.thNetPerHour}</th><th>${t.thEta}</th></tr></thead><tbody>`);
    for (const st of p.stalls) {
      const lims = st.limits.length ? st.limits : [null];
      lims.forEach((l, i) => {
        parts.push(`<tr>${i === 0 ? `<td rowspan="${lims.length}">${esc(st.node)}</td><td rowspan="${lims.length}" class="n">${pct(st.share)}</td><td rowspan="${lims.length}">${esc(st.reasons.join("; ") || t.stopTimeout)}</td>` : ""}` +
          (l ? `<td>${esc(l.resource)}</td><td class="n">${num(l.gap)}</td><td class="n">${num(l.netPerHour)}</td><td class="n ${l.etaMinutes === null ? "bad" : ""}">${l.etaMinutes === null ? t.doesNotClose : "~" + fmtMin(l.etaMinutes)}</td>` : `<td colspan="4" class="muted">${t.noLimits}</td>`) + `</tr>`);
      });
    }
    parts.push(`</tbody></table>`);
  }
  parts.push(`</section>`);
  return parts.join("");
}

function policySection(t: U, waste: NonNullable<Insights["waste"]>): string {
  const rows = waste.map((w) => `<tr><td>${esc(w.actionName ?? w.action)}</td><td>${esc(w.resourceName ?? w.resource)}</td><td class="n">${num(w.made)}</td><td class="n ${w.unusedShare >= 0.2 ? "warn" : ""}">${num(w.unused)} (${pct(w.unusedShare)})</td><td>${esc(w.wastedCosts.filter((c) => c.amount > 0).map((c) => `${c.name ?? c.resource} ${num(c.amount)} (${pct(c.shareOfConsumed)})`).join(", "))}</td></tr>`).join("");
  return `<section id="policy"><h2>${esc(t.policyH)} <small>${esc(t.policyHint)}</small></h2><table><thead><tr><th>${t.thAction}</th><th>${t.thResource}</th><th>${t.thMade}</th><th>${t.thUnused}</th><th>${t.thWasted}</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function economySection(t: U, rows: EconomyRow[], usage: { id: string; mean: number }[]): string {
  const parts: string[] = [`<section id="economy"><h2>${t.economyH} <small>${esc(t.meansPerRun)}</small></h2>`];
  parts.push(`<table><thead><tr><th>${t.thResource}</th><th>${t.thProduced}</th><th>${t.thConsumed}</th><th>${t.thFinal}</th><th>${t.thNetPerHour}</th><th>${t.thOverflow}</th></tr></thead><tbody>`);
  for (const r of rows) {
    parts.push(`<tr><td>${esc(r.id)}</td><td class="n">${num(r.produced)}</td><td class="n">${num(r.consumed)}</td><td class="n">${num(r.finalMedian)}</td><td class="n ${r.netPerHour < 0 ? "bad" : ""}">${num(r.netPerHour)}</td><td class="n ${r.overflow > 0 ? "warn" : ""}">${r.overflow > 0 ? `${num(r.overflow)} (${pct(r.overflowShare)})` : "-"}</td></tr>`);
  }
  parts.push(`</tbody></table><h3>${esc(t.flowsH)}</h3><div class="flows">`);
  for (const r of rows) {
    parts.push(`<div class="flow"><h4>${esc(r.id)}</h4><div class="flow-row"><span class="lbl">${t.flowIn}</span>${r.sources.length ? stackBar(t, r.sources) : `<span class="muted">${t.none}</span>`}</div><div class="flow-row"><span class="lbl">${t.flowOut}</span>${r.sinks.length ? stackBar(t, r.sinks) : `<span class="muted">${t.none}</span>`}</div></div>`);
  }
  parts.push(`</div>`);
  if (usage.length) parts.push(`<h3>${esc(t.actionUsageH)} <small>${esc(t.meanUsesPerRun)}</small></h3>${hbar(usage.map((u) => ({ label: u.id, value: u.mean, text: num(u.mean), cls: u.mean === 0 ? "zero" : "" })))}`);
  parts.push(`</section>`);
  return parts.join("");
}

function scenarioSection(t: U, r: CompareReport, views: ScenarioView[]): string {
  const parts: string[] = [`<section id="scenarios"><h2>${t.scenarioH} <small>${esc(t.scenarioHint)}</small></h2>`];
  for (const v of views) {
    const sc = r.scenarios.find((x) => x.id === v.id)!;
    parts.push(`<div class="scenario"><h3>${esc(v.id)}${v.description ? ` <small>${esc(v.description)}</small>` : ""}</h3>`);
    parts.push(`<details><summary>${esc(t.valuesChanged(String(v.changes)))}</summary><table><thead><tr><th>${t.thOp}</th><th>${t.thPath}</th><th>${t.thBefore}</th><th>${t.thAfter}</th></tr></thead><tbody>${sc.applied.flatMap((a) => a.matches.map((m) => `<tr><td>${esc(a.op)}</td><td><code>${esc(m.path)}</code></td><td class="n">${esc(JSON.stringify(m.before))}</td><td class="n">${esc(JSON.stringify(m.after))}</td></tr>`)).join("")}</tbody></table></details>`);
    if (!v.valid) {
      parts.push(`<p class="bad">${esc(t.scenarioInvalid)}</p>${issues(t, sc.validation.errors)}</div>`);
      continue;
    }
    const cr = v.completionRate!;
    parts.push(`<p>${esc(t.completionRate)} <b>${pct(cr.baseline ?? 0)}</b> → <b class="${(cr.delta ?? 0) < 0 ? "bad" : (cr.delta ?? 0) > 0 ? "good" : ""}">${pct(cr.scenario ?? 0)}</b></p>`);
    if (sc.simulation && r.baseline) parts.push(`<h4>${esc(t.medianArrivalH)}</h4>${dumbbell(t, r.baseline, sc.simulation)}`);
    if (v.nodeImpact.length) {
      parts.push(`<table><thead><tr><th>${t.thNodeImpact}</th><th>${t.thMedian}</th><th>${t.thReach}</th></tr></thead><tbody>`);
      for (const n of v.nodeImpact) {
        const d = n.medianMinute.delta;
        const cls = n.medianMinute.baseline !== null && n.medianMinute.scenario === null ? "bad" : d === null ? "" : d < 0 ? "good" : d > 0 ? "bad" : "";
        const rc = n.reachRate.delta ? `${pct(n.reachRate.baseline ?? 0)} → ${pct(n.reachRate.scenario ?? 0)}` : `${pct(n.reachRate.baseline ?? 0)} (=)`;
        parts.push(`<tr><td>${esc(n.id)}</td><td class="${cls}">${esc(fmtDeltaMin(n.medianMinute))}</td><td class="${(n.reachRate.delta ?? 0) < 0 ? "bad" : (n.reachRate.delta ?? 0) > 0 ? "good" : ""}">${rc}</td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
    if (!v.resourcesComparable) parts.push(`<p class="muted">${esc(t.resNotComparable)}</p>`);
    if (v.limiterShifts.length) parts.push(`<h4>${esc(t.limiterShiftH)}</h4><ul>${v.limiterShifts.map((x) => `<li>${esc(x.node)}: ${esc(x.from)} → ${esc(x.to)}</li>`).join("")}</ul>`);
    if (v.resourceImpact.length) {
      parts.push(`<table><thead><tr><th>${t.thResImpact}</th><th>${t.thBaselineFinal}</th><th>${t.thScenarioFinal}</th><th>${t.thChange}</th></tr></thead><tbody>`);
      for (const x of v.resourceImpact) parts.push(`<tr><td>${esc(x.id)}</td><td class="n">${num(x.delta.baseline ?? 0)}</td><td class="n">${num(x.delta.scenario ?? 0)}</td><td class="n">${signedPct(x.delta.pct)}</td></tr>`);
      parts.push(`</tbody></table>`);
    }
    if (!v.nodeImpact.length && !v.resourceImpact.length && !v.limiterShifts.length) parts.push(`<p class="warn">${esc(t.noChange)}</p>`);
    parts.push(`</div>`);
  }
  parts.push(`</section>`);
  return parts.join("");
}

function validationSection(t: U, r: AnyReport): string {
  const v = r.validation;
  return `<section id="validation"><h2>${t.validationH(String(v.errors.length), String(v.warnings.length))}</h2>${v.errors.length + v.warnings.length ? issues(t, [...v.errors, ...v.warnings]) : `<p class="good">${esc(t.validationOk)}</p>`}</section>`;
}

function issues(t: U, list: ValidationIssue[]): string {
  return `<table><thead><tr><th></th><th>${t.thCode}</th><th>${t.thPath}</th><th>${t.thMessage}</th><th>${t.thSource}</th></tr></thead><tbody>${list
    .map((i) => `<tr><td>${badge(i.severity === "error" ? "critical" : "warning", i.severity)}</td><td><code>${esc(i.code)}</code></td><td><code>${esc(i.path)}</code></td><td>${esc(i.message)}</td><td>${i.source ? esc(i.source.file + (i.source.path ? ` (${i.source.path})` : "")) : ""}${i.hint ? `<div class="muted">${esc(i.hint)}</div>` : ""}</td></tr>`)
    .join("")}</tbody></table>`;
}

// ---------------------------------------------------------------- charts (inline SVG)

const PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
const STOP_COLORS: Record<string, string> = { completed: "#59a14f", time_limit: "#4e79a7", action_limit: "#edc948", stuck: "#e15759" };
const LABEL_W = 170;
const CHART_W = 640;

function rangeChart(t: U, p: PacingView): string {
  const rowH = 24;
  const max = Math.max(1, ...p.nodes.map((n) => n.p90 ?? n.median ?? 0));
  const plotW = CHART_W - LABEL_W - 110;
  const x = (m: number) => LABEL_W + (m / max) * plotW;
  const h = p.nodes.length * rowH + 24;
  const rows = p.nodes.map((n, i) => {
    const y = i * rowH + 16;
    const label = `<text x="${LABEL_W - 8}" y="${y + 4}" text-anchor="end">${esc(n.id)}</text>`;
    if (n.median === null) return `${label}<text x="${LABEL_W}" y="${y + 4}" class="muted">${t.notReached}</text>`;
    const range = n.p10 !== null && n.p90 !== null && n.p90 > n.p10 ? `<rect x="${x(n.p10)}" y="${y - 5}" width="${Math.max(1, x(n.p90) - x(n.p10))}" height="10" rx="3" fill="#4e79a7" opacity="0.35"><title>${esc(t.chartRangeTitle(fmtMin(n.p10), fmtMin(n.p90)))}</title></rect>` : "";
    const reach = n.reachRate < 1 ? ` · ${pct(n.reachRate)}` : "";
    return `${label}<line x1="${LABEL_W}" x2="${LABEL_W + plotW}" y1="${y}" y2="${y}" class="grid"/>${range}<circle cx="${x(n.median)}" cy="${y}" r="4.5" fill="#4e79a7"><title>${esc(t.chartMedianTitle(fmtMin(n.median)))}</title></circle><text x="${LABEL_W + plotW + 8}" y="${y + 4}">${fmtMin(n.median)}${reach}</text>`;
  });
  const axis = `<text x="${LABEL_W}" y="${h - 4}" class="muted">0</text><text x="${LABEL_W + plotW}" y="${h - 4}" text-anchor="end" class="muted">${fmtMin(max)}</text>`;
  return svg(CHART_W, h, rows.join("") + axis);
}

function segmentChart(t: U, p: PacingView): string {
  if (!p.segments.length) return `<p class="muted">${t.notReached}</p>`;
  return hbar(p.segments.map((s) => ({ label: `→ ${s.to}`, value: s.medianMinutes, text: `${fmtMin(s.medianMinutes)}${s.share ? ` (${pct(s.share)})` : ""}`, cls: s === p.slowest ? "hot" : "" })));
}

function hbar(items: { label: string; value: number; text: string; cls?: string }[]): string {
  const rowH = 22;
  const max = Math.max(1e-9, ...items.map((i) => i.value));
  const plotW = CHART_W - LABEL_W - 120;
  const body = items.map((it, i) => {
    const y = i * rowH + 4;
    const w = it.value > 0 ? Math.max(2, (it.value / max) * plotW) : 0;
    return `<text x="${LABEL_W - 8}" y="${y + 13}" text-anchor="end">${esc(it.label)}</text><rect x="${LABEL_W}" y="${y + 3}" width="${w}" height="14" rx="2" class="bar ${it.cls ?? ""}"/><text x="${LABEL_W + w + 6}" y="${y + 14}" class="${it.value === 0 ? "muted" : ""}">${esc(it.text)}</text>`;
  });
  return svg(CHART_W, items.length * rowH + 8, body.join(""));
}

function stackBar(t: U, parts: FlowShare[], colors?: Record<string, string>): string {
  const w = 460;
  const total = parts.reduce((a, b) => a + b.share, 0) || 1;
  let x = 0;
  const rects: string[] = [];
  const legend: string[] = [];
  parts.forEach((p, i) => {
    const c = colors?.[p.key] ?? PALETTE[i % PALETTE.length]!;
    const pw = (p.share / total) * w;
    rects.push(`<rect x="${x}" y="0" width="${pw}" height="16" fill="${c}"><title>${esc(p.key)}: ${pct(p.share)} (${num(p.mean)})</title></rect>`);
    x += pw;
    legend.push(`<span class="lg"><i style="background:${c}"></i>${esc(p.key)} ${pct(p.share)}</span>`);
  });
  return `<div class="stack">${svg(w, 16, rects.join(""))}<div class="legend">${legend.join("")}</div></div>`;
}

function dumbbell(t: U, a: SimulationResult, b: SimulationResult): string {
  const rowH = 24;
  const nodes = a.nodes.map((n) => ({ id: n.id, a: n.minute?.median ?? null, b: b.nodes.find((x) => x.id === n.id)?.minute?.median ?? null }));
  const max = Math.max(1, ...nodes.flatMap((n) => [n.a ?? 0, n.b ?? 0]));
  const plotW = CHART_W - LABEL_W - 150;
  const x = (m: number) => LABEL_W + (m / max) * plotW;
  const body = nodes.map((n, i) => {
    const y = i * rowH + 16;
    let s = `<text x="${LABEL_W - 8}" y="${y + 4}" text-anchor="end">${esc(n.id)}</text><line x1="${LABEL_W}" x2="${LABEL_W + plotW}" y1="${y}" y2="${y}" class="grid"/>`;
    if (n.a !== null && n.b !== null) {
      const cls = n.b < n.a ? "good" : n.b > n.a ? "bad" : "";
      s += `<line x1="${x(n.a)}" x2="${x(n.b)}" y1="${y}" y2="${y}" class="db ${cls}"/>`;
    }
    if (n.a !== null) s += `<circle cx="${x(n.a)}" cy="${y}" r="4.5" fill="#999"><title>${esc(t.chartBaselineTitle(fmtMin(n.a)))}</title></circle>`;
    if (n.b !== null) s += `<circle cx="${x(n.b)}" cy="${y}" r="4.5" fill="#4e79a7"><title>${esc(t.chartScenarioTitle(fmtMin(n.b)))}</title></circle>`;
    const txt = n.a === null && n.b === null ? t.notReached : `${n.a === null ? "-" : fmtMin(n.a)} → ${n.b === null ? "-" : fmtMin(n.b)}`;
    return s + `<text x="${LABEL_W + plotW + 8}" y="${y + 4}" class="${n.a === null && n.b === null ? "muted" : ""}">${txt}</text>`;
  });
  const legend = `<text x="${LABEL_W}" y="${nodes.length * rowH + 20}" class="muted">${esc(t.dumbbellLegend)}</text>`;
  return svg(CHART_W, nodes.length * rowH + 28, body.join("") + legend);
}

function svg(w: number, h: number, body: string): string {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// ---------------------------------------------------------------- helpers

function badge(kind: string, text: string): string {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function dt(k: string, v: string, title?: string): string {
  return `<div><dt>${esc(k)}</dt><dd${title ? ` title="${esc(title)}"` : ""}>${esc(v)}</dd></div>`;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** JSON safe to place inside a <script> element. */
function embedJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const CSS = `
:root{--fg:#1f2328;--muted:#6e7781;--line:#d0d7de;--bg:#fff;--soft:#f6f8fa;--crit:#cf222e;--warn:#bc4c00;--info:#57606a;--good:#1a7f37;--accent:#4e79a7}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"Segoe UI","Noto Sans TC","Microsoft JhengHei",Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
header{padding:20px 32px 0;border-bottom:1px solid var(--line);background:var(--soft)}
.title{display:flex;align-items:center;gap:12px}h1{margin:0;font-size:22px}.kind{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.prov{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:4px 24px;margin:12px 0}.prov div{display:flex;gap:8px;min-width:0}
.prov dt{color:var(--muted);min-width:64px}.prov dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav{display:flex;gap:4px;position:sticky;top:0}nav a{padding:8px 14px;color:var(--fg);text-decoration:none;border-bottom:2px solid transparent}nav a:hover{border-color:var(--accent)}
main{padding:0 32px;max-width:1400px}section{padding:12px 0 24px;border-bottom:1px solid var(--line)}
h2{font-size:18px;margin:16px 0 8px}h3{font-size:15px;margin:18px 0 6px}h4{font-size:14px;margin:12px 0 4px}small{font-weight:normal;color:var(--muted);font-size:12px;margin-left:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px}
.card{border:1px solid var(--line);border-left:4px solid var(--info);border-radius:6px;padding:10px 12px;background:var(--bg)}
.card.critical{border-left-color:var(--crit)}.card.warning{border-left-color:var(--warn)}
.card-c{margin-top:4px;font-size:12px;color:var(--warn)}
.card-h{display:flex;gap:8px;align-items:center;font-size:12px}.cat{font-weight:600}.scope{color:var(--muted);margin-left:auto}
.card-t{font-weight:600;margin:4px 0 2px}.card-d{color:var(--muted);font-size:13px}
.badge{display:inline-block;padding:0 8px;border-radius:10px;font-size:12px;color:#fff;background:var(--info)}.badge.critical{background:var(--crit)}.badge.warning{background:var(--warn)}.badge.ok{background:var(--good)}
table{border-collapse:collapse;margin:6px 0 10px;font-size:13px}th,td{border:1px solid var(--line);padding:4px 10px;text-align:left;vertical-align:top}th{background:var(--soft);font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}.bad{color:var(--crit)}.good{color:var(--good)}.warn{color:var(--warn)}.muted{color:var(--muted);fill:var(--muted)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:16px}
.chart{max-width:100%;height:auto;font-size:12px}.chart text{fill:var(--fg)}.chart text.muted{fill:var(--muted)}.chart .grid{stroke:var(--line);stroke-dasharray:2 3}
.bar{fill:var(--accent)}.bar.hot{fill:var(--crit)}.db{stroke:#999;stroke-width:3}.db.good{stroke:var(--good)}.db.bad{stroke:var(--crit)}
.flows{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:8px 24px}.flow h4{margin:8px 0 2px}.flow-row{display:flex;gap:8px;align-items:flex-start;margin:2px 0}.lbl{width:28px;color:var(--muted);font-size:12px;padding-top:1px}
.stack svg{display:block;border-radius:3px}.legend{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:12px;color:var(--muted);margin-top:2px}.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.scenario{border:1px solid var(--line);border-radius:6px;padding:4px 16px 8px;margin:10px 0}details summary{cursor:pointer;color:var(--muted)}code{font-size:12px}
footer{padding:12px 32px 32px}footer h3{font-size:14px}footer li{margin:2px 0}
@media print{nav{display:none}.card,.scenario{break-inside:avoid}}
`;