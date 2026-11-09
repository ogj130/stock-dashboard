import { describe, it, expect } from 'vitest'
import { weightsFromMarketCap, parseNasdaqList } from '../../src/fund/indexWeight'

describe('indexWeight', () => {
  it('按市值占比算权重，总和为 1', () => {
    const w = weightsFromMarketCap([
      { symbol: 'A', marketCap: 600 },
      { symbol: 'B', marketCap: 300 },
      { symbol: 'C', marketCap: 100 },
    ])
    expect(w.find((x) => x.symbol === 'A')!.weight).toBeCloseTo(0.6, 6)
    expect(w.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 6)
  })

  it('市值缺失或为 0 的成分被剔除，避免 NaN 权重', () => {
    const w = weightsFromMarketCap([
      { symbol: 'A', marketCap: 100 },
      { symbol: 'B', marketCap: 0 },
      { symbol: 'C', marketCap: NaN },
    ])
    expect(w).toHaveLength(1)
  })

  it('解析纳斯达克官方 list-type 报文（下标 0 的符号原样保留）', () => {
    const raw = {
      data: { data: { rows: [{ symbol: 'AAPL', marketCap: '5,090,332,710,960', companyName: 'Apple Inc.' }] } },
    }
    expect(parseNasdaqList(raw)).toEqual([{ symbol: 'AAPL', marketCap: 5090332710960, name: 'Apple Inc.' }])
  })
})
