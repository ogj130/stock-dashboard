// tests/store/db.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate, SCHEMA_VERSION } from '../../src/store/db'

const TABLES = [
  'constituent', 'estimate_log', 'fund', 'fx_cache',
  'nav_history', 'quote_cache', 'quote_symbol_market', 'residual',
]

describe('db schema', () => {
  it('建出全部 8 张表', () => {
    const db = openDb(':memory:')
    const names = db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
      .all()
      .map((r: any) => r.name as string)
      .sort()
    expect(names).toEqual(TABLES)
  })

  it('user_version 记录迁移版本', () => {
    const db = openDb(':memory:')
    const row = db.prepare('pragma user_version').get() as { user_version: number }
    expect(row.user_version).toBe(SCHEMA_VERSION)
  })

  it('重复迁移幂等，版本不变', () => {
    const db = openDb(':memory:')
    expect(() => migrate(db)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    const row = db.prepare('pragma user_version').get() as { user_version: number }
    expect(row.user_version).toBe(SCHEMA_VERSION)
  })

  it('文件模式下 WAL 生效，且自动建出父目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stockmy-'))
    const path = join(dir, 'nested', 'app.db')
    const db = openDb(path)
    expect(existsSync(path)).toBe(true)
    const mode = db.prepare('pragma journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
  })

  it('删基金连带删净值与残差（外键级联）', () => {
    const db = openDb(':memory:')
    db.prepare("insert into fund (code, created_at) values ('X', 1)").run()
    db.prepare("insert into nav_history (fund_code, nav_date, nav, pct, fetched_at) values ('X','2026-11-06',7.3,1.2,1)").run()
    db.prepare("insert into residual (fund_code, nav_date, model_pct, actual_pct, diff, nav_ts) values ('X','2026-11-06',1.1,1.2,-0.1,1)").run()
    db.prepare("delete from fund where code = 'X'").run()
    expect((db.prepare('select count(*) c from nav_history').get() as any).c).toBe(0)
    expect((db.prepare('select count(*) c from residual').get() as any).c).toBe(0)
  })

  it('CHECK 拦住把百分数当小数写进 weight', () => {
    const db = openDb(':memory:')
    const stmt = db.prepare(
      `insert into constituent (owner_type, owner_key, symbol, weight, as_of, source, fetched_at)
       values ('index','ndx','AAPL',?,?,?,1)`,
    )
    expect(() => stmt.run(7.6, '2026-09-30', 'test')).toThrow(/CHECK/i)
    expect(() => stmt.run(0.076, '2026-09-30', 'test')).not.toThrow()
  })

  it('CHECK 拦住非法的 lag_days 与 exposure', () => {
    const db = openDb(':memory:')
    const stmt = db.prepare('insert into fund (code, lag_days, exposure, created_at) values (?,?,?,1)')
    expect(() => stmt.run('A', 5, 0.95)).toThrow(/CHECK/i)
    expect(() => stmt.run('B', 1, 9)).toThrow(/CHECK/i)
    expect(() => stmt.run('C', 1, 0.95)).not.toThrow()
  })

  it('同一基金同一净值日同一相位只允许一行（v2 唯一约束）', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('X', 1)
    const stmt = db.prepare(
      `insert into estimate_log
         (fund_code, model_ts, target_nav_date, phase, model_pct, model_amount, covered_weight, lag_days, exposure)
       values (?,?,?,?,?,?,?,?,?)`,
    )
    stmt.run('X', 1, '2026-11-06', 'settled', 1.4, 0, 0.66, 1, 0.95)
    expect(() => stmt.run('X', 2, '2026-11-06', 'settled', 1.5, 0, 0.66, 1, 0.95)).toThrow(/UNIQUE/i)
  })

  it('同一 key 用 upsert 覆盖，行数不变且值更新', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('X', 1)
    const stmt = db.prepare(
      `insert into estimate_log
         (fund_code, model_ts, target_nav_date, phase, model_pct, model_amount, covered_weight, lag_days, exposure)
       values (?,?,?,?,?,?,?,?,?)
       on conflict(fund_code, target_nav_date, phase) do update set
         model_ts=excluded.model_ts, model_pct=excluded.model_pct`,
    )
    stmt.run('X', 1, '2026-11-06', 'live', 1.0, 0, 0.66, 1, 0.95)
    stmt.run('X', 2, '2026-11-06', 'live', 1.3, 0, 0.66, 1, 0.95)
    const rows = db.prepare("select model_pct from estimate_log where phase='live'").all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].model_pct).toBeCloseTo(1.3, 6)
  })

  it('v2 之后 SCHEMA_VERSION 为 2，且重复 migrate 不重复执行 v2', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBe(2)
    expect(() => migrate(db)).not.toThrow()
    const idx = db.prepare("select name from sqlite_master where type='index' and name='idx_estimate_day'").all()
    expect(idx).toHaveLength(1)
  })
})
