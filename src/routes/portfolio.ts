import type { FastifyInstance } from 'fastify'
import type { Db } from '../store/db'
import { clampHours, listHistory } from '../store/portfolio'

export interface PortfolioHistoryResponse {
  points: Array<{ tsMs: number; value: number; amount: number }>
}

/**
 * `?hours=6` 的解析。
 *
 * 空串必须单独拦掉：Number('') === 0 是有限数，会被夹成 1 小时，
 * 于是「没传参数」变成「只看最近一小时」，曲线突然只剩几个点。
 */
function parseHours(raw: unknown): number {
  if (typeof raw === 'number') return clampHours(raw)
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return clampHours(null)
    const num = Number(text)
    return clampHours(Number.isFinite(num) ? num : null)
  }
  return clampHours(null)
}

/** 金额保留两位：浮点累加出来的 84321.29999999999 不该原样吐给前端 */
const round2 = (n: number): number => Math.round(n * 100) / 100

export function registerPortfolioRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { hours?: unknown } }>(
    '/api/portfolio/history',
    async (req): Promise<PortfolioHistoryResponse> => {
      const hours = parseHours(req.query?.hours)
      const points = listHistory(db, hours).map((p) => ({
        tsMs: p.tsMs,
        value: round2(p.value),
        amount: round2(p.amount),
      }))
      return { points }
    },
  )
}
