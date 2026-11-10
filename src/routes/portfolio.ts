import type { FastifyInstance } from 'fastify'
import type { Db } from '../store/db'
import {
  HISTORY_DEFAULT_RANGE,
  parseRange,
  rangeFromHours,
  readHistory,
  type HistoryRange,
  type SessionKind,
} from '../store/portfolio'

export interface PortfolioHistoryResponse {
  /** 实际生效的档位（未知值会被折回 session，所以前端要以此为准） */
  range: HistoryRange
  /** 窗口边界，UI 用它标注横轴与副标题，不必自己再猜一次交易日 */
  startMs: number
  endMs: number
  /**
   * `session` 这个档位指的是哪一段：`regular` = 09:30–16:00，`pre` = 04:00–09:30。
   * 前端据此决定横轴与副标题怎么写，不必再传一次同样的参数。
   */
  session: SessionKind
  points: Array<{
    tsMs: number
    value: number
    amount: number
    profit: number
    /** 盘前口径；没有这个口径的点是 null（不要用 0 顶替） */
    valuePre: number | null
    amountPre: number | null
  }>
}

/** 是否「传了这个参数」——空串当没传，`?range=` 不该变成一次非法查询 */
function present(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  return typeof raw !== 'string' || raw.trim() !== ''
}

/**
 * `range` 优先；没给 `range` 时退回旧的 `hours`（映射到最近的档位）。
 *
 * 两个参数同时出现时以 `range` 为准：新参数是明确的意图，旧参数只是还没改的
 * 调用方。`hours` 计划在一个版本后删掉。
 */
function resolveRange(query: { range?: unknown; hours?: unknown } | undefined): HistoryRange {
  if (present(query?.range)) return parseRange(query?.range)
  if (present(query?.hours)) return rangeFromHours(query?.hours)
  return HISTORY_DEFAULT_RANGE
}

/** 金额保留两位：浮点累加出来的 84321.29999999999 不该原样吐给前端 */
const round2 = (n: number): number => Math.round(n * 100) / 100

/** null 要原样留着：那不是 0，是「这个点没有盘前口径」 */
const round2OrNull = (n: number | null): number | null => (n === null ? null : round2(n))

export interface PortfolioRouteOptions {
  /** 测试注入的时钟；线上就是 Date.now */
  now?: () => number
}

export function registerPortfolioRoutes(
  app: FastifyInstance,
  db: Db,
  options: PortfolioRouteOptions = {},
): void {
  app.get<{ Querystring: { range?: unknown; hours?: unknown; phase?: unknown } }>(
    '/api/portfolio/history',
    async (req): Promise<PortfolioHistoryResponse> => {
      const now = options.now ? options.now() : Date.now()
      // 盘前视图要盘前的窗口：不然头部写「盘前」，图还是昨天 09:30–16:00 那一场
      const session: SessionKind = req.query?.phase === 'pre' ? 'pre' : 'regular'
      const result = readHistory(db, resolveRange(req.query), now, undefined, session)
      return {
        range: result.range,
        startMs: result.startMs,
        endMs: result.endMs,
        session,
        points: result.points.map((p) => ({
          tsMs: p.tsMs,
          value: round2(p.value),
          amount: round2(p.amount),
          profit: round2(p.profit),
          valuePre: round2OrNull(p.valuePre),
          amountPre: round2OrNull(p.amountPre),
        })),
      }
    },
  )
}
