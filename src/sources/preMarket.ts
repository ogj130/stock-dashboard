import type { AfterHoursQuote } from '../types'
import { parseSina } from './sina'
import { isUsTicker } from './types'

/**
 * 盘前行情。
 *
 * 与夜盘（afterHours）是同一类「延伸时段」数据，但**取数优先级相反**：
 *
 * 夜盘只有新浪有（东财闭市后整批返回空、腾讯 qt.gtimg 的延伸字段全是 0），
 * 盘前却是 CNBC 更权威：它的 `ExtendedMktQuote.type` 明确写着 `PRE_MKT`，
 * 带自己的成交时刻，涨跌幅直接给（基准是上一交易日收盘），不用自己算。
 * 新浪仍作兜底 —— 它有 100 只/批的吞吐，CNBC 的分片上限要保守。
 *
 * 为什么必须单独一条腿而不是复用常规行情：
 * 盘前时段常规接口给的是**上一个交易日收盘**（实测 04:21 ET 腾讯/CNBC 常规腿
 * 都还是 350.69 / +2.43%）。直接拿来当"现在"，界面就会在盘前显示昨天的涨幅，
 * 而且看起来完全正常——这类静默错误比报错危险得多。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** CNBC 的批量上限没公开文档，50 只一档保守取值（实测 3 只正常，见 design 记录） */
export const PRE_MARKET_CNBC_BATCH = 50
/** 新浪一只约 600 字节，100 只约 60KB，与 registry / afterHours 口径一致 */
export const PRE_MARKET_SINA_BATCH = 100
export const PRE_MARKET_TIMEOUT_MS = 5_000
export const PRE_MARKET_TTL_MS = 60_000

const CNBC_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'

export type ReadCnbc = (symbols: string[]) => Promise<string>
export type ReadSina = (symbols: string[]) => Promise<string>

export async function readCnbcBatch(symbols: string[]): Promise<string> {
  const url =
    `${CNBC_URL}?symbols=${symbols.join('|')}` +
    '&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json'
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(PRE_MARKET_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`cnbc http ${res.status}`)
  return res.text()
}

export async function readSinaBatchForPre(symbols: string[]): Promise<string> {
  const list = symbols.map((s) => `gb_${s.toLowerCase()}`).join(',')
  const res = await fetch(`https://hq.sinajs.cn/list=${list}`, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(PRE_MARKET_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`sina http ${res.status}`)
  return new TextDecoder('gbk').decode(await res.arrayBuffer())
}

/**
 * CNBC 的时间是 ISO 带偏移但**不带冒号**（`2026-11-10T04:18:35.843-0500`）。
 * V8 容错能解析，但不是规范 ISO 8601，显式补冒号避免换运行时静默变 NaN。
 */
function timeMs(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs
  const parsed = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(parsed) ? parsed : fallbackMs
}

/** `"+1.23%"` / `"-0.25%"` / `"1.23"` → 数字；空串和 '-' 一律 NaN（Number('') === 0 会骗人） */
function num(s: string | undefined): number {
  if (s === undefined) return NaN
  const t = s.replace(/[+%,]/g, '').trim()
  return t === '' ? NaN : Number(t)
}

interface CnbcExtended {
  type?: string
  last?: string
  change_pct?: string
  last_time?: string
}

interface CnbcRow {
  symbol?: string
  last?: string
  ExtendedMktQuote?: CnbcExtended
}

/**
 * 只认 `type === 'PRE_MKT'` 的延伸行情。
 *
 * 这一条是安全性检查，不是洁癖：`exthrs=1` 在盘后时段会把 `POST_MKT` 塞进同一个
 * 字段里。不校验类型的话，盘后重启服务时会拿夜盘价冒充盘前价，
 * 两个数的基准都是昨收，看着都对，只是时间错了半天。
 */
export function parseCnbcPreMarket(raw: unknown, nowMs: number): AfterHoursQuote[] {
  const rows = (raw as { FormattedQuoteResult?: { FormattedQuote?: CnbcRow[] } })?.FormattedQuoteResult
    ?.FormattedQuote
  if (!Array.isArray(rows)) return []
  const out: AfterHoursQuote[] = []
  for (const row of rows) {
    const ext = row?.ExtendedMktQuote
    const symbol = row?.symbol
    if (!symbol || !ext || ext.type !== 'PRE_MKT') continue
    const price = num(ext.last)
    const pct = num(ext.change_pct)
    // prevClose 只用于展示与校验；CNBC 已给涨跌幅，缺失也不影响计算
    const prevClose = num(row?.last)
    if (!(price > 0) || !Number.isFinite(pct)) continue
    out.push({
      symbol,
      price,
      pct,
      tsMs: timeMs(ext.last_time, nowMs),
      ...(Number.isFinite(prevClose) && prevClose > 0 ? { prevClose } : {}),
    } as AfterHoursQuote)
  }
  return out
}

export interface PreMarketFetcherOptions {
  readCnbc?: ReadCnbc
  readSina?: ReadSina
  ttlMs?: number
  now?: () => number
}

/**
 * 工厂而不是单例：测试各拿各的缓存，互不串味（与 afterHours / marketIndices 同思路）。
 *
 * 契约与夜盘一致：
 * - **永不抛错**；取不到就是空 Map，界面据此不出盘前数字；
 * - 返回的 Map 允许比请求小（没有盘前成交的票本来就不该在里面）；
 * - 只问美股代码，纯数字（港股/A 股）先滤掉；
 * - 阴性结果同样进缓存 60 秒，避免源抽风时每 5 秒重打一遍。
 */
export function createPreMarketFetcher(
  options: PreMarketFetcherOptions = {},
): (symbols: string[]) => Promise<Map<string, AfterHoursQuote>> {
  const readCnbc = options.readCnbc ?? readCnbcBatch
  const readSina = options.readSina ?? readSinaBatchForPre
  const ttlMs = options.ttlMs ?? PRE_MARKET_TTL_MS
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, { quote: AfterHoursQuote | null; atMs: number }>()

  function chunk<T>(list: T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
    return out
  }

  async function fetchCnbc(batch: string[]): Promise<AfterHoursQuote[]> {
    try {
      return parseCnbcPreMarket(JSON.parse(await readCnbc(batch)), now())
    } catch {
      return []
    }
  }

  async function fetchSina(batch: string[]): Promise<AfterHoursQuote[]> {
    try {
      return parseSina(await readSina(batch), now()).flatMap((q) => {
        if (q.afterHoursPrice === undefined) return []
        if (q.afterHoursPct === undefined) return []
        return [
          {
            symbol: q.symbol,
            price: q.afterHoursPrice,
            pct: q.afterHoursPct,
            tsMs: q.afterHoursMs ?? now(),
          },
        ]
      })
    } catch {
      return []
    }
  }

  return async (symbols) => {
    const wanted = [...new Set(symbols)].filter((s) => isUsTicker(s))
    if (wanted.length === 0) return new Map()

    const at = now()
    const stale = wanted.filter((s) => {
      const hit = cache.get(s)
      return !hit || at - hit.atMs >= ttlMs
    })

    if (stale.length > 0) {
      const got = new Map<string, AfterHoursQuote>()
      for (const batch of chunk(stale, PRE_MARKET_CNBC_BATCH)) {
        for (const quote of await fetchCnbc(batch)) got.set(quote.symbol, quote)
      }
      // 只给 CNBC 没覆盖到的补齐，避免为已拿到的符号再打一次新浪
      const gaps = stale.filter((s) => !got.has(s))
      if (gaps.length > 0) {
        for (const batch of chunk(gaps, PRE_MARKET_SINA_BATCH)) {
          for (const quote of await fetchSina(batch)) {
            if (!got.has(quote.symbol)) got.set(quote.symbol, quote)
          }
        }
      }
      for (const symbol of stale) cache.set(symbol, { quote: got.get(symbol) ?? null, atMs: at })
    }

    const out = new Map<string, AfterHoursQuote>()
    for (const symbol of wanted) {
      const quote = cache.get(symbol)?.quote
      if (quote) out.set(symbol, quote)
    }
    return out
  }
}

/** 生产入口：模块级单例，60 秒缓存。不抛错。 */
const defaultFetcher = createPreMarketFetcher()

export function fetchPreMarket(symbols: string[]): Promise<Map<string, AfterHoursQuote>> {
  return defaultFetcher(symbols)
}
