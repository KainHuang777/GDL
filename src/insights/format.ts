import type { AnyReport } from "../index.js";
import { fmtMin, num, pct, signedPct } from "../report/units.js";
import { fmtDeltaMin, type Category, type Insights } from "./insights.js";

/** Terminal reading view for `gdl inspect`. */
export function formatInsights(report: AnyReport, ins: Insights, focus: Category[] = []): string {
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
  out.push(`Findings  ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`);
  if (!fs.length) out.push("  (none)");
  for (const f of fs) {
    const tag = f.severity === "critical" ? "CRIT" : f.severity === "warning" ? "WARN" : "info";
    out.push(`  ${tag} ${pad(`[${f.category}]`, 13)}${f.title}`);
    if (f.detail) out.push(`       ${" ".repeat(13)}${f.detail}`);
  }
  out.push("");

  if (want("bottleneck") && ins.pacing) {
    const pc = ins.pacing;
    out.push("Pacing (median minute; segment = time since previous node)");
    const max = Math.max(1, ...pc.segments.map((s) => s.medianMinutes));
    for (const n of pc.nodes) {
      const seg = pc.segments.find((s) => s.to === n.id);
      const bar = seg ? "█".repeat(Math.max(seg.medianMinutes > 0 ? 1 : 0, Math.round((seg.medianMinutes / max) * 24))) : "";
      const mark = seg && pc.slowest === seg ? " ◀ slowest" : "";
      out.push(`  ${pad(n.id, 22)} ${pad(pct(n.reachRate), 7)} ${pad(n.median === null ? "-" : fmtMin(n.median), 8)} ${pad(seg ? fmtMin(seg.medianMinutes) : "", 8)} ${bar}${mark}`);
    }
    out.push(`  stop: ${pc.stops.map((s) => `${s.reason} ${pct(s.share)}`).join(", ")}`);
    for (const st of pc.stalls) {
      out.push(`  stalled before ${st.node} (${pct(st.share)}): ${st.reasons.join("; ") || "ran out of time/actions"}`);
      for (const l of st.limits) {
        out.push(`    ${l.resource}: need ${num(l.need)}, have ${num(l.have)}, gap ${num(l.gap)}, net ${num(l.netPerHour)}/h → ${l.etaMinutes === null ? "does not close" : "~" + fmtMin(l.etaMinutes)}`);
      }
    }
    out.push("");
  }

  if (want("economy") && ins.economy) {
    out.push("Economy (means per run)");
    out.push(`  ${pad("resource", 16)} ${pad("produced", 10)} ${pad("consumed", 10)} ${pad("final(med)", 11)} ${pad("net/h", 9)} overflow`);
    for (const r of ins.economy) {
      out.push(`  ${pad(r.id, 16)} ${pad(num(r.produced), 10)} ${pad(num(r.consumed), 10)} ${pad(num(r.finalMedian), 11)} ${pad(num(r.netPerHour), 9)} ${r.overflow > 0 ? `${num(r.overflow)} (${pct(r.overflowShare)})` : "-"}`);
      if (r.sources.length) out.push(`      in : ${r.sources.slice(0, 4).map((x) => `${x.key} ${pct(x.share)}`).join(", ")}`);
      if (r.sinks.length) out.push(`      out: ${r.sinks.slice(0, 4).map((x) => `${x.key} ${pct(x.share)}`).join(", ")}`);
    }
    out.push("");
  }

  if (want("scenario") && ins.scenarios) {
    for (const v of ins.scenarios) {
      out.push(`Scenario ${v.id}${v.description ? ` - ${v.description}` : ""}  (${v.changes} value(s) changed)`);
      if (!v.valid) {
        out.push("  invalid model; not simulated");
        out.push("");
        continue;
      }
      if (v.completionRate) out.push(`  completion ${pct(v.completionRate.baseline ?? 0)} → ${pct(v.completionRate.scenario ?? 0)}`);
      if (!v.nodeImpact.length && !v.resourceImpact.length) out.push("  no measurable change");
      for (const n of v.nodeImpact) {
        const reach = n.reachRate.delta ? `  reach ${pct(n.reachRate.baseline ?? 0)} → ${pct(n.reachRate.scenario ?? 0)}` : "";
        out.push(`  node ${pad(n.id, 22)} ${fmtDeltaMin(n.medianMinute)}${reach}`);
      }
      for (const x of v.resourceImpact) out.push(`  res  ${pad(x.id, 22)} ${num(x.delta.baseline ?? 0)} → ${num(x.delta.scenario ?? 0)} (${signedPct(x.delta.pct)})`);
      out.push("");
    }
  }

  if (report.unsupported.length) out.push(`Not modelled: ${report.unsupported.map((u) => u.feature).join(", ")}`, "");
  return out.join("\n") + "\n";
}

function pad(s: string, n: number) {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}
