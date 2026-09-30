import type { Action, Condition, GameModel, Outcome, Policy, ProgressionNode, Quantity, ResourceAmount } from "../schema/types.js";
import type { Rng } from "./rng.js";

export type SimMode = "expected" | "monte-carlo";

export interface SimLimits {
  /** Stop when in-game clock would exceed this many minutes. */
  maxMinutes: number;
  /** Stop after this many actions. */
  maxActions: number;
  /** Stop once the final progression node is reached. Default true. */
  stopOnComplete?: boolean;
}

export type StopReason = "completed" | "time_limit" | "action_limit" | "stuck";

export interface Blocker {
  /** "action:<id>" or "node:<id>" */
  target: string;
  reasons: string[];
}

export interface NodeReach {
  minute: number;
  actions: number;
}

export interface ResourceFlow {
  produced: Record<string, number>;
  consumed: Record<string, number>;
  /** Amount discarded because of Resource.max. */
  overflow: number;
}

export interface RunResult {
  stopReason: StopReason;
  minutes: number;
  actions: number;
  /** null = not reached within limits. */
  nodes: Record<string, NodeReach | null>;
  finalResources: Record<string, number>;
  flows: Record<string, ResourceFlow>;
  actionCounts: Record<string, number>;
  minutesWaiting: number;
  /** Present when stopReason === "stuck". */
  blockers?: Blocker[];
  /** When the track was not completed: the next node and why it was not reached at the end of the run. */
  nextNode?: Blocker;
  trace?: TraceEvent[];
}

export type TraceEvent =
  | { t: number; kind: "action"; id: string }
  | { t: number; kind: "wait"; minutes: number }
  | { t: number; kind: "node"; id: string };

const EPS = 1e-9;

/**
 * Run one progression simulation. Pure function of (model, policy, limits, mode, rng).
 * Model must already be validated.
 */
export function simulateRun(model: GameModel, policy: Policy, limits: SimLimits, mode: SimMode, rng: Rng | null, trace = false): RunResult {
  if (mode === "monte-carlo" && !rng) throw new Error("monte-carlo mode requires an rng");
  return new Run(model, policy, limits, mode, rng, trace).execute();
}

class Run {
  private amounts = new Map<string, number>();
  private max = new Map<string, number>();
  private regen = new Map<string, number>();
  private clock = 0;
  private actionsDone = 0;
  private waiting = 0;
  private uses = new Map<string, number>();
  private reached = new Set<string>();
  private nodeReach: Record<string, NodeReach | null> = {};
  private flows: Record<string, ResourceFlow> = {};
  private nodes: ProgressionNode[];
  private nextNodeIdx = 0;
  private actions: Action[];
  private events: TraceEvent[] = [];

  constructor(
    private model: GameModel,
    policy: Policy,
    private limits: SimLimits,
    private mode: SimMode,
    private rng: Rng | null,
    private trace: boolean,
  ) {
    for (const r of model.resources) {
      this.amounts.set(r.id, r.initial ?? 0);
      if (r.max !== undefined) this.max.set(r.id, r.max);
      if (r.regenPerMinute) this.regen.set(r.id, r.regenPerMinute);
      this.flows[r.id] = { produced: {}, consumed: {}, overflow: 0 };
    }
    this.nodes = [...model.progression].sort((a, b) => a.order - b.order);
    for (const n of this.nodes) this.nodeReach[n.id] = null;
    const byId = new Map(model.actions.map((a) => [a.id, a]));
    this.actions = policy.actions.map((id) => {
      const a = byId.get(id);
      if (!a) throw new Error(`Policy "${policy.id}" references unknown action "${id}"`);
      return a;
    });
  }

  execute(): RunResult {
    let stop: StopReason;
    let blockers: Blocker[] | undefined;
    for (;;) {
      this.advanceProgression();
      if (this.nextNodeIdx >= this.nodes.length && this.nodes.length > 0 && this.limits.stopOnComplete !== false) {
        stop = "completed";
        break;
      }
      if (this.actionsDone >= this.limits.maxActions) {
        stop = "action_limit";
        break;
      }
      const action = this.actions.find((a) => this.canPerform(a) && this.clock + a.durationMinutes <= this.limits.maxMinutes + EPS);
      if (action) {
        this.perform(action);
        continue;
      }
      // Nothing is available now: can waiting for regeneration help?
      const wait = this.minWaitToProgress();
      if (Number.isFinite(wait) && wait > 0) {
        if (this.clock + wait > this.limits.maxMinutes + EPS) {
          stop = "time_limit";
          break;
        }
        this.passTime(wait);
        this.waiting += wait;
        if (this.trace) this.events.push({ t: this.clock, kind: "wait", minutes: wait });
        continue;
      }
      // An action exists but does not fit in the remaining time.
      if (this.actions.some((a) => this.canPerform(a))) {
        stop = "time_limit";
        break;
      }
      stop = "stuck";
      blockers = this.explainBlockers();
      break;
    }

    const res: RunResult = {
      stopReason: stop,
      minutes: this.clock,
      actions: this.actionsDone,
      nodes: this.nodeReach,
      finalResources: Object.fromEntries(this.amounts),
      flows: this.flows,
      actionCounts: Object.fromEntries(this.model.actions.map((a) => [a.id, this.uses.get(a.id) ?? 0])),
      minutesWaiting: this.waiting,
    };
    if (blockers) res.blockers = blockers;
    const pending = this.nodes[this.nextNodeIdx];
    if (pending) res.nextNode = { target: `node:${pending.id}`, reasons: this.reasons(pending.requirements, pending.costs) };
    if (this.trace) res.trace = this.events;
    return res;
  }

  // ---- progression ----------------------------------------------------------

  private advanceProgression() {
    while (this.nextNodeIdx < this.nodes.length) {
      const n = this.nodes[this.nextNodeIdx]!;
      if (!this.conditionsHold(n.requirements) || !this.affordable(n.costs)) return;
      this.pay(n.costs, `node:${n.id}`);
      this.reached.add(n.id);
      this.nodeReach[n.id] = { minute: this.clock, actions: this.actionsDone };
      if (this.trace) this.events.push({ t: this.clock, kind: "node", id: n.id });
      this.nextNodeIdx++;
    }
  }

  // ---- actions --------------------------------------------------------------

  private canPerform(a: Action): boolean {
    if (a.maxUses !== undefined && (this.uses.get(a.id) ?? 0) >= a.maxUses) return false;
    return this.conditionsHold(a.requires) && this.affordable(a.costs);
  }

  private perform(a: Action) {
    this.pay(a.costs, `action:${a.id}`);
    this.passTime(a.durationMinutes);
    for (const o of a.outcomes ?? []) this.applyOutcome(o, `action:${a.id}`);
    this.uses.set(a.id, (this.uses.get(a.id) ?? 0) + 1);
    this.actionsDone++;
    if (this.trace) this.events.push({ t: this.clock, kind: "action", id: a.id });
  }

  private applyOutcome(o: Outcome, src: string) {
    if (o.type === "resource") {
      const p = o.probability ?? 1;
      if (this.mode === "expected") {
        this.gain(o.resource, meanOf(o.amount) * p, src);
      } else if (p >= 1 || this.rng!.next() < p) {
        this.gain(o.resource, this.roll(o.amount), src);
      }
      return;
    }
    const total = o.entries.reduce((s, e) => s + e.weight, 0);
    if (this.mode === "expected") {
      for (const e of o.entries) for (const ro of e.outcomes) {
        this.gain(ro.resource, meanOf(ro.amount) * (ro.probability ?? 1) * (e.weight / total), src);
      }
      return;
    }
    let pick = this.rng!.next() * total;
    let chosen = o.entries[o.entries.length - 1]!;
    for (const e of o.entries) {
      pick -= e.weight;
      if (pick < 0) {
        chosen = e;
        break;
      }
    }
    for (const ro of chosen.outcomes) this.applyOutcome(ro, src);
  }

  private roll(q: Quantity): number {
    if (typeof q === "number") return q;
    const r = this.rng!.next();
    if (Number.isInteger(q.min) && Number.isInteger(q.max)) return q.min + Math.floor(r * (q.max - q.min + 1));
    return q.min + r * (q.max - q.min);
  }

  // ---- resources ------------------------------------------------------------

  private gain(res: string, amount: number, src: string) {
    if (amount <= 0) return;
    const cur = this.amounts.get(res) ?? 0;
    const cap = this.max.get(res) ?? Infinity;
    const next = Math.min(cur + amount, cap);
    const added = next - cur;
    const flow = this.flows[res]!;
    if (added > 0) flow.produced[src] = (flow.produced[src] ?? 0) + added;
    if (amount - added > EPS) flow.overflow += amount - added;
    this.amounts.set(res, next);
  }

  private pay(costs: ResourceAmount[] | undefined, sink: string) {
    for (const c of costs ?? []) {
      if (c.amount <= 0) continue;
      const cur = this.amounts.get(c.resource) ?? 0;
      this.amounts.set(c.resource, Math.max(0, cur - c.amount));
      const flow = this.flows[c.resource]!;
      flow.consumed[sink] = (flow.consumed[sink] ?? 0) + c.amount;
    }
  }

  private passTime(minutes: number) {
    if (minutes <= 0) return;
    this.clock += minutes;
    for (const [res, rate] of this.regen) this.gain(res, rate * minutes, "regen");
  }

  private affordable(costs: ResourceAmount[] | undefined): boolean {
    // Aggregate duplicate resources in one cost list.
    const need = new Map<string, number>();
    for (const c of costs ?? []) need.set(c.resource, (need.get(c.resource) ?? 0) + c.amount);
    for (const [res, amt] of need) if ((this.amounts.get(res) ?? 0) + EPS < amt) return false;
    return true;
  }

  private conditionsHold(conds: Condition[] | undefined): boolean {
    for (const c of conds ?? []) {
      if (c.type === "node") {
        if (!this.reached.has(c.node)) return false;
      } else {
        const v = this.amounts.get(c.resource) ?? 0;
        if (c.gte !== undefined && v + EPS < c.gte) return false;
        if (c.lte !== undefined && v - EPS > c.lte) return false;
      }
    }
    return true;
  }

  // ---- waiting & diagnostics --------------------------------------------------

  /** Minutes of pure regeneration needed before some policy action or the next node becomes possible. */
  private minWaitToProgress(): number {
    let best = Infinity;
    for (const a of this.actions) {
      if (a.maxUses !== undefined && (this.uses.get(a.id) ?? 0) >= a.maxUses) continue;
      best = Math.min(best, this.waitFor(a.requires, a.costs));
    }
    const n = this.nodes[this.nextNodeIdx];
    if (n) best = Math.min(best, this.waitFor(n.requirements, n.costs));
    return best;
  }

  private waitFor(conds: Condition[] | undefined, costs: ResourceAmount[] | undefined): number {
    const need = new Map<string, number>();
    for (const c of costs ?? []) need.set(c.resource, (need.get(c.resource) ?? 0) + c.amount);
    for (const c of conds ?? []) {
      if (c.type === "node") {
        if (!this.reached.has(c.node)) return Infinity;
        continue;
      }
      if (c.lte !== undefined) {
        // Regen only increases amounts, so an lte that fails now never becomes true by waiting.
        if ((this.amounts.get(c.resource) ?? 0) - EPS > c.lte) return Infinity;
      }
      if (c.gte !== undefined) need.set(c.resource, Math.max(need.get(c.resource) ?? 0, c.gte));
    }
    let t = 0;
    for (const [res, amt] of need) {
      const have = this.amounts.get(res) ?? 0;
      if (have + EPS >= amt) continue;
      const rate = this.regen.get(res) ?? 0;
      const cap = this.max.get(res) ?? Infinity;
      if (rate <= 0 || cap + EPS < amt) return Infinity;
      t = Math.max(t, (amt - have) / rate);
    }
    // lte conditions could be broken by regen during the wait; re-checked after waiting.
    return t;
  }

  private explainBlockers(): Blocker[] {
    const out: Blocker[] = [];
    const n = this.nodes[this.nextNodeIdx];
    if (n) out.push({ target: `node:${n.id}`, reasons: this.reasons(n.requirements, n.costs) });
    for (const a of this.actions) {
      const reasons: string[] = [];
      if (a.maxUses !== undefined && (this.uses.get(a.id) ?? 0) >= a.maxUses) reasons.push(`maxUses ${a.maxUses} exhausted`);
      reasons.push(...this.reasons(a.requires, a.costs));
      if (this.clock + a.durationMinutes > this.limits.maxMinutes + EPS) reasons.push(`needs ${a.durationMinutes} min but only ${fmt(this.limits.maxMinutes - this.clock)} remain`);
      out.push({ target: `action:${a.id}`, reasons });
    }
    return out;
  }

  private reasons(conds: Condition[] | undefined, costs: ResourceAmount[] | undefined): string[] {
    const r: string[] = [];
    for (const c of conds ?? []) {
      if (c.type === "node") {
        if (!this.reached.has(c.node)) r.push(`requires node ${c.node}`);
      } else {
        const v = this.amounts.get(c.resource) ?? 0;
        if (c.gte !== undefined && v + EPS < c.gte) r.push(`requires ${c.resource} >= ${c.gte} (have ${fmt(v)})`);
        if (c.lte !== undefined && v - EPS > c.lte) r.push(`requires ${c.resource} <= ${c.lte} (have ${fmt(v)})`);
      }
    }
    for (const c of costs ?? []) {
      const v = this.amounts.get(c.resource) ?? 0;
      if (v + EPS < c.amount) r.push(`costs ${c.resource} ${c.amount} (have ${fmt(v)})`);
    }
    return r;
  }
}

export function meanOf(q: Quantity): number {
  return typeof q === "number" ? q : (q.min + q.max) / 2;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
