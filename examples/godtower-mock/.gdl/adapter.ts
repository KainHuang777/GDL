/**
 * GodTower adapter (MOCK). Tower-defense data in CSV -> GDL standard model.
 *
 * The real per-frame combat is NOT simulated. It is abstracted as:
 *   "a wave can be cleared iff tower power >= power_required"
 * and declared in `unsupported` so reports never pretend otherwise.
 *
 * Mapping decisions ("建議" until the real GodTower data is confirmed):
 * - waves.csv          -> ProgressionNode wave_N (requires waves_cleared >= N)
 *                         + one-off Action clear_wave_N (requires power, gives gold)
 *                         + repeatable Action farm_wave_N (gold * farmGoldRatio)
 * - tower_upgrades.csv -> one-off Action upgrade_L (costs gold, gives power), level 1 is initial power.
 */
import { defineAdapter } from "../../../src/adapter/api.js";
import type { Action, GameModel, ProgressionNode } from "../../../src/schema/types.js";

const WAVES = "data/waves.csv";
const UPGRADES = "data/tower_upgrades.csv";

function parseCsv(text: string, file: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0]?.split(",").map((h) => h.trim());
  if (!header) throw new Error(`${file}: empty file`);
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length !== header.length) throw new Error(`${file}: row ${i + 2} has ${cells.length} columns, expected ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, cells[j]!]));
  });
}

function num(row: Record<string, string>, col: string, file: string, rowNo: number): number {
  const v = Number(row[col]);
  if (row[col] === undefined || row[col] === "" || !Number.isFinite(v)) throw new Error(`${file}: row ${rowNo} column "${col}" is not a number ("${row[col] ?? ""}")`);
  return v;
}

export default defineAdapter({
  id: "godtower-mock",
  version: "0.1.0",
  apiVersion: "0.1",
  async load(ctx): Promise<GameModel> {
    const farmRatio = typeof ctx.options.farmGoldRatio === "number" ? ctx.options.farmGoldRatio : 0.5;
    const waves = parseCsv(await ctx.readText(WAVES), WAVES).map((r, i) => ({
      wave: num(r, "wave", WAVES, i + 2),
      power: num(r, "power_required", WAVES, i + 2),
      gold: num(r, "gold_reward", WAVES, i + 2),
      minutes: num(r, "minutes", WAVES, i + 2),
      boss: r.is_boss === "1",
      row: i + 2,
    }));
    const ups = parseCsv(await ctx.readText(UPGRADES), UPGRADES).map((r, i) => ({
      level: num(r, "level", UPGRADES, i + 2),
      cost: num(r, "gold_cost", UPGRADES, i + 2),
      gain: num(r, "power_gain", UPGRADES, i + 2),
      minutes: num(r, "build_minutes", UPGRADES, i + 2),
      row: i + 2,
    }));
    waves.sort((a, b) => a.wave - b.wave);
    ups.sort((a, b) => a.level - b.level);
    const base = ups.find((u) => u.level === 1);
    if (!base) throw new Error(`${UPGRADES}: level 1 row (initial tower power) is required`);

    const progression: ProgressionNode[] = [
      { id: "wave_0", name: "Start", order: 0 },
      ...waves.map((w) => ({
        id: `wave_${w.wave}`,
        name: `Wave ${w.wave}${w.boss ? " (boss)" : ""}`,
        order: w.wave,
        requirements: [{ type: "resource" as const, resource: "waves_cleared", gte: w.wave }],
        source: { file: WAVES, path: `row ${w.row}` },
      })),
    ];

    const clear: Action[] = waves.map((w) => ({
      id: `clear_wave_${w.wave}`,
      durationMinutes: w.minutes,
      maxUses: 1,
      requires: [
        { type: "node", node: `wave_${w.wave - 1}` },
        { type: "resource", resource: "power", gte: w.power },
      ],
      outcomes: [
        { type: "resource", resource: "gold", amount: w.gold },
        { type: "resource", resource: "waves_cleared", amount: 1 },
      ],
      source: { file: WAVES, path: `row ${w.row}` },
    }));

    const farm: Action[] = [...waves].reverse().map((w) => ({
      id: `farm_wave_${w.wave}`,
      durationMinutes: w.minutes,
      requires: [{ type: "node", node: `wave_${w.wave}` }],
      outcomes: [{ type: "resource", resource: "gold", amount: Math.floor(w.gold * farmRatio) }],
      source: { file: WAVES, path: `row ${w.row}` },
    }));

    const upgrades: Action[] = ups
      .filter((u) => u.level > 1)
      .map((u) => ({
        id: `upgrade_${u.level}`,
        durationMinutes: u.minutes,
        maxUses: 1,
        costs: [{ resource: "gold", amount: u.cost }],
        // Upgrades must be bought in level order.
        requires: [{ type: "resource", resource: "tower_level", gte: u.level - 1, lte: u.level - 1 }],
        outcomes: [
          { type: "resource", resource: "power", amount: u.gain },
          { type: "resource", resource: "tower_level", amount: 1 },
        ],
        source: { file: UPGRADES, path: `row ${u.row}` },
      }));

    const actions = [...clear, ...upgrades, ...farm];
    return {
      schemaVersion: "0.1",
      project: { id: "godtower-mock", name: "GodTower (mock data)", genre: "tower-defense" },
      resources: [
        { id: "gold", unit: "coin", initial: 0 },
        { id: "power", name: "Tower power", unit: "point", initial: base.gain, source: { file: UPGRADES, path: `row ${base.row}` } },
        { id: "tower_level", unit: "level", initial: 1 },
        { id: "waves_cleared", unit: "wave", initial: 0 },
      ],
      actions,
      progression,
      policies: [
        { id: "default", type: "priority", description: "Push the next wave when possible, else upgrade, else farm the highest wave.", actions: actions.map((a) => a.id) },
        {
          id: "no_upgrades",
          type: "priority",
          description: "Pushes and farms but never upgrades; shows where progression stalls.",
          actions: [...clear, ...farm].map((a) => a.id),
        },
        { id: "smart", type: "adaptive", description: "Chooses between pushing, upgrading and farming by progress rate (2h look-ahead).", lookaheadMinutes: 120 },
      ],
      unsupported: [
        { feature: "wave combat", reason: "Per-frame tower-defense combat is abstracted as a power threshold (power >= power_required)." },
        { feature: "tower placement / multiple towers", reason: "Single aggregated tower power only." },
      ],
    };
  },
});
