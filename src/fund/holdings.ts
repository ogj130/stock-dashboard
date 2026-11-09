import type { Holding } from '../types'

const UA = 'EMProjJijin/6.5.0 (iPhone; iOS 16.0)'

export interface RawStock {
  GPDM: string
  GPJC: string
  JZBL: string
}
export interface PositionResp {
  Datas: {
    fundStocks?: RawStock[] | null
    fundboods?: unknown[] | null
    fundfofs?: unknown[] | null
    ETFCODE?: string | null
    ETFSHORTNAME?: string | null
  }
  Expansion?: string
}

export interface ParsedPosition {
  holdings: Holding[]
  targetEtf: string | null
  asOf: string
}

/**
 * 接口的 JZBL 是百分数（7.6 表示 7.6%），Holding.weight 要 0~1 小数，所以除以 100。
 *
 * 空串必须单独拦掉：Number('') === 0 且 0 是有限数，只判 Number.isFinite 会把
 * 缺失权重当成「权重 0」收下，污染 coveredWeight。缺失就丢弃该条。
 */
function toWeight(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (text === '') return null
  const pct = Number(text)
  if (!Number.isFinite(pct)) return null
  return pct / 100
}

export function parsePosition(resp: PositionResp): ParsedPosition {
  const stocks = resp.Datas.fundStocks ?? []
  const holdings: Holding[] = []
  for (const s of stocks) {
    const symbol = s.GPDM?.trim().toUpperCase()
    if (!symbol) continue
    const weight = toWeight(s.JZBL)
    if (weight === null) continue
    holdings.push({ symbol, name: s.GPJC, weight })
  }
  return {
    holdings,
    targetEtf: resp.Datas.ETFCODE?.trim() || null,
    asOf: resp.Expansion ?? new Date().toISOString().slice(0, 10),
  }
}

export async function fetchPosition(code: string): Promise<PositionResp> {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${code}` +
    `&deviceid=1&plat=Android&product=EFund&version=1`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`position http ${res.status} for ${code}`)
  return (await res.json()) as PositionResp
}

export interface ResolvedHoldings {
  holdings: Holding[]
  viaEtf: string | null
  asOf: string
}

/**
 * 基金代码 → 持仓。
 * 联接基金自身不持股，接口只返回 ETFCODE，需再查一次目标 ETF。
 * 递归深度限制 1 层：目前不存在 ETF 套 ETF 的情形，超限即返回空，避免环形请求。
 */
export async function resolveHoldingsFrom(
  code: string,
  fetcher: (code: string) => Promise<PositionResp>,
): Promise<ResolvedHoldings> {
  const first = parsePosition(await fetcher(code))
  if (first.holdings.length > 0) {
    return { holdings: first.holdings, viaEtf: null, asOf: first.asOf }
  }
  if (!first.targetEtf) {
    return { holdings: [], viaEtf: null, asOf: first.asOf }
  }
  const second = parsePosition(await fetcher(first.targetEtf))
  return { holdings: second.holdings, viaEtf: first.targetEtf, asOf: second.asOf }
}
