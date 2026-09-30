import type { AnyReport } from "../index.js";
import { fmtMin, num, pct, signedPct } from "../report/units.js";
import { fmtDeltaMin, type Category, type InsightLang, type Insights } from "./insights.js";

/** Terminal reading view for `gdl inspect`. */
export function formatInsights(report: AnyReport, ins: Insights, focus: Category[] = [], lang: InsightLang = "en"): string {
  const zh = lang === "zh-TW";
  const want = (c: Category) => !focus.length || focus.includes(c);
  const out: string[] = [];
  const p = report.provenance;
  out.push(`GDL inspect | ${report.kind} | project ${p.project.id} | model ${p.modelSha256.slice(0, 12)} | ${p.generatedAt}`);
  const sim = report.kind === "compare" ? report.baseline : report.kind === "validate" ? undefined : report.simulation;
  if (sim) out.push(`  ${sim.mode}${sim.seed !== null ? ` runs ${sim.runs} seed ${sim.seed}` : ""}  limit ${fmtMin(sim.limits.maxMinutes)}  policy ${sim.policy.id}`);
  out.push("");

  const fs = ins.findings.filter((f) => want(f.category));
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of fs) counts[f.severity]++;
  out.push(zh ? `發現  ${counts.critical} 重大, ${counts.warning} 警告, ${counts.info} 資訊` : `Findings  ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`);
  if (!fs.length) out.push(zh ? "  （無）" : "  (none)");
  for (const f of fs) {
    const tag = f.severity === "critical" ? "CRIT" : f.severity === "warning" ? "WARN" : "info";
    out.push(`  ${tag} ${pad(`[${f.category}]`, 13)}${f.title}`);
    if (f.detail) out.push(`       ${" ".repeat(13)}${f.detail}`);
    if (f.caveats?.length) out.push(`       ${" ".repeat(13)}${zh ? "※ 數值可能不可靠，未建模：" : "* numbers may be unreliable; not modelled: "}${f.caveats.join(", ")}`);
  }
  out.push("");

  if (want("bottleneck") && ins.pacing) {
    const pc = ins.pacing;
    out.push(zh ? "進度（中位數分鐘；區段 = 距上一節點時間）" : "Pacing (median minute; segment = time since previous node)");
    const max = Math.max(1, ...pc.segments.map((s) => s.medianMinutes));
    for (const n of pc.nodes) {
      const seg = pc.segments.find((s) => s.to === n.id);
      const bar = seg ? "█".repeat(Math.max(seg.medianMinutes > 0 ? 1 : 0, Math.round((seg.medianMinutes / max) * 24))) : "";
      const mark = seg && pc.slowest === seg ? (zh ? " ◀ 最慢" : " ◀ slowest") : "";
      out.push(`  ${pad(n.id, 22)} ${pad(pct(n.reachRate), 7)} ${pad(n.median === null ? "-" : fmtMin(n.median), 8)} ${pad(seg ? fmtMin(seg.medianMinutes) : "", 8)} ${bar}${mark}`);
    }
    const lim = pc.nodes.filter((n) => n.limiters.length && n.median !== null && pc.segments.some((s) => s.to === n.id));
    if (lim.length) {
      out.push(zh ? "  等待歸因（各節點等待時間依限制資源）" : "  Waiting by limiting resource");
      for (const n of lim) out.push(`    ${pad(n.id, 22)} ${n.limiters.slice(0, 3).map((l) => `${l.resource} ${pct(l.share)} (${fmtMin(l.minutes)})`).join(", ")}`);
    }
    out.push(`${zh ? "  停止: " : "  stop: "}${pc.stops.map((s) => `${s.reason} ${pct(s.share)}`).join(", ")}`);
    for (const st of pc.stalls) {
      out.push(`${zh ? "  在「" + st.node + "」前卡住" : "  stalled before " + st.node} (${pct(st.share)}): ${st.reasons.join("; ") || (zh ? "時間/動作數耗盡" : "ran out of time/actions")}`);
      for (const l of st.limits) {
        out.push(zh
          ? `    ${l.resource}: 需要 ${num(l.need)}, 現有 ${num(l.have)}, 缺口 ${num(l.gap)}, 淨產 ${num(l.netPerHour)}/h → ${l.etaMinutes === null ? "不會自行補足" : "~" + fmtMin(l.etaMinutes)}`
          : `    ${l.resource}: need ${num(l.need)}, have ${num(l.have)}, gap ${num(l.gap)}, net ${num(l.netPerHour)}/h → ${l.etaMinutes === null ? "does not close" : "~" + fmtMin(l.etaMinutes)}`);
      }
    }
    out.push("");
  }

  if (want("economy") && ins.economy) {
    out.push(zh ? "經濟（每場平均值）" : "Economy (means per run)");
    const cols = zh ? ["資源", "產出", "消耗", "期末(中位)", "淨/h", "溢出"] : ["resource", "produced", "consumed", "final(med)", "net/h", "overflow"];
    out.push(`  ${pad(cols[0]!, 16)} ${pad(cols[1]!, 10)} ${pad(cols[2]!, 10)} ${pad(cols[3]!, 11)} ${pad(cols[4]!, 9)} ${cols[5]}`);
    for (const r of ins.economy) {
      out.push(`  ${pad(r.id, 16)} ${pad(num(r.produced), 10)} ${pad(num(r.consumed), 10)} ${pad(num(r.finalMedian), 11)} ${pad(num(r.netPerHour), 9)} ${r.overflow > 0 ? `${num(r.overflow)} (${pct(r.overflowShare)})` : "-"}`);
      if (r.sources.length) out.push(`      ${zh ? "入 :" : "in :"} ${r.sources.slice(0, 4).map((x) => `${x.key} ${pct(x.share)}`).join(", ")}`);
      if (r.sinks.length) out.push(`      ${zh ? "出:" : "out:"} ${r.sinks.slice(0, 4).map((x) => `${x.key} ${pct(x.share)}`).join(", ")}`);
    }
    out.push("");
  }

  if (want("policy") && ins.waste?.length) {
    out.push(zh ? "策略浪費（製作後未使用的成品）" : "Strategy waste (crafted goods never used)");
    for (const w of ins.waste) {
      out.push(`  ${pad(w.action, 26)} ${w.resource}: ${zh ? "製作" : "made"} ${num(w.made)}, ${zh ? "未使用" : "unused"} ${num(w.unused)} (${pct(w.unusedShare)})${w.wastedCosts.length ? "  ← " + w.wastedCosts.filter((c) => c.amount > 0).map((c) => `${c.resource} ${num(c.amount)} (${pct(c.shareOfConsumed)})`).join(", ") : ""}`);
    }
    out.push("");
  }

  if (want("scenario") && ins.scenarios) {
    for (const v of ins.scenarios) {
      out.push(`${zh ? "情境「" + v.id + "」" : "Scenario " + v.id}${v.description ? ` - ${v.description}` : ""}  (${v.changes} ${zh ? "個數值已變更" : "value(s) changed"})`);
      if (!v.valid) {
        out.push(zh ? "  無效模型；未模擬" : "  invalid model; not simulated");
        out.push("");
        continue;
      }
      if (v.completionRate) out.push(`${zh ? "  完成率 " : "  completion "}${pct(v.completionRate.baseline ?? 0)} → ${pct(v.completionRate.scenario ?? 0)}`);
      if (!v.resourcesComparable) out.push(zh ? "  （兩次執行結束時間不同，不比較期末資源）" : "  (runs ended at different times; final resources not compared)");
      for (const sh of v.limiterShifts) out.push(`  ${zh ? "限制資源" : "limiter"} ${pad(sh.node, 22)} ${sh.from} → ${sh.to}`);
      if (!v.nodeImpact.length && !v.resourceImpact.length && !v.limiterShifts.length) out.push(zh ? "  無可測量的變化" : "  no measurable change");
      for (const n of v.nodeImpact) {
        const reach = n.reachRate.delta ? `${zh ? "  到達率 " : "  reach "}${pct(n.reachRate.baseline ?? 0)} → ${pct(n.reachRate.scenario ?? 0)}` : "";
        out.push(`  ${zh ? "節點" : "node"} ${pad(n.id, 22)} ${fmtDeltaMin(n.medianMinute, lang)}${reach}`);
      }
      for (const x of v.resourceImpact) out.push(`  ${zh ? "資源" : "res"}  ${pad(x.id, 22)} ${num(x.delta.baseline ?? 0)} → ${num(x.delta.scenario ?? 0)} (${signedPct(x.delta.pct)})`);
      out.push("");
    }
  }

  if (report.unsupported.length) out.push(`${zh ? "未建模：" : "Not modelled: "}${report.unsupported.map((u) => u.feature).join(", ")}`, "");
  return out.join("\n") + "\n";
}

function pad(s: string, n: number) {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}