import { describe, it, expect, vi } from 'vitest'
import { buildMessages, chatCompletion, parseAnalysis } from '../../src/ai/analysis'
import type { AnalysisSnapshot } from '../../src/ai/snapshot'

const snapshot: AnalysisSnapshot = {
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
  stocks: [{ symbol: 'NVDA', name: '英伟达', weightPct: 10, pct: 4.6 }],
  news: [{ title: '半导体走强', tsMs: 1, important: true }],
}

const response = (content: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => (ok ? '' : 'bad request'),
  }) as unknown as Response

describe('buildMessages · 提示词把边界说死', () => {
  it('system 里写清楚「不许算数、不做买卖建议、只输出 JSON」', () => {
    const [system, user] = buildMessages(snapshot)
    expect(system!.role).toBe('system')
    expect(system!.content).toContain('不要做新的计算')
    expect(system!.content).toContain('不做买卖建议')
    expect(system!.content).toContain('只输出 JSON')
    expect(user!.content).toContain('270042')
    expect(user!.content).toContain('NVDA')
  })
})

describe('parseAnalysis · 只接受约定结构', () => {
  it('标准 JSON', () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        headline: '半导体带动上涨',
        summary: ['广发纳指 +2.07%'],
        drivers: [{ label: '英伟达', detail: '+4.61%' }],
        risks: ['集中度高'],
        watch: ['等官方净值'],
      }),
    )
    expect(parsed).toEqual({
      headline: '半导体带动上涨',
      summary: ['广发纳指 +2.07%'],
      drivers: [{ label: '英伟达', detail: '+4.61%' }],
      risks: ['集中度高'],
      watch: ['等官方净值'],
    })
  })

  it('外面裹了 ```json 也能解析（不少兼容端点会加）', () => {
    const parsed = parseAnalysis('```json\n{"headline":"x","summary":["y"]}\n```')
    expect(parsed?.headline).toBe('x')
  })

  it('散文 / 半截 JSON / 空对象 → null', () => {
    expect(parseAnalysis('今天涨得不错')).toBeNull()
    expect(parseAnalysis('{"headline":')).toBeNull()
    expect(parseAnalysis('{}')).toBeNull()
  })

  it('数组里的非字符串被过滤，超长被截断', () => {
    const parsed = parseAnalysis(
      JSON.stringify({ headline: 'h', summary: ['ok', 42, '', 'x'.repeat(500)] }),
    )
    expect(parsed!.summary).toHaveLength(2)
    expect(parsed!.summary[1]!.length).toBeLessThanOrEqual(120)
  })
})

describe('chatCompletion · 兼容端点', () => {
  it('正常返回 content 字符串', async () => {
    const fetchFn = vi.fn(async () => response('{"headline":"ok"}'))
    const text = await chatCompletion(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      { fetchFn: fetchFn as unknown as typeof fetch },
    )
    expect(text).toBe('{"headline":"ok"}')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('端点不认 response_format（400）时去掉它重试一次', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return bodies.length === 1 ? response(null, false, 400) : response('ok')
    })
    const text = await chatCompletion(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      { fetchFn: fetchFn as unknown as typeof fetch },
    )
    expect(text).toBe('ok')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.response_format).toBeDefined()
    expect(bodies[1]!.response_format).toBeUndefined()
  })

  it('HTTP 失败带出状态码，不吞错', async () => {
    const fetchFn = vi.fn(async () => response(null, false, 401))
    await expect(
      chatCompletion(
        { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
        [{ role: 'user', content: 'hi' }],
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/401/)
  })

  it('content 是分段数组时拼起来', async () => {
    const fetchFn = vi.fn(async () =>
      response([{ text: '你' }, { text: '好' }]),
    )
    const text = await chatCompletion(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      { fetchFn: fetchFn as unknown as typeof fetch },
    )
    expect(text).toBe('你好')
  })
})

describe('chatCompletion · 推理型模型的输出预算', () => {
  it('finish_reason=length 且 content 为空 → 翻倍 token 重试一次', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      // 第一次：思考把 4096 用完，content 空
      if (bodies.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
          text: async () => '',
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"headline":"ok"}' }, finish_reason: 'stop' }] }),
        text: async () => '',
      } as unknown as Response
    })
    const text = await chatCompletion(
      { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      { fetchFn: fetchFn as unknown as typeof fetch, maxTokens: 4096 },
    )
    expect(text).toBe('{"headline":"ok"}')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.max_tokens).toBe(4096)
    expect(bodies[1]!.max_tokens).toBe(8192)
  })

  it('两次都被思考吃满 → 明确报「只输出了思考过程」', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
      text: async () => '',
    }) as unknown as Response)
    await expect(
      chatCompletion(
        { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
        [{ role: 'user', content: 'hi' }],
        { fetchFn: fetchFn as unknown as typeof fetch, maxTokens: 4096 },
      ),
    ).rejects.toThrow(/思考/)
  })

  it('ping 这类小请求可以关掉重试（只打一次）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
      text: async () => '',
    }) as unknown as Response)
    await expect(
      chatCompletion(
        { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
        [{ role: 'user', content: 'ping' }],
        { fetchFn: fetchFn as unknown as typeof fetch, maxTokens: 8, retryOnTruncation: false },
      ),
    ).rejects.toThrow(/没有返回正文|思考/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
