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

  it('双股权类公司只计一次市值（GOOGL/GOOG 不能各算一遍）', () => {
    const w = weightsFromMarketCap([
      { symbol: 'GOOGL', marketCap: 1000, name: 'Alphabet Inc.' },
      { symbol: 'GOOG', marketCap: 1000, name: 'Alphabet Inc.' },
      { symbol: 'AAPL', marketCap: 3000, name: 'Apple Inc.' },
    ])
    expect(w.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 6)
    // 公司市值 1000 均分给两个类别：各 500；AAPL 3000 → 总和 4000
    expect(w.find((x) => x.symbol === 'GOOGL')!.weight).toBeCloseTo(0.125, 6)
    expect(w.find((x) => x.symbol === 'GOOG')!.weight).toBeCloseTo(0.125, 6)
    expect(w.find((x) => x.symbol === 'AAPL')!.weight).toBeCloseTo(0.75, 6)
  })

  it('真实报文的两类公司名不同（Class A / Class C），仍要并成一组', () => {
    // 2026-11-10 实测：companyName 逐 symbol 不同，仅靠等值分组会静默失效
    const w = weightsFromMarketCap([
      { symbol: 'GOOGL', marketCap: 3574, name: 'Alphabet Inc. Class A Common Stock' },
      { symbol: 'GOOG', marketCap: 3550, name: 'Alphabet Inc. Class C Capital Stock' },
      { symbol: 'AAPL', marketCap: 5077, name: 'Apple Inc. Common Stock' },
    ])
    const combined = w.filter((x) => x.symbol === 'GOOGL' || x.symbol === 'GOOG')
    expect(combined).toHaveLength(2)
    // 组内取最大 3574 再均分，分母 = 1787 + 1787 + 5077
    const expected = 1787 / (1787 + 1787 + 5077)
    expect(w.find((x) => x.symbol === 'GOOGL')!.weight).toBeCloseTo(expected, 6)
    expect(w.find((x) => x.symbol === 'GOOG')!.weight).toBeCloseTo(expected, 6)
    expect(w.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 6)
  })

  it('不同公司名字相近也不能误合并（HON / HONA 是两家公司）', () => {
    const w = weightsFromMarketCap([
      { symbol: 'HON', marketCap: 300, name: 'Honeywell International Inc. Common Stock' },
      { symbol: 'HONA', marketCap: 100, name: 'Honeywell Aerospace Inc. Common Stock' },
    ])
    // 误合并会变成各 150（0.375）；正确是 0.75 / 0.25
    expect(w.find((x) => x.symbol === 'HON')!.weight).toBeCloseTo(0.75, 6)
    expect(w.find((x) => x.symbol === 'HONA')!.weight).toBeCloseTo(0.25, 6)
  })

  it('解析纳斯达克官方 list-type 报文（下标 0 的符号原样保留）', () => {
    const raw = {
      data: { data: { rows: [{ symbol: 'AAPL', marketCap: '5,090,332,710,960', companyName: 'Apple Inc.' }] } },
    }
    expect(parseNasdaqList(raw)).toEqual([{ symbol: 'AAPL', marketCap: 5090332710960, name: 'Apple Inc.' }])
  })
})
