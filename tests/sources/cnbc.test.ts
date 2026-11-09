import { describe, it, expect, vi } from 'vitest'
import { parseCnbc, parseStatus, CnbcSource } from '../../src/sources/cnbc'

const RAW = {
  FormattedQuoteResult: {
    FormattedQuote: [
      {
        symbol: 'AAPL', last: '349.49', change_pct: '+2.08%', previous_day_closing: '342.37',
        last_time: '2026-11-09T12:36:30.292-0500', curmktstatus: 'REG_MKT', realTime: 'true',
      },
    ],
  },
}

describe('cnbc', () => {
  it('解析带符号的百分比字符串', () => {
    expect(parseCnbc(RAW)[0]!.pct).toBeCloseTo(2.08, 2)
    expect(parseCnbc(RAW)[0]!.price).toBeCloseTo(349.49, 2)
  })

  it('解析 ISO 带偏移的时间', () => {
    expect(parseCnbc(RAW)[0]!.tsMs).toBe(Date.parse('2026-11-09T12:36:30.292-05:00'))
  })

  it('市场状态映射', () => {
    expect(parseStatus(RAW)).toBe('REG_MKT')
  })

  it('返回条数少于请求条数时抛错，绝不静默放过', async () => {
    const src = new CnbcSource()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => RAW, // 请求 3 只，只回 1 只
    }))
    await expect(src.fetchQuotes(['AAPL', 'MSFT', 'NVDA'])).rejects.toThrow(/incomplete/i)
    vi.unstubAllGlobals()
  })
})
