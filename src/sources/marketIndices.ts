import { CONFIG } from '../config'

const BASE = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const FIELDS = 'f2,f3,f4,f12,f14'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * 底部指数条要的四行指数：上证 / 深证 / 纳斯达克100 / 标普500。
 *
 * 一次 ulist 拿全，不逐条问：这是界面的锦上添花，请求数越少越好；
 * secid 顺序就是界面展示顺序（1=沪、0=深，100=美股指数）。
 */
export const MARKET_INDEX_SECIDS = ['1.000001', '0.399001', '100.NDX', '100.SPX'] as const

export interface MarketIndex {
  /** 报文里的 f12，如 '000001' / 'NDX' */
  symbol: string
  /** 报文里的 f14，如 '上证指数' / '纳斯达克' */
  name: string
  /** 点位 */
  value: number
  /** 涨跌点数 */
  change: number
  /** 涨跌幅（百分数，0.32 表示 +0.32%） */
  pct: number
}

export interface UlIndexRow {
  f2?: unknown
  f3?: unknown
  f4?: unknown
  f12?: unknown
  f14?: unknown
}

export interface UlIndexResponse {
  data?: { diff?: UlIndexRow[] | null } | null
}

/**
 * 东财 ulist 报文 -> MarketIndex[]。f2(点位)/f4(涨跌点) 与 f3(涨跌幅) 都放大 100 倍：
 * 实测 2026-11-10 上证 f2=366079 → 3660.79、f4=1161 → 11.61、f3=32 → 0.32%。
 *
 * 五个字段缺一即丢整行：指数条上「点位在、涨跌幅缺席」比少一行更让人困惑，
 * 而把 '-' 当 0% 展示就是编数字。
 */
export function normalizeMarketIndices(raw: UlIndexResponse | null | undefined): MarketIndex[] {
  const rows = raw?.data?.diff ?? []
  const out: MarketIndex[] = []
  for (const row of rows) {
    const symbol = typeof row.f12 === 'string' ? row.f12.trim() : ''
    const name = typeof row.f14 === 'string' ? row.f14.trim() : ''
    const value = scaled(row.f2)
    const change = scaled(row.f4)
    const pct = scaled(row.f3)
    if (symbol === '' || name === '' || value === null || change === null || pct === null) continue
    out.push({ symbol, name, value, change, pct })
  }
  return out
}

/** 报文里的数字既可能是 number 也可能是字符串；'' 与 '-' 一律当缺失（Number('') === 0 会伪装成 0 点） */
function scaled(value: unknown): number | null {
  const raw =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : null
  if (raw === null || !Number.isFinite(raw)) return null
  return raw / 100
}

/** 真实网络取一次；失败直接抛，由调用方决定降级（这条腿绝不能把估值拖成 500） */
export async function fetchMarketIndices(): Promise<MarketIndex[]> {
  const url = `${BASE}?secids=${MARKET_INDEX_SECIDS.join(',')}&fields=${FIELDS}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`eastmoney ulist http ${res.status}`)
  return normalizeMarketIndices((await res.json()) as UlIndexResponse)
}

/**
 * 30 秒缓存 + 失败缓存。
 *
 * 两条都必须有：5 秒轮询不能每轮打 4 个指数；而失败若不记进缓存，
 * 接口挂掉的 30 秒里每 5 秒都会再打一次、每次刷一条 warn。
 * 失败时缓存空数组——界面拿到空数组就不渲染指数条，这是诚实的降级。
 *
 * 用工厂而不是模块级单例：测试各拿各的缓存，互不串味。
 */
export function createMarketIndicesCache(
  fetchIndices: () => Promise<MarketIndex[]> = fetchMarketIndices,
  ttlMs: number = CONFIG.staleMs.indices,
): () => Promise<MarketIndex[]> {
  let memo: { list: MarketIndex[]; atMs: number } | null = null
  return async () => {
    const now = Date.now()
    if (memo && now - memo.atMs < ttlMs) return memo.list
    try {
      const list = await fetchIndices()
      memo = { list, atMs: now }
      return list
    } catch (err) {
      memo = { list: [], atMs: now }
      throw err
    }
  }
}
