# QDII 持仓实时估值器 · 设计文档

- 日期：2026-11-10
- 状态：待用户评审
- 作者：大鱼鱼（与 ouguangji 共同敲定）

## 1. 背景与目标

### 1.1 问题

国内公募的海外 QDII 基金（纳指 100、标普 500、纳指科技等）没有盘中估值。国内股票基金有官方 15:00 估值，海外 QDII 没有——净值要等美股收盘、汇率确定，且延迟一天公布。用户持有约 13 只以纳指 100 为主的 QDII，合计二十余万，看不到当日浮动。

### 1.2 目标

自用的本地工具，录入基金持有后，**基于基金的真实持股（或跟踪指数的全量成分权重）实时估算当日收益**，并把估算误差量化、持续校准。

### 1.3 成功标准

1. 指数型 QDII 的日估 MAE < 0.15pp（walk-forward 回测，非事后拟合）。
2. 每次估算都能展开看到「哪只股票贡献了多少」，不是黑箱数字。
3. 净值公布后自动与估算比对，页面上能看到模型今日偏差。

### 1.4 非目标

- 不做 A 股基金、黄金 ETF 的估值（东财已有官方估值，自建无意义）。
- 不做交易、不做申购赎回、不接券商。
- 不做多用户、不做公网部署、不做金融信息资质相关的产品化。
- 不追求主动型 QDII 的全量持仓（法定只披露前十大，拿不到）。

## 2. 关键事实（已实测，非推断）

| 事实 | 证据 |
|---|---|
| 基金持仓接口给前十大 + 权重 | `FundMNInverstPosition`，易方达全球成长精选返 10 只 |
| 联接基金不持股，只返 `ETFCODE` | 270042 → `ETFCODE: 159941`，`fundStocks: []` |
| 目标 ETF 才有真实持仓 | 159941 → NVDA 7.6%、AAPL 6.71%、MSFT 5.26%… |
| 中国公募季报只披露前十大 | 法规层面，全量持仓不可得 |
| 指数全量成分可得 | `api.nasdaq.com/api/quote/list-type/nasdaq100` → 101 只带 marketCap |
| 美股行情无 15 分钟延时 | 同秒横向比对，东财/新浪/腾讯时间戳均在 3 秒内 |
| 美股存在「无 key 免费实时」多源 | 东财、腾讯、新浪、CNBC、纳斯达克官方均无需注册即可取实时报价 |
| 美股不存在「无鉴权公共推流」 | 行情是交易所授权商品，Binance 式 `wss://` 公共流无对应物 |

### 2.1 数据源实测（连续 8 次，每次 100 只，2026-11-10 01:13–01:35）

| 源 | 中位耗时 | 成功率 | 鉴权 | 时间戳 | 精度 | 定位 |
|---|---|---|---|---|---|---|
| 东财 `push2/ulist.np` | **48ms** | 8/8 | 无 | UTC 秒 `f86` | 2 位 | **主源** |
| 腾讯 `qt.gtimg.cn` | 161ms | 8/8 | 无 | 美东时间直给 | 3 位 | **校验源** |
| CNBC `restQuote` | 652ms | 8/8 | 无 | ISO 带偏移 | 2 位 | **权威源 / 市场状态** |
| 新浪 `hq.sinajs.cn` | ~200ms | — | 无 | 北京秒级 | 4 位 | 兜底 |
| 纳斯达克官方 API | — | — | 无（需 UA） | — | — | 权重来源 |
| Alpaca Data API | — | 401（链路通） | 免费 key | — | — | 可选推流增强 |
| Finnhub / Polygon / TwelveData | — | 401 / 401 / demo 可用 | key | — | — | 免费层限频过严，不采用 |

### 2.2 选型结论

- **速度与批量**：东财无可替代，48ms 拉 100 只，一次请求即可覆盖 NDX 全部成分。
- **权威性与相位**：CNBC 是免费的意外之喜——`realTime: true`、`curmktstatus`（`REG_MKT`/`PRE_MKT`/`POST_MKT`/`CLOSED`）、`exthrs=1` 给盘前盘后价。相位判定改读这个字段，不再自行推算美东时区与冬夏令时。
- **推流**：唯一免费路线是 Alpaca（IEX 实时 WebSocket，需注册免费 key）。权衡：IEX 仅占美股成交量 2–3%，价格可能偏离 consolidated tape 一两个分，属于**新增误差源**换实时感。默认关闭，作为可选开关。
- **不采用的路线**：Kraken 等代币化美股（`AAPLXUSD` 报 `Unknown asset pair`，且链上价与 NMS 报价存在结构性偏离，不适合净值估算）；`slickcharts.com`（403）。

已知坑（实现阶段实测补充）：

- **位置式解析里 `Number('') === 0`，不是 NaN**。字段缺失时空串会被静默读成 0；对 `prevClose = price - change` 是致命的（会算成现价，涨跌幅归零）。所有位置式解析必须先判空串再转数字。Task 7 在新浪源实测到此问题并修复。
- **东财的市场码给错会让整批请求返回 `data: null`**（`105.IBM` → `{"rc":102,"data":null}`），不是只丢那一只；`normalizeEastmoney` 对 `null` 安全返回 `[]` 且不抛错，于是 100 只票静默变 0 只。必须靠"返回条数 < 请求条数即失败"的断言兜住，并用持久化的 symbol→market 映射避免猜测（`105.V` 会被自动纠正成 106，所以随机抽样测不出来）。
- **CNBC 用逗号分隔不是"只回第一条"，而是回一条垃圾数据**：`symbol` 字段变成 `"AAPL,MSFT,NVDA"` 整串、无 `last` 价格，解析后得 0 条。必须断言返回条数。
- 新浪原始报文**第 25 位是昨收**（实测 `342.3700`）。实现仍用 `price - change` 反推，因为它更抗字段位置漂移，两者实测一致。
- `api.nasdaq.com` 不带浏览器 UA 直接 400。
- `api.nasdaq.com/api/quote/list-type/sp500` 报 `code 1011 Bad or No parameter`，标普 500 全量需换源（候选：iShares IVV 持仓 CSV、screener 接口）。
- 东财 f 系列价格字段放大 1000 倍，涨跌幅放大 100 倍。
- 腾讯美股报文共 73 个 `~` 分隔字段，时间在 `[30]` 且是**美东时间**（无时区标记），冬夏令时需外部兜底。

## 3. 架构

单进程全栈：`pnpm dev` 一条命令起服务，抓取、估算、界面同进程。

```
┌─────────────────────────────────────────────┐
│  Web UI (React + Vite, 暗色玻璃拟态, 5s 轮询)  │
│  账户汇总 / 基金列表 / 持仓明细 / 误差面板      │
└───────────────┬─────────────────────────────┘
                │ HTTP JSON（前端 5 秒轮询）
┌───────────────▼─────────────────────────────┐
│  Fastify (Node 24 + TypeScript)              │
│  ├─ routes/    funds, estimate               │
│  ├─ engine/    估值核心（纯函数，可单测）      │
│  ├─ sources/   数据源适配层（主备 + 校验）     │
│  ├─ sync/      定时任务：抓持仓 / 抓行情 / 标定 │
│  └─ store/     better-sqlite3 访问层          │
└───────────────┬─────────────────────────────┘
                │
         SQLite (data/app.db)
```

### 3.1 数据源适配层（五层梯队）

统一接口，每个源声明自己的能力，由注册表按职责调度：

```ts
interface QuoteSource {
  id: string
  assetClass: 'us_equity'
  maxBatch: number                    // 单次批量上限（东财 100 / CNBC 100+）
  sep: string                         // 批量分隔符（CNBC 只认 '|'）
  capabilities: ('quote' | 'marketStatus' | 'prepost' | 'stream')[]
  fetchQuotes(symbols): Promise<Quote[]>
  normalize(raw): Quote               // → {symbol, price, prevClose, pct, tsMs, precision, sourceId}
}
```

梯队分工：

| 层 | 源 | 职责 | 频率 |
|---|---|---|---|
| L1 | 东财 | 常规报价，全量成分一次性拉齐 | 盘中 5s / 收盘 10min |
| L2 | 腾讯 | 交叉校验，字段最全（开高低、成交额） | 盘中每 60s 抽查 |
| L3 | CNBC | 市场状态（相位）、盘前盘后价、权威复核 | 相位 5min / 全量复核 15min |
| L4 | Alpaca（可选） | WebSocket 推流，需自备免费 key | 默认关闭 |
| L5 | 新浪 | 兜底，前三层全挂时启用 | 按需 |

调度规则：
1. L1 连续 3 次失败或 p95 > 2s → 降级 L2，10 分钟后试探恢复。
2. L1 与 L2 同刻比价，同一 symbol 偏差 > 0.5% → 触发 L3 裁决；L3 与 L1 一致则弃 L2，三方互斥则冻结该 symbol 并标 `source_conflict`，不写缓存。
3. 写 `quote_cache` 必带 `source_id` 与 `ts_ms`；过期阈值盘中 30s、收盘 10min、`stale` 超 3 个周期未更新即前端显示快照时间。
4. CNBC 批量的分隔符必须是 `|`，用 `,` 会静默只返回第一条——适配层需要断言「返回条数 == 请求条数」，否则视为失败。

### 3.2 数据获取链路

```
基金代码
  └─ FundBaseTypeInformation  → 名称、类型、官方净值
  └─ FundMNInverstPosition
       ├─ fundStocks 非空        → 直接是股票持仓（主动 QDII / ETF）
       └─ ETFCODE 非空           → 递归查目标 ETF 的持仓
            └─ 权重 < 100% 且是纯指数基金 → 用指数全量成分替换
```

权重还原优先级：
1. 指数全量成分（指数基金）——最准。
2. 目标 ETF 的真实持仓（ETF 有完整持仓披露）。
3. 前十大 + 残差按标的指数涨跌代理（主动型 QDII 唯一选择）。

### 3.3 数据模型

```sql
fund(id, code UNIQUE, name, kind, target_etf_code, index_key,
     asset_class, shares, cost_basis, exposure, lag_days,
     calibrated_at, created_at)
    -- kind: etf_link | etf | index | active
    -- exposure/lag_days: 由校准闭环拟合，初值 0.95 / 1

constituent(id, owner_type, owner_key, symbol, name, weight, as_of, source)
    -- owner_type: index | fund
    -- 权重快照，按 as_of 版本化，不覆盖历史

quote_cache(symbol, asset_class, price, prev_close, pct, ts_ms, source_id,
            fetched_at, PRIMARY KEY(symbol, source_id))

fx_cache(pair, rate, ts_ms, source_id)      -- USDCNY 等

nav_history(fund_code, nav_date, nav, pct, PRIMARY KEY(fund_code, nav_date))

estimate_log(id, fund_code, model_ts, phase, model_pct, model_amount,
             covered_weight, constituents_json, lag_days, exposure)

residual(fund_code, nav_date, model_pct, actual_pct, diff, nav_ts)
    -- 校准原料，只增不改
```

### 3.4 估值核心（纯函数）

```ts
function estimateNav(input: {
  holdings: { symbol, weight, pct }[]   // pct 为该股当期涨跌幅
  fxNow: number, fxPrev: number
  coveredWeight: number                  // Σ weight
  exposure: number
  residualProxyPct?: number              // 未覆盖部分的代理涨跌
}): { stockPct, fxPct, navPct, breakdown }
```

计算：

```
W_cov  = Σ wᵢ
r_cov  = Σ(wᵢ · pctᵢ) / W_cov
W_unc  = max(0, 1 − W_cov)
r_unc  = residualProxyPct ?? 0
r_stock = W_cov · r_cov + W_unc · r_unc
r_fx    = fxNow / fxPrev − 1
r_asset = (1 + r_stock)(1 + r_fx) − 1
r_nav   = exposure · r_asset              // 剩余为现金，收益按 0 计
```

`breakdown` 返回每只股票的 `wᵢ·pctᵢ` 贡献值，供 UI 展开——这是目标 1.3.2 的实现。

### 3.5 双相位状态机

净值的时间语义在 QDII 上是错位的，必须显式建模，不能混用：

| 相位 | 判定 | 含义 | 刷新 |
|---|---|---|---|
| `live` | CNBC `curmktstatus = REG_MKT` \| `PRE_MKT` | 正在形成的那一场，`r_nav` 是浮动值 | 5 秒（L1 轮询） |
| `settled` | `curmktstatus = POST_MKT` \| `CLOSED` | 昨夜已定，对应今夜将公布的净值 | 冻结，10 分钟校验一次 |
| `stale` | 行情超过阈值未更新 | 显示快照时间，不冒充实时 | — |

相位判定**优先读 CNBC 的 `curmktstatus` 字段**（免费、权威、自带盘前盘后语义），而不是自行推算美东时区——冬夏令时切换每年两次，硬编码必错。CNBC 不可用时降级为本地按 `America/New_York` 实算，这是兜底而非主路。

盘前（`PRE_MKT`）的处理：美股盘前流动性薄，价格跳动大且不代表开盘价，因此盘前只展示「参考」，不更新 `settled` 已定的数值，避免 nightly 估值被盘前的噪音带偏。

### 3.6 校准闭环

每个交易日净值公布后（定时任务每 30 分钟检查一次新 `nav_history`）：

1. 取出该 `nav_date` 对应的最近一条 `estimate_log`。
2. 算残差，写 `residual`。
3. 滚动 60 个交易日，网格搜索 `lag_days ∈ {0,1,2}` 使相关系数最大；固定 lag 后用最小二乘拟合 `exposure`。
4. 更新 `fund`，记录 `calibrated_at`。
5. UI 展示「模型近 20 日 MAE 0.08pp / 今日偏差 +0.03pp」。

初值不猜：任何新基金录入后先跑一次历史标定，再允许显示估值，标定失败则明确标注「未校准，粗估」。

### 3.7 录入方式

C 端最小录入：**基金代码 + 持有市值 + 持有收益** → 反推 `shares = 市值 / 最新净值`、`cost_basis = 市值 − 持有收益`。也支持直接填份额与成本。不做长表单。

### 3.8 API

```
GET  /api/funds                 列表 + 当前估值（聚合）
POST /api/funds                 新增（code, marketValue, profit）
PATCH /api/funds/:id            改份额/成本
DELETE /api/funds/:id
GET  /api/funds/:id/breakdown   持仓明细与贡献
POST /api/sync/holdings         强制刷新持仓快照
GET  /api/calibration/:code     校准面板数据
```

### 3.9 界面

三块，自上而下：
1. **账户汇总**：总资产、当期估算收益（金额 + 百分比）、相位标签（`盘中` / `待公布` / `快照 12:03`）。
2. **基金列表**：每行左侧名称 + 市值，右侧估算金额与百分比、关联指数、持有收益；未校准的基金打灰标。
3. **展开详情**：持仓权重表 + 每只股票贡献 + 汇率贡献 + 模型误差。

视觉：暗色玻璃拟态，移动优先（手机局域网访问），红涨绿跌沿用国内习惯。

## 4. 测试策略

- **单元测试**：权重归一、汇率合成、相位判定（跨冬夏令时边界）、`normalize` 各源字段解析（含放大倍数）、主备冲突判定。
- **回测**：`scripts/backtest.ts`，对每只已录入基金跑 walk-forward，输出 MAE / 最大偏差 / 偏差与波动率的相关性。
- **集成测试**：真实接口烟囱测试，标记 `@network`，CI 里跳过。
- **验收**：指数型 QDII 的 20 日 MAE < 0.15pp；主动 QDII 单列报告，不与指数型平均。

## 5. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 东财接口无 SLA、随时变 | 估值断供 | 主备三源 + 缓存 + `stale` 状态明示 |
| 联接基金双重稀释（ETF 仓位 + 费用） | 系统性低估 | `exposure` 由最小二乘拟合，非拍脑袋 |
| 主动 QDII 只有前十大 | 误差大 | UI 明确标注覆盖率，误差单独统计 |
| 净值口径 lag 判断错 | 全盘错一天 | 自动标定 + 残差监控，lag 漂移时告警 |
| 标普 500 全量源未定 | 该类基金退化为前十大 | 实现前先探测，失败则如实降级并在 UI 注明 |

## 6. 里程碑

1. **M1 数据通**：源适配层 + 持仓解析 + 行情批量，跑通 3 只基金拿真实数字。
2. **M2 算得对**：估值核心 + 历史标定 + 回测脚本，产出 MAE 报告。
3. **M3 看得见**：Web UI 三块 + 5 秒轮询刷新（单用户自用场景 SSE 属过度设计）。
4. **M4 闭环**：残留校准 + 误差面板 + 降级路径。

每个里程碑都要有可复核的证据（脚本输出、MAE 数字），不接受「应该没问题」。

## 7. 实现前必须验证的三件事

这三项是 M1 的入口条件，不是遗留问题；验证结果直接决定是否降级，不允许跳过。

1. **标普 500 / 纳指科技（NDXT）全量成分源**：`api.nasdaq.com` 的 `list-type` 端点对 sp500 报参数错误。备选顺序：iShares IVV 持仓 CSV → nasdaq screener 接口 → 该指数仅用前十大并把 `coveredWeight` 如实标在 UI 上。**默认决策**：探测 3 次失败即降级，不为此无限试错。
2. **历史日线接口**：标定需要成分股过去 60 个交易日的日涨跌序列，候选 `push2his.eastmoney.com/api/qt/stock/kline/get`。**默认决策**：东财不可用则用腾讯 `web.ifzq.gtimg.cn/appstock/app/usfqkline/get`；两者都不可用则只做前向标定（用实时快照逐日累积，首月内滚动校准）。
3. **Alpaca 推流：已决——不上。** 理由：东财 48ms / 5 秒轮询在感知上等同推流，且 IEX 单一交易所会引入 2–3% 成交量样本带来的价格偏离，净收益为负。代码中保留 `AlpacaStreamSource` 适配器骨架（`capabilities: ['stream']`，默认不注册），将来想开只需填入 key 与一行配置。`asset_class` 字段保留扩展位，第一版只落 `us_equity`。
