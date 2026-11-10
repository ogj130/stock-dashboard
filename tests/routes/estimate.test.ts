import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerEstimateRoutes, boardOf, type EstimateDeps } from '../../src/routes/estimate'
import { openDb, type Db } from '../../src/store/db'
import { insertFund } from '../../src/store/queries'
import type { QuoteRegistry } from '../../src/sources/registry'
import type { AfterHoursQuote, Holding, MarketStatus, Quote } from '../../src/types'
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
  /** 交易所状态：默认盘中（live）；夜盘用例需要 CLOSED（settled） */
  status: MarketStatus = 'REG_MKT',
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
      status: async () => status,
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
    total_profit: number
    fund_count: number
  }
  const snaps = (db: Db): Snap[] =>
    db
      .prepare(
        'select ts_ms, total_value, total_amount, total_profit, fund_count from portfolio_snapshot order by ts_ms',
      )
      .all() as unknown as Snap[]

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
    const profit = body.funds.reduce(
      (s: number, f: { marketValue: number; costBasis: number }) => s + (f.marketValue - f.costBasis),
      0,
    )
    expect(stored[0]!.total_value).toBeCloseTo(value, 6)
    expect(stored[0]!.total_amount).toBeCloseTo(amount, 6)
    // 持有收益 = Σ(市值 − 成本)，与当日估算收益是两条独立的腿
    expect(stored[0]!.total_profit).toBeCloseTo(profit, 6)
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

/**
 * 夜盘（盘后）估值。三条必须钉死的边界：
 *   ① 只有 phase === 'settled' 才发请求、才出数；
 *   ② 覆盖率 < 0.3 时整块省掉（不是 0，也不是「—」）；
 *   ③ 这条腿怎么坏都不能影响收盘估值那条腿。
 */
describe('GET /api/estimate · 夜盘（afterHours）', () => {
  /** 两只美股，权重合计 0.9 —— 稳过 0.3 的门槛 */
  const NIGHT_HOLDINGS: Holding[] = [
    { symbol: 'AAPL', name: '苹果', weight: 0.5, market: 105 },
    { symbol: 'MSFT', name: '微软', weight: 0.4, market: 105 },
  ]
  /** 2026-11-09 19:59 EST */
  const AH_TS = Date.parse('2026-11-10T00:59:00Z')

  const quoteOf = (symbol: string, pct: number): [string, AfterHoursQuote] => [
    symbol,
    { symbol, price: 100, pct, tsMs: AH_TS },
  ]
  const allQuoted = (pct: number) => (symbols: string[]) =>
    Promise.resolve(new Map(symbols.map((s) => quoteOf(s, pct))))

  it('settled 且覆盖率 ≥ 0.3：多出第二组数字，收盘口径的 navPct 不被改动', async () => {
    const { app } = makeApp(
      [{ code: '270042', name: '纳指', indexKey: 'ndx' }],
      {
        loadHoldings: async () => ({ holdings: NIGHT_HOLDINGS, weightsFrom: 'index' }),
        afterHours: allQuoted(1),
      },
      ['AAPL', 'MSFT'],
      'CLOSED',
    )
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.phase).toBe('settled')

    const f = body.funds[0]
    // 收盘那条腿：这两只成分当日都是 +2.3%，权重 0.9 全覆盖 → 成分加权口径
    // （本文件 INDICES 的纳指 symbol 是 'NDX' 而非 'NDX100'，所以指数腿不生效）
    expect(f.navPct).toBeCloseTo(0.95 * ((1.023 * (7.2 / 7.18) - 1) * 100), 6)
    // 夜盘那条腿：0.95·((1.01)(7.2/7.18)−1)·100
    expect(f.afterHours).toBeDefined()
    expect(f.afterHours.coveredWeight).toBeCloseTo(0.9, 6)
    expect(f.afterHours.navPct).toBeCloseTo(1.2173, 3)
    expect(f.afterHours.amount).toBeCloseTo(89.73, 2)
    expect(f.afterHours.asOfMs).toBe(AH_TS)
    // 两条腿互不覆盖：夜盘不是把 navPct 改小
    expect(f.afterHours.navPct).not.toBeCloseTo(f.navPct, 2)
  })

  it('盘中（phase=live）不发夜盘请求，也不出数', async () => {
    const spy = vi.fn(allQuoted(1))
    const { app } = makeApp(
      [{ code: '270042', name: '纳指', indexKey: 'ndx' }],
      { loadHoldings: async () => ({ holdings: NIGHT_HOLDINGS, weightsFrom: 'index' }), afterHours: spy },
      ['AAPL', 'MSFT'],
      'REG_MKT',
    )
    const { body } = await get(app)
    expect(body.phase).toBe('live')
    expect(spy).not.toHaveBeenCalled()
    expect('afterHours' in body.funds[0]).toBe(false)
  })

  it('盘前也是 live，同样不出夜盘（那是三小时以后的事）', async () => {
    const spy = vi.fn(allQuoted(1))
    const { app } = makeApp(
      [{ code: '270042', name: '纳指', indexKey: 'ndx' }],
      { loadHoldings: async () => ({ holdings: NIGHT_HOLDINGS, weightsFrom: 'index' }), afterHours: spy },
      ['AAPL', 'MSFT'],
      'PRE_MKT',
    )
    const { body } = await get(app)
    expect(spy).not.toHaveBeenCalled()
    expect('afterHours' in body.funds[0]).toBe(false)
  })

  it('覆盖率只有 0.1 → 整块省掉（外推是噪声，宁可不给）', async () => {
    const { app } = makeApp(
      [{ code: '270042', name: '纳指', indexKey: 'ndx' }],
      {
        loadHoldings: async () => ({
          holdings: [{ symbol: 'AAPL', name: '苹果', weight: 0.1, market: 105 }],
          weightsFrom: 'top10',
        }),
        afterHours: allQuoted(3),
      },
      ['AAPL'],
      'CLOSED',
    )
    const { body } = await get(app)
    const f = body.funds[0]
    expect('afterHours' in f).toBe(false)
    // 收盘估值照常
    expect(f.coveredWeight).toBeCloseTo(0.1, 6)
    expect(Number.isFinite(f.navPct)).toBe(true)
  })

  it('一只都没有盘后行情 → 空 Map → 省掉整块，而不是写 0', async () => {
    const { app } = makeApp(
      [{ code: '270042', name: '纳指', indexKey: 'ndx' }],
      {
        loadHoldings: async () => ({ holdings: NIGHT_HOLDINGS, weightsFrom: 'index' }),
        afterHours: async () => new Map(),
      },
      ['AAPL', 'MSFT'],
      'CLOSED',
    )
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect('afterHours' in body.funds[0]).toBe(false)
  })

  it('夜盘取数抛错也不污染请求：200 + 收盘估值照常', async () => {
    const { app } = makeApp(
      [{ code: '270042', name: '纳指', indexKey: 'ndx' }],
      {
        loadHoldings: async () => ({ holdings: NIGHT_HOLDINGS, weightsFrom: 'index' }),
        afterHours: async () => {
          throw new Error('sina down')
        },
      },
      ['AAPL', 'MSFT'],
      'CLOSED',
    )
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect('afterHours' in body.funds[0]).toBe(false)
    expect(body.funds[0].navPct).toBeCloseTo(0.95 * ((1.023 * (7.2 / 7.18) - 1) * 100), 6)
  })

  it('只把美股代码送去取夜盘：港股在取价前已被剔除', async () => {
    const seen: string[] = []
    const spy = vi.fn(async (symbols: string[]) => {
      seen.push(...symbols)
      return new Map(symbols.map((s) => quoteOf(s, 1)))
    })
    // 默认 HOLDINGS['270042'] = AAPL 0.5 + 腾讯 00700 0.1
    const { app } = makeApp(
      [{ code: '270042', name: '纳指', indexKey: 'ndx' }],
      { afterHours: spy },
      ['AAPL'],
      'CLOSED',
    )
    const { body } = await get(app)
    expect(seen).toEqual(['AAPL'])
    expect(body.funds[0].afterHours.coveredWeight).toBeCloseTo(0.5, 6)
  })

  it('多只基金各算各的：没有夜盘的那只不带 afterHours', async () => {
    const { app } = makeApp(
      [
        { code: '270042', name: '纳指', indexKey: 'ndx' },
        { code: '000001', name: '无盘后', indexKey: null },
      ],
      {
        loadHoldings: async (fund) =>
          fund.code === '270042'
            ? { holdings: NIGHT_HOLDINGS, weightsFrom: 'index' }
            : {
                holdings: [{ symbol: 'TSLA', name: '特斯拉', weight: 0.3, market: 105 }],
                weightsFrom: 'top10',
              },
        // 只给 AAPL/MSFT 盘后行情，TSLA 没有
        afterHours: async (symbols) =>
          new Map(symbols.filter((s) => s !== 'TSLA').map((s) => quoteOf(s, 1))),
      },
      ['AAPL', 'MSFT', 'TSLA'],
      'CLOSED',
    )
    const { body } = await get(app)
    const byCode = Object.fromEntries(body.funds.map((f: { code: string }) => [f.code, f]))
    expect(byCode['270042'].afterHours).toBeDefined()
    expect('afterHours' in byCode['000001']).toBe(false)
  })
})

/**
 * 指数口径可用性。
 *
 * 这是「闭市后估值还在漂」的直接病根：指数条取不到 NDX100 → indexPct 变 undefined
 * → navPct 从「官方指数涨跌幅」静默退回「自算成分加权」。两套方法论，数字看着都正常，
 * 界面完全看不出来。所以必须有一个如实的标记 + 一条 warn。
 */
describe('GET /api/estimate · 指数口径可用性（indexPctAvailable）', () => {
  /** 2026-11-10 闭市后实测：东财空 body，这四条来自新浪 */
  const STRIP: MarketIndex[] = [
    { symbol: '000001', name: '上证指数', value: 3667.8157, change: 7.024, pct: 0.19 },
    { symbol: '399001', name: '深证成指', value: 11245.62, change: 100.132, pct: 0.9 },
    { symbol: 'NDX100', name: '纳斯达克100', value: 27907.6251, change: 917.6336, pct: 3.4 },
    { symbol: 'SPX', name: '标普500', value: 7549.9399, change: 173.08, pct: 2.35 },
  ]
  const FX = 7.2 / 7.18

  it('拿到 NDX100 → indexPctAvailable=true，navPct 走指数口径（≈ 指数 × 仓位）', async () => {
    const { app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }], {
      marketIndices: async () => STRIP,
    })
    const { body } = await get(app)
    const f = body.funds[0]
    expect(f.indexPctAvailable).toBe(true)
    expect(f.weightsFrom).toBe('index')
    expect(f.navPct).toBeCloseTo(0.95 * ((1 + 3.4 / 100) * FX - 1) * 100, 6)
    // 指数 × 仓位是 3.23；汇率那条腿（7.2/7.18−1 ≈ +0.28%）再复合上来，落在 3.2~3.6 之间
    expect(f.navPct).toBeGreaterThan(3.2)
    expect(f.navPct).toBeLessThan(3.6)
  })

  it('配了 index_key 但指数条没有 NDX100 → 标记为 false，weightsFrom 仍是 index', async () => {
    // 默认 INDICES 里纳指那一行 symbol 是 'NDX'（综合指数），映射不到 NDX100
    const { app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }])
    const { body } = await get(app)
    const f = body.funds[0]
    expect(f.indexPctAvailable).toBe(false)
    // 权重口径没变（成分名单来自指数全量），变的只是涨跌幅算法 —— 这正是要标出来的事
    expect(f.weightsFrom).toBe('index')
    // 退回了成分加权自算：0.95·((1.023)(7.2/7.18)−1)·100
    expect(f.navPct).toBeCloseTo(0.95 * ((1.023 * FX - 1) * 100), 6)
  })

  it('两个源全挂（指数条为空数组）→ 200、指数条空、该基金标记 false', async () => {
    const { app } = makeApp([{ code: '270042', name: '纳指', indexKey: 'ndx' }], {
      marketIndices: async () => [],
    })
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.marketIndices).toEqual([])
    const f = body.funds[0]
    expect(f.indexPctAvailable).toBe(false)
    expect(f.weightsFrom).toBe('index')
    expect(Number.isFinite(f.navPct)).toBe(true)
  })

  it('没配 index_key 的基金一律 false（它本来就不该走指数口径）', async () => {
    const { app } = makeApp([{ code: '000001', name: '无指数', indexKey: null }], {
      marketIndices: async () => STRIP,
    })
    const { body } = await get(app)
    expect(body.funds[0].indexPctAvailable).toBe(false)
  })

  it('口径降级时打一条 warn（否则这个故障只能靠肉眼看数字漂移才能发现）', async () => {
    const warn = vi.fn()
    const { app } = makeApp(
      // 用独立代码：warn 节流按基金代码记 60 秒，别被别的用例吃掉
      [{ code: '888001', name: '独立纳指', indexKey: 'ndx' }],
      {
        marketIndices: async () => [],
        loadHoldings: async () => ({
          holdings: [{ symbol: 'AAPL', name: '苹果', weight: 0.5, market: 105 }],
          weightsFrom: 'index',
        }),
      },
    )
    app.log.warn = warn as unknown as typeof app.log.warn
    await get(app)
    const messages = warn.mock.calls.map((call) => String(call[1]))
    expect(messages).toContain('index pct unavailable; estimate falls back to constituent weighting')
    expect(messages).toContain('marketIndices has no NDX100; index funds lose their official pct')
  })
})
