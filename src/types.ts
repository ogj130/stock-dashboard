export type MarketStatus = 'PRE_MKT' | 'REG_MKT' | 'POST_MKT' | 'CLOSED'
export type Phase = 'live' | 'settled'
export type AssetClass = 'us_equity'

export interface Quote {
  symbol: string
  price: number
  prevClose: number
  pct: number          // 当日涨跌幅，百分数（2.31 表示 +2.31%）
  tsMs: number
  precision: number
  sourceId: string
}

export interface MarketSnapshot {
  status: MarketStatus
  tsMs: number
  sourceId: string
}

export interface Holding {
  symbol: string
  name: string
  weight: number       // 0~1 的小数
}

export interface EstimateInput {
  holdings: Array<Holding & { pct: number }>
  fxNow: number
  fxPrev: number
  exposure: number
  residualPct?: number
}

export interface EstimateResult {
  stockPct: number
  fxPct: number
  navPct: number
  coveredWeight: number
  breakdown: Array<{ symbol: string; weight: number; pct: number; contribution: number }>
}
