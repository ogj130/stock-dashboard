import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerPortfolioRoutes } from '../../src/routes/portfolio'
import { openDb, type Db } from '../../src/store/db'
import { HISTORY_MAX_POINTS } from '../../src/store/portfolio'

/** 直接往快照表灌点：这一层只测读取侧的窗口与抽样，写入侧由 estimate 路由的用例覆盖 */
function seed(db: Db, offsetsMs: number[], value = 100_000, amount = 0, now = Date.now()): void {
  const stmt = db.prepare(
    'insert into portfolio_snapshot (ts_ms, total_value, total_amount, fund_count) values (?,?,?,?)',
  )
  for (const off of offsetsMs) stmt.run(now - off, value, amount, 2)
}

function makeApp(db: Db) {
  const app = Fastify()
  registerPortfolioRoutes(app, db)
  return app
}

async function history(app: ReturnType<typeof makeApp>, query = '') {
  const res = await app.inject({ method: 'GET', url: `/api/portfolio/history${query}` })
  return { status: res.statusCode, body: JSON.parse(res.body) as { points: Array<{ tsMs: number; value: number; amount: number }> } }
}

const MIN = 60_000
const HOUR = 3_600_000

describe('GET /api/portfolio/history · 窗口', () => {
  it('默认 6 小时：5 小时前的点在，20 小时前的不在', async () => {
    const db = openDb(':memory:')
    seed(db, [30 * MIN, 2 * HOUR, 5 * HOUR, 20 * HOUR, 60 * HOUR, 80 * HOUR])
    const { status, body } = await history(makeApp(db))
    expect(status).toBe(200)
    expect(body.points).toHaveLength(3)
  })

  it('hours=0 夹到 1 小时，hours=999 夹到 72 小时', async () => {
    const db = openDb(':memory:')
    seed(db, [30 * MIN, 2 * HOUR, 5 * HOUR, 20 * HOUR, 60 * HOUR, 80 * HOUR])

    const oneHour = await history(makeApp(db), '?hours=0')
    expect(oneHour.body.points).toHaveLength(1)

    const maxWindow = await history(makeApp(db), '?hours=999')
    // 80 小时前的点仍在窗口外，其余 5 个都在
    expect(maxWindow.body.points).toHaveLength(5)
  })

  it('hours 缺省/空串/非数字都退回 6 小时，不会被 Number("")=0 夹成 1 小时', async () => {
    const db = openDb(':memory:')
    seed(db, [30 * MIN, 2 * HOUR, 5 * HOUR, 20 * HOUR])
    for (const q of ['', '?hours=', '?hours=abc', '?hours=NaN']) {
      const { body } = await history(makeApp(db), q)
      expect(body.points, q).toHaveLength(3)
    }
  })

  it('点按老→新返回，金额保留两位', async () => {
    const db = openDb(':memory:')
    const now = Date.now()
    seed(db, [2 * HOUR, 1 * HOUR], 84_321.29999999999, -12.346, now)
    seed(db, [30 * MIN], 84_322, 5, now)
    const { body } = await history(makeApp(db))
    expect(body.points.map((p) => p.tsMs)).toEqual([now - 2 * HOUR, now - 1 * HOUR, now - 30 * MIN])
    expect(body.points[0]!.value).toBe(84_321.3)
    expect(body.points[0]!.amount).toBe(-12.35)
    expect(body.points[2]!.value).toBe(84_322)
  })

  it('空库返回空数组而不是 500（曲线渲染成「暂无数据」）', async () => {
    const db = openDb(':memory:')
    const { status, body } = await history(makeApp(db))
    expect(status).toBe(200)
    expect(body.points).toEqual([])
  })
})

describe('GET /api/portfolio/history · 抽样', () => {
  it('72 小时窗口内 5000 个点被抽到 720 个，且首尾都保留', async () => {
    const db = openDb(':memory:')
    const now = Date.now()
    // 窗口是 [now-72h, now]：卡在边界上的点会因路由里 Date.now() 晚了几毫秒而被排除，
    // 所以向内留一分钟，测的是抽样而不是边界
    const span = 72 * HOUR - MIN
    const count = 5000
    const offsets = Array.from({ length: count }, (_, i) => span - (i * span) / (count - 1))
    seed(db, offsets, 100_000, 0, now)

    const { body } = await history(makeApp(db), '?hours=72')
    expect(body.points).toHaveLength(HISTORY_MAX_POINTS)
    // 首点是窗口内最老的那个，末点必须是「现在」——否则曲线会停在前几分钟，和页面上的总资产对不上
    expect(body.points[0]!.tsMs).toBe(now - span)
    expect(body.points[body.points.length - 1]!.tsMs).toBe(now)
    // 单调递增，没有因为四舍五入取到重复下标
    const ts = body.points.map((p) => p.tsMs)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(new Set(ts).size).toBe(HISTORY_MAX_POINTS)
  })

  it('点数不超过上限时原样返回，不抽样', async () => {
    const db = openDb(':memory:')
    const offsets = Array.from({ length: HISTORY_MAX_POINTS }, (_, i) => (HISTORY_MAX_POINTS - i) * 30_000)
    seed(db, offsets)
    const { body } = await history(makeApp(db), '?hours=72')
    expect(body.points).toHaveLength(HISTORY_MAX_POINTS)
  })
})
