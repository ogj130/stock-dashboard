import { describe, it, expect } from 'vitest'
import { QuoteRegistry } from '../../src/sources/registry'
import type { QuoteSource } from '../../src/sources/types'
import type { Quote } from '../../src/types'

function fake(id: string, price: number, op: (syms: string[]) => Promise<Quote[]>) {
  return { id, maxBatch: 100, sep: ',', capabilities: ['quote'], fetchQuotes: op } as QuoteSource
}
const q = (symbol: string, price: number, sourceId: string): Quote => ({
  symbol, price, prevClose: 100, pct: ((price - 100) / 100) * 100, tsMs: Date.now(), precision: 2, sourceId,
})

describe('QuoteRegistry', () => {
  it('主源正常时直接用主源', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),
      fake('b', 0, async () => [q('AAPL', 111, 'b')]),
    ])
    const r = await reg.getQuotes(['AAPL'])
    expect(r.get('AAPL')!.sourceId).toBe('a')
  })

  it('主源连续失败三次后降级到备源', async () => {
    let calls = 0
    const reg = new QuoteRegistry([
      fake('a', 0, async () => { calls++; throw new Error('down') }),
      fake('b', 0, async () => [q('AAPL', 111, 'b')]),
    ])
    for (let i = 0; i < 3; i++) await reg.getQuotes(['AAPL'])
    const r = await reg.getQuotes(['AAPL'])
    expect(calls).toBe(3)
    expect(r.get('AAPL')!.sourceId).toBe('b')
  })

  it('主备偏差超 0.5% 且无第三方裁决时拒绝写入（返回空）', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),
      fake('b', 0, async () => [q('AAPL', 120, 'b')]),
    ])
    const r = await reg.getQuotes(['AAPL'], { crossCheck: true })
    expect(r.has('AAPL')).toBe(false)
    expect(reg.lastConflicts()).toContain('AAPL')
  })

  it('超过 maxBatch 会分片请求，而不是静默截断', async () => {
    let batches = 0
    const reg = new QuoteRegistry([
      fake('a', 0, async (syms) => { batches++; return syms.map((s) => q(s, 110, 'a')) }),
    ])
    // fake 的 maxBatch 是 100
    const syms = Array.from({ length: 150 }, (_, i) => `S${i}`)
    const r = await reg.getQuotes(syms)
    expect(batches).toBe(2)
    expect(r.size).toBe(150)
  })

  it('返回条数少于请求条数时视为失败并降级，不静默放过', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),          // 请求 2 只只回 1 只
      fake('b', 0, async (syms) => syms.map((s) => q(s, 111, 'b'))),
    ])
    const r = await reg.getQuotes(['AAPL', 'MSFT'])
    expect(r.size).toBe(2)
    expect(r.get('MSFT')!.sourceId).toBe('b')
  })

  it('第三方更接近备源时采用备源', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),
      fake('b', 0, async () => [q('AAPL', 112, 'b')]),
      fake('c', 0, async () => [q('AAPL', 111.9, 'c')]),
    ])
    const r = await reg.getQuotes(['AAPL'], { crossCheck: true })
    expect(r.get('AAPL')!.sourceId).toBe('b')
  })

  it('第三方与主源一致时采用主源', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async () => [q('AAPL', 110, 'a')]),
      fake('b', 0, async () => [q('AAPL', 120, 'b')]),
      fake('c', 0, async () => [q('AAPL', 110.1, 'c')]),
    ])
    const r = await reg.getQuotes(['AAPL'], { crossCheck: true })
    expect(r.get('AAPL')!.sourceId).toBe('a')
  })
})
