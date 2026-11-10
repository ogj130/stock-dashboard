import { describe, it, expect } from 'vitest'
import { applyPreView, preViewFunds } from '../../web/preView'

/**
 * 盘前视图唯一容易算错的地方：两段涨跌是**串起来**的，不是替换。
 * 收盘口径估的是上一场美股，盘前是从那个收盘价往后走的另一段。
 * 这里钉住的就是「别把上一场的涨幅抹掉」。
 */
const fund = {
  nav: 7,
  shares: 1000,
  costBasis: 6000,
  navPct: 3,      // 上一场收盘 +3%
  amount: 210,    // 7000 × 3%
  marketValue: 7210,
  holdingProfit: 1210,
  preMarket: { navPct: -0.5, amount: 0, basis: 'index' as const },
}

describe('applyPreView', () => {
  it('市值 = 收盘估值市值 × (1 + 盘前)，上一场涨幅不能被抹掉', () => {
    const v = applyPreView(fund)
    expect(v.marketValue).toBeCloseTo(7210 * 0.995, 6)
    // 若误写成 nav × shares × (1 + 盘前) 会得到 6965，差 208 元
    expect(v.marketValue).not.toBeCloseTo(7000 * 0.995, 2)
  })

  it('金额 = 盘前这一段自己的盈亏（基准是收盘时的价值）', () => {
    const v = applyPreView(fund)
    expect(v.amount).toBeCloseTo(7210 * -0.005, 6)
    // 不能直接用后端给的 preMarket.amount：那是相对净值的，不是相对收盘估值
    expect(v.amount).not.toBeCloseTo(7000 * -0.005, 2)
  })

  it('涨跌幅显示盘前那一段，与 chip 文案一致', () => {
    expect(applyPreView(fund).navPct).toBe(-0.5)
  })

  it('持有收益跟着新市值走', () => {
    const v = applyPreView(fund)
    expect(v.holdingProfit).toBeCloseTo(v.marketValue - 6000, 6)
  })

  it('没有盘前读数 → 原样返回（宁可显示昨收，也不能造 0）', () => {
    const noPre = { ...fund, preMarket: undefined }
    expect(applyPreView(noPre)).toEqual(noPre)
  })

  it('批量换算跳过没有盘前读数的基金', () => {
    const list = [fund, { ...fund, preMarket: undefined }]
    const out = preViewFunds(list)
    expect(out[0]!.marketValue).toBeCloseTo(7210 * 0.995, 6)
    expect(out[1]!.marketValue).toBe(7210)
  })
})
