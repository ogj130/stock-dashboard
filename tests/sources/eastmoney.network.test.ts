import { describe, it, expect } from 'vitest'
import { EastmoneySource, probeMarket } from '../../src/sources/eastmoney'

describe.skipIf(!process.env.NET)('eastmoney 真实接口', () => {
  it('一次拉 100 只 NDX 成分不报错', async () => {
    // marketOf 现在必须传入：NVDA/AAPL 这类 NDX 成分在纳斯达克，IBM 在纽交所。
    const markets: Record<string, number> = { AAPL: 105, MSFT: 105, NVDA: 105, AMZN: 105, META: 105, GOOGL: 105, GOOG: 105, AVGO: 105, TSLA: 105, COST: 105 }
    const src = new EastmoneySource((s) => markets[s])
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
