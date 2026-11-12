/**
 * AI 复盘的前端数据形状。
 *
 * 这里只做一件事：把界面上**已经算好的**数字摆成快照，原样发给 /api/analysis。
 * 前端不做任何新的估值，也不在这里判断"该不该分析"——那是服务端的事。
 */

export type AnalysisPhase = 'pre' | 'live' | 'settled'

export interface AnalysisFundInput {
  code: string
  name: string
  marketValue: number
  amount: number
  /** 当日估算涨跌幅（百分数） */
  navPct: number
  holdingProfit: number
  /** 0~1 */
  coveredWeight: number
  board: string | null
}

export interface AnalysisStockInput {
  symbol: string
  name: string
  weightPct: number
  pct: number
}

export interface AnalysisNewsInput {
  title: string
  tsMs: number
  important: boolean
}

export interface AnalysisSnapshot {
  phase: AnalysisPhase
  atMs: number
  totalValue: number
  totalAmount: number
  totalAmountPct: number | null
  totalHoldingProfit: number
  totalHoldingPct: number | null
  fx: { pair: string; rate: number; pct: number } | null
  indices: Array<{ name: string; pct: number }>
  funds: Array<{
    code: string
    name: string
    marketValue: number
    amount: number
    pct: number
    holdingProfit: number
    coveredWeight: number
    board: string | null
  }>
  stocks: AnalysisStockInput[]
  news: AnalysisNewsInput[]
}

export interface AnalysisTotals {
  value: number
  amount: number
  amountPct: number | null
  holdingProfit: number
  holdingPct: number | null
}

export interface BuildSnapshotInput {
  phase: AnalysisPhase
  atMs: number
  totals: AnalysisTotals
  fx: { pair: string; rate: number; pct: number } | null
  indices: Array<{ name: string; pct: number }>
  funds: readonly AnalysisFundInput[]
  stocks: readonly AnalysisStockInput[]
  news: readonly AnalysisNewsInput[]
}

/** 纯函数，便于单测；顺序与界面一致（服务端不重排） */
export function buildAnalysisSnapshot(input: BuildSnapshotInput): AnalysisSnapshot {
  return {
    phase: input.phase,
    atMs: input.atMs,
    totalValue: input.totals.value,
    totalAmount: input.totals.amount,
    totalAmountPct: input.totals.amountPct,
    totalHoldingProfit: input.totals.holdingProfit,
    totalHoldingPct: input.totals.holdingPct,
    fx: input.fx,
    indices: input.indices.map((item) => ({ name: item.name, pct: item.pct })),
    funds: input.funds.map((f) => ({
      code: f.code,
      name: f.name,
      marketValue: f.marketValue,
      amount: f.amount,
      pct: f.navPct,
      holdingProfit: f.holdingProfit,
      coveredWeight: f.coveredWeight,
      board: f.board,
    })),
    stocks: input.stocks.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      weightPct: s.weightPct,
      pct: s.pct,
    })),
    news: input.news.map((n) => ({ title: n.title, tsMs: n.tsMs, important: n.important })),
  }
}

export interface AnalysisDriver {
  label: string
  detail: string
}

export interface AnalysisResult {
  headline: string
  summary: string[]
  drivers: AnalysisDriver[]
  risks: string[]
  watch: string[]
  model: string
  generatedAt: number
  cached: boolean
  disclaimer: string
}

export interface AiConfigView {
  baseUrl: string
  model: string
  hasKey: boolean
  maskedKey: string
  configured: boolean
}

/** 结果卡右上角的时间：'14:32' */
const CLOCK = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function analysisClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return CLOCK.format(new Date(ms))
}
