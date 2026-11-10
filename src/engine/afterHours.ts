import type { AfterHoursQuote, Holding } from '../types'

/**
 * 覆盖率门槛：低于这个比例就不出夜盘数字。
 *
 * 理由与估值引擎的 residualPct 不同——常规收盘那一路可以用「未覆盖部分与已覆盖同涨」
 * 外推，因为那是同一天的同一批资产；夜盘的成交更薄、更离散，用 30% 的权重去代表
 * 另外 70% 出来的数字是噪声，还会被用户当成"今晚净值"照着下单。
 * 0.3 ≈ 前十大披露口径的最低可用覆盖率（270042 实测 0.4276），再低就只剩个别票撑场。
 */
export const AFTER_HOURS_MIN_COVERED_WEIGHT = 0.3

export interface AfterHoursEstimateInput {
  holdings: Holding[]
  /** 只含「确实拿到盘后行情」的股票 */
  afterHours: Map<string, AfterHoursQuote>
  fxNow: number
  fxPrev: number
  exposure: number
}

export interface AfterHoursEstimate {
  /** 盘后口径的净值涨跌幅（百分数） */
  navPct: number
  /** 股票腿原始加权涨跌幅（未乘 exposure、未叠加汇率） */
  stockPct: number
  /** 参与计算的权重之和（已夹到 0~1） */
  coveredWeight: number
  /** 参与计算的盘后成交时刻里最新的那个（用于「更新于 19:59 ET」） */
  asOfMs: number
}

/**
 * 延伸时段估值（盘前与夜盘共用）。纯函数，不做 IO。
 *
 * 盘前与夜盘的数学完全一样：两边的涨跌幅都以**上一交易日收盘**为基准，
 * 都不该用 indexPct（那是常规时段的数），也都不能用 residualPct 外推
 * （时段成交薄，外推会把噪声放大成"净值"）。差别只在取数来源与文案。
 * 所以这里一个函数两种用法，靠调用方决定传哪批行情。
 *
 *   r_stock = Σ(wᵢ·ahPctᵢ) / Σwᵢ        只对**有盘后行情**的成分做加权
 *   r_fx    = fxNow/fxPrev − 1           与收盘估值同一条汇率腿
 *   r_asset = (1 + r_stock/100)(1 + r_fx) − 1
 *   navPct  = exposure · r_asset · 100
 *
 * 与 estimateNav 的三处刻意不同：
 * ① 不用 indexPct：官方指数涨跌是**常规时段**的数，拿它当夜盘等于把白天的涨幅
 *    再算一遍，会得出「夜盘又涨了 2.5%」这种假数字；
 * ② 不做 residualPct 外推：覆盖不到的部分就靠 0.3 的门槛挡住，不外推；
 * ③ 分母只用有盘后行情的成分权重（Σw 是子集），因为基准是「这半批资产的盘后表现」。
 */
export function estimateExtendedHours(input: AfterHoursEstimateInput): AfterHoursEstimate | null {
  const { holdings, afterHours, fxNow, fxPrev, exposure } = input

  const usable = holdings.filter((h) => afterHours.has(h.symbol))
  const weightSum = usable.reduce((sum, h) => sum + h.weight, 0)
  // 权重全是 0（脏数据/空持仓）时不做除法：0/0 会给出 NaN，而 NaN 会被当成「有值」传下去
  if (usable.length === 0 || !(weightSum > 0)) return null

  // 与引擎一致：权重可能 > 1（脏数据），两头夹住再与门槛比较
  const coveredWeight = Math.min(1, weightSum)
  if (coveredWeight < AFTER_HOURS_MIN_COVERED_WEIGHT) return null

  const weighted = usable.reduce((sum, h) => sum + h.weight * afterHours.get(h.symbol)!.pct, 0) / weightSum
  const rFx = fxPrev > 0 ? fxNow / fxPrev - 1 : 0
  const rAsset = (1 + weighted / 100) * (1 + rFx) - 1
  const navPct = exposure * rAsset * 100
  if (!Number.isFinite(navPct)) return null

  const asOfMs = usable.reduce((latest, h) => {
    const ts = afterHours.get(h.symbol)!.tsMs
    return Number.isFinite(ts) && ts > latest ? ts : latest
  }, 0)

  return { navPct, stockPct: weighted, coveredWeight, asOfMs }
}

/** 夜盘入口：语义别名，别让调用方以为盘前也走这条取名 */
export const estimateAfterHours = estimateExtendedHours
