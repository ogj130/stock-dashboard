import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerPortfolioRoutes, type PortfolioHistoryResponse } from '../../src/routes/portfolio'
import { openDb, type Db } from '../../src/store/db'
import { etWallClockToUtcMs, HISTORY_MAX_POINTS } from '../../src/store/portfolio'

/** 固定时钟：session 档位要断言边界，不能被 Date.now() 的毫秒抖动带偏 */
const NOW = etWallClockToUtcMs(2026, 11, 9, 15, 0) // 周一 15:00 美东，盘中

function seed(
  db: Db,
  stamps: number[],
  value = 100_000,
  amount = 0,
  profit = 0,
): void {
  const stmt = db.prepare(
    `insert into portfolio_snapshot (ts_ms, total_value, total_amount, total_profit, fund_count)
     values (?,?,?,?,?)`,
  )
  for (const ts of stamps) stmt.run(ts, value, amount, profit, 2)
}

function makeApp(db: Db, now = NOW) {
  const app = Fastify()
  registerPortfolioRoutes(app, db, { now: () => now })
  return app
}

async function history(
  app: ReturnType<typeof makeApp>,
  query = '',
): Promise<{ status: number; body: PortfolioHistoryResponse }> {
  const res = await app.inject({ method: 'GET', url: `/api/portfolio/history${query}` })
  return { status: res.statusCode, body: JSON.parse(res.body) as PortfolioHistoryResponse }
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const et = (y: number, m: number, d: number, h: number, mi = 0): number =>
  etWallClockToUtcMs(y, m, d, h, mi)

describe('GET /api/portfolio/history · 档位', () => {
  it('不传参数：默认 session，回包带上 range/startMs/endMs', async () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 9, 9, 45), et(2026, 11, 9, 14)])
    const { status, body } = await history(makeApp(db))
    expect(status).toBe(200)
    expect(body.range).toBe('session')
    expect(body.startMs).toBe(et(2026, 11, 9, 9, 30))
    expect(body.endMs).toBe(NOW)
    expect(body.points).toHaveLength(2)
  })

  it('session 只留 09:30–16:00 美东内的点：开盘前、收盘后、上一交易日的一律不要', async () => {
    const db = openDb(':memory:')
    seed(db, [
      et(2026, 11, 9, 9, 29),
      et(2026, 11, 9, 9, 31),
      et(2026, 11, 9, 13),
      et(2026, 11, 6, 12),
      et(2026, 11, 9, 16, 30),
    ])
    const { body } = await history(makeApp(db))
    expect(body.points.map((p) => p.tsMs)).toEqual([et(2026, 11, 9, 9, 31), et(2026, 11, 9, 13)])
  })

  it('range=1h/6h/24h/7d 的窗口就是「现在往前 N」', async () => {
    const db = openDb(':memory:')
    seed(db, [
      NOW - 30 * MIN,
      NOW - 3 * HOUR,
      NOW - 12 * HOUR,
      NOW - 3 * DAY,
      NOW - 30 * DAY,
    ])
    const expected: Array<[string, number, number]> = [
      ['1h', HOUR, 1],
      ['6h', 6 * HOUR, 2],
      ['24h', 24 * HOUR, 3],
      ['7d', 7 * DAY, 4],
    ]
    for (const [range, span, count] of expected) {
      const { body } = await history(makeApp(db), `?range=${range}`)
      expect(body.range, range).toBe(range)
      expect(body.startMs).toBe(NOW - span)
      expect(body.endMs).toBe(NOW)
      expect(body.points, range).toHaveLength(count)
      expect(body.points[body.points.length - 1]!.tsMs).toBe(NOW - 30 * MIN)
    }
  })

  it('未知 range 退回 session；空串同样退回 session', async () => {
    const db = openDb(':memory:')
    seed(db, [et(2026, 11, 9, 10)])
    for (const q of ['?range=12h', '?range=week', '?range=', '?range=%20']) {
      const { body } = await history(makeApp(db), q)
      expect(body.range, q).toBe('session')
      expect(body.startMs).toBe(et(2026, 11, 9, 9, 30))
    }
  })

  it('旧参数 ?hours= 仍然生效，映射到最近的档位', async () => {
    const db = openDb(':memory:')
    const cases: Array<[string, string, number]> = [
      ['?hours=1', '1h', HOUR],
      ['?hours=6', '6h', 6 * HOUR],
      ['?hours=12', '24h', 24 * HOUR],
      ['?hours=72', '7d', 7 * DAY],
    ]
    for (const [q, range, span] of cases) {
      const { body } = await history(makeApp(db), q)
      expect(body.range, q).toBe(range)
      expect(body.startMs, q).toBe(NOW - span)
    }
    // 空串/坏值当没传：现在是默认档，不是 6 小时
    for (const q of ['?hours=', '?hours=abc']) {
      const { body } = await history(makeApp(db), q)
      expect(body.range, q).toBe('session')
    }
  })

  it('range 与 hours 同时出现时以 range 为准', async () => {
    const db = openDb(':memory:')
    const { body } = await history(makeApp(db), '?range=1h&hours=24')
    expect(body.range).toBe('1h')
    expect(body.startMs).toBe(NOW - HOUR)
  })
})

describe('GET /api/portfolio/history · 数据', () => {
  it('点按老→新返回，三个指标都在且金额保留两位', async () => {
    const db = openDb(':memory:')
    seed(db, [NOW - 2 * HOUR, NOW - HOUR], 84_321.29999999999, -12.346, 15_907.664)
    seed(db, [NOW - 30 * MIN], 84_322, 5, -4_321.099)
    const { body } = await history(makeApp(db), '?range=6h')
    expect(body.points.map((p) => p.tsMs)).toEqual([NOW - 2 * HOUR, NOW - HOUR, NOW - 30 * MIN])
    expect(body.points[0]!.value).toBe(84_321.3)
    expect(body.points[0]!.amount).toBe(-12.35)
    expect(body.points[0]!.profit).toBe(15_907.66)
    expect(body.points[2]!.value).toBe(84_322)
    // 收益为负时原样带符号回给前端，不取绝对值
    expect(body.points[2]!.profit).toBe(-4_321.1)
    // 三个指标一次给全：切换指标不需要再发请求
    expect(Object.keys(body.points[0] ?? {}).sort()).toEqual(['amount', 'profit', 'tsMs', 'value'])
  })

  it('空库返回空数组 + 合法窗口，而不是 500（曲线渲染成「暂无数据」）', async () => {
    const db = openDb(':memory:')
    const { status, body } = await history(makeApp(db))
    expect(status).toBe(200)
    expect(body.points).toEqual([])
    expect(body.startMs).toBe(et(2026, 11, 9, 9, 30))
  })

  it('7d 窗口内 5000 个点被抽到 720 个，且末点就是最新点', async () => {
    const db = openDb(':memory:')
    const span = 7 * DAY
    const count = 5000
    seed(
      db,
      Array.from({ length: count }, (_, i) => NOW - (i * span) / (count - 1)),
    )
    const { body } = await history(makeApp(db), '?range=7d')
    expect(body.points).toHaveLength(HISTORY_MAX_POINTS)
    expect(body.points[0]!.tsMs).toBe(NOW - span)
    expect(body.points[body.points.length - 1]!.tsMs).toBe(NOW)
    const ts = body.points.map((p) => p.tsMs)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(new Set(ts).size).toBe(HISTORY_MAX_POINTS)
  })

  it('点数不超过上限时原样返回，不抽样', async () => {
    const db = openDb(':memory:')
    seed(
      db,
      Array.from({ length: HISTORY_MAX_POINTS }, (_, i) => NOW - (HISTORY_MAX_POINTS - i) * 30_000),
    )
    const { body } = await history(makeApp(db), '?range=7d')
    expect(body.points).toHaveLength(HISTORY_MAX_POINTS)
  })
})
