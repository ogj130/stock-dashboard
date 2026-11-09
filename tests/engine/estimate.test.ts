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

  it('未给残差代理时，未覆盖部分按已覆盖的加权涨跌外推', () => {
    // 覆盖 60%、涨 2%。未覆盖的 40% 不该按 0 计（那等于假设另一半资产当天不动），
    // 而应假设它与已披露部分同属一个组合、涨跌相近 → 整体仍是 2%
    const r = estimateNav({ ...base, holdings: [{ symbol: 'A', name: 'A', weight: 0.6, pct: 2 }] })
    expect(r.navPct).toBeCloseTo(2, 6)
  })

  it('显式给出 residualPct 时以它为准', () => {
    const r = estimateNav({
      ...base,
      holdings: [{ symbol: 'A', name: 'A', weight: 0.6, pct: 2 }],
      residualPct: 5,
    })
    expect(r.navPct).toBeCloseTo(0.6 * 2 + 0.4 * 5, 6)
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
