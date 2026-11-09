import { describe, it, expect } from 'vitest'
import { parsePosition, resolveHoldingsFrom, type PositionResp } from '../../src/fund/holdings'

// 270042 广发纳指100ETF联接：不持股，只给 ETFCODE（实测报文）
const LINK: PositionResp = {
  Datas: { fundStocks: [], fundboods: [], fundfofs: [], ETFCODE: '159941', ETFSHORTNAME: '纳指ETF广发' },
  Expansion: '2026-09-30',
}

// 159941：真实持仓（实测报文节选）
const ETF: PositionResp = {
  Datas: {
    fundStocks: [
      { GPDM: 'NVDA', GPJC: '英伟达', JZBL: '7.6' },
      { GPDM: 'AAPL', GPJC: '苹果', JZBL: '6.71' },
    ],
    fundboods: [],
    fundfofs: [],
    ETFCODE: null,
  },
  Expansion: '2026-09-30',
}

describe('holdings', () => {
  it('联接基金识别出目标 ETF', () => {
    const p = parsePosition(LINK)
    expect(p.targetEtf).toBe('159941')
    expect(p.holdings).toHaveLength(0)
  })

  it('ETF 持仓权重转成 0~1 小数', () => {
    const p = parsePosition(ETF)
    expect(p.targetEtf).toBeNull()
    expect(p.holdings[0]).toMatchObject({ symbol: 'NVDA', weight: 0.076 })
  })

  it('联接基金递归查到 ETF 的持仓', async () => {
    const fetchPosition = async (code: string) => (code === '270042' ? LINK : ETF)
    const r = await resolveHoldingsFrom('270042', fetchPosition)
    expect(r.holdings.map((h) => h.symbol)).toEqual(['NVDA', 'AAPL'])
    expect(r.viaEtf).toBe('159941')
  })

  it('ETF 也拿不到时返回空持仓而不是抛错', async () => {
    const fetchPosition = async () => ({ Datas: { fundStocks: [], fundboods: [], fundfofs: [], ETFCODE: null } })
    const r = await resolveHoldingsFrom('000000', fetchPosition)
    expect(r.holdings).toEqual([])
  })

  it('JZBL 为空串时丢弃该条，不收下 0 权重', () => {
    const p = parsePosition({
      Datas: { fundStocks: [{ GPDM: 'X', GPJC: 'X', JZBL: '' }], fundboods: [], fundfofs: [] },
    })
    expect(p.holdings).toHaveLength(0)
  })
})
