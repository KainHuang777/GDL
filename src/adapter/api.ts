import type { GameModel } from "../schema/types.js";
import type { InsightRule } from "../insights/insights.js";

/**
 * Adapter API v0.1.
 *
 * An adapter converts a project's raw data into a standard GameModel.
 * It MUST read project files through `ctx` so GDL can hash them for traceability,
 * and MUST NOT write to project files. No network or LLM is required.
 */
export interface GdlAdapter {
  id: string;
  version: string;
  /** Adapter API version this adapter targets. Currently "0.1". */
  apiVersion?: string;
  load(ctx: AdapterContext): Promise<GameModel> | GameModel;
  /**
   * Optional project-specific insight rules, evaluated after the built-in rules whenever
   * insights are built for a report of this project (simulate/compare --save, inspect, report).
   * Rules must be pure and deterministic; a throwing rule becomes a "rule-error" finding.
   */
  insightRules?: InsightRule[];
}

export interface AdapterContext {
  /** Absolute project root (directory containing .gdl/). */
  projectRoot: string;
  /** Data roots from config, resolved to absolute paths. */
  dataRoots: string[];
  /** Adapter-specific options from config.adapterOptions. */
  options: Record<string, unknown>;
  /** Read a text file (path relative to projectRoot). Recorded + hashed. */
  readText(relPath: string): Promise<string>;
  /** Read and parse a JSON file (path relative to projectRoot). Recorded + hashed. */
  readJson<T = unknown>(relPath: string): Promise<T>;
  /** List files (relative to projectRoot) under a directory, optionally filtered by extension. */
  listFiles(relDir: string, ext?: string): Promise<string[]>;
}

/** Helper for adapter authors: gives type checking with zero runtime cost. */
export function defineAdapter(adapter: GdlAdapter): GdlAdapter {
  return adapter;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly adapterId?: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
