# Adapter 撰寫指南（Adapter API 0.1）

Adapter 的唯一職責：**讀取專案原始資料 → 回傳標準 `GameModel`**。
模擬、驗證、統計全部由 GDL Core 負責；adapter 不應包含模擬邏輯。

## 1. 放置位置

在遊戲 repo（或任意目錄）建立：

```text
.gdl/
  config.json
  adapter.ts        # 若使用 builtin:json-model 則不需要
```

```json
{
  "projectId": "dao2",
  "adapter": "./adapter.ts",
  "dataRoots": ["./data"],
  "adapterOptions": { "farmGoldRatio": 0.4 },
  "outputDir": "./.gdl/reports"
}
```

- 相對路徑以**專案根目錄**（`.gdl/` 的上一層）為基準，`adapter` 以 `.gdl/` 為基準。
- `adapter: "builtin:json-model"`：直接讀取 `dataRoots` 中的標準模型 JSON。
- 讀檔不可跳出專案根目錄（路徑逃逸會被拒絕）。

## 2. 最小範例

```ts
import { defineAdapter } from "gdl/src/adapter/api.js";   // 範例中使用相對路徑
import type { GameModel } from "gdl/src/schema/types.js";

export default defineAdapter({
  id: "my-game",
  version: "0.1.0",
  apiVersion: "0.1",
  async load(ctx): Promise<GameModel> {
    const levels = await ctx.readJson<{ id: string; exp: number }[]>("data/levels.json");
    return {
      schemaVersion: "0.1",
      project: { id: "my-game" },
      resources: [{ id: "exp" }],
      actions: [{ id: "grind", durationMinutes: 5, outcomes: [{ type: "resource", resource: "exp", amount: 10 }] }],
      progression: levels.map((l, i) => ({
        id: l.id, order: i,
        requirements: [{ type: "resource", resource: "exp", gte: l.exp }],
        source: { file: "data/levels.json", path: `$[${i}]` },
      })),
    };
  },
});
```

## 3. AdapterContext

| 成員 | 說明 |
|---|---|
| `projectRoot` | 專案根目錄絕對路徑 |
| `dataRoots` | 設定中的資料目錄 |
| `options` | `adapterOptions` 原樣傳入 |
| `readText(path)` / `readJson(path)` | **請一律透過這兩個讀檔**，GDL 才能記錄來源檔 SHA-256 以供重現 |
| `listFiles(dir, ext?)` | 列出檔案 |

## 4. 撰寫守則

1. **不猜值、不補值。** 資料缺欄位時丟出 `AdapterError`（或一般 Error）並指出檔案與欄位；GDL 會以 exit 1 回報。
2. **標註來源。** 在實體上填 `source: { file, path }`，驗證錯誤會指回原始資料位置。
3. **聲明不支援的玩法。** 無法合理抽象的機制（逐幀戰鬥、盤面策略…）放進 `unsupported[]`，不要硬塞進通用欄位。報告會顯示這些限制。
4. **時間只用 `durationMinutes`。** 不要建立時間資源。
5. **提供 policies。** 至少一個 `default`；它是明確、可執行的行為假設，而非「玩家人格」。
6. **不寫入。** Adapter 應為唯讀；GDL 不會修改原始資料。
7. **版本化。** 資料格式變更時遞增 adapter `version`；它會寫入每份報告。

## 4b. 自訂分析規則與門檻（選用）

Adapter 可匯出 `insightRules`，在內建規則之外追加專案專屬的 findings：

```ts
import { defineAdapter } from "../../../src/adapter/api.js";
import type { InsightRule } from "../../../src/insights/insights.js";

const rules: InsightRule[] = [{
  id: "energy-cap",
  evaluate(ctx) {
    const sim = ctx.sim; // 主要模擬結果（可能為 undefined，例如 validate 報告）
    if (!sim || sim.completionRate >= 0.5) return [];
    return [{ id: "low-completion", severity: "warning", category: "bottleneck", scope: "", title: "完成率偏低", detail: `${sim.completionRate}` }];
  },
}];
export default defineAdapter({ id: "my-game", version: "1.0.0", insightRules: rules, load: (ctx) => ctx.readJson("model.json") });
```

- `evaluate(ctx)` 必須是純函式；`ctx` 含 `report`、`lang`、`thresholds`、`sim`、`pacing`、`economy`、已產生的 `findings`。
- 回傳的 finding 會被驗證（severity / category / title / detail 必填），並自動標上 `rule`；`scope` 留空字串時補為預設 scope。
- 規則拋錯不會中斷分析，會轉成一則 `rule-error` warning。
- 規則只在 `inspect` / `report` / `index` / 產生報告時載入（解析 adapter 但不呼叫 `load`），需能在無資料的情況下 import。
- 內建規則門檻可在 `.gdl/config.json` 覆寫：`{ "insights": { "thresholds": { "stallShare": 0.1 } } }`；CLI `--threshold key=value` 優先於 config。
## 5. 參考實作

- `examples/dao2-mock/.gdl/adapter.ts` — 巢狀 JSON；境界 = 進度節點（經驗為檢查、靈石為消耗）、體力回復、獨立機率掉落。
- `examples/godtower-mock/.gdl/adapter.ts` — CSV；波次 = 進度節點，戰力抽象為資源，逐幀塔防戰鬥聲明為 unsupported。

兩者皆為 **mock 資料**，實際 Dao2 / GodTower 的資料結構待確認後需重寫映射。
