/**
 * GDL standard Game Model, schema version 0.1.
 *
 * Design decisions (see docs/design-review.md):
 * - Time is ONLY expressed by `Action.durationMinutes`; there is no "time" resource.
 * - Progression is a single linear track ordered by `order`.
 *   `requirements` are checks (not consumed); `costs` are paid on advancing.
 * - `probability` on a resource outcome is an independent roll;
 *   `table` outcomes pick exactly one entry by weight.
 */

/** Optional pointer back to the raw project data an entity was derived from. */
export interface SourceRef {
  file: string;
  /** Free-form locator inside the file, e.g. "row 12" or "$.realms[3]". */
  path?: string;
}

export interface ProjectInfo {
  id: string;
  name?: string;
  genre?: string;
}

/**
 * How a resource behaves for analysis. Default currency.
 * - currency: earned and spent; overflow / hoarding / deficit rules apply.
 * - counter: progress statistics or levels (training time, skill level); never expected to be spent.
 * - crafted: intermediate goods made by actions; waste is judged against what is actually needed.
 */
export type ResourceKind = "currency" | "counter" | "crafted";

export interface Resource {
  id: string;
  name?: string;
  kind?: ResourceKind;
  unit?: string;
  /** Starting amount. Default 0. */
  initial?: number;
  /** Hard cap. Amounts above are discarded and counted as overflow. */
  max?: number;
  /** Continuous regeneration per in-game minute (e.g. stamina). Default 0. */
  regenPerMinute?: number;
  source?: SourceRef;
}

export interface ResourceAmount {
  resource: string;
  amount: number;
}

export type Condition = ResourceCondition | NodeCondition;

/** Check (never consumes) that a resource amount is within bounds. */
export interface ResourceCondition {
  type: "resource";
  resource: string;
  gte?: number;
  lte?: number;
}

/** Check that a progression node has been reached. */
export interface NodeCondition {
  type: "node";
  node: string;
}

/** Fixed number or inclusive range. Integer bounds roll integers; otherwise continuous. */
export type Quantity = number | { min: number; max: number };

export interface ResourceOutcome {
  type: "resource";
  resource: string;
  amount: Quantity;
  /** Independent chance in [0,1]. Default 1. */
  probability?: number;
}

export interface TableEntry {
  weight: number;
  /** Empty list = "nothing drops". */
  outcomes: ResourceOutcome[];
}

export interface TableOutcome {
  type: "table";
  /** Exactly one entry is chosen, weighted. */
  entries: TableEntry[];
}

export type Outcome = ResourceOutcome | TableOutcome;

export interface Action {
  id: string;
  name?: string;
  /** In-game minutes consumed by performing the action once. */
  durationMinutes: number;
  costs?: ResourceAmount[];
  /** All must hold for the action to be available. */
  requires?: Condition[];
  outcomes?: Outcome[];
  /** Maximum times this action may be performed in one run (e.g. one-off upgrades). */
  maxUses?: number;
  source?: SourceRef;
}

export interface ProgressionNode {
  id: string;
  name?: string;
  order: number;
  requirements?: Condition[];
  costs?: ResourceAmount[];
  source?: SourceRef;
}

/** Performs the first available action in `actions` order; waits for regen if none is available. */
export interface PriorityPolicy {
  id: string;
  type: "priority";
  description?: string;
  actions: string[];
}

/**
 * Decides at every step from the CURRENT state instead of following a fixed order.
 * Candidates = legal actions (affordable, requirements met, fits in remaining time) from `actions` (default: all).
 * Each candidate is scored by how much it advances the next progression node; the best one is played.
 * - lookaheadMinutes > 0: score = progress gained after `lookaheadMinutes` of play that starts with the candidate,
 *   continued by the greedy rule in expected-value mode (handles "invest first" actions such as buying a tool).
 * - lookaheadMinutes = 0: one-step greedy, progress per minute (cheap, but never invests).
 * - temperature = 0: always the best candidate (deterministic). > 0 (monte-carlo only): sampled among candidates,
 *   weight = exp((score / bestScore - 1) / temperature), i.e. "10% worse" is e^-1 as likely at temperature 0.1.
 */
export interface AdaptivePolicy {
  id: string;
  type: "adaptive";
  description?: string;
  /** Candidate pool and tie-break order. Default: every action in declaration order. */
  actions?: string[];
  /** Only "progress-rate" in v0.1. */
  objective?: "progress-rate";
  /** >= 0. Default 0. Ignored in expected mode (always deterministic). */
  temperature?: number;
  /** >= 0 in-game minutes. Default 120. */
  lookaheadMinutes?: number;
}

export type Policy = PriorityPolicy | AdaptivePolicy;

/** Adapter-declared gameplay that is intentionally NOT modelled. Surfaced in every report. */
export interface UnsupportedFeature {
  feature: string;
  reason: string;
  /** Resource ids whose numbers are unreliable because this gameplay is not modelled. */
  affects?: string[];
}

export interface GameModel {
  schemaVersion: string;
  project: ProjectInfo;
  resources: Resource[];
  actions: Action[];
  progression: ProgressionNode[];
  policies?: Policy[];
  unsupported?: UnsupportedFeature[];
  /** Free-form, ignored by the engine. */
  meta?: Record<string, unknown>;
}
