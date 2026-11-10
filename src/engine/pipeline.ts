import type { AfterHoursQuote, Holding, Phase, Quote } from '../types'
import { estimateAfterHours } from './afterHours'
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
  /** 跟踪指数的官方涨跌幅（百分数）；有则替代成分加权 */
  indexPct?: number
  /** 取价前被剔除的港股数量（route 过滤，这里只负责如实上报） */
  excludedHk?: number
  /** 权重来源：指数全量成分（≈100% 覆盖）/ 基金披露的前十大（40~70%）/ 无持仓 */
  weightsFrom?: 'index' | 'top10' | 'none'
  /** 关联板块（跟踪指数的中文名，如「纳斯达克100」）；null 表示没配 index_key */
  board?: string | null
  /**
   * 盘后行情。只有 `phase === 'settled'` 时调用方才会传（盘中谈「夜盘」没有意义），
   * 覆盖率不够或一只都没有时，buildEstimate 自己把 afterHours 整块省掉。
   */
  afterHours?: Map<string, AfterHoursQuote>
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
  /**
   * 官方指数涨跌幅是否真的拿到了。
   *
   * 为什么单独一个标记：`weightsFrom === 'index'` 只说明**成分权重**来自指数全量名单，
   * 不代表涨跌幅走了指数口径。指数涨跌幅取不到时（东财闭市后返回空 body），
   * navPct 会静默退回成分加权自算——那是**另一套方法论**，数字却看着一样正常，
   * 还会随盘后零星成交一直漂。这里如实标出来，界面才能说
   * 「指数口径不可用，当前为成分加权」，而不是让人以为看到的是指数口径。
   */
  indexPctAvailable: boolean
  /** 关联板块：跟踪指数的中文名，界面用它分 tab、也对它去匹配指数涨跌幅 */
  board: string | null
  /** 让界面能说"含港股 N 只，已排除" */
  excluded: { hk: number }
  missing: string[]
  breakdown: Array<{ symbol: string; name: string; weight: number; pct: number; contribution: number }>
  /**
   * 夜盘（盘后）估值的第二组数字。**可选**：没有盘后行情、覆盖率不足 0.3、
   * 或当前是盘中，这个键就根本不出现——界面据此决定要不要多渲染一行，
   * 所以绝不能写 0 占位（那会画出「夜盘 +0.00%」这种假数据）。
   *
   * 与 navPct 的关系：navPct 仍是「截至常规收盘」的估算，这一块是补充读数，
   * 两者互不覆盖。
   */
  afterHours?: {
    navPct: number
    amount: number
    /** 有盘后行情的成分权重之和（0~1），界面可据此说明「覆盖 xx%」 */
    coveredWeight: number
    /** 盘后最新成交时刻 */
    asOfMs: number
  }
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
    // 名称优先级：行情源的中文名（东财 f14）> 指数报文的英文公司名 > ticker
    holdings: available.map((h) => {
      const q = quotes.get(h.symbol)!
      return { ...h, name: q.name?.trim() || h.name || h.symbol, pct: q.pct }
    }),
    fxNow: input.fxNow,
    fxPrev: input.fxPrev,
    exposure: input.exposure,
    residualPct: input.residualPct,
    indexPct: input.indexPct,
  })

  const base = input.shares * input.nav
  const marketValue = base * (1 + result.navPct / 100)

  // 夜盘那条腿：只有调用方给了盘后行情才算。算不出来（覆盖率 < 0.3、一只都没有）
  // 就整块省掉——用 `...{}` 而不是把 afterHours 设成 undefined，JSON 里连键都不出现。
  const afterHours = input.afterHours
    ? estimateAfterHours({
        holdings,
        afterHours: input.afterHours,
        fxNow: input.fxNow,
        fxPrev: input.fxPrev,
        exposure: input.exposure,
      })
    : null

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
    // 唯一真源就是 indexPct 本身：拿到且是有限数才算「指数口径生效」，
    // 不另设一个可以被忘掉同步的入参（那正是这次静默降级的成因）
    indexPctAvailable: input.indexPct !== undefined && Number.isFinite(input.indexPct),
    board: input.board ?? null,
    excluded: { hk: input.excludedHk ?? 0 },
    missing,
    breakdown: result.breakdown,
    ...(afterHours
      ? {
          afterHours: {
            navPct: afterHours.navPct,
            // 与 navPct 同口径：市值 = 份额 × 净值，再乘这条腿的涨跌幅
            amount: base * (afterHours.navPct / 100),
            coveredWeight: afterHours.coveredWeight,
            asOfMs: afterHours.asOfMs,
          },
        }
      : {}),
  }
}
