import type { FastifyInstance } from 'fastify'
import { fetchMarketContext, type ContextPhase } from '../sources/context'
import { isUsTicker } from '../sources/types'

/**
 * AI 复盘的市场上下文。只读、按需调用（不参与 5 秒估值轮询）。
 * 任何一个数据源失败都只丢对应字段，接口本身永远 200。
 */
export interface ContextRouteDeps {
  fetchContext?: typeof fetchMarketContext
}

const EMPTY = { tsMs: 0, futures: [], etfs: [], premarketStocks: [] }

export function registerContextRoutes(app: FastifyInstance, deps: ContextRouteDeps = {}): void {
  const read = deps.fetchContext ?? fetchMarketContext

  app.get<{ Querystring: { phase?: string; symbols?: string } }>('/api/context', async (req) => {
    const phase: ContextPhase =
      req.query.phase === 'pre' || req.query.phase === 'live' || req.query.phase === 'settled'
        ? req.query.phase
        : 'live'
    const symbols = [...new Set(
      (req.query.symbols ?? '')
        .split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol !== '' && isUsTicker(symbol)),
    )].slice(0, 12)
    try {
      return await read({ phase, symbols })
    } catch (err) {
      app.log.warn({ err }, 'market context failed')
      return { ...EMPTY, tsMs: Date.now() }
    }
  })
}
