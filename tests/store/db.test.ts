// tests/store/db.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate, SCHEMA_VERSION } from '../../src/store/db'

const TABLES = [
  'constituent', 'estimate_log', 'fund', 'fx_cache',
  'nav_history', 'portfolio_snapshot', 'quote_cache', 'quote_symbol_market', 'residual',
]

describe('db schema', () => {
  it('建出全部 9 张表', () => {
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

  it('v7 之后 SCHEMA_VERSION 为 7，且重复 migrate 不重复执行 v2/v3', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBe(7)
    expect(() => migrate(db)).not.toThrow()
    const idx = db.prepare("select name from sqlite_master where type='index' and name='idx_estimate_day'").all()
    expect(idx).toHaveLength(1)
  })
})

describe('db schema v4 · portfolio_snapshot', () => {
  it('表与 ts 索引都在，且 user_version 真的推到最新', () => {
    const db = openDb(':memory:')
    const cols = db.prepare('pragma table_info(portfolio_snapshot)').all() as Array<{
      name: string
      notnull: number
      type: string
    }>
    expect(cols.map((c) => c.name)).toEqual([
      'id', 'ts_ms', 'total_value', 'total_amount', 'fund_count', 'total_profit',
      // v7：盘前口径（可空，历史行没有这个口径）
      'total_value_pre', 'total_amount_pre',
    ])
    // 收盘口径的字段都不许为空：缺 ts 画不了横轴，缺 value 画不了纵轴。
    // 盘前两列是例外——v6 之前的历史行没有这个口径，用 0 顶替会画出断崖
    const nullable = new Set(['id', 'total_value_pre', 'total_amount_pre'])
    expect(cols.filter((c) => !nullable.has(c.name)).every((c) => c.notnull === 1)).toBe(true)

    const idx = db
      .prepare("select name from sqlite_master where type='index' and tbl_name='portfolio_snapshot'")
      .all() as Array<{ name: string }>
    expect(idx.map((r) => r.name)).toEqual(['idx_portfolio_ts'])

    const row = db.prepare('pragma user_version').get() as { user_version: number }
    expect(row.user_version).toBe(SCHEMA_VERSION)
  })

  it('快照表可插入并按 ts_ms 取回', () => {
    const db = openDb(':memory:')
    db.prepare(
      'insert into portfolio_snapshot (ts_ms, total_value, total_amount, fund_count) values (?,?,?,?)',
    ).run(1_700_000_000_000, 84_321.5, -12.34, 3)
    const row = db.prepare('select * from portfolio_snapshot').get() as {
      ts_ms: number
      total_value: number
      total_amount: number
      fund_count: number
      total_profit: number
    }
    expect(row.ts_ms).toBe(1_700_000_000_000)
    expect(row.total_value).toBeCloseTo(84_321.5, 6)
    expect(row.total_amount).toBeCloseTo(-12.34, 6)
    expect(row.fund_count).toBe(3)
    // 不写这一列时走 v5 的 default 0（老写入方不必改也能继续跑）
    expect(row.total_profit).toBe(0)
  })

  it('从 v3 升级到 v4→v5 时保留已有表与数据（增量迁移，不是重建）', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('X', 1)
    // 退回 v3 再迁一次，模拟「老库第一次见到 v4/v5」
    db.exec('drop table portfolio_snapshot')
    db.exec('pragma user_version = 3')
    migrate(db)

    expect((db.prepare("select count(*) c from fund where code='X'").get() as any).c).toBe(1)
    expect((db.prepare('pragma user_version').get() as any).user_version).toBe(SCHEMA_VERSION)
    expect(
      db.prepare("select name from sqlite_master where type='table' and name='portfolio_snapshot'").all(),
    ).toHaveLength(1)
  })
})

describe('db schema v5 · total_profit（持有收益）', () => {
  type Row = { total_profit: number }

  /** 把库退回「v4 形状」：5 列、没有 total_profit，塞两行历史数据 */
  function v4Db(): ReturnType<typeof openDb> {
    const db = openDb(':memory:')
    db.exec('drop table portfolio_snapshot')
    db.exec(`
      create table portfolio_snapshot (
        id integer primary key autoincrement,
        ts_ms integer not null,
        total_value real not null,
        total_amount real not null,
        fund_count integer not null
      );
      create index idx_portfolio_ts on portfolio_snapshot(ts_ms);
    `)
    db.exec(
      `insert into portfolio_snapshot (ts_ms, total_value, total_amount, fund_count)
       values (1, 84321.5, -12.34, 3), (2, 85000, 500, 3)`,
    )
    db.exec('pragma user_version = 4')
    return db
  }

  it('列存在、real、not null、默认 0', () => {
    const db = openDb(':memory:')
    const cols = db.prepare('pragma table_info(portfolio_snapshot)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    const col = cols.find((c) => c.name === 'total_profit')
    expect(col).toBeDefined()
    expect(col!.type).toBe('REAL')
    expect(col!.notnull).toBe(1)
    expect(col!.dflt_value).toBe('0')
  })

  it('从 v4 升级（alter table）把历史行回填成 0，且旧数据一行不丢', () => {
    const db = v4Db()
    migrate(db)

    const rows = db
      .prepare('select ts_ms, total_value, total_profit from portfolio_snapshot order by ts_ms')
      .all() as Array<{ ts_ms: number; total_value: number; total_profit: number }>
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.ts_ms)).toEqual([1, 2])
    expect(rows.map((r) => r.total_profit)).toEqual([0, 0])
    expect(rows[0]!.total_value).toBeCloseTo(84_321.5, 6)
    expect((db.prepare('pragma user_version').get() as any).user_version).toBe(SCHEMA_VERSION)
  })

  it('可写负数（持有浮亏），不会被 check 或 not null 拦下', () => {
    const db = openDb(':memory:')
    db.prepare(
      `insert into portfolio_snapshot (ts_ms, total_value, total_amount, total_profit, fund_count)
       values (?,?,?,?,?)`,
    ).run(1, 80_000, -300, -4_321.09, 2)
    expect((db.prepare('select total_profit from portfolio_snapshot').get() as Row).total_profit).toBeCloseTo(
      -4_321.09,
      6,
    )
  })
})

describe('db schema v3 · covered_weight 浮点漂移（S5）', () => {
  type Db = ReturnType<typeof openDb>
  function insertLog(db: Db, coveredWeight: number, date = '2026-11-06'): void {
    db.prepare(
      `insert into estimate_log
         (fund_code, model_ts, target_nav_date, phase, model_pct, model_amount, covered_weight, lag_days, exposure)
       values ('X', ?, ?, 'live', 1, 0, ?, 1, 0.95)`,
    ).run(Date.now(), date, coveredWeight)
  }

  it('归一化权重求和漂移超过 1 时不再 abort 事务', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('X', 1)

    // 100 个归一化权重逐个累加，实测 sum = 1.0000000000000007（> 1）
    let sum = 0
    for (let i = 0; i < 100; i++) sum += 1 / 100
    expect(sum).toBeGreaterThan(1)

    expect(() => {
      db.exec('begin')
      insertLog(db, sum)
      db.exec('commit')
    }).not.toThrow()
  })

  it('上界仍然挡住真正的越界值，不是把 CHECK 删掉', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('X', 1)
    expect(() => insertLog(db, 1.5)).toThrow(/CHECK/i)
    expect(() => insertLog(db, 1.000002)).toThrow(/CHECK/i)
    expect(() => insertLog(db, -0.1)).toThrow(/CHECK/i)
  })

  it('重建表搬走已有数据，且唯一约束、索引、外键级联都还在', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('X', 1)
    insertLog(db, 0.66)

    // 回退版本号再迁一次，强制重跑 v3 的表重建（copy → drop → rename）。
    // 重跑会连带重跑 v4，而 v4 是纯 create table（与 v1 一样靠版本号驱动、不用
    // if not exists），所以先把 v4 的表拆掉，否则报到 "already exists"。
    db.exec('drop table portfolio_snapshot')
    db.exec('pragma user_version = 2')
    migrate(db)

    const rows = db.prepare('select fund_code, covered_weight from estimate_log').all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].fund_code).toBe('X')
    expect(rows[0].covered_weight).toBeCloseTo(0.66, 6)

    const idx = db.prepare("select name from sqlite_master where type='index' and name like 'idx_estimate%'")
    expect((idx.all() as any[]).map((r) => r.name).sort()).toEqual([
      'idx_estimate_day', 'idx_estimate_lookup', 'idx_estimate_ts',
    ])

    insertLog(db, 0.7, '2026-11-05')
    expect(() => insertLog(db, 0.8, '2026-11-05')).toThrow(/UNIQUE/i)

    db.prepare("delete from fund where code = 'X'").run()
    expect((db.prepare('select count(*) c from estimate_log').get() as any).c).toBe(0)
  })
})

describe('db schema v6 · 盘前相位', () => {
  /** 退回 v5 形状：estimate_log 的 phase 只允许 live/settled，且没有 v7 的盘前列 */
  function v5Db() {
    const db = openDb(':memory:')
    db.exec(`
      alter table portfolio_snapshot drop column total_value_pre;
      alter table portfolio_snapshot drop column total_amount_pre;
      drop table estimate_log;
      create table estimate_log (
        id integer primary key autoincrement,
        fund_code text not null references fund(code) on delete cascade,
        model_ts integer not null,
        target_nav_date text not null,
        phase text not null check (phase in ('live', 'settled')),
        model_pct real not null,
        model_amount real not null default 0,
        covered_weight real not null check (covered_weight >= 0 and covered_weight <= 1.000001),
        lag_days integer not null,
        exposure real not null
      );
      create index idx_estimate_lookup on estimate_log(fund_code, target_nav_date, phase);
      create unique index idx_estimate_day on estimate_log(fund_code, target_nav_date, phase);
      create index idx_estimate_ts on estimate_log(model_ts);
    `)
    db.prepare('insert into fund (code, created_at) values (?,?)').run('270042', 1)
    db.prepare(
      `insert into estimate_log (fund_code, model_ts, target_nav_date, phase, model_pct, covered_weight, lag_days, exposure)
       values ('270042', 1, '2026-11-09', 'live', 3.2, 1.0, 1, 0.95)`,
    ).run()
    db.exec('pragma user_version = 5')
    return db
  }

  it('老库升级后盘前相位可写，历史 live 行一行不丢', () => {
    const db = v5Db()
    migrate(db)

    const kept = db.prepare('select phase, model_pct from estimate_log').all() as Array<{
      phase: string
      model_pct: number
    }>
    expect(kept).toEqual([{ phase: 'live', model_pct: 3.2 }])

    db.prepare(
      `insert into estimate_log (fund_code, model_ts, target_nav_date, phase, model_pct, covered_weight, lag_days, exposure)
       values ('270042', 2, '2026-11-10', 'pre', 1.05, 0.98, 1, 0.95)`,
    ).run()
    const pre = db.prepare("select model_pct from estimate_log where phase='pre'").get() as {
      model_pct: number
    }
    expect(pre.model_pct).toBeCloseTo(1.05, 6)
  })

  it('重建后唯一索引仍在（否则 5 秒轮询会立刻撞唯一键报错）', () => {
    const db = v5Db()
    migrate(db)
    const idx = db
      .prepare("select name from sqlite_master where type='index' and tbl_name='estimate_log'")
      .all() as Array<{ name: string }>
    expect(idx.map((r) => r.name).sort()).toEqual(
      ['idx_estimate_day', 'idx_estimate_lookup', 'idx_estimate_ts'].sort(),
    )
    expect(() =>
      db
        .prepare(
          `insert into estimate_log (fund_code, model_ts, target_nav_date, phase, model_pct, covered_weight, lag_days, exposure)
           values ('270042', 9, '2026-11-09', 'live', 3.3, 1.0, 1, 0.95)`,
        )
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('乱写的相位仍被 CHECK 拦住（别把脏相位放进对账序列）', () => {
    const db = openDb(':memory:')
    db.prepare('insert into fund (code, created_at) values (?,?)').run('270042', 1)
    expect(() =>
      db
        .prepare(
          `insert into estimate_log (fund_code, model_ts, target_nav_date, phase, model_pct, covered_weight, lag_days, exposure)
           values ('270042', 1, '2026-11-10', 'premarket', 1, 1, 1, 0.95)`,
        )
        .run(),
    ).toThrow(/CHECK/)
  })
})
