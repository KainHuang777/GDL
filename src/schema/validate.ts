import { SUPPORTED_SCHEMA_VERSIONS } from "../version.js";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  severity: Severity;
  /** Stable machine-readable code, e.g. "REF_NOT_FOUND". */
  code: string;
  /** JSON-path-like location inside the Game Model, e.g. "actions[2].costs[0].resource". */
  path: string;
  message: string;
  /** Suggested fix direction. */
  hint?: string;
  /** Raw project file the offending entity came from, if the adapter provided it. */
  source?: { file: string; path?: string };
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

type Obj = Record<string, unknown>;

const KNOWN_KEYS: Record<string, string[]> = {
  root: ["schemaVersion", "project", "resources", "actions", "progression", "policies", "unsupported", "meta"],
  project: ["id", "name", "genre"],
  resource: ["id", "name", "unit", "initial", "max", "regenPerMinute", "source"],
  action: ["id", "name", "durationMinutes", "costs", "requires", "outcomes", "maxUses", "source"],
  node: ["id", "name", "order", "requirements", "costs", "source"],
  policy: ["id", "type", "description", "actions"],
};

/**
 * Validate an unknown value against the GDL Game Model v0.1.
 * Never throws for bad data; everything is reported as issues.
 */
export function validateModel(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const v = new Validator(issues);
  v.run(input);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { ok: errors.length === 0, errors, warnings };
}

class Validator {
  private resourceIds = new Set<string>();
  private actionIds = new Set<string>();
  private nodeIds = new Set<string>();
  private nodeOrder = new Map<string, number>();
  private currentSource: ValidationIssue["source"];

  constructor(private issues: ValidationIssue[]) {}

  private add(severity: Severity, code: string, path: string, message: string, hint?: string) {
    const issue: ValidationIssue = { severity, code, path, message };
    if (hint) issue.hint = hint;
    if (this.currentSource) issue.source = this.currentSource;
    this.issues.push(issue);
  }
  private err(code: string, path: string, message: string, hint?: string) {
    this.add("error", code, path, message, hint);
  }
  private warn(code: string, path: string, message: string, hint?: string) {
    this.add("warning", code, path, message, hint);
  }

  run(input: unknown) {
    if (!isObj(input)) {
      this.err("NOT_OBJECT", "$", "Game Model must be a JSON object.");
      return;
    }
    this.unknownKeys(input, "root", "$");

    const sv = input.schemaVersion;
    if (typeof sv !== "string") {
      this.err("MISSING_FIELD", "schemaVersion", "schemaVersion is required and must be a string.", `Use "${SUPPORTED_SCHEMA_VERSIONS[0]}".`);
    } else if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(sv)) {
      this.err("UNKNOWN_SCHEMA_VERSION", "schemaVersion", `Unsupported schemaVersion "${sv}".`, `Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}.`);
    }

    if (!isObj(input.project)) {
      this.err("MISSING_FIELD", "project", "project is required and must be an object.");
    } else {
      this.unknownKeys(input.project, "project", "project");
      if (!isNonEmptyString(input.project.id)) this.err("MISSING_FIELD", "project.id", "project.id must be a non-empty string.");
    }

    const resources = this.array(input, "resources", true);
    const actions = this.array(input, "actions", true);
    const progression = this.array(input, "progression", true);
    const policies = this.array(input, "policies", false);
    const unsupported = this.array(input, "unsupported", false);

    // Pass 1: collect ids (so forward references work).
    this.collectIds(resources, "resources", this.resourceIds);
    this.collectIds(actions, "actions", this.actionIds);
    this.collectIds(progression, "progression", this.nodeIds);
    progression.forEach((n) => {
      if (isObj(n) && typeof n.id === "string" && isFiniteNum(n.order)) this.nodeOrder.set(n.id, n.order);
    });

    // Pass 2: per-entity checks.
    resources.forEach((r, i) => this.withSource(r, () => this.resource(r, `resources[${i}]`)));
    actions.forEach((a, i) => this.withSource(a, () => this.action(a, `actions[${i}]`)));
    this.progression(progression);
    policies.forEach((p, i) => this.policy(p, `policies[${i}]`));
    unsupported.forEach((u, i) => {
      if (!isObj(u) || !isNonEmptyString(u.feature) || !isNonEmptyString(u.reason)) {
        this.err("INVALID_FIELD", `unsupported[${i}]`, "unsupported entries need non-empty 'feature' and 'reason' strings.");
      }
    });

    if (this.errorsSoFar() === 0) this.staticFlowChecks(input);
  }

  private errorsSoFar() {
    return this.issues.filter((i) => i.severity === "error").length;
  }

  private withSource(entity: unknown, fn: () => void) {
    const prev = this.currentSource;
    if (isObj(entity) && isObj(entity.source) && typeof entity.source.file === "string") {
      this.currentSource = { file: entity.source.file };
      if (typeof entity.source.path === "string") this.currentSource.path = entity.source.path;
    }
    fn();
    this.currentSource = prev;
  }

  private array(obj: Obj, key: string, required: boolean): unknown[] {
    const val = obj[key];
    if (val === undefined) {
      if (required) this.err("MISSING_FIELD", key, `${key} is required and must be an array.`);
      return [];
    }
    if (!Array.isArray(val)) {
      this.err("INVALID_TYPE", key, `${key} must be an array.`);
      return [];
    }
    return val;
  }

  private unknownKeys(obj: Obj, kind: keyof typeof KNOWN_KEYS, path: string) {
    const known = KNOWN_KEYS[kind]!;
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) {
        const hint = k === "time_minutes" || k === "duration" ? "Time is expressed only by actions[].durationMinutes." : `Known fields: ${known.join(", ")}.`;
        this.warn("UNKNOWN_FIELD", path === "$" ? k : `${path}.${k}`, `Unknown field "${k}" is ignored.`, hint);
      }
    }
  }

  private collectIds(list: unknown[], key: string, into: Set<string>) {
    list.forEach((item, i) => {
      const p = `${key}[${i}]`;
      if (!isObj(item)) {
        this.err("INVALID_TYPE", p, "Entry must be an object.");
        return;
      }
      if (!isNonEmptyString(item.id)) {
        this.err("MISSING_FIELD", `${p}.id`, "id must be a non-empty string.");
        return;
      }
      if (into.has(item.id)) {
        this.withSource(item, () => this.err("DUPLICATE_ID", `${p}.id`, `Duplicate id "${item.id}" in ${key}.`, "Ids must be unique within their collection."));
      }
      into.add(item.id);
    });
  }

  private resource(r: unknown, p: string) {
    if (!isObj(r)) return;
    this.unknownKeys(r, "resource", p);
    this.optNonNegative(r, "initial", p);
    this.optNonNegative(r, "regenPerMinute", p);
    if (r.max !== undefined) {
      if (!isFiniteNum(r.max) || r.max <= 0) this.err("INVALID_NUMBER", `${p}.max`, "max must be a positive number.");
      else if (isFiniteNum(r.initial) && r.initial > r.max) this.err("INITIAL_EXCEEDS_MAX", `${p}.initial`, `initial (${r.initial}) exceeds max (${r.max}).`);
    }
    if (typeof r.id === "string" && /time|minute|hour|second/i.test(r.id)) {
      this.warn("TIME_AS_RESOURCE", `${p}.id`, `Resource "${r.id}" looks like a time resource.`, "Time should be modelled with actions[].durationMinutes to avoid double counting.");
    }
  }

  private action(a: unknown, p: string) {
    if (!isObj(a)) return;
    this.unknownKeys(a, "action", p);
    if (!isFiniteNum(a.durationMinutes) || a.durationMinutes < 0) {
      this.err("INVALID_NUMBER", `${p}.durationMinutes`, "durationMinutes is required and must be a number >= 0.");
    }
    if (a.maxUses !== undefined && !(Number.isInteger(a.maxUses) && (a.maxUses as number) >= 1)) {
      this.err("INVALID_NUMBER", `${p}.maxUses`, "maxUses must be an integer >= 1.");
    }
    this.amounts(a.costs, `${p}.costs`);
    this.conditions(a.requires, `${p}.requires`, undefined);
    this.outcomes(a.outcomes, `${p}.outcomes`);
    const costs = Array.isArray(a.costs) ? a.costs : [];
    if (a.durationMinutes === 0 && costs.length === 0 && a.maxUses === undefined) {
      this.warn("FREE_INFINITE_ACTION", p, "Action takes 0 minutes, costs nothing and has no maxUses.", "The simulator will be bounded only by --max-actions. Add a duration, cost or maxUses.");
    }
    if (!Array.isArray(a.outcomes) || a.outcomes.length === 0) {
      this.warn("NO_OUTCOMES", `${p}.outcomes`, "Action has no outcomes.");
    }
  }

  private amounts(list: unknown, p: string) {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      this.err("INVALID_TYPE", p, "Must be an array of { resource, amount }.");
      return;
    }
    list.forEach((c, i) => {
      const cp = `${p}[${i}]`;
      if (!isObj(c)) return this.err("INVALID_TYPE", cp, "Must be an object { resource, amount }.");
      this.resourceRef(c.resource, `${cp}.resource`);
      if (!isFiniteNum(c.amount) || c.amount < 0) this.err("INVALID_NUMBER", `${cp}.amount`, "amount must be a number >= 0.", "Negative costs are not allowed; model gains as outcomes.");
    });
  }

  private conditions(list: unknown, p: string, ownerNodeOrder: number | undefined) {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      this.err("INVALID_TYPE", p, "Must be an array of conditions.");
      return;
    }
    list.forEach((c, i) => {
      const cp = `${p}[${i}]`;
      if (!isObj(c)) return this.err("INVALID_TYPE", cp, "Condition must be an object.");
      if (c.type === "resource") {
        this.resourceRef(c.resource, `${cp}.resource`);
        if (c.gte === undefined && c.lte === undefined) this.err("MISSING_FIELD", cp, "Resource condition needs 'gte' and/or 'lte'.");
        if (c.gte !== undefined && (!isFiniteNum(c.gte) || c.gte < 0)) this.err("INVALID_NUMBER", `${cp}.gte`, "gte must be a number >= 0.");
        if (c.lte !== undefined && (!isFiniteNum(c.lte) || c.lte < 0)) this.err("INVALID_NUMBER", `${cp}.lte`, "lte must be a number >= 0.");
        if (isFiniteNum(c.gte) && isFiniteNum(c.lte) && c.gte > c.lte) this.err("INVALID_RANGE", cp, "gte is greater than lte; condition can never hold.");
      } else if (c.type === "node") {
        if (!isNonEmptyString(c.node) || !this.nodeIds.has(c.node)) {
          this.err("REF_NOT_FOUND", `${cp}.node`, `Progression node "${String(c.node)}" does not exist.`, hintFrom(this.nodeIds));
        } else if (ownerNodeOrder !== undefined) {
          const o = this.nodeOrder.get(c.node);
          if (o !== undefined && o >= ownerNodeOrder) {
            this.err("CYCLIC_DEPENDENCY", `${cp}.node`, `Node requires "${c.node}" which is not earlier in the progression track.`, "On a linear track a node can only depend on nodes with a lower order.");
          }
        }
      } else {
        this.err("INVALID_TYPE", `${cp}.type`, `Unknown condition type "${String(c.type)}".`, 'Use "resource" or "node".');
      }
    });
  }

  private outcomes(list: unknown, p: string) {
    if (list === undefined) return;
    if (!Array.isArray(list)) return this.err("INVALID_TYPE", p, "outcomes must be an array.");
    list.forEach((o, i) => {
      const op = `${p}[${i}]`;
      if (!isObj(o)) return this.err("INVALID_TYPE", op, "Outcome must be an object.");
      if (o.type === "resource") this.resourceOutcome(o, op);
      else if (o.type === "table") {
        if (!Array.isArray(o.entries) || o.entries.length === 0) return this.err("MISSING_FIELD", `${op}.entries`, "table outcome needs a non-empty 'entries' array.");
        let total = 0;
        o.entries.forEach((e: unknown, j: number) => {
          const ep = `${op}.entries[${j}]`;
          if (!isObj(e)) return this.err("INVALID_TYPE", ep, "Entry must be an object.");
          if (!isFiniteNum(e.weight) || e.weight <= 0) this.err("INVALID_NUMBER", `${ep}.weight`, "weight must be a number > 0.");
          else total += e.weight;
          if (!Array.isArray(e.outcomes)) return this.err("MISSING_FIELD", `${ep}.outcomes`, "Entry needs an 'outcomes' array (may be empty for 'nothing').");
          e.outcomes.forEach((ro: unknown, k: number) => {
            const rp = `${ep}.outcomes[${k}]`;
            if (!isObj(ro) || ro.type !== "resource") return this.err("INVALID_TYPE", rp, 'Table entries may only contain outcomes of type "resource".');
            this.resourceOutcome(ro, rp);
          });
        });
        if (total > 0 && Math.abs(total - 1) > 1e-9 && Math.abs(total - 100) > 1e-9) {
          this.warn("TABLE_WEIGHTS_NOT_NORMALISED", `${op}.entries`, `Table weights sum to ${total}; they are treated as relative weights.`, "If these were meant to be probabilities, make them sum to 1 (or 100).");
        }
      } else {
        this.err("INVALID_TYPE", `${op}.type`, `Unknown outcome type "${String(o.type)}".`, 'Use "resource" or "table".');
      }
    });
  }

  private resourceOutcome(o: Obj, p: string) {
    this.resourceRef(o.resource, `${p}.resource`);
    this.quantity(o.amount, `${p}.amount`);
    if (o.probability !== undefined && (!isFiniteNum(o.probability) || o.probability < 0 || o.probability > 1)) {
      this.err("INVALID_PROBABILITY", `${p}.probability`, `probability must be within [0, 1], got ${String(o.probability)}.`, "Use a fraction, e.g. 0.25 for 25%.");
    }
    if (o.probability === 0) this.warn("ZERO_PROBABILITY", `${p}.probability`, "Outcome can never happen (probability 0).");
  }

  private quantity(q: unknown, p: string) {
    if (isFiniteNum(q)) {
      if (q < 0) this.err("INVALID_NUMBER", p, "amount must be >= 0.");
      return;
    }
    if (isObj(q) && isFiniteNum(q.min) && isFiniteNum(q.max)) {
      if (q.min < 0) this.err("INVALID_NUMBER", `${p}.min`, "min must be >= 0.");
      if (q.min > q.max) this.err("INVALID_RANGE", p, `min (${q.min}) is greater than max (${q.max}).`);
      return;
    }
    this.err("INVALID_TYPE", p, "amount must be a number or { min, max }.");
  }

  private resourceRef(ref: unknown, p: string) {
    if (!isNonEmptyString(ref) || !this.resourceIds.has(ref)) {
      this.err("REF_NOT_FOUND", p, `Resource "${String(ref)}" does not exist.`, hintFrom(this.resourceIds, ref));
    }
  }

  private progression(list: unknown[]) {
    const orders = new Map<number, string>();
    list.forEach((n, i) =>
      this.withSource(n, () => {
        const p = `progression[${i}]`;
        if (!isObj(n)) return;
        this.unknownKeys(n, "node", p);
        if (!isFiniteNum(n.order)) {
          this.err("MISSING_FIELD", `${p}.order`, "order is required and must be a number.");
        } else if (orders.has(n.order)) {
          this.err("DUPLICATE_ORDER", `${p}.order`, `order ${n.order} is already used by "${orders.get(n.order)}".`, "v0.1 supports a single linear track; orders must be unique.");
        } else orders.set(n.order, String(n.id));
        this.conditions(n.requirements, `${p}.requirements`, isFiniteNum(n.order) ? n.order : undefined);
        this.amounts(n.costs, `${p}.costs`);
      }),
    );
    if (list.length === 0) this.warn("NO_PROGRESSION", "progression", "No progression nodes; progression analysis will be empty.");
  }

  private policy(pol: unknown, p: string) {
    if (!isObj(pol)) return this.err("INVALID_TYPE", p, "Policy must be an object.");
    this.unknownKeys(pol, "policy", p);
    if (!isNonEmptyString(pol.id)) this.err("MISSING_FIELD", `${p}.id`, "Policy id is required.");
    if (pol.type !== "priority") this.err("INVALID_TYPE", `${p}.type`, `Unknown policy type "${String(pol.type)}".`, 'v0.1 supports only "priority".');
    if (!Array.isArray(pol.actions) || pol.actions.length === 0) return this.err("MISSING_FIELD", `${p}.actions`, "Policy needs a non-empty 'actions' array.");
    pol.actions.forEach((a: unknown, i: number) => {
      if (!isNonEmptyString(a) || !this.actionIds.has(a)) this.err("REF_NOT_FOUND", `${p}.actions[${i}]`, `Action "${String(a)}" does not exist.`, hintFrom(this.actionIds, a));
    });
  }

  /** Warnings about resources that can be required but are never produced. Only runs on structurally valid models. */
  private staticFlowChecks(model: Obj) {
    const produced = new Set<string>();
    for (const r of model.resources as Obj[]) {
      if ((isFiniteNum(r.initial) && r.initial > 0) || (isFiniteNum(r.regenPerMinute) && r.regenPerMinute > 0)) produced.add(r.id as string);
    }
    const walk = (outs: unknown) => {
      for (const o of (outs as Obj[]) ?? []) {
        if (o.type === "resource" && o.probability !== 0) produced.add(o.resource as string);
        if (o.type === "table") for (const e of o.entries as Obj[]) walk(e.outcomes);
      }
    };
    for (const a of model.actions as Obj[]) walk(a.outcomes);

    const needed = new Map<string, string>();
    const note = (list: unknown, p: string) =>
      ((list as Obj[]) ?? []).forEach((c, i) => {
        if (typeof c.resource === "string" && (c.amount === undefined ? isFiniteNum(c.gte) && c.gte > 0 : isFiniteNum(c.amount) && c.amount > 0)) {
          if (!needed.has(c.resource)) needed.set(c.resource, `${p}[${i}]`);
        }
      });
    (model.actions as Obj[]).forEach((a, i) => {
      note(a.costs, `actions[${i}].costs`);
      note(a.requires, `actions[${i}].requires`);
    });
    (model.progression as Obj[]).forEach((n, i) => {
      note(n.costs, `progression[${i}].costs`);
      note(n.requirements, `progression[${i}].requirements`);
    });
    for (const [res, where] of needed) {
      if (!produced.has(res)) {
        this.warn("RESOURCE_NEVER_PRODUCED", where, `Resource "${res}" is required but has no initial amount, regen, or producing outcome.`, "Anything gated by it is unreachable unless the adapter is missing a source.");
      }
    }
    const usedResources = new Set<string>([...needed.keys()]);
    for (const r of model.resources as Obj[]) {
      if (!usedResources.has(r.id as string) && !produced.has(r.id as string)) {
        this.warn("UNUSED_RESOURCE", `resources`, `Resource "${String(r.id)}" is never produced nor consumed.`);
      }
    }
  }

  private optNonNegative(obj: Obj, key: string, p: string) {
    const v = obj[key];
    if (v !== undefined && (!isFiniteNum(v) || v < 0)) this.err("INVALID_NUMBER", `${p}.${key}`, `${key} must be a number >= 0.`);
  }
}

function hintFrom(ids: Set<string>, attempted?: unknown): string | undefined {
  if (ids.size === 0) return undefined;
  const list = [...ids];
  if (typeof attempted === "string") {
    const close = list.filter((id) => levenshtein(id, attempted) <= 2);
    if (close.length) return `Did you mean: ${close.join(", ")}?`;
  }
  return `Known ids: ${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}.`;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
