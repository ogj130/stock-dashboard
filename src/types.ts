export type MarketStatus = 'PRE_MKT' | 'REG_MKT' | 'POST_MKT' | 'CLOSED'
export type Phase = 'live' | 'settled'
export type AssetClass = 'us_equity'

export interface Quote {
  symbol: string
  /** 数据源给的本地化名称（东财的 f14 是中文名，如「苹果」「英伟达」）。腾讯/CNBC 只有英文 */
  name?: string
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
  /** 东财 secid 市场码（105 NASDAQ / 106 NYSE / 107 AMEX / 116 港股…）。能拿到就必须带 */
  market?: number
}

export interface EstimateInput {
  holdings: Array<Holding & { pct: number }>
  /**
   * 跟踪指数的官方涨跌幅（百分数）。给了就用它代替成分加权——
   * 实测自算纯市值加权与官方 NDX 差 0.206pp，比 MAE 预算还大，
   * 因为 NDX 是修正市值加权（有 capping）且成分名单有时点差。
   * 指数基金应尽量走这条；主动型无指数才退回成分加权。
   */
  indexPct?: number
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
  breakdown: Array<{ symbol: string; name: string; weight: number; pct: number; contribution: number }>
}
