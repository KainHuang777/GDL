import { loadProject, type LoadedProject } from "./adapter/loader.js";
import { analyzeReachability, type ReachabilityReport } from "./core/reachability.js";
import { runSimulation, type SimulationOptions, type SimulationResult } from "./core/runner.js";
import { applyScenario, type AppliedChange, type Scenario } from "./core/scenario.js";
import { round } from "./core/stats.js";
import type { GameModel, UnsupportedFeature } from "./schema/types.js";
import { validateModel, type ValidationResult } from "./schema/validate.js";
import { GDL_VERSION, REPORT_VERSION, SCHEMA_VERSION } from "./version.js";

/** Provenance block attached to every report (design §3.3). */
export interface Provenance {
  gdlVersion: string;
  reportVersion: string;
  schemaVersion: string;
  generatedAt: string;
  project: { id: string; root: string };
  adapter: LoadedProject["adapter"];
  modelSha256: string;
  sources: LoadedProject["sources"];
}

export interface ReportBase<K extends string> {
  kind: K;
  provenance: Provenance;
  validation: ValidationResult;
  /** Gameplay the adapter declared as not modelled. Results do NOT cover these. */
  unsupported: UnsupportedFeature[];
}

export interface ValidateReport extends ReportBase<"validate"> {}

export interface AnalyzeReport extends ReportBase<"analyze"> {
  reachability?: ReachabilityReport;
  /** Deterministic expected-value simulation used for timing & resource flow. */
  simulation?: SimulationResult;
}

export interface SimulateReport extends ReportBase<"simulate"> {
  simulation?: SimulationResult;
}

export interface CompareReport extends ReportBase<"compare"> {
  baseline?: SimulationResult;
  scenarios: {
    id: string;
    description?: string;
    applied: AppliedChange[];
    validation: ValidationResult;
    simulation?: SimulationResult;
    diff?: ScenarioDiff;
  }[];
}

export type AnyReport = ValidateReport | AnalyzeReport | SimulateReport | CompareReport;

export interface ScenarioDiff {
  completionRate: Delta;
  nodes: { id: string; reachRate: Delta; medianMinute: Delta }[];
  resourcesFinalMedian: { id: string; delta: Delta }[];
}

export interface Delta {
  baseline: number | null;
  scenario: number | null;
  delta: number | null;
  /** Relative change; null when baseline is 0 or missing. */
  pct: number | null;
}

async function prepare(target: string, cwd?: string) {
  const project = await loadProject(target, cwd);
  const validation = validateModel(project.model);
  const model = validation.ok ? (project.model as GameModel) : null;
  const provenance: Provenance = {
    gdlVersion: GDL_VERSION,
    reportVersion: REPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    project: { id: project.config.projectId, root: project.root },
    adapter: project.adapter,
    modelSha256: project.modelSha256,
    sources: project.sources,
  };
  const unsupported = model?.unsupported ?? [];
  return { project, validation, model, provenance, unsupported };
}

export async function validateProject(target: string, cwd?: string): Promise<ValidateReport> {
  const { validation, provenance, unsupported } = await prepare(target, cwd);
  return { kind: "validate", provenance, validation, unsupported };
}

export async function analyzeProject(target: string, sim: Omit<SimulationOptions, "mode">, cwd?: string): Promise<AnalyzeReport> {
  const { validation, model, provenance, unsupported } = await prepare(target, cwd);
  const report: AnalyzeReport = { kind: "analyze", provenance, validation, unsupported };
  if (!model) return report;
  report.reachability = analyzeReachability(model);
  report.simulation = runSimulation(model, { ...sim, mode: "expected" });
  return report;
}

export async function simulateProject(target: string, sim: SimulationOptions, cwd?: string): Promise<SimulateReport> {
  const { validation, model, provenance, unsupported } = await prepare(target, cwd);
  const report: SimulateReport = { kind: "simulate", provenance, validation, unsupported };
  if (!model) return report;
  report.simulation = runSimulation(model, sim);
  return report;
}

export async function compareProject(target: string, scenarios: Scenario[], sim: SimulationOptions, cwd?: string): Promise<CompareReport> {
  const { validation, model, provenance, unsupported } = await prepare(target, cwd);
  const report: CompareReport = { kind: "compare", provenance, validation, unsupported, scenarios: [] };
  if (!model) return report;
  const baseline = runSimulation(model, sim);
  report.baseline = baseline;
  for (const sc of scenarios) {
    const { model: changed, applied } = applyScenario(model, sc);
    const v = validateModel(changed);
    const entry: CompareReport["scenarios"][number] = { id: sc.id, applied, validation: v };
    if (sc.description) entry.description = sc.description;
    if (v.ok) {
      // Same seed => common random numbers, reducing noise in the comparison.
      const s = runSimulation(changed, { ...sim, policy: sc.policy ?? sim.policy });
      entry.simulation = s;
      entry.diff = diffSimulations(baseline, s);
    }
    report.scenarios.push(entry);
  }
  return report;
}

export function diffSimulations(a: SimulationResult, b: SimulationResult): ScenarioDiff {
  return {
    completionRate: delta(a.completionRate, b.completionRate),
    nodes: a.nodes.map((n) => {
      const m = b.nodes.find((x) => x.id === n.id);
      return { id: n.id, reachRate: delta(n.reachRate, m?.reachRate ?? null), medianMinute: delta(n.minute?.median ?? null, m?.minute?.median ?? null) };
    }),
    resourcesFinalMedian: a.resources.map((r) => ({ id: r.id, delta: delta(r.final.median, b.resources.find((x) => x.id === r.id)?.final.median ?? null) })),
  };
}

function delta(a: number | null, b: number | null): Delta {
  const d = a !== null && b !== null ? round(b - a) : null;
  return { baseline: a, scenario: b, delta: d, pct: d !== null && a ? round((d / a) * 100, 2) : null };
}

export { loadProject } from "./adapter/loader.js";
export { defineAdapter } from "./adapter/api.js";
export { buildInsights, resolveThresholds, THRESHOLDS } from "./insights/insights.js";
export type { InsightRule, RuleContext, Finding, Thresholds, Insights } from "./insights/insights.js";
export type { GdlAdapter, AdapterContext } from "./adapter/api.js";
export { validateModel } from "./schema/validate.js";
export { runSimulation } from "./core/runner.js";
export { analyzeReachability } from "./core/reachability.js";
export { applyScenario, parseScenario } from "./core/scenario.js";
export type * from "./schema/types.js";
