import type { Db } from './db'

/**
 * 组合市值快照的读写。
 *
 * 为什么要落库而不是只留在前端内存：页面每 5 秒轮询一次，刷新一下内存里的曲线
 * 就没了；而用户想看的正是「放上几小时，线慢慢往上爬」。所以点必须存在服务端。
 *
 * 写入侧做节流：5 秒一行的全量落库是每天 17k 行、一年 630 万行，
 * 只为了画一条 110px 高的线。30 秒一行 ≈ 每天 2880 行，视觉上完全看不出差别。
 */

/** 两行之间的最小间隔；估算路由据此决定这一跳要不要落库 */
export const SNAPSHOT_THROTTLE_MS = 30_000

/** 历史接口一次最多回多少个点：7 天 × 每 30 秒一行远超此数，必须抽样 */
export const HISTORY_MAX_POINTS = 720

/**
 * 时间窗口档位。
 *
 * 语义从「最近 N 小时」换成了「档位」，因为用户要的是「今天美股这一场」：
 * 滚动窗口在开盘前后会横跨两个交易日，画出来的涨跌既不是今天的也不是昨天的。
 * `session` 由美东交易日历算（见 sessionWindow），其余仍是滚动窗口。
 */
export const HISTORY_RANGES = ['session', '1h', '6h', '24h', '7d'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

/** 默认就是用户那句话里的「当天美股开盘到收盘」 */
export const HISTORY_DEFAULT_RANGE: HistoryRange = 'session'

/** 滚动档位的跨度；`session` 不在表里，它不是一个固定长度 */
const RANGE_SPAN_MS: Record<Exclude<HistoryRange, 'session'>, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
}

export interface PortfolioPoint {
  tsMs: number
  value: number
  amount: number
}

export interface HistoryWindow {
  startMs: number
  endMs: number
}

export interface HistoryResult extends HistoryWindow {
  range: HistoryRange
  points: PortfolioPoint[]
}

/**
 * `?range=` 的解析。未知值一律退回 session（而不是报错）：
 * 这是个纯展示接口，宁可画默认窗口，也别让用户的曲线整块消失。
 */
export function parseRange(raw: unknown): HistoryRange {
  if (typeof raw !== 'string') return HISTORY_DEFAULT_RANGE
  const text = raw.trim().toLowerCase()
  return (HISTORY_RANGES as readonly string[]).includes(text)
    ? (text as HistoryRange)
    : HISTORY_DEFAULT_RANGE
}

/**
 * 旧参数 `?hours=` 的兼容映射：取「装得下这个小时数的最小档位」。
 *
 * 不给 12 小时这种中间值造新档：多出来的点肉眼分辨不出，却会让前端的分段控件
 * 出现一个选不中的状态。7d 之上没有档位，直接落 7d。
 */
export function rangeFromHours(raw: unknown): HistoryRange {
  const num =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN
  // 坏值当没传（跟 parseRange 一致），别把 "abc" 当成 1 小时
  if (!Number.isFinite(num)) return HISTORY_DEFAULT_RANGE
  if (num <= 1) return '1h'
  if (num <= 6) return '6h'
  if (num <= 24) return '24h'
  return '7d'
}

/* ---------- 美东时区 ---------- */

const ET_ZONE = 'America/New_York'

/**
 * 从 `Intl` 的 longOffset 名字里读出偏移分钟数。
 *
 * 只认 `GMT±HH:MM` 这一种形状：`GMT`（零偏移）按 0 处理，其它形状（本地化
 * 名字、`GMT+5:30` 之外的怪格式）也按 0，宁可差一小时也不抛异常。
 * 时区偏移随 DST 变，所以这个函数必须带「哪个瞬间」——2026 年 7 月是 −04:00，
 * 11 月是 −05:00，写死任何一个都会在半年里全错一小时。
 */
function zoneOffsetMinutes(timeZone: string, atMs: number): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(atMs))
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0))
}

/**
 * 美东墙钟时间 → UTC 毫秒。不引日期库：偏移量本身能从 `Intl` 问出来。
 *
 * 偏移是「某个瞬间」的属性，而这里拿到的是墙钟数字，所以先把它当 UTC 猜一个
 * 瞬间、问出那个瞬间的偏移、再校正一次；正常情况下两轮就收敛。跨 DST 的那个
 * 小时本身有歧义（美东 01:30 那天出现两次），但美股开盘 09:30 永远不在边界上。
 */
export function etWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  let ts = naive
  for (let i = 0; i < 3; i++) {
    const next = naive - zoneOffsetMinutes(ET_ZONE, ts) * 60_000
    if (next === ts) break
    ts = next
  }
  return ts
}

export interface EtWallClock {
  year: number
  month: number
  day: number
  /** 0=周日 … 6=周六 */
  weekday: number
  hour: number
  minute: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/** `hourCycle: 'h23'` 不能省：`hour12: false` 在部分实现在午夜给出 "24"。 */
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
})

/** 某个 UTC 瞬间对应的美东墙钟 */
export function etWallClock(atMs: number): EtWallClock {
  const parts = ET_PARTS.formatToParts(new Date(atMs))
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    weekday: WEEKDAY_INDEX[pick('weekday')] ?? 0,
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
  }
}

/* ---------- 交易日窗口 ---------- */

/** 开盘 09:30，以「当天分钟数」表示，比较时不用再拆时和分 */
const SESSION_OPEN_MINUTES = 9 * 60 + 30

interface Ymd {
  y: number
  m: number
  d: number
}

/** 墙钟日期往前退一个工作日。日期算术放在 UTC 正午，不会被任何偏移影响 */
function previousWeekday({ y, m, d }: Ymd): Ymd {
  const t = new Date(Date.UTC(y, m - 1, d, 12))
  do {
    t.setUTCDate(t.getUTCDate() - 1)
  } while (t.getUTCDay() === 0 || t.getUTCDay() === 6)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** 一个完整交易日的边界（09:30–16:00 美东） */
function fullSession(day: Ymd): HistoryWindow {
  return {
    startMs: etWallClockToUtcMs(day.y, day.m, day.d, 9, 30),
    endMs: etWallClockToUtcMs(day.y, day.m, day.d, 16, 0),
  }
}

/**
 * 「最近一个美股交易日」的窗口。
 *
 * 四条规则（全部按美东墙钟判定，绝不写死 EST/EDT）：
 *   1. 今天是工作日且已过 09:30 → 今天的 09:30 到 min(现在, 16:00)；
 *   2. 今天是工作日但还没开盘 → 上一个工作日的整场；
 *   3. 今天是周末 → 上周五的整场；
 *   4. 算出来的交易日一条快照都没有（节假日）→ 顺着工作日再往前找，最多 5 次。
 *
 * 第 4 条不去维护节假日表：用「这天有没有数据」反推，感恩节、圣诞、独立日
 * 全都自动成立，代价只是长假后的第一个交易日要多看一天。
 */
export function sessionWindow(db: Db, now: number = Date.now()): HistoryWindow {
  const clock = etWallClock(now)
  const minutes = clock.hour * 60 + clock.minute
  const isWeekday = clock.weekday >= 1 && clock.weekday <= 5

  let day: Ymd = { y: clock.year, m: clock.month, d: clock.day }
  let window: HistoryWindow

  if (isWeekday && minutes >= SESSION_OPEN_MINUTES) {
    // 盘中 end 跟着现在走；收盘后 min() 自然把它钉在 16:00，
    // 所以收盘之后落的点不会混进「今天这一场」的涨跌里。
    const session = fullSession(day)
    window = { startMs: session.startMs, endMs: Math.min(now, session.endMs) }
  } else {
    day = previousWeekday(day)
    window = fullSession(day)
  }

  // 空库（刚装好、还没落过点）没有可回退的东西：硬退 5 天只会把一个诚实的时间
  // 标签变成 5 个交易日前的，读数更糟。只有当库里确实有更早的数据时才回退。
  const hasAny = db.prepare('select 1 as hit from portfolio_snapshot limit 1').get() !== undefined
  if (!hasAny) return window

  const hit = db.prepare(
    'select 1 as hit from portfolio_snapshot where ts_ms >= ? and ts_ms <= ? limit 1',
  )
  for (let i = 0; i < 5 && hit.get(window.startMs, window.endMs) === undefined; i++) {
    day = previousWeekday(day)
    window = fullSession(day)
  }
  return window
}

/* ---------- 读 ---------- */

/** 落一行快照。返回 false 表示被节流跳过（不是失败）。 */
export function recordSnapshot(
  db: Db,
  sample: { value: number; amount: number; fundCount: number },
  now: number = Date.now(),
): boolean {
  const newest = db
    .prepare('select ts_ms from portfolio_snapshot order by ts_ms desc limit 1')
    .get() as { ts_ms: number } | undefined
  if (newest && now - newest.ts_ms < SNAPSHOT_THROTTLE_MS) return false

  db.prepare(
    'insert into portfolio_snapshot (ts_ms, total_value, total_amount, fund_count) values (?,?,?,?)',
  ).run(now, sample.value, sample.amount, sample.fundCount)
  return true
}

/** 闭区间 [startMs, endMs] 内的点，老 → 新，并按 maxPoints 抽样 */
export function listWindow(
  db: Db,
  window: HistoryWindow,
  maxPoints: number = HISTORY_MAX_POINTS,
): PortfolioPoint[] {
  const rows = db
    .prepare(
      `select ts_ms as tsMs, total_value as value, total_amount as amount
         from portfolio_snapshot
        where ts_ms >= ? and ts_ms <= ?
        order by ts_ms asc`,
    )
    .all(window.startMs, window.endMs) as unknown as PortfolioPoint[]

  return downsample(rows, maxPoints)
}

/** 按档位取一个窗口的数据；路由只需要这一个入口 */
export function readHistory(
  db: Db,
  range: HistoryRange,
  now: number = Date.now(),
  maxPoints: number = HISTORY_MAX_POINTS,
): HistoryResult {
  const window: HistoryWindow =
    range === 'session'
      ? sessionWindow(db, now)
      : { startMs: now - RANGE_SPAN_MS[range], endMs: now }
  return { range, ...window, points: listWindow(db, window, maxPoints) }
}

/** 均匀抽样，保留首尾；点数已经够少时原样返回 */
export function downsample<T>(rows: T[], maxPoints: number): T[] {
  if (maxPoints <= 0) return []
  if (rows.length <= maxPoints) return rows
  if (maxPoints === 1) return [rows[rows.length - 1]!]

  const out: T[] = []
  const last = rows.length - 1
  for (let i = 0; i < maxPoints; i++) {
    const index = Math.round((i * last) / (maxPoints - 1))
    out.push(rows[index]!)
  }
  return out
}
