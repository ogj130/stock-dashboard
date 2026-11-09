import { describe, it, expect } from 'vitest'
import { EastmoneySource, probeMarket } from '../../src/sources/eastmoney'

describe.skipIf(!process.env.NET)('eastmoney 真实接口', () => {
  it('一次拉 100 只 NDX 成分不报错', async () => {
    const src = new EastmoneySource()
    const syms = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'GOOG', 'AVGO', 'TSLA', 'COST']
    const q = await src.fetchQuotes(syms)
    expect(q.length).toBeGreaterThanOrEqual(9)
    expect(q[0]!.price).toBeGreaterThan(0)
  })

  it('能探测出 NYSE 的票与 NASDAQ 的票', async () => {
    expect(await probeMarket('AAPL')).toBe(105)
    expect(await probeMarket('IBM')).toBe(106)
  })
})
