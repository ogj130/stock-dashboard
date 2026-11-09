import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normalizeMarketIndices,
  fetchMarketIndices,
  createMarketIndicesCache,
  MARKET_INDEX_SECIDS,
  type MarketIndex,
} from '../../src/sources/marketIndices'

/** 2026-11-10 实测报文（原样抄下来，缩放口径就靠它对账） */
const RAW = {
  data: {
    diff: [
      { f2: 366079, f3: 32, f4: 1161, f12: '000001', f14: '上证指数' },
      { f2: 1114549, f3: -27, f4: -3029, f12: '399001', f14: '深证成指' },
      { f2: 2521208, f3: 257, f4: 63266, f12: 'NDX', f14: '纳斯达克' },
      { f2: 754917, f3: 234, f4: 17231, f12: 'SPX', f14: '标普500' },
    ],
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('normalizeMarketIndices', () => {
  it('f2/f4 除以 100 得到点位与涨跌点，f3 除以 100 得到百分数', () => {
    const [sh] = normalizeMarketIndices(RAW)
    expect(sh).toEqual({ symbol: '000001', name: '上证指数', value: 3660.79, change: 11.61, pct: 0.32 })
    const ndx = normalizeMarketIndices(RAW)[2]!
    expect(ndx.value).toBeCloseTo(25212.08, 2)
    expect(ndx.change).toBeCloseTo(632.66, 2)
    expect(ndx.pct).toBeCloseTo(2.57, 2)
  })

  it('保持报文顺序（界面按这个顺序从左往右排）', () => {
    expect(normalizeMarketIndices(RAW).map((i) => i.name)).toEqual([
      '上证指数',
      '深证成指',
      '纳斯达克',
      '标普500',
    ])
  })

  it('负值不丢符号：深证成指的跌要留成负数', () => {
    const sz = normalizeMarketIndices(RAW)[1]!
    expect(sz.pct).toBeCloseTo(-0.27, 2)
    expect(sz.change).toBeCloseTo(-30.29, 2)
  })

  it('缺字段 / "-" / 空串的行整行丢弃，绝不产生 NaN 或 0 点', () => {
    const out = normalizeMarketIndices({
      data: {
        diff: [
          { f2: '-', f3: 32, f4: 1161, f12: 'BAD', f14: '破数据' },
          { f2: 366079, f4: 1161, f12: 'NOF3', f14: '缺涨跌幅' },
          { f2: 366079, f3: 32, f4: 1161, f14: '缺代码' },
          { f2: 366079, f3: 32, f4: 1161, f12: '000001' },
          { f2: 366079, f3: 32, f4: 1161, f12: '000001', f14: '上证指数' },
        ],
      },
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.symbol).toBe('000001')
    expect(out.every((i) => Number.isFinite(i.value) && Number.isFinite(i.pct))).toBe(true)
  })

  it('东财整批返回 data:null 时是空数组，不是抛错', () => {
    expect(normalizeMarketIndices({ data: null })).toEqual([])
    expect(normalizeMarketIndices(null)).toEqual([])
  })
})

describe('fetchMarketIndices', () => {
  it('一次请求拿全部四个指数', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(RAW), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const list = await fetchMarketIndices()
    expect(list).toHaveLength(4)
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toContain(`secids=${MARKET_INDEX_SECIDS.join(',')}`)
    expect(url).toContain('fields=f2,f3,f4,f12,f14')
  })

  it('HTTP 失败要抛（由路由降级成空数组），不能静默返回空', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 502 }))
    await expect(fetchMarketIndices()).rejects.toThrow(/502/)
  })
})

describe('createMarketIndicesCache', () => {
  const INDICES: MarketIndex[] = [
    { symbol: '000001', name: '上证指数', value: 3660.79, change: 11.61, pct: 0.32 },
  ]

  it('30 秒内只打一次接口（5 秒轮询不能每轮陪跑）', async () => {
    const fetchIndices = vi.fn(async () => INDICES)
    const cached = createMarketIndicesCache(fetchIndices, 30_000)
    await cached()
    await cached()
    await cached()
    expect(fetchIndices).toHaveBeenCalledTimes(1)
  })

  it('过了 TTL 会重新取一次', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T02:00:00Z'))
    const fetchIndices = vi.fn(async () => INDICES)
    const cached = createMarketIndicesCache(fetchIndices, 30_000)
    await cached()
    vi.setSystemTime(new Date('2026-11-10T02:00:31Z'))
    await cached()
    expect(fetchIndices).toHaveBeenCalledTimes(2)
  })

  it('失败也进缓存：第一次抛，TTL 内后续调用返回空数组不再打接口', async () => {
    const fetchIndices = vi.fn(async () => {
      throw new Error('network down')
    })
    const cached = createMarketIndicesCache(fetchIndices, 30_000)
    await expect(cached()).rejects.toThrow('network down')
    await expect(cached()).resolves.toEqual([])
    await expect(cached()).resolves.toEqual([])
    expect(fetchIndices).toHaveBeenCalledTimes(1)
  })
})
