import type { Holding } from '../types'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export interface CapRow {
  symbol: string
  marketCap: number
  name: string
}

/** 纳指官方 list-type 报文（2026-11-10 实测形状，未列字段一律忽略） */
export interface NasdaqListResponse {
  data?: {
    data?: {
      rows?: Array<{
        symbol?: string | null
        marketCap?: string | number | null
        companyName?: string | null
      }> | null
    } | null
  } | null
}

/**
 * 报文下标 0 的行为 `{symbol, companyName, marketCap, lastSalePrice, percentageChange, ...}`，
 * 不做大小写还原，symbol 去掉首尾空白后原样保留。
 *
 * marketCap 是带千分位逗号的字符串（"5,090,332,710,960"），必须先删逗号再 Number。
 * 缺失或空串时 Number('') === 0 会伪装成「市值 0」，这里用显式 `> 0` 剔除，
 * 否则这些行会进到 weightsFromMarketCap 里占位。
 */
export function parseNasdaqList(raw: unknown): CapRow[] {
  const rows = (raw as NasdaqListResponse | null)?.data?.data?.rows ?? []
  return rows
    .map((r) => ({
      symbol: String(r.symbol ?? '')
        .trim()
        .toUpperCase(),
      marketCap: Number(String(r.marketCap ?? '').replace(/,/g, '')),
      name: String(r.companyName ?? ''),
    }))
    .filter((r) => r.symbol && Number.isFinite(r.marketCap) && r.marketCap > 0)
}

/**
 * 市值加权近似。
 *
 * 过滤必须发生在求和之前：市值缺失/为 0 的行若混进分母，会把所有正常成分的权重整体压低，
 * 且权重总和不再等于 1，撞上数据库 `Holding.weight` 的 CHECK 约束。
 * `Number.isFinite` 挡不住 0（0 是有限数），所以额外要求 `> 0`。
 *
 * 已知偏差：纳斯达克 100 是修正市值加权（capped），本算法为纯市值占比，
 * 两者存在可度量偏差，需在回测（Task 14）中量化，这里不做任何「假装一致」的补偿。
 */
export function weightsFromMarketCap(
  rows: Array<{ symbol: string; marketCap: number; name?: string }>,
): Holding[] {
  const valid = rows.filter((r) => Number.isFinite(r.marketCap) && r.marketCap > 0)
  const total = valid.reduce((s, r) => s + r.marketCap, 0)
  if (total <= 0) return []
  return valid.map((r) => ({
    symbol: r.symbol,
    name: r.name ?? r.symbol,
    weight: r.marketCap / total,
  }))
}

const INDEX_ENDPOINT: Record<string, string> = {
  ndx: 'https://api.nasdaq.com/api/quote/list-type/nasdaq100',
}

/**
 * 指数 key → 全量成分权重。
 *
 * 未知 key 明确抛错而非返回空数组：静默空会让调用方以为「该指数没有成分」，
 * 进而退化成前十大权重而不自知。sp500 的全量源尚未确定（list-type/sp500 报
 * 400 code 1011 Bad or No parameter），待 Task 18 探测后再登记。
 */
export async function fetchIndexWeights(indexKey: string): Promise<Holding[]> {
  const url = INDEX_ENDPOINT[indexKey]
  if (!url) throw new Error(`unknown index: ${indexKey}（sp500 全量源待 probe.ts 验证后再登记）`)
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`index http ${res.status}`)
  return weightsFromMarketCap(parseNasdaqList(await res.json()))
}
