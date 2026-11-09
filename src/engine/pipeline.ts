import type { Holding, Phase, Quote } from '../types'
import { estimateNav } from './estimate'

export interface BuildInput {
  code: string
  name: string
  shares: number
  costBasis: number
  nav: number                 // 最新官方净值
  holdings: Holding[]
  quotes: Map<string, Quote>
  fxNow: number
  fxPrev: number
  exposure: number
  lagDays: number
  phase: Phase
  residualPct?: number
  /** 取价前被剔除的港股数量（route 过滤，这里只负责如实上报） */
  excludedHk?: number
  /** 权重来源：指数全量成分（≈100% 覆盖）/ 基金披露的前十大（40~70%）/ 无持仓 */
  weightsFrom?: 'index' | 'top10' | 'none'
}

export interface FundEstimate {
  code: string
  name: string
  phase: Phase
  navPct: number
  nav: number
  shares: number
  costBasis: number
  marketValue: number
  amount: number              // 当日估算收益（元）
  holdingProfit: number       // 累计持有收益（元）
  coveredWeight: number
  /** 参与计算的持仓只数（已剔除港股与无行情） */
  holdingsCount: number
  lagDays: number
  weightsFrom: 'index' | 'top10' | 'none'
  /** 让界面能说"含港股 N 只，已排除" */
  excluded: { hk: number }
  missing: string[]
  breakdown: Array<{ symbol: string; weight: number; pct: number; contribution: number }>
}

/**
 * 纯函数：不做 IO，便于单测。行情缺失的股票剔除并计入 missing，覆盖率如实上报。
 *
 * 与数据层的连接契约（Task 7.5 加固后）：
 * - quotes 是「实际拿到的」行情，允许比 holdings 少；join 必须用 `quotes.has(symbol)`，
 *   绝不能按下标或按条数对齐——缺一只票就会让整列错位。
 * - quotes 为空是合法输入（没有任何源能解析这些符号时 registry 返回空 Map 而不抛错），
 *   此时 coveredWeight = 0、navPct = 0，界面据此显示"无覆盖"，而不是假装估出了 0%。
 * - 港股已由调用方在取价前剔除（引擎只有一条 USD/CNY 汇率，港币资产会被错误折算）。
 */
export function buildEstimate(input: BuildInput): FundEstimate {
  const { holdings, quotes } = input
  const available = holdings.filter((h) => quotes.has(h.symbol))
  const missing = holdings.filter((h) => !quotes.has(h.symbol)).map((h) => h.symbol)

  const result = estimateNav({
    holdings: available.map((h) => ({ ...h, pct: quotes.get(h.symbol)!.pct })),
    fxNow: input.fxNow,
    fxPrev: input.fxPrev,
    exposure: input.exposure,
    residualPct: input.residualPct,
  })

  const base = input.shares * input.nav
  const marketValue = base * (1 + result.navPct / 100)
  return {
    code: input.code,
    name: input.name,
    phase: input.phase,
    navPct: result.navPct,
    nav: input.nav,
    shares: input.shares,
    costBasis: input.costBasis,
    marketValue,
    amount: base * (result.navPct / 100),
    holdingProfit: marketValue - input.costBasis,
    coveredWeight: result.coveredWeight,
    holdingsCount: available.length,
    lagDays: input.lagDays,
    weightsFrom: input.weightsFrom ?? (holdings.length > 0 ? 'top10' : 'none'),
    excluded: { hk: input.excludedHk ?? 0 },
    missing,
    breakdown: result.breakdown,
  }
}
