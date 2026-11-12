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
  /** 官方净值日（估算的锚点） */
  navDate?: string | null
  /** 净值日之后已经补了几场 */
  sessionsSinceNav?: number
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

export interface AnalysisClock {
  /** 北京时间 '2026-11-12 20:31' */
  local: string
  /** 美东时间 '2026-11-12 07:31' */
  et: string
  /** 阶段说明：美股盘前（美东 04:00–09:30） */
  session: string
  /** 给模型的一句提醒：哪些数据属于上一场 */
  note: string
}

export interface AnalysisSnapshot {
  phase: AnalysisPhase
  atMs: number
  clock: AnalysisClock
  totalValue: number
  totalAmount: number
  totalAmountPct: number | null
  totalHoldingProfit: number
  totalHoldingPct: number | null
  fx: { pair: string; rate: number; pct: number } | null
  indices: Array<{ name: string; pct: number; asOf: string }>
  /** 按跟踪指数聚合的板块权重，供模型把「半导体/纳指」类新闻挂到持仓上 */
  boards: Array<{ name: string; weightPct: number }>
  /** 预先算好的组合分析量：贡献 pp、集中度、覆盖率、汇率影响 */
  analytics: {
    topContributors: Array<{ symbol: string; name: string; weightPct: number; pct: number; contributionPp: number }>
    topDetractors: Array<{ symbol: string; name: string; weightPct: number; pct: number; contributionPp: number }>
    concentration: { top3WeightPct: number; top5WeightPct: number }
    coverage: { coveredFunds: number; blindFunds: number; coveredValuePct: number }
    fxImpactPp: number
    fundMoves: Array<{ code: string; name: string; pct: number; amount: number }>
  }
  funds: Array<{
    code: string
    name: string
    marketValue: number
    amount: number
    pct: number
    holdingProfit: number
    coveredWeight: number
    board: string | null
    navDate: string | null
    sessionsSinceNav: number
  }>
  stocks: Array<AnalysisStockInput & { asOf: string }>
  news: Array<AnalysisNewsInput & { related: string[] }>
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
const round = (n: number, digits = 2): number =>
  Number.isFinite(n) ? Number(n.toFixed(digits)) : 0

export function buildAnalysisSnapshot(input: BuildSnapshotInput): AnalysisSnapshot {
  const asOf =
    input.phase === 'pre' ? '上一交易日收盘' : input.phase === 'live' ? '当前时段' : '最近收盘'
  const totalValue = input.totals.value
  const boardTotals = new Map<string, number>()
  for (const fund of input.funds) {
    if (fund.board === null || !Number.isFinite(fund.marketValue)) continue
    boardTotals.set(fund.board, (boardTotals.get(fund.board) ?? 0) + fund.marketValue)
  }
  const boards = [...boardTotals.entries()]
    .map(([name, value]) => ({ name, weightPct: totalValue > 0 ? round((value / totalValue) * 100, 2) : 0 }))
    .sort((a, b) => b.weightPct - a.weightPct)

  // ---- 组合分析量：模型不该自己算，这些数直接给它 ----
  // 贡献 pp = 组合权重 × 个股涨跌；用传进来的聚合结果，不再重复汇总一遍
  const stockRows = input.stocks.map((stock) => ({
    symbol: stock.symbol,
    name: stock.name,
    weightPct: round(stock.weightPct),
    pct: round(stock.pct),
    contributionPp: round((stock.weightPct * stock.pct) / 100, 3),
  }))
  const byContribution = [...stockRows].sort((a, b) => b.contributionPp - a.contributionPp)
  const topContributors = byContribution.filter((row) => row.contributionPp > 0).slice(0, 3)
  const topDetractors = [...byContribution].reverse().filter((row) => row.contributionPp < 0).slice(0, 3)

  const weights = [...stockRows].map((row) => row.weightPct).sort((a, b) => b - a)
  const concentration = {
    top3WeightPct: round(weights.slice(0, 3).reduce((sum, w) => sum + w, 0)),
    top5WeightPct: round(weights.slice(0, 5).reduce((sum, w) => sum + w, 0)),
  }

  const coveredFunds = input.funds.filter((f) => f.coveredWeight > 0).length
  const coveredValue = input.funds.reduce(
    (sum, f) => sum + (f.coveredWeight > 0 ? f.marketValue : 0),
    0,
  )
  const coverage = {
    coveredFunds,
    blindFunds: input.funds.length - coveredFunds,
    coveredValuePct: totalValue > 0 ? round((coveredValue / totalValue) * 100) : 0,
  }
  const fxImpactPp = input.fx !== null ? round(input.fx.pct * (coveredValue / Math.max(totalValue, 1)), 3) : 0

  const fundMoves = [...input.funds]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5)
    .map((f) => ({ code: f.code, name: f.name, pct: round(f.navPct, 3), amount: round(f.amount) }))

  return {
    phase: input.phase,
    atMs: input.atMs,
    clock: sessionClock(input.phase, input.atMs),
    totalValue: round(totalValue),
    totalAmount: round(input.totals.amount),
    totalAmountPct: input.totals.amountPct === null ? null : round(input.totals.amountPct, 3),
    totalHoldingProfit: round(input.totals.holdingProfit),
    totalHoldingPct: input.totals.holdingPct === null ? null : round(input.totals.holdingPct, 3),
    fx:
      input.fx === null
        ? null
        : { pair: input.fx.pair, rate: round(input.fx.rate, 4), pct: round(input.fx.pct, 3) },
    indices: input.indices.map((item) => ({ name: item.name, pct: round(item.pct), asOf })),
    boards,
    analytics: {
      topContributors,
      topDetractors,
      concentration,
      coverage,
      fxImpactPp,
      fundMoves,
    },
    funds: input.funds.map((f) => ({
      code: f.code,
      name: f.name,
      marketValue: round(f.marketValue),
      amount: round(f.amount),
      pct: round(f.navPct, 3),
      holdingProfit: round(f.holdingProfit),
      coveredWeight: f.coveredWeight,
      board: f.board,
      navDate: f.navDate ?? null,
      sessionsSinceNav: f.sessionsSinceNav ?? 0,
    })),
    stocks: input.stocks.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      weightPct: round(s.weightPct),
      pct: round(s.pct),
      asOf,
    })),
    news: input.news.map((n) => ({
      title: n.title,
      tsMs: n.tsMs,
      important: n.important,
      related: relatedSymbols(n.title, input.stocks),
    })),
  }
}

export interface AnalysisDriver {
  label: string
  detail: string
}

export interface AnalysisEvent {
  title: string
  impact: string
}

export interface AnalysisScenario {
  name: string
  trigger: string
  implication: string
}

export interface AnalysisResult {
  headline: string
  summary: string[]
  drivers: AnalysisDriver[]
  events: AnalysisEvent[]
  scenarios: AnalysisScenario[]
  risks: string[]
  dataGaps: string[]
  confidence: { level: string; reason: string } | null
  watch: string[]
  model: string
  generatedAt: number
  cached: boolean
  disclaimer: string
}

export interface AiProfileView {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  maskedKey: string
}

export interface AiConfigView {
  activeId: string
  profiles: AiProfileView[]
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

const CN_STAMP = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const ET_STAMP = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const SESSION_LABEL: Record<AnalysisPhase, string> = {
  pre: '美股盘前（美东 04:00–09:30）',
  live: '美股盘中（美东 09:30–16:00）',
  settled: '美股已收盘（等待官方净值）',
}

/**
 * 给模型的时间上下文。
 *
 * 「纳指100 +2.28%」在盘前是**上一交易日收盘**的涨幅，不是今天盘前的涨跌。
 * 这个区别人一眼能看出来，模型不会——所以把时区、阶段、以及「哪些字段属于上一场」
 * 直接写成字符串塞进快照，而不是指望它从 phase 推断。
 */
function stamp(format: Intl.DateTimeFormat, ms: number): string {
  const parts = format.formatToParts(new Date(ms))
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

export function sessionClock(phase: AnalysisPhase, atMs: number): AnalysisClock {
  const note =
    phase === 'pre'
      ? 'indices 与 stocks 的 asOf 是「上一交易日收盘」，代表上一场常规时段；不要把它们的涨跌说成今天盘前。今天盘前的变动只在 funds[].pct（相对昨收）里。'
      : phase === 'live'
        ? 'indices 与 stocks 是当前常规时段（盘中）的数据；funds[].pct 是相对昨收的当日估算。'
        : 'indices 与 stocks 是最近一个常规时段收盘的数据；基金官方净值尚未公布，funds[].pct 仍是估算。'
  return {
    local: stamp(CN_STAMP, atMs),
    et: `${stamp(ET_STAMP, atMs)} ET`,
    session: SESSION_LABEL[phase],
    note,
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 标题命中的持仓个股（中文名长度 >= 2；ticker 要求词边界） */
export function relatedSymbols(title: string, stocks: readonly AnalysisStockInput[]): string[] {
  const hits: string[] = []
  for (const stock of stocks) {
    const name = stock.name.trim()
    if (name.length >= 2 && title.includes(name)) {
      hits.push(stock.symbol)
      continue
    }
    if (stock.symbol !== '') {
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(stock.symbol)}([^A-Za-z0-9]|$)`, 'i')
      if (re.test(title)) hits.push(stock.symbol)
    }
  }
  return hits
}
