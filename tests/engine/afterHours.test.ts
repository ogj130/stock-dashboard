import { describe, it, expect } from 'vitest'
import {
  AFTER_HOURS_MIN_COVERED_WEIGHT,
  estimateAfterHours,
} from '../../src/engine/afterHours'
import type { AfterHoursQuote, Holding } from '../../src/types'

/**
 * 夜盘估值是纯函数，因此这里钉的是**口径**而不是接线：
 * 用哪些权重做分母、汇率腿怎么复合、覆盖率不到 0.3 时为什么宁可不给。
 */

const h = (symbol: string, weight: number): Holding => ({ symbol, name: symbol, weight })
const ah = (symbol: string, pct: number, tsMs = 1_700_000_000_000): [string, AfterHoursQuote] => [
  symbol,
  { symbol, price: 100, pct, tsMs },
]
const map = (...entries: Array<[string, AfterHoursQuote]>): Map<string, AfterHoursQuote> =>
  new Map(entries)

const base = {
  fxNow: 7.2,
  fxPrev: 7.2,
  exposure: 1,
}

describe('estimateAfterHours · 公式', () => {
  it('汇率不变时 = 成分盘后加权 × 仓位', () => {
    const r = estimateAfterHours({
      ...base,
      holdings: [h('AAPL', 0.5), h('MSFT', 0.3)],
      afterHours: map(ah('AAPL', 2), ah('MSFT', -1)),
    })!
    // (0.5·2 + 0.3·(−1)) / 0.8 = 0.875%
    expect(r.navPct).toBeCloseTo(0.875, 6)
    expect(r.coveredWeight).toBeCloseTo(0.8, 6)
  })

  it('汇率腿与收盘估值同一条：(1+r_stock)(1+r_fx) − 1 再乘仓位', () => {
    const r = estimateAfterHours({
      ...base,
      fxNow: 7.2,
      fxPrev: 7.18,
      exposure: 0.95,
      holdings: [h('AAPL', 0.9)],
      afterHours: map(ah('AAPL', 1)),
    })!
    expect(r.navPct).toBeCloseTo(0.95 * ((1.01 * (7.2 / 7.18) - 1) * 100), 6)
    expect(r.navPct).toBeCloseTo(1.2173, 3)
  })

  it('分母只用「有盘后行情」的成分权重，缺的票不拉低幅度', () => {
    // 只有 AAPL 有盘后行情：若拿全部权重（0.5+0.5）当分母会得出 1%，正确是 2%
    const r = estimateAfterHours({
      ...base,
      holdings: [h('AAPL', 0.5), h('NVDA', 0.5)],
      afterHours: map(ah('AAPL', 2)),
    })!
    expect(r.navPct).toBeCloseTo(2, 6)
    expect(r.coveredWeight).toBeCloseTo(0.5, 6)
  })

  it('asOfMs 取参与计算的最新一笔盘后成交', () => {
    const r = estimateAfterHours({
      ...base,
      holdings: [h('AAPL', 0.5), h('MSFT', 0.5)],
      afterHours: map(ah('AAPL', 1, 1000), ah('MSFT', 1, 9000)),
    })!
    expect(r.asOfMs).toBe(9000)
  })
})

describe('estimateAfterHours · 覆盖率门槛 0.3', () => {
  it('门槛常量就是 0.3（文档与实现同一处定义）', () => {
    expect(AFTER_HOURS_MIN_COVERED_WEIGHT).toBe(0.3)
  })

  it('覆盖率 0.29 → null（外推是噪声，宁可不给）', () => {
    expect(
      estimateAfterHours({
        ...base,
        holdings: [h('AAPL', 0.29), h('MSFT', 0.71)],
        afterHours: map(ah('AAPL', 3)),
      }),
    ).toBeNull()
  })

  it('覆盖率刚好 0.3 → 出数（边界含在内）', () => {
    const r = estimateAfterHours({
      ...base,
      holdings: [h('AAPL', 0.3), h('MSFT', 0.7)],
      afterHours: map(ah('AAPL', 3)),
    })
    expect(r).not.toBeNull()
    expect(r!.coveredWeight).toBeCloseTo(0.3, 6)
    expect(r!.navPct).toBeCloseTo(3, 6)
  })

  it('一只都没有 / 权重全 0 → null（不做 0/0）', () => {
    expect(
      estimateAfterHours({ ...base, holdings: [h('AAPL', 0.9)], afterHours: new Map() }),
    ).toBeNull()
    expect(
      estimateAfterHours({
        ...base,
        holdings: [h('AAPL', 0)],
        afterHours: map(ah('AAPL', 5)),
      }),
    ).toBeNull()
  })

  it('权重脏数据 >1 时覆盖率夹到 1', () => {
    const r = estimateAfterHours({
      ...base,
      holdings: [h('AAPL', 0.8), h('MSFT', 0.8)],
      afterHours: map(ah('AAPL', 2), ah('MSFT', 2)),
    })!
    expect(r.coveredWeight).toBe(1)
    expect(r.navPct).toBeCloseTo(2, 6)
  })
})
