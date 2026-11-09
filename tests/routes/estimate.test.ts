import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerEstimateRoutes, boardOf, type EstimateDeps } from '../../src/routes/estimate'
import { openDb, type Db } from '../../src/store/db'
import { insertFund } from '../../src/store/queries'
import type { QuoteRegistry } from '../../src/sources/registry'
import type { Holding, Quote } from '../../src/types'
import type { MarketIndex } from '../../src/sources/marketIndices'

const INDICES: MarketIndex[] = [
  { symbol: '000001', name: '上证指数', value: 3660.79, change: 11.61, pct: 0.32 },
  { symbol: 'NDX', name: '纳斯达克', value: 25212.08, change: 632.66, pct: 2.57 },
]

const quote = (symbol: string): Quote => ({
  symbol,
  price: 100,
  prevClose: 97.7,
  pct: 2.3,
  tsMs: 1_700_000_000_000,
  precision: 2,
  sourceId: 'stub',
})

/** 桩注册表：只给 quoted 里的符号出行情，其余缺口留给 buildEstimate 记 missing */
function registryStub(quoted: string[]): QuoteRegistry {
  return {
    getQuotes: async (symbols: string[]) =>
      new Map(symbols.filter((s) => quoted.includes(s)).map((s) => [s, quote(s)])),
  } as unknown as QuoteRegistry
}

const HOLDINGS: Record<string, Holding[]> = {
  // 270042：纳指联接，另有 1 只港股（取价前就该被剔除）
  '270042': [
    { symbol: 'AAPL', name: '苹果', weight: 0.5, market: 105 },
    { symbol: '00700', name: '腾讯控股', weight: 0.1, market: 116 },
  ],
  // 161125：标普500
  '161125': [{ symbol: 'AAPL', name: '苹果', weight: 0.4, market: 105 }],
  // 000001：没配跟踪指数，且行情一只都取不到 → 覆盖率 0
  '000001': [{ symbol: 'TSLA', name: '特斯拉', weight: 0.3, market: 105 }],
}

function makeApp(
  funds: Array<{ code: string; name: string; indexKey: string | null }>,
  overrides: Partial<EstimateDeps> = {},
  quoted: string[] = ['AAPL'],
): { db: Db; app: FastifyInstance } {
  const db = openDb(':memory:')
  for (const f of funds) {
    insertFund(db, { code: f.code, name: f.name, indexKey: f.indexKey, shares: 1000, costBasis: 5000 })
  }
  const app = Fastify()
  registerEstimateRoutes(
    app,
    {
      db,
      registry: registryStub(quoted),
      status: async () => 'REG_MKT',
      ensureMarkets: async () => {},
    },
    {
      resolveFx: async () => ({ pair: 'USDCNY', rate: 7.2, prevClose: 7.18, tsMs: 1, sourceId: 'stub' }),
      loadHoldings: async (fund) => ({
        holdings: HOLDINGS[fund.code] ?? [],
        weightsFrom: (HOLDINGS[fund.code]?.length ?? 0) > 0 ? 'index' : 'none',
      }),
      latestNav: async () => 7.3714,
      marketIndices: async () => INDICES,
      ...overrides,
    },
  )
  return { db, app }
}

async function get(app: FastifyInstance) {
  const res = await app.inject({ method: 'GET', url: '/api/estimate' })
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

beforeEach(() => {
  // 估算路由的每条腿都必须走注入：任何一条偷偷联网都直接炸掉
  vi.stubGlobal('fetch', () => {
    throw new Error('测试禁止联网：网络调用必须通过 deps 注入')
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('boardOf', () => {
  it('ndx / sp500 映射成给人看的板块名，其余一律 null', () => {
    expect(boardOf('ndx')).toBe('纳斯达克100')
    expect(boardOf('sp500')).toBe('标普500')
    expect(boardOf(null)).toBeNull()
    expect(boardOf('')).toBeNull()
    expect(boardOf('dow')).toBeNull()
  })
})

describe('GET /api/estimate · 关联板块', () => {
  it('index_key 映射成 board，未配置的基金 board 为 null', async () => {
    const { app } = makeApp([
      { code: '270042', name: '广发纳斯达克100ETF', indexKey: 'ndx' },
      { code: '161125', name: '易方达标普500', indexKey: 'sp500' },
      { code: '000001', name: '未配置指数的基金', indexKey: null },
    ])
    const { status, body } = await get(app)
    expect(status).toBe(200)
    const byCode = Object.fromEntries(body.funds.map((f: { code: string; board: string | null }) => [f.code, f.board]))
    expect(byCode).toEqual({
      '270042': '纳斯达克100',
      '161125': '标普500',
      '000001': null,
    })
  })

  it('港股仍在取价前剔除，并以 excluded.hk 如实上报（界面拿它说"已排除"）', async () => {
    const { app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }])
    const { body } = await get(app)
    expect(body.funds[0].excluded.hk).toBe(1)
  })

  it('行情一只都没拿到时 coveredWeight 为 0（界面据此显示"行情不可用 / 无覆盖"）', async () => {
    const { app } = makeApp([{ code: '000001', name: '无覆盖', indexKey: null }])
    const { body } = await get(app)
    expect(body.funds[0].coveredWeight).toBe(0)
    expect(body.funds[0].missing).toEqual(['TSLA'])
  })
})

describe('GET /api/estimate · marketIndices', () => {
  it('指数条随响应返回，且是缩放后的数', async () => {
    const { app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }])
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.marketIndices).toHaveLength(2)
    expect(body.marketIndices[1]).toMatchObject({ symbol: 'NDX', name: '纳斯达克', pct: 2.57 })
    expect(body.marketIndices[1].value).toBeCloseTo(25212.08, 2)
  })

  it('指数取不到时降级成空数组：HTTP 200，基金估值照常', async () => {
    const { app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }], {
      marketIndices: async () => {
        throw new Error('eastmoney down')
      },
    })
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.marketIndices).toEqual([])
    expect(body.funds).toHaveLength(1)
    expect(body.funds[0].navPct).toBeGreaterThan(0)
  })

  it('空仓时也返回指数条（底部行情条不是持仓的一部分）', async () => {
    const { app } = makeApp([])
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.funds).toEqual([])
    expect(body.marketIndices).toHaveLength(2)
  })
})

describe('GET /api/estimate · 组合快照落库与节流', () => {
  interface Snap {
    ts_ms: number
    total_value: number
    total_amount: number
    fund_count: number
  }
  const snaps = (db: Db): Snap[] =>
    db.prepare('select ts_ms, total_value, total_amount, fund_count from portfolio_snapshot order by ts_ms').all() as unknown as Snap[]

  it('一次估值落一行，值等于响应里的汇总（市值/收益/只数）', async () => {
    const { db, app } = makeApp([
      { code: '270042', name: '纳指', indexKey: 'ndx' },
      { code: '161125', name: '标普', indexKey: 'sp500' },
    ])
    const { body } = await get(app)
    const stored = snaps(db)
    expect(stored).toHaveLength(1)

    const value = body.funds.reduce((s: number, f: { marketValue: number }) => s + f.marketValue, 0)
    const amount = body.funds.reduce((s: number, f: { amount: number }) => s + f.amount, 0)
    expect(stored[0]!.total_value).toBeCloseTo(value, 6)
    expect(stored[0]!.total_amount).toBeCloseTo(amount, 6)
    expect(stored[0]!.fund_count).toBe(2)
  })

  it('30 秒内的重复估值只落一行（5 秒轮询不该写出 17k 行/天）', async () => {
    const { db, app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }])
    await get(app)
    await get(app)
    await get(app)
    expect(snaps(db)).toHaveLength(1)
  })

  it('最新一行老过 30 秒后重新落一行（真实跑会等 31s，这里把时间戳回拨）', async () => {
    const { db, app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }])
    await get(app)
    db.prepare('update portfolio_snapshot set ts_ms = ts_ms - 31000').run()
    await get(app)
    const stored = snaps(db)
    expect(stored).toHaveLength(2)
    expect(stored[1]!.ts_ms).toBeGreaterThan(stored[0]!.ts_ms)
  })

  it('空仓不落点：没有基金就没有总资产可言', async () => {
    const { db, app } = makeApp([])
    const { status } = await get(app)
    expect(status).toBe(200)
    expect(snaps(db)).toHaveLength(0)
  })

  it('写库失败不污染请求路径：快照表被删也照样 200 且有基金明细', async () => {
    const { db, app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }])
    db.exec('drop table portfolio_snapshot')
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.funds).toHaveLength(1)
    expect(body.funds[0].navPct).toBeGreaterThan(0)
  })
})
