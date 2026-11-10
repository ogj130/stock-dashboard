import type { AfterHoursQuote } from '../types'
import { parseSina } from './sina'
import { isUsTicker } from './types'

export type { AfterHoursQuote }

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** 新浪一只票的报文体量约 600 字节，100 只约 60KB，与 registry 的分片口径一致 */
export const AFTER_HOURS_BATCH = 100

/**
 * 5 秒超时。这条腿是锦上添花，绝不能让夜盘请求拖住整条估值——
 * 用户在看的是收盘估值，夜盘只是旁边多一行。
 */
export const AFTER_HOURS_TIMEOUT_MS = 5_000

/** 60 秒缓存：前端 5 秒轮询，盘后又不怎么跳，一分钟一次足够 */
export const AFTER_HOURS_TTL_MS = 60_000

/**
 * 为什么单独一条取数路径，而不是给 QuoteRegistry 加能力：
 *
 * registry 的契约是「一只票一条行情」，靠 symbol 做键、做去重、做降级裁决。
 * 盘后价是**同一只票的第二条序列**：塞进去要么把常规行情挤掉，要么被当成重复项吃掉，
 * 两种结果都是静默错误。所以这里自己拿一批、自己解析、自己缓存，
 * 上层拿到的是独立的 Map，永远只用于「夜盘估值」那一个数。
 *
 * 新浪是**唯一**有盘后字段的源（东财 ulist 与腾讯 qt.gtimg 都没有，且东财在
 * 美股闭市后整批返回空 body），所以这里不做多源梯队，只此一家。
 */

/** 取一批原始报文（GBK 已解码成文本）。测试注入这个函数即可完全离线 */
export type ReadBatch = (symbols: string[]) => Promise<string>

export async function readSinaBatch(symbols: string[]): Promise<string> {
  const list = symbols
    .map((s) => `gb_${s.toLowerCase()}`)
    .join(',')
  const res = await fetch(`https://hq.sinajs.cn/list=${list}`, {
    // 缺 Referer 会被新浪直接拒绝（实测 2026-11-10），别删
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(AFTER_HOURS_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`sina http ${res.status}`)
  // 新浪返回 GBK，直接 res.text() 会把中文名解成乱码
  return new TextDecoder('gbk').decode(await res.arrayBuffer())
}

export interface AfterHoursFetcherOptions {
  readBatch?: ReadBatch
  ttlMs?: number
  now?: () => number
}

/**
 * 工厂而不是模块级单例：测试各拿各的缓存，互不串味（与 marketIndices 同一思路）。
 *
 * 契约：
 * - **永不抛错**。取不到就是空 Map，界面据此整行不渲染；
 * - 返回的 Map 允许比请求小（没盘后成交的票本来就不该在里面）；
 * - 只问美股代码，纯数字（港股/A 股）先滤掉，别拿它们把整批拖成空。
 * - 失败/无数据也进缓存（阴性缓存 60 秒），否则新浪抽风的这一分钟里
 *   每 5 秒都会重打一次。盘后数据本来就一分钟一变，阴性缓存不损失信息。
 */
export function createAfterHoursFetcher(
  options: AfterHoursFetcherOptions = {},
): (symbols: string[]) => Promise<Map<string, AfterHoursQuote>> {
  const readBatch = options.readBatch ?? readSinaBatch
  const ttlMs = options.ttlMs ?? AFTER_HOURS_TTL_MS
  const now = options.now ?? (() => Date.now())
  /** null = 这一轮问过、没有盘后成交 */
  const cache = new Map<string, { quote: AfterHoursQuote | null; atMs: number }>()

  async function fetchBatch(batch: string[]): Promise<AfterHoursQuote[]> {
    try {
      const text = await readBatch(batch)
      return parseSina(text, now()).flatMap((q) => {
        if (q.afterHoursPrice === undefined) return []
        if (q.afterHoursPct === undefined || q.afterHoursMs === undefined) return []
        return [
          {
            symbol: q.symbol,
            price: q.afterHoursPrice,
            pct: q.afterHoursPct,
            tsMs: q.afterHoursMs,
          },
        ]
      })
    } catch {
      // 超时、HTTP 5xx、报文乱码——这一批当「没有盘后数据」，绝不向上抛
      return []
    }
  }

  return async (symbols) => {
    const wanted = [...new Set(symbols)].filter((s) => isUsTicker(s))
    if (wanted.length === 0) return new Map()

    const at = now()
    const stale: string[] = []
    for (const symbol of wanted) {
      const hit = cache.get(symbol)
      if (hit && at - hit.atMs < ttlMs) continue
      stale.push(symbol)
    }

    const batches: string[][] = []
    for (let i = 0; i < stale.length; i += AFTER_HOURS_BATCH) {
      batches.push(stale.slice(i, i + AFTER_HOURS_BATCH))
    }
    if (batches.length > 0) {
      const results = await Promise.all(batches.map((b) => fetchBatch(b)))
      const got = new Map<string, AfterHoursQuote>()
      for (const quote of results.flat()) got.set(quote.symbol, quote)
      // 阴性与阳性都落缓存，同一个 TTL 口径
      for (const batch of batches) {
        for (const symbol of batch) cache.set(symbol, { quote: got.get(symbol) ?? null, atMs: at })
      }
    }

    const out = new Map<string, AfterHoursQuote>()
    for (const symbol of wanted) {
      const quote = cache.get(symbol)?.quote
      if (quote) out.set(symbol, quote)
    }
    return out
  }
}

/**
 * 生产入口：模块级单例，60 秒缓存。调用方拿到的是「现在能拿到的盘后行情」，不抛错。
 */
const defaultFetcher = createAfterHoursFetcher()

export function fetchAfterHours(symbols: string[]): Promise<Map<string, AfterHoursQuote>> {
  return defaultFetcher(symbols)
}
