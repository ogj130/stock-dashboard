import type { Quote } from '../types'
import { isUsTicker, type Capability, type QuoteSource } from './types'

const BASE = 'https://qt.gtimg.cn/q='
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// 字段索引实测于 2026-11-10，整包共 73 个 '~' 分隔字段
const IDX = { status: 0, name: 1, code: 2, price: 3, prevClose: 4, time: 30, pct: 32 } as const

/**
 * 把 "2026-11-09 12:36:20"（美东）转成毫秒时间戳。
 *
 * 已知局限（有意不修）：这里硬编码 -05:00（EST）。美东夏令时（EDT）期间实际偏移是
 * -04:00，会让 tsMs 有 1 小时偏差。该偏差只影响展示/新鲜度字段，不影响价格与涨跌幅；
 * 系统里另有 CNBC 的 ISO 时间戳（带正确偏移）做兜底。不要为此引入时区库或 Intl 反解，
 * 那只会多一个失败点。
 */
function etToMs(s: string): number {
  return Date.parse(`${s.replace(' ', 'T')}-05:00`)
}

/**
 * 腾讯 qt.gtimg.cn 的原始文本 -> Quote。
 * 报文形如 v_usAAPL="200~苹果~AAPL.OQ~349.58~..."，多只以 ';' 分隔；
 * 状态码非 200、或价格/昨收非有限数的条目直接丢弃，绝不产出 NaN。
 */
export function parseTencent(raw: string): Quote[] {
  const out: Quote[] = []
  for (const chunk of raw.split(';')) {
    const m = chunk.match(/v_us([A-Z.\-]+)="([^"]*)"/)
    if (!m) continue
    const f = m[2]!.split('~')
    if (f[IDX.status] !== '200') continue
    const price = Number(f[IDX.price])
    const prevClose = Number(f[IDX.prevClose])
    if (!Number.isFinite(price) || !Number.isFinite(prevClose)) continue
    out.push({
      symbol: m[1]!,
      price,
      prevClose,
      pct: Number(f[IDX.pct] ?? 0),
      tsMs: etToMs(f[IDX.time] ?? ''),
      precision: 3,
      sourceId: 'tencent',
    })
  }
  return out
}

export class TencentSource implements QuoteSource {
  id = 'tencent'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote']

  /** 只服务美股代码：港股（00992）这类纯数字代码它取不到，别让 registry 误记为失败 */
  resolves(symbol: string): boolean {
    return isUsTicker(symbol)
  }

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return []
    const q = symbols
      .slice(0, this.maxBatch)
      .map((s) => `us${s}`)
      .join(',')
    const res = await fetch(`${BASE}${q}`, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`tencent http ${res.status}`)
    // 腾讯返回 GB18030，直接 res.text() 会把中文名解成乱码
    const buf = await res.arrayBuffer()
    const text = new TextDecoder('gb18030').decode(buf)
    return parseTencent(text)
  }
}
