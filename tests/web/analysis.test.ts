import { describe, it, expect } from 'vitest'
import { analysisClock, buildAnalysisSnapshot, relatedSymbols, sessionClock } from '../../web/analysis'

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
      navDate: null,
      sessionsSinceNav: 0,
    })
    expect(snap.totalAmountPct).toBe(2.81)
    expect(snap.stocks[0]!.symbol).toBe('NVDA')
    expect(snap.news[0]!.important).toBe(true)
    // 板块权重按基金市值聚合，给模型挂「半导体/纳指」类事件用
    expect(snap.boards).toEqual([{ name: '纳斯达克100', weightPct: 20.53 }])
    // 贡献 pp = 权重 × 涨跌 / 100：10.08 × 4.61 / 100 ≈ 0.46
    expect(snap.analytics.topContributors[0]).toMatchObject({ symbol: 'NVDA', contributionPp: 0.465 })
    expect(snap.analytics.concentration.top3WeightPct).toBe(10.08)
    expect(snap.analytics.coverage).toEqual({ coveredFunds: 1, blindFunds: 0, coveredValuePct: 20.53 })
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


describe('时间上下文 · 盘前的指数/个股不是「今天」', () => {
  it('phase=pre 时 indices/stocks 标注「上一交易日收盘」，clock 带北京与美东', () => {
    const at = new Date('2026-11-12T12:31:00Z').getTime()
    const snap = buildAnalysisSnapshot({ ...input, phase: 'pre', atMs: at })
    expect(snap.clock.local).toBe('2026-11-12 20:31')
    expect(snap.clock.et).toContain('07:31')
    expect(snap.clock.session).toContain('盘前')
    expect(snap.clock.note).toContain('上一交易日收盘')
    expect(snap.indices[0]!.asOf).toBe('上一交易日收盘')
    expect(snap.stocks[0]!.asOf).toBe('上一交易日收盘')
  })

  it('盘中时 asOf 是「当前时段」', () => {
    const snap = buildAnalysisSnapshot({ ...input, phase: 'live' })
    expect(snap.indices[0]!.asOf).toBe('当前时段')
    expect(snap.clock.note).toContain('盘中')
  })

  it('sessionClock 三档文案', () => {
    expect(sessionClock('settled', 0).session).toContain('已收盘')
  })
})

describe('relatedSymbols · 事件命中持仓', () => {
  const stocks = [
    { symbol: 'NVDA', name: '英伟达', weightPct: 10, pct: 1 },
    { symbol: 'MU', name: '美光科技', weightPct: 3, pct: 2 },
  ]

  it('中文名包含、ticker 词边界都能命中', () => {
    expect(relatedSymbols('英伟达盘前涨 2%', stocks)).toEqual(['NVDA'])
    expect(relatedSymbols('MU 与 NVDA 领涨半导体', stocks)).toEqual(['NVDA', 'MU'])
  })

  it('拼写相近不算命中', () => {
    expect(relatedSymbols('NVDIA 的传闻', stocks)).toEqual([])
  })
})
