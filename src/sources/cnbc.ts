import type { MarketSnapshot, MarketStatus, Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const BASE = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'

interface RawQuote {
  symbol?: string
  last?: string
  change_pct?: string
  previous_day_closing?: string
  last_time?: string
  curmktstatus?: string
  realTime?: string
}

function num(s?: string): number {
  if (!s) return NaN
  return Number(s.replace(/[+%,]/g, ''))
}

/**
 * CNBC 的时间是 ISO 带偏移但**不带冒号**（`...T12:36:30.292-0500`）。
 * V8 能容错解析，但这不是规范 ISO 8601；显式补上冒号，避免换运行时后静默变 NaN。
 */
function timeMs(s?: string): number {
  if (!s) return Date.now()
  const normalized = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  return Date.parse(normalized)
}

export function normalizeStatus(s?: string): MarketStatus {
  switch (s) {
    case 'PRE_MKT':
    case 'REG_MKT':
    case 'POST_MKT':
    case 'CLOSED':
      return s
    default:
      return 'CLOSED'
  }
}

export function parseCnbc(raw: any): Quote[] {
  const list: RawQuote[] = raw?.FormattedQuoteResult?.FormattedQuote ?? []
  const out: Quote[] = []
  for (const r of list) {
    const price = num(r.last)
    const prevClose = num(r.previous_day_closing)
    if (!r.symbol || !Number.isFinite(price) || !Number.isFinite(prevClose)) continue
    out.push({
      symbol: r.symbol,
      price,
      prevClose,
      pct: num(r.change_pct),
      tsMs: timeMs(r.last_time),
      precision: 2,
      sourceId: 'cnbc',
    })
  }
  return out
}

export function parseStatus(raw: any): MarketStatus {
  const first = raw?.FormattedQuoteResult?.FormattedQuote?.[0]
  return normalizeStatus(first?.curmktstatus)
}

export class CnbcSource implements QuoteSource {
  id = 'cnbc'
  maxBatch = 100
  /** CNBC 只认管道符；用逗号不报错，只静默返回第一条 */
  sep = '|'
  capabilities: Capability[] = ['quote', 'marketStatus', 'prepost']

  private url(symbols: string[]): string {
    const s = encodeURIComponent(symbols.join(this.sep))
    return `${BASE}?symbols=${s}&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json`
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    const want = symbols.slice(0, this.maxBatch)
    if (want.length === 0) return []
    const res = await fetch(this.url(want), { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`cnbc http ${res.status}`)
    const quotes = parseCnbc(await res.json())
    if (quotes.length !== want.length) {
      throw new Error(
        `cnbc incomplete response: want ${want.length}, got ${quotes.length}（检查分隔符是否为 '|'）`,
      )
    }
    return quotes
  }

  async fetchMarketStatus(): Promise<MarketSnapshot> {
    const res = await fetch(this.url(['AAPL']), { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`cnbc status http ${res.status}`)
    const raw = await res.json()
    return { status: parseStatus(raw), tsMs: Date.now(), sourceId: this.id }
  }
}
