# GDL 標準 Game Model — schema 0.1

型別定義的權威來源：`src/schema/types.ts`；驗證規則：`src/schema/validate.ts`。

## 頂層

```jsonc
{
  "schemaVersion": "0.1",           // 必填；未知版本 => UNKNOWN_SCHEMA_VERSION
  "project": { "id": "x", "name": "…", "genre": "…" },
  "resources": [],                  // Resource[]
  "actions": [],                    // Action[]
  "progression": [],                // ProgressionNode[]（單一線性軌，依 order 排序）
  "policies": [],                   // 選填；沒有時自動產生 implicit policy（actions 原順序）
  "unsupported": [],                // 選填；{ feature, reason } — 報告中會列出
  "meta": {}                        // 選填；引擎忽略
}
```

## Resource

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | 唯一 |
| `initial` | number ≥ 0 | 預設 0，不可超過 `max` |
| `max` | number | 上限；超出部分計入 overflow |
| `regenPerMinute` | number ≥ 0 | 每遊戲內分鐘連續回復（如體力） |
| `kind` | `"currency"`（預設）/ `"counter"` / `"crafted"` | 資源性質，供報告規則去噪：`counter` = 計數器（訓練時數、技能等級），`crafted` = 由動作製作的成品 |

`unsupported[]` 的每一項可含 `affects: string[]`（資源 id）：標示因該未建模功能而數值不可靠的資源，相關發現會附 `caveats`。

**時間不是資源。** 時間只由 `Action.durationMinutes` 表達；若資源 id 看起來像時間（`time_minutes` 等），會出現 `TIME_AS_RESOURCE` 警告。

## Action

| 欄位 | 說明 |
|---|---|
| `durationMinutes` | 必填，> 0 才會推進時間；0 且無成本無上限 => `FREE_INFINITE_ACTION` 警告 |
| `costs` | `{resource, amount}[]`，執行時扣除 |
| `requires` | `Condition[]`，全部成立才可執行（不消耗） |
| `outcomes` | `Outcome[]` |
| `maxUses` | 單次 run 的使用上限（一次性升級等） |

## Condition

```jsonc
{ "type": "resource", "resource": "exp", "gte": 100, "lte": 999 }   // 檢查，不消耗
{ "type": "node", "node": "realm_2" }                                // 已抵達該節點
```

## Outcome

```jsonc
// 獨立擲骰；amount 可為固定值或閉區間（整數邊界 => 整數，否則連續）
{ "type": "resource", "resource": "gold", "amount": { "min": 5, "max": 10 }, "probability": 0.3 }

// 權重互斥表：恰好選中一項；outcomes 為空代表「沒掉東西」
{ "type": "table", "entries": [
  { "weight": 90, "outcomes": [] },
  { "weight": 10, "outcomes": [{ "type": "resource", "resource": "gem", "amount": 1 }] }
] }
```

## ProgressionNode

| 欄位 | 說明 |
|---|---|
| `order` | 唯一；決定線性順序 |
| `requirements` | 檢查型門檻（不消耗），如累積經驗 |
| `costs` | 突破時支付（消耗），如靈石 |

節點在滿足條件時由引擎自動推進（先 requirements，再支付 costs）。

## 模擬語意

- **expected 模式**：每個機率結果以期望值結算（`amount × probability`，區間取中點，表取加權平均）。快速、可做回歸比較，但**不是**分布。
- **monte-carlo 模式**：mulberry32 RNG，每個 run 的 seed 由主 seed 衍生，可完整重現。
- **priority policy**：每步執行清單中第一個可用的 action；沒有可用 action 時，若有回復中的資源會等待到最早可用時刻，否則判定 `stuck` 並記錄 blocker。
- **adaptive policy**（離線、確定性、不使用 LLM）：每步在「合法 action」（條件與成本滿足、剩餘時間足夠）中，依當下狀態打分並選最高者。
  - 欄位：`actions?`（候選池與同分順序；省略 = 全部 action）、`objective?`（目前僅 `"progress-rate"`）、
    `temperature?`（≥ 0，預設 0）、`lookaheadMinutes?`（≥ 0，預設 120）。
  - 分數 = 朝下一個進度節點的推進量（已達節點數 + 下一節點資源需求〔gte 門檻與 costs〕的平均完成度）除以耗時。
  - `lookaheadMinutes > 0`：候選先執行，之後以 expected 值貪婪模擬至多 N 分鐘，比較這段時間的推進速率，因此「買工具」這類投資可被選中；
    `0` = 純單步貪婪，永不投資。
  - `temperature = 0`：取最高分（同分依池順序），完全確定。`> 0` 且為 monte-carlo：以 softmax 抽樣，權重 `exp((score − best) / (|best| × temperature))`；expected 模式忽略此欄。
  - 它是決策假設，不是玩家真實行為；報告的 `policy.type` / `policy.adaptive` 會記錄實際參數。
  - 注意：每步需分叉狀態做前瞻，速度比 priority 慢（godtower 24h 約 1.5 秒 expected、數秒 / 20 runs monte-carlo）。
- **停止原因**：`completed`（抵達最後節點）、`time_limit`、`action_limit`、`stuck`。

## 驗證碼

錯誤：`NOT_OBJECT` `MISSING_FIELD` `UNKNOWN_SCHEMA_VERSION` `INVALID_TYPE` `DUPLICATE_ID` `REF_NOT_FOUND`
`INVALID_NUMBER` `INVALID_PROBABILITY` `INVALID_RANGE` `CYCLIC_DEPENDENCY` `DUPLICATE_ORDER` `INITIAL_EXCEEDS_MAX`

警告：`UNKNOWN_FIELD` `TIME_AS_RESOURCE` `FREE_INFINITE_ACTION` `NO_OUTCOMES` `TABLE_WEIGHTS_NOT_NORMALISED`
`ZERO_PROBABILITY` `NO_PROGRESSION` `RESOURCE_NEVER_PRODUCED` `UNUSED_RESOURCE`

每則訊息包含 JSON 路徑（如 `actions[2].outcomes[0].probability`）、修正提示，若實體帶 `source` 也會附上原始檔位置。

## Scenario 檔

```json
{
  "id": "boss-power-minus-20",
  "description": "Boss 波次需求戰力 -20%",
  "changes": [
    { "path": "progression[id=wave_5].requirements[resource=power].gte", "op": "multiply", "value": 0.8 },
    { "path": "actions[*].durationMinutes", "op": "add", "value": -1 }
  ]
}
```

- 選擇器：`[key=value]`、`[*]`、`[0]`；`op`：`set` / `add` / `multiply`。
- 套用在模型的深拷貝上，**不修改來源資料**；選擇器零匹配 => 錯誤（exit 1），避免「靜默無效」的情境。
- 套用後的模型會重新驗證。
