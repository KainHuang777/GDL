import { isObj } from "../schema/validate.js";
import type { GameModel } from "../schema/types.js";
import { UsageError } from "./policy.js";

/**
 * Scenario = named list of changes applied to a COPY of the Game Model.
 * Source data is never modified.
 *
 * Target selector syntax (dot separated):
 *   progression[id=realm_2].requirements[resource=exp].gte
 *   actions[*].durationMinutes
 *   actions[fight_wolf].outcomes[0].probability     ([x] without "=" matches id, or index if numeric)
 */
export interface ScenarioChange {
  target: string;
  op: "set" | "add" | "multiply";
  value: unknown;
  note?: string;
}

export interface Scenario {
  id: string;
  description?: string;
  changes: ScenarioChange[];
  /** Optional: override policy used by compare. */
  policy?: string;
}

export interface AppliedChange {
  target: string;
  op: ScenarioChange["op"];
  matches: { path: string; before: unknown; after: unknown }[];
}

export function parseScenario(raw: unknown, file = "scenario"): Scenario {
  if (!isObj(raw)) throw new UsageError(`${file}: scenario must be a JSON object.`);
  if (typeof raw.id !== "string" || !raw.id) throw new UsageError(`${file}: scenario.id is required.`);
  if (!Array.isArray(raw.changes) || raw.changes.length === 0) throw new UsageError(`${file}: scenario.changes must be a non-empty array.`);
  raw.changes.forEach((c: unknown, i: number) => {
    if (!isObj(c) || typeof c.target !== "string") throw new UsageError(`${file}: changes[${i}].target must be a string.`);
    if (c.op !== "set" && c.op !== "add" && c.op !== "multiply") throw new UsageError(`${file}: changes[${i}].op must be set | add | multiply.`);
    if (c.op !== "set" && typeof c.value !== "number") throw new UsageError(`${file}: changes[${i}].value must be a number for op "${c.op}".`);
    if (!("value" in c)) throw new UsageError(`${file}: changes[${i}].value is required.`);
  });
  return raw as unknown as Scenario;
}

export function applyScenario(model: GameModel, scenario: Scenario): { model: GameModel; applied: AppliedChange[] } {
  const copy = structuredClone(model) as unknown as Record<string, unknown>;
  const applied: AppliedChange[] = [];
  scenario.changes.forEach((ch, i) => {
    const segments = parseTarget(ch.target);
    const matches = resolve(copy, segments, "");
    if (matches.length === 0) throw new UsageError(`Scenario "${scenario.id}" changes[${i}]: target "${ch.target}" matched nothing.`);
    const rec: AppliedChange = { target: ch.target, op: ch.op, matches: [] };
    for (const m of matches) {
      const before = m.parent[m.key];
      let after: unknown;
      if (ch.op === "set") after = structuredClone(ch.value);
      else {
        if (typeof before !== "number") throw new UsageError(`Scenario "${scenario.id}" changes[${i}]: "${m.path}" is not a number (op ${ch.op}).`);
        after = ch.op === "add" ? before + (ch.value as number) : before * (ch.value as number);
      }
      m.parent[m.key] = after;
      rec.matches.push({ path: m.path, before, after });
    }
    applied.push(rec);
  });
  return { model: copy as unknown as GameModel, applied };
}

type Segment = { key: string; filter?: { field: string | null; value: string } };

function parseTarget(target: string): Segment[] {
  const out: Segment[] = [];
  const re = /([A-Za-z_$][\w$]*)((?:\[[^\]]*\])*)/y;
  let pos = 0;
  while (pos < target.length) {
    re.lastIndex = pos;
    const m = re.exec(target);
    if (!m) throw new UsageError(`Invalid scenario target "${target}" near position ${pos}.`);
    out.push({ key: m[1]! });
    const brackets = [...m[2]!.matchAll(/\[([^\]]*)\]/g)].map((b) => b[1]!.trim());
    for (const b of brackets) {
      const eq = b.indexOf("=");
      const seg: Segment = { key: "", filter: eq >= 0 ? { field: b.slice(0, eq).trim(), value: b.slice(eq + 1).trim() } : { field: null, value: b } };
      out.push(seg);
    }
    pos = re.lastIndex;
    if (pos < target.length) {
      if (target[pos] !== ".") throw new UsageError(`Invalid scenario target "${target}" near position ${pos}.`);
      pos++;
    }
  }
  return out;
}

interface Match {
  parent: Record<string, unknown> | unknown[] & Record<string, unknown>;
  key: string | number;
  path: string;
}

function resolve(node: unknown, segs: Segment[], path: string): Match[] {
  const [seg, ...rest] = segs;
  if (!seg) return [];
  if (!seg.filter) {
    if (!isObj(node) || !(seg.key in node)) return [];
    const p = path ? `${path}.${seg.key}` : seg.key;
    if (rest.length === 0) return [{ parent: node, key: seg.key, path: p }];
    return resolve(node[seg.key], rest, p);
  }
  if (!Array.isArray(node)) return [];
  const { field, value } = seg.filter;
  const idxs: number[] = [];
  node.forEach((item, i) => {
    if (value === "*" && field === null) idxs.push(i);
    else if (field === null) {
      if (/^\d+$/.test(value) ? i === Number(value) : isObj(item) && String(item.id) === value) idxs.push(i);
    } else if (isObj(item) && String(item[field]) === value) idxs.push(i);
  });
  return idxs.flatMap((i) => {
    const p = `${path}[${i}]`;
    if (rest.length === 0) return [{ parent: node as Match["parent"], key: i, path: p }];
    return resolve(node[i], rest, p);
  });
}
