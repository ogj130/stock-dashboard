import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const BASE = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const FIELDS = 'f2,f3,f12,f13,f14,f18'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export const MARKET = { NASDAQ: 105, NYSE: 106, AMEX: 107 } as const

export function toSecid(symbol: string, market: number): string {
  return `${market}.${symbol}`
}

interface EmRow {
  f2?: number
  f3?: number
  f12?: string
  f13?: number
  f14?: string
  f18?: number
}

interface EmResponse {
  data?: { diff?: EmRow[] } | null
}

/**
 * 东财 push2 的原始行 -> Quote。
 * f2/f18 放大 1000 倍，f3 放大 100 倍；缺关键字段或非有限数的行直接丢弃，绝不产出 NaN。
 */
export function normalizeEastmoney(raw: EmResponse): Quote[] {
  const rows = raw.data?.diff ?? []
  const out: Quote[] = []
  for (const r of rows) {
    const { f2, f3, f12, f18 } = r
    if (!f12 || typeof f2 !== 'number' || typeof f18 !== 'number') continue
    if (!Number.isFinite(f2) || !Number.isFinite(f18)) continue
    out.push({
      symbol: f12,
      price: f2 / 1000,
      prevClose: f18 / 1000,
      pct: (typeof f3 === 'number' && Number.isFinite(f3) ? f3 : 0) / 100,
      tsMs: Date.now(),
      precision: 2,
      sourceId: 'eastmoney',
    })
  }
  return out
}

export class EastmoneySource implements QuoteSource {
  id = 'eastmoney'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote']

  constructor(private marketOf: (symbol: string) => number = () => MARKET.NASDAQ) {}

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return []
    const secids = symbols
      .slice(0, this.maxBatch)
      .map((s) => toSecid(s, this.marketOf(s)))
      .join(',')
    const url = `${BASE}?secids=${secids}&fields=${FIELDS}`
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`eastmoney http ${res.status}`)
    return normalizeEastmoney((await res.json()) as EmResponse)
  }
}
