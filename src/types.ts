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

/**
 * 盘后（美东 16:00–20:00 ET）的单只行情。
 *
 * 刻意**不是** Quote：Quote 的契约是「一只票一条、price 是常规时段成交价」，
 * 盘后价是同一只票的第二条序列。塞进 Quote 会被 registry 的「一只票一条」去重
 * 当成重复项吃掉，也容易让 navPct 与盘后价悄悄串线。
 */
export interface AfterHoursQuote {
  symbol: string
  /** 盘后最新成交价 */
  price: number
  /** 盘后涨跌幅（百分数），基准是当日**常规收盘价** */
  pct: number
  /** 盘后最后一笔成交时间（epoch ms） */
  tsMs: number
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
