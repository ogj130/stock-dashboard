/**
 * 净值口径标定与仓位系数拟合。
 *
 * 这个模块负责给估值系统算出两个「自我校正参数」：
 *   1. lag      —— 官方净值对应标的的哪一天收盘（QDII 合同差异导致 0/1/2 都有）
 *   2. exposure —— 基金实际投到标的资产上的仓位比例（联接基金常有现金拖累）
 *
 * 量纲契约：navPcts / modelPcts 均为百分数（2.31 表示 +2.31%），与 estimateNav 一致；
 * exposure 是无量纲的 0~1 系数。
 */

/** 拟合不可信时的保守默认值：联接基金把 ~95% 投进目标 ETF，其余是现金与费用。 */
export const DEFAULT_EXPOSURE = 0.95

/** exposure 的合理区间。越界说明数据有问题（单位错、lag 错、样本脏），不采信。 */
const EXPOSURE_MIN = 0.5
const EXPOSURE_MAX = 1.2

/** 少于 3 个样本时，任何相关系数/斜率都只是噪声。 */
const MIN_SAMPLES = 3

/**
 * 皮尔逊相关系数。
 *
 * 样本不足 3 个、或任一方差为 0（序列全等）时返回 0，不产生 NaN——
 * 调用方拿到 0 只会当「没相关性」，拿到 NaN 会污染整条比较链。
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n < MIN_SAMPLES) return 0

  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]!
    sy += ys[i]!
  }
  const mx = sx / n
  const my = sy / n

  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx
    const dy = ys[i]! - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }

  if (vx === 0 || vy === 0) return 0
  return cov / Math.sqrt(vx * vy)
}

/**
 * 标定净值口径：净值序列与「按权重加权的当日涨跌序列」做相关性比较，
 * 选出相关性最高的滞后天数。
 *
 * `modelByLag[L]` 必须由调用方**预先按 lag L 对齐**：即 modelByLag[L][i]
 * 是解释 navPcts[i] 的那个交易日的标的涨跌。本函数只做比较，不做位移，
 * 这样日期对齐的规则（按交易日索引还是按自然日）留给调用方决定。
 *
 * 无可用序列时返回 1（计划里的初值）。相关系数打平时保留先遍历到的 lag
 * （数值键按升序遍历，所以平手取较小的 lag）。
 */
export function pickLag(navPcts: number[], modelByLag: Record<number, number[]>): number {
  let bestLag = 1
  let best = -Infinity

  for (const key of Object.keys(modelByLag)) {
    const lag = Number(key)
    const series = modelByLag[lag]
    if (!series) continue
    const c = pearson(navPcts, series)
    if (c > best) {
      best = c
      bestLag = lag
    }
  }

  return bestLag
}

/**
 * 穿过原点的最小二乘：exposure = Σ(x·y) / Σ(x²)
 * x 为模型预测涨跌，y 为实际净值涨跌。
 *
 * 刻意不带截距：净值涨跌与标的涨跌在数学上必须同时为 0
 * （标的没动，满仓的净值也不该动），截距只会吸收脏样本。
 *
 * 样本不足 3 个、分母为 0、或拟合值落在 [0.5, 1.2] 之外时返回默认值——
 * 宁可保守，不拿一个噪声拟合去改模型。
 */
export function fitExposure(modelPcts: number[], actualPcts: number[]): number {
  const n = Math.min(modelPcts.length, actualPcts.length)
  if (n < MIN_SAMPLES) return DEFAULT_EXPOSURE

  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const x = modelPcts[i]!
    num += x * actualPcts[i]!
    den += x * x
  }

  if (den === 0) return DEFAULT_EXPOSURE

  const exposure = num / den
  return exposure >= EXPOSURE_MIN && exposure <= EXPOSURE_MAX ? exposure : DEFAULT_EXPOSURE
}
