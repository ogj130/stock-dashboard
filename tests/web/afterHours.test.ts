import { describe, it, expect } from 'vitest'
import { afterHoursClock, summarizeAfterHours } from '../../web/afterHours'

/**
 * 夜盘那一行的展示口径。这里只钉两件事：加权怎么加、没有数据时返回什么。
 * 后者尤其重要——界面靠 null 决定「整行不渲染」，绝不能把它变成「夜盘 —」。
 */

const fund = (code: string, marketValue: number, navPct?: number, asOfMs = 0) =>
  navPct === undefined
    ? { code, marketValue }
    : { code, marketValue, afterHours: { navPct, amount: 0, coveredWeight: 0.9, asOfMs } }

describe('summarizeAfterHours', () => {
  it('按市值加权：大仓位主导结论', () => {
    const s = summarizeAfterHours([fund('A', 90_000, 1), fund('B', 10_000, -3)])!
    expect(s.pct).toBeCloseTo(0.6, 6)
    expect(s.count).toBe(2)
  })

  it('只有部分基金有夜盘 → 只在那几只里加权（不把没有的当 0）', () => {
    const s = summarizeAfterHours([fund('A', 10_000, 2), fund('B', 90_000)])!
    expect(s.pct).toBeCloseTo(2, 6)
    expect(s.count).toBe(1)
  })

  it('asOfMs 取最新一笔', () => {
    const s = summarizeAfterHours([fund('A', 1, 1, 1000), fund('B', 1, 1, 5000)])!
    expect(s.asOfMs).toBe(5000)
  })

  it('一只都没有 → null（界面据此整行不渲染）', () => {
    expect(summarizeAfterHours([])).toBeNull()
    expect(summarizeAfterHours([fund('A', 10_000), fund('B', 20_000)])).toBeNull()
  })

  it('市值全为 0 时不硬算（没有权重就没有加权平均）', () => {
    expect(summarizeAfterHours([fund('A', 0, 1)])).toBeNull()
  })
})

describe('afterHoursClock', () => {
  it('按美东时区显示 HH:MM ET（冬令时 19:59 EST → 19:59 ET）', () => {
    expect(afterHoursClock(Date.parse('2026-11-10T00:59:00Z'))).toBe('19:59 ET')
  })

  it('夏令时自动跟着 Intl 走（19:59 EDT → 19:59 ET）', () => {
    expect(afterHoursClock(Date.parse('2026-08-11T23:59:00Z'))).toBe('19:59 ET')
  })

  it('非法时刻返回 null（不显示 "NaN:NaN ET"）', () => {
    expect(afterHoursClock(0)).toBeNull()
    expect(afterHoursClock(Number.NaN)).toBeNull()
  })
})
