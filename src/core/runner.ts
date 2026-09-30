import type { GameModel } from "../schema/types.js";
import { resolvePolicy, UsageError } from "./policy.js";
import { createRng, deriveSeed } from "./rng.js";
import { simulateRun, type Blocker, type RunResult, type SimLimits, type SimMode, type StopReason } from "./simulate.js";
import { round, summarize, type Summary } from "./stats.js";

export const MAX_RUNS = 100_000;

export interface SimulationOptions {
  mode: SimMode;
  policy?: string;
  limits: SimLimits;
  /** Monte Carlo only. */
  runs?: number;
  seed?: number;
  /** Keep every run in the output (default false: aggregate only). */
  keepRuns?: boolean;
  /** Keep an event trace for the first run. */
  trace?: boolean;
}

export interface NodeStats {
  id: string;
  order: number;
  /** Fraction of runs that reached the node. */
  reachRate: number;
  minute: Summary | null;
  actions: Summary | null;
  /** Minutes since the previous node, over runs that reached both. */
  deltaMinute: Summary | null;
}

export interface ResourceStats {
  id: string;
  final: Summary;
  produced: Summary;
  consumed: Summary;
  overflow: Summary;
  /** Mean totals per source/sink across runs. */
  topSources: { source: string; mean: number }[];
  topSinks: { sink: string; mean: number }[];
  /** produced - consumed per in-game hour (mean over runs). */
  netPerHour: number;
}

export interface SimulationResult {
  policy: { id: string; implicit: boolean; actions: string[] };
  mode: SimMode;
  runs: number;
  seed: number | null;
  limits: SimLimits;
  stopReasons: Partial<Record<StopReason, number>>;
  completionRate: number;
  minutes: Summary;
  minutesWaiting: Summary;
  nodes: NodeStats[];
  resources: ResourceStats[];
  actionUsage: { id: string; mean: number }[];
  /** Most frequent blocker description over stuck runs. */
  stuck: { count: number; examples: Blocker[] } | null;
  /** Where runs ended without completing the track: next node + most common reason, by frequency. */
  stalls: { node: string; runs: number; exampleReasons: string[] }[];
  runResults?: RunResult[];
  trace?: RunResult["trace"];
}

export function runSimulation(model: GameModel, opts: SimulationOptions): SimulationResult {
  const { policy, implicit } = resolvePolicy(model, opts.policy);
  const mc = opts.mode === "monte-carlo";
  const runs = mc ? opts.runs ?? 1000 : 1;
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new UsageError(`runs must be an integer in [1, ${MAX_RUNS}].`);
  const seed = mc ? opts.seed ?? 1 : null;
  if (mc && !Number.isInteger(seed)) throw new UsageError("seed must be an integer.");
  if (!(opts.limits.maxMinutes > 0) || !(opts.limits.maxActions > 0)) throw new UsageError("limits must be positive.");

  const results: RunResult[] = [];
  for (let i = 0; i < runs; i++) {
    const rng = mc ? createRng(deriveSeed(seed!, i)) : null;
    results.push(simulateRun(model, policy, opts.limits, opts.mode, rng, !!opts.trace && i === 0));
  }

  const out: SimulationResult = {
    policy: { id: policy.id, implicit, actions: policy.actions },
    mode: opts.mode,
    runs,
    seed,
    limits: opts.limits,
    ...aggregate(model, results),
  };
  if (opts.keepRuns) out.runResults = results.map(({ trace: _t, ...r }) => r);
  if (opts.trace) out.trace = results[0]!.trace;
  return out;
}

function aggregate(model: GameModel, results: RunResult[]) {
  const n = results.length;
  const stopReasons: Partial<Record<StopReason, number>> = {};
  for (const r of results) stopReasons[r.stopReason] = (stopReasons[r.stopReason] ?? 0) + 1;

  const sorted = [...model.progression].sort((a, b) => a.order - b.order);
  const nodes: NodeStats[] = sorted.map((node, idx) => {
    const reached = results.map((r) => r.nodes[node.id]).filter((x): x is NonNullable<typeof x> => !!x);
    const prev = sorted[idx - 1];
    const deltas = prev
      ? results.flatMap((r) => {
          const a = r.nodes[prev.id];
          const b = r.nodes[node.id];
          return a && b ? [b.minute - a.minute] : [];
        })
      : [];
    return {
      id: node.id,
      order: node.order,
      reachRate: round(reached.length / n),
      minute: summarize(reached.map((x) => x.minute)),
      actions: summarize(reached.map((x) => x.actions)),
      deltaMinute: prev ? summarize(deltas) : null,
    };
  });

  const resources: ResourceStats[] = model.resources.map((res) => {
    const produced = results.map((r) => sum(r.flows[res.id]!.produced));
    const consumed = results.map((r) => sum(r.flows[res.id]!.consumed));
    const minutes = results.map((r) => r.minutes);
    const net = results.map((_, i) => (minutes[i]! > 0 ? ((produced[i]! - consumed[i]!) / minutes[i]!) * 60 : 0));
    return {
      id: res.id,
      final: summarize(results.map((r) => r.finalResources[res.id] ?? 0))!,
      produced: summarize(produced)!,
      consumed: summarize(consumed)!,
      overflow: summarize(results.map((r) => r.flows[res.id]!.overflow))!,
      topSources: meanBreakdown(results.map((r) => r.flows[res.id]!.produced), n).map(([source, mean]) => ({ source, mean })),
      topSinks: meanBreakdown(results.map((r) => r.flows[res.id]!.consumed), n).map(([sink, mean]) => ({ sink, mean })),
      netPerHour: round(net.reduce((a, b) => a + b, 0) / n),
    };
  });

  const actionUsage = model.actions.map((a) => ({ id: a.id, mean: round(results.reduce((s, r) => s + (r.actionCounts[a.id] ?? 0), 0) / n) }));

  const stuckRuns = results.filter((r) => r.stopReason === "stuck");
  const completed = stopReasons.completed ?? 0;
  const stallMap = new Map<string, { runs: number; exampleReasons: string[] }>();
  for (const r of results) {
    if (!r.nextNode) continue;
    const node = r.nextNode.target.replace(/^node:/, "");
    const e = stallMap.get(node) ?? { runs: 0, exampleReasons: r.nextNode.reasons };
    e.runs++;
    stallMap.set(node, e);
  }
  const stalls = [...stallMap.entries()].map(([node, v]) => ({ node, ...v })).sort((a, b) => b.runs - a.runs);

  return {
    stopReasons,
    completionRate: round(completed / n),
    minutes: summarize(results.map((r) => r.minutes))!,
    minutesWaiting: summarize(results.map((r) => r.minutesWaiting))!,
    nodes,
    resources,
    actionUsage,
    stuck: stuckRuns.length ? { count: stuckRuns.length, examples: stuckRuns[0]!.blockers ?? [] } : null,
    stalls,
  };
}

function sum(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}

function meanBreakdown(recs: Record<string, number>[], n: number): [string, number][] {
  const acc = new Map<string, number>();
  for (const r of recs) for (const [k, v] of Object.entries(r)) acc.set(k, (acc.get(k) ?? 0) + v);
  return [...acc.entries()].map(([k, v]) => [k, round(v / n)] as [string, number]).sort((a, b) => b[1] - a[1]);
}
