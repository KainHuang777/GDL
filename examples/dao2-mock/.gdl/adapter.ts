/**
 * Dao2 adapter (MOCK). Maps the invented Dao2-like data in ../data to the GDL standard model.
 *
 * Mapping decisions (all "建議" until the real Dao2 layout is confirmed):
 * - realms[]           -> ProgressionNode (order = tier). expNeeded is a CHECK (cumulative exp,
 *                         not consumed); stoneCost is CONSUMED on breakthrough.
 * - meditation         -> one Action per realm tier (exp scales with tier). Higher tiers listed first
 *                         in the policy so the best available variant is used.
 * - monsters[]         -> Action "fight_<key>", gated by realm tier, costs stamina, drops as
 *                         independent-chance outcomes.
 * - items.qi_pill      -> Action "use_qi_pill".
 * - stamina            -> Resource with max + regen.
 */
import { defineAdapter } from "../../../src/adapter/api.js";
import type { Action, GameModel, ProgressionNode } from "../../../src/schema/types.js";

interface Cultivation {
  player: { stamina: { start: number; cap: number; regenPerHour: number } };
  realms: { key: string; title: string; tier: number; expNeeded: number; stoneCost: number }[];
}
interface Activities {
  meditation: { minutes: number; expPerSession: number; expBonusPerTier: number };
  monsters: { key: string; minTier: number; minutes: number; stamina: number; exp: number; drops: { chance: number; item: string; qty: [number, number] }[] }[];
  items: Record<string, { useMinutes: number; exp: number }>;
}

const CULT = "data/cultivation.json";
const ACT = "data/activities.json";

export default defineAdapter({
  id: "dao2-mock",
  version: "0.1.0",
  apiVersion: "0.1",
  async load(ctx): Promise<GameModel> {
    const cult = await ctx.readJson<Cultivation>(CULT);
    const act = await ctx.readJson<Activities>(ACT);
    const realms = [...cult.realms].sort((a, b) => a.tier - b.tier);
    const realmAtTier = (tier: number) => {
      const r = realms.find((x) => x.tier === tier);
      if (!r) throw new Error(`${ACT}: references realm tier ${tier}, which is not defined in ${CULT}`);
      return r;
    };

    const progression: ProgressionNode[] = realms.map((r, i) => {
      const node: ProgressionNode = { id: `realm_${r.key}`, name: r.title, order: r.tier, source: { file: CULT, path: `$.realms[${i}]` } };
      if (r.expNeeded > 0) node.requirements = [{ type: "resource", resource: "exp", gte: r.expNeeded }];
      if (r.stoneCost > 0) node.costs = [{ resource: "spirit_stone", amount: r.stoneCost }];
      return node;
    });

    const meditate: Action[] = [...realms].reverse().map((r) => ({
      id: `meditate_t${r.tier}`,
      name: `Meditate (${r.title})`,
      durationMinutes: act.meditation.minutes,
      requires: [{ type: "node", node: `realm_${r.key}` }],
      outcomes: [{ type: "resource", resource: "exp", amount: act.meditation.expPerSession * (1 + act.meditation.expBonusPerTier * r.tier) }],
      source: { file: ACT, path: "$.meditation" },
    }));

    const fights: Action[] = [...act.monsters]
      .sort((a, b) => b.minTier - a.minTier)
      .map((m) => ({
        id: `fight_${m.key}`,
        durationMinutes: m.minutes,
        costs: [{ resource: "stamina", amount: m.stamina }],
        requires: [{ type: "node", node: `realm_${realmAtTier(m.minTier).key}` }],
        outcomes: [
          { type: "resource", resource: "exp", amount: m.exp },
          ...m.drops.map((d) => ({ type: "resource" as const, resource: d.item, amount: { min: d.qty[0], max: d.qty[1] }, probability: d.chance })),
        ],
        source: { file: ACT, path: `$.monsters[?(@.key=='${m.key}')]` },
      }));

    const items: Action[] = Object.entries(act.items).map(([key, it]) => ({
      id: `use_${key}`,
      durationMinutes: it.useMinutes,
      costs: [{ resource: key, amount: 1 }],
      outcomes: [{ type: "resource", resource: "exp", amount: it.exp }],
      source: { file: ACT, path: `$.items.${key}` },
    }));

    const actions = [...items, ...fights, ...meditate];
    return {
      schemaVersion: "0.1",
      project: { id: "dao2-mock", name: "Dao2 (mock data)", genre: "idle-rpg" },
      resources: [
        { id: "exp", name: "Cultivation EXP", unit: "point", initial: 0 },
        { id: "spirit_stone", name: "Spirit Stone", unit: "item", initial: 0 },
        { id: "qi_pill", name: "Qi Pill", unit: "item", initial: 0 },
        {
          id: "stamina",
          name: "Stamina",
          unit: "point",
          initial: cult.player.stamina.start,
          max: cult.player.stamina.cap,
          regenPerMinute: cult.player.stamina.regenPerHour / 60,
          source: { file: CULT, path: "$.player.stamina" },
        },
      ],
      actions,
      progression,
      policies: [
        { id: "default", type: "priority", description: "Pills first, then the strongest unlocked monster, else meditate.", actions: actions.map((a) => a.id) },
        { id: "meditate_only", type: "priority", description: "Never fights (pacifist route).", actions: meditate.map((a) => a.id) },
        { id: "smart", type: "adaptive", description: "Picks the action with the best progress rate toward the next realm (2h look-ahead).", lookaheadMinutes: 120 },
      ],
      unsupported: [
        { feature: "combat outcome", reason: "Fights always succeed; win rate / HP / equipment are not in the mock data." },
        { feature: "offline progress", reason: "Simulation is continuous play time only." },
      ],
    };
  },
});
