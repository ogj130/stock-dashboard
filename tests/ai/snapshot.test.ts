import { describe, it, expect } from 'vitest'
import { parseSnapshot } from '../../src/ai/snapshot'

const base = {
  phase: 'live',
  atMs: 1_700_000_000_000,
  totalValue: 250_000,
  totalAmount: 6_800,
  totalAmountPct: 2.81,
  totalHoldingProfit: 28_000,
  totalHoldingPct: 12.6,
  fx: { pair: 'USD/CNY', rate: 6.6675, pct: -0.09 },
  indices: [{ name: '纳斯达克100', pct: 2.28 }],
  funds: [
    {
      code: '270042',
      name: '广发纳指',
      marketValue: 51_335.99,
      amount: 1_043.2,
      pct: 2.07,
      holdingProfit: 16_049,
      coveredWeight: 0.9,
      board: '纳斯达克100',
    },
  ],
  stocks: [{ symbol: 'NVDA', name: '英伟达', weightPct: 10.08, pct: 4.61 }],
  news: [{ title: '费城半导体指数涨幅扩大至7%', tsMs: 1, important: true }],
}

describe('parseSnapshot · 只认界面给的事实', () => {
  it('合法快照原样通过，字段不改口径', () => {
    const { snapshot } = parseSnapshot(base)
    expect(snapshot).toBeDefined()
    expect(snapshot!.funds[0]).toMatchObject({ code: '270042', pct: 2.07, coveredWeight: 0.9 })
    expect(snapshot!.stocks[0]!.symbol).toBe('NVDA')
    expect(snapshot!.news[0]!.important).toBe(true)
    expect(snapshot!.fx!.pair).toBe('USD/CNY')
  })

  it('phase 非法直接拒绝（措辞依赖它）', () => {
    expect(parseSnapshot({ ...base, phase: 'afternoon' }).error).toContain('phase')
  })

  it('一只基金都没有 → 拒绝，而不是让模型分析空气', () => {
    expect(parseSnapshot({ ...base, funds: [] }).error).toContain('基金')
  })

  it('coveredWeight 夹到 0~1，缺字段的行被丢掉', () => {
    const { snapshot } = parseSnapshot({
      ...base,
      funds: [
        { ...base.funds[0], coveredWeight: 3 },
        { code: '', name: 'bad' },
      ],
    })
    expect(snapshot!.funds).toHaveLength(1)
    expect(snapshot!.funds[0]!.coveredWeight).toBe(1)
  })

  it('超长字符串截断、数组截断（别把整页 DOM 塞给模型）', () => {
    const manyNews = Array.from({ length: 20 }, (_, i) => ({ title: `新闻${i}`, tsMs: i, important: false }))
    const { snapshot } = parseSnapshot({
      ...base,
      news: manyNews,
      funds: Array.from({ length: 60 }, (_, i) => ({ ...base.funds[0], code: `F${i}` })),
    })
    expect(snapshot!.news).toHaveLength(8)
    expect(snapshot!.funds).toHaveLength(40)
    expect(snapshot!.news[0]!.title.length).toBeLessThanOrEqual(120)
  })

  it('非对象 / null → 给出可读错误', () => {
    expect(parseSnapshot(null).error).toBeTruthy()
    expect(parseSnapshot('x').error).toBeTruthy()
  })
})
