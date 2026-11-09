import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerFundRoutes, type FundRouteDeps } from '../../src/routes/funds'
import { openDb, type Db } from '../../src/store/db'
import { insertFund, listFunds, upsertNav, getNavHistory } from '../../src/store/queries'

/** 桩：真实实现要打外网，这里全部离线 */
const stubDeps: FundRouteDeps = {
  latestNav: async () => 7.3714,
  resolveHoldings: async () => ({ holdings: [], viaEtf: null, asOf: '2026-09-30' }),
}

function makeApp(deps: FundRouteDeps = stubDeps): { db: Db; app: FastifyInstance } {
  const db = openDb(':memory:')
  const app = Fastify()
  registerFundRoutes(app, db, deps)
  return { db, app }
}

async function post(app: FastifyInstance, payload: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/funds', payload: payload as object })
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

// 任何一条用例偷偷联网都直接炸掉，保证「测试完全离线」不是口号
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('测试禁止联网：网络调用必须通过 deps 注入')
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/funds', () => {
  it('新增基金后能列出，且份额由市值/净值反推', async () => {
    const { app } = makeApp()
    const { status, body } = await post(app, { code: '270042', marketValue: 47932.65, profit: 12646.36 })
    expect(status).toBe(200)
    expect(body.fund.shares).toBeCloseTo(47932.65 / 7.3714, 4)
    expect(body.fund.cost_basis).toBeCloseTo(47932.65 - 12646.36, 2)

    const list = await app.inject({ method: 'GET', url: '/api/funds' })
    expect(JSON.parse(list.body).funds).toHaveLength(1)
  })

  it('indexKey 落库到 fund.index_key，并在响应里回显', async () => {
    const { db, app } = makeApp()
    const { status, body } = await post(app, {
      code: '270042', marketValue: 47932.65, profit: 12646.36, indexKey: 'ndx',
    })
    expect(status).toBe(200)
    expect(body.indexKey).toBe('ndx')
    expect(body.fund.index_key).toBe('ndx')
    expect(listFunds(db)[0]!.index_key).toBe('ndx')
  })

  it('重复录入同一代码是 upsert：行数不变，份额被覆盖', async () => {
    const { db, app } = makeApp()
    await post(app, { code: '270042', marketValue: 47932.65, profit: 12646.36 })
    const second = await post(app, { code: '270042', marketValue: 74.0, profit: 0 })
    expect(second.status).toBe(200)
    expect(second.body.fund.shares).toBeCloseTo(74.0 / 7.3714, 6)
    expect(listFunds(db)).toHaveLength(1)
  })

  it('直接给 shares/costBasis 时覆盖反推值，且不再请求净值', async () => {
    const latestNav = vi.fn(async () => {
      throw new Error('不该被调用')
    })
    const { app } = makeApp({ ...stubDeps, latestNav })
    const { status, body } = await post(app, {
      code: '161125', marketValue: 10000, profit: 500, shares: 1234.5, costBasis: 9500,
    })
    expect(status).toBe(200)
    expect(body.fund.shares).toBeCloseTo(1234.5, 6)
    expect(body.fund.cost_basis).toBeCloseTo(9500, 6)
    expect(latestNav).not.toHaveBeenCalled()
  })

  it('成本不允许为负：持有收益大于市值时夹到 0', async () => {
    const { app } = makeApp()
    const { body } = await post(app, { code: 'X1', marketValue: 1000, profit: 5000 })
    expect(body.fund.cost_basis).toBe(0)
  })

  it('缺 code 返回 400', async () => {
    const { db, app } = makeApp()
    const { status } = await post(app, { marketValue: 1000 })
    expect(status).toBe(400)
    expect(listFunds(db)).toHaveLength(0)
  })

  it("marketValue 为 '' 返回 400（Number('') === 0 陷阱）", async () => {
    const { db, app } = makeApp()
    const { status } = await post(app, { code: 'X2', marketValue: '' })
    expect(status).toBe(400)
    expect(listFunds(db)).toHaveLength(0)
  })

  it('marketValue 非数字返回 400，不写库', async () => {
    const { db, app } = makeApp()
    expect((await post(app, { code: 'X3', marketValue: 'abc' })).status).toBe(400)
    expect((await post(app, { code: 'X4' })).status).toBe(400)
    expect(listFunds(db)).toHaveLength(0)
  })

  it('净值取不到又没有显式 shares 时返回 502，不静默写 0 份', async () => {
    const { db, app } = makeApp({ ...stubDeps, latestNav: async () => 0 })
    const { status } = await post(app, { code: 'X5', marketValue: 1000 })
    expect(status).toBe(502)
    expect(listFunds(db)).toHaveLength(0)
  })

  it('返回解析到的持仓数与 viaEtf', async () => {
    const { app } = makeApp({
      latestNav: async () => 1.5,
      resolveHoldings: async () => ({
        holdings: [{ symbol: 'AAPL', name: 'Apple', weight: 0.08 }],
        viaEtf: '513100',
        asOf: '2026-09-30',
      }),
    })
    const { body } = await post(app, { code: 'X6', marketValue: 1500 })
    expect(body.holdings).toBe(1)
    expect(body.viaEtf).toBe('513100')
  })

  it('持仓解析抛错不影响基金落库', async () => {
    const { db, app } = makeApp({
      ...stubDeps,
      resolveHoldings: async () => {
        throw new Error('boom')
      },
    })
    const { status } = await post(app, { code: 'X7', marketValue: 1000 })
    expect(status).toBe(200)
    expect(listFunds(db)).toHaveLength(1)
  })
})

describe('GET /api/funds', () => {
  it('空库返回空数组', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/funds' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ funds: [] })
  })

  it('按 id 升序返回，含 UI 需要的 asset_class / calibrated_at / created_at', async () => {
    const { app } = makeApp()
    await post(app, { code: 'A1', marketValue: 1000 })
    await post(app, { code: 'A2', marketValue: 2000 })
    const res = await app.inject({ method: 'GET', url: '/api/funds' })
    const { funds } = JSON.parse(res.body)
    expect(funds.map((f: { code: string }) => f.code)).toEqual(['A1', 'A2'])
    expect(funds[0].asset_class).toBe('us_equity')
    expect(funds[0].calibrated_at).toBeNull()
    expect(typeof funds[0].created_at).toBe('number')
  })
})

describe('DELETE /api/funds/:id', () => {
  it('按 id 删除，连带净值（外键级联）', async () => {
    const { db, app } = makeApp()
    const { body } = await post(app, { code: 'D1', marketValue: 7371.4 })
    upsertNav(db, 'D1', '2026-11-06', 7.3, 1.2)
    const res = await app.inject({ method: 'DELETE', url: `/api/funds/${body.fund.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
    expect(listFunds(db)).toHaveLength(0)
    expect(getNavHistory(db, 'D1')).toHaveLength(0)
  })

  it('id 非数字返回 400', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/funds/abc' })
    expect(res.statusCode).toBe(400)
  })
})

describe('store/queries', () => {
  it('insertFund 的 upsert 会更新 name，不只 shares/cost_basis', () => {
    const db = openDb(':memory:')
    insertFund(db, { code: 'Q1', name: '广发纳斯达克100ETF联接A', shares: 100, costBasis: 700 })
    const row = insertFund(db, { code: 'Q1', name: '改名了', shares: 200, costBasis: 1400 })
    expect(row.name).toBe('改名了')
    expect(row.shares).toBeCloseTo(200, 6)
    expect(listFunds(db)).toHaveLength(1)
  })

  it('再次 insertFund 不传 name 时保留已有名称，不擦成空串', () => {
    const db = openDb(':memory:')
    insertFund(db, { code: 'Q1b', name: '广发纳斯达克100ETF联接A', shares: 100, costBasis: 700 })
    const row = insertFund(db, { code: 'Q1b', shares: 200, costBasis: 1400 })
    expect(row.name).toBe('广发纳斯达克100ETF联接A')
    expect(row.shares).toBeCloseTo(200, 6)
  })

  it('upsert 不把校准产物（exposure / calibrated_at）打回默认', () => {
    const db = openDb(':memory:')
    insertFund(db, { code: 'Q1c', shares: 100, costBasis: 700 })
    db.prepare('update fund set exposure = 0.87, lag_days = 2, calibrated_at = 123 where code = ?').run('Q1c')
    const row = insertFund(db, { code: 'Q1c', shares: 200, costBasis: 1400 })
    expect(row.exposure).toBeCloseTo(0.87, 6)
    expect(row.lag_days).toBe(2)
    expect(row.calibrated_at).toBe(123)
  })

  it('insertFund 返回的 FundRow 字段齐全', () => {
    const db = openDb(':memory:')
    const row = insertFund(db, { code: 'Q2', shares: 1, costBasis: 1 })
    expect(Object.keys(row).sort()).toEqual(
      [
        'asset_class', 'calibrated_at', 'code', 'cost_basis', 'created_at', 'exposure',
        'id', 'index_key', 'kind', 'lag_days', 'name', 'shares', 'target_etf_code',
      ].sort(),
    )
    expect(row.calibrated_at).toBeNull()
    expect(row.created_at).toBeGreaterThan(0)
  })

  it('upsertNav 用 do update：官方重述净值时覆盖同一行', () => {
    const db = openDb(':memory:')
    insertFund(db, { code: 'Q3', shares: 1, costBasis: 1 })
    upsertNav(db, 'Q3', '2026-11-06', 7.30, 1.2)
    upsertNav(db, 'Q3', '2026-11-06', 7.3714, 1.36)
    const rows = getNavHistory(db, 'Q3')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pct).toBeCloseTo(1.36, 6)
  })

  it('getNavHistory 按日期倒序并遵守 limit', () => {
    const db = openDb(':memory:')
    insertFund(db, { code: 'Q4', shares: 1, costBasis: 1 })
    upsertNav(db, 'Q4', '2026-11-04', 7.0, 0.5)
    upsertNav(db, 'Q4', '2026-11-06', 7.2, 1.0)
    upsertNav(db, 'Q4', '2026-11-05', 7.1, 0.8)
    expect(getNavHistory(db, 'Q4').map((r) => r.nav_date)).toEqual([
      '2026-11-06', '2026-11-05', '2026-11-04',
    ])
    expect(getNavHistory(db, 'Q4', 2)).toHaveLength(2)
  })

  it('insertFund 缺省 exposure/lag_days 走 schema 默认语义', () => {
    const db = openDb(':memory:')
    const row = insertFund(db, { code: 'Q5', shares: 1, costBasis: 1 })
    expect(row.exposure).toBeCloseTo(0.95, 6)
    expect(row.lag_days).toBe(1)
  })
})
