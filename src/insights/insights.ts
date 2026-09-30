import type { AnyReport, CompareReport, Delta } from "../index.js";
import type { SimulationResult } from "../core/runner.js";
import { round } from "../core/stats.js";
import { fmtMin, num, pct, signedPct } from "../report/units.js";

/**
 * Deterministic reading aids built on top of a report (docs/dashboard-design.md).
 * Pure: same report => same insights. Never reruns the simulation.
 */

export type Severity = "critical" | "warning" | "info";
export type Category = "bottleneck" | "economy" | "scenario" | "data";
export const CATEGORIES: Category[] = ["bottleneck", "economy", "scenario", "data"];

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  /** "simulation" | "baseline" | "scenario:<id>" */
  scope: string;
  /** "node:<id>" | "resource:<id>" | "action:<id>" | "scenario:<id>" */
  subject?: string;
  title: string;
  detail: string;
}

export interface Segment {
  from: string;
  to: string;
  medianMinutes: number;
  /** Share of the median time to the last reached node. */
  share: number;
}

export interface PacingView {
  nodes: { id: string; reachRate: number; p10: number | null; median: number | null; p90: number | null }[];
  segments: Segment[];
  slowest: Segment | null;
  /** Median minute of the last node that at least half the runs reached. */
  horizonMinutes: number;
  stops: { reason: string; share: number }[];
  stalls: { node: string; share: number; reasons: string[]; limits: Limiter[] }[];
}

export interface Limiter {
  resource: string;
  kind: "cost" | "requirement";
  need: number;
  have: number;
  gap: number;
  netPerHour: number;
  /** Estimated in-game minutes to close the gap at the current net rate; null if the rate is <= 0. */
  etaMinutes: number | null;
}

export interface FlowShare {
  key: string;
  mean: number;
  share: number;
}

export interface EconomyRow {
  id: string;
  produced: number;
  consumed: number;
  finalMedian: number;
  netPerHour: number;
  overflow: number;
  /** overflow / (produced + overflow) */
  overflowShare: number;
  sources: FlowShare[];
  sinks: FlowShare[];
}

export interface ScenarioView {
  id: string;
  description?: string;
  valid: boolean;
  changes: number;
  completionRate: Delta | null;
  /** Nodes sorted by |impact| on median time. */
  nodeImpact: { id: string; medianMinute: Delta; reachRate: Delta }[];
  resourceImpact: { id: string; delta: Delta }[];
}

export interface Insights {
  kind: AnyReport["kind"];
  findings: Finding[];
  pacing?: PacingView;
  economy?: EconomyRow[];
  actionUsage?: { id: string; mean: number }[];
  scenarios?: ScenarioView[];
}

/** Initial thresholds; tune with real project feedback. */
export const THRESHOLDS = {
  stallShare: 0.05,
  slowSegmentShare: 0.35,
  slowSegmentMinNodes: 3,
  spikeFactor: 2,
  varianceRatio: 1.5,
  waitingShare: 0.3,
  overflowWarnShare: 0.1,
  hoardShare: 0.5,
  sourceConcentration: 0.8,
  scenarioTop: 3,
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function buildInsights(report: AnyReport): Insights {
  const findings: Finding[] = [];
  const ins: Insights = { kind: report.kind, findings };

  if (!report.validation.ok) {
    findings.push({
      id: "invalid",
      severity: "critical",
      category: "data",
      scope: "model",
      title: `Model is invalid (${report.validation.errors.length} error(s)); nothing was simulated`,
      detail: report.validation.errors.slice(0, 3).map((e) => `[${e.code}] ${e.path}: ${e.message}`).join("; "),
    });
  } else if (report.validation.warnings.length) {
    findings.push({
      id: "validation-warnings",
      severity: "info",
      category: "data",
      scope: "model",
      title: `${report.validation.warnings.length} validation warning(s)`,
      detail: report.validation.warnings.slice(0, 3).map((e) => `[${e.code}] ${e.path}: ${e.message}`).join("; "),
    });
  }

  if (report.kind === "analyze" && report.reachability) {
    for (const n of report.reachability.nodes.filter((x) => x.status === "unreachable")) {
      findings.push({
        id: "unreachable",
        severity: "critical",
        category: "bottleneck",
        scope: "static",
        subject: n.target,
        title: `${n.target} is unreachable by design`,
        detail: n.reasons.join("; ") || "static reachability found no way to satisfy it",
      });
    }
  }

  const primary = report.kind === "compare" ? report.baseline : report.kind === "validate" ? undefined : report.simulation;
  if (primary) {
    const scope = report.kind === "compare" ? "baseline" : "simulation";
    ins.pacing = pacing(primary);
    ins.economy = economy(primary);
    ins.actionUsage = [...primary.actionUsage].sort((a, b) => b.mean - a.mean);
    bottleneckRules(primary, ins.pacing, scope, findings);
    economyRules(primary, ins.economy, ins.pacing, scope, findings);
  }

  if (report.kind === "compare") {
    ins.scenarios = scenarioViews(report);
    scenarioRules(report, ins.scenarios, findings);
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  return ins;
}

// ---------------------------------------------------------------- pacing / bottleneck

function pacing(s: SimulationResult): PacingView {
  const reached = s.nodes.filter((n) => n.minute && n.reachRate >= 0.5);
  const horizon = reached.length ? reached[reached.length - 1]!.minute!.median : 0;
  const segments: Segment[] = [];
  for (let i = 1; i < s.nodes.length; i++) {
    const n = s.nodes[i]!;
    if (!n.deltaMinute) continue;
    segments.push({ from: s.nodes[i - 1]!.id, to: n.id, medianMinutes: n.deltaMinute.median, share: horizon > 0 ? round(n.deltaMinute.median / horizon, 4) : 0 });
  }
  const slowest = segments.length ? segments.reduce((a, b) => (b.medianMinutes > a.medianMinutes ? b : a)) : null;
  const stalls = s.stalls.map((st) => ({
    node: st.node,
    share: round(st.runs / s.runs, 4),
    reasons: st.exampleReasons,
    limits: st.exampleReasons.map((r) => parseLimiter(r, s)).filter((x): x is Limiter => !!x),
  }));
  return {
    nodes: s.nodes.map((n) => ({ id: n.id, reachRate: n.reachRate, p10: n.minute?.p10 ?? null, median: n.minute?.median ?? null, p90: n.minute?.p90 ?? null })),
    segments,
    slowest,
    horizonMinutes: horizon,
    stops: Object.entries(s.stopReasons).map(([reason, count]) => ({ reason, share: round(count! / s.runs, 4) })),
    stalls,
  };
}

const COST_RE = /^costs (\S+) ([\d.]+) \(have ([-\d.]+)\)$/;
const REQ_RE = /^requires (\S+) >= ([\d.]+) \(have ([-\d.]+)\)$/;

/** Parse engine blocker reasons (src/core/simulate.ts `reasons()`) into a resource gap. */
export function parseLimiter(reason: string, s: SimulationResult): Limiter | null {
  const m = COST_RE.exec(reason) ?? REQ_RE.exec(reason);
  if (!m) return null;
  const resource = m[1]!;
  const need = Number(m[2]);
  const have = Number(m[3]);
  const netPerHour = s.resources.find((r) => r.id === resource)?.netPerHour ?? 0;
  const gap = round(Math.max(0, need - have));
  return {
    resource,
    kind: reason.startsWith("costs") ? "cost" : "requirement",
    need,
    have,
    gap,
    netPerHour,
    etaMinutes: netPerHour > 0 ? round((gap / netPerHour) * 60, 2) : null,
  };
}

function bottleneckRules(s: SimulationResult, p: PacingView, scope: string, out: Finding[]) {
  const T = THRESHOLDS;
  const mc = s.mode === "monte-carlo";

  if (s.stuck) {
    const blockers = s.stuck.examples.filter((b) => b.reasons.length).slice(0, 4);
    out.push({
      id: "stuck",
      severity: "critical",
      category: "bottleneck",
      scope,
      title: `Stuck in ${s.stuck.count}/${s.runs} run(s): no affordable action and nothing regenerates`,
      detail: blockers.map((b) => `${b.target}: ${b.reasons.join("; ")}`).join(" | ") || "no blocking reason recorded (policy excludes the needed actions?)",
    });
  }

  for (const st of p.stalls) {
    if (st.share < T.stallShare) continue;
    const lim = st.limits[0];
    let detail = st.reasons.join("; ") || "requirements met; ran out of time/actions";
    if (lim) {
      detail += lim.etaMinutes !== null
        ? ` — short ${num(lim.gap)} ${lim.resource}; at ${num(lim.netPerHour)}/h that is ~${fmtMin(lim.etaMinutes)} more play`
        : ` — short ${num(lim.gap)} ${lim.resource}, whose net rate is ${num(lim.netPerHour)}/h: it will not close by itself`;
    }
    out.push({
      id: "stall",
      severity: "warning",
      category: "bottleneck",
      scope,
      subject: `node:${st.node}`,
      title: `${pct(st.share)} of runs stop before ${st.node}${lim ? ` (limited by ${lim.resource})` : ""}`,
      detail,
    });
  }

  const partial = s.nodes.find((n) => n.reachRate > 0 && n.reachRate < 1);
  if (partial) {
    out.push({
      id: "partial-reach",
      severity: "warning",
      category: "bottleneck",
      scope,
      subject: `node:${partial.id}`,
      title: `Only ${pct(partial.reachRate)} of runs reach ${partial.id}`,
      detail: "Outcomes diverge from here: randomness decides whether players progress within the limit.",
    });
  }

  const reachedCount = p.nodes.filter((n) => n.median !== null).length;
  if (p.slowest && reachedCount >= T.slowSegmentMinNodes && p.slowest.share >= T.slowSegmentShare) {
    out.push({
      id: "slow-segment",
      severity: "warning",
      category: "bottleneck",
      scope,
      subject: `node:${p.slowest.to}`,
      title: `${p.slowest.from} → ${p.slowest.to} takes ${pct(p.slowest.share)} of the progression time`,
      detail: `Median ${fmtMin(p.slowest.medianMinutes)} of ${fmtMin(p.horizonMinutes)} to the last commonly reached node.`,
    });
  }

  for (let i = 1; i < p.segments.length; i++) {
    const a = p.segments[i - 1]!;
    const b = p.segments[i]!;
    if (a.medianMinutes > 0 && b.medianMinutes >= a.medianMinutes * T.spikeFactor && b !== p.slowest) {
      out.push({
        id: "pacing-spike",
        severity: "info",
        category: "bottleneck",
        scope,
        subject: `node:${b.to}`,
        title: `Pacing jump at ${b.to}: ${fmtMin(b.medianMinutes)} vs ${fmtMin(a.medianMinutes)} for the previous step (×${num(round(b.medianMinutes / a.medianMinutes, 2))})`,
        detail: `Segment ${b.from} → ${b.to}.`,
      });
    }
  }

  if (mc) {
    const noisy = s.nodes.filter((n) => n.minute && n.minute.p10 > 0 && n.minute.p90 / n.minute.p10 >= T.varianceRatio);
    if (noisy.length) {
      out.push({
        id: "variance",
        severity: "info",
        category: "bottleneck",
        scope,
        subject: `node:${noisy[0]!.id}`,
        title: `Arrival time varies a lot for ${noisy.map((n) => n.id).join(", ")}`,
        detail: noisy.map((n) => `${n.id}: p10 ${fmtMin(n.minute!.p10)} / p90 ${fmtMin(n.minute!.p90)} (×${num(round(n.minute!.p90 / n.minute!.p10, 2))})`).join("; "),
      });
    }
  }

  if (s.minutes.median > 0 && s.minutesWaiting.median / s.minutes.median >= T.waitingShare) {
    out.push({
      id: "waiting",
      severity: "warning",
      category: "bottleneck",
      scope,
      title: `Players spend ${pct(s.minutesWaiting.median / s.minutes.median)} of play time waiting for regeneration`,
      detail: `Median waiting ${fmtMin(s.minutesWaiting.median)} of ${fmtMin(s.minutes.median)} played.`,
    });
  }
}

// ---------------------------------------------------------------- economy

function economy(s: SimulationResult): EconomyRow[] {
  return s.resources.map((r) => {
    const produced = r.produced.mean;
    const consumed = r.consumed.mean;
    const overflow = r.overflow.mean;
    return {
      id: r.id,
      produced,
      consumed,
      finalMedian: r.final.median,
      netPerHour: r.netPerHour,
      overflow,
      overflowShare: produced + overflow > 0 ? round(overflow / (produced + overflow), 4) : 0,
      sources: r.topSources.map((x) => ({ key: x.source, mean: x.mean, share: produced > 0 ? round(x.mean / produced, 4) : 0 })),
      sinks: r.topSinks.map((x) => ({ key: x.sink, mean: x.mean, share: consumed > 0 ? round(x.mean / consumed, 4) : 0 })),
    };
  });
}

function economyRules(s: SimulationResult, rows: EconomyRow[], p: PacingView, scope: string, out: Finding[]) {
  const T = THRESHOLDS;
  const limiting = new Set(p.stalls.flatMap((st) => st.limits.map((l) => l.resource)));
  const noSink: string[] = [];

  for (const r of rows) {
    const subject = `resource:${r.id}`;
    if (r.overflow > 0) {
      const warn = r.overflowShare >= T.overflowWarnShare;
      out.push({
        id: "overflow",
        severity: warn ? "warning" : "info",
        category: "economy",
        scope,
        subject,
        title: `${r.id} overflows its cap: ${pct(r.overflowShare)} of income is wasted`,
        detail: `Mean ${num(r.overflow)} lost per run vs ${num(r.produced)} kept. Raise the cap, add a sink, or reduce idle time.`,
      });
    }
    if (r.netPerHour < 0 && r.consumed > 0) {
      const drained = r.finalMedian <= 0;
      out.push({
        id: "deficit",
        severity: drained ? "warning" : "info",
        category: "economy",
        scope,
        subject,
        title: `${r.id} is net negative (${num(r.netPerHour)}/h)${drained ? " and runs dry" : ""}`,
        detail: `Produced ${num(r.produced)}, consumed ${num(r.consumed)} per run; median final ${num(r.finalMedian)}.`,
      });
    }
    if (r.consumed === 0 && r.produced > 0) noSink.push(r.id);
    if (r.consumed > 0 && r.produced > 0 && r.finalMedian >= r.produced * T.hoardShare && !limiting.has(r.id)) {
      out.push({
        id: "hoarding",
        severity: "info",
        category: "economy",
        scope,
        subject,
        title: `${r.id} piles up: median final ${num(r.finalMedian)} is ${pct(r.finalMedian / r.produced)} of income`,
        detail: `Only ${num(r.consumed)} of ${num(r.produced)} is spent per run; sinks may be too weak.`,
      });
    }
    const top = r.sources[0];
    if (top && r.consumed > 0 && r.sources.length >= 1 && top.key !== "regen" && top.share >= T.sourceConcentration) {
      out.push({
        id: "source-concentration",
        severity: "info",
        category: "economy",
        scope,
        subject,
        title: `${r.id} depends on one source: ${top.key} gives ${pct(top.share)}`,
        detail: `Changes to ${top.key} will move the whole ${r.id} economy.`,
      });
    }
  }

  if (noSink.length) {
    out.push({
      id: "no-sink",
      severity: "info",
      category: "economy",
      scope,
      title: `Only produced, never spent: ${noSink.join(", ")}`,
      detail: "Fine for counters / progress stats (e.g. exp used only as a requirement); otherwise a sink is missing.",
    });
  }

  const unused = s.actionUsage.filter((a) => a.mean === 0).map((a) => a.id);
  if (unused.length) {
    out.push({
      id: "unused-action",
      severity: "info",
      category: "economy",
      scope,
      title: `${unused.length} action(s) never used under policy "${s.policy.id}"`,
      detail: `${unused.join(", ")} — dead content, locked behind unreached nodes, or outranked in the policy.`,
    });
  }
}

// ---------------------------------------------------------------- scenarios

function impactScore(d: Delta): number {
  if (d.pct !== null) return Math.abs(d.pct);
  if (d.baseline === null && d.scenario !== null) return Infinity; // newly reached
  if (d.baseline !== null && d.scenario === null) return Infinity; // no longer reached
  return Math.abs(d.delta ?? 0);
}

function scenarioViews(r: CompareReport): ScenarioView[] {
  return r.scenarios.map((sc) => {
    const v: ScenarioView = {
      id: sc.id,
      valid: sc.validation.ok,
      changes: sc.applied.reduce((n, a) => n + a.matches.length, 0),
      completionRate: sc.diff?.completionRate ?? null,
      nodeImpact: [],
      resourceImpact: [],
    };
    if (sc.description) v.description = sc.description;
    if (sc.diff) {
      v.nodeImpact = sc.diff.nodes
        .filter((n) => changed(n.medianMinute) || changed(n.reachRate))
        .sort((a, b) => impactScore(b.medianMinute) - impactScore(a.medianMinute) || impactScore(b.reachRate) - impactScore(a.reachRate));
      v.resourceImpact = sc.diff.resourcesFinalMedian.filter((x) => changed(x.delta)).sort((a, b) => impactScore(b.delta) - impactScore(a.delta));
    }
    return v;
  });
}

function changed(d: Delta): boolean {
  return d.delta !== null ? d.delta !== 0 : d.baseline !== d.scenario;
}

function scenarioRules(r: CompareReport, views: ScenarioView[], out: Finding[]) {
  const T = THRESHOLDS;
  for (const v of views) {
    const scope = `scenario:${v.id}`;
    const sc = r.scenarios.find((x) => x.id === v.id)!;
    if (!v.valid) {
      out.push({
        id: "scenario-invalid",
        severity: "critical",
        category: "scenario",
        scope,
        subject: scope,
        title: `Scenario ${v.id} produces an invalid model; not simulated`,
        detail: sc.validation.errors.slice(0, 3).map((e) => `[${e.code}] ${e.path}: ${e.message}`).join("; "),
      });
      continue;
    }
    if (sc.simulation?.stuck) {
      out.push({
        id: "stuck",
        severity: "critical",
        category: "bottleneck",
        scope,
        subject: scope,
        title: `Scenario ${v.id}: stuck in ${sc.simulation.stuck.count}/${sc.simulation.runs} run(s)`,
        detail: sc.simulation.stuck.examples.filter((b) => b.reasons.length).slice(0, 4).map((b) => `${b.target}: ${b.reasons.join("; ")}`).join(" | "),
      });
    }
    const cr = v.completionRate;
    if (cr && cr.delta) {
      out.push({
        id: "scenario-completion",
        severity: cr.delta < 0 ? "warning" : "info",
        category: "scenario",
        scope,
        subject: scope,
        title: `Scenario ${v.id}: completion rate ${pct(cr.baseline ?? 0)} → ${pct(cr.scenario ?? 0)}`,
        detail: `${cr.delta < 0 ? "Fewer" : "More"} runs finish the track within the limit.`,
      });
    }
    const reach = v.nodeImpact.filter((n) => changed(n.reachRate));
    if (reach.length) {
      const down = reach.some((n) => (n.reachRate.delta ?? 0) < 0);
      out.push({
        id: "scenario-reach",
        severity: down ? "warning" : "info",
        category: "scenario",
        scope,
        subject: scope,
        title: `Scenario ${v.id}: reach rate changes at ${reach.map((n) => n.id).join(", ")}`,
        detail: reach.map((n) => `${n.id} ${pct(n.reachRate.baseline ?? 0)} → ${pct(n.reachRate.scenario ?? 0)}`).join("; "),
      });
    }
    const timeImpact = v.nodeImpact.filter((n) => changed(n.medianMinute)).slice(0, T.scenarioTop);
    const resImpact = v.resourceImpact.slice(0, T.scenarioTop);
    if (timeImpact.length || resImpact.length) {
      const parts: string[] = [];
      if (timeImpact.length) parts.push("time: " + timeImpact.map((n) => `${n.id} ${fmtDeltaMin(n.medianMinute)}`).join(", "));
      if (resImpact.length) parts.push("final: " + resImpact.map((x) => `${x.id} ${signedPct(x.delta.pct)}`).join(", "));
      out.push({
        id: "scenario-impact",
        severity: "info",
        category: "scenario",
        scope,
        subject: timeImpact[0] ? `node:${timeImpact[0].id}` : `resource:${resImpact[0]!.id}`,
        title: `Scenario ${v.id}: biggest impact on ${timeImpact[0]?.id ?? resImpact[0]!.id}`,
        detail: parts.join(" | "),
      });
    } else if (!(cr && cr.delta)) {
      out.push({
        id: "scenario-no-effect",
        severity: "warning",
        category: "scenario",
        scope,
        subject: scope,
        title: `Scenario ${v.id} changes nothing measurable`,
        detail: `${v.changes} value(s) changed, but no node time, reach rate or final resource moved. The change may hit content this policy never uses.`,
      });
    }
  }
}

export function fmtDeltaMin(d: Delta): string {
  if (d.baseline === null && d.scenario !== null) return `newly reached at ${fmtMin(d.scenario)}`;
  if (d.baseline !== null && d.scenario === null) return `no longer reached (was ${fmtMin(d.baseline)})`;
  if (d.delta === null) return "-";
  return `${fmtMin(d.baseline!)} → ${fmtMin(d.scenario!)} (${signedPct(d.pct)})`;
}
