import type { GameModel, Policy } from "../schema/types.js";

export const DEFAULT_POLICY_ID = "default";

/**
 * Resolve a policy by id. When the model defines no policies and id is omitted/"default",
 * a priority policy over all actions in declaration order is used and flagged as implicit.
 */
export function resolvePolicy(model: GameModel, id?: string): { policy: Policy; implicit: boolean } {
  const policies = model.policies ?? [];
  if (id && id !== DEFAULT_POLICY_ID) {
    const p = policies.find((x) => x.id === id);
    if (!p) {
      const known = policies.map((x) => x.id).join(", ") || "(none)";
      throw new UsageError(`Unknown policy "${id}". Available: ${known}.`);
    }
    return { policy: p, implicit: false };
  }
  const explicitDefault = policies.find((x) => x.id === DEFAULT_POLICY_ID) ?? (id ? undefined : policies[0]);
  if (explicitDefault) return { policy: explicitDefault, implicit: false };
  return {
    policy: {
      id: DEFAULT_POLICY_ID,
      type: "priority",
      description: "Implicit: first available action in declaration order.",
      actions: model.actions.map((a) => a.id),
    },
    implicit: true,
  };
}

export const ADAPTIVE_DEFAULTS = { objective: "progress-rate", temperature: 0, lookaheadMinutes: 120 } as const;

/** Action ids the policy may play, in tie-break / priority order. */
export function policyPool(model: GameModel, policy: Policy): string[] {
  return policy.actions ?? model.actions.map((a) => a.id);
}

/** Parameters of an adaptive policy with defaults applied; null for other policy types. */
export function adaptiveParams(policy: Policy): { objective: "progress-rate"; temperature: number; lookaheadMinutes: number } | null {
  if (policy.type !== "adaptive") return null;
  return {
    objective: policy.objective ?? ADAPTIVE_DEFAULTS.objective,
    temperature: policy.temperature ?? ADAPTIVE_DEFAULTS.temperature,
    lookaheadMinutes: policy.lookaheadMinutes ?? ADAPTIVE_DEFAULTS.lookaheadMinutes,
  };
}

/** Error caused by bad CLI/user input (exit code 2), as opposed to data validation (exit code 1). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
