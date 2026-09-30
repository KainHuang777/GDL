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

/** Error caused by bad CLI/user input (exit code 2), as opposed to data validation (exit code 1). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
