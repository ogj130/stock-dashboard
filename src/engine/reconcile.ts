/**
 * 对账：把「我们当时算的」和「官方后来公布的」摆在一起。
 *
 * 没有这一步，整个估值系统只是一堆看起来合理的数字——没有任何硬证据说它准。
 * 这里不做任何拟合魔法，只回答两个问题：
 *   1. 模型的逐日误差有多大（MAE / 偏差方向）
 *   2. 官方净值到底对应哪一场美股（lag），以及仓位系数该不该调
 *
 * 量纲与 calibrate.ts 一致：全部用百分数（2.31 = +2.31%）。
 */

/** 官方公布的一天：净值日 + 当日涨跌幅 */
export interface NavDay {
  date: string
  pct: number
}

/** 一条对齐后的残差：模型指着某一场，官方在某一天公布了结果 */
export interface Residual {
  /** 我们估的是哪一场美股（estimate_log.target_nav_date） */
  modelDate: string
  /** 官方净值日 */
  navDate: string
  modelPct: number
  actualPct: number
  /** 模型 − 实际；正数 = 我们高估了 */
  diff: number
}

const DAY_MS = 86_400_000

/** "2026-11-06" → UTC 正午的毫秒（正午避免任何时区/夏令时把日期推走一天） */
export function dateToMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return NaN
  return Date.UTC(y, m - 1, d, 12)
}

/** 日期加减天数，回 "YYYY-MM-DD" */
export function shiftDate(date: string, days: number): string {
  const ms = dateToMs(date)
  if (!Number.isFinite(ms)) return date
  const t = new Date(ms + days * DAY_MS)
  const y = t.getUTCFullYear()
  const m = String(t.getUTCMonth() + 1).padStart(2, '0')
  const d = String(t.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 对齐规则：一场美股 → 它之后的**第 slot 次净值公布**。
 *
 * 早先按自然日推（navDate = modelDate + 1）在周末必错：周五那场美股的净值是
 * 下周一公布的，自然日差 3 天；而周一那场的净值是周二公布的，差 1 天。
 * 用固定天数对齐，会让周末附近的样本全部错位，MAE 看起来很差却不是模型的问题。
 *
 * 现在改成用**实际公布的日期序列**：对每一场 m，取严格晚于 m 的那些净值日里
 * 第 slot 个（slot 从 1 开始）。这样节假日、周末、基金自己的停报都被自动跳过，
 * slot 的语义也稳定：「净值在那一场之后第几次公布」。
 *
 * 为什么结构上必然是「之后」而不是「当天」：美股收盘是北京时间次日凌晨，
 * 所以 D 这一天公布的 QDII 净值不可能含有 D 那场美股的结果。
 */
export function alignResiduals(
  modelByDate: ReadonlyMap<string, number>,
  navs: readonly NavDay[],
  slot = 1,
): Residual[] {
  const published = navs
    .filter((n) => Number.isFinite(n.pct) && typeof n.date === 'string')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
  if (published.length === 0) return []

  const out: Residual[] = []
  const sessionDates = [...modelByDate.keys()].sort((a, b) => a.localeCompare(b))
  for (const modelDate of sessionDates) {
    const modelPct = modelByDate.get(modelDate)!
    if (!Number.isFinite(modelPct)) continue
    // 第一个严格晚于这场美股的公布日
    const first = published.findIndex((n) => n.date > modelDate)
    if (first < 0) continue
    const nav = published[first + slot - 1]
    if (!nav) continue
    out.push({
      modelDate,
      navDate: nav.date,
      modelPct,
      actualPct: nav.pct,
      diff: modelPct - nav.pct,
    })
  }
  return out
}

export interface ResidualSummary {
  /** 样本数 */
  n: number
  /** 平均绝对误差（百分点） */
  mae: number
  /** 平均偏差：正 = 系统性高估 */
  bias: number
  /** 最大单日绝对误差 */
  maxAbs: number
}

export function summarize(residuals: readonly Residual[]): ResidualSummary {
  if (residuals.length === 0) return { n: 0, mae: 0, bias: 0, maxAbs: 0 }
  let sumAbs = 0
  let sum = 0
  let maxAbs = 0
  for (const r of residuals) {
    const abs = Math.abs(r.diff)
    sumAbs += abs
    sum += r.diff
    if (abs > maxAbs) maxAbs = abs
  }
  return {
    n: residuals.length,
    mae: sumAbs / residuals.length,
    bias: sum / residuals.length,
    maxAbs,
  }
}

export interface SlotFit {
  /** 净值在那一场之后第几次公布（1 = 次日公布，QDII 常态） */
  slot: number
  /** 该 slot 下的 MAE */
  mae: number
  samples: number
  /** 所有候选的 MAE，供人工核对 */
  candidates: Array<{ slot: number; mae: number; samples: number }>
}

export const MIN_SAMPLES = 6

/**
 * 用全部样本试每个候选 slot，取总 MAE 最小的那个。
 *
 * 为什么用 MAE 而不是相关系数：这里要的是「哪种对齐让数值最接近」，
 * 相关系数对幅度不敏感——一个系统性放大两倍的模型相关性照样接近 1。
 *
 * 样本不足（< MIN_SAMPLES）时不给结论：lag 回 1（QDII 常态的结构性事实），
 * 但 `samples` 如实报出来，界面据此显示「还不够对账」而不是一个漂亮的 0.00。
 */
export function fitSlot(
  modelByFund: ReadonlyMap<string, ReadonlyMap<string, number>>,
  navsByFund: ReadonlyMap<string, readonly NavDay[]>,
  candidates: readonly number[] = [1, 2, 3],
): SlotFit {
  const scored = candidates.map((slot) => {
    let sumAbs = 0
    let n = 0
    for (const [fund, navs] of navsByFund) {
      const model = modelByFund.get(fund)
      if (!model) continue
      for (const r of alignResiduals(model, navs, slot)) {
        sumAbs += Math.abs(r.diff)
        n += 1
      }
    }
    return { slot, mae: n > 0 ? sumAbs / n : Number.POSITIVE_INFINITY, samples: n }
  })

  const best = scored.reduce((a, b) => (b.mae < a.mae ? b : a))
  const enough = best.samples >= MIN_SAMPLES
  return {
    slot: enough ? best.slot : 1,
    mae: enough ? best.mae : 0,
    samples: best.samples,
    candidates: scored,
  }
}
