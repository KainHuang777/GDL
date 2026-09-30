# Game Design Lab (GDL) — v0.1 prototype

本機優先、可由 Adapter 接入不同遊戲、並以**可重現模擬**驗證設計假設的 Game Design SDK。
核心數值結果全部由程式引擎產生；v0.1 不含任何 LLM 功能。

> 原始碼：<https://github.com/KainHuang777/GDL>
> 設計草案的審查結論與調整項目見 [docs/design-review.md](docs/design-review.md)。

## 快速開始

```bash
npm install
npm test                       # 19 個測試：驗證、決定性、重現性、跨專案、scenario

# 驗證（標準 JSON 模型或含 .gdl/config.json 的專案目錄）
npm run gdl -- validate --project examples/minimal-idle-game/model.json
npm run gdl -- validate --project examples/invalid/model.json        # exit 1

# 期望值模式分析：可達性 + 進度時間 + 卡點原因
npm run gdl -- analyze --project examples/dao2-mock --hours 48

# Monte Carlo（seed 可重現）
npm run gdl -- simulate --project examples/godtower-mock --hours 8 --runs 1000 --seed 42

# 情境比較（不修改來源資料）
npm run gdl -- compare --project examples/godtower-mock --hours 8 \
  --scenario examples/godtower-mock/scenarios/boss-power-minus-20.json

# 機器可讀輸出
npm run gdl -- simulate --project examples/dao2-mock --format json --out report.json

# 閱讀分析：瓶頸 / 經濟 / 情境 findings（終端機）與靜態 HTML dashboard
npm run gdl -- inspect report.json --focus bottleneck,economy
npm run gdl -- report report.json --out dashboard.html
# 或一次完成：模擬同時輸出 dashboard；--save 存到 outputDir（預設 .gdl/reports/）
npm run gdl -- compare --project examples/dao2-mock \
  --scenario examples/dao2-mock/scenarios/realm-stone-plus-50.json --html dao2.html --save
```

設計說明見 [docs/dashboard-design.md](docs/dashboard-design.md)。

安裝為指令：`npm link` 後可直接用 `gdl <command> ...`。

## 指令

| 指令 | 作用 | 預設 |
|---|---|---|
| `validate` | Schema 與引用驗證 | — |
| `analyze` | 靜態可達性 + 單次期望值模擬 | `--mode expected` |
| `simulate` | 多次模擬並彙總分布 | `--mode monte-carlo --runs 1000 --seed 1` |
| `compare` | baseline vs 一或多個 scenario | 同 simulate |
| `inspect` | 讀取已存 JSON 報告，輸出分析 findings | `--format text` |
| `report` | 由已存 JSON 報告產生單檔 HTML dashboard | `<report>.html` |

常用選項：`--project <dir|file>`、`--policy <id>`、`--minutes N` / `--hours N`（預設 1440 分鐘）、
`--max-actions N`、`--no-stop-on-complete`、`--keep-runs`、`--trace`、`--format text|json`、`--out <file>`、`--html <file>`、`--save`、`--focus bottleneck,economy,scenario,data`。

### 結束碼

| 碼 | 意義 |
|---|---|
| 0 | 成功 |
| 1 | 資料錯誤（驗證失敗、scenario 選擇器無匹配、adapter 讀檔失敗…） |
| 2 | 使用或執行錯誤（參數錯誤、找不到路徑、未知 policy…） |

## 可追溯性

每份報告都帶 `provenance`：GDL / schema / report 版本、adapter id 與版本、每個來源檔的 SHA-256、
標準化後模型的 SHA-256、全部模擬參數與 seed、執行時間。相同輸入 + 參數 + seed ⇒ 相同結果（測試涵蓋）。

## 專案結構

```text
src/
  schema/    types.ts（標準模型）、validate.ts（驗證器）
  core/      rng、simulate、policy、runner（彙總）、reachability、scenario、stats
  adapter/   api.ts（Adapter API）、loader.ts（載入專案 / 雜湊來源）
  cli/       index.ts（指令）、format.ts（文字報告）
  index.ts   程式化 API：validateProject / analyzeProject / simulateProject / compareProject
examples/
  minimal-idle-game/   純標準 JSON 模型
  dao2-mock/           Dao2 風格 JSON + TS adapter（mock 資料）
  godtower-mock/       GodTower 風格 CSV + TS adapter（mock 資料）
  invalid/             刻意錯誤的模型
docs/                  design-review、schema、adapter-authoring
tests/
```

## 目前限制

- Dao2 / GodTower 實際 repo **未在工作區中**，兩個 adapter 均以自擬 mock 資料驗證架構（待確認）。
- 單一線性進度軌；策略僅支援 `priority`；無離線收益、無戰鬥逐幀模擬。
- Adapter 可在模型的 `unsupported[]` 聲明未建模玩法，所有報告都會列出。

文件：[Schema](docs/schema.md) · [Adapter 撰寫指南](docs/adapter-authoring.md) · [設計審查](docs/design-review.md)
