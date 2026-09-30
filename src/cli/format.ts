import type { AnalyzeReport, AnyReport, CompareReport, Delta, ReportBase } from "../index.js";
import type { SimulationResult } from "../core/runner.js";
import type { Summary } from "../core/stats.js";
import type { ValidationIssue } from "../schema/validate.js";
import type { Insights, InsightLang } from "../insights/insights.js";
import { fmtMin, num, pct } from "../report/units.js";

export { fmtMin };

export function formatText(r: AnyReport, insights?: Insights, lang: InsightLang = "en"): string {
  const out: string[] = [];
  header(r, out);
  validation(r, out);
  if (r.kind === "analyze") analyze(r, out);
  if (r.kind === "simulate" && r.simulation) simulation(r.simulation, out, "Simulation");
  if (r.kind === "compare") compare(r, out);
  unsupported(r, out);
  if (insights) findingsSummary(insights, lang, out);
  return out.join("\n") + "\n";
}

/** Short findings block appended to text reports: critical + warning only. */
function findingsSummary(ins: Insights, lang: InsightLang, out: string[]) {
  const important = ins.findings.filter((f) => f.severity !== "info");
  const infos = ins.findings.length - important.length;
  if (!ins.findings.length) return;
  out.push(lang === "zh-TW"
    ? `發現：${important.length} 個重要，${infos} 個資訊（完整清單：gdl inspect <report.json>）`
    : `Findings: ${important.length} important, ${infos} info  (full list: gdl inspect <report.json>)`);
  for (const f of important) out.push(`  ${f.severity === "critical" ? "CRIT" : "WARN"} [${f.category}] ${f.title}`);
  out.push("");
}

function header(r: ReportBase<string>, out: string[]) {
  const p = r.provenance;
  out.push(`GDL ${p.gdlVersion} | ${r.kind} | project ${p.project.id}`);
  out.push(`  adapter  ${p.adapter.id}@${p.adapter.version} (api ${p.adapter.apiVersion})`);
  out.push(`  model    sha256 ${p.modelSha256.slice(0, 16)}...  sources: ${p.sources.length} file(s)`);
  out.push("");
}

function validation(r: ReportBase<string>, out: string[]) {
  const v = r.validation;
  out.push(`Validation: ${v.ok ? "OK" : "FAILED"}  (${v.errors.length} error(s), ${v.warnings.length} warning(s))`);
  for (const i of v.errors) out.push(issue(i));
  for (const i of v.warnings) out.push(issue(i));
  out.push("");
}

function issue(i: ValidationIssue): string {
  const tag = i.severity === "error" ? "ERROR" : "WARN ";
  let s = `  ${tag} [${i.code}] ${i.path}: ${i.message}`;
  if (i.source) s += `\n         source: ${i.source.file}${i.source.path ? ` (${i.source.path})` : ""}`;
  if (i.hint) s += `\n         hint: ${i.hint}`;
  return s;
}

function analyze(r: AnalyzeReport, out: string[]) {
  if (!r.reachability || !r.simulation) return;
  out.push("Reachability (static, policy-independent; 'possibly' is an upper bound, not a guarantee)");
  for (const n of r.reachability.nodes) {
    out.push(`  node   ${pad(n.target, 22)} ${n.status === "unreachable" ? "UNREACHABLE" : "possibly reachable"}${n.reasons.length ? "  - " + n.reasons.join("; ") : ""}`);
  }
  for (const a of r.reachability.actions.filter((x) => x.status === "unreachable")) {
    out.push(`  action ${pad(a.target, 22)} UNREACHABLE  - ${a.reasons.join("; ")}`);
  }
  out.push("");
  simulation(r.simulation, out, "Expected-value simulation (deterministic; random outcomes counted at their mean)");
}

function simulation(s: SimulationResult, out: string[], title: string) {
  const mc = s.mode === "monte-carlo";
  out.push(`${title}`);
  out.push(`  policy ${s.policy.id}${s.policy.implicit ? " (implicit: declaration order)" : ""}: ${s.policy.actions.join(s.policy.type === "adaptive" ? ", " : " > ")}`);
  if (s.policy.adaptive) out.push(`    adaptive: objective ${s.policy.adaptive.objective}, temperature ${s.policy.adaptive.temperature}, lookahead ${s.policy.adaptive.lookaheadMinutes} min`);
  out.push(`  limits ${fmtMin(s.limits.maxMinutes)} / ${s.limits.maxActions} actions   mode ${s.mode}${mc ? `   runs ${s.runs}   seed ${s.seed}` : ""}`);
  out.push(`  stop   ${Object.entries(s.stopReasons).map(([k, v]) => `${k} ${mc ? pct(v! / s.runs) : ""}`.trim()).join(", ")}`);
  out.push(`  played ${mc ? sumStr(s.minutes, fmtMin) : fmtMin(s.minutes.median)}   waiting ${mc ? sumStr(s.minutesWaiting, fmtMin) : fmtMin(s.minutesWaiting.median)}`);
  out.push("");
  out.push("  Progression");
  out.push(`    ${pad("node", W)} ${pad("reached", 8)} ${pad(mc ? "time p10 / median / p90" : "time", 30)} ${"since prev (median)"}`);
  for (const n of s.nodes) {
    const time = !n.minute ? "-" : mc ? `${fmtMin(n.minute.p10)} / ${fmtMin(n.minute.median)} / ${fmtMin(n.minute.p90)}` : fmtMin(n.minute.median);
    const since = n.deltaMinute ? fmtMin(n.deltaMinute.median) : "-";
    out.push(`    ${pad(n.id, W)} ${pad(pct(n.reachRate), 8)} ${pad(time, 30)} ${since}`);
  }
  out.push("");
  out.push("  Resources (median final; produced/consumed are means per run)");
  for (const r of s.resources) {
    const src = r.topSources.slice(0, 3).map((x) => `${x.source} ${num(x.mean)}`).join(", ") || "-";
    const snk = r.topSinks.slice(0, 3).map((x) => `${x.sink} ${num(x.mean)}`).join(", ") || "-";
    out.push(`    ${pad(r.id, W)} final ${pad(num(r.final.median), 10)} net/h ${pad(num(r.netPerHour), 10)}${r.overflow.mean > 0 ? ` overflow ${num(r.overflow.mean)}` : ""}`);
    out.push(`      in:  ${src}`);
    out.push(`      out: ${snk}`);
  }
  out.push("");
  out.push(`  Action usage (mean per run): ${s.actionUsage.map((a) => `${a.id} ${num(a.mean)}`).join(", ")}`);
  if (s.stalls.length) {
    out.push("");
    out.push("  Progress ended before the final node (next node / runs / reason at end of run):");
    for (const st of s.stalls) out.push(`    ${pad(st.node, W)} ${pad(mc ? pct(st.runs / s.runs) : "", 8)} ${st.exampleReasons.join("; ") || "(requirements met; ran out of time/actions)"}`);
  }
  if (s.stuck) {
    out.push("");
    out.push(`  STUCK in ${s.stuck.count} run(s). Blockers in first stuck run:`);
    for (const b of s.stuck.examples) out.push(`    ${b.target}: ${b.reasons.join("; ") || "(no blocking reason; policy excludes it?)"}`);
  }
  out.push("");
}

function compare(r: CompareReport, out: string[]) {
  if (!r.baseline) return;
  simulation(r.baseline, out, "Baseline");
  for (const sc of r.scenarios) {
    out.push(`Scenario ${sc.id}${sc.description ? ` - ${sc.description}` : ""}`);
    for (const a of sc.applied) {
      for (const m of a.matches) out.push(`  ${a.op} ${m.path}: ${JSON.stringify(m.before)} -> ${JSON.stringify(m.after)}`);
    }
    if (!sc.validation.ok) {
      out.push(`  Scenario model is INVALID; not simulated.`);
      for (const i of sc.validation.errors) out.push(issue(i));
      out.push("");
      continue;
    }
    const d = sc.diff!;
    out.push(`  completion rate ${fmtDelta(d.completionRate, pct)}`);
    out.push(`    ${pad("node", W)} ${pad("reach rate", 28)} median time`);
    for (const n of d.nodes) out.push(`    ${pad(n.id, W)} ${pad(fmtDelta(n.reachRate, pct), 28)} ${fmtDelta(n.medianMinute, fmtMin)}`);
    out.push(`  final resources (median): ${d.resourcesFinalMedian.filter((x) => x.delta.delta).map((x) => `${x.id} ${fmtDelta(x.delta, num)}`).join(", ") || "no change"}`);
    out.push("");
  }
}

function unsupported(r: ReportBase<string>, out: string[]) {
  if (!r.unsupported.length) return;
  out.push("Not modelled (declared by adapter; results do not cover these):");
  for (const u of r.unsupported) out.push(`  - ${u.feature}: ${u.reason}`);
  out.push("");
}

function fmtDelta(d: Delta, f: (n: number) => string): string {
  const b = d.baseline === null ? "-" : f(d.baseline);
  const s = d.scenario === null ? "-" : f(d.scenario);
  if (d.delta === null) return `${b} -> ${s}`;
  if (d.delta === 0) return `${b} (=)`;
  return `${b} -> ${s} (${d.pct !== null ? (d.pct > 0 ? "+" : "") + d.pct + "%" : "n/a"})`;
}

function sumStr(s: Summary, f: (n: number) => string) {
  return `median ${f(s.median)} (p10 ${f(s.p10)}, p90 ${f(s.p90)})`;
}

export function pad(s: string, n: number) {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

const W = 22;

