import type { FastifyInstance } from 'fastify'
import { NewsReader, type NewsItem, type NewsPayload } from '../sources/news'

/** 依赖注入：默认打东财，单测注入桩函数即可完全离线 */
export interface NewsRouteDeps {
  fetchNews?: () => Promise<NewsItem[]>
  now?: () => number
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

/**
 * `?limit=` 夹到 1–10，缺省 5。
 * 非数字、0、负数、999 都落到合法区间：卡片只要 5 条，多给的既没人看也占带宽。
 */
export function clampNewsLimit(raw: unknown): number {
  // 空串必须先单独拦掉：Number('') === 0，会被夹成 1，看着像「用户要 1 条」
  const text = typeof raw === 'string' ? raw.trim() : raw
  const num =
    typeof text === 'number' ? text : typeof text === 'string' && text !== '' ? Number(text) : Number.NaN
  if (!Number.isFinite(num)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(num)))
}

export function registerNewsRoutes(app: FastifyInstance, deps: NewsRouteDeps = {}): void {
  const reader = new NewsReader({
    fetchNews: deps.fetchNews,
    now: deps.now,
    onWarn: (err) => app.log.warn({ err }, 'news fetch failed, serving cache'),
  })

  /**
   * 这个路由**永不 500**：快讯源是非官方接口，挂了是常态而不是事故。
   * 卡片拿到空数组会显示「资讯暂不可用」，比整块报错体面，也不会把
   * 「新闻挂了」误认成「后端挂了」。
   */
  app.get<{ Querystring: { limit?: string } }>('/api/news', async (req): Promise<NewsPayload> => {
    try {
      return await reader.read(clampNewsLimit(req.query.limit))
    } catch (err) {
      app.log.warn({ err }, 'news route unexpected failure')
      return { items: [], tsMs: 0, stale: true }
    }
  })
}
