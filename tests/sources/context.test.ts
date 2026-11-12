import { describe, it, expect, vi } from 'vitest'
import { fetchMarketContext, parseSinaFutures } from '../../src/sources/context'

const FUTURES = [
  'var hq_str_hf_NQ="28495.502,,28479.000,28480.250,28652.250,28013.750,02:01:54,28473.250,28306.250,0,1,1,2026-11-13,纳斯达克指数期货,0";',
  'var hq_str_hf_ES="7651.318,,7648.750,7649.000,7674.750,7572.000,02:01:54,7640.500,7616.750,0,12,13,2026-11-13,标普500指数期货,0";',
].join('\n')

// 腾讯 ETF 报文：字段足够 parseTencent 取到 pct；名称用 ASCII，避免测试里做 GBK 编码
const ETFS = [
  'v_usSMH="200~SMH~SMH.OQ~502.65~506.96~485.01~6543466~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026-11-12 13:01:40~-4.31~-0.85~509.80~484.50~USD~";',
  'v_usSOXX="200~SOXX~SOXX.OQ~155.20~155.40~150.47~40475199~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026-11-12 13:01:40~-0.20~-0.13~157.63~150.04~USD~";',
].join('\n')

function response(text: string): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    text: async () => text,
    json: async () => ({}),
  } as unknown as Response
}

describe('parseSinaFutures', () => {
  it('按 0 现价 / 7 昨收算涨跌幅，名称取 13', () => {
    const quotes = parseSinaFutures(FUTURES)
    expect(quotes).toHaveLength(2)
    expect(quotes[0]).toMatchObject({ symbol: 'NQ', name: '纳斯达克指数期货', asOf: '实时' })
    expect(quotes[0]!.pct).toBeCloseTo(0.08, 2)
    expect(quotes[1]!.pct).toBeCloseTo(0.14, 2)
  })

  it('坏行 / 昨收为 0 直接丢弃', () => {
    expect(parseSinaFutures('var hq_str_hf_NQ="1,,,,,,,,0,0,0,2026-01-01,x";')).toEqual([])
    expect(parseSinaFutures('garbage')).toEqual([])
  })
})

describe('fetchMarketContext', () => {
  it('聚合期货 / ETF / 盘前个股，并把盘前腿标成 asOf=盘前', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).includes('sinajs')) return response(FUTURES)
      return response(ETFS)
    })
    const premarketFn = vi.fn(async () => new Map([
      ['SMH', { symbol: 'SMH', price: 500, pct: -1.2, tsMs: 1 }],
      ['NVDA', { symbol: 'NVDA', price: 180, pct: -5, tsMs: 1 }],
    ]))
    const ctx = await fetchMarketContext(
      { phase: 'pre', symbols: ['NVDA'] },
      { fetchFn: fetchFn as unknown as typeof fetch, premarketFn, now: () => 1000, ttlMs: 30_000 },
    )
    expect(ctx.futures.map((f) => f.symbol)).toEqual(['NQ', 'ES'])
    const smh = ctx.etfs.find((e) => e.symbol === 'SMH')!
    expect(smh).toMatchObject({ pct: -1.2, asOf: '盘前' })
    // 没有盘前读数的 ETF 退回常规行情，并如实标「上一交易日收盘」
    const soxx = ctx.etfs.find((e) => e.symbol === 'SOXX')!
    expect(soxx.asOf).toBe('上一交易日收盘')
    expect(ctx.premarketStocks).toEqual([{ symbol: 'NVDA', pct: -5, price: 180 }])
  })

  it('30 秒缓存：同一 phase+symbols 不重复打源', async () => {
    let clock = 0
    const fetchFn = vi.fn(async (url: string) => (String(url).includes('sinajs') ? response(FUTURES) : response(ETFS)))
    const deps = { fetchFn: fetchFn as unknown as typeof fetch, premarketFn: async () => new Map(), now: () => clock, ttlMs: 30_000 }
    await fetchMarketContext({ phase: 'live', symbols: [] }, deps)
    const calls = fetchFn.mock.calls.length
    clock = 10_000
    await fetchMarketContext({ phase: 'live', symbols: [] }, deps)
    expect(fetchFn.mock.calls.length).toBe(calls)
    clock = 31_000
    await fetchMarketContext({ phase: 'live', symbols: [] }, deps)
    expect(fetchFn.mock.calls.length).toBe(calls * 2)
  })

  it('期货源失败不影响 ETF 与盘前', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).includes('sinajs')) throw new Error('down')
      return response(ETFS)
    })
    const ctx = await fetchMarketContext(
      { phase: 'settled', symbols: [] },
      { fetchFn: fetchFn as unknown as typeof fetch, premarketFn: async () => new Map(), now: () => 1, ttlMs: 1 },
    )
    expect(ctx.futures).toEqual([])
    expect(ctx.etfs.length).toBeGreaterThan(0)
  })
})
