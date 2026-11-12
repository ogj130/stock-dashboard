import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeEastmoney, toSecid, EastmoneySource } from '../../src/sources/eastmoney'

const RAW = {
  data: {
    diff: [
      { f2: 350170, f3: 228, f6: 5671975014, f12: 'AAPL', f13: 105, f14: '苹果', f18: 342370 },
      { f2: 542330, f3: 221, f12: 'MSFT', f13: 105, f14: '微软', f18: 530610 },
    ],
  },
}

describe('eastmoney', () => {
  it('价格放大 1000 倍要还原，涨跌幅放大 100 倍要还原', () => {
    const q = normalizeEastmoney(RAW)[0]!
    expect(q.symbol).toBe('AAPL')
    expect(q.price).toBeCloseTo(350.17, 3)
    expect(q.prevClose).toBeCloseTo(342.37, 3)
    expect(q.pct).toBeCloseTo(2.28, 3)
  })

  it('f6 是当日成交额（不再缩放），缺失时不写键', () => {
    const [aapl, msft] = normalizeEastmoney(RAW)
    expect(aapl!.turnover).toBe(5_671_975_014)
    expect(msft).not.toHaveProperty('turnover')
  })

  it('沪深美股市场码映射正确', () => {
    expect(toSecid('AAPL', 105)).toBe('105.AAPL')
    expect(toSecid('IBM', 106)).toBe('106.IBM')
  })

  it('缺字段的条目被丢弃而不是产生 NaN', () => {
    const q = normalizeEastmoney({ data: { diff: [{ f12: 'X' }] } })
    expect(q).toHaveLength(0)
  })

  // S1：pct 是唯一被产品消费的字段。f3 缺失/为 "-" 时绝不能编成 0%，
  // 否则 NaN 之外又多一种静默污染 Σw·pct 的方式。
  it('f3 缺失或为 "-" 的条目被丢弃，不编成 pct 0', () => {
    const q = normalizeEastmoney({
      data: {
        diff: [
          { f2: 350170, f3: '-', f12: 'SUSP', f13: 105, f18: 342370 },
          { f2: 350170, f12: 'NOF3', f13: 105, f18: 342370 },
          { f2: 350170, f3: 228, f12: 'AAPL', f13: 105, f18: 342370 },
        ],
      },
    })
    expect(q.map((x) => x.symbol)).toEqual(['AAPL'])
  })
})

describe('EastmoneySource · 市场码', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stub(body: unknown): { calls: string[] } {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url))
      return { ok: true, json: async () => body } as unknown as Response
    })
    return { calls }
  }

  // B2：默认猜 105 会让 NYSE 的票整批返回 data:null（实测 162411：猜 105 → 0/10，正确 106 → 10/10）。
  // 未知市场必须跳过该 symbol，而不是猜一个默认值。
  it('市场未知的 symbol 被跳过，不猜 105', async () => {
    const { calls } = stub({ data: { diff: [{ f2: 100000, f3: 100, f12: 'NVDA', f13: 105, f18: 99000 }] } })
    const src = new EastmoneySource((s) => (s === 'NVDA' ? 105 : undefined))
    const got = await src.fetchQuotes(['NVDA', '00992'])
    expect(got.map((x) => x.symbol)).toEqual(['NVDA'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('105.NVDA')
    expect(calls[0]).not.toContain('00992')
    expect(calls[0]).not.toContain('105.00992')
  })

  it('市场码全部未知时不发请求，直接返回空', async () => {
    const { calls } = stub({ data: { diff: [] } })
    const src = new EastmoneySource(() => undefined)
    expect(await src.fetchQuotes(['00992', '03690'])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
