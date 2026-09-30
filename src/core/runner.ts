import type { GameModel, Policy, ResourceKind } from "../schema/types.js";
import { adaptiveParams, policyPool, resolvePolicy, UsageError } from "./policy.js";
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
  /** Display name from the model, when provided. */
  name?: string;
  order: number;
  /** Fraction of runs that reached the node. */
  reachRate: number;
  minute: Summary | null;
  actions: Summary | null;
  /** Minutes since the previous node, over runs that reached both. */
  deltaMinute: Summary | null;
  /**
   * What the node's waiting time was spent on (critical-path resource at each wait), mean over
   * runs that reached it, sorted by minutes. Empty when the node needed no waiting.
   */
  limiters: { resource: string; name?: string; minutes: number; share: number }[];
}

export interface ResourceStats {
  id: string;
  /** Display name from the model, when provided. */
  name?: string;
  kind: ResourceKind;
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

/** Crafted goods the policy made but never needed: the resources spent on them were wasted. */
export interface WasteStat {
  /** Action that produced the surplus. */
  action: string;
  actionName?: string;
  /** Crafted resource that piled up. */
  resource: string;
  resourceName?: string;
  /** Mean units made / left unused per run. */
  made: number;
  unused: number;
  unusedShare: number;
  /** Resources spent on the unused units (mean per run) and their share of that resource's total consumption. */
  wastedCosts: { resource: string; name?: string; amount: number; shareOfConsumed: number }[];
}

export interface PolicyInfo {
  id: string;
  type: "priority" | "adaptive";
  implicit: boolean;
  /** Priority order (priority) or candidate pool (adaptive). */
  actions: string[];
  adaptive?: { objective: string; temperature: number; lookaheadMinutes: number };
}

function policyInfo(model: GameModel, policy: Policy, implicit: boolean): PolicyInfo {
  const info: PolicyInfo = { id: policy.id, type: policy.type, implicit, actions: policyPool(model, policy) };
  const ap = adaptiveParams(policy);
  if (ap) info.adaptive = ap;
  return info;
}

export interface SimulationResult {
  policy: PolicyInfo;
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
  actionUsage: { id: string; name?: string; mean: number }[];
  /** Surplus crafting by the policy (kind "crafted" resources). */
  waste: WasteStat[];
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
    policy: policyInfo(model, policy, implicit),
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
    const nodeStats: NodeStats = {
      id: node.id,
      order: node.order,
      reachRate: round(reached.length / n),
      minute: summarize(reached.map((x) => x.minute)),
      actions: summarize(reached.map((x) => x.actions)),
      deltaMinute: prev ? summarize(deltas) : null,
      limiters: nodeLimiters(model, node.id, results),
    };
    if (node.name) nodeStats.name = node.name;
    return nodeStats;
  });

  const resources: ResourceStats[] = model.resources.map((res) => {
    const produced = results.map((r) => sum(r.flows[res.id]!.produced));
    const consumed = results.map((r) => sum(r.flows[res.id]!.consumed));
    const minutes = results.map((r) => r.minutes);
    const net = results.map((_, i) => (minutes[i]! > 0 ? ((produced[i]! - consumed[i]!) / minutes[i]!) * 60 : 0));
    const rs: ResourceStats = {
      id: res.id,
      kind: res.kind ?? "currency",
      final: summarize(results.map((r) => r.finalResources[res.id] ?? 0))!,
      produced: summarize(produced)!,
      consumed: summarize(consumed)!,
      overflow: summarize(results.map((r) => r.flows[res.id]!.overflow))!,
      topSources: meanBreakdown(results.map((r) => r.flows[res.id]!.produced), n).map(([source, mean]) => ({ source, mean })),
      topSinks: meanBreakdown(results.map((r) => r.flows[res.id]!.consumed), n).map(([sink, mean]) => ({ sink, mean })),
      netPerHour: round(net.reduce((a, b) => a + b, 0) / n),
    };
    if (res.name) rs.name = res.name;
    return rs;
  });

  const actionUsage = model.actions.map((a) => ({ id: a.id, ...(a.name ? { name: a.name } : {}), mean: round(results.reduce((s, r) => s + (r.actionCounts[a.id] ?? 0), 0) / n) }));

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
    waste: wasteStats(model, results),
    stuck: stuckRuns.length ? { count: stuckRuns.length, examples: stuckRuns[0]!.blockers ?? [] } : null,
    stalls,
  };
}

/** Mean waiting minutes per critical-path resource while pursuing 
odeId, over runs that reached it. */
function nodeLimiters(model: GameModel, nodeId: string, results: RunResult[]): NodeStats["limiters"] {
  const reached = results.filter((r) => r.nodes[nodeId]);
  if (!reached.length) return [];
  const acc = new Map<string, number>();
  for (const r of reached) for (const [res, min] of Object.entries(r.waitBy[nodeId] ?? {})) acc.set(res, (acc.get(res) ?? 0) + min);
  const total = [...acc.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const names = new Map(model.resources.map((x) => [x.id, x.name]));
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([resource, min]) => {
      const name = names.get(resource);
      return { resource, ...(name ? { name } : {}), minutes: round(min / reached.length), share: round(min / total, 4) };
    });
}

/**
 * Surplus crafting: for each action that outputs a "crafted" resource, units made minus units the run
 * actually consumed or had to hold as a requirement. Costs are apportioned by the unused share.
 */
function wasteStats(model: GameModel, results: RunResult[]): WasteStat[] {
  const n = results.length;
  const kinds = new Map(model.resources.map((r) => [r.id, r.kind ?? "currency"]));
  const resName = new Map(model.resources.map((r) => [r.id, r.name]));
  // Largest amount of a resource that must be held at once (>= conditions on nodes and actions).
  const hold = new Map<string, number>();
  const noteHold = (conds: { type: string; resource?: string; gte?: number }[] | undefined) => {
    for (const c of conds ?? []) if (c.type === "resource" && c.resource && c.gte) hold.set(c.resource, Math.max(hold.get(c.resource) ?? 0, c.gte));
  };
  for (const node of model.progression) noteHold(node.requirements as never);
  for (const a of model.actions) noteHold(a.requires as never);
  const mean = (f: (r: RunResult) => number) => results.reduce((s, r) => s + f(r), 0) / n;
  const out: WasteStat[] = [];
  for (const a of model.actions) {
    const uses = mean((r) => r.actionCounts[a.id] ?? 0);
    if (uses <= 0) continue;
    const outs = new Set<string>();
    const collect = (o: NonNullable<typeof a.outcomes>[number]) => {
      if (o.type === "resource") outs.add(o.resource);
      else for (const e of o.entries) e.outcomes.forEach(collect);
    };
    (a.outcomes ?? []).forEach(collect);
    for (const res of outs) {
      if (kinds.get(res) !== "crafted") continue;
      const key = `action:${a.id}`;
      const made = mean((r) => (r.flows[res]?.produced[key] ?? 0) + (r.flows[res]?.overflowBy[key] ?? 0));
      const consumed = mean((r) => Object.values(r.flows[res]?.consumed ?? {}).reduce((x, y) => x + y, 0));
      const madeAll = mean((r) => Object.values(r.flows[res]?.produced ?? {}).reduce((x, y) => x + y, 0) + (r.flows[res]?.overflow ?? 0));
      if (made <= 0 || madeAll <= 0) continue;
      // Needed = consumed + held requirement; apportion across producing actions by their share of output.
      const needed = Math.min(madeAll, consumed + (hold.get(res) ?? 0));
      const unusedAll = Math.max(0, madeAll - needed);
      const unused = unusedAll * (made / madeAll);
      if (unused < 1e-6) continue;
      const share = unused / made;
      const wastedCosts = (a.costs ?? []).map((c) => {
        const amount = uses * c.amount * share;
        const totalConsumed = mean((r) => Object.values(r.flows[c.resource]?.consumed ?? {}).reduce((x, y) => x + y, 0));
        const name = resName.get(c.resource);
        return { resource: c.resource, ...(name ? { name } : {}), amount: round(amount), shareOfConsumed: totalConsumed > 0 ? round(amount / totalConsumed, 4) : 0 };
      });
      const an = a.name;
      const rn = resName.get(res);
      out.push({ action: a.id, ...(an ? { actionName: an } : {}), resource: res, ...(rn ? { resourceName: rn } : {}), made: round(made), unused: round(unused), unusedShare: round(share, 4), wastedCosts });
    }
  }
  return out.sort((x, y) => y.unusedShare - x.unusedShare);
}

function sum(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}

function meanBreakdown(recs: Record<string, number>[], n: number): [string, number][] {
  const acc = new Map<string, number>();
  for (const r of recs) for (const [k, v] of Object.entries(r)) acc.set(k, (acc.get(k) ?? 0) + v);
  return [...acc.entries()].map(([k, v]) => [k, round(v / n)] as [string, number]).sort((a, b) => b[1] - a[1]);
}
