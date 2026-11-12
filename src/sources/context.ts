import type { AfterHoursQuote } from '../types'
import { parseTencent } from './tencent'
import { fetchPreMarket } from './preMarket'
import { isUsTicker } from './types'

/**
 * AI 复盘用的「市场上下文」：指数期货、板块 ETF、个股盘前。
 *
 * 为什么单独一层：这三样只服务分析（按需、30–60 秒缓存），
 * 不能塞进 5 秒一次的估值轮询里——期货与 ETF 不属于持仓，也不参与 Σw·pct。
 *
 * 数据边界：
 *   · 期货来自新浪外盘（hf_NQ / hf_ES），连续交易，盘前盘中都有数；
 *   · 板块 ETF 在盘前走 CNBC 的盘前腿（与持仓同一套），拿不到才退回常规行情，
 *     并如实标 asOf，避免把上一场收盘当成盘前；
 *   · 个股盘前复用 preMarket 的 60 秒缓存，不额外打源。
 */
export type ContextPhase = 'pre' | 'live' | 'settled'

export interface FutureQuote {
  symbol: string
  name: string
  price: number
  pct: number
  asOf: string
}

export interface EtfQuote {
  symbol: string
  name: string
  pct: number
  asOf: string
}

export interface PremarketStock {
  symbol: string
  pct: number
  price: number
}

export interface MarketContext {
  tsMs: number
  futures: FutureQuote[]
  etfs: EtfQuote[]
  premarketStocks: PremarketStock[]
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const FUTURES_URL = 'https://hq.sinajs.cn/list=hf_NQ,hf_ES'
const ETF_SYMBOLS = ['SMH', 'SOXX', 'XLK', 'QQQ'] as const
const ETF_NAMES: Record<string, string> = {
  SMH: '半导体 ETF',
  SOXX: '费城半导体 ETF',
  XLK: '科技行业 ETF',
  QQQ: '纳指 100 ETF',
}

/** 新浪 hf_ 期货：0 现价、4 最高、5 最低、6 时间、7 昨收、13 名称 */
export function parseSinaFutures(raw: string): FutureQuote[] {
  const out: FutureQuote[] = []
  for (const line of raw.split('\n')) {
    const match = /hq_str_hf_([A-Z]+)="([^"]*)"/.exec(line)
    if (!match) continue
    const symbol = match[1] ?? ''
    const body = match[2] ?? ''
    const f = body.split(',')
    const price = Number(f[0])
    const prevClose = Number(f[7])
    const name = (f[13] ?? '').trim() || symbol
    if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) continue
    out.push({
      symbol,
      name,
      price: Math.round(price * 100) / 100,
      pct: Math.round(((price - prevClose) / prevClose) * 10000) / 100,
      asOf: '实时',
    })
  }
  return out
}

async function fetchFutures(fetchFn: typeof fetch): Promise<FutureQuote[]> {
  const res = await fetchFn(FUTURES_URL, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`futures http ${res.status}`)
  const buf = await res.arrayBuffer()
  return parseSinaFutures(new TextDecoder('gb18030').decode(buf))
}

async function fetchEtfs(
  phase: ContextPhase,
  fetchFn: typeof fetch,
  premarketFn: (symbols: string[]) => Promise<Map<string, AfterHoursQuote>>,
): Promise<EtfQuote[]> {
  const symbols = [...ETF_SYMBOLS]
  let premarket: Map<string, AfterHoursQuote> | null = null
  if (phase === 'pre') {
    premarket = await premarketFn(symbols).catch(() => null)
  }
  // 盘前：优先 CNBC 盘前腿；没有盘前成交的 ETF 退回常规行情（标 asOf，别冒充盘前）
  const needRegular = symbols.filter((symbol) => !premarket?.has(symbol))
  const regular = new Map<string, { pct: number }>()
  if (needRegular.length > 0) {
    const url = `https://qt.gtimg.cn/q=${needRegular.map((s) => `us${s}`).join(',')}`
    const res = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const text = new TextDecoder('gb18030').decode(buf)
      for (const quote of parseTencent(text)) {
        if (Number.isFinite(quote.pct)) regular.set(quote.symbol, { pct: quote.pct })
      }
    }
  }

  const asOfRegular = phase === 'pre' ? '上一交易日收盘' : phase === 'live' ? '当前时段' : '最近收盘'
  const out: EtfQuote[] = []
  for (const symbol of symbols) {
    const pm = premarket?.get(symbol)
    if (pm && Number.isFinite(pm.pct)) {
      out.push({ symbol, name: ETF_NAMES[symbol] ?? symbol, pct: Math.round(pm.pct * 100) / 100, asOf: '盘前' })
      continue
    }
    const quote = regular.get(symbol)
    if (quote) {
      out.push({ symbol, name: ETF_NAMES[symbol] ?? symbol, pct: Math.round(quote.pct * 100) / 100, asOf: asOfRegular })
    }
  }
  return out
}

interface Cache<T> {
  value: T
  atMs: number
}

export interface ContextDeps {
  fetchFn?: typeof fetch
  premarketFn?: (symbols: string[]) => Promise<Map<string, AfterHoursQuote>>
  now?: () => number
  ttlMs?: number
}

/**
 * 拉取一次上下文。任何一块失败只丢那一块，整体仍然 200。
 * 期货/ETF 30 秒缓存；盘前个股沿用 preMarket 自己的 60 秒缓存。
 */
export async function fetchMarketContext(
  input: { phase: ContextPhase; symbols: string[] },
  deps: ContextDeps = {},
): Promise<MarketContext> {
  const fetchFn = deps.fetchFn ?? fetch
  const premarketFn = deps.premarketFn ?? fetchPreMarket
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? 30_000
  const symbols = [...new Set(input.symbols.filter((s) => s !== '' && isUsTicker(s)))].slice(0, 12)

  const key = `${input.phase}:${symbols.join(',')}`
  const cache = contextCache.get(key)
  if (cache !== undefined && now() - cache.atMs < ttlMs) return { ...cache.value, tsMs: cache.atMs }

  const [futures, etfs, premarket] = await Promise.all([
    fetchFutures(fetchFn).catch(() => []),
    fetchEtfs(input.phase, fetchFn, premarketFn).catch(() => []),
    input.phase === 'pre' && symbols.length > 0
      ? premarketFn(symbols).catch(() => new Map<string, AfterHoursQuote>())
      : Promise.resolve(new Map<string, AfterHoursQuote>()),
  ])

  const premarketStocks: PremarketStock[] = []
  for (const symbol of symbols) {
    const quote = premarket.get(symbol)
    if (quote && Number.isFinite(quote.pct)) {
      premarketStocks.push({ symbol, pct: Math.round(quote.pct * 100) / 100, price: quote.price })
    }
  }

  const value: MarketContext = { tsMs: now(), futures, etfs, premarketStocks }
  contextCache.set(key, { value, atMs: value.tsMs })
  return value
}

const contextCache = new Map<string, Cache<MarketContext>>()
