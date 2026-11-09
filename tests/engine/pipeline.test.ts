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

  it('缺行情的股票被剔除，覆盖率如实反映', () => {
    const partial = new Map(quotes)
    partial.delete('MSFT')
    const r = buildEstimate({
      code: 'X', name: 'X', shares: 1, costBasis: 1, nav: 1,
      holdings, quotes: partial, fxNow: 7, fxPrev: 7, exposure: 1, lagDays: 1, phase: 'live',
    })
    expect(r.coveredWeight).toBeCloseTo(0.6, 6)
    expect(r.navPct).toBeCloseTo(6, 6)          // 0.6 覆盖部分全涨 10% → 归一后 10%，未覆盖按 0 → 6
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
