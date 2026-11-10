import { describe, it, expect } from 'vitest'
import { findExtrema, windowExtremes } from '../../web/extrema'

/**
 * 图表上的极值标记。两条线分开测，因为它们回答的是不同问题：
 * 「这一屏最高/最低是多少」永远有答案；「哪里是转折点」需要去噪，否则一段横盘
 * 能标出几十个"局部最高"，图就没法看了。
 */

describe('windowExtremes', () => {
  it('给出窗口内的最高与最低', () => {
    const r = windowExtremes([1, 5, 3, -2, 4])
    expect(r.peak).toEqual({ index: 1, value: 5 })
    expect(r.trough).toEqual({ index: 3, value: -2 })
  })

  it('并列时取最早出现的那个（后到的不是"又冲了一次"）', () => {
    const r = windowExtremes([0, 9, 1, 9])
    expect(r.peak).toEqual({ index: 1, value: 9 })
  })

  it('空数组给 null，不造 0', () => {
    expect(windowExtremes([])).toEqual({ peak: null, trough: null })
  })

  it('NaN 不参与比较', () => {
    const r = windowExtremes([1, Number.NaN, 3])
    expect(r.peak).toEqual({ index: 2, value: 3 })
  })
})

describe('findExtrema', () => {
  it('单调上升没有转折（不该给任何点）', () => {
    expect(findExtrema([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([])
  })

  it('一条水平线没有转折（span=0 时不能把所有点都算成转折）', () => {
    expect(findExtrema([5, 5, 5, 5, 5, 5, 5])).toEqual([])
  })

  it('先涨后跌给出一个峰', () => {
    const got = findExtrema([0, 1, 2, 3, 4, 5, 4, 3, 2, 1])
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ kind: 'peak', index: 5, value: 5 })
  })

  it('起伏走完一轮：峰 → 谷 → 峰', () => {
    const got = findExtrema([0, 2, 4, 6, 4, 2, 0, 2, 4, 6, 4, 2, 0])
    expect(got.map((e) => e.kind)).toEqual(['peak', 'trough', 'peak'])
    expect(got.map((e) => e.index)).toEqual([3, 6, 9])
  })

  it('小抖动被阈值滤掉（否则 30 秒一个点能标出几十个）', () => {
    // 主体是 0→10 的上涨，中间掺 ±0.3 的噪声；阈值 12% × 10 = 1.2，噪声不该成峰
    const noisy = [0, 0.3, 1, 0.8, 2, 2.3, 3, 2.9, 5, 5.3, 7, 6.8, 9, 10]
    const got = findExtrema(noisy, { ratio: 0.12 })
    expect(got).toHaveLength(0)
  })

  it('端点不算转折点（首尾由 windowExtremes 负责）', () => {
    const got = findExtrema([9, 1, 2, 3, 4, 5, 6, 7, 8])
    // 末尾是最高点，但它是窗口边界，不该被标成"峰"
    expect(got.every((e) => e.index > 0 && e.index < 8)).toBe(true)
  })

  it('点太少时不给结论', () => {
    expect(findExtrema([1, 5, 1])).toEqual([])
  })

  it('超过 limit 时按落差挑重点，再按时间排回去', () => {
    // 造 8 个幅度递减的来回，limit=3 时只留最大的三个
    const vals: number[] = []
    for (let k = 0; k < 8; k++) {
      const amp = 10 - k
      vals.push(vals.length === 0 ? 0 : vals[vals.length - 1]!)
      vals.push(vals[vals.length - 1]! + amp)
      vals.push(vals[vals.length - 1]! - amp)
    }
    const got = findExtrema(vals, { limit: 3, ratio: 0.05 })
    expect(got).toHaveLength(3)
    expect(got.map((e) => e.index)).toEqual([...got.map((e) => e.index)].sort((a, b) => a - b))
  })
})
