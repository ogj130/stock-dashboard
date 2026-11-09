import type { Quote } from '../types'
import type { Capability, QuoteSource } from './types'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * 空串 / 缺失字段一律当 NaN 处理。
 *
 * 不能直接用 Number(x)：`Number('')` 是 0 而不是 NaN。新浪报文是位置式字段，
 * 尾部字段缺失时 split(',') 会给出空串，裸用 Number 会把"缺失"读成"涨跌额 0"，
 * 于是 prevClose 被算成等于现价——一个静默的错值，比抛错更危险。
 */
function num(s: string | undefined): number {
  if (s === undefined) return NaN
  const t = s.trim()
  return t === '' ? NaN : Number(t)
}

/**
 * 新浪 hq.sinajs.cn 的原始文本 -> Quote。兜底源（L5），价格精度 4 位最高。
 *
 * 实测报文（2026-11-10 验证）：
 * `var hq_str_gb_aapl="苹果,350.1800,2.28,2026-11-10 01:07:03,7.8100,344.9950,...";`
 * 字段位置（位置式，勿按名字取）：[0]名称 [1]现价 [2]涨跌幅% [3]时间(北京时间) [4]涨跌额。
 *
 * 新浪**没有直接的昨收字段**：优先 `price - change`，涨跌额缺失时用 `price / (1 + pct/100)` 反推。
 * 价格非有限数的条目直接丢弃，绝不产出 NaN。
 */
export function parseSina(raw: string): Quote[] {
  const out: Quote[] = []
  for (const chunk of raw.split(';')) {
    // 变量名是小写 hq_str_gb_aapl，产出时统一转大写
    const m = chunk.match(/hq_str_gb_([a-z.\-]+)="([^"]*)"/)
    if (!m) continue
    const f = m[2]!.split(',')
    const price = num(f[1])
    if (!Number.isFinite(price)) continue
    const rawPct = num(f[2])
    const change = num(f[4])
    const prevClose = Number.isFinite(change)
      ? price - change
      : Number.isFinite(rawPct) && rawPct !== -100
        ? price / (1 + rawPct / 100)
        : price
    // 涨跌幅缺失时由昨收反算，保持两个字段自洽
    const pct = Number.isFinite(rawPct)
      ? rawPct
      : prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : 0
    out.push({
      symbol: m[1]!.toUpperCase(),
      price,
      prevClose,
      pct,
      // [3] 是北京时间（无偏移），显式补 +08:00；解析失败退回当前时间，不当 NaN 传下去
      tsMs: f[3] ? Date.parse(`${f[3].trim().replace(' ', 'T')}+08:00`) || Date.now() : Date.now(),
      precision: 4,
      sourceId: 'sina',
    })
  }
  return out
}

export class SinaSource implements QuoteSource {
  id = 'sina'
  maxBatch = 100
  sep = ','
  capabilities: Capability[] = ['quote']

  async fetchQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return []
    const list = symbols
      .slice(0, this.maxBatch)
      .map((s) => `gb_${s.toLowerCase()}`)
      .join(',')
    const res = await fetch(`https://hq.sinajs.cn/list=${list}`, {
      // 缺 Referer 会被新浪直接拒绝（实测 2026-11-10），别删
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    })
    if (!res.ok) throw new Error(`sina http ${res.status}`)
    // 新浪返回 GBK，直接 res.text() 会把中文名解成乱码
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
    return parseSina(text)
  }
}
