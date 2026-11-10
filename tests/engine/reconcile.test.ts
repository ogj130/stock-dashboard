import { describe, it, expect } from 'vitest'
import {
  alignResiduals,
  dateToMs,
  fitSlot,
  shiftDate,
  summarize,
  type NavDay,
} from '../../src/engine/reconcile'

/**
 * 对账是整个系统的「成绩单」：没有它，所有估值都只是看起来合理。
 * 这里钉四件事：日期位移不被时区带偏、lag 对齐正确、统计量定义正确、
 * 以及**样本不足时不给结论**（宁可说"还不够"，也不能编一个 MAE 出来）。
 */

describe('日期工具', () => {
  it('日期落在 UTC 正午：任何时区都不会把日期推走一天', () => {
    expect(new Date(dateToMs('2026-11-06')).getUTCDate()).toBe(6)
  })

  it('加减天数跨月跨年', () => {
    expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDate('2026-11-06', 3)).toBe('2026-11-09')
  })

  it('坏日期原样返回，不产生 NaN 日期', () => {
    expect(shiftDate('', 1)).toBe('')
    expect(shiftDate('2026-13', 1)).toBe('2026-13')
  })
})

describe('alignResiduals', () => {
  const model = new Map([
    ['2026-11-05', 1.2],
    ['2026-11-06', -0.4],
  ])
  // 公布日序列：11-06(周五) 公布的是 11-05 那场；11-09(周一) 公布的是 11-06 那场
  const navs: NavDay[] = [
    { date: '2026-11-06', pct: 1.1 },
    { date: '2026-11-09', pct: -0.4 },
  ]

  it('slot=1：对齐到「这场之后第一次公布」', () => {
    const r = alignResiduals(model, navs, 1)
    expect(r.map((x) => x.modelDate)).toEqual(['2026-11-05', '2026-11-06'])
    expect(r[0]!.navDate).toBe('2026-11-06')
    // 周末不参与计算：11-06 那场的净值是 11-09 公布的（自然日差 3 天也不是问题）
    expect(r[1]!.navDate).toBe('2026-11-09')
    expect(r[0]!.diff).toBeCloseTo(0.1, 6)
    expect(r[1]!.diff).toBeCloseTo(0, 6)
  })

  it('slot=2：跳过最近一次公布，用于识别「落后两次公布」的基金', () => {
    const r = alignResiduals(model, navs, 2)
    expect(r.map((x) => x.modelDate)).toEqual(['2026-11-05'])
    expect(r[0]!.navDate).toBe('2026-11-09')
  })

  it('没有更晚的公布日 → 这场对不了账，跳过而不是硬凑', () => {
    expect(alignResiduals(model, [{ date: '2026-11-01', pct: 1 }], 1)).toEqual([])
  })

  it('没有对应留痕的那天直接跳过，不补 0', () => {
    expect(alignResiduals(model, [{ date: '2026-10-01', pct: 1 }], 1)).toEqual([])
  })

  it('净值涨跌幅非有限值时跳过（脏数据不进统计）', () => {
    expect(alignResiduals(model, [{ date: '2026-11-20', pct: Number.NaN }], 1)).toEqual([])
  })
})

describe('summarize', () => {
  it('MAE 取绝对值、bias 保留方向', () => {
    const s = summarize([
      { modelDate: 'a', navDate: 'b', modelPct: 1, actualPct: 0, diff: 1 },
      { modelDate: 'a', navDate: 'c', modelPct: 1, actualPct: 3, diff: -2 },
    ])
    expect(s.n).toBe(2)
    expect(s.mae).toBeCloseTo(1.5, 6)
    expect(s.bias).toBeCloseTo(-0.5, 6)
    expect(s.maxAbs).toBe(2)
  })

  it('空样本给全 0，而不是 NaN', () => {
    expect(summarize([])).toEqual({ n: 0, mae: 0, bias: 0, maxAbs: 0 })
  })
})

describe('fitSlot', () => {
  /** 造一只基金：公布日序列紧跟在每一场之后（slot=1 时完全吻合） */
  function fixture(slotTrue: 1 | 2): {
    model: Map<string, Map<string, number>>
    navs: Map<string, NavDay[]>
  } {
    const sessions = ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']
    const pcts = [1.2, -0.4, 2.1, 0.3, -1.1, 0.8, 0.5]
    const model = new Map<string, Map<string, number>>()
    const m = new Map<string, number>()
    sessions.forEach((d, i) => m.set(d, pcts[i]!))
    model.set('270042', m)

    // 真正的公布日：每场之后的第 slotTrue 次公布。这里假设每天都公布。
    const publishDays = sessions.map((d) => shiftDate(d, 1))
    const navs = new Map<string, NavDay[]>()
    navs.set(
      '270042',
      // slot=1 时 navs[i] 解释 sessions[i]；slot=2 时整体右移一格
      publishDays.map((d, i) => ({
        date: d,
        pct: pcts[Math.max(0, i - (slotTrue - 1))]!,
      })),
    )
    return { model, navs }
  }

  it('能识别出落后的公布次数', () => {
    const one = fixture(1)
    expect(fitSlot(one.model, one.navs).slot).toBe(1)
  })

  it('候选 MAE 全部给出，供人工核对', () => {
    const { model, navs } = fixture(1)
    const fit = fitSlot(model, navs)
    expect(fit.candidates.map((c) => c.slot)).toEqual([1, 2, 3])
    const right = fit.candidates.find((c) => c.slot === 1)!
    expect(right.mae).toBeCloseTo(0, 6)
  })

  it('样本不足时不给结论（slot 回结构默认 1、samples 如实报）', () => {
    const model = new Map([['270042', new Map([['2026-11-05', 1]])]])
    const navs = new Map([['270042', [{ date: '2026-11-06', pct: 1 }]]])
    const fit = fitSlot(model, navs)
    expect(fit.slot).toBe(1)
    expect(fit.samples).toBe(1)
  })
})
