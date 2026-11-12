import { describe, it, expect } from 'vitest'
import { analysisClock, buildAnalysisSnapshot } from '../../web/analysis'

const fund = {
  code: '270042',
  name: '广发纳指',
  marketValue: 51_335.99,
  amount: 1_043.2,
  navPct: 2.07,
  holdingProfit: 16_049,
  coveredWeight: 0.95,
  board: '纳斯达克100',
}

const input = {
  phase: 'live' as const,
  atMs: 1_700_000_000_000,
  totals: { value: 250_000, amount: 6_800, amountPct: 2.81, holdingProfit: 28_000, holdingPct: 12.6 },
  fx: { pair: 'USD/CNY', rate: 6.6675, pct: -0.09 },
  indices: [{ name: '纳斯达克100', pct: 2.28 }],
  funds: [fund],
  stocks: [{ symbol: 'NVDA', name: '英伟达', weightPct: 10.08, pct: 4.61 }],
  news: [{ title: '半导体走强', tsMs: 1, important: true }],
}

describe('buildAnalysisSnapshot · 前端只搬运已算好的数', () => {
  it('navPct 映射成 pct，其余字段原样', () => {
    const snap = buildAnalysisSnapshot(input)
    expect(snap.funds[0]).toEqual({
      code: '270042',
      name: '广发纳指',
      marketValue: 51_335.99,
      amount: 1_043.2,
      pct: 2.07,
      holdingProfit: 16_049,
      coveredWeight: 0.95,
      board: '纳斯达克100',
    })
    expect(snap.totalAmountPct).toBe(2.81)
    expect(snap.stocks[0]!.symbol).toBe('NVDA')
    expect(snap.news[0]!.important).toBe(true)
  })

  it('空列表也能构建（让服务端去拒绝，前端不预判）', () => {
    const snap = buildAnalysisSnapshot({ ...input, funds: [], stocks: [], news: [] })
    expect(snap.funds).toEqual([])
    expect(snap.phase).toBe('live')
  })
})

describe('analysisClock', () => {
  it('生成时间 → HH:MM，非法值写 —', () => {
    const at = new Date(2026, 10, 12, 14, 32).getTime()
    expect(analysisClock(at)).toBe('14:32')
    expect(analysisClock(Number.NaN)).toBe('—')
  })
})
