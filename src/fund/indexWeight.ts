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
 * 公司名 → 分组键：抹平「股本类别」噪音，让同一公司的多个类别落到同一个键上。
 *
 * 只删类别/证券类型词，不删公司主体词；归一化后仍为空则退回 symbol（宁可不去重，
 * 也不能把一堆空名字的成分并成一组）。
 */
const SHARE_CLASS_NOISE =
  /\b(class [a-z]|series [a-z]|common stock|capital stock|common shares|ordinary shares|voting shares|nonvoting shares|subordinate voting shares|depositary shares)\b/g

function companyKey(name: string | undefined, symbol: string): string {
  const base = (name?.trim() || symbol)
    .toLowerCase()
    .replace(/[.,"'()]/g, ' ')
    .replace(SHARE_CLASS_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return base || symbol.toLowerCase()
}

/**
 * 市值加权近似。
 *
 * 过滤必须发生在求和之前：市值缺失/为 0 的行若混进分母，会把所有正常成分的权重整体压低，
 * 且权重总和不再等于 1，撞上数据库 `Holding.weight` 的 CHECK 约束。
 * `Number.isFinite` 挡不住 0（0 是有限数），所以额外要求 `> 0`。
 *
 * **双股权类去重（必须）**：api.nasdaq.com 的 `marketCap` 是「公司整体市值」，多类别公司
 * （GOOGL/GOOG、FOX/FOXA、NWS/NWSA）会**每个 symbol 各返回一次同样的公司市值**。
 * 直接求和会把 Alphabet 算成 16.45%（真实约 9.01%，超 1.83 倍），并让其余成分被过大的
 * 分母等比压低约 9%（实测 AAPL −1.13pp、NVDA −0.85pp、MSFT −0.78pp）。
 * 处理：按公司名分组，组内市值均分给各 symbol——同类股本相近时这等价于按股本拆分，
 * 实测能让 Alphabet 合计回到约 9.0%，与第三方权重表吻合。
 *
 * **分组键必须先归一化**：实测（2026-11-10）`companyName` 对同一公司的两个类别**并不相同**，
 *   GOOGL → "Alphabet Inc. Class A Common Stock"
 *   GOOG  → "Alphabet Inc. Class C Capital Stock"
 * 直接拿全名当 key，全表 101 行里没有任何一对重名，去重静默失效（Alphabet 仍算 16.45%）——
 * 这正是本条 bug 的第一版修复被真实 API 打回的原因。故用 companyKey 抹掉股本类别噪音。
 *
 * 其他偏差（纳指 100 用的是修正市值加权，有 capping）需在 Task 14 回测中单独计量，
 * 不要和这里的去重混成一个数字。
 */
export function weightsFromMarketCap(
  rows: Array<{ symbol: string; marketCap: number; name?: string }>,
): Holding[] {
  const valid = rows.filter((r) => Number.isFinite(r.marketCap) && r.marketCap > 0)
  if (valid.length === 0) return []

  const groups = new Map<string, typeof valid>()
  for (const r of valid) {
    const key = companyKey(r.name, r.symbol)
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }

  const adjusted: Array<{ symbol: string; name: string; marketCap: number }> = []
  for (const list of groups.values()) {
    // 组内取最大作为公司市值（数据源对同类给的值可能略有差异），再均分回各 symbol
    const companyCap = Math.max(...list.map((r) => r.marketCap))
    const per = companyCap / list.length
    for (const r of list) {
      adjusted.push({ symbol: r.symbol, name: r.name ?? r.symbol, marketCap: per })
    }
  }

  const total = adjusted.reduce((s, r) => s + r.marketCap, 0)
  if (total <= 0) return []
  return adjusted.map((r) => ({ symbol: r.symbol, name: r.name, weight: r.marketCap / total }))
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
