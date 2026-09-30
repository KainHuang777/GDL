import type { AnyReport, CompareReport, Delta } from "../index.js";
import type { SimulationResult, WasteStat } from "../core/runner.js";
import { round } from "../core/stats.js";
import { fmtMin, num, pct, signedPct } from "../report/units.js";

/**
 * Deterministic reading aids built on top of a report (docs/dashboard-design.md).
 * Pure: same report => same insights. Never reruns the simulation.
 */

export type Severity = "critical" | "warning" | "info";
/** `policy` = effects of the simulated strategy rather than of the game design. */
export type Category = "bottleneck" | "economy" | "policy" | "scenario" | "data";
export const CATEGORIES: Category[] = ["bottleneck", "economy", "policy", "scenario", "data"];

export type InsightLang = "en" | "zh-TW";

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  /** "simulation" | "baseline" | "scenario:<id>" */
  scope: string;
  /** "node:<id>" | "resource:<id>" | "action:<id>" | "scenario:<id>" */
  subject?: string;
  title: string;
  detail: string;
  /** Unmodelled features (`unsupported[].feature`) that make the numbers behind this finding unreliable. */
  caveats?: string[];
  /** Id of the adapter-provided rule that produced this finding (absent for built-in rules). */
  rule?: string;
}

export interface Segment {
  from: string;
  to: string;
  medianMinutes: number;
  /** Share of the median time to the last reached node. */
  share: number;
}

export interface PacingView {
  nodes: { id: string; reachRate: number; p10: number | null; median: number | null; p90: number | null; limiters: WaitLimiter[] }[];
  segments: Segment[];
  slowest: Segment | null;
  /** Median minute of the last node that at least half the runs reached. */
  horizonMinutes: number;
  stops: { reason: string; share: number }[];
  stalls: { node: string; share: number; reasons: string[]; limits: Limiter[] }[];
}

/** Share of a node's waiting time spent on one critical-path resource. */
export interface WaitLimiter {
  resource: string;
  minutes: number;
  share: number;
}

export interface Limiter {
  resource: string;
  kind: "cost" | "requirement";
  need: number;
  have: number;
  gap: number;
  netPerHour: number;
  /** Estimated in-game minutes to close the gap at the current net rate; null if the rate is <= 0. */
  etaMinutes: number | null;
}

export interface FlowShare {
  key: string;
  mean: number;
  share: number;
}

export interface EconomyRow {
  id: string;
  produced: number;
  consumed: number;
  finalMedian: number;
  netPerHour: number;
  overflow: number;
  /** overflow / (produced + overflow) */
  overflowShare: number;
  sources: FlowShare[];
  sinks: FlowShare[];
}

export interface ScenarioView {
  id: string;
  description?: string;
  valid: boolean;
  changes: number;
  completionRate: Delta | null;
  /** False when the two runs ended at different times, so final resource amounts are not comparable. */
  resourcesComparable: boolean;
  /** Nodes whose main waiting limiter changed. */
  limiterShifts: { node: string; from: string; to: string }[];
  /** Nodes sorted by |impact| on median time. */
  nodeImpact: { id: string; medianMinute: Delta; reachRate: Delta }[];
  resourceImpact: { id: string; delta: Delta }[];
}

/** Distribution of one node's arrival minute over all kept runs (needs --keep-runs). */
export interface Histogram {
  id: string;
  /** Runs that reached the node. */
  count: number;
  /** Runs that did not reach it. */
  missing: number;
  min: number;
  max: number;
  /** Equal-width bins over [min, max]; a single value gets one bin. */
  bins: number[];
  median: number;
}

/** Condensed event trace of the first run (needs --trace). */
export interface TimelineView {
  horizon: number;
  nodes: { id: string; t: number }[];
  /** Merged waiting spans. */
  waits: { start: number; end: number }[];
  waitingShare: number;
  /** Action count per equal-width time bucket; `series` holds the busiest actions, the rest fall into "other". */
  bucketMinutes: number;
  series: { id: string; total: number; counts: number[] }[];
}

export interface Insights {
  kind: AnyReport["kind"];
  findings: Finding[];
  pacing?: PacingView;
  economy?: EconomyRow[];
  actionUsage?: { id: string; mean: number }[];
  waste?: WasteStat[];
  scenarios?: ScenarioView[];
  histograms?: Histogram[];
  timeline?: TimelineView;
  /** Threshold overrides applied on top of the defaults (absent when none). */
  thresholdOverrides?: Partial<Thresholds>;
}

/** Initial thresholds; tune with real project feedback. */
export const THRESHOLDS = {
  stallShare: 0.05,
  slowSegmentShare: 0.35,
  slowSegmentMinNodes: 3,
  spikeFactor: 2,
  varianceRatio: 1.5,
  waitingShare: 0.3,
  overflowWarnShare: 0.1,
  hoardShare: 0.5,
  sourceConcentration: 0.8,
  scenarioTop: 3,
  /** A node's waiting must be this concentrated on one resource to be called out. */
  limiterShare: 0.5,
  /** A node must take at least this share of the horizon to get a limiter finding. */
  limiterSegmentShare: 0.2,
  wasteShare: 0.2,
  /** Wasted input at least this share of that input's total spend => warning. */
  wasteSpendShare: 0.05,
};

export type Thresholds = typeof THRESHOLDS;

/** Merge validated overrides over the defaults. Throws Error on unknown keys / non-finite numbers. */
export function resolveThresholds(overrides?: Partial<Thresholds>): Thresholds {
  const out: Thresholds = { ...THRESHOLDS };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!(k in THRESHOLDS)) throw new Error(`unknown threshold "${k}" (known: ${Object.keys(THRESHOLDS).join(", ")})`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`threshold "${k}" must be a finite number >= 0`);
    out[k as keyof Thresholds] = v;
  }
  return out;
}

/** Read-only view handed to adapter-provided rules. */
export interface RuleContext {
  report: AnyReport;
  lang: InsightLang;
  thresholds: Thresholds;
  /** "simulation" | "baseline" (undefined for validate reports). */
  scope?: string;
  /** Primary simulation (compare: the baseline). */
  sim?: SimulationResult;
  pacing?: PacingView;
  economy?: EconomyRow[];
  /** Built-in findings, already computed (read-only intent; do not mutate). */
  findings: readonly Finding[];
}

/**
 * Adapter-provided insight rule. Must be pure and deterministic: same report => same findings.
 * `scope` defaults to the primary scope; `category` must be a known Category.
 */
export interface InsightRule {
  id: string;
  evaluate(ctx: RuleContext): Finding[] | void;
}

export interface BuildInsightsOptions {
  thresholds?: Partial<Thresholds>;
  rules?: InsightRule[];
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------- i18n

/** Finding title/detail templates. `{name}` placeholders are filled by `fill`. */
interface Msgs {
  invalidTitle: string;
  validationWarningsTitle: string;
  ruleErrorTitle: string;
  unreachableTitle: string;
  unreachableFallback: string;
  stuckTitle: string;
  stuckFallback: string;
  stallTitle: string;
  stallLimitedBy: string;
  stallShortA: string;
  stallShortB: string;
  stallFallback: string;
  partialTitle: string;
  partialDetail: string;
  slowTitle: string;
  slowDetail: string;
  spikeTitle: string;
  spikeDetail: string;
  varianceTitle: string;
  varianceDetail: string;
  waitingTitle: string;
  waitingDetail: string;
  overflowTitle: string;
  overflowDetail: string;
  deficitTitle: string;
  deficitRunsDry: string;
  deficitDetail: string;
  noSinkTitle: string;
  noSinkDetail: string;
  hoardTitle: string;
  hoardDetail: string;
  sourceTitle: string;
  sourceDetail: string;
  unusedTitle: string;
  unusedDetail: string;
  scenInvalidTitle: string;
  scenStuckTitle: string;
  scenCompletionTitle: string;
  scenCompletionMore: string;
  scenCompletionFewer: string;
  scenReachTitle: string;
  scenReachDetail: string;
  scenImpactTitle: string;
  scenImpactTime: string;
  scenImpactFinal: string;
  scenNoEffectTitle: string;
  scenNoEffectDetail: string;
  newlyReached: string;
  noLongerReached: string;
  regen: string;
  waitCauseTitle: string;
  waitCauseDetail: string;
  waitTimeGatedTitle: string;
  waitTimeGatedDetail: string;
  wasteTitle: string;
  wasteDetail: string;
  wasteCost: string;
  scenLimiterTitle: string;
  scenLimiterDetail: string;
  scenLimiterShift: string;
  otherLimiter: string;
}

const EN: Msgs = {
  invalidTitle: "Model is invalid ({n} error(s)); nothing was simulated",
  validationWarningsTitle: "{n} validation warning(s)",
  ruleErrorTitle: "Custom rule \"{id}\" failed",
  unreachableTitle: "{target} is unreachable by design",
  unreachableFallback: "static reachability found no way to satisfy it",
  stuckTitle: "Stuck in {c}/{r} run(s): no affordable action and nothing regenerates",
  stuckFallback: "no blocking reason recorded (policy excludes the needed actions?)",
  stallTitle: "{pct} of runs stop before {node}",
  stallLimitedBy: " (limited by {res})",
  stallShortA: " — short {gap} {res}; at {rate}/h that is ~{eta} more play",
  stallShortB: " — short {gap} {res}, whose net rate is {rate}/h: it will not close by itself",
  stallFallback: "requirements met; ran out of time/actions",
  partialTitle: "Only {pct} of runs reach {node}",
  partialDetail: "Outcomes diverge from here: randomness decides whether players progress within the limit.",
  slowTitle: "{from} → {to} takes {share} of the progression time",
  slowDetail: "Median {m} of {h} to the last commonly reached node.",
  spikeTitle: "Pacing jump at {node}: {b} vs {a} for the previous step (×{factor})",
  spikeDetail: "Segment {from} → {to}.",
  varianceTitle: "Arrival time varies a lot for {nodes}",
  varianceDetail: "{node}: p10 {p10} / p90 {p90} (×{f})",
  waitingTitle: "Players spend {pct} of play time waiting for regeneration",
  waitingDetail: "Median waiting {w} of {played} played.",
  overflowTitle: "{res} overflows its cap: {pct} of income is wasted",
  overflowDetail: "Mean {lost} lost per run vs {kept} kept. Raise the cap, add a sink, or reduce idle time.",
  deficitTitle: "{res} is net negative ({rate}/h)",
  deficitRunsDry: " and runs dry",
  deficitDetail: "Produced {p}, consumed {c} per run; median final {f}.",
  noSinkTitle: "Only produced, never spent: {res}",
  noSinkDetail: "Fine for counters / progress stats (e.g. exp used only as a requirement); otherwise a sink is missing.",
  hoardTitle: "{res} piles up: median final {f} is {pct} of income",
  hoardDetail: "Only {c} of {p} is spent per run; sinks may be too weak.",
  sourceTitle: "{res} depends on one source: {source} gives {pct}",
  sourceDetail: "Changes to {source} will move the whole {res} economy.",
  unusedTitle: "{n} action(s) never used under policy \"{policy}\"",
  unusedDetail: "{actions} — dead content, locked behind unreached nodes, or outranked / never chosen under the policy.",
  scenInvalidTitle: "Scenario {id} produces an invalid model; not simulated",
  scenStuckTitle: "Scenario {id}: stuck in {c}/{r} run(s)",
  scenCompletionTitle: "Scenario {id}: completion rate {b} → {s}",
  scenCompletionMore: "More runs finish the track within the limit.",
  scenCompletionFewer: "Fewer runs finish the track within the limit.",
  scenReachTitle: "Scenario {id}: reach rate changes at {nodes}",
  scenReachDetail: "{node} {b} → {s}",
  scenImpactTitle: "Scenario {id}: biggest impact on {target}",
  scenImpactTime: "time",
  scenImpactFinal: "final",
  scenNoEffectTitle: "Scenario {id} changes nothing measurable",
  scenNoEffectDetail: "{n} value(s) changed, but no node time, reach rate or final resource moved. The change may hit content this policy never uses.",
  newlyReached: "newly reached at {min}",
  noLongerReached: "no longer reached (was {min})",
  regen: "regen",
  waitCauseTitle: "{node}: {pct} of waiting is spent on {res}",
  waitCauseDetail: "{node} takes {seg} of the progression time; of its {wait} waiting, {mins} is waiting for {res} to accumulate. Improving {res} income or lowering its cost moves this step most.",
  waitTimeGatedTitle: "{node} is time-gated by {res}",
  waitTimeGatedDetail: "{pct} of the {wait} spent waiting at {node} is for the {res} counter (training/timers); resource income does not speed this up.",
  wasteTitle: "Policy \"{policy}\" over-produces {res} via {action}: {pct} unused",
  wasteDetail: "Makes {made} per run but only ~{needed} are needed; {unused} left over.{costs} This is a strategy inefficiency, not a game bottleneck.",
  wasteCost: " Wasted inputs: {list}.",
  scenLimiterTitle: "Scenario {id}: the limiting resource changes at {nodes}",
  scenLimiterDetail: "{shifts}",
  scenLimiterShift: "{node}: {from} → {to}",
  otherLimiter: "other",
};

const ZH: Msgs = {
  invalidTitle: "模型無效（{n} 個錯誤）；未進行任何模擬",
  validationWarningsTitle: "{n} 個驗證警告",
  ruleErrorTitle: "自訂規則「{id}」執行失敗",
  unreachableTitle: "「{target}」在設計上無法達成",
  unreachableFallback: "靜態可達性分析找不到能滿足它的路徑",
  stuckTitle: "{c}/{r} 場執行卡死：沒有可負擔的動作，且沒有資源會再生",
  stuckFallback: "未記錄阻礙原因（可能政策排除了所需動作）",
  stallTitle: "{pct} 的執行在「{node}」之前停止",
  stallLimitedBy: "（受限於「{res}」）",
  stallShortA: " — 缺少 {gap} {res}；以 {rate}/h 計約需再玩 {eta}",
  stallShortB: " — 缺少 {gap} {res}，其淨產率為 {rate}/h：無法自行補足",
  stallFallback: "條件已滿足；但時間/動作數耗盡",
  partialTitle: "僅 {pct} 的執行到達「{node}」",
  partialDetail: "由此開始分歧：隨機性決定玩家能否在限制內推進。",
  slowTitle: "「{from}」→「{to}」佔整體推進時間的 {share}",
  slowDetail: "至最後共同到達節點的中位數為 {m}（共 {h}）。",
  spikeTitle: "「{node}」出現節奏跳升：{b}，上一段為 {a}（×{factor}）",
  spikeDetail: "區段「{from}」→「{to}」。",
  varianceTitle: "「{nodes}」的到達時間差異很大",
  varianceDetail: "{node}：p10 {p10} / p90 {p90}（×{f}）",
  waitingTitle: "玩家花費 {pct} 的遊玩時間等待資源再生",
  waitingDetail: "等待中位數 {w}（總遊玩 {played}）。",
  overflowTitle: "「{res}」溢出上限：{pct} 的收入被浪費",
  overflowDetail: "每場平均損失 {lost}，保留 {kept}。可提高上限、加入消耗途徑，或減少掛機時間。",
  deficitTitle: "「{res}」為淨負值（{rate}/h）",
  deficitRunsDry: "，且已耗盡",
  deficitDetail: "每場產出 {p}、消耗 {c}；中位數期末 {f}。",
  noSinkTitle: "只產出不消耗：「{res}」",
  noSinkDetail: "若作為計數器/進度統計（例如僅作為條件的經驗值）則無妨；否則可能缺少消耗途徑。",
  hoardTitle: "「{res}」囤積：中位數期末 {f} 佔收入的 {pct}",
  hoardDetail: "每場僅消耗 {p} 中的 {c}；消耗途徑可能太弱。",
  sourceTitle: "「{res}」依賴單一來源：「{source}」提供 {pct}",
  sourceDetail: "調整「{source}」將影響整個「{res}」經濟。",
  unusedTitle: "在政策「{policy}」下有 {n} 個動作從未使用",
  unusedDetail: "{actions} — 可能是無用內容、鎖在未到達節點之後，或在政策下被排序在後/從未被選擇。",
  scenInvalidTitle: "情境「{id}」產生無效模型；未模擬",
  scenStuckTitle: "情境「{id}」：{c}/{r} 場執行卡死",
  scenCompletionTitle: "情境「{id}」：完成率 {b} → {s}",
  scenCompletionMore: "更多執行能在限制內完成整個路線。",
  scenCompletionFewer: "較少執行能在限制內完成整個路線。",
  scenReachTitle: "情境「{id}」：到達率於「{nodes}」發生變化",
  scenReachDetail: "{node} {b} → {s}",
  scenImpactTitle: "情境「{id}」：對「{target}」影響最大",
  scenImpactTime: "時間",
  scenImpactFinal: "期末",
  scenNoEffectTitle: "情境「{id}」未造成任何可測量的變化",
  scenNoEffectDetail: "已變更 {n} 個數值，但節點時間、到達率與期末資源皆無變化。變更可能影響到此政策從未使用的內容。",
  newlyReached: "新到達：{min}",
  noLongerReached: "不再到達（原為 {min}）",
  regen: "再生",
  waitCauseTitle: "「{node}」：{pct} 的等待耗在「{res}」",
  waitCauseDetail: "「{node}」佔整體推進時間的 {seg}；其 {wait} 的等待中，有 {mins} 在等「{res}」累積。提高「{res}」收入或降低其消耗，對此階段的加速最有效。",
  waitTimeGatedTitle: "「{node}」受「{res}」計時限制",
  waitTimeGatedDetail: "在「{node}」的 {wait} 等待中，有 {pct} 是在等「{res}」計數（修練/計時）；增加資源收入無法加速此階段。",
  wasteTitle: "政策「{policy}」透過「{action}」過量產出「{res}」：{pct} 未使用",
  wasteDetail: "每場製作 {made}，但僅需約 {needed}；剩餘 {unused}。{costs}這是策略效率問題，而非遊戲瓶頸。",
  wasteCost: " 浪費的投入：{list}。",
  scenLimiterTitle: "情境「{id}」：限制資源於「{nodes}」改變",
  scenLimiterDetail: "{shifts}",
  scenLimiterShift: "「{node}」：{from} → {to}",
  otherLimiter: "其他",
};

function msgs(lang: InsightLang): Msgs {
  return lang === "zh-TW" ? ZH : EN;
}

function fill(tpl: string, v: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? `{${k}}`));
}

/** Display-name lookups for node/resource/action ids, falling back to the raw id. */
interface Names {
  node(id: string): string;
  res(id: string): string;
  action(id: string): string;
}

function namesOf(report: AnyReport): Names {
  const nodes = new Map<string, string>();
  const res = new Map<string, string>();
  const actions = new Map<string, string>();
  const primary = report.kind === "compare" ? report.baseline : report.kind === "validate" ? undefined : report.simulation;
  if (primary) {
    for (const n of primary.nodes) if (n.name) nodes.set(n.id, n.name);
    for (const r of primary.resources) if (r.name) res.set(r.id, r.name);
    for (const a of primary.actionUsage) if (a.name) actions.set(a.id, a.name);
  }
  return {
    node: (id) => nodes.get(id) ?? id,
    res: (id) => res.get(id) ?? id,
    action: (id) => actions.get(id) ?? id,
  };
}

/** Display name for a flow source/sink key (`regen`, `action:<id>` or `node:<id>`). */
function flowKeyName(key: string, names: Names, m: Msgs): string {
  if (key === "regen") return m.regen;
  const mm = /^(action|node):(.*)$/.exec(key);
  if (!mm) return key;
  return mm[1] === "action" ? names.action(mm[2]!) : names.node(mm[2]!);
}

/** Unmodelled features whose ffects list intersects the given resource ids. */
function caveatsFor(report: AnyReport, ids: string[]): string[] | undefined {
  const set = new Set(ids);
  const feats = report.unsupported.filter((u) => u.affects?.some((a) => set.has(a))).map((u) => u.feature);
  return feats.length ? feats : undefined;
}

function withCaveats(f: Finding, caveats: string[] | undefined): Finding {
  if (caveats) f.caveats = caveats;
  return f;
}

export function buildInsights(report: AnyReport, lang: InsightLang = "en", opts: BuildInsightsOptions = {}): Insights {
  const T = resolveThresholds(opts.thresholds);
  const m = msgs(lang);
  const names = namesOf(report);
  const findings: Finding[] = [];
  const ins: Insights = { kind: report.kind, findings };
  if (opts.thresholds && Object.keys(opts.thresholds).length) ins.thresholdOverrides = { ...opts.thresholds };

  if (!report.validation.ok) {
    findings.push({
      id: "invalid",
      severity: "critical",
      category: "data",
      scope: "model",
      title: fill(m.invalidTitle, { n: report.validation.errors.length }),
      detail: report.validation.errors.slice(0, 3).map((e) => `[${e.code}] ${e.path}: ${e.message}`).join("; "),
    });
  } else if (report.validation.warnings.length) {
    findings.push({
      id: "validation-warnings",
      severity: "info",
      category: "data",
      scope: "model",
      title: fill(m.validationWarningsTitle, { n: report.validation.warnings.length }),
      detail: report.validation.warnings.slice(0, 3).map((e) => `[${e.code}] ${e.path}: ${e.message}`).join("; "),
    });
  }

  if (report.kind === "analyze" && report.reachability) {
    for (const n of report.reachability.nodes.filter((x) => x.status === "unreachable")) {
      findings.push({
        id: "unreachable",
        severity: "critical",
        category: "bottleneck",
        scope: "static",
        subject: n.target,
        title: fill(m.unreachableTitle, { target: names.node(n.target) }),
        detail: n.reasons.join("; ") || m.unreachableFallback,
      });
    }
  }

  const primary = report.kind === "compare" ? report.baseline : report.kind === "validate" ? undefined : report.simulation;
  if (primary) {
    const scope = report.kind === "compare" ? "baseline" : "simulation";
    ins.pacing = pacing(primary);
    ins.economy = economy(primary);
    ins.actionUsage = [...primary.actionUsage].sort((a, b) => b.mean - a.mean);
    ins.waste = primary.waste;
    const hist = histograms(primary);
    if (hist.length) ins.histograms = hist;
    const tl = timeline(primary);
    if (tl) ins.timeline = tl;
    const cav = (ids: string[]) => caveatsFor(report, ids);
    bottleneckRules(primary, ins.pacing, scope, names, m, cav, T, findings);
    economyRules(primary, ins.economy, ins.pacing, scope, names, m, cav, T, findings);
  }

  if (report.kind === "compare") {
    ins.scenarios = scenarioViews(report);
    scenarioRules(report, ins.scenarios, names, m, lang, (ids) => caveatsFor(report, ids), T, findings);
  }

  if (opts.rules?.length) runCustomRules(opts.rules, { report, lang, thresholds: T, ...(primary ? { scope: report.kind === "compare" ? "baseline" : "simulation", sim: primary } : {}), ...(ins.pacing ? { pacing: ins.pacing } : {}), ...(ins.economy ? { economy: ins.economy } : {}), findings }, m, findings);

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  return ins;
}

function runCustomRules(rules: InsightRule[], ctx: RuleContext, m: Msgs, out: Finding[]) {
  const builtins = ctx.findings.slice();
  const frozen: RuleContext = { ...ctx, findings: builtins };
  const defaultScope = ctx.scope ?? "model";
  for (const rule of rules) {
    try {
      const got = rule.evaluate(frozen) ?? [];
      if (!Array.isArray(got)) throw new Error("evaluate() must return an array of findings");
      for (const f of got) {
        const bad = badFinding(f);
        if (bad) throw new Error(bad);
        out.push({ ...f, scope: f.scope || defaultScope, rule: rule.id });
      }
    } catch (e) {
      out.push({
        id: "rule-error",
        severity: "warning",
        category: "data",
        scope: "model",
        title: fill(m.ruleErrorTitle, { id: rule.id }),
        detail: (e as Error).message,
        rule: rule.id,
      });
    }
  }
}

function badFinding(f: unknown): string | null {
  if (typeof f !== "object" || f === null) return "finding must be an object";
  const o = f as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return "finding.id must be a non-empty string";
  if (o.severity !== "critical" && o.severity !== "warning" && o.severity !== "info") return `finding "${o.id}": severity must be critical|warning|info`;
  if (typeof o.category !== "string" || !CATEGORIES.includes(o.category as Category)) return `finding "${o.id}": category must be one of ${CATEGORIES.join(",")}`;
  if (typeof o.title !== "string" || typeof o.detail !== "string") return `finding "${o.id}": title and detail must be strings`;
  return null;
}

// ---------------------------------------------------------------- distributions / timeline

const HIST_BINS = 20;
const TIMELINE_BUCKETS = 48;
const TIMELINE_SERIES = 5;

function histograms(s: SimulationResult): Histogram[] {
  const runs = s.runResults;
  if (!runs?.length) return [];
  const out: Histogram[] = [];
  for (const n of s.nodes) {
    const xs = runs.map((r) => r.nodes[n.id]?.minute).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    if (!xs.length) continue;
    const min = xs[0]!;
    const max = xs[xs.length - 1]!;
    const k = max > min ? HIST_BINS : 1;
    const bins = new Array<number>(k).fill(0);
    for (const v of xs) bins[k === 1 ? 0 : Math.min(k - 1, Math.floor(((v - min) / (max - min)) * k))]!++;
    out.push({ id: n.id, count: xs.length, missing: runs.length - xs.length, min: round(min, 2), max: round(max, 2), bins, median: round(xs[Math.floor((xs.length - 1) / 2)]!, 2) });
  }
  return out;
}

function timeline(s: SimulationResult): TimelineView | undefined {
  const ev = s.trace;
  if (!ev?.length) return undefined;
  const horizon = Math.max(0, ...ev.map((e) => e.t));
  if (!(horizon > 0)) return undefined;
  const nodes = ev.flatMap((e) => (e.kind === "node" ? [{ id: e.id, t: round(e.t, 2) }] : []));
  const spans: { start: number; end: number }[] = [];
  for (const e of ev) {
    if (e.kind !== "wait") continue;
    const start = e.t - e.minutes;
    const last = spans[spans.length - 1];
    if (last && start <= last.end + 1e-9) last.end = e.t;
    else spans.push({ start, end: e.t });
  }
  const waited = spans.reduce((a, b) => a + (b.end - b.start), 0);
  const bucketMinutes = horizon / TIMELINE_BUCKETS;
  const per = new Map<string, number[]>();
  for (const e of ev) {
    if (e.kind !== "action") continue;
    let c = per.get(e.id);
    if (!c) per.set(e.id, (c = new Array<number>(TIMELINE_BUCKETS).fill(0)));
    c[Math.min(TIMELINE_BUCKETS - 1, Math.floor(e.t / bucketMinutes))]!++;
  }
  const ranked = [...per.entries()].map(([id, counts]) => ({ id, counts, total: counts.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  const series = ranked.slice(0, TIMELINE_SERIES);
  const rest = ranked.slice(TIMELINE_SERIES);
  if (rest.length) {
    const counts = new Array<number>(TIMELINE_BUCKETS).fill(0);
    for (const r of rest) r.counts.forEach((c, i) => (counts[i]! += c));
    series.push({ id: "other", counts, total: counts.reduce((a, b) => a + b, 0) });
  }
  return { horizon: round(horizon, 2), nodes, waits: spans.map((x) => ({ start: round(x.start, 2), end: round(x.end, 2) })), waitingShare: round(waited / horizon, 4), bucketMinutes: round(bucketMinutes, 4), series };
}

// ---------------------------------------------------------------- pacing / bottleneck

function pacing(s: SimulationResult): PacingView {
  const reached = s.nodes.filter((n) => n.minute && n.reachRate >= 0.5);
  const horizon = reached.length ? reached[reached.length - 1]!.minute!.median : 0;
  const segments: Segment[] = [];
  for (let i = 1; i < s.nodes.length; i++) {
    const n = s.nodes[i]!;
    if (!n.deltaMinute) continue;
    segments.push({ from: s.nodes[i - 1]!.id, to: n.id, medianMinutes: n.deltaMinute.median, share: horizon > 0 ? round(n.deltaMinute.median / horizon, 4) : 0 });
  }
  const slowest = segments.length ? segments.reduce((a, b) => (b.medianMinutes > a.medianMinutes ? b : a)) : null;
  const stalls = s.stalls.map((st) => ({
    node: st.node,
    share: round(st.runs / s.runs, 4),
    reasons: st.exampleReasons,
    limits: st.exampleReasons.map((r) => parseLimiter(r, s)).filter((x): x is Limiter => !!x),
  }));
  return {
    nodes: s.nodes.map((n) => ({ id: n.id, reachRate: n.reachRate, p10: n.minute?.p10 ?? null, median: n.minute?.median ?? null, p90: n.minute?.p90 ?? null, limiters: n.limiters.map((l) => ({ resource: l.resource, minutes: l.minutes, share: l.share })) })),
    segments,
    slowest,
    horizonMinutes: horizon,
    stops: Object.entries(s.stopReasons).map(([reason, count]) => ({ reason, share: round(count! / s.runs, 4) })),
    stalls,
  };
}

const COST_RE = /^costs (\S+) ([\d.]+) \(have ([-\d.]+)\)$/;
const REQ_RE = /^requires (\S+) >= ([\d.]+) \(have ([-\d.]+)\)$/;

/** Parse engine blocker reasons (src/core/simulate.ts `reasons()`) into a resource gap. */
export function parseLimiter(reason: string, s: SimulationResult): Limiter | null {
  const m = COST_RE.exec(reason) ?? REQ_RE.exec(reason);
  if (!m) return null;
  const resource = m[1]!;
  const need = Number(m[2]);
  const have = Number(m[3]);
  const netPerHour = s.resources.find((r) => r.id === resource)?.netPerHour ?? 0;
  const gap = round(Math.max(0, need - have));
  return {
    resource,
    kind: reason.startsWith("costs") ? "cost" : "requirement",
    need,
    have,
    gap,
    netPerHour,
    etaMinutes: netPerHour > 0 ? round((gap / netPerHour) * 60, 2) : null,
  };
}

type Cav = (ids: string[]) => string[] | undefined;

function bottleneckRules(s: SimulationResult, p: PacingView, scope: string, names: Names, m: Msgs, cav: Cav, T: Thresholds, out: Finding[]) {
  const mc = s.mode === "monte-carlo";

  if (s.stuck) {
    const blockers = s.stuck.examples.filter((b) => b.reasons.length).slice(0, 4);
    out.push({
      id: "stuck",
      severity: "critical",
      category: "bottleneck",
      scope,
      title: fill(m.stuckTitle, { c: s.stuck.count, r: s.runs }),
      detail: blockers.map((b) => `${b.target}: ${b.reasons.join("; ")}`).join(" | ") || m.stuckFallback,
    });
  }

  for (const st of p.stalls) {
    if (st.share < T.stallShare) continue;
    const lim = st.limits[0];
    let detail = st.reasons.join("; ") || m.stallFallback;
    if (lim) {
      detail += lim.etaMinutes !== null
        ? fill(m.stallShortA, { gap: num(lim.gap), res: names.res(lim.resource), rate: num(lim.netPerHour), eta: fmtMin(lim.etaMinutes) })
        : fill(m.stallShortB, { gap: num(lim.gap), res: names.res(lim.resource), rate: num(lim.netPerHour) });
    }
    out.push(withCaveats({
      id: "stall",
      severity: "warning",
      category: "bottleneck",
      scope,
      subject: `node:${st.node}`,
      title: fill(m.stallTitle, { pct: pct(st.share), node: names.node(st.node) }) + (lim ? fill(m.stallLimitedBy, { res: names.res(lim.resource) }) : ""),
      detail,
    }, lim ? cav([lim.resource]) : undefined));
  }

  const partial = s.nodes.find((n) => n.reachRate > 0 && n.reachRate < 1);
  if (partial) {
    out.push({
      id: "partial-reach",
      severity: "warning",
      category: "bottleneck",
      scope,
      subject: `node:${partial.id}`,
      title: fill(m.partialTitle, { pct: pct(partial.reachRate), node: names.node(partial.id) }),
      detail: m.partialDetail,
    });
  }

  const reachedCount = p.nodes.filter((n) => n.median !== null).length;
  if (p.slowest && reachedCount >= T.slowSegmentMinNodes && p.slowest.share >= T.slowSegmentShare) {
    out.push({
      id: "slow-segment",
      severity: "warning",
      category: "bottleneck",
      scope,
      subject: `node:${p.slowest.to}`,
      title: fill(m.slowTitle, { from: names.node(p.slowest.from), to: names.node(p.slowest.to), share: pct(p.slowest.share) }),
      detail: fill(m.slowDetail, { m: fmtMin(p.slowest.medianMinutes), h: fmtMin(p.horizonMinutes) }),
    });
  }

  const kinds = new Map(s.resources.map((r) => [r.id, r.kind] as const));
  for (const seg of p.segments) {
    if (seg.share < T.limiterSegmentShare) continue;
    const node = p.nodes.find((n) => n.id === seg.to);
    const top = node?.limiters[0];
    if (!node || !top || top.share < T.limiterShare) continue;
    const wait = node.limiters.reduce((a, l) => a + l.minutes, 0);
    const vars = { node: names.node(seg.to), res: top.resource === "other" ? m.otherLimiter : names.res(top.resource), pct: pct(top.share), seg: pct(seg.share), wait: fmtMin(wait), mins: fmtMin(top.minutes) };
    if (kinds.get(top.resource) === "counter") {
      out.push({ id: "wait-time-gated", severity: "info", category: "bottleneck", scope, subject: `node:${seg.to}`, title: fill(m.waitTimeGatedTitle, vars), detail: fill(m.waitTimeGatedDetail, vars) });
    } else {
      out.push(withCaveats({ id: "wait-cause", severity: seg === p.slowest ? "warning" : "info", category: "bottleneck", scope, subject: `node:${seg.to}`, title: fill(m.waitCauseTitle, vars), detail: fill(m.waitCauseDetail, vars) }, cav([top.resource])));
    }
  }

  for (let i = 1; i < p.segments.length; i++) {
    const a = p.segments[i - 1]!;
    const b = p.segments[i]!;
    if (a.medianMinutes > 0 && b.medianMinutes >= a.medianMinutes * T.spikeFactor && b !== p.slowest) {
      out.push({
        id: "pacing-spike",
        severity: "info",
        category: "bottleneck",
        scope,
        subject: `node:${b.to}`,
        title: fill(m.spikeTitle, { node: names.node(b.to), b: fmtMin(b.medianMinutes), a: fmtMin(a.medianMinutes), factor: num(round(b.medianMinutes / a.medianMinutes, 2)) }),
        detail: fill(m.spikeDetail, { from: names.node(b.from), to: names.node(b.to) }),
      });
    }
  }

  if (mc) {
    const noisy = s.nodes.filter((n) => n.minute && n.minute.p10 > 0 && n.minute.p90 / n.minute.p10 >= T.varianceRatio);
    if (noisy.length) {
      out.push({
        id: "variance",
        severity: "info",
        category: "bottleneck",
        scope,
        subject: `node:${noisy[0]!.id}`,
        title: fill(m.varianceTitle, { nodes: noisy.map((n) => names.node(n.id)).join(", ") }),
        detail: noisy.map((n) => fill(m.varianceDetail, { node: names.node(n.id), p10: fmtMin(n.minute!.p10), p90: fmtMin(n.minute!.p90), f: num(round(n.minute!.p90 / n.minute!.p10, 2)) })).join("; "),
      });
    }
  }

  if (s.minutes.median > 0 && s.minutesWaiting.median / s.minutes.median >= T.waitingShare) {
    out.push({
      id: "waiting",
      severity: "info",
      category: "bottleneck",
      scope,
      title: fill(m.waitingTitle, { pct: pct(s.minutesWaiting.median / s.minutes.median) }),
      detail: fill(m.waitingDetail, { w: fmtMin(s.minutesWaiting.median), played: fmtMin(s.minutes.median) }),
    });
  }
}

// ---------------------------------------------------------------- economy

function economy(s: SimulationResult): EconomyRow[] {
  return s.resources.map((r) => {
    const produced = r.produced.mean;
    const consumed = r.consumed.mean;
    const overflow = r.overflow.mean;
    return {
      id: r.id,
      produced,
      consumed,
      finalMedian: r.final.median,
      netPerHour: r.netPerHour,
      overflow,
      overflowShare: produced + overflow > 0 ? round(overflow / (produced + overflow), 4) : 0,
      sources: r.topSources.map((x) => ({ key: x.source, mean: x.mean, share: produced > 0 ? round(x.mean / produced, 4) : 0 })),
      sinks: r.topSinks.map((x) => ({ key: x.sink, mean: x.mean, share: consumed > 0 ? round(x.mean / consumed, 4) : 0 })),
    };
  });
}

function economyRules(s: SimulationResult, rows: EconomyRow[], p: PacingView, scope: string, names: Names, m: Msgs, cav: Cav, T: Thresholds, out: Finding[]) {
  const kinds = new Map(s.resources.map((r) => [r.id, r.kind] as const));
  const wasted = new Set(s.waste.map((w) => w.resource));
  const limiting = new Set(p.stalls.flatMap((st) => st.limits.map((l) => l.resource)));
  const noSink: string[] = [];

  for (const r of rows) {
    const subject = `resource:${r.id}`;
    const kind = kinds.get(r.id) ?? "currency";
    if (kind === "counter") continue;
    const caveats = cav([r.id]);
    if (r.overflow > 0 && !(kind === "crafted" && wasted.has(r.id))) {
      const warn = r.overflowShare >= T.overflowWarnShare && !caveats;
      out.push(withCaveats({
        id: "overflow",
        severity: warn ? "warning" : "info",
        category: "economy",
        scope,
        subject,
        title: fill(m.overflowTitle, { res: names.res(r.id), pct: pct(r.overflowShare) }),
        detail: fill(m.overflowDetail, { lost: num(r.overflow), kept: num(r.produced) }),
      }, caveats));
    }
    if (r.netPerHour < 0 && r.consumed > 0) {
      const drained = r.finalMedian <= 0;
      out.push(withCaveats({
        id: "deficit",
        severity: drained ? "warning" : "info",
        category: "economy",
        scope,
        subject,
        title: fill(m.deficitTitle, { res: names.res(r.id), rate: num(r.netPerHour) }) + (drained ? m.deficitRunsDry : ""),
        detail: fill(m.deficitDetail, { p: num(r.produced), c: num(r.consumed), f: num(r.finalMedian) }),
      }, caveats));
    }
    if (r.consumed === 0 && r.produced > 0) noSink.push(r.id);
    if (r.consumed > 0 && r.produced > 0 && r.finalMedian >= r.produced * T.hoardShare && !limiting.has(r.id) && kind !== "crafted") {
      out.push(withCaveats({
        id: "hoarding",
        severity: "info",
        category: "economy",
        scope,
        subject,
        title: fill(m.hoardTitle, { res: names.res(r.id), f: num(r.finalMedian), pct: pct(r.finalMedian / r.produced) }),
        detail: fill(m.hoardDetail, { c: num(r.consumed), p: num(r.produced) }),
      }, caveats));
    }
    const top = r.sources[0];
    if (top && r.consumed > 0 && r.sources.length >= 1 && top.key !== "regen" && kind !== "crafted" && top.share >= T.sourceConcentration) {
      out.push({
        id: "source-concentration",
        severity: "info",
        category: "economy",
        scope,
        subject,
        title: fill(m.sourceTitle, { res: names.res(r.id), source: flowKeyName(top.key, names, m), pct: pct(top.share) }),
        detail: fill(m.sourceDetail, { source: flowKeyName(top.key, names, m), res: names.res(r.id) }),
      });
    }
  }

  if (noSink.length) {
    out.push({
      id: "no-sink",
      severity: "info",
      category: "economy",
      scope,
      title: fill(m.noSinkTitle, { res: noSink.map((id) => names.res(id)).join(", ") }),
      detail: m.noSinkDetail,
    });
  }

  for (const w of s.waste) {
    if (w.unusedShare < 0.05 || w.unused <= 0) continue;
    const spend = Math.max(0, ...w.wastedCosts.map((c) => c.shareOfConsumed));
    const costs = w.wastedCosts.filter((c) => c.amount > 0).slice(0, 3).map((c) => `${names.res(c.resource)} ${num(c.amount)} (${pct(c.shareOfConsumed)})`).join(", ");
    out.push({
      id: "strategy-waste",
      severity: w.unusedShare >= T.wasteShare || spend >= T.wasteSpendShare ? "warning" : "info",
      category: "policy",
      scope,
      subject: `action:${w.action}`,
      title: fill(m.wasteTitle, { policy: s.policy.id, res: names.res(w.resource), action: names.action(w.action), pct: pct(w.unusedShare) }),
      detail: fill(m.wasteDetail, { made: num(w.made), needed: num(round(w.made - w.unused, 2)), unused: num(w.unused), costs: costs ? fill(m.wasteCost, { list: costs }) : "" }),
    });
  }

  const unused = s.actionUsage.filter((a) => a.mean === 0).map((a) => a.id);
  if (unused.length) {
    out.push({
      id: "unused-action",
      severity: "info",
      category: "economy",
      scope,
      title: fill(m.unusedTitle, { n: unused.length, policy: s.policy.id }),
      detail: fill(m.unusedDetail, { actions: unused.map((id) => names.action(id)).join(", ") }),
    });
  }
}

// ---------------------------------------------------------------- scenarios

function impactScore(d: Delta): number {
  if (d.pct !== null) return Math.abs(d.pct);
  if (d.baseline === null && d.scenario !== null) return Infinity; // newly reached
  if (d.baseline !== null && d.scenario === null) return Infinity; // no longer reached
  return Math.abs(d.delta ?? 0);
}

function scenarioViews(r: CompareReport): ScenarioView[] {
  return r.scenarios.map((sc) => {
    const v: ScenarioView = {
      id: sc.id,
      valid: sc.validation.ok,
      changes: sc.applied.reduce((n, a) => n + a.matches.length, 0),
      completionRate: sc.diff?.completionRate ?? null,
      resourcesComparable: !!sc.simulation && !!r.baseline && Math.abs(sc.simulation.minutes.median - r.baseline.minutes.median) < 1e-6,
      limiterShifts: [],
      nodeImpact: [],
      resourceImpact: [],
    };
    if (sc.description) v.description = sc.description;
    if (sc.diff) {
      v.nodeImpact = sc.diff.nodes
        .filter((n) => changed(n.medianMinute) || changed(n.reachRate))
        .sort((a, b) => impactScore(b.medianMinute) - impactScore(a.medianMinute) || impactScore(b.reachRate) - impactScore(a.reachRate));
      if (v.resourcesComparable) {
        v.resourceImpact = sc.diff.resourcesFinalMedian.filter((x) => changed(x.delta)).sort((a, b) => impactScore(b.delta) - impactScore(a.delta));
      }
    }
    if (sc.simulation && r.baseline) {
      for (const n of sc.simulation.nodes) {
        const b = r.baseline.nodes.find((x) => x.id === n.id);
        const from = b?.limiters[0];
        const to = n.limiters[0];
        if (from && to && from.resource !== to.resource && n.reachRate > 0 && b!.reachRate > 0) v.limiterShifts.push({ node: n.id, from: from.resource, to: to.resource });
      }
    }
    return v;
  });
}

function changed(d: Delta): boolean {
  return d.delta !== null ? d.delta !== 0 : d.baseline !== d.scenario;
}

function scenarioRules(r: CompareReport, views: ScenarioView[], names: Names, m: Msgs, lang: InsightLang, cav: Cav, T: Thresholds, out: Finding[]) {
  for (const v of views) {
    const scope = `scenario:${v.id}`;
    const sc = r.scenarios.find((x) => x.id === v.id)!;
    if (!v.valid) {
      out.push({
        id: "scenario-invalid",
        severity: "critical",
        category: "scenario",
        scope,
        subject: scope,
        title: fill(m.scenInvalidTitle, { id: v.id }),
        detail: sc.validation.errors.slice(0, 3).map((e) => `[${e.code}] ${e.path}: ${e.message}`).join("; "),
      });
      continue;
    }
    if (sc.simulation?.stuck) {
      out.push({
        id: "stuck",
        severity: "critical",
        category: "bottleneck",
        scope,
        subject: scope,
        title: fill(m.scenStuckTitle, { id: v.id, c: sc.simulation.stuck.count, r: sc.simulation.runs }),
        detail: sc.simulation.stuck.examples.filter((b) => b.reasons.length).slice(0, 4).map((b) => `${b.target}: ${b.reasons.join("; ")}`).join(" | "),
      });
    }
    const cr = v.completionRate;
    if (cr && cr.delta) {
      out.push({
        id: "scenario-completion",
        severity: cr.delta < 0 ? "warning" : "info",
        category: "scenario",
        scope,
        subject: scope,
        title: fill(m.scenCompletionTitle, { id: v.id, b: pct(cr.baseline ?? 0), s: pct(cr.scenario ?? 0) }),
        detail: cr.delta < 0 ? m.scenCompletionFewer : m.scenCompletionMore,
      });
    }
    const reach = v.nodeImpact.filter((n) => changed(n.reachRate));
    if (reach.length) {
      const down = reach.some((n) => (n.reachRate.delta ?? 0) < 0);
      out.push({
        id: "scenario-reach",
        severity: down ? "warning" : "info",
        category: "scenario",
        scope,
        subject: scope,
        title: fill(m.scenReachTitle, { id: v.id, nodes: reach.map((n) => names.node(n.id)).join(", ") }),
        detail: reach.map((n) => fill(m.scenReachDetail, { node: names.node(n.id), b: pct(n.reachRate.baseline ?? 0), s: pct(n.reachRate.scenario ?? 0) })).join("; "),
      });
    }
    if (v.limiterShifts.length) {
      const res = (id: string) => (id === "other" ? m.otherLimiter : names.res(id));
      out.push(withCaveats({
        id: "scenario-limiter-shift",
        severity: "info",
        category: "scenario",
        scope,
        subject: scope,
        title: fill(m.scenLimiterTitle, { id: v.id, nodes: v.limiterShifts.map((x) => names.node(x.node)).join(", ") }),
        detail: v.limiterShifts.map((x) => fill(m.scenLimiterShift, { node: names.node(x.node), from: res(x.from), to: res(x.to) })).join("; "),
      }, cav(v.limiterShifts.flatMap((x) => [x.from, x.to]))));
    }
    const timeImpact = v.nodeImpact.filter((n) => changed(n.medianMinute)).slice(0, T.scenarioTop);
    const resImpact = v.resourceImpact.slice(0, T.scenarioTop);
    if (timeImpact.length || resImpact.length) {
      const parts: string[] = [];
      if (timeImpact.length) parts.push(m.scenImpactTime + ": " + timeImpact.map((n) => `${names.node(n.id)} ${fmtDeltaMin(n.medianMinute, lang)}`).join(", "));
      if (resImpact.length) parts.push(m.scenImpactFinal + ": " + resImpact.map((x) => `${names.res(x.id)} ${signedPct(x.delta.pct)}`).join(", "));
      out.push({
        id: "scenario-impact",
        severity: "info",
        category: "scenario",
        scope,
        subject: timeImpact[0] ? `node:${timeImpact[0].id}` : `resource:${resImpact[0]!.id}`,
        title: fill(m.scenImpactTitle, { id: v.id, target: timeImpact[0] ? names.node(timeImpact[0].id) : names.res(resImpact[0]!.id) }),
        detail: parts.join(" | "),
      });
    } else if (!(cr && cr.delta) && !v.limiterShifts.length) {
      out.push({
        id: "scenario-no-effect",
        severity: "warning",
        category: "scenario",
        scope,
        subject: scope,
        title: fill(m.scenNoEffectTitle, { id: v.id }),
        detail: fill(m.scenNoEffectDetail, { n: v.changes }),
      });
    }
  }
}

export function fmtDeltaMin(d: Delta, lang: InsightLang = "en"): string {
  const m = msgs(lang);
  if (d.baseline === null && d.scenario !== null) return fill(m.newlyReached, { min: fmtMin(d.scenario) });
  if (d.baseline !== null && d.scenario === null) return fill(m.noLongerReached, { min: fmtMin(d.baseline) });
  if (d.delta === null) return "-";
  return `${fmtMin(d.baseline!)} → ${fmtMin(d.scenario!)} (${signedPct(d.pct)})`;
}