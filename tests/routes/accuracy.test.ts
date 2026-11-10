import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDb } from '../../src/store/db'
import { insertFund } from '../../src/store/queries'
import { registerAccuracyRoutes, buildAccuracy } from '../../src/routes/accuracy'

/**
 * 对账是「成绩单」。这几条钉的是：分母诚实（样本不足不报 MAE）、
 * 同日多相位只取最接近收盘的那条、以及每只基金用自己的残差拟合仓位。
 */
function seedDb() {
  const db = openDb(':memory:')
  insertFund(db, { code: '270042', name: '广发纳指', indexKey: 'ndx', shares: 1000, costBasis: 7000 })
  const est = db.prepare(
    `insert into estimate_log (fund_code, model_ts, target_nav_date, phase, model_pct, covered_weight, lag_days, exposure)
     values (?,?,?,?,?,?,?,?)`,
  )
  const nav = db.prepare('insert into nav_history (fund_code, nav_date, nav, pct, fetched_at) values (?,?,?,?,?)')
  return { db, est, nav }
}

describe('buildAccuracy', () => {
  it('样本为空时不给 MAE（0 与"还没有样本"必须能让界面区分）', () => {
    const { db } = seedDb()
    const r = buildAccuracy(db)
    expect(r.samples).toBe(0)
    expect(r.enough).toBe(false)
    expect(r.funds[0]!.n).toBe(0)
    expect(r.funds[0]!.suggestedExposure).toBe(0.95)
  })

  it('同一场有 pre/live/settled 三条留痕时只取 settled（收盘那条才是结果）', () => {
    const { db, est, nav } = seedDb()
    est.run('270042', 1, '2026-11-09', 'pre', -0.3, 1, 1, 0.95)
    est.run('270042', 2, '2026-11-09', 'live', 5.0, 1, 1, 0.95)   // 盘中噪声
    est.run('270042', 3, '2026-11-09', 'settled', 2.1, 1, 1, 0.95)
    nav.run('270042', '2026-11-10', 7.6, 2.0, Date.now())

    const r = buildAccuracy(db)
    expect(r.samples).toBe(1)
    // 用 settled 的 2.1 对 2.0 → MAE 0.1；若误取 live 的 5.0，会是 3.0
    expect(r.mae).toBeCloseTo(0.1, 6)
    expect(r.funds[0]!.n).toBe(1)
  })

  it('净值日必须晚于所估的那一场：同一天的净值不能拿来对账', () => {
    const { db, est, nav } = seedDb()
    est.run('270042', 1, '2026-11-09', 'settled', 2.0, 1, 1, 0.95)
    nav.run('270042', '2026-11-09', 7.6, 2.0, Date.now())
    expect(buildAccuracy(db).samples).toBe(0)
  })

  it('样本够了才给结论，并给出逐基金建议仓位', () => {
    const { db, est, nav } = seedDb()
    // 6 场留痕，实际净值系统性只有模型的 0.9 倍
    for (let i = 0; i < 6; i++) {
      const day = `2026-11-${String(10 + i).padStart(2, '0')}`
      const next = `2026-11-${String(11 + i).padStart(2, '0')}`
      est.run('270042', i, day, 'settled', 1.0, 1, 1, 0.95)
      nav.run('270042', next, 7.6, 0.9, Date.now())
    }
    const r = buildAccuracy(db)
    expect(r.enough).toBe(true)
    expect(r.samples).toBeGreaterThanOrEqual(6)
    expect(r.mae).toBeCloseTo(0.1, 6)
    expect(r.funds[0]!.suggestedExposure).toBeCloseTo(0.9, 6)
  })
})

describe('GET /api/accuracy', () => {
  it('可以指定 slot 覆盖自动拟合', async () => {
    const { db } = seedDb()
    const app = Fastify()
    registerAccuracyRoutes(app, db)
    const res = await app.inject({ method: 'GET', url: '/api/accuracy?slot=2' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).slot).toBe(2)
    await app.close()
  })
})
