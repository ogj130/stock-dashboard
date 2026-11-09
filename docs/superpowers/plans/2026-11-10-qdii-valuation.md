# QDII 持仓实时估值器 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 录入持有的美股 QDII 基金，基于跟踪指数全量成分或基金真实持仓，实时估算当日净值涨跌与收益金额，并用真实净值持续校准误差。

**Architecture:** 单进程全栈。Node 24 + Fastify 提供 JSON API，`node:sqlite` 内置数据库零原生依赖，React + Vite 出界面，前端 5 秒轮询估值接口（单用户场景下 SSE 属过度设计，不做）。估值核心是纯函数，可脱离网络单测；取数走五层数据源梯队（东财 → 腾讯 → CNBC → Alpaca 预留 → 新浪），带失败降级与主备冲突裁决。

**Tech Stack:** TypeScript / Node 24 / Fastify / node:sqlite / Vite + React / Vitest / tsx

**Spec:** [2026-11-10-qdii-valuation-design.md](../specs/2026-11-10-qdii-valuation-design.md)

---

## 环境约定

- 工作目录：`/Users/ouguangji/2026/stock-my`
- 包管理器：`pnpm`
- 所有命令在项目根目录执行
- 测试框架：`vitest`（`pnpm test`）
- 真实网络测试打标签 `@network`，默认跳过：`vitest run -- --exclude '**/*.network.test.ts'` 不需要，用 `describe.skipIf(!process.env.NET)` 控制

## 文件结构

| 路径 | 职责 |
|---|---|
| `src/types.ts` | 全部共享类型：`Quote`、`MarketStatus`、`Holding`、`EstimateInput/Result` |
| `src/config.ts` | 常量：批次上限、过期阈值、源优先级 |
| `src/store/db.ts` | `node:sqlite` 连接与建表迁移 |
| `src/store/queries.ts` | 各表的读写函数（唯一允许写 SQL 的地方） |
| `src/sources/types.ts` | `QuoteSource` 接口契约 |
| `src/sources/eastmoney.ts` | L1 主源 |
| `src/sources/tencent.ts` | L2 校验源 |
| `src/sources/cnbc.ts` | L3 权威源 + 市场状态 |
| `src/sources/sina.ts` | L5 兜底 |
| `src/sources/alpaca.ts` | L4 推流骨架，默认不注册 |
| `src/sources/registry.ts` | 梯队调度、失败降级、冲突裁决 |
| `src/fund/holdings.ts` | 基金代码 → 持仓（含 `ETFCODE` 递归） |
| `src/fund/indexWeight.ts` | 指数全量成分与权重重算 |
| `src/engine/estimate.ts` | 估值核心（纯函数） |
| `src/engine/phase.ts` | 相位判定 |
| `src/engine/calibrate.ts` | lag 标定 + exposure 最小二乘 |
| `src/sync/quotes.ts` | 定时行情轮询写缓存 |
| `src/sync/nav.ts` | 净值抓取与残差入账 |
| `src/routes/*.ts` | HTTP 路由 |
| `src/server.ts` | 装配入口 |
| `web/*` | React 界面 |
| `scripts/backtest.ts` | walk-forward 回测，产出 MAE |
| `scripts/probe.ts` | 实现前必须验证的三件事的探测脚本 |

拆分原则：`engine/` 不 import `sources/`，纯计算；`sources/` 不知道数据库存在；`store/` 不知道业务。这样估值逻辑可以脱离网络单测，是这套东西能长期维护的前提。

---

## Phase M1 · 数据通

### Task 1: 项目骨架与工具链

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: 初始化项目**

```bash
cd /Users/ouguangji/2026/stock-my
pnpm init
pnpm add fastify @fastify/static react react-dom
pnpm add -D typescript tsx vite @vitejs/plugin-react vitest @types/node @types/react @types/react-dom
```

- [ ] **Step 2: 写 `package.json` 脚本**

```json
{
  "name": "stock-my",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "dev:web": "vite",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "backtest": "tsx scripts/backtest.ts",
    "probe": "tsx scripts/probe.ts"
  }
}
```

- [ ] **Step 3: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"],
    "noEmit": true
  },
  "include": ["src", "web", "scripts", "tests"]
}
```

- [ ] **Step 4: 写 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: 写 `.gitignore`**

```
node_modules
data/*.db
data/*.db-*
dist
.DS_Store
```

- [ ] **Step 6: 验证工具链**

Run: `pnpm typecheck && pnpm test`
Expected: `typecheck` 无输出（0 error）；`vitest` 报 "No test files found" 但退出码 0 或 1（无测试时属正常）。退出码非 0 且原因是编译错误，说明工具链没配对。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "chore: 项目骨架与工具链"
```

---

### Task 2: 数据库 schema 与迁移

**Files:**
- Create: `src/store/db.ts`, `src/config.ts`
- Test: `tests/store/db.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/store/db.test.ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/store/db'

describe('db', () => {
  it('建表后六张表都存在', () => {
    const db = openDb(':memory:')
    const names = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r: any) => r.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'fund', 'constituent', 'quote_cache', 'fx_cache', 'nav_history', 'estimate_log', 'residual',
      ]),
    )
  })

  it('重复建表不报错（幂等迁移）', () => {
    const db = openDb(':memory:')
    expect(() => migrate(db)).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/store/db.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/db'`

- [ ] **Step 3: 写 `src/config.ts`**

```ts
export const CONFIG = {
  batchSize: 100,
  staleMs: { live: 30_000, settled: 600_000, fx: 60_000 },
  conflictTolerance: 0.005,      // 主备偏差 0.5% 触发裁决
  degradeAfterFailures: 3,
  degradeCooldownMs: 600_000,
  pollMs: { live: 5_000, settled: 600_000 },
  cnbcRecheckMs: 300_000,
  navPollMs: 1_800_000,
  calibrationWindow: 60,
} as const
```

- [ ] **Step 4: 写 `src/store/db.ts`**

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

const SCHEMA = `
create table if not exists fund (
  id integer primary key autoincrement,
  code text not null unique,
  name text not null default '',
  kind text not null default 'index',
  target_etf_code text,
  index_key text,
  asset_class text not null default 'us_equity',
  shares real not null default 0,
  cost_basis real not null default 0,
  exposure real not null default 0.95,
  lag_days integer not null default 1,
  calibrated_at text,
  created_at text not null default (datetime('now'))
);

create table if not exists constituent (
  id integer primary key autoincrement,
  owner_type text not null,
  owner_key text not null,
  symbol text not null,
  name text not null default '',
  weight real not null,
  as_of text not null,
  source text not null,
  unique(owner_type, owner_key, symbol, as_of)
);

create table if not exists quote_cache (
  symbol text not null,
  asset_class text not null default 'us_equity',
  price real not null,
  prev_close real not null,
  pct real not null,
  ts_ms integer not null,
  source_id text not null,
  fetched_at integer not null,
  primary key (symbol, source_id)
);

create table if not exists fx_cache (
  pair text not null,
  rate real not null,
  ts_ms integer not null,
  source_id text not null,
  primary key (pair, source_id)
);

create table if not exists nav_history (
  fund_code text not null,
  nav_date text not null,
  nav real not null,
  pct real not null,
  primary key (fund_code, nav_date)
);

create table if not exists estimate_log (
  id integer primary key autoincrement,
  fund_code text not null,
  model_ts integer not null,
  phase text not null,
  model_pct real not null,
  model_amount real not null default 0,
  covered_weight real not null,
  constituents_json text not null,
  lag_days integer not null,
  exposure real not null
);

create table if not exists residual (
  id integer primary key autoincrement,
  fund_code text not null,
  nav_date text not null,
  model_pct real not null,
  actual_pct real not null,
  diff real not null,
  nav_ts integer not null,
  unique(fund_code, nav_date)
);

create index if not exists idx_constituent_owner on constituent(owner_type, owner_key);
create index if not exists idx_estimate_fund_ts on estimate_log(fund_code, model_ts);
`

export function migrate(db: Db): void {
  db.exec(SCHEMA)
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  migrate(db)
  return db
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/store/db.test.ts`
Expected: PASS 2 passed

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(store): sqlite schema 与幂等迁移"
```

---

### Task 3: 共享类型与行情契约

**Files:**
- Create: `src/types.ts`, `src/sources/types.ts`

- [ ] **Step 1: 写 `src/types.ts`**

```ts
export type MarketStatus = 'PRE_MKT' | 'REG_MKT' | 'POST_MKT' | 'CLOSED'
export type Phase = 'live' | 'settled'
export type AssetClass = 'us_equity'

export interface Quote {
  symbol: string
  price: number
  prevClose: number
  pct: number          // 当日涨跌幅，百分数（2.31 表示 +2.31%）
  tsMs: number
  precision: number
  sourceId: string
}

export interface MarketSnapshot {
  status: MarketStatus
  tsMs: number
  sourceId: string
}

export interface Holding {
  symbol: string
  name: string
  weight: number       // 0~1 的小数
}

export interface EstimateInput {
  holdings: Array<Holding & { pct: number }>
  fxNow: number
  fxPrev: number
  exposure: number
  residualPct?: number
}

export interface EstimateResult {
  stockPct: number
  fxPct: number
  navPct: number
  coveredWeight: number
  breakdown: Array<{ symbol: string; weight: number; pct: number; contribution: number }>
}
```

- [ ] **Step 2: 写 `src/sources/types.ts`**

```ts
import type { MarketSnapshot, Quote } from '../types'

export type Capability = 'quote' | 'marketStatus' | 'prepost' | 'stream'

export interface QuoteSource {
  id: string
  maxBatch: number
  sep: string
  capabilities: Capability[]
  fetchQuotes(symbols: string[]): Promise<Quote[]>
  fetchMarketStatus?(): Promise<MarketSnapshot>
}
```

- [ ] **Step 3: 类型自检**

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat(types): 行情与估值共享契约"
```

---

### Task 4: 东财适配器（L1 主源）

**Files:**
- Create: `src/sources/eastmoney.ts`
- Test: `tests/sources/eastmoney.test.ts`

- [ ] **Step 1: 写失败测试（解析与归一）**

```ts
// tests/sources/eastmoney.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeEastmoney, toSecid } from '../../src/sources/eastmoney'

const RAW = {
  data: {
    diff: [
      { f2: 350170, f3: 228, f12: 'AAPL', f13: 105, f14: '苹果', f18: 342370 },
      { f2: 542330, f3: 221, f12: 'MSFT', f13: 105, f14: '微软', f18: 530610 },
    ],
  },
}

describe('eastmoney', () => {
  it('价格放大 1000 倍要还原，涨跌幅放大 100 倍要还原', () => {
    const q = normalizeEastmoney(RAW)[0]!
    expect(q.symbol).toBe('AAPL')
    expect(q.price).toBeCloseTo(350.17, 3)
    expect(q.prevClose).toBeCloseTo(342.37, 3)
    expect(q.pct).toBeCloseTo(2.28, 3)
  })

  it('沪深美股市场码映射正确', () => {
    expect(toSecid('AAPL', 105)).toBe('105.AAPL')
    expect(toSecid('IBM', 106)).toBe('106.IBM')
  })

  it('缺字段的条目被丢弃而不是产生 NaN', () => {
    const q = normalizeEastmoney({ data: { diff: [{ f12: 'X' }] } })
    expect(q).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sources/eastmoney.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/sources/eastmoney.ts`**

```ts
import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const BASE = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const FIELDS = 'f2,f3,f12,f13,f14,f18'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export const MARKET = { NASDAQ: 105, NYSE: 106, AMEX: 107 } as const

export function toSecid(symbol: string, market: number): string {
  return `${market}.${symbol}`
}

interface EmRow {
  f2?: number
  f3?: number
  f12?: string
  f13?: number
  f14?: string
  f18?: number
}

export function normalizeEastmoney(raw: { data?: { diff?: EmRow[] } | null }): Quote[] {
  const rows = raw.data?.diff ?? []
  const out: Quote[] = []
  for (const r of rows) {
    if (!r.f12 || typeof r.f2 !== 'number' || typeof r.f18 !== 'number') continue
    out.push({
      symbol: r.f12,
      price: r.f2 / 1000,
      prevClose: r.f18 / 1000,
      pct: (r.f3 ?? 0) / 100,
      tsMs: Date.now(),
      precision: 2,
      sourceId: 'eastmoney',
    })
  }
  return out
}

export class EastmoneySource implements QuoteSource {
  id = 'eastmoney'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote']

  constructor(private marketOf: (symbol: string) => number = () => MARKET.NASDAQ) {}

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return []
    const secids = symbols.slice(0, this.maxBatch).map((s) => toSecid(s, this.marketOf(s))).join(',')
    const url = `${BASE}?secids=${secids}&fields=${FIELDS}`
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`eastmoney http ${res.status}`)
    return normalizeEastmoney((await res.json()) as any)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sources/eastmoney.test.ts`
Expected: PASS 3 passed

- [ ] **Step 5: 真实接口烟囱测试（打网络）**

```ts
// tests/sources/eastmoney.network.test.ts
import { describe, it, expect } from 'vitest'
import { EastmoneySource } from '../../src/sources/eastmoney'

describe.skipIf(!process.env.NET)('eastmoney 真实接口', () => {
  it('一次拉 100 只 NDX 成分不报错', async () => {
    const src = new EastmoneySource()
    const syms = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'GOOG', 'AVGO', 'TSLA', 'COST']
    const q = await src.fetchQuotes(syms)
    expect(q.length).toBeGreaterThanOrEqual(9)
    expect(q[0]!.price).toBeGreaterThan(0)
  })
})
```

Run: `NET=1 pnpm vitest run tests/sources/eastmoney.network.test.ts`
Expected: PASS，实时价非零

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(sources): 东财主源适配器"
```

---

### Task 5: 腾讯适配器（L2 校验源）

**Files:**
- Create: `src/sources/tencent.ts`
- Test: `tests/sources/tencent.test.ts`

- [ ] **Step 1: 写失败测试（真实报文形状）**

```ts
// tests/sources/tencent.test.ts
import { describe, it, expect } from 'vitest'
import { parseTencent } from '../../src/sources/tencent'

// 实测报文（2026-11-10 01:36 采集），以索引对齐方式截取前 36 个字段：
// [0]状态 [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 ... [30]时间 [31]涨跌额 [32]涨跌幅 [33]高 [34]低 [35]币种
const RAW = `v_usAAPL="${['200', '苹果', 'AAPL.OQ', '349.58', '342.37', '345.00', '15566421',
  ...Array(23).fill('0'), '2026-11-09 12:36:20', '7.21', '2.10', '351.42', '344.78', 'USD'].join('~')}";`;

describe('tencent', () => {
  it('按字段索引取现价/昨收/涨跌幅', () => {
    const q = parseTencent(RAW)[0]!
    expect(q.symbol).toBe('AAPL')
    expect(q.price).toBeCloseTo(349.58, 2)
    expect(q.prevClose).toBeCloseTo(342.37, 2)
    expect(q.pct).toBeCloseTo(2.1, 2)
  })

  it('时间戳按美东解析成毫秒', () => {
    const q = parseTencent(RAW)[0]!
    expect(q.tsMs).toBe(Date.parse('2026-11-09T12:36:20-05:00'))
  })

  it('状态码非 200 的条目被丢弃', () => {
    expect(parseTencent('v_usXXXX="301~x~x";')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sources/tencent.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/sources/tencent.ts`**

```ts
import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// 字段索引实测于 2026-11-10，共 73 个字段
const IDX = { status: 0, name: 1, code: 2, price: 3, prevClose: 4, time: 30, pct: 32 } as const

/** 把 "2026-11-09 12:36:20"（美东）转成毫秒时间戳 */
function etToMs(s: string): number {
  // 美东时间；11 月为 EST(-05:00)。冬夏令时切换由 Date 的 IANA 库无法直接处理字符串，
  // 因此这里沿用交易所标注的偏移，跨季节由 CNBC 的 ISO 时间戳兜底校验。
  return Date.parse(`${s.replace(' ', 'T')}-05:00`)
}

export function parseTencent(raw: string): Quote[] {
  const out: Quote[] = []
  for (const chunk of raw.split(';')) {
    const m = chunk.match(/v_us([A-Z.\-]+)="([^"]*)"/)
    if (!m) continue
    const f = m[2]!.split('~')
    if (f[IDX.status] !== '200') continue
    const price = Number(f[IDX.price])
    const prevClose = Number(f[IDX.prevClose])
    if (!Number.isFinite(price) || !Number.isFinite(prevClose)) continue
    out.push({
      symbol: m[1]!,
      price,
      prevClose,
      pct: Number(f[IDX.pct] ?? 0),
      tsMs: etToMs(f[IDX.time] ?? ''),
      precision: 3,
      sourceId: 'tencent',
    })
  }
  return out
}

export class TencentSource implements QuoteSource {
  id = 'tencent'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote']

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return []
    const q = symbols.slice(0, this.maxBatch).map((s) => `us${s}`).join(',')
    const res = await fetch(`https://qt.gtimg.cn/q=${q}`, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`tencent http ${res.status}`)
    const buf = await res.arrayBuffer()
    const text = new TextDecoder('gb18030').decode(buf)
    return parseTencent(text)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sources/tencent.test.ts`
Expected: PASS 3 passed

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(sources): 腾讯校验源适配器"
```

---

### Task 6: CNBC 适配器（L3 权威源 + 市场状态）

**Files:**
- Create: `src/sources/cnbc.ts`
- Test: `tests/sources/cnbc.test.ts`

- [ ] **Step 1: 写失败测试（含那个静默截断的坑）**

```ts
// tests/sources/cnbc.test.ts
import { describe, it, expect, vi } from 'vitest'
import { parseCnbc, CnbcSource } from '../../src/sources/cnbc'

const RAW = {
  FormattedQuoteResult: {
    FormattedQuote: [
      {
        symbol: 'AAPL', last: '349.49', change_pct: '+2.08%', previous_day_closing: '342.37',
        last_time: '2026-11-09T12:36:30.292-0500', curmktstatus: 'REG_MKT', realTime: 'true',
      },
    ],
  },
}

describe('cnbc', () => {
  it('解析带符号的百分比字符串', () => {
    expect(parseCnbc(RAW)[0]!.pct).toBeCloseTo(2.08, 2)
    expect(parseCnbc(RAW)[0]!.price).toBeCloseTo(349.49, 2)
  })

  it('解析 ISO 带偏移的时间', () => {
    expect(parseCnbc(RAW)[0]!.tsMs).toBe(Date.parse('2026-11-09T12:36:30.292-05:00'))
  })

  it('市场状态映射', () => {
    expect(parseStatus(RAW)).toBe('REG_MKT')
  })

  it('返回条数少于请求条数时抛错，绝不静默放过', async () => {
    const src = new CnbcSource()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => RAW, // 请求 3 只，只回 1 只
    }))
    await expect(src.fetchQuotes(['AAPL', 'MSFT', 'NVDA'])).rejects.toThrow(/incomplete/i)
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sources/cnbc.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/sources/cnbc.ts`**

```ts
import type { MarketSnapshot, MarketStatus, Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const BASE = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'

interface RawQuote {
  symbol?: string
  last?: string
  change_pct?: string
  previous_day_closing?: string
  last_time?: string
  curmktstatus?: string
  realTime?: string
}

function num(s?: string): number {
  if (!s) return NaN
  return Number(s.replace(/[+%,]/g, ''))
}

export function normalizeStatus(s?: string): MarketStatus {
  switch (s) {
    case 'PRE_MKT':
    case 'REG_MKT':
    case 'POST_MKT':
    case 'CLOSED':
      return s
    default:
      return 'CLOSED'
  }
}

export function parseCnbc(raw: any): Quote[] {
  const list: RawQuote[] = raw?.FormattedQuoteResult?.FormattedQuote ?? []
  const out: Quote[] = []
  for (const r of list) {
    const price = num(r.last)
    const prevClose = num(r.previous_day_closing)
    if (!r.symbol || !Number.isFinite(price) || !Number.isFinite(prevClose)) continue
    out.push({
      symbol: r.symbol,
      price,
      prevClose,
      pct: num(r.change_pct),
      tsMs: r.last_time ? Date.parse(r.last_time) : Date.now(),
      precision: 2,
      sourceId: 'cnbc',
    })
  }
  return out
}

export function parseStatus(raw: any): MarketStatus {
  const first = raw?.FormattedQuoteResult?.FormattedQuote?.[0]
  return normalizeStatus(first?.curmktstatus)
}

export class CnbcSource implements QuoteSource {
  id = 'cnbc'
  maxBatch = 100
  /** CNBC 只认管道符；用逗号不报错，只静默返回第一条 */
  sep = '|'
  capabilities: Capability[] = ['quote', 'marketStatus', 'prepost']

  private url(symbols: string[]): string {
    const s = encodeURIComponent(symbols.join(this.sep))
    return `${BASE}?symbols=${s}&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json`
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    const want = symbols.slice(0, this.maxBatch)
    if (want.length === 0) return []
    const res = await fetch(this.url(want), { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`cnbc http ${res.status}`)
    const quotes = parseCnbc(await res.json())
    if (quotes.length !== want.length) {
      throw new Error(`cnbc incomplete response: want ${want.length}, got ${quotes.length}（检查分隔符是否为 '|'）`)
    }
    return quotes
  }

  async fetchMarketStatus(): Promise<MarketSnapshot> {
    const res = await fetch(this.url(['AAPL']), { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`cnbc status http ${res.status}`)
    const raw = await res.json()
    return { status: parseStatus(raw), tsMs: Date.now(), sourceId: this.id }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sources/cnbc.test.ts`
Expected: PASS 4 passed

- [ ] **Step 5: 真实接口验证市场状态**

```bash
curl -s -m 10 -A 'Mozilla/5.0' 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=AAPL&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json' | grep -o '"curmktstatus":"[A-Z_]*"'
```
Expected: `"curmktstatus":"REG_MKT"`（美股盘中）；收盘后为 `POST_MKT`/`CLOSED`

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(sources): CNBC 权威源，含条数断言与市场状态"
```

---

### Task 7: 新浪兜底与 Alpaca 骨架

**Files:**
- Create: `src/sources/sina.ts`, `src/sources/alpaca.ts`
- Test: `tests/sources/sina.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/sources/sina.test.ts
import { describe, it, expect } from 'vitest'
import { parseSina } from '../../src/sources/sina'

const RAW = `var hq_str_gb_aapl="苹果,350.1200,2.26,2026-11-10 01:13:44,7.7500,344.9950,351.4200,344.7800,355.3800,242.8900";`

describe('sina', () => {
  it('取现价与涨跌幅', () => {
    const q = parseSina(RAW)[0]!
    expect(q.symbol).toBe('AAPL')
    expect(q.price).toBeCloseTo(350.12, 2)
    expect(q.pct).toBeCloseTo(2.26, 2)
  })
  it('昨收 = 现价 - 涨跌额', () => {
    expect(parseSina(RAW)[0]!.prevClose).toBeCloseTo(350.12 - 7.75, 2)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sources/sina.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/sources/sina.ts`**

```ts
import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'

export function parseSina(raw: string): Quote[] {
  const out: Quote[] = []
  for (const chunk of raw.split(';')) {
    const m = chunk.match(/hq_str_gb_([a-z.\-]+)="([^"]*)"/)
    if (!m) continue
    const f = m[2]!.split(',')
    const price = Number(f[1])
    const pct = Number(f[2])
    const change = Number(f[4])
    if (!Number.isFinite(price)) continue
    out.push({
      symbol: m[1]!.toUpperCase(),
      price,
      prevClose: Number.isFinite(change) ? price - change : price / (1 + pct / 100),
      pct,
      tsMs: f[3] ? Date.parse(`${f[3]!.replace(' ', 'T')}+08:00`) : Date.now(),
      precision: 4,
      sourceId: 'sina',
    })
  }
  return out
}

export class SinaSource implements QuoteSource {
  id = 'sina'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote']

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return []
    const list = symbols.slice(0, this.maxBatch).map((s) => `gb_${s.toLowerCase()}`).join(',')
    const res = await fetch(`https://hq.sinajs.cn/list=${list}`, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    })
    if (!res.ok) throw new Error(`sina http ${res.status}`)
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
    return parseSina(text)
  }
}
```

- [ ] **Step 4: 实现 `src/sources/alpaca.ts`（骨架，默认不注册）**

```ts
import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

/**
 * L4 可选推流源。默认不注册进 registry。
 * 启用方式：设置 ALPACA_KEY_ID / ALPACA_SECRET_KEY 环境变量，
 * 并在 createRegistry() 里把 new AlpacaSource() 加入 sources 数组。
 * 已知代价：免费层只有 IEX 单一交易所，成交量占全市场 2~3%，价格与 consolidated tape 存在系统性偏离。
 */
export class AlpacaSource implements QuoteSource {
  id = 'alpaca'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote', 'stream']

  constructor(
    private keyId = process.env.ALPACA_KEY_ID ?? '',
    private secret = process.env.ALPACA_SECRET_KEY ?? '',
  ) {}

  get enabled(): boolean {
    return Boolean(this.keyId && this.secret)
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (!this.enabled) throw new Error('alpaca credentials missing')
    const list = symbols.slice(0, this.maxBatch).join(',')
    const res = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${list}&feed=iex`, {
      headers: { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secret },
    })
    if (!res.ok) throw new Error(`alpaca http ${res.status}`)
    const body = (await res.json()) as Record<string, any>
    return Object.entries(body).map(([symbol, snap]) => {
      const price = snap?.latestTrade?.p ?? 0
      const prevClose = snap?.prevDailyBar?.c ?? price
      return {
        symbol,
        price,
        prevClose,
        pct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
        tsMs: Date.parse(snap?.latestTrade?.t ?? '') || Date.now(),
        precision: 2,
        sourceId: 'alpaca',
      }
    })
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/sources/sina.test.ts`
Expected: PASS 2 passed

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(sources): 新浪兜底与 alpaca 推流骨架"
```

---

### Task 8: 源注册表、失败降级与冲突裁决

**Files:**
- Create: `src/sources/registry.ts`
- Test: `tests/sources/registry.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/sources/registry.test.ts
import { describe, it, expect } from 'vitest'
import { QuoteRegistry } from '../../src/sources/registry'
import type { QuoteSource } from '../../src/sources/types'
import type { Quote } from '../../src/types'

function fake(id: string, price: number, op: () => Promise<Quote[]>) {
  return { id, maxBatch: 100, sep: ',', capabilities: ['quote'], fetchQuotes: op } as QuoteSource
}
const q = (symbol: string, price: number, sourceId: string): Quote => ({
  symbol, price, prevClose: 100, pct: ((price - 100) / 100) * 100, tsMs: Date.now(), precision: 2, sourceId,
})

describe('QuoteRegistry', () => {
  it('主源正常时直接用主源', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),
      fake('b', 0, async () => [q('AAPL', 111, 'b')]),
    ])
    const r = await reg.getQuotes(['AAPL'])
    expect(r.get('AAPL')!.sourceId).toBe('a')
  })

  it('主源连续失败三次后降级到备源', async () => {
    let calls = 0
    const reg = new QuoteRegistry([
      fake('a', 0, async () => { calls++; throw new Error('down') }),
      fake('b', 0, async () => [q('AAPL', 111, 'b')]),
    ])
    for (let i = 0; i < 3; i++) await reg.getQuotes(['AAPL'])
    const r = await reg.getQuotes(['AAPL'])
    expect(calls).toBe(3)
    expect(r.get('AAPL')!.sourceId).toBe('b')
  })

  it('主备偏差超 0.5% 且无第三方裁决时拒绝写入（返回空）', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),
      fake('b', 0, async () => [q('AAPL', 120, 'b')]),
    ])
    const r = await reg.getQuotes(['AAPL'], { crossCheck: true })
    expect(r.has('AAPL')).toBe(false)
    expect(reg.lastConflicts()).toContain('AAPL')
  })

  it('第三方与主源一致时采用主源', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),
      fake('b', 0, async () => [q('AAPL', 120, 'b')]),
      fake('c', 0, async () => [q('AAPL', 110.1, 'c')]),
    ])
    const r = await reg.getQuotes(['AAPL'], { crossCheck: true })
    expect(r.get('AAPL')!.sourceId).toBe('a')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sources/registry.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/sources/registry.ts`**

```ts
import { CONFIG } from '../config'
import type { Quote } from '../types'
import type { QuoteSource } from './types'

interface Options {
  crossCheck?: boolean
}

export class QuoteRegistry {
  private failures = new Map<string, number>()
  private degradedUntil = new Map<string, number>()
  private conflicts: string[] = []

  constructor(private sources: QuoteSource[]) {
    if (sources.length === 0) throw new Error('registry needs at least one source')
  }

  lastConflicts(): string[] {
    return [...this.conflicts]
  }

  /** 按优先级取第一个可用源 */
  private order(): QuoteSource[] {
    const now = Date.now()
    return [...this.sources].sort((a, b) => {
      const da = (this.degradedUntil.get(a.id) ?? 0) > now ? 1 : 0
      const db = (this.degradedUntil.get(b.id) ?? 0) > now ? 1 : 0
      return da - db
    })
  }

  private markFailure(id: string): void {
    const n = (this.failures.get(id) ?? 0) + 1
    this.failures.set(id, n)
    if (n >= CONFIG.degradeAfterFailures) {
      this.degradedUntil.set(id, Date.now() + CONFIG.degradeCooldownMs)
      this.failures.set(id, 0)
    }
  }

  async getQuotes(symbols: string[], opts: Options = {}): Promise<Map<string, Quote>> {
    this.conflicts = []
    const order = this.order()
    const primary = order[0]!
    let primaryMap: Map<string, Quote>
    try {
      primaryMap = index(await primary.fetchQuotes(symbols))
      this.failures.set(primary.id, 0)
    } catch {
      this.markFailure(primary.id)
      if (order[1]) {
        primaryMap = index(await order[1].fetchQuotes(symbols))
      } else {
        throw new Error('all sources failed')
      }
    }

    if (!opts.crossCheck || order.length < 2) return primaryMap

    // 交叉校验：主源与校验源比价
    let checkMap: Map<string, Quote>
    try {
      checkMap = index(await order[1]!.fetchQuotes(symbols))
    } catch {
      return primaryMap
    }

    const result = new Map(primaryMap)
    for (const [sym, p] of primaryMap) {
      const c = checkMap.get(sym)
      if (!c || p.price === 0) continue
      const diff = Math.abs(p.price - c.price) / p.price
      if (diff <= CONFIG.conflictTolerance) continue

      // 引入第三方裁决
      const arbiter = order[2]
      if (!arbiter) {
        result.delete(sym)
        this.conflicts.push(sym)
        continue
      }
      try {
        const a = index(await arbiter.fetchQuotes([sym])).get(sym)
        if (!a) { result.delete(sym); this.conflicts.push(sym); continue }
        const da = Math.abs(p.price - a.price) / p.price
        const dc = Math.abs(c.price - a.price) / a.price
        if (da <= dc) continue           // 主源胜出
        result.set(sym, { ...c, sourceId: c.sourceId })
      } catch {
        result.delete(sym)
        this.conflicts.push(sym)
      }
    }
    return result
  }
}

function index(list: Quote[]): Map<string, Quote> {
  return new Map(list.map((q) => [q.symbol, q]))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/sources/registry.test.ts`
Expected: PASS 4 passed

> 若第 3 条测试（偏差超限且无第三方）失败，检查 `crossCheck` 分支是否在 `order.length < 2` 时提前 return。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(sources): 梯队注册表、降级与冲突裁决"
```

---

### Task 9: 基金持仓解析（含 ETFCODE 递归）

**Files:**
- Create: `src/fund/holdings.ts`
- Test: `tests/fund/holdings.test.ts`

- [ ] **Step 1: 写失败测试（用实测报文）**

```ts
// tests/fund/holdings.test.ts
import { describe, it, expect } from 'vitest'
import { parsePosition, resolveHoldingsFrom, type PositionResp } from '../../src/fund/holdings'

// 270042 广发纳指100ETF联接：不持股，只给 ETFCODE
const LINK: PositionResp = {
  Datas: { fundStocks: [], fundboods: [], fundfofs: [], ETFCODE: '159941', ETFSHORTNAME: '纳指ETF广发' },
  Expansion: '2026-09-30',
}

// 159941：真实持仓
const ETF: PositionResp = {
  Datas: {
    fundStocks: [
      { GPDM: 'NVDA', GPJC: '英伟达', JZBL: '7.6' },
      { GPDM: 'AAPL', GPJC: '苹果', JZBL: '6.71' },
    ],
    fundboods: [], fundfofs: [], ETFCODE: null,
  },
  Expansion: '2026-09-30',
}

describe('holdings', () => {
  it('联接基金识别出目标 ETF', () => {
    const p = parsePosition(LINK)
    expect(p.targetEtf).toBe('159941')
    expect(p.holdings).toHaveLength(0)
  })

  it('ETF 持仓权重转成 0~1 小数', () => {
    const p = parsePosition(ETF)
    expect(p.targetEtf).toBeNull()
    expect(p.holdings[0]).toMatchObject({ symbol: 'NVDA', weight: 0.076 })
  })

  it('联接基金递归查到 ETF 的持仓', async () => {
    const fetchPosition = async (code: string) => (code === '270042' ? LINK : ETF)
    const r = await resolveHoldingsFrom('270042', fetchPosition)
    expect(r.holdings.map((h) => h.symbol)).toEqual(['NVDA', 'AAPL'])
    expect(r.viaEtf).toBe('159941')
  })

  it('ETF 也拿不到时返回空持仓而不是抛错', async () => {
    const fetchPosition = async () => ({ Datas: { fundStocks: [], fundboods: [], fundfofs: [], ETFCODE: null } })
    const r = await resolveHoldingsFrom('000000', fetchPosition)
    expect(r.holdings).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/fund/holdings.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/fund/holdings.ts`**

```ts
import type { Holding } from '../types'

const UA = 'EMProjJijin/6.5.0 (iPhone; iOS 16.0)'

export interface RawStock { GPDM: string; GPJC: string; JZBL: string }
export interface PositionResp {
  Datas: {
    fundStocks?: RawStock[] | null
    fundboods?: unknown[] | null
    fundfofs?: unknown[] | null
    ETFCODE?: string | null
    ETFSHORTNAME?: string | null
  }
  Expansion?: string
}

export interface ParsedPosition {
  holdings: Holding[]
  targetEtf: string | null
  asOf: string
}

export function parsePosition(resp: PositionResp): ParsedPosition {
  const stocks = resp.Datas.fundStocks ?? []
  const holdings: Holding[] = stocks
    .filter((s) => s.GPDM && Number.isFinite(Number(s.JZBL)))
    .map((s) => ({
      symbol: s.GPDM.trim().toUpperCase(),
      name: s.GPJC,
      weight: Number(s.JZBL) / 100,
    }))
  return {
    holdings,
    targetEtf: resp.Datas.ETFCODE?.trim() || null,
    asOf: resp.Expansion ?? new Date().toISOString().slice(0, 10),
  }
}

export async function fetchPosition(code: string): Promise<PositionResp> {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${code}` +
    `&deviceid=1&plat=Android&product=EFund&version=1`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`position http ${res.status} for ${code}`)
  return (await res.json()) as PositionResp
}

export interface ResolvedHoldings {
  holdings: Holding[]
  viaEtf: string | null
  asOf: string
}

/**
 * 基金代码 → 持仓。
 * 联接基金自身不持股，接口只返回 ETFCODE，需再查一次目标 ETF。
 * 递归深度限制 1 层：目前不存在 ETF 套 ETF 的情形，超限即返回空，避免环形请求。
 */
export async function resolveHoldingsFrom(
  code: string,
  fetcher: (code: string) => Promise<PositionResp>,
): Promise<ResolvedHoldings> {
  const first = parsePosition(await fetcher(code))
  if (first.holdings.length > 0) {
    return { holdings: first.holdings, viaEtf: null, asOf: first.asOf }
  }
  if (!first.targetEtf) {
    return { holdings: [], viaEtf: null, asOf: first.asOf }
  }
  const second = parsePosition(await fetcher(first.targetEtf))
  return { holdings: second.holdings, viaEtf: first.targetEtf, asOf: second.asOf }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/fund/holdings.test.ts`
Expected: PASS 4 passed

- [ ] **Step 5: 真实接口验证**

```bash
npx tsx -e "import {resolveHoldingsFrom,fetchPosition} from './src/fund/holdings.ts'; const r = await resolveHoldingsFrom('270042', fetchPosition); console.log(r.viaEtf, r.holdings.slice(0,3))"
```
Expected: `159941` + `[{symbol:'NVDA',weight:0.076}, ...]`

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(fund): 持仓解析与 ETFCODE 递归"
```

---

### Task 10: 指数全量成分与权重重算

**Files:**
- Create: `src/fund/indexWeight.ts`
- Test: `tests/fund/indexWeight.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/fund/indexWeight.test.ts
import { describe, it, expect } from 'vitest'
import { weightsFromMarketCap, parseNasdaqList } from '../../src/fund/indexWeight'

describe('indexWeight', () => {
  it('按市值占比算权重，总和为 1', () => {
    const w = weightsFromMarketCap([
      { symbol: 'A', marketCap: 600 },
      { symbol: 'B', marketCap: 300 },
      { symbol: 'C', marketCap: 100 },
    ])
    expect(w.find((x) => x.symbol === 'A')!.weight).toBeCloseTo(0.6, 6)
    expect(w.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 6)
  })

  it('市值缺失或为 0 的成分被剔除，避免 NaN 权重', () => {
    const w = weightsFromMarketCap([
      { symbol: 'A', marketCap: 100 },
      { symbol: 'B', marketCap: 0 },
      { symbol: 'C', marketCap: NaN },
    ])
    expect(w).toHaveLength(1)
  })

  it('解析纳斯达克官方 list-type 报文（下标 0 的符号原样保留）', () => {
    const raw = {
      data: { data: { rows: [{ symbol: 'AAPL', marketCap: '5,090,332,710,960', companyName: 'Apple Inc.' }] } },
    }
    expect(parseNasdaqList(raw)).toEqual([{ symbol: 'AAPL', marketCap: 5090332710960, name: 'Apple Inc.' }])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/fund/indexWeight.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/fund/indexWeight.ts`**

```ts
import type { Holding } from '../types'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export interface CapRow { symbol: string; marketCap: number; name: string }

export function parseNasdaqList(raw: any): CapRow[] {
  const rows: any[] = raw?.data?.data?.rows ?? []
  return rows
    .map((r) => ({
      symbol: String(r.symbol ?? '').trim().toUpperCase(),
      marketCap: Number(String(r.marketCap ?? '').replace(/,/g, '')),
      name: String(r.companyName ?? ''),
    }))
    .filter((r) => r.symbol && Number.isFinite(r.marketCap) && r.marketCap > 0)
}

/** 市值加权近似。纳斯达克 100 为修正市值加权，与本算法存在可度量偏差，需在回测中确认。 */
export function weightsFromMarketCap(rows: Array<{ symbol: string; marketCap: number }>): Holding[] {
  const valid = rows.filter((r) => Number.isFinite(r.marketCap) && r.marketCap > 0)
  const total = valid.reduce((s, r) => s + r.marketCap, 0)
  if (total <= 0) return []
  return valid.map((r) => ({ symbol: r.symbol, name: r.symbol, weight: r.marketCap / total }))
}

const INDEX_ENDPOINT: Record<string, string> = {
  ndx: 'https://api.nasdaq.com/api/quote/list-type/nasdaq100',
}

export async function fetchIndexWeights(indexKey: string): Promise<Holding[]> {
  const url = INDEX_ENDPOINT[indexKey]
  if (!url) throw new Error(`unknown index: ${indexKey}（sp500 全量源待 probe.ts 验证后再登记）`)
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`index http ${res.status}`)
  return weightsFromMarketCap(parseNasdaqList(await res.json()))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/fund/indexWeight.test.ts`
Expected: PASS 3 passed

- [ ] **Step 5: 真实接口验证权重总和**

```bash
npx tsx -e "import {fetchIndexWeights} from './src/fund/indexWeight.ts'; const w = await fetchIndexWeights('ndx'); console.log(w.length, w.reduce((s,x)=>s+x.weight,0).toFixed(6), w.slice(0,3))"
```
Expected: `101 1.000000` + 前三大权重

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(fund): 指数全量成分与市值权重重算"
```

---

## Phase M2 · 算得对

### Task 11: 估值核心（纯函数）

**Files:**
- Create: `src/engine/estimate.ts`
- Test: `tests/engine/estimate.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/engine/estimate.test.ts
import { describe, it, expect } from 'vitest'
import { estimateNav } from '../../src/engine/estimate'

const base = { fxNow: 7, fxPrev: 7, exposure: 1 }

describe('estimateNav', () => {
  it('全权重覆盖、汇率不变时等于加权涨跌', () => {
    const r = estimateNav({
      ...base,
      holdings: [
        { symbol: 'A', name: 'A', weight: 0.6, pct: 2 },
        { symbol: 'B', name: 'B', weight: 0.4, pct: -1 },
      ],
    })
    expect(r.navPct).toBeCloseTo(0.6 * 2 + 0.4 * -1, 6)
    expect(r.coveredWeight).toBeCloseTo(1, 6)
  })

  it('权重只覆盖 60% 时，剩余 40% 用残差代理', () => {
    const r = estimateNav({
      ...base,
      holdings: [{ symbol: 'A', name: 'A', weight: 0.6, pct: 2 }],
      residualPct: 1,
    })
    expect(r.navPct).toBeCloseTo(0.6 * 2 + 0.4 * 1, 6)
  })

  it('未给残差代理时，未覆盖部分按 0 计', () => {
    const r = estimateNav({ ...base, holdings: [{ symbol: 'A', name: 'A', weight: 0.6, pct: 2 }] })
    expect(r.navPct).toBeCloseTo(1.2, 6)
  })

  it('汇率升值抵消股票涨幅', () => {
    const r = estimateNav({
      fxNow: 6.86, fxPrev: 7, exposure: 1,
      holdings: [{ symbol: 'A', name: 'A', weight: 1, pct: 2 }],
    })
    // (1+2%)*(1-2%) - 1 ≈ -0.04%
    expect(r.navPct).toBeCloseTo((1.02 * 0.98 - 1) * 100, 4)
  })

  it('exposure 0.95 稀释涨跌（联接基金现金拖累）', () => {
    const r = estimateNav({
      ...base, exposure: 0.95,
      holdings: [{ symbol: 'A', name: 'A', weight: 1, pct: 2 }],
    })
    expect(r.navPct).toBeCloseTo(1.9, 6)
  })

  it('breakdown 给出每只股票的贡献且可加总回 navPct（fx=0、exposure=1 时）', () => {
    const r = estimateNav({
      ...base,
      holdings: [
        { symbol: 'A', name: 'A', weight: 0.5, pct: 4 },
        { symbol: 'B', name: 'B', weight: 0.5, pct: -2 },
      ],
    })
    const sum = r.breakdown.reduce((s, b) => s + b.contribution, 0)
    expect(sum).toBeCloseTo(r.navPct, 6)
  })

  it('权重全为 0 时不产生 NaN', () => {
    const r = estimateNav({ ...base, holdings: [{ symbol: 'A', name: 'A', weight: 0, pct: 5 }] })
    expect(Number.isFinite(r.navPct)).toBe(true)
    expect(r.navPct).toBe(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/engine/estimate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/engine/estimate.ts`**

```ts
import type { EstimateInput, EstimateResult } from '../types'

/**
 * QDII 净值涨跌估算。
 *
 *   r_cov   = Σ(wᵢ·pctᵢ) / Σwᵢ          已覆盖部分的加权涨跌
 *   r_stock = W_cov·r_cov + W_unc·r_unc   未覆盖部分用指数/残差代理
 *   r_fx    = fxNow/fxPrev − 1
 *   r_asset = (1+r_stock)(1+r_fx) − 1
 *   r_nav   = exposure · r_asset          余额为现金，收益按 0 计
 *
 * exposure 由 calibrate 拟合，代表基金实际投资于标的资产的仓位比例。
 */
export function estimateNav(input: EstimateInput): EstimateResult {
  const { holdings, fxNow, fxPrev, exposure, residualPct } = input

  const totalWeight = holdings.reduce((s, h) => s + h.weight, 0)
  const weighted =
    totalWeight > 0 ? holdings.reduce((s, h) => s + h.weight * h.pct, 0) / totalWeight : 0

  // 权重归一到「组合的 1.0」：totalWeight 可能 < 1（只覆盖前十大）
  const wCov = Math.min(1, Math.max(0, totalWeight))
  const wUnc = Math.max(0, 1 - wCov)
  const rUnc = residualPct ?? 0
  const rStock = wCov * weighted + wUnc * rUnc

  const rFx = fxPrev > 0 ? fxNow / fxPrev - 1 : 0
  const rAsset = (1 + rStock / 100) * (1 + rFx) - 1
  const rNav = exposure * rAsset * 100

  return {
    stockPct: rStock,
    fxPct: rFx * 100,
    navPct: rNav,
    coveredWeight: wCov,
    breakdown: totalWeight > 0
      ? holdings.map((h) => ({
          symbol: h.symbol,
          weight: h.weight,
          pct: h.pct,
          contribution: (h.weight / totalWeight) * h.pct * wCov * exposure,
        }))
      : [],
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/engine/estimate.test.ts`
Expected: PASS 7 passed

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(engine): 估值核心纯函数"
```

---

### Task 12: 相位判定

**Files:**
- Create: `src/engine/phase.ts`
- Test: `tests/engine/phase.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/engine/phase.test.ts
import { describe, it, expect } from 'vitest'
import { derivePhase, isPreMarket } from '../../src/engine/phase'

describe('phase', () => {
  it('盘中与盘前都是 live', () => {
    expect(derivePhase('REG_MKT')).toBe('live')
    expect(derivePhase('PRE_MKT')).toBe('live')
  })
  it('盘后与闭市都是 settled', () => {
    expect(derivePhase('POST_MKT')).toBe('settled')
    expect(derivePhase('CLOSED')).toBe('settled')
  })
  it('盘前被单独标记，用于 UI 不覆盖已定数值', () => {
    expect(isPreMarket('PRE_MKT')).toBe(true)
    expect(isPreMarket('REG_MKT')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/engine/phase.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/engine/phase.ts`**

```ts
import type { MarketStatus, Phase } from '../types'

/**
 * 相位只由交易所状态决定，不自行推算时区——
 * 美东冬夏令时每年切换两次，硬编码必错。
 */
export function derivePhase(status: MarketStatus): Phase {
  return status === 'PRE_MKT' || status === 'REG_MKT' ? 'live' : 'settled'
}

/** 盘前流动性薄，价格跳动大，只能作为参考，不得覆盖已定的夜间估值 */
export function isPreMarket(status: MarketStatus): boolean {
  return status === 'PRE_MKT'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/engine/phase.test.ts`
Expected: PASS 3 passed

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(engine): 相位判定"
```

---

### Task 13: 净值口径标定与仓位系数拟合

**Files:**
- Create: `src/engine/calibrate.ts`
- Test: `tests/engine/calibrate.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/engine/calibrate.test.ts
import { describe, it, expect } from 'vitest'
import { pickLag, fitExposure, pearson } from '../../src/engine/calibrate'

describe('calibrate', () => {
  it('相关系数：完全正相关为 1', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6)
  })

  it('能识别出净值滞后一天', () => {
    // 净值 seq 等于模型 seq 右移一位
    const nav = [0, 1, 2, 3, 0, 1]
    const model = [1, 2, 3, 0, 1, 2]
    const got = pickLag(nav, { 0: nav, 1: model, 2: [2, 3, 0, 1, 2, 3] })
    expect(got).toBe(0) // nav 与 lag0 序列完全一致
  })

  it('穿过原点的最小二乘给出 0.95', () => {
    const xs = [1, 2, 3, -1]
    const ys = xs.map((x) => x * 0.95)
    expect(fitExposure(xs, ys)).toBeCloseTo(0.95, 6)
  })

  it('样本过少时返回默认值而不是瞎拟合', () => {
    expect(fitExposure([1], [0.95])).toBe(0.95)
    expect(fitExposure([], [])).toBe(0.95)
  })

  it('全部输入为 0 时不产生 NaN', () => {
    expect(fitExposure([0, 0], [0, 0])).toBe(0.95)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/engine/calibrate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/engine/calibrate.ts`**

```ts
export const DEFAULT_EXPOSURE = 0.95

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return 0
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]! }
  const mx = sx / n, my = sy / n
  let cov = 0, vx = 0, vy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my
    cov += dx * dy; vx += dx * dx; vy += dy * dy
  }
  if (vx === 0 || vy === 0) return 0
  return cov / Math.sqrt(vx * vy)
}

/**
 * 标定净值口径：净值序列与「按权重加权的当日涨跌序列」做相关性比较，
 * 选出相关性最高的滞后天数。QDII 合同差异导致 0/1/2 都有可能出现。
 */
export function pickLag(navPcts: number[], modelByLag: Record<number, number[]>): number {
  let bestLag = 1
  let best = -Infinity
  for (const key of Object.keys(modelByLag)) {
    const lag = Number(key)
    const c = pearson(navPcts, modelByLag[lag]!)
    if (c > best) { best = c; bestLag = lag }
  }
  return bestLag
}

/**
 * 穿过原点的最小二乘：exposure = Σ(x·y) / Σ(x²)
 * x 为模型预测涨跌，y 为实际净值涨跌。
 * 样本不足 3 个或分母为 0 时返回默认值——宁可保守，不拿一个噪声拟合去改模型。
 */
export function fitExposure(modelPcts: number[], actualPcts: number[]): number {
  const n = Math.min(modelPcts.length, actualPcts.length)
  if (n < 3) return DEFAULT_EXPOSURE
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    const x = modelPcts[i]!
    num += x * actualPcts[i]!
    den += x * x
  }
  if (den === 0) return DEFAULT_EXPOSURE
  const e = num / den
  // 合理区间护栏：超过 [0.5, 1.2] 说明数据有问题，不采信
  return e >= 0.5 && e <= 1.2 ? e : DEFAULT_EXPOSURE
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/engine/calibrate.test.ts`
Expected: PASS 5 passed

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(engine): 净值口径标定与仓位系数拟合"
```

---

### Task 14: 回测脚本（产出真实 MAE）

**Files:**
- Create: `scripts/backtest.ts`
- Test: 无单测（脚本产出可复核数字）

- [ ] **Step 1: 写完整回测脚本**

```ts
// scripts/backtest.ts
/**
 * walk-forward 回测：官方净值序列 vs 模型估算序列，算 MAE。
 * 用法：npx tsx scripts/backtest.ts 270042 012868 000834
 *
 * 同时输出 lag=0 与 lag=1 的误差，用来判断该基金的净值口径——
 * 这是「净值到底对应哪一天的行情」的数据证据，不靠猜。
 */
import { fetchPosition, resolveHoldingsFrom } from '../src/fund/holdings'
import { estimateNav } from '../src/engine/estimate'
import { fitExposure } from '../src/engine/calibrate'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const EM_HIS = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

async function fetchNavHistory(code: string, size = 90): Promise<Array<{ date: string; pct: number }>> {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=${code}` +
    `&pageIndex=1&pageSize=${size}&deviceid=1&plat=Android&product=EFund&version=1`
  const res = await fetch(url, { headers: { 'User-Agent': 'EMProjJijin/6.5.0 (iPhone; iOS 16.0)' } })
  const body = (await res.json()) as any
  return (body.Datas as Array<{ FSRQ: string; JZZZL: string }>)
    .map((d) => ({ date: d.FSRQ, pct: Number(d.JZZZL) }))
    .filter((d) => Number.isFinite(d.pct))
    .reverse() // 接口按日期倒序返回，回测要正序
}

/** 东财美股日线，klines 每行格式为 "日期,开,收,涨跌幅"（f51,f52,f53,f59 实测确认） */
async function fetchDailyPcts(symbol: string, days = 120): Promise<Map<string, number>> {
  const beg = ymd(Date.now() - days * 86_400_000)
  const url =
    `${EM_HIS}?secid=105.${symbol}&klt=101&fqt=1&beg=${beg}&end=20500101` +
    `&fields1=f1,f2,f3&fields2=f51,f53,f59`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  const body = (await res.json()) as any
  const map = new Map<string, number>()
  for (const line of body?.data?.klines ?? []) {
    const parts = String(line).split(',')
    const date = parts[0]
    const pct = Number(parts[3])
    if (date && Number.isFinite(pct)) map.set(date, pct)
  }
  return map
}

interface Row { date: string; actual: number; model: number }

async function backtestOne(code: string): Promise<void> {
  const nav = await fetchNavHistory(code)
  const resolved = await resolveHoldingsFrom(code, fetchPosition)
  if (resolved.holdings.length === 0) {
    console.log(`${code}: 无持仓数据，跳过`)
    return
  }

  const hist = await Promise.all(resolved.holdings.map((h) => fetchDailyPcts(h.symbol)))
  const rows: Row[] = []
  for (const d of nav) {
    const pcts = hist.map((m) => m.get(d.date))
    if (pcts.some((p) => p === undefined)) continue
    const model = estimateNav({
      holdings: resolved.holdings.map((h, i) => ({ ...h, pct: pcts[i]! })),
      fxNow: 1, fxPrev: 1, exposure: 1,     // 汇率单独成项，回测先隔离掉以纯看持仓解释力
    }).navPct
    rows.push({ date: d.date, actual: d.pct, model })
  }

  if (rows.length < 10) {
    console.log(`${code}: 可对齐样本仅 ${rows.length} 天，不足以回测`)
    return
  }

  const model = rows.map((r) => r.model)
  const actual = rows.map((r) => r.actual)
  const exposure = fitExposure(model, actual)

  const errOf = (lag: number): { mae: number; max: number; n: number } => {
    const errs: number[] = []
    for (let i = lag; i < rows.length; i++) {
      errs.push(Math.abs(rows[i]!.model * exposure - rows[i - lag]!.actual))
    }
    return {
      mae: errs.reduce((s, e) => s + e, 0) / errs.length,
      max: Math.max(...errs),
      n: errs.length,
    }
  }
  const l0 = errOf(0)
  const l1 = errOf(1)

  const best = l0.mae <= l1.mae ? 0 : 1
  console.log(
    `${code}: 样本${rows.length}天 持仓${resolved.holdings.length}只 exposure=${exposure.toFixed(3)} | ` +
      `lag0 MAE=${l0.mae.toFixed(4)}pp max=${l0.max.toFixed(4)} | ` +
      `lag1 MAE=${l1.mae.toFixed(4)}pp max=${l1.max.toFixed(4)} | 判定 lag=${best}`,
  )
}

async function main(): Promise<void> {
  const codes = process.argv.slice(2)
  if (codes.length === 0) {
    console.error('用法: npx tsx scripts/backtest.ts <基金代码...>')
    process.exit(1)
  }
  for (const code of codes) {
    try {
      await backtestOne(code)
    } catch (e) {
      console.log(`${code}: 失败 — ${(e as Error).message}`)
    }
  }
}

main()
```

- [ ] **Step 2: 跑通并观察真实数字**

Run: `npx tsx scripts/backtest.ts 270042 012868`
Expected: 两行输出。270042（指数型）lag0 或 lag1 的 MAE 应在 0.05~0.2pp 量级（验收线 < 0.15pp）；012868（主动型，只有前十大）明显更差。**若 MAE 大于 1pp，说明权重单位或放大倍数错了，先查 `JZBL` 是否已按 /100 转成小数。**

- [ ] **Step 3: 记录判定结果**

把每只基金的 `exposure`、最优 lag、MAE 抄进设计文档第 3.6 节的下方，作为标定基准。lag 的判定值直接写入 `fund.lag_days` 初值。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat(scripts): walk-forward 回测，输出 lag 判定与 MAE"
```

---

## Phase M3 · 看得见

### Task 15: HTTP 路由

**Files:**
- Create: `src/routes/funds.ts`, `src/server.ts`
- Test: `tests/routes/funds.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/routes/funds.test.ts
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerFundRoutes } from '../../src/routes/funds'
import { openDb } from '../../src/store/db'

describe('funds 路由', () => {
  it('新增基金后能列出', async () => {
    const db = openDb(':memory:')
    const app = Fastify()
    registerFundRoutes(app, db)
    const res = await app.inject({
      method: 'POST', url: '/api/funds',
      payload: { code: '270042', marketValue: 47932.65, profit: 12646.36 },
    })
    expect(res.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/funds' })
    expect(JSON.parse(list.body).funds).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/routes/funds.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/store/queries.ts`（节选，仅本任务需要的）**

```ts
import type { Db } from './db'

export interface FundRow {
  id: number; code: string; name: string; kind: string
  target_etf_code: string | null; index_key: string | null
  shares: number; cost_basis: number; exposure: number; lag_days: number
}

export function insertFund(
  db: Db,
  input: { code: string; name?: string; shares: number; costBasis: number; exposure?: number; lagDays?: number },
): FundRow {
  db.prepare(
    `insert into fund (code, name, shares, cost_basis, exposure, lag_days)
     values (?,?,?,?,?,?)
     on conflict(code) do update set shares=excluded.shares, cost_basis=excluded.cost_basis`,
  ).run(input.code, input.name ?? '', input.shares, input.costBasis, input.exposure ?? 0.95, input.lagDays ?? 1)
  return db.prepare('select * from fund where code = ?').get(input.code) as unknown as FundRow
}

export function listFunds(db: Db): FundRow[] {
  return db.prepare('select * from fund order by id').all() as unknown as FundRow[]
}

export function upsertNav(db: Db, code: string, date: string, nav: number, pct: number): void {
  db.prepare(
    `insert into nav_history (fund_code, nav_date, nav, pct) values (?,?,?,?)
     on conflict(fund_code, nav_date) do update set nav=excluded.nav, pct=excluded.pct`,
  ).run(code, date, nav, pct)
}

export function getNavHistory(db: Db, code: string, limit = 90): Array<{ nav_date: string; pct: number }> {
  return db.prepare(
    'select nav_date, pct from nav_history where fund_code = ? order by nav_date desc limit ?',
  ).all(code, limit) as any
}
```

- [ ] **Step 4: 实现 `src/routes/funds.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../store/db'
import { insertFund, listFunds } from '../store/queries'
import { fetchPosition, resolveHoldingsFrom } from '../fund/holdings'

interface AddBody { code: string; marketValue: number; profit?: number; shares?: number; costBasis?: number }

export function registerFundRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/funds', async () => ({ funds: listFunds(db) }))

  app.post<{ Body: AddBody }>('/api/funds', async (req, reply) => {
    const { code, marketValue, profit = 0, shares, costBasis } = req.body
    if (!code) return reply.code(400).send({ error: 'code required' })

    // 未直接给份额时，用「市值 + 持有收益」反推，避免用户填长表单
    const resolved = await resolveHoldingsFrom(code, fetchPosition).catch(() => ({ holdings: [] as any[], viaEtf: null, asOf: '' }))
    const nav = await latestNav(code)
    const s = shares ?? (nav > 0 ? marketValue / nav : 0)
    const c = costBasis ?? Math.max(0, marketValue - profit)

    const fund = insertFund(db, { code, shares: s, costBasis: c })
    return { fund, holdings: resolved.holdings.length, viaEtf: resolved.viaEtf }
  })

  app.delete<{ Params: { id: string } }>('/api/funds/:id', async (req) => {
    db.prepare('delete from fund where id = ?').run(Number(req.params.id))
    return { ok: true }
  })
}

async function latestNav(code: string): Promise<number> {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=1` +
    `&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1&Fcodes=${code}`
  try {
    const res = await fetch(url)
    const body = (await res.json()) as any
    return Number(body?.Datas?.[0]?.NAV ?? 0)
  } catch {
    return 0
  }
}
```

- [ ] **Step 5: 实现 `src/server.ts` 装配**

```ts
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { openDb } from './store/db'
import { registerFundRoutes } from './routes/funds'

const db = openDb('data/app.db')
const app = Fastify({ logger: true })

await app.register(fastifyStatic, {
  root: fileURLToPath(new URL('../dist', import.meta.url)),
  wildcard: false,
})

registerFundRoutes(app, db)

app.get('/api/health', async () => ({ ok: true }))

await app.listen({ port: Number(process.env.PORT ?? 5178), host: '0.0.0.0' })
console.log('listening on http://127.0.0.1:5178')
```

- [ ] **Step 6: 运行测试并起服务验证**

Run: `pnpm vitest run tests/routes/funds.test.ts && pnpm dev`
Expected: 测试 PASS；服务打印 `listening on http://127.0.0.1:5178`；`curl -s localhost:5178/api/health` 返回 `{"ok":true}`

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat(routes): funds 路由与 server 装配"
```

---

### Task 16: 估算编排与估值路由

> 这个任务是整条链路真正通电的地方：把「持仓权重 + 实时行情 + 汇率 + 相位」串成一次估值。漏了它，前面所有零件都只是零件。

**Files:**
- Create: `src/sources/fx.ts`, `src/engine/pipeline.ts`, `src/routes/estimate.ts`
- Test: `tests/engine/pipeline.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/engine/pipeline.test.ts
import { describe, it, expect } from 'vitest'
import { buildEstimate } from '../../src/engine/pipeline'
import type { Quote } from '../../src/types'

const holdings = [
  { symbol: 'AAPL', name: '苹果', weight: 0.6 },
  { symbol: 'MSFT', name: '微软', weight: 0.4 },
]
const quotes = new Map<string, Quote>([
  ['AAPL', { symbol: 'AAPL', price: 110, prevClose: 100, pct: 10, tsMs: Date.now(), precision: 2, sourceId: 't' }],
  ['MSFT', { symbol: 'MSFT', price: 100, prevClose: 100, pct: 0, tsMs: Date.now(), precision: 2, sourceId: 't' }],
])

describe('buildEstimate', () => {
  it('把行情接到权重上算出净值涨跌与金额', () => {
    const r = buildEstimate({
      code: '270042', name: '广发纳指', shares: 1000, costBasis: 5000,
      nav: 7.37, holdings, quotes, fxNow: 7, fxPrev: 7,
      exposure: 1, lagDays: 1, phase: 'live',
    })
    expect(r.navPct).toBeCloseTo(6, 6)          // 0.6*10 + 0.4*0
    expect(r.marketValue).toBeCloseTo(1000 * 7.37 * 1.06, 2)
    expect(r.amount).toBeCloseTo(1000 * 7.37 * 0.06, 2)
  })

  it('缺行情的股票被剔除，覆盖率如实反映', () => {
    const partial = new Map(quotes)
    partial.delete('MSFT')
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 1, costBasis: 1, nav: 1,
      holdings, quotes: partial, fxNow: 7, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
    })
    expect(r.coveredWeight).toBeCloseTo(0.6, 6)
    expect(r.navPct).toBeCloseTo(6, 6)          // 0.6 覆盖部分全涨 10% → 归一后 10%，未覆盖按 0 → 6
  })

  it('汇率升值时金额被抵消', () => {
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 1000, costBasis: 1, nav: 1,
      holdings: [{ symbol: 'AAPL', name: 'A', weight: 1 }], quotes,
      fxNow: 6.86, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
    })
    expect(r.navPct).toBeCloseTo((1.1 * 0.98 - 1) * 100, 4)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/engine/pipeline.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/sources/fx.ts`**

```ts
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export interface FxRate { pair: string; rate: number; prevClose: number; tsMs: number; sourceId: string }

/** 东财离岸人民币：f43/f60 放大 10000 倍（实测 66710 → 6.6710） */
export async function fetchUsdCny(): Promise<FxRate> {
  const url = 'https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43,f60,f86'
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`fx http ${res.status}`)
  const d = ((await res.json()) as any)?.data
  if (!d?.f43) throw new Error('fx empty')
  return {
    pair: 'USDCNY',
    rate: d.f43 / 10000,
    prevClose: d.f60 / 10000,
    tsMs: (d.f86 ?? 0) * 1000 || Date.now(),
    sourceId: 'eastmoney',
  }
}

/** 新浪在岸人民币兜底：字段 1 为现价，字段 8 为昨收（实测报文） */
export async function fetchUsdCnyFallback(): Promise<FxRate> {
  const res = await fetch('https://hq.sinajs.cn/list=fx_susdcny', {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
  })
  if (!res.ok) throw new Error(`fx fallback http ${res.status}`)
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
  const f = text.split('"')[1]?.split(',') ?? []
  const rate = Number(f[1])
  const prevClose = Number(f[8] ?? f[1])
  if (!Number.isFinite(rate)) throw new Error('fx fallback parse failed')
  return { pair: 'USDCNY', rate, prevClose, tsMs: Date.now(), sourceId: 'sina' }
}
```

- [ ] **Step 4: 实现 `src/engine/pipeline.ts`**

```ts
import type { Holding, Phase, Quote } from '../types'
import { estimateNav } from './estimate'

export interface BuildInput {
  code: string
  name: string
  shares: number
  costBasis: number
  nav: number                 // 最新官方净值
  holdings: Holding[]
  quotes: Map<string, Quote>
  fxNow: number
  fxPrev: number
  exposure: number
  lagDays: number
  phase: Phase
  residualPct?: number
}

export interface FundEstimate {
  code: string
  name: string
  phase: Phase
  navPct: number
  nav: number
  shares: number
  costBasis: number
  marketValue: number
  amount: number              // 当日估算收益（元）
  holdingProfit: number       // 累计持有收益（元）
  coveredWeight: number
  missing: string[]
  breakdown: Array<{ symbol: string; weight: number; pct: number; contribution: number }>
}

/** 纯函数：不做 IO，便于单测。行情缺失的股票剔除并计入 missing，覆盖率如实上报。 */
export function buildEstimate(input: BuildInput): FundEstimate {
  const { holdings, quotes } = input
  const available = holdings.filter((h) => quotes.has(h.symbol))
  const missing = holdings.filter((h) => !quotes.has(h.symbol)).map((h) => h.symbol)

  const result = estimateNav({
    holdings: available.map((h) => ({ ...h, pct: quotes.get(h.symbol)!.pct })),
    fxNow: input.fxNow,
    fxPrev: input.fxPrev,
    exposure: input.exposure,
    residualPct: input.residualPct,
  })

  const base = input.shares * input.nav
  const marketValue = base * (1 + result.navPct / 100)
  return {
    code: input.code,
    name: input.name,
    phase: input.phase,
    navPct: result.navPct,
    nav: input.nav,
    shares: input.shares,
    costBasis: input.costBasis,
    marketValue,
    amount: base * (result.navPct / 100),
    holdingProfit: marketValue - input.costBasis,
    coveredWeight: result.coveredWeight,
    missing,
    breakdown: result.breakdown,
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/engine/pipeline.test.ts`
Expected: PASS 3 passed

- [ ] **Step 6: 实现 `src/routes/estimate.ts`（带缓存的编排层）**

```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../store/db'
import type { QuoteRegistry } from '../sources/registry'
import type { MarketStatus } from '../types'
import { buildEstimate, type FundEstimate } from '../engine/pipeline'
import { derivePhase } from '../engine/phase'
import { resolveHoldingsFrom, fetchPosition } from '../fund/holdings'
import { fetchUsdCny, fetchUsdCnyFallback } from '../sources/fx'
import { listFunds } from '../store/queries'

interface Ctx {
  db: Db
  registry: QuoteRegistry
  status: () => Promise<MarketStatus>
}

export function registerEstimateRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/estimate', async (): Promise<{ funds: FundEstimate[] }> => {
    const funds = listFunds(ctx.db)
    if (funds.length === 0) return { funds: [] }

    const status = await ctx.status().catch(() => 'CLOSED' as MarketStatus)
    const phase = derivePhase(status)

    const fx = await fetchUsdCny().catch(() => fetchUsdCnyFallback())

    // 收集全部成分股，一次批量取价
    const perFund = await Promise.all(
      funds.map(async (f) => ({
        fund: f,
        resolved: await resolveHoldingsFrom(f.code, fetchPosition).catch(() => ({ holdings: [], viaEtf: null, asOf: '' })),
      })),
    )
    const symbols = [...new Set(perFund.flatMap((p) => p.resolved.holdings.map((h) => h.symbol)))]
    const quotes = await ctx.registry.getQuotes(symbols, { crossCheck: false })

    const estimates = perFund.map(({ fund, resolved }) =>
      buildEstimate({
        code: fund.code,
        name: fund.name || fund.code,
        shares: fund.shares,
        costBasis: fund.cost_basis,
        nav: latestNavOf(ctx.db, fund.code),
        holdings: resolved.holdings,
        quotes,
        fxNow: fx.rate,
        fxPrev: fx.prevClose,
        exposure: fund.exposure,
        lagDays: fund.lag_days,
        phase,
      }),
    )
    return { funds: estimates }
  })
}

function latestNavOf(db: Db, code: string): number {
  const row = db
    .prepare('select nav from nav_history where fund_code = ? order by nav_date desc limit 1')
    .get(code) as { nav: number } | undefined
  return row?.nav ?? 0
}
```

- [ ] **Step 7: 在 `src/server.ts` 追加注册（放在 `registerFundRoutes` 之后）**

```ts
import { QuoteRegistry } from './sources/registry'
import { EastmoneySource } from './sources/eastmoney'
import { TencentSource } from './sources/tencent'
import { CnbcSource } from './sources/cnbc'
import { SinaSource } from './sources/sina'
import { registerEstimateRoutes } from './routes/estimate'

const cnbc = new CnbcSource()
const registry = new QuoteRegistry([
  new EastmoneySource(),
  new TencentSource(),
  cnbc,
  new SinaSource(),
])

registerEstimateRoutes(app, {
  db,
  registry,
  status: async () => (await cnbc.fetchMarketStatus()).status,
})
```

- [ ] **Step 8: 真实数据端到端验证**

```bash
curl -s -X POST localhost:5178/api/funds -H 'content-type: application/json' \
  -d '{"code":"270042","marketValue":47932.65,"profit":12646.36}'
curl -s localhost:5178/api/estimate
```
Expected: 返回含 `navPct`、`amount`、`coveredWeight`、`breakdown` 的 JSON，`navPct` 与东财页面当日估值同量级（个位数百分比），`coveredWeight` ≈ 0.6~0.7（前十大口径）

- [ ] **Step 9: 提交**

```bash
git add -A && git commit -m "feat(engine): 估算编排、汇率与估值路由"
```

---

### Task 17: Web 界面（暗色玻璃拟态）

**Files:**
- Create: `web/index.html`, `web/main.tsx`, `web/App.tsx`, `web/styles.css`, `vite.config.ts`

- [ ] **Step 1: 写 `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:5178' } },
})
```

- [ ] **Step 2: 写 `web/index.html` 与 `web/main.tsx`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>美股基金估值</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
```

- [ ] **Step 3: 写 `web/App.tsx`（接真实估值，不放假数据）**

```tsx
import { useEffect, useState } from 'react'

interface Breakdown { symbol: string; weight: number; pct: number; contribution: number }
interface FundEstimate {
  code: string
  name: string
  phase: 'live' | 'settled'
  navPct: number
  marketValue: number
  amount: number
  holdingProfit: number
  coveredWeight: number
  missing: string[]
  breakdown: Breakdown[]
}

const fmt = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const cls = (n: number) => (n >= 0 ? 'up' : 'down')

export default function App() {
  const [funds, setFunds] = useState<FundEstimate[]>([])
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetch('/api/estimate')
        .then((r) => r.json())
        .then((d) => { if (alive) setFunds(d.funds ?? []) })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const totalValue = funds.reduce((s, f) => s + f.marketValue, 0)
  const totalAmount = funds.reduce((s, f) => s + f.amount, 0)
  const phase = funds[0]?.phase ?? 'settled'

  return (
    <div className="page">
      <header className="glass card summary">
        <div className="label">账户资产</div>
        <div className="amount">{fmt(totalValue)}</div>
        <div className="delta">
          今日估算 <span className={cls(totalAmount)}>{totalAmount >= 0 ? '+' : ''}{fmt(totalAmount)}</span>
        </div>
        <div className="phase">{phase === 'live' ? '盘中 · 5 秒刷新' : '美股已收盘 · 待公布净值'}</div>
      </header>

      <section className="glass card list">
        {funds.length === 0 && <div className="empty">还没有基金，先录入一只</div>}
        {funds.map((f) => (
          <div key={f.code}>
            <div className="row" onClick={() => setOpen(open === f.code ? null : f.code)}>
              <div>
                <div className="name">{f.name}</div>
                <div className="meta">
                  {f.code} · 市值 {fmt(f.marketValue)} · 覆盖 {(f.coveredWeight * 100).toFixed(0)}%
                  {f.missing.length > 0 && ` · 缺 ${f.missing.length} 只行情`}
                </div>
              </div>
              <div className="right">
                <div className={cls(f.amount)}>{f.amount >= 0 ? '+' : ''}{fmt(f.amount)}</div>
                <div className={cls(f.navPct) + ' small'}>{pct(f.navPct)}</div>
              </div>
            </div>
            {open === f.code && (
              <div className="breakdown">
                {f.breakdown.map((b) => (
                  <div className="brow" key={b.symbol}>
                    <span>{b.symbol}</span>
                    <span className="muted">{(b.weight * 100).toFixed(2)}%</span>
                    <span className={cls(b.pct)}>{pct(b.pct)}</span>
                    <span className={cls(b.contribution)}>{b.contribution.toFixed(3)}pp</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}
```

- [ ] **Step 4: 写 `web/styles.css`（暗色玻璃拟态）**

```css
:root {
  --bg: #070b14;
  --glass: rgba(28, 36, 56, 0.55);
  --stroke: rgba(255, 255, 255, 0.08);
  --up: #ff4d4f;
  --down: #22c55e;
  --text: #e8edf7;
  --muted: #8892a6;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(900px 500px at 15% -10%, rgba(64, 120, 255, 0.22), transparent 60%),
    radial-gradient(700px 420px at 90% 0%, rgba(120, 64, 255, 0.16), transparent 55%),
    var(--bg);
  color: var(--text);
  font: 15px/1.5 -apple-system, "PingFang SC", system-ui, sans-serif;
}
.page { max-width: 560px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 14px; }
.glass {
  background: var(--glass);
  border: 1px solid var(--stroke);
  border-radius: 20px;
  backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
}
.card { padding: 18px 20px; }
.summary .label { color: var(--muted); font-size: 13px; }
.summary .amount {
  font-size: 34px; font-weight: 650; letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
}
.summary .delta { margin-top: 4px; font-size: 14px; }
.summary .phase { color: var(--muted); font-size: 12px; margin-top: 6px; }
.list { padding: 6px 8px; }
.row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 12px; border-bottom: 1px solid var(--stroke); cursor: pointer;
}
.row:hover { background: rgba(255, 255, 255, 0.03); }
.row:last-child { border-bottom: none; }
.row .name { font-weight: 550; }
.row .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
.row .right { text-align: right; font-variant-numeric: tabular-nums; }
.row .right .small { font-size: 12px; }
.up { color: var(--up); }
.down { color: var(--down); }
.muted { color: var(--muted); }
.breakdown { padding: 8px 12px 14px; background: rgba(0, 0, 0, 0.18); border-radius: 0 0 14px 14px; }
.brow {
  display: grid; grid-template-columns: 1fr 70px 70px 70px;
  gap: 6px; font-size: 12px; padding: 5px 0; font-variant-numeric: tabular-nums;
}
.brow span:not(:first-child) { text-align: right; }
.empty { color: var(--muted); text-align: center; padding: 32px 0; font-size: 13px; }
```

- [ ] **Step 5: 启动验证界面可打开**

Run: `pnpm dev &` 然后 `pnpm dev:web`
Expected: Vite 打印本地地址；打开后深色页面。若已录入基金，能看到账户汇总、列表、点开展开持仓明细与每只股票贡献（`pp` 单位）。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(web): 暗色玻璃拟态界面接入真实估值"
```

---

### Task 18: 实现前必须验证的三件事（探测脚本）

**Files:**
- Create: `scripts/probe.ts`

- [ ] **Step 1: 写探测脚本**

```ts
// scripts/probe.ts
/**
 * 设计文档第 7 节三项验证，一次性跑完并打印结论。
 * 用法：npx tsx scripts/probe.ts
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'

async function probeSp500() {
  const tries: Array<[string, string]> = [
    ['nasdaq list-type', 'https://api.nasdaq.com/api/quote/list-type/sp500'],
    ['nasdaq screener', 'https://api.nasdaq.com/api/screener/stocks?exchange=NYSE&limit=500'],
    ['ishares IVV csv', 'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax?fileType=csv&dataType=fund'],
  ]
  for (const [name, url] of tries) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      const text = await res.text()
      console.log(`[sp500] ${name}: ${res.status} len=${text.length} head=${text.slice(0, 80).replace(/\n/g, ' ')}`)
    } catch (e) {
      console.log(`[sp500] ${name}: FAIL ${(e as Error).message}`)
    }
  }
}

async function probeDailyKline() {
  const tries: Array<[string, string]> = [
    ['eastmoney kline', 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=105.AAPL&klt=101&fqt=1&beg=20260801&end=20500101&fields1=f1,f2&fields2=f51,f53'],
    ['tencent kline', 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=usAAPL,day,,,60,qfq'],
  ]
  for (const [name, url] of tries) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      const text = await res.text()
      console.log(`[kline] ${name}: ${res.status} len=${text.length} head=${text.slice(0, 120).replace(/\n/g, ' ')}`)
    } catch (e) {
      console.log(`[kline] ${name}: FAIL ${(e as Error).message}`)
    }
  }
}

async function probeFx() {
  try {
    const res = await fetch('https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43,f60', {
      headers: { 'User-Agent': UA },
    })
    console.log('[fx] eastmoney USDCNH:', res.status, await res.text())
  } catch (e) {
    console.log('[fx] FAIL', (e as Error).message)
  }
}

await probeSp500()
await probeDailyKline()
await probeFx()
```

- [ ] **Step 2: 跑探测并按结论落配置**

Run: `npx tsx scripts/probe.ts`
Expected: 每项打印状态码与报文头。按输出决定：
- sp500 全量：若 ishares CSV 可用 → 在 `INDEX_ENDPOINT` 增加 `sp500` 条目；全部失败 → 该类基金只算前十大，`coveredWeight` 如实显示。
- 日线：若 eastmoney kline 可用 → 回测用东财；否则用腾讯；两者都挂 → 只做前向标定。
- 汇率：确认 USDCNY 的 secid 与字段。

- [ ] **Step 3: 把结论写回设计文档第 7 节**

用编辑方式更新三项的最终结论与所选源，不留「待定」。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat(scripts): 源探测脚本与结论落定"
```

---

### Task 19: 净值抓取与残差入账

**Files:**
- Create: `src/sync/nav.ts`, `src/sync/quotes.ts`
- Test: `tests/sync/nav.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/sync/nav.test.ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/store/db'
import { recordResidual } from '../../src/sync/nav'

describe('nav sync', () => {
  it('残差 = 模型 - 实际，同一净值日重复入账被覆盖而非堆积', () => {
    const db = openDb(':memory:')
    recordResidual(db, { fundCode: '270042', navDate: '2026-11-06', modelPct: 1.4, actualPct: 1.36 })
    recordResidual(db, { fundCode: '270042', navDate: '2026-11-06', modelPct: 1.5, actualPct: 1.36 })
    const rows = db.prepare('select * from residual').all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].diff).toBeCloseTo(0.14, 2)
  })

  it('净值序列能算近 20 日 MAE', () => {
    const db = openDb(':memory:')
    for (let i = 0; i < 20; i++) {
      recordResidual(db, { fundCode: 'X', navDate: `2026-10-${String(i + 1).padStart(2, '0')}`, modelPct: 1, actualPct: 1 - i * 0.01 })
    }
    const mae = meanAbsDiff(db, 'X', 20)
    expect(mae).toBeCloseTo(0.095, 3)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sync/nav.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/sync/nav.ts`**

```ts
import type { Db } from '../store/db'

export function recordResidual(
  db: Db,
  r: { fundCode: string; navDate: string; modelPct: number; actualPct: number },
): void {
  db.prepare(
    `insert into residual (fund_code, nav_date, model_pct, actual_pct, diff, nav_ts)
     values (?,?,?,?,?,?)
     on conflict(fund_code, nav_date) do update set
       model_pct=excluded.model_pct, actual_pct=excluded.actual_pct,
       diff=excluded.diff, nav_ts=excluded.nav_ts`,
  ).run(r.fundCode, r.navDate, r.modelPct, r.actualPct, r.modelPct - r.actualPct, Date.now())
}

export function meanAbsDiff(db: Db, fundCode: string, window = 20): number {
  const rows = db
    .prepare('select diff from residual where fund_code = ? order by nav_date desc limit ?')
    .all(fundCode, window) as Array<{ diff: number }>
  if (rows.length === 0) return 0
  return rows.reduce((s, r) => s + Math.abs(r.diff), 0) / rows.length
}

/** 拉取官方净值序列，新值写库，返回新增条数 */
export async function syncNavHistory(db: Db, code: string, size = 90): Promise<number> {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=${code}` +
    `&pageIndex=1&pageSize=${size}&deviceid=1&plat=Android&product=EFund&version=1`
  const res = await fetch(url, { headers: { 'User-Agent': 'EMProjJijin/6.5.0 (iPhone; iOS 16.0)' } })
  if (!res.ok) throw new Error(`nav http ${res.status}`)
  const body = (await res.json()) as any
  const list = (body.Datas ?? []) as Array<{ FSRQ: string; DWJZ: string; JZZZL: string }>
  let added = 0
  for (const d of list) {
    const nav = Number(d.DWJZ)
    const pct = Number(d.JZZZL)
    if (!d.FSRQ || !Number.isFinite(nav) || !Number.isFinite(pct)) continue
    db.prepare(
      `insert into nav_history (fund_code, nav_date, nav, pct) values (?,?,?,?)
       on conflict(fund_code, nav_date) do nothing`,
    ).run(code, d.FSRQ, nav, pct)
    added++
  }
  return added
}
```

- [ ] **Step 4: 补上「净值公布 → 找对应估算 → 写残差」的闭环**

这是整个校准链真正闭合的一步。加到 `src/sync/nav.ts`：

```ts
/**
 * 对某只基金：取最新净值日，在 estimate_log 里找该日最近的一条估算，
 * 落一条残差。同一净值日重复调用由 unique 约束覆盖，不会堆积。
 */
export function reconcile(db: Db, fundCode: string): { navDate: string; modelPct: number; actualPct: number } | null {
  const nav = db
    .prepare('select nav_date, pct from nav_history where fund_code = ? order by nav_date desc limit 1')
    .get(fundCode) as { nav_date: string; pct: number } | undefined
  if (!nav) return null

  // estimate_log.model_ts 是毫秒时间戳，取该净值日当天及之后最早的一条
  const dayStart = Date.parse(`${nav.nav_date}T00:00:00+08:00`)
  const est = db
    .prepare(
      `select model_pct from estimate_log where fund_code = ? and model_ts >= ?
       order by model_ts asc limit 1`,
    )
    .get(fundCode, dayStart) as { model_pct: number } | undefined
  if (!est) return null

  recordResidual(db, {
    fundCode,
    navDate: nav.nav_date,
    modelPct: est.model_pct,
    actualPct: nav.pct,
  })
  return { navDate: nav.nav_date, modelPct: est.model_pct, actualPct: nav.pct }
}
```

同步补一条测试到 `tests/sync/nav.test.ts`：

```ts
it('净值与估值能对上账，算出残差', async () => {
  const db = openDb(':memory:')
  db.prepare('insert into nav_history (fund_code, nav_date, nav, pct) values (?,?,?,?)')
    .run('270042', '2026-11-06', 7.3714, 1.36)
  db.prepare(
    'insert into estimate_log (fund_code, model_ts, phase, model_pct, model_amount, covered_weight, constituents_json, lag_days, exposure) values (?,?,?,?,?,?,?,?,?)',
  ).run('270042', Date.parse('2026-11-06T20:00:00+08:00'), 'settled', 1.41, 0, 0.66, '[]', 1, 0.95)

  const r = reconcile(db, '270042')
  expect(r?.modelPct).toBeCloseTo(1.41, 2)
  const mae = meanAbsDiff(db, '270042', 20)
  expect(mae).toBeCloseTo(0.05, 2)
})
```

> 注意 `import { reconcile }` 要加进测试文件的 import 行。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/sync/nav.test.ts`
Expected: PASS 3 passed

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(sync): 净值抓取、残差入账与对账闭环"
```

---

## 验收清单

全部任务完成后逐条核对，每条都要有可复核的输出：

- [ ] `pnpm test` 全绿，`pnpm typecheck` 零错误
- [ ] `npx tsx scripts/backtest.ts 270042` 输出 MAE < 0.15pp
- [ ] `npx tsx scripts/probe.ts` 三项均有明确结论，且已写回设计文档第 7 节
- [ ] 界面上能录入一只基金，看到实时估算金额与百分比
- [ ] 点开某只基金能看到持仓明细与每只股票的贡献
- [ ] 相位标签在美股收盘后变成「待公布」，且数值冻结不再跳动
- [ ] 净值公布后 `residual` 表出现新行，「模型今日偏差」有值

## 已知未覆盖（明确不做）

- 主动型 QDII 的全量持仓（法规不披露，只能前十大 + 指数代理）
- 标普 500 等权重、纳指科技（NDXT）的独立权重源，取决于 Task 18 探测结果
- 币圈行情（用户确认：要的是币圈级数据质量，不是币圈资产）
- 多用户、鉴权、公网部署
