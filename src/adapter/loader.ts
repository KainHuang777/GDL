import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTER_API_VERSION } from "../version.js";
import { AdapterError, type AdapterContext, type GdlAdapter } from "./api.js";
import { UsageError } from "../core/policy.js";
import { isObj } from "../schema/validate.js";

export interface ProjectConfig {
  projectId: string;
  /** "./adapter.ts" (relative to .gdl/) or "builtin:json-model". */
  adapter: string;
  dataRoots?: string[];
  adapterOptions?: Record<string, unknown>;
  outputDir?: string;
}

export interface SourceFileRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface LoadedProject {
  root: string;
  config: ProjectConfig;
  adapter: { id: string; version: string; apiVersion: string };
  /** Unvalidated adapter output. */
  model: unknown;
  sources: SourceFileRecord[];
  modelSha256: string;
}

export const CONFIG_REL = path.join(".gdl", "config.json");

/**
 * Load a project. `target` may be:
 * - a project directory containing .gdl/config.json
 * - a standard Game Model .json file (no adapter)
 */
export async function loadProject(target: string, cwd = process.cwd()): Promise<LoadedProject> {
  const abs = path.resolve(cwd, target);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new UsageError(`Path not found: ${abs}`);

  if (stat.isFile()) {
    const root = path.dirname(abs);
    const ctx = makeContext(root, [root], {});
    const model = await ctx.ctx.readJson(path.basename(abs));
    return finish(root, { projectId: guessId(model), adapter: "builtin:json-model" }, BUILTIN_JSON, model, ctx.sources);
  }

  const cfgPath = path.join(abs, CONFIG_REL);
  const cfgText = await fs.readFile(cfgPath, "utf8").catch(() => null);
  if (cfgText === null) throw new UsageError(`No ${CONFIG_REL} in ${abs}. Pass a project directory with .gdl/config.json or a Game Model .json file.`);
  let cfg: ProjectConfig;
  try {
    cfg = parseConfig(JSON.parse(cfgText));
  } catch (e) {
    throw new UsageError(`${cfgPath}: ${(e as Error).message}`);
  }

  const dataRoots = (cfg.dataRoots ?? ["."]).map((d) => path.resolve(abs, d));
  const adapter = await resolveAdapter(cfg.adapter, path.join(abs, ".gdl"));
  const { ctx, sources } = makeContext(abs, dataRoots, cfg.adapterOptions ?? {});
  let model: unknown;
  try {
    model = await adapter.load(ctx);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new AdapterError(`Adapter "${adapter.id}@${adapter.version}" failed: ${(e as Error).message}`, adapter.id);
  }
  return finish(abs, cfg, adapter, model, sources);
}

function finish(root: string, config: ProjectConfig, adapter: GdlAdapter, model: unknown, sourceMap: Map<string, SourceFileRecord>): LoadedProject {
  const sources = [...sourceMap.values()];
  return {
    root,
    config,
    adapter: { id: adapter.id, version: adapter.version, apiVersion: adapter.apiVersion ?? ADAPTER_API_VERSION },
    model,
    sources: sources.sort((a, b) => a.path.localeCompare(b.path)),
    modelSha256: sha256(stableStringify(model)),
  };
}

function parseConfig(raw: unknown): ProjectConfig {
  if (!isObj(raw)) throw new Error("config must be an object");
  if (typeof raw.projectId !== "string" || !raw.projectId) throw new Error("projectId is required");
  if (typeof raw.adapter !== "string" || !raw.adapter) throw new Error('adapter is required (path or "builtin:json-model")');
  if (raw.dataRoots !== undefined && !(Array.isArray(raw.dataRoots) && raw.dataRoots.every((d) => typeof d === "string"))) throw new Error("dataRoots must be an array of strings");
  if (raw.adapterOptions !== undefined && !isObj(raw.adapterOptions)) throw new Error("adapterOptions must be an object");
  return raw as unknown as ProjectConfig;
}

const BUILTIN_JSON: GdlAdapter = {
  id: "builtin:json-model",
  version: "0.1.0",
  apiVersion: ADAPTER_API_VERSION,
  async load(ctx) {
    const file = ctx.options.file;
    if (typeof file !== "string") throw new UsageError('builtin:json-model requires adapterOptions.file (path to the Game Model JSON, relative to project root).');
    return ctx.readJson(file);
  },
};

async function resolveAdapter(spec: string, gdlDir: string): Promise<GdlAdapter> {
  if (spec === "builtin:json-model") return BUILTIN_JSON;
  if (spec.startsWith("builtin:")) throw new UsageError(`Unknown builtin adapter "${spec}". Available: builtin:json-model.`);
  const file = path.resolve(gdlDir, spec);
  if (!(await fs.stat(file).catch(() => null))) throw new UsageError(`Adapter file not found: ${file}`);
  if (file.endsWith(".ts") || file.endsWith(".mts")) {
    // Enable on-the-fly TypeScript import (idempotent).
    const { register } = await import("tsx/esm/api");
    register();
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; adapter?: unknown };
  const a = (mod.default ?? mod.adapter) as GdlAdapter | undefined;
  if (!a || typeof a.load !== "function" || typeof a.id !== "string" || typeof a.version !== "string") {
    throw new AdapterError(`${file} must export (default) an object { id, version, load(ctx) }.`);
  }
  if (a.apiVersion && a.apiVersion !== ADAPTER_API_VERSION) {
    throw new AdapterError(`Adapter "${a.id}" targets API ${a.apiVersion}; this GDL supports ${ADAPTER_API_VERSION}.`, a.id);
  }
  return a;
}

function makeContext(root: string, dataRoots: string[], options: Record<string, unknown>): { ctx: AdapterContext; sources: Map<string, SourceFileRecord> } {
  const sources = new Map<string, SourceFileRecord>();
  const safe = (rel: string) => {
    const abs = path.resolve(root, rel);
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) throw new UsageError(`Adapter tried to read outside project root: ${rel}`);
    return { abs, rel: relToRoot.split(path.sep).join("/") };
  };
  const readText = async (relPath: string) => {
    const { abs, rel } = safe(relPath);
    const buf = await fs.readFile(abs).catch((e: NodeJS.ErrnoException) => {
      throw new AdapterError(`Cannot read ${rel}: ${e.code ?? e.message}`);
    });
    sources.set(rel, { path: rel, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
    return buf.toString("utf8").replace(/^\uFEFF/, "");
  };
  const ctx: AdapterContext = {
    projectRoot: root,
    dataRoots,
    options,
    readText,
    async readJson<T>(relPath: string) {
      const text = await readText(relPath);
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        throw new AdapterError(`Invalid JSON in ${relPath}: ${(e as Error).message}`);
      }
    },
    async listFiles(relDir, ext) {
      const { abs } = safe(relDir);
      const entries = await fs.readdir(abs, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && (!ext || e.name.endsWith(ext)))
        .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
        .sort();
    },
  };
  return { ctx, sources };
}

function guessId(model: unknown): string {
  return isObj(model) && isObj(model.project) && typeof model.project.id === "string" ? model.project.id : "unknown";
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** JSON with sorted object keys, for stable hashing. */
export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (isObj(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val));
}
