import { describe, it, expect } from 'vitest'
import { weightChip } from '../../web/weightChip'

// 这几句文案的区别不是文风，是「下一步做什么」：
// 取数失败等重试会自己好，配置缺失不改配置永远不会好，涨跌幅缺失数字会漂。
// 说错一句，用户就去修一个没坏的东西。
describe('weightChip', () => {
  it('指数口径齐全 → 不打扰（口径正常就没有提示）', () => {
    expect(
      weightChip({ weightsFrom: 'index', indexPctAvailable: true, indexWeightsUnavailable: false }),
    ).toBeNull()
  })

  it('配了指数却拉不到成分 → 说「获取失败」，不甩锅给配置', () => {
    expect(
      weightChip({ weightsFrom: 'top10', indexPctAvailable: false, indexWeightsUnavailable: true }),
    ).toEqual({ tone: 'warn', text: '指数成分获取失败，暂用前十大' })
  })

  it('压根没配指数 → 说「未配置」，提示去填配置', () => {
    expect(
      weightChip({ weightsFrom: 'top10', indexPctAvailable: false, indexWeightsUnavailable: false }),
    ).toEqual({ tone: 'warn', text: '未配置跟踪指数，估值偏保守' })
  })

  it('成分是指数的、涨跌幅却自算 → 提醒数字会漂', () => {
    expect(
      weightChip({ weightsFrom: 'index', indexPctAvailable: false, indexWeightsUnavailable: false }),
    ).toEqual({ tone: 'warn', text: '指数口径不可用，当前为成分加权' })
  })

  it('连持仓都没有 → 最严重一级（bad），不是 warn', () => {
    expect(weightChip({ weightsFrom: 'none', indexPctAvailable: false, indexWeightsUnavailable: false }))
      .toEqual({ tone: 'bad', text: '未取到持仓，无法估值' })
  })

  it('标记与权重来源矛盾时以权重来源为准（资金规模为零的脏状态也不该冒出失败文案）', () => {
    expect(
      weightChip({ weightsFrom: 'index', indexPctAvailable: true, indexWeightsUnavailable: true }),
    ).toBeNull()
  })
})
