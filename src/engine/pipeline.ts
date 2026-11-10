import type { AfterHoursQuote, Holding, Phase, Quote } from '../types'
import { estimateAfterHours, estimateExtendedHours } from './afterHours'
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
  /** 配了跟踪指数却拉不到成分（取数失败），不是「没配置」 */
  indexWeightsUnavailable?: boolean
  /** 关联板块（跟踪指数的中文名，如「纳斯达克100」）；null 表示没配 index_key */
  board?: string | null
  /**
   * 盘后行情。只有 `phase === 'settled'` 时调用方才会传（盘中谈「夜盘」没有意义），
   * 覆盖率不够或一只都没有时，buildEstimate 自己把 afterHours 整块省掉。
   */
  afterHours?: Map<string, AfterHoursQuote>
  /**
   * 盘前行情。只有 `phase === 'pre'` 时调用方才传。
   *
   * 为什么与 afterHours 分开而不是共用一份：这两个时段看到的数字**基准相同、
   * 含义相反**——盘前是"今天还没开盘"的变化，盘后是"今天已经收完"的变化。
   * 混在一个字段里，界面就没法说清「你现在看的是哪一段时间」。
   */
  preMarket?: Map<string, AfterHoursQuote>
  /**
   * 盘前时段「指数口径」的涨跌幅（来自跟踪同一指数的 ETF，如 NDX100→QQQ）。
   *
   * 有它就用它，而不是拿成分自算：成分权重是我们按市值归一化的近似，
   * 而指数用的是修正市值加权，大盘股分化时能差 0.3pp（实测 2026-11-10 盘前）。
   * 与常规时段「有官方指数涨跌幅就用官方」是同一条原则。
   */
  preMarketIndexPct?: number
}

/** 一组延伸时段行情里最新的成交时刻（没有就是 0，界面对 0 不渲染时间） */
function latestTs(quotes: Map<string, AfterHoursQuote> | undefined): number {
  if (!quotes) return 0
  let latest = 0
  for (const q of quotes.values()) if (Number.isFinite(q.tsMs) && q.tsMs > latest) latest = q.tsMs
  return latest
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
  /** 配了跟踪指数却拉不到成分权重，退回前十大。与「压根没配指数」是两回事 */
  indexWeightsUnavailable: boolean
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
  /**
   * 盘前估值的第二组数字。**可选**：只有 `phase === 'pre'`、且拿到盘前成交、
   * 覆盖率过 0.3 才出现。
   *
   * 与 navPct 的关系是**先后两段**而不是"覆盖"：navPct 是上一交易日收盘那一段
   * （常规接口在盘前只给这个），这一块是今天盘前进行中的那一段。两个数都真，
   * 但只有这一块是"现在"。
   */
  preMarket?: {
    navPct: number
    amount: number
    /** 有盘前成交的成分权重之和（0~1） */
    coveredWeight: number
    /** 盘前最后一笔成交时刻 */
    asOfMs: number
    /**
     * 这条盘前数字的口径：
     * - `index`：跟踪指数的 ETF（QQQ/SPY）盘前涨跌 + 汇率腿 × exposure
     * - `constituents`：成分权重加权（主动基金只有这一条路）
     */
    basis: 'index' | 'constituents'
    /** 成分口径的原始加权涨跌（百分数）。与 basis='index' 同时存在时可用于对账 */
    constituentPct?: number
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

  // 盘前那条腿。两条口径：
  // ① 有指数代理（QQQ/SPY）→ 用 ETF 涨跌，和常规时段用官方指数涨跌幅同理；
  // ② 没有（主动基金）→ 退回成分加权，同一道 0.3 覆盖率门槛。
  const preConstituents = input.preMarket
    ? estimateExtendedHours({
        holdings,
        afterHours: input.preMarket,
        fxNow: input.fxNow,
        fxPrev: input.fxPrev,
        exposure: input.exposure,
      })
    : null
  const preIndex =
    input.preMarketIndexPct !== undefined && Number.isFinite(input.preMarketIndexPct)
      ? input.preMarketIndexPct
      : undefined
  const preFx = input.fxPrev > 0 ? input.fxNow / input.fxPrev - 1 : 0
  const preMarket =
    preIndex !== undefined
      ? {
          navPct: input.exposure * ((1 + preIndex / 100) * (1 + preFx) - 1) * 100,
          amount: 0, // 下面用 base 补
          coveredWeight: 1,
          // 取最新一笔，而不是 Map 里的任意一条：这个时间会被显示成「更新于 04:30 ET」
          asOfMs: latestTs(input.preMarket),
          basis: 'index' as const,
          ...(preConstituents ? { constituentPct: preConstituents.stockPct } : {}),
        }
      : preConstituents
        ? {
            navPct: preConstituents.navPct,
            amount: 0,
            coveredWeight: preConstituents.coveredWeight,
            asOfMs: preConstituents.asOfMs,
            basis: 'constituents' as const,
          }
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
    // 只有「配了指数 + 退回前十大 + 确实有持仓」才算取数失败
    indexWeightsUnavailable:
      input.indexWeightsUnavailable === true && (input.weightsFrom ?? '') === 'top10',
    // 唯一真源就是 indexPct 本身：拿到且是有限数才算「指数口径生效」，
    // 不另设一个可以被忘掉同步的入参（那正是这次静默降级的成因）
    indexPctAvailable: input.indexPct !== undefined && Number.isFinite(input.indexPct),
    board: input.board ?? null,
    excluded: { hk: input.excludedHk ?? 0 },
    missing,
    breakdown: result.breakdown,
    ...(preMarket && input.phase === 'pre'
      ? {
          preMarket: {
            ...preMarket,
            amount: base * (preMarket.navPct / 100),
          },
        }
      : {}),
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
