import { describe, it, expect } from 'vitest'
import { pctFromDelta, pctText } from '../../web/format'

/**
 * 百分比的分母规则。这是「同一笔收益，两种算法差 0.1~0.2 个百分点」的地方：
 * 拿现值当分母不会报错，只会在对账时露出马脚，所以必须钉死。
 */
describe('pctFromDelta · 分母是变动之前的基准', () => {
  it('涨：用「现值 − 金额」做分母，而不是现值', () => {
    expect(pctFromDelta(1_686.26, 49_618.91)).toBeCloseTo(3.5182, 3)
  })

  it('跌：亏损额是负数，基准比现值更大', () => {
    expect(pctFromDelta(-250, 10_000)).toBeCloseTo(-2.439, 3)
  })

  it('后端口径自洽：amount 与 marketValue 能还原出 navPct', () => {
    // marketValue = 基准 × (1 + 3.52%)，amount = 基准 × 3.52%
    const base = 47_932.65
    const navPct = 3.52
    const amount = base * (navPct / 100)
    const marketValue = base * (1 + navPct / 100)
    expect(pctFromDelta(amount, marketValue)).toBeCloseTo(navPct, 9)
  })

  it('基准算不出来（0 / 负数 / 非有限数）→ null，调用方写「—」', () => {
    expect(pctFromDelta(0, 0)).toBeNull()
    expect(pctFromDelta(100, 100)).toBeNull()
    expect(pctFromDelta(150, 100)).toBeNull()
    expect(pctFromDelta(Number.NaN, 100)).toBeNull()
    expect(pctFromDelta(1, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('pctText · 不许出现 -0.00%', () => {
  it('四舍五入后是零的负数按 0.00% 写', () => {
    expect(pctText(-0.001)).toBe('0.00%')
    expect(pctText(-0.004)).toBe('0.00%')
  })

  it('正数带 +，负数带 -，两位小数', () => {
    expect(pctText(1.006)).toBe('+1.01%')
    expect(pctText(-2.439)).toBe('-2.44%')
    expect(pctText(0)).toBe('0.00%')
  })
})
