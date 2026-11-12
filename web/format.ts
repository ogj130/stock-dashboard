/**
 * 数字/颜色的展示口径。
 *
 * 汇总卡与折线图必须用同一套格式：同一个总资产，卡片上写 84,321.30、
 * 图上写 84321.3，用户会以为其中一个算错了。
 */

export const money = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 带正负号的金额：中文习惯 + 赚 / − 亏，符号本身就是语气；0 不带符号 */
export const signedMoney = (n: number) =>
  n === 0 ? money(0) : `${n < 0 ? '-' : '+'}${money(Math.abs(n))}`

/**
 * 百分比文案。先四舍五入再决定符号：极小负数 toFixed 之后会得到 "-0.00%"，
 * 那是个看起来像 bug 的零——统一按 0.00% 写，别让「-0.00%」出现在界面上。
 */
export const pctText = (n: number) => {
  const rounded = Number(n.toFixed(2))
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`
}

/** 红涨绿跌（A 股/国内习惯），0 视为无色，避免把持平刷成一片红 */
export const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat')

/**
 * 「赚了多少」→「涨了百分之几」。
 *
 * 分母必须是**变动之前**的基准，也就是「现值 − 变动额」，而不是现值本身。
 * 拿现值当分母，涨的那天百分比会偏小、跌的那天偏大——两个方向都错，而且错得
 * 不大不小，正是那种看起来很正常、对账时才发现的错。
 *
 * 后端给这套数时是严格自洽的：marketValue = 基准 × (1 + navPct/100)、
 * amount = 基准 × navPct/100，所以 amount / (marketValue − amount) 应该正好
 * 还原出 navPct；持有收益同理（基准是成本）。
 *
 * 基准算不出来（<= 0 或非有限数）时返回 null，调用方显示「—」，绝不编一个 0%。
 */
export const pctFromDelta = (delta: number, value: number): number | null => {
  const base = value - delta
  if (!Number.isFinite(base) || base <= 0) return null
  return (delta / base) * 100
}
