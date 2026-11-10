import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normalizeMarketIndices,
  fetchMarketIndices,
  fetchSinaIndices,
  createMarketIndicesCache,
  parseSinaIndices,
  mergeMarketIndices,
  coversAllIndices,
  MARKET_INDEX_SECIDS,
  MARKET_INDEX_SPECS,
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

/**
 * 新浪备用源。它一套报文里两种字段布局，是全链路最容易读错的地方：
 * 美股指数（gb_）把涨跌幅放在 [2]、涨跌额放在 [4]；A 股指数（s_）点位在 [1]、
 * 涨跌额在 [2]、涨跌幅在 [3]。错一位就会把 +3.40% 读成 917.63。
 *
 * 下面的原文是 2026-11-10 14:56 CST（美股已闭市）实测抄下来的。
 */
const SINA_RAW = [
  'var hq_str_gb_ndx="纳斯达克100,27907.6251,3.40,2026-11-10 06:30:00,917.6336,27263.4269,28025.7744,27227.5335";',
  'var hq_str_gb_$inx="标普500指数,7549.9399,2.35,2026-11-10 06:13:19,173.0800,7422.2402,7577.3901,7422.2402";',
  'var hq_str_s_sh000001="上证指数,3667.8157,7.0240,0.19,3574899,60224721";',
  'var hq_str_s_sz399001="深证成指,11245.62,100.132,0.90,463904991,73972881";',
].join('\n')

/**
 * 同一份报文按 GBK 编码后的字节（新浪是 GBK，UTF-8 直接读会把中文名解成乱码）。
 * 用 ArrayBuffer 而不是 Uint8Array：Response 的 BodyInit 不接受裸 typed array。
 */
const SINA_GBK_B64 =
  'dmFyIGhxX3N0cl9nYl9uZHg9IsTJy7m077/LMTAwLDI3OTA3LjYyNTEsMy40MCwyMDI2LTExLTEwIDA2OjMwOjAwLDkxNy42MzM2LDI3MjYzLjQyNjkiOwp2YXIgaHFfc3RyX2diXyRpbng9IrHqxtU1MDDWuMr9LDc1NDkuOTM5OSwyLjM1LDIwMjYtMTEtMTAgMDY6MTM6MTksMTczLjA4MDAsNzQyMi4yNDAyIjsKdmFyIGhxX3N0cl9zX3NoMDAwMDAxPSLJz9ak1rjK/SwzNjY3LjgxNTcsNy4wMjQwLDAuMTksMzU3NDg5OSw2MDIyNDcyMSI7CnZhciBocV9zdHJfc19zejM5OTAwMT0iye7WpLPJ1rgsMTEyNDUuNjIsMTAwLjEzMiwwLjkwLDQ2MzkwNDk5MSw3Mzk3Mjg4MSI7Cg=='

const sinaBytes = (): ArrayBuffer => {
  const buf = Buffer.from(SINA_GBK_B64, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** 东财四条齐全时的报文（f12 是 'NDX100'：注意别用 100.NDX，那是纳斯达克综合） */
const RAW_FULL = {
  data: {
    diff: [
      { f2: 366079, f3: 32, f4: 1161, f12: '000001', f14: '上证指数' },
      { f2: 1114549, f3: -27, f4: -3029, f12: '399001', f14: '深证成指' },
      { f2: 2790762, f3: 340, f4: 91763, f12: 'NDX100', f14: '纳斯达克100' },
      { f2: 754993, f3: 235, f4: 17307, f12: 'SPX', f14: '标普500' },
    ],
  },
}

/** 按 URL 分派的 fetch 桩：东财与新浪各给一个应答，任何别的地址都算测试写错了 */
function stubSources(eastmoney: () => Response | Promise<Response>, sina: () => Response | Promise<Response>) {
  const calls: string[] = []
  const mock = vi.fn(async (url: string) => {
    calls.push(String(url))
    if (String(url).includes('push2.eastmoney.com')) return eastmoney()
    if (String(url).includes('hq.sinajs.cn')) return sina()
    throw new Error(`unexpected url: ${String(url)}`)
  })
  vi.stubGlobal('fetch', mock)
  return { mock, calls }
}

describe('parseSinaIndices · 两种字段布局', () => {
  it('gb_ 读 [1]点位 [2]涨跌幅% [4]涨跌额；s_ 读 [1]点位 [2]涨跌额 [3]涨跌幅%', () => {
    const list = parseSinaIndices(SINA_RAW)
    expect(list).toEqual([
      { symbol: '000001', name: '上证指数', value: 3667.8157, change: 7.024, pct: 0.19 },
      { symbol: '399001', name: '深证成指', value: 11245.62, change: 100.132, pct: 0.9 },
      { symbol: 'NDX100', name: '纳斯达克100', value: 27907.6251, change: 917.6336, pct: 3.4 },
      { symbol: 'SPX', name: '标普500', value: 7549.9399, change: 173.08, pct: 2.35 },
    ])
  })

  it('symbol 用规范表的稳定代码（NDX100 / SPX），不吃新浪的名字', () => {
    const list = parseSinaIndices(SINA_RAW)
    expect(list.map((i) => i.symbol)).toEqual(['000001', '399001', 'NDX100', 'SPX'])
    // 新浪把标普500叫「标普500指数」，前缀匹配会对不上，所以名称固定用规范表的值
    expect(list.find((i) => i.symbol === 'SPX')!.name).toBe('标普500')
  })

  it('缺行 / 空报文体 / 点位为 0 的条目整行丢弃，绝不产出 NaN 或 0 点', () => {
    const onlyNdx = 'var hq_str_gb_ndx="纳斯达克100,27907.6251,3.40,2026-11-10 06:30:00,917.6336";'
    expect(parseSinaIndices(onlyNdx).map((i) => i.symbol)).toEqual(['NDX100'])

    const broken = [
      'var hq_str_gb_ndx="";',
      'var hq_str_gb_$inx="标普500指数,0.0000,0.00,2026-11-10 06:13:19,0.0000";',
      'var hq_str_s_sh000001="上证指数,,,";',
      'var hq_str_s_sz399001="深证成指,11245.62,100.132,0.90,463904991,73972881";',
    ].join('\n')
    const list = parseSinaIndices(broken)
    expect(list.map((i) => i.symbol)).toEqual(['399001'])
    expect(list.every((i) => Number.isFinite(i.value) && Number.isFinite(i.pct) && Number.isFinite(i.change))).toBe(
      true,
    )
  })

  it('缺涨跌额时由昨收恒等式反算 change = value·pct/(100+pct)', () => {
    const raw = [
      'var hq_str_gb_ndx="纳斯达克100,110.0000,10.00,2026-11-10 06:30:00,,27263.4269";',
      'var hq_str_s_sh000001="上证指数,110.0000,,10.00,3574899,60224721";',
    ].join('\n')
    const list = parseSinaIndices(raw)
    // 110 / 1.10 = 100（昨收），涨跌额 = 10
    expect(list.find((i) => i.symbol === 'NDX100')!.change).toBeCloseTo(10, 6)
    expect(list.find((i) => i.symbol === '000001')!.change).toBeCloseTo(10, 6)
  })

  it('pct = -100（昨收为 0）时既无反算式也无涨跌额 → 整行丢弃，不写 Infinity', () => {
    const raw = 'var hq_str_gb_ndx="纳斯达克100,100.0000,-100.00,2026-11-10 06:30:00,";'
    expect(parseSinaIndices(raw)).toEqual([])
  })

  it('忽略规范表外的代码', () => {
    const raw =
      'var hq_str_gb_aapl="苹果,350.6900,2.43,2026-11-10 09:30:10,8.3200";\n' +
      'var hq_str_s_sh000001="上证指数,3667.8157,7.0240,0.19,3574899,60224721";'
    expect(parseSinaIndices(raw).map((i) => i.symbol)).toEqual(['000001'])
  })
})

describe('fetchSinaIndices', () => {
  it('一次请求四条，带 Referer，GBK 由调用方解码', async () => {
    const labels: string[] = []
    class RecordingDecoder extends TextDecoder {
      constructor(label?: string, options?: TextDecoderOptions) {
        super(label, options)
        labels.push(String(label))
      }
    }
    vi.stubGlobal('TextDecoder', RecordingDecoder)
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('referer')).toBe('https://finance.sina.com.cn')
      return new Response(sinaBytes(), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const list = await fetchSinaIndices()
    // 一个请求四条（顺序按规范表，回包靠代码取，不依赖顺序）
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url.startsWith('https://hq.sinajs.cn/list=')).toBe(true)
    expect(url.split('list=')[1]!.split(',')).toEqual(['s_sh000001', 's_sz399001', 'gb_ndx', 'gb_$inx'])
    expect(labels).toContain('gbk')
    expect(list).toHaveLength(4)
    expect(list.find((i) => i.symbol === 'NDX100')).toMatchObject({ value: 27907.6251, pct: 3.4 })
  })

  it('HTTP 失败要抛（由 fetchMarketIndices 决定是否忽略这条腿）', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }))
    await expect(fetchSinaIndices()).rejects.toThrow(/sina index http 500/)
  })
})

describe('mergeMarketIndices · 部分结果合并而不是丢弃', () => {
  const em: MarketIndex[] = [
    { symbol: 'NDX100', name: '纳斯达克', value: 25212.08, change: 632.66, pct: 2.57 },
    { symbol: 'UNKNOWN', name: '表外的', value: 1, change: 0.01, pct: 1 },
  ]
  const sina: MarketIndex[] = [
    { symbol: '000001', name: '上证指数', value: 3667.8157, change: 7.024, pct: 0.19 },
    { symbol: '399001', name: '深证成指', value: 11245.62, change: 100.132, pct: 0.9 },
    { symbol: 'NDX100', name: '纳斯达克100', value: 27907.6251, change: 917.6336, pct: 3.4 },
    { symbol: 'SPX', name: '标普500', value: 7549.9399, change: 173.08, pct: 2.35 },
  ]

  it('同 symbol 主源优先，顺序按规范表（界面顺序不随来源跳）', () => {
    const merged = mergeMarketIndices(em, sina)
    expect(merged.map((i) => i.symbol)).toEqual(['000001', '399001', 'NDX100', 'SPX', 'UNKNOWN'])
    // NDX100 来自东财（主源），不被新浪覆盖
    expect(merged.find((i) => i.symbol === 'NDX100')!.value).toBe(25212.08)
  })

  it('coversAllIndices 只认规范表四条', () => {
    expect(coversAllIndices(sina)).toBe(true)
    expect(coversAllIndices(sina.slice(0, 3))).toBe(false)
    // NDX100 有就行，名字/来源无所谓（东财那行的 name 是「纳斯达克」）
    expect(coversAllIndices([...sina.filter((i) => i.symbol !== 'NDX100'), em[0]!])).toBe(true)
    expect(coversAllIndices([])).toBe(false)
  })

  it('规范表正好是界面需要的四条（守卫：加行/改代码时别忘改 INDEX_SYMBOL）', () => {
    expect(MARKET_INDEX_SPECS.map((s) => s.symbol)).toEqual(['000001', '399001', 'NDX100', 'SPX'])
  })
})

describe('fetchMarketIndices · 东财为主，新浪补缺', () => {
  it('东财四条齐全就不打新浪（省一个请求）', async () => {
    const { calls } = stubSources(
      () => new Response(JSON.stringify(RAW_FULL), { status: 200 }),
      () => new Response(sinaBytes(), { status: 200 }),
    )
    const list = await fetchMarketIndices()
    expect(list).toHaveLength(4)
    expect(calls).toHaveLength(1)
  })

  it('东财闭市后回空 body（实测的真实故障）→ 新浪一次补齐四条', async () => {
    const { calls } = stubSources(
      () => new Response('', { status: 200 }),
      () => new Response(sinaBytes(), { status: 200 }),
    )
    const list = await fetchMarketIndices()
    expect(calls[0]).toContain('push2.eastmoney.com')
    expect(calls[1]).toContain('hq.sinajs.cn')
    expect(list.map((i) => i.symbol)).toEqual(['000001', '399001', 'NDX100', 'SPX'])
    // 这条就是用户看到的那个数：闭市后 NDX100 必须还在，否则纳指基金静默换口径
    expect(list.find((i) => i.symbol === 'NDX100')!.pct).toBeCloseTo(3.4, 6)
  })

  it('东财只回一条 → 与新浪合并（主源那一行保留，缺的三行补上）', async () => {
    stubSources(
      () =>
        new Response(
          JSON.stringify({
            data: { diff: [{ f2: 366079, f3: 32, f4: 1161, f12: '000001', f14: '上证指数' }] },
          }),
          { status: 200 },
        ),
      () => new Response(sinaBytes(), { status: 200 }),
    )
    const list = await fetchMarketIndices()
    expect(list.map((i) => i.symbol)).toEqual(['000001', '399001', 'NDX100', 'SPX'])
    expect(list.find((i) => i.symbol === '000001')!.value).toBeCloseTo(3660.79, 2) // 东财的数字
    expect(list.find((i) => i.symbol === 'NDX100')!.pct).toBeCloseTo(3.4, 6) // 新浪补的
  })

  it('新浪挂了但东财有部分 → 返回那部分，不把已有结果丢掉', async () => {
    stubSources(
      () =>
        new Response(
          JSON.stringify({
            data: {
              diff: [
                { f2: 366079, f3: 32, f4: 1161, f12: '000001', f14: '上证指数' },
                { f2: 1114549, f3: -27, f4: -3029, f12: '399001', f14: '深证成指' },
              ],
            },
          }),
          { status: 200 },
        ),
      () => new Response('boom', { status: 500 }),
    )
    const list = await fetchMarketIndices()
    expect(list.map((i) => i.symbol)).toEqual(['000001', '399001'])
  })

  it('两个源都挂 → 抛错（路由把它降级成空数组 + warn），缓存随即吐空数组', async () => {
    stubSources(
      () => new Response('boom', { status: 502 }),
      () => new Response('boom', { status: 500 }),
    )
    await expect(fetchMarketIndices()).rejects.toThrow(/502/)

    const cached = createMarketIndicesCache(async () => fetchMarketIndices(), 30_000)
    await expect(cached()).rejects.toThrow(/502/)
    await expect(cached()).resolves.toEqual([])
  })

  it('两个源都「诚实地没有数据」（东财空 body + 新浪空报文体）→ 空数组，不抛错', async () => {
    stubSources(
      () => new Response(JSON.stringify({ data: null }), { status: 200 }),
      () => new Response('var hq_str_gb_ndx="";', { status: 200 }),
    )
    await expect(fetchMarketIndices()).resolves.toEqual([])
  })
})
