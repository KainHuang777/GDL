import type { Action, Condition, GameModel, Outcome, ResourceAmount } from "../schema/types.js";

/**
 * Static (policy-independent) reachability.
 *
 * Computes an UPPER BOUND on what the rules allow:
 * - "unreachable" is a proof that no policy can reach the target under the model.
 * - "possibly_reachable" means no structural obstacle was found; it is NOT a guarantee
 *   (amounts, ordering and costs across multiple steps are only partly considered).
 */
export type Reachability = "possibly_reachable" | "unreachable";

export interface ReachabilityEntry {
  target: string;
  status: Reachability;
  reasons: string[];
}

export interface ReachabilityReport {
  nodes: ReachabilityEntry[];
  actions: ReachabilityEntry[];
  /** Per resource: max obtainable amount (Infinity serialised as null = unbounded). */
  supply: Record<string, number | null>;
}

export function analyzeReachability(model: GameModel): ReachabilityReport {
  const nodes = [...model.progression].sort((a, b) => a.order - b.order);
  const availableActions = new Set<string>();
  const reachableNodes = new Set<string>();
  let supply = computeSupply(model, availableActions);

  // Fixpoint: unlock actions / nodes until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of model.actions) {
      if (availableActions.has(a.id)) continue;
      if (blockers(a.requires, a.costs, supply, reachableNodes, model).length === 0) {
        availableActions.add(a.id);
        changed = true;
      }
    }
    for (const n of nodes) {
      if (reachableNodes.has(n.id)) continue;
      // Linear track: must reach every previous node first.
      if (!nodes.slice(0, nodes.indexOf(n)).every((p) => reachableNodes.has(p.id))) break;
      if (blockers(n.requirements, n.costs, supply, reachableNodes, model).length === 0) {
        reachableNodes.add(n.id);
        changed = true;
      } else break;
    }
    if (changed) supply = computeSupply(model, availableActions);
  }

  const nodeEntries: ReachabilityEntry[] = nodes.map((n, idx) => {
    if (reachableNodes.has(n.id)) return { target: n.id, status: "possibly_reachable", reasons: [] };
    const prev = nodes[idx - 1];
    const own = blockers(n.requirements, n.costs, supply, reachableNodes, model);
    const reasons = prev && !reachableNodes.has(prev.id) && own.length === 0 ? [`previous node ${prev.id} is unreachable`] : own;
    if (prev && !reachableNodes.has(prev.id) && own.length > 0) reasons.push(`previous node ${prev.id} is unreachable`);
    return { target: n.id, status: "unreachable", reasons };
  });

  const actionEntries: ReachabilityEntry[] = model.actions.map((a) =>
    availableActions.has(a.id)
      ? { target: a.id, status: "possibly_reachable", reasons: [] }
      : { target: a.id, status: "unreachable", reasons: blockers(a.requires, a.costs, supply, reachableNodes, model) },
  );

  return {
    nodes: nodeEntries,
    actions: actionEntries,
    supply: Object.fromEntries([...supply].map(([k, v]) => [k, Number.isFinite(v) ? v : null])),
  };
}

function blockers(conds: Condition[] | undefined, costs: ResourceAmount[] | undefined, supply: Map<string, number>, reached: Set<string>, model: GameModel): string[] {
  const out: string[] = [];
  const cap = new Map(model.resources.map((r) => [r.id, r.max ?? Infinity]));
  const check = (res: string, need: number, what: string) => {
    const s = supply.get(res) ?? 0;
    const c = cap.get(res) ?? Infinity;
    if (need > c) out.push(`${what} ${res} ${need} exceeds resource max ${c}`);
    else if (need > s + 1e-9) out.push(`${what} ${res} ${need} but at most ${fmt(s)} is obtainable`);
  };
  for (const c of conds ?? []) {
    if (c.type === "node") {
      if (!reached.has(c.node)) out.push(`requires node ${c.node}`);
    } else if (c.gte !== undefined) check(c.resource, c.gte, "requires");
  }
  for (const c of costs ?? []) check(c.resource, c.amount, "costs");
  return out;
}

/** Upper bound of obtainable amount per resource given the currently available actions. */
function computeSupply(model: GameModel, available: Set<string>): Map<string, number> {
  const s = new Map<string, number>();
  for (const r of model.resources) s.set(r.id, r.regenPerMinute && r.regenPerMinute > 0 ? Infinity : r.initial ?? 0);
  for (const a of model.actions) {
    if (!available.has(a.id)) continue;
    for (const [res, maxAmt] of maxYield(a)) {
      if (maxAmt <= 0) continue;
      const add = a.maxUses === undefined ? Infinity : maxAmt * a.maxUses;
      s.set(res, (s.get(res) ?? 0) + add);
    }
  }
  // Resource.max is enforced in blockers(): a single requirement above max is impossible.
  return s;
}

function maxYield(a: Action): Map<string, number> {
  const m = new Map<string, number>();
  const addOut = (o: Outcome) => {
    if (o.type === "resource") {
      if ((o.probability ?? 1) <= 0) return;
      const amt = typeof o.amount === "number" ? o.amount : o.amount.max;
      m.set(o.resource, (m.get(o.resource) ?? 0) + amt);
    } else {
      // Upper bound: best entry per resource.
      const best = new Map<string, number>();
      for (const e of o.entries) {
        const em = new Map<string, number>();
        for (const ro of e.outcomes) {
          if ((ro.probability ?? 1) <= 0) continue;
          const amt = typeof ro.amount === "number" ? ro.amount : ro.amount.max;
          em.set(ro.resource, (em.get(ro.resource) ?? 0) + amt);
        }
        for (const [k, v] of em) best.set(k, Math.max(best.get(k) ?? 0, v));
      }
      for (const [k, v] of best) m.set(k, (m.get(k) ?? 0) + v);
    }
  };
  for (const o of a.outcomes ?? []) addOut(o);
  return m;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
