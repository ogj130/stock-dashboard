import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type Db = DatabaseSync

/**
 * 有序迁移。每一项是「从版本 N 升到 N+1」的增量。
 * 永远不要改已发布的迁移——新增列就追加新的一项。
 * 用 create table if not exists 初始化已有库是静默 no-op，所以必须靠版本号驱动。
 */
const MIGRATIONS: Array<(db: Db) => void> = [
  // v1：初始 schema
  (db) => {
    db.exec(`
      create table fund (
        id integer primary key autoincrement,
        code text not null unique,
        name text not null default '',
        kind text not null default 'index',
        target_etf_code text,
        index_key text,
        asset_class text not null default 'us_equity',
        shares real not null default 0 check (shares >= 0),
        cost_basis real not null default 0,
        exposure real not null default 0.95 check (exposure between 0 and 1.5),
        lag_days integer not null default 1 check (lag_days in (0, 1, 2)),
        calibrated_at integer,
        created_at integer not null
      );

      create table constituent (
        id integer primary key autoincrement,
        owner_type text not null,
        owner_key text not null,
        symbol text not null,
        name text not null default '',
        weight real not null check (weight >= 0 and weight <= 1),
        as_of text not null,
        source text not null,
        fetched_at integer not null,
        unique(owner_type, owner_key, symbol, as_of)
      );
      create index idx_constituent_latest on constituent(owner_type, owner_key, as_of desc);

      create table quote_cache (
        symbol text not null,
        asset_class text not null default 'us_equity',
        price real not null check (price >= 0),
        prev_close real not null check (prev_close >= 0),
        pct real not null check (pct between -1000 and 1000),
        precision integer not null default 2,
        ts_ms integer not null,
        source_id text not null,
        fetched_at integer not null,
        primary key (symbol, source_id)
      );

      create table fx_cache (
        pair text not null,
        rate real not null check (rate > 0),
        prev_close real not null check (prev_close > 0),
        ts_ms integer not null,
        source_id text not null,
        fetched_at integer not null,
        primary key (pair, source_id)
      );

      create table nav_history (
        fund_code text not null references fund(code) on delete cascade,
        nav_date text not null,
        nav real not null check (nav > 0),
        pct real not null,
        fetched_at integer not null,
        primary key (fund_code, nav_date)
      );

      create table estimate_log (
        id integer primary key autoincrement,
        fund_code text not null references fund(code) on delete cascade,
        model_ts integer not null,
        target_nav_date text not null,
        phase text not null check (phase in ('live', 'settled')),
        model_pct real not null,
        model_amount real not null default 0,
        covered_weight real not null check (covered_weight >= 0 and covered_weight <= 1),
        lag_days integer not null,
        exposure real not null
      );
      create index idx_estimate_lookup on estimate_log(fund_code, target_nav_date, phase);
      create index idx_estimate_ts on estimate_log(model_ts);

      create table residual (
        id integer primary key autoincrement,
        fund_code text not null references fund(code) on delete cascade,
        nav_date text not null,
        model_pct real not null,
        actual_pct real not null,
        diff real not null,
        nav_ts integer not null,
        unique(fund_code, nav_date)
      );

      create table quote_symbol_market (
        symbol text primary key,
        market integer not null,
        updated_at integer not null
      );
    `)
  },
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function migrate(db: Db): void {
  const row = db.prepare('pragma user_version').get() as { user_version: number }
  const current = row.user_version
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('begin')
    try {
      MIGRATIONS[v]!(db)
      db.exec(`pragma user_version = ${v + 1}`)
      db.exec('commit')
    } catch (e) {
      db.exec('rollback')
      throw e
    }
  }
}

export function openDb(path: string): Db {
  const isMemory = path === ':memory:'
  if (!isMemory) mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma busy_timeout = 5000')
  db.exec('pragma foreign_keys = on')
  db.exec('pragma journal_mode = wal')
  migrate(db)
  return db
}
