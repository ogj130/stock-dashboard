import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

// buildEstimate 是纯函数，任何一条用例偷偷联网都说明纯度被破坏了
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('buildEstimate 必须是纯函数：禁止联网')
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

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
    expect(r.holdingProfit).toBeCloseTo(1000 * 7.37 * 1.06 - 5000, 2)
    expect(r.coveredWeight).toBeCloseTo(1, 6)
    expect(r.missing).toEqual([])
    // 各项贡献之和 == navPct：exposure=1、汇率不变时成立
    const sum = r.breakdown.reduce((s, b) => s + b.contribution, 0)
    expect(sum).toBeCloseTo(r.navPct, 6)
  })

  it('breakdown 带上成交额与行情源的中文名（只服务卡片「个股」）', () => {
    const withMeta = new Map(quotes)
    withMeta.set('AAPL', {
      ...quotes.get('AAPL')!,
      name: '苹果',
      turnover: 5_671_975_014,
    })
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 1, costBasis: 1, nav: 1,
      holdings, quotes: withMeta, fxNow: 7, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
    })
    const aapl = r.breakdown.find((b) => b.symbol === 'AAPL')!
    expect(aapl.name).toBe('苹果')
    expect(aapl.turnover).toBe(5_671_975_014)
    // 另一只没有成交额：连键都不出现，卡片才能识别「热度未知」而不是热度 0
    const msft = r.breakdown.find((b) => b.symbol === 'MSFT')!
    expect(msft).not.toHaveProperty('turnover')
  })

  it('缺行情的股票被剔除，覆盖率如实反映', () => {
    const partial = new Map(quotes)
    partial.delete('MSFT')
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 1, costBasis: 1, nav: 1,
      holdings, quotes: partial, fxNow: 7, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
    })
    expect(r.coveredWeight).toBeCloseTo(0.6, 6)
    // 覆盖的 60% 涨 10%；未覆盖的 40% 按已覆盖的涨幅外推（也按 10%），
    // 所以整体仍是 10% —— 而不是旧逻辑的 6%（那等于假设缺行情的那只当天不动）
    expect(r.navPct).toBeCloseTo(10, 6)
    expect(r.missing).toEqual(['MSFT'])
    // 未覆盖的票不能出现在明细里：明细是"实际参与计算的部分"
    expect(r.breakdown.map((b) => b.symbol)).toEqual(['AAPL'])
  })

  it('汇率升值时金额被抵消', () => {
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 1000, costBasis: 1, nav: 1,
      holdings: [{ symbol: 'AAPL', name: 'A', weight: 1 }], quotes,
      fxNow: 6.86, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
    })
    expect(r.navPct).toBeCloseTo((1.1 * 0.98 - 1) * 100, 4)
  })

  it('一条行情都没有时 coverage 为 0，绝不产出 NaN（数据层允许返回空 Map）', () => {
    const fxNow = 7.1
    const fxPrev = 7
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 100, costBasis: 500, nav: 2,
      holdings, quotes: new Map(), fxNow, fxPrev,
      exposure: 0.95, lagDays: 1, phase: 'settled',
    })
    // 覆盖率 0 是唯一可信的错误信号；界面必须据此显示「无覆盖」而不是「涨 1.36%」
    expect(r.coveredWeight).toBe(0)
    expect(r.breakdown).toEqual([])
    expect(r.missing).toEqual(['AAPL', 'MSFT'])
    // 股票腿一无信息按 0 计，汇率腿是真实已知量，所以 navPct 只剩汇率：
    // 这是部分真相，不能抹掉，也不该被读成「基金涨了」
    expect(r.navPct).toBeCloseTo((fxNow / fxPrev - 1) * 0.95 * 100, 6)
    expect(Number.isFinite(r.marketValue)).toBe(true)
    expect(r.amount).toBeCloseTo(100 * 2 * (r.navPct / 100), 6)
  })

  it('港股排除数如实透传（过滤发生在取价之前，纯函数只负责上报）', () => {
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 1, costBasis: 1, nav: 1,
      holdings, quotes, fxNow: 7, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
      excludedHk: 3, weightsFrom: 'index',
    })
    expect(r.excluded).toEqual({ hk: 3 })
    expect(r.weightsFrom).toBe('index')
    // 缺省时不撒谎：没排除就是 0
    const noHk = buildEstimate({
      code: 'X', name: 'X', shares: 1, costBasis: 1, nav: 1,
      holdings, quotes, fxNow: 7, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
    })
    expect(noHk.excluded).toEqual({ hk: 0 })
  })
})

describe('indexWeightsUnavailable', () => {
  // 语义边界：只有「真的退回前十大」才算取数失败。
  // 若指数成分拿到了（weightsFrom='index'），那么这个标记毫无意义，
  // 前端却会照着它去显示故障文案 —— 必须在这里挡住。
  const base = {
    code: '270042', name: '广发纳指', shares: 1000, costBasis: 5000,
    nav: 7.37, holdings, quotes, fxNow: 7, fxPrev: 7,
    exposure: 1, lagDays: 1, phase: 'live' as const,
  }

  it('配了指数、退回前十大 → true', () => {
    const r = buildEstimate({ ...base, weightsFrom: 'top10', indexWeightsUnavailable: true })
    expect(r.indexWeightsUnavailable).toBe(true)
  })

  it('指数成分拿到了 → false（标记不该跟着权重来源一起漂）', () => {
    const r = buildEstimate({ ...base, weightsFrom: 'index', indexWeightsUnavailable: true })
    expect(r.indexWeightsUnavailable).toBe(false)
  })

  it('什么都没说 → false，不让旧调用方被迫改签名', () => {
    expect(buildEstimate(base).indexWeightsUnavailable).toBe(false)
  })
})

describe('盘前那条腿', () => {
  // 盘前价与 navPct 都是「相对上一交易日收盘」，只是先后两段：
  // navPct 是昨天那一整段（常规接口在盘前只会给这个），preMarket 是今天盘前进行中那段。
  const base = {
    code: '270042', name: '广发纳指', shares: 1000, costBasis: 5000,
    nav: 7.37, holdings, quotes, fxNow: 7, fxPrev: 7,
    exposure: 1, lagDays: 1, weightsFrom: 'index' as const,
  }
  const pre = new Map([
    ['AAPL', { symbol: 'AAPL', price: 111, pct: 1, tsMs: 1_700_000_000_000 }],
    ['MSFT', { symbol: 'MSFT', price: 99, pct: -1, tsMs: 1_700_000_001_000 }],
  ])

  it('盘前相且覆盖率够 → 给出第二组数字', () => {
    const r = buildEstimate({ ...base, phase: 'pre', preMarket: pre })
    // 0.6*1 + 0.4*(-1) = +0.2%
    expect(r.preMarket).toBeDefined()
    expect(r.preMarket!.navPct).toBeCloseTo(0.2, 6)
    expect(r.preMarket!.coveredWeight).toBeCloseTo(1, 6)
    expect(r.preMarket!.amount).toBeCloseTo(1000 * 7.37 * 0.002, 6)
    expect(r.preMarket!.asOfMs).toBe(1_700_000_001_000)
  })

  it('盘中/收盘相根本不带这个键（哪怕调用方塞了行情）', () => {
    for (const phase of ['live', 'settled'] as const) {
      const r = buildEstimate({ ...base, phase, preMarket: pre })
      expect('preMarket' in r).toBe(false)
    }
  })

  it('覆盖率不足 30% 就不出盘前数字，而不是给个假 0', () => {
    // 持仓里只有 0.2 的权重有盘前成交 → 低于 0.3 的门槛
    const thin = new Map([['AAPL', { symbol: 'AAPL', price: 111, pct: 1, tsMs: 1 }]])
    const lowCover = [
      { symbol: 'AAPL', name: '苹果', weight: 0.2 },
      { symbol: 'MSFT', name: '微软', weight: 0.8 },
    ]
    const r = buildEstimate({ ...base, holdings: lowCover, phase: 'pre', preMarket: thin })
    expect('preMarket' in r).toBe(false)
  })

  it('盘前不掺 indexPct：官方指数涨跌是常规时段的数，拿来算盘前会把白天涨幅重算一遍', () => {
    const r = buildEstimate({ ...base, phase: 'pre', preMarket: pre, indexPct: 3.4 })
    // 若误用 indexPct，这里会变成 3.4 而非 0.2
    expect(r.preMarket!.navPct).toBeCloseTo(0.2, 6)
  })
})

describe('盘前口径：指数代理优先', () => {
  // 实测依据（2026-11-10 04:30 ET）：成分加权 +0.07%，QQQ −0.21%，纳指期货 −0.17%。
  // 后两者一致 → 偏差来自「成分权重是我们按市值归一化的近似」，不是行情错。
  // 所以跟踪指数的基金在盘前用 ETF 的口径，与常规时段用官方指数涨跌幅是同一条原则。
  const base = {
    code: '270042', name: '广发纳指', shares: 1000, costBasis: 5000,
    nav: 7.37, holdings, quotes, fxNow: 7, fxPrev: 7,
    exposure: 1, lagDays: 1, phase: 'pre' as const, weightsFrom: 'index' as const,
  }
  const pre = new Map([
    ['AAPL', { symbol: 'AAPL', price: 110, pct: 10, tsMs: 5 }],
    ['MSFT', { symbol: 'MSFT', price: 100, pct: 0, tsMs: 6 }],
  ])

  it('给了指数代理涨跌幅就用它，并把成分口径留着对账', () => {
    const r = buildEstimate({ ...base, preMarket: pre, preMarketIndexPct: -0.2 })
    expect(r.preMarket!.basis).toBe('index')
    expect(r.preMarket!.navPct).toBeCloseTo(-0.2, 6)
    // 成分加权是 0.6*10 = 6%：两套口径差了 6pp 也要如实留着，别抹平
    expect(r.preMarket!.constituentPct).toBeCloseTo(6, 6)
  })

  it('没有指数（主动基金）→ 成分口径', () => {
    const r = buildEstimate({ ...base, weightsFrom: 'top10', preMarket: pre })
    expect(r.preMarket!.basis).toBe('constituents')
    expect(r.preMarket!.navPct).toBeCloseTo(6, 6)
  })

  it('指数口径也要过汇率腿（与收盘同一条腿，不能漏）', () => {
    const r = buildEstimate({ ...base, preMarket: pre, preMarketIndexPct: -0.2, fxNow: 7.14, fxPrev: 7 })
    // (-0.2%) × (7.14/7 − 1 = +2%) → ≈ +1.796%
    expect(r.preMarket!.navPct).toBeCloseTo(((1 - 0.002) * 1.02 - 1) * 100, 6)
  })

  it('指数代理拿到但成分一只都没有 → 仍然出盘前数字（口径不依赖成分）', () => {
    const r = buildEstimate({ ...base, preMarket: new Map(), preMarketIndexPct: -0.2 })
    expect(r.preMarket!.basis).toBe('index')
    expect(r.preMarket!.coveredWeight).toBe(1)
  })

  it('非有限值的代理涨跌被当成「没给」，退回成分口径', () => {
    const r = buildEstimate({ ...base, weightsFrom: 'top10', preMarket: pre, preMarketIndexPct: NaN })
    expect(r.preMarket!.basis).toBe('constituents')
  })
})

describe('净值滞后链', () => {
  // QDII 官方净值 T+1/T+2 才公布：净值停在 11-06 时，11-09 那场已经发生但没进净值。
  // 不把这段复合进来，总资产就会凭空少算——实测差过一万块。
  const base = {
    code: '270042', name: '广发纳指', shares: 1000, costBasis: 5000,
    nav: 7.37, holdings, quotes, fxNow: 7, fxPrev: 7,
    exposure: 1, lagDays: 1, phase: 'live' as const, weightsFrom: 'index' as const,
  }

  it('净值日之后那几场要复合进市值，且是复合不是相加', () => {
    const r = buildEstimate({
      ...base,
      navChain: {
        navDate: '2026-11-06',
        sessions: [
          { date: '2026-11-09', pct: 3 },
          { date: '2026-11-10', pct: 2 },
        ],
      },
    })
    // 1.03 × 1.02 = 1.0506 → +5.06%（相加会得到 +5%）
    expect(r.priorPct).toBeCloseTo(5.06, 6)
    expect(r.sessionsSinceNav).toBe(2)
    expect(r.navDate).toBe('2026-11-06')
    // 今天这一场 +6%（holdings 权重算出来的），市值 = 基准 × 1.0506 × 1.06
    const baseValue = 1000 * 7.37
    expect(r.marketValue).toBeCloseTo(baseValue * 1.0506 * 1.06, 4)
  })

  it('今日收益按"今天开场时的估值市值"算，不把滞后那几场算成今天赚的', () => {
    const r = buildEstimate({
      ...base,
      navChain: { navDate: '2026-11-06', sessions: [{ date: '2026-11-09', pct: 10 }] },
    })
    const baseValue = 1000 * 7.37
    // 今日 +6% 作用在 1.1 倍之后的市值上；若错用净值基准，会是 baseValue*0.06
    expect(r.amount).toBeCloseTo(baseValue * 1.1 * 0.06, 4)
    expect(r.amount).not.toBeCloseTo(baseValue * 0.06, 2)
  })

  it('没有滞后（净值最新）时行为与原来一致', () => {
    const withChain = buildEstimate({
      ...base,
      navChain: { navDate: '2026-11-10', sessions: [] },
    })
    const without = buildEstimate(base)
    expect(withChain.priorPct).toBe(0)
    expect(withChain.sessionsSinceNav).toBe(0)
    expect(withChain.marketValue).toBeCloseTo(without.marketValue, 6)
    expect(withChain.amount).toBeCloseTo(without.amount, 6)
  })

  it('持有收益跟着滞后链一起修正（否则账面上永远少那一段）', () => {
    const plain = buildEstimate(base)
    const chained = buildEstimate({
      ...base,
      navChain: { navDate: '2026-11-06', sessions: [{ date: '2026-11-09', pct: 3 }] },
    })
    // 3% 的滞后段作用在净值基准上，且要再乘今天这一场（+6%）：
    // 1000×7.37×0.03×1.06 —— 这正是"复合"与"相加"的区别
    expect(chained.holdingProfit - plain.holdingProfit).toBeCloseTo(1000 * 7.37 * 0.03 * 1.06, 4)
  })
})
