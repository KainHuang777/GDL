import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnyReport } from "../index.js";
import { UsageError } from "../core/policy.js";
import { CONFIG_REL } from "../adapter/loader.js";

const KINDS = new Set(["validate", "analyze", "simulate", "compare"]);

/** Read a GDL JSON report from disk (for `gdl inspect` / `gdl report`). */
export async function readReport(file: string): Promise<AnyReport> {
  const text = await fs.readFile(path.resolve(file), "utf8").catch(() => {
    throw new UsageError(`Report file not found: ${file}`);
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new UsageError(`${file}: invalid JSON: ${(e as Error).message}`);
  }
  const r = raw as Partial<AnyReport> | null;
  if (!r || typeof r !== "object" || !KINDS.has(r.kind as string) || !r.provenance?.reportVersion || !r.validation) {
    throw new UsageError(`${file}: not a GDL report (expected kind + provenance + validation; produce one with --format json --out <file>).`);
  }
  if (r.provenance.reportVersion.split(".")[0] !== "0") throw new UsageError(`${file}: unsupported reportVersion ${r.provenance.reportVersion}.`);
  return r as AnyReport;
}

/** Resolve the project's report directory: `.gdl/config.json` outputDir, else `<root>/.gdl/reports`. */
export async function resolveOutputDir(projectRoot: string): Promise<string> {
  const cfgText = await fs.readFile(path.join(projectRoot, CONFIG_REL), "utf8").catch(() => null);
  if (cfgText) {
    try {
      const cfg = JSON.parse(cfgText) as { outputDir?: unknown };
      if (typeof cfg.outputDir === "string" && cfg.outputDir) return path.resolve(projectRoot, cfg.outputDir);
    } catch {
      /* config was already validated by the loader; fall through */
    }
  }
  return path.join(projectRoot, ".gdl", "reports");
}

/** File stem for a saved report: 2026-09-30T10-11-12-345Z-simulate */
export function reportStem(r: AnyReport): string {
  return `${r.provenance.generatedAt.replace(/[:.]/g, "-")}-${r.kind}`;
}

export async function writeFileEnsured(file: string, content: string): Promise<string> {
  const abs = path.resolve(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}
