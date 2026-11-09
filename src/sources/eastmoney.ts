import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const BASE = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const FIELDS = 'f2,f3,f12,f13,f14,f18'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// 116 是港股：NEWTEXCH 会直接给出它，但本系统只估美股部分（港股行情不参与 Σw·pct），
// 所以 probeMarket 仍然只探美股三个市场。
export const MARKET = { NASDAQ: 105, NYSE: 106, AMEX: 107, HK: 116 } as const

export function toSecid(symbol: string, market: number): string {
  return `${market}.${symbol}`
}

interface EmRow {
  f2?: number | string
  f3?: number | string
  f12?: string
  f13?: number
  f14?: string
  f18?: number | string
}

interface EmResponse {
  data?: { diff?: EmRow[] } | null
}

/**
 * 东财 push2 的原始行 -> Quote。
 * f2/f18 放大 1000 倍，f3 放大 100 倍；缺关键字段或非有限数的行直接丢弃，绝不产出 NaN。
 *
 * f3（当日涨跌幅）缺失或为 "-"（停牌等）时**丢弃整行**：pct 是唯一被产品消费的字段，
 * 补一个 0% 会静默污染 Σw·pct，比缺这只票危险得多。
 */
export function normalizeEastmoney(raw: EmResponse): Quote[] {
  const rows = raw.data?.diff ?? []
  const out: Quote[] = []
  for (const r of rows) {
    const { f2, f3, f12, f14, f18 } = r
    if (!f12 || typeof f2 !== 'number' || typeof f18 !== 'number' || typeof f3 !== 'number') continue
    if (!Number.isFinite(f2) || !Number.isFinite(f18) || !Number.isFinite(f3)) continue
    out.push({
      symbol: f12,
      // f14 是中文简称（「英伟达」「苹果」），界面读起来比 ticker 顺；
      // 腾讯/CNBC 不提供，pipeline 会退回指数报文的英文公司名
      name: typeof f14 === 'string' && f14.trim() ? f14.trim() : undefined,
      price: f2 / 1000,
      prevClose: f18 / 1000,
      pct: f3 / 100,
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

  /**
   * marketOf 必须传入：返回 undefined 表示「市场未知」，该 symbol 本次不发请求。
   * 曾经默认 `() => MARKET.NASDAQ`，结果是 NYSE 的票整批返回 data:null：
   * 实测 162411（全 NYSE）默认 105 → 0/10，正确 106 → 10/10。
   */
  constructor(private marketOf: (symbol: string) => number | undefined) {}

  resolves(symbol: string): boolean {
    return this.marketOf(symbol) !== undefined
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    // 先剔掉市场未知的符号：宁可少问几只，也不能带着猜出来的市场码整批失败
    const resolvable = symbols.filter((s) => this.resolves(s)).slice(0, this.maxBatch)
    if (resolvable.length === 0) return []
    const secids = resolvable.map((s) => toSecid(s, this.marketOf(s)!)).join(',')
    const url = `${BASE}?secids=${secids}&fields=${FIELDS}`
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`eastmoney http ${res.status}`)
    return normalizeEastmoney((await res.json()) as EmResponse)
  }
}

interface ProbeResponse {
  rc?: number
  data?: { total?: number } | null
}

/**
 * 逐市场试一只票，返回能查到它的市场码；三个都查不到返回 null。
 * 必须逐只探测：NYSE 的票放到 105. 前缀会整批返回 data:null（不抛错），
 * 而 105.V 又会被接口自动纠正成 106，随机抽样根本发现不了。
 */
export async function probeMarket(symbol: string): Promise<number | null> {
  for (const market of [MARKET.NASDAQ, MARKET.NYSE, MARKET.AMEX]) {
    try {
      const url = `${BASE}?secids=${toSecid(symbol, market)}&fields=f12`
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      const body = (await res.json()) as ProbeResponse
      if (body?.rc === 0 && (body.data?.total ?? 0) > 0) return market
    } catch {
      // 单个市场探测失败不影响其他市场
    }
  }
  return null
}
