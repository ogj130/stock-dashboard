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

export const pctText = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`

/** 红涨绿跌（A 股/国内习惯），0 视为无色，避免把持平刷成一片红 */
export const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat')
