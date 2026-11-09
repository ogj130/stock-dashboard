import type { MarketStatus, Phase } from '../types'

/**
 * 相位只由交易所状态决定，不自行推算时区——
 * 美东冬夏令时每年切换两次，硬编码必错。
 */
export function derivePhase(status: MarketStatus): Phase {
  return status === 'PRE_MKT' || status === 'REG_MKT' ? 'live' : 'settled'
}

/** 盘前流动性薄，价格跳动大，只能作为参考，不得覆盖已定的夜间估值 */
export function isPreMarket(status: MarketStatus): boolean {
  return status === 'PRE_MKT'
}

/**
 * 美东市场钟点的格式化器。
 * `hourCycle: 'h23'` 让午夜稳定输出 `00`（默认 h24 在部分 ICU 上输出 `24`）；
 * 下面的 `hour % 24` 仍保留一层防御，任何 ICU 差异都不会把午夜算成 24 点。
 * `Intl` 自带时区数据库，冬夏令时切换由运行时处理，不手写规则。
 */
const NY_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
})

const PRE_START = 4 * 60
const REG_OPEN = 9 * 60 + 30
const REG_CLOSE = 16 * 60
const POST_CLOSE = 20 * 60
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

/**
 * 本地时区兜底：仅在 CNBC 状态不可用时使用。
 *
 * 为什么必须存在：`normalizeStatus` 遇到缺失/异常字段会兜底成 `'CLOSED'`。
 * 若把这个当成真值，正在盘中的活跃时段会被误判成"已收盘"，
 * 界面就会冻结一个本该跳动的数字——比报错更危险。
 * 所以兜底是"用本地时钟算"，而不是"默认已收盘"。
 *
 * 判定依据美东当地钟点（周六、周日整日闭市）：
 * 04:00–09:30 盘前 / 09:30–16:00 盘中 / 16:00–20:00 盘后 / 其余闭市。
 * 注意：这里不识别交易所假日，假日会被判成盘中——只影响"是否跳动"，不影响数值口径。
 */
export function derivePhaseLocal(now: Date = new Date()): MarketStatus {
  const parts = NY_CLOCK.formatToParts(now)
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? ''

  const weekday = get('weekday')
  if (!WEEKDAYS.has(weekday)) return 'CLOSED'

  const hourRaw = get('hour')
  const minuteRaw = get('minute')
  // ICU 理论上不会缺字段；真缺了就没有任何信息可用，只能退化成闭市，
  // 但绝不因为“解析成 0 点”就误判成盘中——那会冻结一个正在跳的数字。
  // `% 24` 兜住 h24 循环把午夜写成 `24` 的 ICU 差异。
  if (!hourRaw || !minuteRaw) return 'CLOSED'
  const mins = (Number(hourRaw) % 24) * 60 + Number(minuteRaw)

  if (mins >= PRE_START && mins < REG_OPEN) return 'PRE_MKT'
  if (mins >= REG_OPEN && mins < REG_CLOSE) return 'REG_MKT'
  if (mins >= REG_CLOSE && mins < POST_CLOSE) return 'POST_MKT'
  return 'CLOSED'
}
