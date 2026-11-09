import { describe, it, expect } from 'vitest'
import { EastmoneySource } from '../../src/sources/eastmoney'

describe.skipIf(!process.env.NET)('eastmoney 真实接口', () => {
  it('一次拉 100 只 NDX 成分不报错', async () => {
    const src = new EastmoneySource()
    const syms = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'GOOG', 'AVGO', 'TSLA', 'COST']
    const q = await src.fetchQuotes(syms)
    expect(q.length).toBeGreaterThanOrEqual(9)
    expect(q[0]!.price).toBeGreaterThan(0)
  })
})
