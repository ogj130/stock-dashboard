import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { registerContextRoutes } from '../../src/routes/context'

describe('GET /api/context', () => {
  it('清洗 symbols（大写、去重、只认美股代码）并透传 phase', async () => {
    const fetchContext = vi.fn(async () => ({ tsMs: 1, futures: [], etfs: [], premarketStocks: [] }))
    const app = Fastify()
    registerContextRoutes(app, { fetchContext: fetchContext as never })
    const res = await app.inject({ url: '/api/context?phase=pre&symbols=nvda,aapl,nvda,00992,%20msft%20' })
    expect(res.statusCode).toBe(200)
    expect(fetchContext).toHaveBeenCalledWith({ phase: 'pre', symbols: ['NVDA', 'AAPL', 'MSFT'] })
  })

  it('phase 非法时按 live 处理', async () => {
    const fetchContext = vi.fn(async () => ({ tsMs: 1, futures: [], etfs: [], premarketStocks: [] }))
    const app = Fastify()
    registerContextRoutes(app, { fetchContext: fetchContext as never })
    await app.inject({ url: '/api/context?phase=afternoon' })
    expect(fetchContext).toHaveBeenCalledWith({ phase: 'live', symbols: [] })
  })

  it('底层抛错 → 200 + 空上下文，不 500', async () => {
    const app = Fastify()
    registerContextRoutes(app, {
      fetchContext: (async () => {
        throw new Error('down')
      }) as never,
    })
    const res = await app.inject({ url: '/api/context' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ futures: [], etfs: [], premarketStocks: [] })
  })
})
