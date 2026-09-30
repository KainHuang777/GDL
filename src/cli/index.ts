import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { analyzeProject, compareProject, simulateProject, validateProject } from "../index.js";
import { AdapterError } from "../adapter/api.js";
import { UsageError } from "../core/policy.js";
import { parseScenario, type Scenario } from "../core/scenario.js";
import type { SimLimits, SimMode } from "../core/simulate.js";
import type { SimulationOptions } from "../core/runner.js";
import { GDL_VERSION } from "../version.js";
import { formatText } from "./format.js";
import { buildInsights, CATEGORIES, type Category } from "../insights/insights.js";
import { formatInsights } from "../insights/format.js";
import { renderHtml } from "../report/html.js";
import { readReport, reportStem, resolveOutputDir, writeFileEnsured } from "../report/io.js";

export const EXIT = { OK: 0, DATA_INVALID: 1, ERROR: 2 } as const;

const HELP = `GDL ${GDL_VERSION} - Game Design Lab

Usage:
  gdl validate <project|model.json>
  gdl analyze  <project|model.json> [sim options]
  gdl simulate <project|model.json> [sim options] [--mode monte-carlo|expected] [--runs N] [--seed S]
  gdl compare  <project|model.json> --scenario <file.json> [--scenario ...] [sim options]
  gdl inspect  <report.json> [--focus bottleneck,economy,scenario] [--format text|json]
  gdl report   <report.json> [--out dashboard.html]

<project> is a directory containing .gdl/config.json; alternatively pass a Game Model JSON file.
(--project <path> is accepted instead of the positional argument.)

Sim options:
  --policy <id>        policy id from the model (default: "default" or first policy, else declaration order)
  --minutes <n>        play-time limit in in-game minutes     (default 1440 = 24h)
  --hours <n>          same, in hours
  --max-actions <n>    action-count limit                      (default 100000)
  --no-stop-on-complete  keep playing after the last node is reached

simulate/compare:
  --mode <m>           monte-carlo (default for simulate/compare) | expected
  --runs <n>           Monte Carlo runs (default 1000, max 100000)
  --seed <n>           integer seed (default 1)
  --keep-runs          include every run in JSON output
  --trace              include an event trace of the first run in JSON output

Output:
  --format text|json   (default text)
  --out <file>         also write the JSON report to <file> (never inside source data unless you choose so)
                       (gdl report: the HTML output path; default <report>.html)
  --html <file>        also write a static HTML dashboard to <file>
  --save               save JSON + HTML dashboard to the project outputDir (default <project>/.gdl/reports)

Reading reports:
  inspect              findings (bottlenecks, economy, scenarios) + pacing/economy tables in the terminal
  --focus <list>       comma-separated categories: bottleneck,economy,scenario,data
  report               render a saved JSON report as a self-contained HTML dashboard

Exit codes: 0 ok, 1 data validation failed, 2 usage/runtime error.
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`${GDL_VERSION}\n`);
    return EXIT.OK;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: "string" },
        policy: { type: "string" },
        minutes: { type: "string" },
        hours: { type: "string" },
        "max-actions": { type: "string" },
        "no-stop-on-complete": { type: "boolean" },
        mode: { type: "string" },
        runs: { type: "string" },
        seed: { type: "string" },
        "keep-runs": { type: "boolean" },
        trace: { type: "boolean" },
        scenario: { type: "string", multiple: true },
        format: { type: "string" },
        out: { type: "string" },
        html: { type: "string" },
        save: { type: "boolean" },
        focus: { type: "string" },
      },
    });
    if (command === "inspect" || command === "report") return await readCommand(command, positionals, values);
    const target = values.project ?? positionals[0];
    if (!target) throw new UsageError(`Missing project path. Run "gdl help".`);
    if (positionals.length > (values.project ? 0 : 1)) throw new UsageError(`Unexpected arguments: ${positionals.slice(values.project ? 0 : 1).join(" ")}`);
    const format = values.format ?? "text";
    if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json.`);

    const limits: SimLimits = {
      maxMinutes: values.hours !== undefined ? posNum(values.hours, "--hours") * 60 : values.minutes !== undefined ? posNum(values.minutes, "--minutes") : 1440,
      maxActions: values["max-actions"] !== undefined ? posInt(values["max-actions"], "--max-actions") : 100_000,
      stopOnComplete: !values["no-stop-on-complete"],
    };
    if (values.hours !== undefined && values.minutes !== undefined) throw new UsageError("Use either --hours or --minutes, not both.");
    const sim = (defaultMode: SimMode): SimulationOptions => {
      const mode = (values.mode ?? defaultMode) as SimMode;
      if (mode !== "monte-carlo" && mode !== "expected") throw new UsageError("--mode must be monte-carlo or expected.");
      const o: SimulationOptions = { mode, limits };
      if (values.policy) o.policy = values.policy;
      if (values.runs !== undefined) o.runs = posInt(values.runs, "--runs");
      if (values.seed !== undefined) o.seed = int(values.seed, "--seed");
      if (values["keep-runs"]) o.keepRuns = true;
      if (values.trace) o.trace = true;
      return o;
    };

    let report;
    switch (command) {
      case "validate":
        report = await validateProject(target);
        break;
      case "analyze":
        report = await analyzeProject(target, sim("expected"));
        break;
      case "simulate":
        report = await simulateProject(target, sim("monte-carlo"));
        break;
      case "compare": {
        if (!values.scenario?.length) throw new UsageError("compare requires at least one --scenario <file.json>.");
        const scenarios: Scenario[] = [];
        for (const f of values.scenario) {
          const text = await fs.readFile(path.resolve(f), "utf8").catch(() => {
            throw new UsageError(`Scenario file not found: ${f}`);
          });
          let raw: unknown;
          try {
            raw = JSON.parse(text.replace(/^\uFEFF/, ""));
          } catch (e) {
            throw new UsageError(`${f}: invalid JSON: ${(e as Error).message}`);
          }
          scenarios.push(parseScenario(raw, f));
        }
        report = await compareProject(target, scenarios, sim("monte-carlo"));
        break;
      }
      default:
        throw new UsageError(`Unknown command "${command}". Run "gdl help".`);
    }

    const json = JSON.stringify(report, null, 2);
    if (values.out) await writeFileEnsured(values.out, json + "\n");
    const insights = buildInsights(report);
    if (values.html) await writeFileEnsured(values.html, renderHtml(report, insights));
    if (values.save) {
      const dir = await resolveOutputDir(report.provenance.project.root);
      const stem = path.join(dir, reportStem(report));
      await writeFileEnsured(stem + ".json", json + "\n");
      await writeFileEnsured(stem + ".html", renderHtml(report, insights));
      process.stderr.write(`gdl: saved ${stem}.json and .html\n`);
    }
    process.stdout.write(format === "json" ? json + "\n" : formatText(report, insights));
    const scenarioInvalid = report.kind === "compare" && report.scenarios.some((s) => !s.validation.ok);
    return report.validation.ok && !scenarioInvalid ? EXIT.OK : EXIT.DATA_INVALID;
  } catch (e) {
    const err = e as Error;
    const known = e instanceof UsageError || e instanceof AdapterError || (err as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION";
    process.stderr.write(`gdl: ${known ? err.message : err.stack ?? String(err)}\n`);
    return EXIT.ERROR;
  }
}

async function readCommand(command: "inspect" | "report", positionals: string[], values: { format?: string; out?: string; focus?: string; [k: string]: unknown }): Promise<number> {
  const file = positionals[0];
  if (!file) throw new UsageError(`${command} requires a report file: gdl ${command} <report.json>`);
  if (positionals.length > 1) throw new UsageError(`Unexpected arguments: ${positionals.slice(1).join(" ")}`);
  const report = await readReport(file);
  const insights = buildInsights(report);
  if (command === "report") {
    const out = values.out ?? file.replace(/\.json$/i, "") + ".html";
    const abs = await writeFileEnsured(out, renderHtml(report, insights));
    process.stdout.write(`${abs}\n`);
    return EXIT.OK;
  }
  const format = values.format ?? "text";
  if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json.`);
  const focus = (values.focus ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Category[];
  const bad = focus.filter((f) => !CATEGORIES.includes(f));
  if (bad.length) throw new UsageError(`--focus: unknown category ${bad.join(", ")} (use ${CATEGORIES.join(",")}).`);
  process.stdout.write(format === "json" ? JSON.stringify(insights, null, 2) + "\n" : formatInsights(report, insights, focus));
  return EXIT.OK;
}

function posNum(s: string, flag: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number.`);
  return n;
}
function posInt(s: string, flag: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive integer.`);
  return n;
}
function int(s: string, flag: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new UsageError(`${flag} must be an integer.`);
  return n;
}

// Allow `tsx src/cli/index.ts ...`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
