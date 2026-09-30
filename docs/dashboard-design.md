# Dashboard 與閱讀分析工具 — 設計 v0.1（初版）

> 狀態：初版原型已實作（`src/insights/`、`src/report/html.ts`、`gdl inspect` / `gdl report`）。
> 本文件描述目標、資料流、規則與畫面；門檻值均為**可調整的初始值**，待實際專案回饋後校正。

## 1. 目標與非目標

模擬報告（JSON）資訊完整但難以閱讀。本階段要讓企劃在 **1 分鐘內**回答三類問題：

| 類別 | 要回答的問題 |
|---|---|
| **瓶頸 / 卡關定位** (`bottleneck`) | 玩家在哪裡停下來？被哪個資源 / 條件卡住？差多少、照目前產速還要多久？哪一段最花時間、最不穩定？ |
| **資源經濟流向** (`economy`) | 每個資源從哪裡來、往哪裡去？哪些資源溢出浪費、持續淨流失、只進不出、過度依賴單一來源？哪些內容（action）完全沒被使用？ |
| **情境比較** (`scenario`) | 這個改動影響最大的是哪些節點 / 資源？完成率有沒有變？改動是否根本沒有效果？ |

非目標（v0.1 不做）：

- 不做跨報告歷史趨勢 / 多份報告 diff（保留於 §8 後續）。
- 不需伺服器、不引入前端框架或圖表套件；不連網。
- 不做任何 LLM 摘要。所有「發現」皆為**確定性規則**，同一份報告永遠得到同一組結果。
- 不修改既有報告 schema（`reportVersion 0.1` 不變）；分析層只讀取報告。

## 2. 架構與資料流

```text
 simulate / analyze / compare ──► Report (JSON, 既有)
                                     │
                                     ▼
                         buildInsights(report)      src/insights/insights.ts   純函式、無 I/O
                                     │  Insights { findings[], pacing, economy, scenarios }
                ┌────────────────────┼─────────────────────┐
                ▼                    ▼                     ▼
      formatText() 附加 Findings   formatInsights()       renderHtml(report, insights)
      （既有文字報告）              gdl inspect（終端閱讀）  gdl report / --html（靜態 dashboard）
```

設計原則：

1. **單一分析來源**：CLI 文字、`inspect`、HTML 共用同一個 `buildInsights()`，不會出現「網頁跟終端說法不同」。
2. **報告即輸入**：`inspect` / `report` 讀取既有 JSON 報告，因此可以事後重看、附在 issue、在 CI 產出。
3. **自包含 HTML**：單一檔案，CSS inline、圖表為伺服端產生的 inline SVG（**不需 JavaScript**），
   原始報告以 `<script type="application/json" id="gdl-report">` 內嵌，方便日後工具再解析。
4. **可追溯**：dashboard 頁首固定顯示 provenance（版本、adapter、model SHA-256、seed、runs、limits、產生時間），
   頁尾固定顯示 adapter 宣告的「未建模玩法」，避免把模擬結果誤讀為完整遊戲行為。

## 3. 指令介面

| 指令 / 選項 | 作用 |
|---|---|
| `gdl inspect <report.json> [--focus bottleneck,economy,scenario] [--format text\|json]` | 終端閱讀分析：依嚴重度列出發現，附節奏、經濟、情境摘要表 |
| `gdl report <report.json> [--out dashboard.html]` | 由既有報告產生靜態 HTML（預設輸出到同名 `.html`） |
| `simulate/analyze/compare ... --html <file>` | 執行後直接輸出 dashboard |
| `simulate/analyze/compare/validate ... --save` | 將 JSON + HTML 存到專案 `outputDir`（`.gdl/config.json`，預設 `<project>/.gdl/reports/`），檔名 `<generatedAt>-<kind>.{json,html}`；存檔路徑印在 stderr，不污染 stdout |
| `--html <file>` / `--save` / `gdl report` ... `--lang en\|zh-TW` | dashboard 語言（預設 `en`；`zh-TW` 輸出繁體中文介面並設 `<html lang="zh-Hant">`）。介面字串與 insights 標題/說明會本地化；若模型有提供資源/節點/動作的 `name`，顯示時優先使用（DAO 資料即為中文名）。ID、驗證訊息、情境描述等資料內容維持原文 |

既有文字報告（`--format text`）末尾新增 **Findings** 區塊（只列 critical / warning，完整清單用 `inspect`）。

`inspect` / `report` 會檢查輸入的 `kind` 與 `provenance.reportVersion`；不是 GDL 報告時回傳 exit 2。

## 4. Insights 資料模型

```ts
type Severity = "critical" | "warning" | "info";
type Category = "bottleneck" | "economy" | "scenario" | "data";

interface Finding {
  id: string;            // 規則 id，例如 "stall"、"overflow"
  severity: Severity;
  category: Category;
  scope: string;         // "simulation" | "baseline" | "scenario:<id>"
  subject?: string;      // "node:<id>" | "resource:<id>" | "action:<id>" | "scenario:<id>"
  title: string;         // 一句話結論
  detail: string;        // 證據與數字
}

interface Insights {
  kind: Report["kind"];
  findings: Finding[];            // 依 severity → category 排序
  pacing?: PacingView;            // 主要模擬（simulate/analyze 的 simulation、compare 的 baseline）
  economy?: EconomyRow[];
  scenarios?: ScenarioView[];     // 僅 compare
}
```

`PacingView`：每個節點的到達率 / p10 / median / p90、每段（前一節點 → 此節點）的中位時間與占比、最慢段。
`EconomyRow`：每個資源的產出 / 消耗 / 期末 / 淨速率 / 溢出，與來源、去向的占比（share）。
`ScenarioView`：每個情境的完成率差、節點時間與到達率影響（依 |變化%| 排序）、期末資源影響。

## 5. 分析規則（v0.1）

門檻集中在 `THRESHOLDS`（`src/insights/insights.ts`），以下為初始值。

### 5.1 瓶頸 / 卡關（bottleneck）

| id | 條件 | 嚴重度 | 說明 |
|---|---|---|---|
| `invalid` | `validation.ok = false` | critical | 模型無效，沒有模擬結果 |
| `unreachable` | 靜態可達性判定節點 unreachable（analyze） | critical | 設計上不可能到達 |
| `stuck` | `stuck.count > 0` | critical | 沒有可執行 action 且不會再生，附第一個卡住 run 的阻擋原因 |
| `stall` | 未完成的 run 中某節點占比 ≥ 5% | warning | 「進度停在 X」。解析阻擋原因（`costs R A (have H)` / `requires R >= A (have H)`）得出**限制資源與缺口**，並以該資源 `netPerHour` 估算**還需多少時間**；淨速率 ≤ 0 時標示「不會自然補足」 |
| `partial-reach` | 首個 0 < reachRate < 1 的節點 | warning | 只有部分玩家到達 → 隨機性造成分歧 |
| `slow-segment` | 最慢段占「到最後到達節點」中位時間 ≥ 35%，且至少 3 個節點 | warning | 單段過長，節奏失衡 |
| `pacing-spike` | 某段中位時間 ≥ 前一段 × 2 | info | 難度 / 需求跳升點 |
| `variance` | Monte Carlo，節點 p90 / p10 ≥ 1.5 | info | 到達時間不穩定（運氣影響大） |
| `wait-cause` | 節點所在區段 ≥ 20% 推進時間，且其等待有 ≥ 50% 歸因於同一資源（引擎於每次等待時記錄「關鍵路徑資源」） | warning（最慢段）/ info | 回答「為什麼慢」：例如 `era_4` 等待 100% 耗在 lingli。若限制者是 `counter` 類（如 training）則改為 `wait-time-gated`（info：設計上的時間閘，收入無法加速） |
| `waiting` | 等待時間中位數 ≥ 總時長 30% | info | 放置類遊戲天生大量等待，僅作背景資訊；原因見 `wait-cause` |

### 5.2 資源經濟（economy）

| id | 條件 | 嚴重度 |
|---|---|---|
| `overflow` | 溢出量 > 0；占產出 ≥ 10% 為 warning，否則 info。`counter` 略過；`crafted` 且已被 `strategy-waste` 涵蓋則略過；資源列於 `unsupported[].affects` 時降為 info 並附 `caveats` | warning / info |
| `deficit` | `netPerHour < 0` 且有消耗 | info（期末中位數為 0 時 warning：資源被耗盡） |
| `hoarding` | 有消耗管道，但期末中位數 ≥ 產出 50% | info：資源囤積、sink 不足 |
| `no-sink` | 有產出但完全沒有消耗（合併為一條） | info：只進不出，可能是計數器，也可能缺 sink |
| `source-concentration` | 會被消耗的資源，最大來源占 ≥ 80% | info：單一來源依賴 |
| `unused-action` | 在此策略下平均使用 0 次（合併為一條） | info：死內容或策略未涵蓋 |

**資源 `kind`**（`currency` 預設 / `counter` / `crafted`）讓規則分辨資源性質：`counter`（訓練時數、技能等級）不參與 overflow / hoarding / no-sink；`crafted`（製作品）不做來源集中判斷，surplus 交給 `strategy-waste`。`unsupported[].affects` 標示哪些資源因未建模功能而數值不可靠，相關發現會附 `caveats`（「※ 數值可能不可靠，未建模：…」）。

### 5.2b 策略效率（policy）

| id | 條件 | 嚴重度 |
|---|---|---|
| `strategy-waste` | 策略製作了 `crafted` 資源但未使用（產量 − max(實際消耗, 節點/動作所需持有量) ≥ 5%）；未使用占比 ≥ 20% 或浪費的投入 ≥ 該資源總消耗 5% 為 warning | warning / info |

區分「遊戲瓶頸」與「策略缺陷」：例如 smart 策略製作 171 顆築基丹卻只需 11 顆，浪費的靈力屬於策略問題，不應歸咎於遊戲設計。

### 5.3 情境比較（scenario）

| id | 條件 | 嚴重度 |
|---|---|---|
| `scenario-invalid` | 套用後模型無效 | critical |
| `scenario-completion` | 完成率改變 | warning（下降）/ info（上升） |
| `scenario-reach` | 任一節點到達率改變（合併） | warning（下降）/ info（上升） |
| `scenario-impact` | 影響最大的前 3 個節點時間變化 + 前 3 個期末資源變化。**兩次執行結束時間不同時（例如情境更早完成），期末資源不可比較，僅列節點時間** | info |
| `scenario-limiter-shift` | 某節點的主要等待限制資源在情境下改變（如 lingli → skill_point） | info：瓶頸轉移 |
| `scenario-no-effect` | 所有差值皆為 0 | warning：改動可能打在未被使用的內容上 |

## 6. Dashboard 版面（單頁，錨點導覽）

```text
┌ 頁首：專案 / 報告種類 / 驗證狀態徽章 / provenance（版本、adapter、SHA、seed、runs、limits、時間）
├ ① Findings      依嚴重度排序的卡片（紅 critical / 橘 warning / 灰 info），標示 category
├ ② 節奏 Pacing   [SVG] 每節點 p10–p90 區間條 + median 點 + 到達率；[SVG] 各段中位時間長條（最慢段高亮）
│                 [SVG] 結束原因 100% 堆疊條；停滯點與阻擋原因表
├ ③ 經濟 Economy  資源總表（產出/消耗/期末/淨速率/溢出）；每資源來源與去向 100% 堆疊條 + 圖例
│                 Action 使用次數長條
├ ④ 情境 Scenario（compare）每情境：套用變更清單、完成率、[SVG] 節點中位時間 baseline vs scenario 啞鈴圖、
│                 節點 / 資源差異表（時間變短 = 綠、變長 = 紅）
├ ⑤ 驗證 Validation  errors / warnings（含 source 與 hint）
└ 頁尾：未建模玩法（adapter 宣告）+ 產生工具版本
```

視覺規則：時間一律用 `fmtMin` 格式（`1h38m`、`2d3h`）；百分比一位小數；色彩只用於語意（嚴重度、增減），
圖表另附文字數值，列印或無色情況下仍可讀。

## 7. 驗收條件

1. 三個範例專案的 simulate / analyze / compare 報告皆可產生 dashboard 與 inspect 輸出，無例外。
2. dao2-mock（24h）必須產出 `stall` 發現，指出 `realm_foundation`、限制資源 `spirit_stone` 並給出預估時間。
3. dao2-mock 情境 `realm-stone-plus-50` 的 `scenario-impact` 第一名為 `realm_qi_refining`。
4. HTML 不含外部資源（無 `src=` / `href=http`），報告字串經過 escape，內嵌 JSON 可被解析回原報告。
5. 相同報告 → 相同 insights（純函式，測試涵蓋）。
6. `inspect` / `report` 對非報告檔回傳 exit 2。

## 8. 後續（v0.2+ 候選）

- 多份報告比較 / 趨勢（以 `modelSha256` + 參數分組），`gdl report a.json b.json`。
- `--keep-runs` 時的分布直方圖、trace 時間軸。
- 規則門檻可由 `.gdl/config.json` 覆寫；專案自訂規則（adapter 提供）。
- 報告索引頁（`outputDir/index.html`）。
