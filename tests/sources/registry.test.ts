import { describe, it, expect } from 'vitest'
import { QuoteRegistry } from '../../src/sources/registry'
import type { QuoteSource } from '../../src/sources/types'
import type { Quote } from '../../src/types'

function fake(
  id: string,
  price: number,
  op: (syms: string[]) => Promise<Quote[]>,
  resolves?: (s: string) => boolean,
) {
  return {
    id, maxBatch: 100, sep: ',', capabilities: ['quote'], fetchQuotes: op,
    ...(resolves ? { resolves } : {}),
  } as QuoteSource
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

  it('主源缺票时缺口交给下一个源补齐，不静默放过', async () => {
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

describe('QuoteRegistry · 单票缺失不再杀死全局（B1）', () => {
  // 实测 160644：持仓同时有美股与港股，港股用东财市场码 116，四个源都报不出来。
  // 旧实现「池化后条数不足即抛 all sources failed」⇒ 所有基金都没有估值。
  it('一只票所有源都取不到时返回其余行情，缺口进 lastMissing 而不抛错', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async (syms) => syms.filter((s) => s !== '00992').map((s) => q(s, 110, 'a'))),
      fake('b', 0, async (syms) => syms.filter((s) => s !== '00992').map((s) => q(s, 111, 'b'))),
    ])
    const r = await reg.getQuotes(['AAPL', '00992'])
    expect([...r.keys()]).toEqual(['AAPL'])
    expect(reg.lastMissing()).toEqual(['00992'])
  })

  it('一条都拿不到时才抛 all sources failed', async () => {
    const reg = new QuoteRegistry([fake('a', 0, async () => [])])
    await expect(reg.getQuotes(['AAPL'])).rejects.toThrow(/all sources failed/)
  })

  it('没有任何源声明能解析整批符号时返回空 Map，不抛错也不记失败', async () => {
    // 纯港股基金：三个美股源都声明取不到（isUsTicker 为 false），东财也没有市场码。
    // 这不是"源挂了"，是"这批票本来就没人能报"，不该 500，也不该把源降级。
    let usCalls = 0
    const usSrc = fake(
      'tencent',
      0,
      async () => {
        usCalls++
        return []
      },
      (s) => !/^\d+$/.test(s),
    )
    const reg = new QuoteRegistry([fake('eastmoney', 0, async () => [], () => false), usSrc])
    const r = await reg.getQuotes(['00992', '03690'])
    expect(r.size).toBe(0)
    expect(usCalls).toBe(0)
    expect(reg.lastMissing()).toEqual(['00992', '03690'])
  })

  it('声明了 resolves 的源只被问它能解析的符号，缺口如实进 lastMissing', async () => {
    const asked: string[][] = []
    const em = fake(
      'eastmoney',
      0,
      async (syms) => {
        asked.push([...syms])
        return syms.map((s) => q(s, 110, 'eastmoney'))
      },
      (s) => s !== '00992',
    )
    const reg = new QuoteRegistry([em])
    const r = await reg.getQuotes(['AAPL', '00992'])
    expect(asked).toEqual([['AAPL']])
    expect([...r.keys()]).toEqual(['AAPL'])
    expect(reg.lastMissing()).toEqual(['00992'])
  })

  it('有人能回而它一条没回，才记它失败并最终降级', async () => {
    let deadCalls = 0
    const reg = new QuoteRegistry([
      fake('dead', 0, async () => {
        deadCalls++
        return []
      }),
      fake('b', 0, async () => [q('AAPL', 111, 'b')]),
      fake('c', 0, async () => [q('AAPL', 112, 'c')]),
    ])
    for (let i = 0; i < 3; i++) await reg.getQuotes(['AAPL'])
    const r = await reg.getQuotes(['AAPL'])
    expect(deadCalls).toBe(3) // 第 4 轮已降级，不再被问
    expect(r.get('AAPL')!.sourceId).toBe('b')
  })
})

describe('QuoteRegistry · pct 有限性（S1）', () => {
  it('pct 非有限的行情被丢弃并计入 lastMissing', async () => {
    const reg = new QuoteRegistry([
      fake('a', 0, async (syms) =>
        syms.map((s) => ({ ...q(s, 110, 'a'), pct: s === 'AAPL' ? NaN : 1.5 })),
      ),
    ])
    const r = await reg.getQuotes(['AAPL', 'MSFT'])
    expect([...r.keys()]).toEqual(['MSFT'])
    expect(reg.lastMissing()).toEqual(['AAPL'])
  })
})

describe('QuoteRegistry · 交叉校验条数断言（S2）', () => {
  // 实测：坏掉的校验源只回 1/3，旧实现把它唯一返回的那只票删掉（无第三方裁决），
  // 而它漏掉的两只反而「未校验通过」——行为完全反了。
  function brokenChecker() {
    let calls = 0
    const src = fake('checker', 0, async () => {
      calls++
      return [q('AAPL', 130, 'checker')] // 只回 1 只，且价格偏差 18%
    })
    return { src, calls: () => calls }
  }

  it('校验源缺票时整体作废交叉校验：不删票、不记冲突', async () => {
    const broken = brokenChecker()
    const reg = new QuoteRegistry([
      fake('a', 0, async (syms) => syms.map((s) => q(s, 110, 'a'))),
      broken.src,
      fake('c', 0, async (syms) => syms.map((s) => q(s, 110.1, 'c'))),
    ])
    const r = await reg.getQuotes(['AAPL', 'MSFT', 'GOOGL'], { crossCheck: true })
    expect([...r.keys()].sort()).toEqual(['AAPL', 'GOOGL', 'MSFT'])
    expect(reg.lastConflicts()).toEqual([])
  })

  it('坏校验源被记失败，连续三次后降级不再被选为校验源', async () => {
    const broken = brokenChecker()
    const reg = new QuoteRegistry([
      fake('a', 0, async (syms) => syms.map((s) => q(s, 110, 'a'))),
      broken.src,
      fake('c', 0, async (syms) => syms.map((s) => q(s, 110.1, 'c'))),
    ])
    for (let i = 0; i < 3; i++) await reg.getQuotes(['AAPL', 'MSFT', 'GOOGL'], { crossCheck: true })
    const r = await reg.getQuotes(['AAPL', 'MSFT', 'GOOGL'], { crossCheck: true })
    expect(broken.calls()).toBe(3) // 第 4 轮换成 c 当校验源
    expect([...r.keys()].sort()).toEqual(['AAPL', 'GOOGL', 'MSFT'])
    expect(reg.lastConflicts()).toEqual([])
  })
})
