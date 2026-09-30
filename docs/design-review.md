# GDL 設計草案 v0.1 — 審閱與調整紀錄

> 對象：`GDL_設計草案_v0.1.md`
> 標記：**[已確認]** 已由程式碼／環境確認；**[建議]** 本次採用的設計決策；**[待確認]** 需要人工確認。

## 1. 整體判斷

草案方向正確：核心／Adapter 分層、確定性引擎優先、LLM 延後且不參與運算、先做窄切片。
主要問題在於**幾個關鍵語意沒有定義**，若不先定案，實作時會各自猜測、兩個 Adapter 產生不一致的模型。下列為需要調整之處。

## 2. 環境盤點

| 項目 | 狀態 |
|---|---|
| 工作區 `D:\work\fortest\GDL` 為空 git repo | [已確認] |
| Node.js v20.20.0、npm 11.13.0 可用；pnpm 未安裝 | [已確認] |
| Python 3.9.13（較舊，3.9 已 EOL） | [已確認] |
| Dao2、GodTower 原始 repo 不在工作區，也未在 `D:\work` 下找到 | [待確認] 路徑、資料格式、欄位 |
| 因此兩個驗證 Adapter 暫以**模擬資料（mock）**實作於 `examples/`，明確標示不是真實資料 | [建議] |

## 3. 需要調整的語意（依重要度）

### 3.1 時間的表示方式 → 動作屬性，不是資源  [建議]
草案 §4 已指出 `time_minutes` 重複計算的風險。定案：
- `Action.durationMinutes`（必填，≥0）是唯一的時間來源。
- 模擬時鐘由引擎維護；資源不能叫做時間。
- 體力這類「隨時間回復」的資源用 `Resource.regenPerMinute` + `max` 表達。
  草案缺少 **回復與上限**，但放置類遊戲幾乎必備，因此加入 v0.1。

### 3.2 進度門檻：「檢查」與「消耗」要分開  [建議]
草案 `requirements: [{resource: exp, amount: 100}]` 無法分辨「經驗 ≥100」還是「消耗 100 經驗」。定案：
- `ProgressionNode.requirements`：條件（不消耗），`{type:"resource", resource, gte}` 或 `{type:"node", node}`。
- `ProgressionNode.costs`：突破時消耗的資源。
- v0.1 進度為**單一線性軌道**（依 `order`），條件滿足且負擔得起即自動推進。多軌／分支進度列為不支援。

### 3.3 機率語意需明確  [建議]
「probability」可能是獨立判定，也可能是互斥掉落表。定案兩種型別：
- `{type:"resource", ..., probability}`：**獨立**判定。
- `{type:"table", entries:[{weight, outcomes}]}`：**互斥**、依權重抽一個。
- 數量可為固定值或 `{min,max}`（兩端為整數時抽整數，否則抽連續值）。

### 3.4 Deterministic mode 定義  [建議]
草案「只使用確定結果」會讓所有隨機掉落變成 0，系統性低估。改為 **期望值模式**：機率結果以 `amount × p` 計入、範圍以平均值計入（允許小數）。Monte Carlo 模式才實際抽樣。

### 3.5 `Rule` 實體過於模糊 → v0.1 移除  [建議]
「連接動作、成本、結果及進度條件」已由 Action 的 `costs / outcomes / requires` 覆蓋。v0.1 不設獨立 Rule，避免兩套表達同一件事。需要特殊規則時，由 Adapter 宣告 `unsupported` 或未來加入規則模組。

### 3.6 `PlayerState` 不屬於 Schema  [建議]
它是模擬執行期狀態，不是遊戲資料。Schema 只保留 `resources[].initial`；執行期狀態由引擎內部維護並出現在報告中。

### 3.7 玩家策略需要形式化  [建議]
`--policy baseline` 需要明確定義。v0.1 提供：
- `priority`：依列表順序，選第一個「已解鎖、次數未用完、付得起」的動作。
- 若沒有可執行動作但資源會自然回復，則**等待**到最早可執行時間；若永遠不可能，回報「卡住」及缺少的資源。
- 策略可定義在模型 `policies[]` 或 scenario 中；未指定時，以所有動作宣告順序作為預設 priority 策略。

### 3.8 `--days 30` 容易誤導  [建議]
「30 天」隱含每日登入次數、離線收益等未建模行為（草案 §6 自己也說這不是資料欄位）。v0.1 只提供 `--minutes / --hours / --max-actions`（連續遊玩時間），離線與 session 模型列為後續。

### 3.9 Adapter 載入 TypeScript  [建議]
Node 20 不能直接 import `.ts`。使用 `tsx` 的 API 動態載入，讓 `.gdl/adapter.ts` / `.mjs` / `.js` 都可用。另提供內建 `builtin:json-model`（直接讀標準模型 JSON），對應草案的「Data import」路徑的最小形式；CSV mapping 延到 Phase 3。

### 3.10 可追溯性：原始檔雜湊  [建議]
模型雜湊只能證明「轉換後模型」一致。Adapter 透過 GDL 提供的 `ctx.readJson / readText` 讀檔，GDL 自動記錄每個來源檔的 SHA-256，寫進報告。驗證訊息可經實體的 `source` 欄位回指原始檔（草案 §4 的「指出檔案」需求）。

### 3.11 Scenario 格式需先定義  [建議]
以選擇器路徑 + 運算描述變更，不寫回原始資料：
```json
{ "target": "progression[id=realm_2].requirements[resource=exp].gte", "op": "multiply", "value": 1.1 }
```
支援 `[id=x]`、`[key=value]`、`[*]`、`[0]`，運算 `set / add / multiply`。沒有命中任何欄位即報錯（避免 typo 默默無效）。套用後重新驗證。

### 3.12 錯誤碼  [建議]
`0` 成功；`1` 資料驗證失敗；`2` 使用方式或執行錯誤。

### 3.13 範圍調整：Monte Carlo 提前  [建議]
草案 Phase 1 只做 deterministic，但 CLI 範例已用 `--runs --seed`。seedable RNG 與彙總統計成本很低，併入前期版本；scenario compare 也一併完成最小版。

### 3.14 專案結構  [建議]
尚未看到 Dao2/GodTower 技術棧前，不採 monorepo。先用單一 npm 套件，內部以 `src/schema`、`src/core`、`src/cli` 分層，之後可無痛拆包。

### 3.15 技術選型：TypeScript  [建議；接入成本部分待確認]
- 環境已有 Node 20；Python 為 3.9 舊版。
- TS 型別可直接作為 Adapter API 契約；Adapter 以 `.ts` 放在遊戲 repo 最自然。
- 目前模擬規模（數千 runs × 數千 steps）不需要 numpy。
- 若 Dao2/GodTower 其實是 Unity/C# 或 Python 專案，Adapter 仍可先匯出 JSON 再用 `builtin:json-model` 接入。

## 4. 目前明確不支援（會在報告中誠實回報）
- 多軌／分支進度、離線收益、每日 session 模型
- 逐幀戰鬥、盤面策略、AI 玩家人格
- CSV/Excel 欄位對照匯入、MCP、LLM
- Adapter 可在模型 `unsupported[]` 宣告自己省略的玩法，報告會原樣列出。

## 5. 前期版本驗收條件
1. `gdl validate` 能對標準模型給出帶路徑、代碼與修正提示的錯誤/警告。
2. 兩個差異明顯的 mock 專案（放置 RPG、塔防）經各自 Adapter 通過同一套驗證。
3. 同一 CLI 對兩者執行 `analyze`（可達性 + 資源流 + 進度耗時）產生有效結果。
4. 相同輸入、參數、seed → 相同結果（有自動測試）。
5. `compare` 能以 scenario 產生差異報告，且不修改來源檔。
6. Core 內沒有任何專案特定程式碼。
