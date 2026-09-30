/**
 * Dao adapter (REAL data snapshot). Maps Dao v0.46.6 (github.com/KainHuang777/Dao) data
 * in ../data to the GDL standard model. This is a v0.1 prototype: it models a static
 * "reference build" (a fixed set of Lv2 buildings) over Eras 1-4 (練氣→元嬰).
 *
 * Mapping decisions ("建議" until a fuller model is confirmed):
 * - eras.csv           -> ProgressionNode era_1..era_4. Training time per era is the
 *                         geometric series lvl_baseTime * lvl_timeMult^(level-1)
 *                         (eraRequirements.ts); the node requires the CUMULATIVE training
 *                         minutes (1 game-year = 1 real minute) as resource `training`.
 *                         up_skills -> resource requirements; lvl_res1-3 + lv9_item are
 *                         lumped into node costs; era3→4 tribulation (50% roll, failure
 *                         drops levels) is modelled as a deterministic proxy: the node
 *                         requires foundation_pill >= 2 (expected attempts to succeed).
 * - skills.csv         -> one Action learn_<skill> per skill: costs skill_point (flat base
 *                         cost from skills.csv; the real per-level growth in skillCost.ts
 *                         is not modelled), maxUses = maxLevel, outcome +1 skill level.
 *                         Skill level is a Resource skill_<id>. prereq_era / prereq_skills
 *                         become requires.
 * - Resources.csv      -> Resource rows; crafted items get max from CSV but regen 0 (they
 *                         are made by craft_<id> actions from the recipe column).
 * - Production         -> static regenPerMinute derived from a fixed Lv2 reference build
 *                         (buildings.csv formula amount*(level+effectWeight)^1.5 per second
 *                         * 60): hut lingli 94, wooden_house money 96, forest_farm wood 24,
 *                         stone_mine stone_low 24, herb_farm spirit_grass_low 6.6,
 *                         library skill_point 720, spirit_grass_100y field 1.2.
 * - Policies           -> default (skills then crafts), craft_first (crafts before skills),
 *                         smart (adaptive with 2h look-ahead).
 */
import { defineAdapter } from "../../../src/adapter/api.js";
import type { Action, GameModel, ProgressionNode, Resource } from "../../../src/schema/types.js";

const RES_CSV = "data/Resources.csv";
const ERA_CSV = "data/eras.csv";
const SKILL_CSV = "data/skills.csv";

/** Quote-aware CSV parser: fields may be double-quoted with "" escapes (recipes contain commas). */
function parseCsv(text: string, file: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error(`${file}: empty file`);
  const header = splitRow(lines[0]!).map((h) => h.trim());
  return lines.slice(1).map((line, i) => {
    const cells = splitRow(line);
    if (cells.length !== header.length) throw new Error(`${file}: row ${i + 2} has ${cells.length} columns, expected ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, cells[j]!]));
  });
}

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function num(row: Record<string, string>, col: string, file: string, rowNo: number): number {
  const v = Number(row[col]);
  if (row[col] === undefined || row[col] === "" || !Number.isFinite(v)) throw new Error(`${file}: row ${rowNo} column "${col}" is not a number ("${row[col] ?? ""}")`);
  return v;
}

function parseRecipe(s: string | undefined, file: string, rowNo: number): { resource: string; amount: number }[] {
  if (!s) return [];
  try {
    const obj = JSON.parse(s) as Record<string, number>;
    return Object.entries(obj).map(([resource, amount]) => ({ resource, amount }));
  } catch {
    throw new Error(`${file}: row ${rowNo}: recipe is not valid JSON ("${s}")`);
  }
}

/** Parse "skill:level" pairs, e.g. "foundation_building:5|golden_core_formation:5". */
function skillLevels(s: string | undefined): { skill: string; level: number }[] {
  if (!s) return [];
  return s.split("|").map((part) => {
    const [skill, lvl] = part.split(":");
    return { skill: skill!, level: lvl ? Number(lvl) : 1 };
  });
}

// Static "reference build" production, per minute, at Lv2 (see file JSDoc).
const REF_BUILD_RATE: Record<string, number> = {
  lingli: 94,
  money: 96,
  wood: 24,
  stone_low: 24,
  skill_point: 720,
  spirit_grass_low: 6.6,
  spirit_grass_100y: 1.2,
};

// Scope of the v0.1 prototype: the four skills demanded by Eras 2-4, and the four
// crafted items on the 練氣→元嬰 path. Everything else in the CSV is out of scope.
/** Resources whose production/caps depend on unmodelled building and era mechanics. */
const PRODUCED = ["lingli", "money", "wood", "stone_low", "skill_point", "spirit_grass_low", "spirit_grass_100y"];
const SKILL_SCOPE = ["basic_meditation", "foundation_building", "golden_core_formation", "nascent_soul_incubation"];
const CRAFT_SCOPE = ["stone_mid", "talisman", "foundation_pill", "golden_core_pill"];

export default defineAdapter({
  id: "dao",
  version: "0.1.0",
  apiVersion: "0.1",
  async load(ctx): Promise<GameModel> {
    const resRows = parseCsv(await ctx.readText(RES_CSV), RES_CSV);
    const eraRows = parseCsv(await ctx.readText(ERA_CSV), ERA_CSV);
    const skillRows = parseCsv(await ctx.readText(SKILL_CSV), SKILL_CSV);
    const resById = new Map(resRows.map((r) => [r.id, r]));

    const name = (id: string) => resById.get(id)?.name ?? id;

    // --- progression: Eras 1-4 -----------------------------------------------
    // Training requirements are the cumulative training minutes (1 game-year = 1 real
    // minute) to finish each era's 10 levels; see file JSDoc.
    const progression: ProgressionNode[] = [
      { id: "era_1", name: "練氣", order: 0 },
      { id: "era_2", name: "築基", order: 1, requirements: [{ type: "resource", resource: "training", gte: 67 }], costs: [{ resource: "lingli", amount: 5000 }, { resource: "money", amount: 1000 }, { resource: "stone_low", amount: 500 }] },
      { id: "era_3", name: "金丹", order: 2, requirements: [{ type: "resource", resource: "training", gte: 166 }, { type: "resource", resource: "skill_basic_meditation", gte: 5 }], costs: [{ resource: "lingli", amount: 20000 }, { resource: "money", amount: 5000 }, { resource: "stone_mid", amount: 50 }, { resource: "talisman", amount: 10 }] },
      {
        id: "era_4",
        name: "元嬰",
        order: 3,
        requirements: [
          { type: "resource", resource: "training", gte: 377 },
          { type: "resource", resource: "skill_foundation_building", gte: 5 },
          { type: "resource", resource: "skill_golden_core_formation", gte: 5 },
          { type: "resource", resource: "foundation_pill", gte: 2 },
        ],
        costs: [{ resource: "lingli", amount: 50000 }, { resource: "golden_core_pill", amount: 3 }, { resource: "stone_mid", amount: 200 }],
      },
    ];

    const CRAFTED: Record<string, string[]> = {};
    for (const r of resRows) {
      if (r.type === "crafted") {
        const recipe = parseRecipe(r.recipe, RES_CSV, resRows.indexOf(r) + 2);
        CRAFTED[r.id] = recipe.map((c) => c.resource);
      }
    }

    const resources: Resource[] = [
      { id: "lingli", name: name("lingli"), max: 50000, regenPerMinute: REF_BUILD_RATE.lingli },
      { id: "money", name: name("money"), max: 10000, regenPerMinute: REF_BUILD_RATE.money },
      { id: "wood", name: name("wood"), max: 1000, regenPerMinute: REF_BUILD_RATE.wood },
      { id: "stone_low", name: name("stone_low"), max: 20000, regenPerMinute: REF_BUILD_RATE.stone_low },
      { id: "skill_point", name: name("skill_point"), max: 100000, regenPerMinute: REF_BUILD_RATE.skill_point },
      { id: "spirit_grass_low", name: name("spirit_grass_low"), max: 500, regenPerMinute: REF_BUILD_RATE.spirit_grass_low },
      { id: "spirit_grass_100y", name: name("spirit_grass_100y"), max: 100, regenPerMinute: REF_BUILD_RATE.spirit_grass_100y },
      { id: "stone_mid", name: name("stone_mid"), kind: "crafted", max: 2000 },
      { id: "talisman", name: name("talisman"), kind: "crafted", max: 500 },
      { id: "foundation_pill", name: name("foundation_pill"), kind: "crafted", max: 100 },
      { id: "golden_core_pill", name: name("golden_core_pill"), kind: "crafted", max: 100 },
      { id: "training", name: "修行累計時間", kind: "counter", unit: "minute", regenPerMinute: 1 },
    ];
    // Skill levels as resources.
    for (const s of skillRows) {
      if (!SKILL_SCOPE.includes(s.id)) continue;
      resources.push({ id: `skill_${s.id}`, kind: "counter", name: `功法 ${s.name}`, max: num(s, "maxLevel", SKILL_CSV, skillRows.indexOf(s) + 2) });
    }

    // --- actions ----------------------------------------------------------------
    const actions: Action[] = [];

    for (const s of skillRows) {
      if (!SKILL_SCOPE.includes(s.id)) continue;
      const cost = num(s, "cost_amount", SKILL_CSV, skillRows.indexOf(s) + 2);
      const maxLevel = num(s, "maxLevel", SKILL_CSV, skillRows.indexOf(s) + 2);
      const requires: NonNullable<Action["requires"]> = [];
      const era = Number(s.prereq_era || 1);
      if (era > 1) requires.push({ type: "node", node: `era_${era - 1}` });
      for (const p of skillLevels(s.prereq_skills)) requires.push({ type: "resource", resource: `skill_${p.skill}`, gte: p.level });
      actions.push({
        id: `learn_${s.id}`,
        name: `學習 ${s.name}`,
        durationMinutes: 0,
        requires,
        costs: [{ resource: "skill_point", amount: cost }],
        outcomes: [{ type: "resource", resource: `skill_${s.id}`, amount: 1 }],
        maxUses: maxLevel,
        source: { file: SKILL_CSV, path: `row ${skillRows.indexOf(s) + 2}` },
      });
    }

    // Craft actions from the recipe column of crafted resources.
    for (const r of resRows) {
      if (r.type !== "crafted" || !CRAFT_SCOPE.includes(r.id)) continue;
      const recipe = parseRecipe(r.recipe, RES_CSV, resRows.indexOf(r) + 2);
      const era = Number(r.prereqEra || 1);
      actions.push({
        id: `craft_${r.id}`,
        name: `煉製 ${r.name}`,
        durationMinutes: 0,
        requires: era > 1 ? [{ type: "node", node: `era_${era - 1}` }] : [],
        costs: recipe,
        outcomes: [{ type: "resource", resource: r.id, amount: 1 }],
        source: { file: RES_CSV, path: `row ${resRows.indexOf(r) + 2}` },
      });
    }

    const learn = actions.filter((a) => a.id.startsWith("learn_")).map((a) => a.id);
    const craft = actions.filter((a) => a.id.startsWith("craft_")).map((a) => a.id);

    return {
      schemaVersion: "0.1",
      project: { id: "dao", name: "修仙問道 (Dao, real data snapshot v0.46.6)", genre: "idle-cultivation" },
      resources,
      actions,
      progression,
      policies: [
        { id: "default", type: "priority", description: "學功法（由便宜到貴）優先，再依序煉製丹藥/靈石/符咒。", actions: [...learn, ...craft] },
        { id: "craft_first", type: "priority", description: "先煉製再學功法（優先滿足材料需求）。", actions: [...craft, ...learn] },
        { id: "smart", type: "adaptive", description: "依進度速率自我決策（2 小時前瞻）。", lookaheadMinutes: 120 },
      ],
      unsupported: [
        { feature: "era resource multiplier", affects: PRODUCED, reason: "Real production is scaled by era.resourceMultiplier; GDL regenPerMinute is static, so later eras are modelled with the same rates." },
        { feature: "building purchase/upgrade", affects: PRODUCED, reason: "A fixed Lv2 reference build is assumed; building cost curves (buildingCost.ts) are not modelled." },
        { feature: "dynamic capacity", affects: PRODUCED, reason: "Storage buildings and capacity upgrades (capacity.ts) are collapsed into fixed resource maxima." },
        { feature: "tribulation randomness", affects: ["foundation_pill", "golden_core_pill"], reason: "Era 3+ breakthrough is a 50% dice roll (failure drops levels); modelled deterministically as a foundation_pill >= 2 requirement." },
        { feature: "offline progress / lifespan / reincarnation", reason: "Simulation is continuous play time; lifespan exhaustion and daoHeart inheritance are out of scope." },
        { feature: "crafting crits", reason: "The 5% x3 / 10% x2 craft multipliers in craft.ts are not modelled." },
        { feature: "manual gathering, sect tasks, market, encounters, beast buffs", reason: "Player-policy layer not modelled in v0.1." },
      ],
    };
  },
});