/**
 * 夜盘那一行的展示口径。主页面与桌面小部件共用同一份，两处数字永远不会打架。
 *
 * 只做两件事：把多只基金的夜盘估值压成一个加权数、把盘后时刻格式化成
 * 「19:59 ET」。没有任何降级分支——没有数据时返回 null，由调用方整行不渲染
 * （绝不显示「夜盘 —」）。
 */

/** 与 FundEstimate.afterHours 同形；只声明用到的字段，便于测试造数据 */
export interface AfterHoursLite {
  navPct: number
  amount: number
  coveredWeight: number
  asOfMs: number
}

export interface AfterHoursFund {
  code: string
  marketValue: number
  afterHours?: AfterHoursLite
}

export interface AfterHoursSummary {
  /** 加权后的夜盘估值涨跌幅（百分数） */
  pct: number
  /** 参与汇总的基金只数 */
  count: number
  /** 最新的一条盘后成交时刻 */
  asOfMs: number
}

/**
 * 多只基金 → 一个加权夜盘数。权重用**基金市值**：赚 1% 于 10 万的仓位，
 * 与赚 1% 于 1 千的仓位，对「今晚我的账户大概怎么样」的贡献不是一回事。
 * 简单平均会让一只小仓位的票把结论带偏。
 *
 * 没有一只有夜盘数据（盘前、周末、源挂了）就返回 null。
 */
export function summarizeAfterHours(
  funds: readonly AfterHoursFund[],
): AfterHoursSummary | null {
  const hit = funds.filter((f): f is AfterHoursFund & { afterHours: AfterHoursLite } =>
    f.afterHours !== undefined,
  )
  if (hit.length === 0) return null

  const weight = hit.reduce((sum, f) => sum + (Number.isFinite(f.marketValue) ? f.marketValue : 0), 0)
  if (!(weight > 0)) return null

  const pct = hit.reduce((sum, f) => sum + f.afterHours.navPct * f.marketValue, 0) / weight
  if (!Number.isFinite(pct)) return null

  const asOfMs = hit.reduce((latest, f) => Math.max(latest, f.afterHours.asOfMs), 0)
  return { pct, count: hit.length, asOfMs }
}

/**
 * 盘后时刻 -> '19:59 ET'。用美东时区格式化：报文里的 EST/EDT 换算已经做过一次，
 * 这里再交给 Intl 显示，冬夏令时由运行时决定，不会在切换日显示错一小时。
 */
const ET_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function afterHoursClock(asOfMs: number): string | null {
  if (!Number.isFinite(asOfMs) || asOfMs <= 0) return null
  return `${ET_CLOCK.format(new Date(asOfMs))} ET`
}
