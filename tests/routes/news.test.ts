import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { clampNewsLimit, registerNewsRoutes, type NewsRouteDeps } from '../../src/routes/news'
import type { NewsItem } from '../../src/sources/news'

const item = (id: string, over: Partial<NewsItem> = {}): NewsItem => ({
  id,
  title: `快讯 ${id}`,
  url: '',
  source: 'eastmoney',
  tsMs: 1_000,
  important: false,
  ...over,
})

const many = (n: number): NewsItem[] =>
  Array.from({ length: n }, (_, i) => item(`n${i}`, { tsMs: 1_000 + i }))

function makeApp(deps: NewsRouteDeps = {}): FastifyInstance {
  const app = Fastify()
  registerNewsRoutes(app, deps)
  return app
}

async function get(app: FastifyInstance, url = '/api/news') {
  const res = await app.inject({ method: 'GET', url })
  return { status: res.statusCode, body: JSON.parse(res.body) as { items: NewsItem[]; tsMs: number; stale: boolean } }
}

// 任何一条用例偷偷联网都直接炸掉：新闻接口的测试必须完全离线
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('测试禁止联网：网络调用必须通过 deps 注入')
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clampNewsLimit · 1–10，缺省 5', () => {
  it('合法值原样保留（含字符串形式）', () => {
    expect(clampNewsLimit('3')).toBe(3)
    expect(clampNewsLimit(7)).toBe(7)
  })

  it('999 → 10，0 / 负数 → 1', () => {
    expect(clampNewsLimit('999')).toBe(10)
    expect(clampNewsLimit('0')).toBe(1)
    expect(clampNewsLimit('-4')).toBe(1)
  })

  it('缺省 / 非数字 → 5', () => {
    expect(clampNewsLimit(undefined)).toBe(5)
    expect(clampNewsLimit('')).toBe(5)
    expect(clampNewsLimit('abc')).toBe(5)
  })
})

describe('GET /api/news', () => {
  it('正常返回 5 条、stale=false，并带上拉取时刻', async () => {
    const app = makeApp({ fetchNews: async () => many(8), now: () => 12_345 })
    const { status, body } = await get(app, '/api/news?limit=5')
    expect(status).toBe(200)
    expect(body.items).toHaveLength(5)
    expect(body.stale).toBe(false)
    expect(body.tsMs).toBe(12_345)
  })

  it('源挂了且没有缓存 → 200 + 空数组 + stale，绝不 500', async () => {
    const app = makeApp({
      fetchNews: async () => {
        throw new Error('eastmoney down')
      },
      now: () => 1,
    })
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.items).toEqual([])
    expect(body.stale).toBe(true)
  })

  it('源挂了但有缓存 → 旧条目 + stale=true', async () => {
    let fail = false
    let now = 0
    const app = makeApp({
      fetchNews: async () => {
        if (fail) throw new Error('down')
        return many(3)
      },
      now: () => now,
    })
    await get(app)
    fail = true
    now = 61_000
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.stale).toBe(true)
    expect(body.items).toHaveLength(3)
  })

  it('limit=999 夹到 10；limit=0 夹到 1', async () => {
    const app = makeApp({ fetchNews: async () => many(12), now: () => 0 })
    expect((await get(app, '/api/news?limit=999')).body.items).toHaveLength(10)
    expect((await get(app, '/api/news?limit=0')).body.items).toHaveLength(1)
  })

  it('60 秒缓存：同一进程内反复请求只拉一次源', async () => {
    let calls = 0
    let now = 0
    const app = makeApp({
      fetchNews: async () => {
        calls += 1
        return many(2)
      },
      now: () => now,
    })
    await get(app)
    now = 59_000
    await get(app)
    expect(calls).toBe(1)
    now = 60_000
    await get(app)
    expect(calls).toBe(2)
  })
})
