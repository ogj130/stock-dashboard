import { describe, it, expect, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAiRoutes } from '../../src/routes/ai'

const snapshot = {
  phase: 'live',
  atMs: 1,
  totalValue: 100_000,
  totalAmount: 2_000,
  totalAmountPct: 2,
  totalHoldingProfit: 10_000,
  totalHoldingPct: 11,
  fx: { pair: 'USD/CNY', rate: 6.67, pct: -0.1 },
  indices: [{ name: '纳斯达克100', pct: 1.2 }],
  funds: [
    {
      code: '270042',
      name: '广发纳指',
      marketValue: 50_000,
      amount: 1_000,
      pct: 2,
      holdingProfit: 5_000,
      coveredWeight: 0.95,
      board: '纳斯达克100',
    },
  ],
  stocks: [],
  news: [],
}

const analysisText = JSON.stringify({
  headline: '半导体带动上涨',
  summary: ['广发纳指 +2.07%'],
  drivers: [{ label: '英伟达', detail: '+4.61%' }],
  risks: ['集中度高'],
  watch: ['等官方净值'],
})

function okResponse(content: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  } as unknown as Response
}

function makeApp(fetchFn: typeof fetch, now: () => number = () => 0) {
  const dir = mkdtempSync(join(tmpdir(), 'qdii-ai-route-'))
  const app = Fastify()
  registerAiRoutes(app, join(dir, 'app.db'), {
    configPath: join(dir, 'ai.json'),
    fetchFn,
    now,
    ttlMs: 600_000,
  })
  return app
}

async function putConfig(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: 'PUT', url: '/api/ai/config', payload: payload as object })
}

async function postAnalysis(app: FastifyInstance, body: unknown) {
  return app.inject({ method: 'POST', url: '/api/analysis', payload: body as object })
}

const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>

describe('AI 配置 · 多档案', () => {
  it('没配过：profiles 为空，不包含任何密钥字段', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const body = json(await app.inject({ method: 'GET', url: '/api/ai/config' }))
    expect(body.configured).toBe(false)
    expect(body.profiles).toEqual([])
    expect(JSON.stringify(body)).not.toContain('apiKey')
  })

  it('PUT /config 兼容旧版：建一条档案并回掩码', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const body = json(
      await putConfig(app, {
        baseUrl: 'https://api.deepseek.com/v1/',
        model: 'deepseek-chat',
        apiKey: 'sk-1234567890abcdef',
      }),
    )
    const profiles = body.profiles as Array<Record<string, unknown>>
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ name: '默认', baseUrl: 'https://api.deepseek.com/v1', maskedKey: 'sk-…cdef' })
    expect(JSON.stringify(body)).not.toContain('1234567890')
    expect(body.activeId).toBe(profiles[0]!.id)
  })

  it('POST /profiles 新建并切换到新档案', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://a/v1', model: 'm-a', apiKey: 'k-a' })
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/ai/profiles',
        payload: { name: '本地', baseUrl: 'http://127.0.0.1:8788', model: 'local', apiKey: 'k-b' },
      }),
    )
    const profiles = created.profiles as Array<Record<string, unknown>>
    expect(profiles).toHaveLength(2)
    expect(created.activeId).toBe((profiles[1] as { id: string }).id)
    expect((profiles[1] as { name: string }).name).toBe('本地')
  })

  it('PUT /profiles/:id 改字段，PUT /active 切换，DELETE 后 active 回退', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const first = json(await putConfig(app, { baseUrl: 'https://a/v1', model: 'm-a', apiKey: 'k-a' }))
    const firstId = first.activeId as string
    const second = json(
      await app.inject({
        method: 'POST',
        url: '/api/ai/profiles',
        payload: { name: 'B', baseUrl: 'https://b/v1', model: 'm-b', apiKey: 'k-b' },
      }),
    )
    const secondId = second.activeId as string

    const renamed = json(
      await app.inject({
        method: 'PUT',
        url: `/api/ai/profiles/${secondId}`,
        payload: { name: 'B2', model: 'm-b2' },
      }),
    )
    expect((renamed.profiles as Array<{ id: string; name: string }>).find((p) => p.id === secondId)?.name).toBe('B2')

    const switched = json(await app.inject({ method: 'PUT', url: '/api/ai/active', payload: { id: firstId } }))
    expect(switched.activeId).toBe(firstId)

    const removed = json(await app.inject({ method: 'DELETE', url: `/api/ai/profiles/${firstId}` }))
    expect((removed.profiles as unknown[]).length).toBe(1)
    expect(removed.activeId).toBe(secondId)
  })

  it('Base URL 不是 http(s) → 400', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const res = await putConfig(app, { baseUrl: 'ftp://x' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/ai/models', () => {
  const listResponse = {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'm-b' }, { id: 'm-a' }] }),
    text: async () => '',
  } as unknown as Response

  it('按档案拉 /models，返回去重排序后的 id', async () => {
    const calls: Array<{ url: string; headers: unknown }> = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers })
      return listResponse
    })
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://a/v1', model: 'm', apiKey: 'k-a' })
    const body = json(await app.inject({ method: 'POST', url: '/api/ai/models', payload: {} }))
    expect(body.models).toEqual(['m-a', 'm-b'])
    expect(body.count).toBe(2)
    expect(calls[0]!.url).toBe('https://a/v1/models')
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe('Bearer k-a')
  })

  it('草稿端点不借用当前档案的密钥（避免拿旧 key 去试新端点）', async () => {
    let headers: Record<string, string> = {}
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return listResponse
    })
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://a/v1', model: 'm', apiKey: 'k-a' })
    const body = json(
      await app.inject({
        method: 'POST',
        url: '/api/ai/models',
        payload: { baseUrl: 'http://127.0.0.1:9999/v1' },
      }),
    )
    expect(body.models).toEqual(['m-a', 'm-b'])
    expect(headers.authorization).toBeUndefined()
  })
})

describe('POST /api/analysis', () => {
  it('没配置 → 400', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const res = await postAnalysis(app, { snapshot })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('配置')
  })

  it('配置后返回结构化解读，并带模型与免责声明', async () => {
    const fetchFn = vi.fn(async () => okResponse(analysisText))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    const body = json(await postAnalysis(app, { snapshot }))
    expect(body.headline).toBe('半导体带动上涨')
    expect((body.drivers as Array<{ label: string }>)[0]!.label).toBe('英伟达')
    expect(body.model).toBe('m')
    expect(body.cached).toBe(false)
    expect(String(body.disclaimer)).toContain('不构成投资建议')
  })

  it('10 分钟缓存：第二次不重复调用模型，refresh=true 才重算', async () => {
    const fetchFn = vi.fn(async () => okResponse(analysisText))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    expect(json(await postAnalysis(app, { snapshot })).cached).toBe(false)
    expect(json(await postAnalysis(app, { snapshot })).cached).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await postAnalysis(app, { snapshot, refresh: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('切换档案后缓存失效（key 里带 profile id）', async () => {
    const fetchFn = vi.fn(async () => okResponse(analysisText))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://a/v1', model: 'm', apiKey: 'k' })
    await postAnalysis(app, { snapshot })
    await app.inject({
      method: 'POST',
      url: '/api/ai/profiles',
      payload: { name: 'B', baseUrl: 'https://b/v1', model: 'm-b', apiKey: 'k-b' },
    })
    const again = json(await postAnalysis(app, { snapshot }))
    expect(again.cached).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('模型返回散文 → 502', async () => {
    const fetchFn = vi.fn(async () => okResponse('今天涨得不错，继续持有'))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    expect((await postAnalysis(app, { snapshot })).statusCode).toBe(502)
  })

  it('快照非法 → 400', async () => {
    const app = makeApp(vi.fn(async () => okResponse(analysisText)) as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    expect((await postAnalysis(app, { snapshot: { phase: 'live', funds: [] } })).statusCode).toBe(400)
  })
})

describe('POST /api/ai/test', () => {
  it('连接成功有耗时', async () => {
    const fetchFn = vi.fn(async () => okResponse('OK'))
    const app = makeApp(fetchFn as unknown as typeof fetch, () => 1000)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    expect(json(await app.inject({ method: 'POST', url: '/api/ai/test' })).ok).toBe(true)
  })

  it('密钥错误 → ok=false 并带原因', async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' }) as unknown as Response,
    )
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'bad' })
    const body = json(await app.inject({ method: 'POST', url: '/api/ai/test' }))
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain('401')
  })
})
