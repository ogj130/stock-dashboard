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

describe('AI 配置', () => {
  it('没配过：configured=false，不返回密钥字段', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const res = await app.inject({ method: 'GET', url: '/api/ai/config' })
    const body = JSON.parse(res.body)
    expect(body.configured).toBe(false)
    expect(body.hasKey).toBe(false)
    expect(body).not.toHaveProperty('apiKey')
  })

  it('写入后只回掩码，原始密钥永远不出现在响应里', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const res = await putConfig(app, {
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-chat',
      apiKey: 'sk-1234567890abcdef',
    })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.configured).toBe(true)
    expect(body.maskedKey).toBe('sk-…cdef')
    expect(JSON.stringify(body)).not.toContain('1234567890')
    expect(body.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('Base URL 不是 http(s) → 400', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const res = await putConfig(app, { baseUrl: 'ftp://x' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/analysis', () => {
  it('没配置 → 400，提示去配置，而不是 500', async () => {
    const app = makeApp(vi.fn() as unknown as typeof fetch)
    const res = await postAnalysis(app, { snapshot })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('配置')
  })

  it('配置后返回结构化解读，并带模型与免责声明', async () => {
    const fetchFn = vi.fn(async () => okResponse(analysisText))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })

    const res = await postAnalysis(app, { snapshot })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.headline).toBe('半导体带动上涨')
    expect(body.drivers[0].label).toBe('英伟达')
    expect(body.model).toBe('m')
    expect(body.cached).toBe(false)
    expect(body.disclaimer).toContain('不构成投资建议')
  })

  it('10 分钟缓存：第二次不重复调用模型，refresh=true 才重算', async () => {
    const fetchFn = vi.fn(async () => okResponse(analysisText))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })

    const first = JSON.parse((await postAnalysis(app, { snapshot })).body)
    const second = JSON.parse((await postAnalysis(app, { snapshot })).body)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await postAnalysis(app, { snapshot, refresh: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('模型返回散文 → 502，不把半截结果塞进卡片', async () => {
    const fetchFn = vi.fn(async () => okResponse('今天涨得不错，继续持有'))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    const res = await postAnalysis(app, { snapshot })
    expect(res.statusCode).toBe(502)
  })

  it('快照非法 → 400', async () => {
    const fetchFn = vi.fn(async () => okResponse(analysisText))
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    const res = await postAnalysis(app, { snapshot: { phase: 'live', funds: [] } })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/ai/test', () => {
  it('连接成功有耗时', async () => {
    const fetchFn = vi.fn(async () => okResponse('OK'))
    const app = makeApp(fetchFn as unknown as typeof fetch, () => 1000)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' })
    const res = await app.inject({ method: 'POST', url: '/api/ai/test' })
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('密钥错误 → ok=false 并带原因', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    }) as unknown as Response)
    const app = makeApp(fetchFn as unknown as typeof fetch)
    await putConfig(app, { baseUrl: 'https://x/v1', model: 'm', apiKey: 'bad' })
    const res = await app.inject({ method: 'POST', url: '/api/ai/test' })
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('401')
  })
})
