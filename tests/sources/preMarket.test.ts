import { describe, it, expect } from 'vitest'
import {
  PRE_MARKET_CNBC_BATCH,
  PRE_MARKET_TTL_MS,
  createPreMarketFetcher,
  parseCnbcPreMarket,
} from '../../src/sources/preMarket'

/**
 * 盘前这条腿的四条纪律：
 * 1. 只认 `type === 'PRE_MKT'`（盘后时段 exthrs=1 会给 POST_MKT，混进来就是把夜盘价当盘前）
 * 2. 永不抛错：源挂了就是空 Map
 * 3. CNBC 优先、新浪只补缺口（不为已拿到的票再打一次）
 * 4. 阴性结果也缓存，否则源抽风时每 5 秒重打一遍
 */

const NOW = Date.parse('2026-11-10T09:21:00Z')

function cnbcBody(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({ FormattedQuoteResult: { FormattedQuote: rows } })
}

/** 实测报文形状：常规腿 last 是上一交易日收盘，ExtendedMktQuote 才是盘前 */
function row(symbol: string, opts: { type?: string; last?: string; pct?: string; time?: string } = {}) {
  return {
    symbol,
    last: '350.69',
    change_pct: '+2.43%',
    ExtendedMktQuote: {
      type: opts.type ?? 'PRE_MKT',
      source: 'Last NYSE Arca, VOL From CTA',
      last: opts.last ?? '349.80',
      last_time: opts.time ?? '2026-11-10T04:18:35.843-0500',
      change_pct: opts.pct ?? '-0.25%',
    },
  }
}

describe('parseCnbcPreMarket', () => {
  it('取盘前价与盘前涨跌幅，不是常规腿那两个数', () => {
    const [q] = parseCnbcPreMarket(JSON.parse(cnbcBody([row('AAPL')])), NOW)
    expect(q).toMatchObject({ symbol: 'AAPL', price: 349.8, pct: -0.25, prevClose: 350.69 })
  })

  it('POST_MKT 一律丢弃（盘后时段同一字段会变成夜盘）', () => {
    const got = parseCnbcPreMarket(JSON.parse(cnbcBody([row('AAPL', { type: 'POST_MKT' })])), NOW)
    expect(got).toEqual([])
  })

  it('缺涨跌幅 / 价格为 0 的脏行不进结果（Number("") === 0 会骗人）', () => {
    const rows = [
      row('AAPL', { pct: '' }),
      row('MSFT', { last: '0' }),
      row('NVDA'),
    ]
    const got = parseCnbcPreMarket(JSON.parse(cnbcBody(rows)), NOW)
    expect(got.map((q) => q.symbol)).toEqual(['NVDA'])
  })

  it('时间戳把 -0500 补成 -05:00 再解析；解析不出来就退回当前时刻', () => {
    const [ok] = parseCnbcPreMarket(JSON.parse(cnbcBody([row('AAPL')])), NOW)
    expect(ok!.tsMs).toBe(Date.parse('2026-11-10T04:18:35.843-05:00'))
    const [bad] = parseCnbcPreMarket(
      JSON.parse(cnbcBody([row('AAPL', { time: 'not-a-date' })])),
      NOW,
    )
    expect(bad!.tsMs).toBe(NOW)
  })

  it('形状不对（没有 FormattedQuoteResult）→ 空数组，不抛错', () => {
    expect(parseCnbcPreMarket({}, NOW)).toEqual([])
    expect(parseCnbcPreMarket(null, NOW)).toEqual([])
  })
})

describe('createPreMarketFetcher', () => {
  it('CNBC 拿到就不再麻烦新浪', async () => {
    let sinaCalls = 0
    const fetchPre = createPreMarketFetcher({
      readCnbc: async (syms) => cnbcBody(syms.map((s) => row(s))),
      readSina: async () => {
        sinaCalls += 1
        return ''
      },
      now: () => NOW,
    })
    const got = await fetchPre(['AAPL', 'MSFT'])
    expect([...got.keys()].sort()).toEqual(['AAPL', 'MSFT'])
    expect(sinaCalls).toBe(0)
  })

  it('CNBC 缺的票由新浪补齐（盘前字段在 [21][22][24]）', async () => {
    const sinaFields = [
      '苹果', '350.6900', '2.43', '2026-11-10 04:21:31', '8.3200', '344.9950', '352.3300',
      '344.7800', '355.3800', '242.8900', '48753013', '57281347', '5096290905930', '8.30',
      '42.250000', '0.00', '0.00', '0.00', '0.00', '14532182001', '63', '349.8400', '-0.24',
      '-0.85', 'Nov 10 04:21AM EST', 'Nov 09 04:00PM EST', '342.3700', '82110', '1', '2026',
      '17077778235.4219', '351.9485', '349.4500', '28752050.8455', '350.6670', '350.6900',
    ]
    const fetchPre = createPreMarketFetcher({
      // CNBC 只回 AAPL，MSFT 交给新浪
      readCnbc: async () => cnbcBody([row('AAPL')]),
      readSina: async (syms) => {
        expect(syms).toEqual(['MSFT'])
        return `var hq_str_gb_msft="${sinaFields.join(',')}";`
      },
      now: () => NOW,
    })
    const got = await fetchPre(['AAPL', 'MSFT'])
    expect(got.get('AAPL')!.price).toBeCloseTo(349.8, 2)
    expect(got.get('MSFT')!.pct).toBeCloseTo(-0.24, 6)
    // 新浪那条路没有 prevClose 语义保证，别硬塞一个编造的值
    expect(got.get('MSFT')!.price).toBeCloseTo(349.84, 2)
  })

  it('两个源都炸 → 空 Map，绝不抛错（这条腿挂了不该 500）', async () => {
    const fetchPre = createPreMarketFetcher({
      readCnbc: async () => {
        throw new Error('boom')
      },
      readSina: async () => {
        throw new Error('boom too')
      },
      now: () => NOW,
    })
    await expect(fetchPre(['AAPL'])).resolves.toEqual(new Map())
  })

  it('只问美股代码：港股/A 股纯数字先滤掉', async () => {
    const asked: string[][] = []
    const fetchPre = createPreMarketFetcher({
      readCnbc: async (syms) => {
        asked.push(syms)
        return cnbcBody(syms.map((s) => row(s)))
      },
      readSina: async () => '',
      now: () => NOW,
    })
    await fetchPre(['00700', 'AAPL'])
    expect(asked).toEqual([['AAPL']])
  })

  it('缓存生效：TTL 内重复调用不再打源', async () => {
    let calls = 0
    let clock = NOW
    const fetchPre = createPreMarketFetcher({
      readCnbc: async (syms) => {
        calls += 1
        return cnbcBody(syms.map((s) => row(s)))
      },
      readSina: async () => '',
      now: () => clock,
    })
    await fetchPre(['AAPL'])
    clock += PRE_MARKET_TTL_MS - 1
    await fetchPre(['AAPL'])
    expect(calls).toBe(1)
    clock += 2
    await fetchPre(['AAPL'])
    expect(calls).toBe(2)
  })

  it('阴性结果也缓存：没盘前成交的票不会每 5 秒重问一次', async () => {
    let calls = 0
    const fetchPre = createPreMarketFetcher({
      readCnbc: async () => {
        calls += 1
        return cnbcBody([])
      },
      readSina: async () => '',
      now: () => NOW,
    })
    await fetchPre(['AAPL'])
    await fetchPre(['AAPL'])
    expect(calls).toBe(1)
  })

  it('超过一批就分片（CNBC 上限保守取 50）', async () => {
    const batches: number[] = []
    const symbols = Array.from({ length: PRE_MARKET_CNBC_BATCH + 5 }, (_, i) =>
      'S' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)),
    )
    const fetchPre = createPreMarketFetcher({
      readCnbc: async (syms) => {
        batches.push(syms.length)
        return cnbcBody(syms.map((s) => row(s)))
      },
      readSina: async () => '',
      now: () => NOW,
    })
    await fetchPre(symbols)
    expect(batches).toEqual([PRE_MARKET_CNBC_BATCH, 5])
  })
})
