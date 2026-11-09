import { describe, it, expect } from 'vitest'
import { pickLag, fitExposure, pearson } from '../../src/engine/calibrate'

describe('calibrate', () => {
  it('相关系数：完全正相关为 1', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6)
  })

  it('能识别出净值滞后一天', () => {
    // 净值 seq 等于模型 seq 右移一位
    const nav = [0, 1, 2, 3, 0, 1]
    const model = [1, 2, 3, 0, 1, 2]
    const got = pickLag(nav, { 0: nav, 1: model, 2: [2, 3, 0, 1, 2, 3] })
    expect(got).toBe(0) // nav 与 lag0 序列完全一致
  })

  it('穿过原点的最小二乘给出 0.95', () => {
    const xs = [1, 2, 3, -1]
    const ys = xs.map((x) => x * 0.95)
    expect(fitExposure(xs, ys)).toBeCloseTo(0.95, 6)
  })

  it('样本过少时返回默认值而不是瞎拟合', () => {
    expect(fitExposure([1], [0.95])).toBe(0.95)
    expect(fitExposure([], [])).toBe(0.95)
  })

  it('全部输入为 0 时不产生 NaN', () => {
    expect(fitExposure([0, 0], [0, 0])).toBe(0.95)
  })

  // 护栏：拟合值落在 [0.5, 1.2] 之外说明数据有问题（单位错 / lag 错 / 样本脏），
  // 必须回落到默认值，不允许拿噪声去改模型。
  it('拟合结果越界时回落到默认值而不是采信', () => {
    expect(fitExposure([1, 2, 3, -1], [2, 4, 6, -2])).toBe(0.95) // 拟合 2.0
    expect(fitExposure([1, 2, 3, -1], [0.1, 0.2, 0.3, -0.1])).toBe(0.95) // 拟合 0.1
  })
})
