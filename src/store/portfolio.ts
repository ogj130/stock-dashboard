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

/** 历史接口一次最多回多少个点：6 小时 × 每 30 秒一行 = 720，正好是默认窗口的上限 */
export const HISTORY_MAX_POINTS = 720

export const HISTORY_DEFAULT_HOURS = 6
export const HISTORY_MIN_HOURS = 1
export const HISTORY_MAX_HOURS = 72

export interface PortfolioPoint {
  tsMs: number
  value: number
  amount: number
}

/** 取值范围是接口契约的一部分：0/负数/NaN 都退回默认值，999 夹到 72 小时 */
export function clampHours(hours: number | null | undefined): number {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return HISTORY_DEFAULT_HOURS
  return Math.min(HISTORY_MAX_HOURS, Math.max(HISTORY_MIN_HOURS, hours))
}

/**
 * 落一行快照。返回 false 表示被节流跳过（不是失败）。
 *
 * 判定依据是「库里最新一行有多老」，不是进程内的时间戳：重启后第一条请求
 * 不会因为内存计数器清零而立刻多写一行。
 */
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

/**
 * 读取窗口内的点，老 → 新。
 *
 * 节流之后 6 小时内最多 720 个点，与 HISTORY_MAX_POINTS 相等；更长的窗口
 * （72 小时最多 8640 个点）必须抽样，否则 SVG 的 d 属性会长到几十 KB，
 * 而 110px 高的画布根本分辨不出相邻两点。
 *
 * 抽样方式：按均匀下标取 max 个点，**首尾都保留**——最后一个点是「现在」，
 * 少掉它曲线就会停在几分钟前，与页面上的总资产对不上。
 */
export function listHistory(
  db: Db,
  hours: number = HISTORY_DEFAULT_HOURS,
  now: number = Date.now(),
  maxPoints: number = HISTORY_MAX_POINTS,
): PortfolioPoint[] {
  const since = now - clampHours(hours) * 3_600_000
  const rows = db
    .prepare(
      `select ts_ms as tsMs, total_value as value, total_amount as amount
         from portfolio_snapshot
        where ts_ms >= ?
        order by ts_ms asc`,
    )
    .all(since) as unknown as PortfolioPoint[]

  return downsample(rows, maxPoints)
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
